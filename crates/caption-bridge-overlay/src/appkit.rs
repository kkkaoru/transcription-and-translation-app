//! Live AppKit `NSWindow` for the OBS capture surface.
//!
//! All AppKit calls happen on the main thread. Creating a window off the
//! main thread returns [`OverlayError::NativeWindow`].

use objc2::rc::Retained;
use objc2::{AnyThread, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSBitmapFormat,
    NSBitmapImageRep, NSCalibratedRGBColorSpace, NSColor, NSImage, NSImageScaling, NSImageView,
    NSWindow, NSWindowCollectionBehavior, NSWindowSharingType, NSWindowStyleMask,
};
use objc2_foundation::{NSDefaultRunLoopMode, NSPoint, NSRect, NSSize, NSString};

use crate::error::OverlayError;
use crate::options::OverlayWindowOptions;

/// AppKit `NSBitmapFormat` for overlay pixels: alpha last (the default bit)
/// and straight (non-premultiplied) RGBA8.
///
/// The no-`bitmapFormat:` initializer is format `0` (alpha last, premultiplied).
/// Caption and debug buffers in this crate are straight RGBA; treating them as
/// premultiplied darkens semi-transparent edges and produces a halo.
const OVERLAY_BITMAP_FORMAT: NSBitmapFormat = NSBitmapFormat::AlphaNonpremultiplied;

/// Owned AppKit objects for one overlay window.
pub(crate) struct MacOverlay {
    window: Retained<NSWindow>,
    image_view: Retained<NSImageView>,
}

impl MacOverlay {
    pub(crate) fn open(options: &OverlayWindowOptions) -> Result<Self, OverlayError> {
        let mtm = MainThreadMarker::new()
            .ok_or(OverlayError::NativeWindow("NSWindow must be created on the main thread"))?;
        // SAFETY: `mtm` proves we are on the AppKit main thread. The window is
        // borderless, not shared across threads, and we retain it for the
        // lifetime of `MacOverlay`.
        unsafe { create_window(mtm, options) }
    }

    pub(crate) fn set_frame(
        &mut self,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<(), OverlayError> {
        let _mtm = MainThreadMarker::new()
            .ok_or(OverlayError::NativeWindow("NSWindow must be mutated on the main thread"))?;
        let frame = NSRect::new(NSPoint::new(x, y), NSSize::new(width, height));
        self.window.setFrame_display(frame, true);
        Ok(())
    }

    pub(crate) fn set_pixels(
        &mut self,
        width: u32,
        height: u32,
        pixels: &[u8],
    ) -> Result<(), OverlayError> {
        let _mtm = MainThreadMarker::new()
            .ok_or(OverlayError::NativeWindow("NSWindow must be mutated on the main thread"))?;
        let image = bitmap_image(width, height, pixels)?;
        self.image_view.setImage(Some(&image));
        self.window.display();
        Ok(())
    }

    pub(crate) fn redraw(&mut self) -> Result<(), OverlayError> {
        let _mtm = MainThreadMarker::new()
            .ok_or(OverlayError::NativeWindow("NSWindow must be mutated on the main thread"))?;
        self.window.display();
        Ok(())
    }

    pub(crate) fn set_click_through(&mut self, enabled: bool) -> Result<(), OverlayError> {
        let _mtm = MainThreadMarker::new()
            .ok_or(OverlayError::NativeWindow("NSWindow must be mutated on the main thread"))?;
        self.window.setIgnoresMouseEvents(enabled);
        Ok(())
    }

    pub(crate) fn close(self) {
        if MainThreadMarker::new().is_some() {
            self.window.close();
        }
    }
}

/// Create the chromeless, transparent, click-through `NSWindow`.
///
/// # Safety
///
/// Caller must hold a [`MainThreadMarker`] for the AppKit main thread.
unsafe fn create_window(
    mtm: MainThreadMarker,
    options: &OverlayWindowOptions,
) -> Result<MacOverlay, OverlayError> {
    let app = NSApplication::sharedApplication(mtm);
    // When the caller is already inside a host app (e.g. the GPUI Native
    // process), NSApplication is running and has already been configured.
    // Re-setting the activation policy or calling finishLaunching again will
    // either fail silently or corrupt the host's app state.
    if !app.isRunning() {
        app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
        app.finishLaunching();
    }

    let frame =
        NSRect::new(NSPoint::new(options.x, options.y), NSSize::new(options.width, options.height));
    let style = NSWindowStyleMask::Borderless;
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            frame,
            style,
            NSBackingStoreType::Buffered,
            false,
        )
    };

    window.setTitle(&NSString::from_str(&options.title));
    window.setOpaque(false);
    window.setHasShadow(options.chrome.has_shadow);
    window.setBackgroundColor(Some(&NSColor::clearColor()));
    window.setIgnoresMouseEvents(options.chrome.ignores_mouse_events);
    window.setLevel(options.chrome.ns_window_level());
    window.setReleasedWhenClosed(false);
    // Default AppKit sharing is ReadOnly; set it explicitly so a future
    // SharingNone cannot hide this window from OBS CGWindowList / SCK.
    window.setSharingType(NSWindowSharingType::ReadOnly);
    window.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary,
    );

    let content_frame =
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(options.width, options.height));
    let image_view = NSImageView::initWithFrame(NSImageView::alloc(mtm), content_frame);
    image_view.setImageScaling(NSImageScaling::ScaleAxesIndependently);
    window.setContentView(Some(&image_view));
    if let Some(content_view) = window.contentView() {
        content_view.setFrame(content_frame);
    }
    window.setFrame_display(frame, true);
    window.orderFrontRegardless();
    // Re-assert the picker title after show. Some AppKit paths clear an empty
    // title on first orderFront; OBS drops empty names by default.
    window.setTitle(&NSString::from_str(&options.title));
    window.displayIfNeeded();

    Ok(MacOverlay { window, image_view })
}

/// Drain pending AppKit events so a CLI process can keep an overlay visible.
///
/// `NSWindow` stays 0×0 until the application finishes launching and a run
/// loop observes it. GPUI already owns a run loop; the Native stub does not.
pub(crate) fn pump_events() -> Result<(), OverlayError> {
    let mtm = MainThreadMarker::new()
        .ok_or(OverlayError::NativeWindow("AppKit events must be pumped on the main thread"))?;
    let app = NSApplication::sharedApplication(mtm);
    loop {
        // SAFETY: `NSDefaultRunLoopMode` is a process-lifetime Foundation
        // constant. We only pass it to AppKit on the main thread.
        let mode = unsafe { NSDefaultRunLoopMode };
        let Some(event) = app.nextEventMatchingMask_untilDate_inMode_dequeue(
            objc2_app_kit::NSEventMask::Any,
            None,
            mode,
            true,
        ) else {
            break;
        };
        app.sendEvent(&event);
    }
    Ok(())
}

fn bitmap_image(width: u32, height: u32, pixels: &[u8]) -> Result<Retained<NSImage>, OverlayError> {
    let w = isize::try_from(width)
        .map_err(|_| OverlayError::PixelSizeMismatch("width does not fit NSInteger"))?;
    let h = isize::try_from(height)
        .map_err(|_| OverlayError::PixelSizeMismatch("height does not fit NSInteger"))?;
    let samples_per_pixel = 4_isize;
    let bits_per_sample = 8_isize;
    let bytes_per_row = (width as isize)
        .checked_mul(samples_per_pixel)
        .ok_or(OverlayError::PixelSizeMismatch("bytes per row overflow"))?;
    let bits_per_pixel = bits_per_sample
        .checked_mul(samples_per_pixel)
        .ok_or(OverlayError::PixelSizeMismatch("bits per pixel overflow"))?;

    // SAFETY: `pixels` is a tightly packed straight RGBA8 buffer of
    // `width * height * 4` bytes. Passing a null plane pointer asks AppKit to
    // allocate the plane, which we then fill with a bounded copy. The
    // `bitmapFormat:` initializer receives [`OVERLAY_BITMAP_FORMAT`] so AppKit
    // does not treat those unpremultiplied samples as premultiplied.
    let bitmap = unsafe {
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bitmapFormat_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(),
            std::ptr::null_mut(),
            w,
            h,
            bits_per_sample,
            samples_per_pixel,
            true,
            false,
            NSCalibratedRGBColorSpace,
            OVERLAY_BITMAP_FORMAT,
            bytes_per_row,
            bits_per_pixel,
        )
    }
    .ok_or(OverlayError::NativeWindow("failed to allocate NSBitmapImageRep"))?;

    // SAFETY: after a successful init with a null plane pointer, AppKit owns a
    // writable plane of `pixels.len()` bytes.
    unsafe {
        let dest = bitmap.bitmapData();
        if dest.is_null() {
            return Err(OverlayError::NativeWindow("NSBitmapImageRep has no bitmap data"));
        }
        std::ptr::copy_nonoverlapping(pixels.as_ptr(), dest, pixels.len());
    }

    let image = NSImage::initWithSize(NSImage::alloc(), NSSize::new(width as f64, height as f64));
    image.addRepresentation(&bitmap);
    Ok(image)
}
