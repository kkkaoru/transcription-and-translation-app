//! Overlay / Syphon / Spout debug surfaces used by CLI flags and the Settings tab.

use caption_bridge_overlay::{
    pump_native_events, test_pattern_rgba, OverlayWindow, OverlayWindowOptions,
    DEBUG_OVERLAY_TITLE, DEFAULT_OVERLAY_HEIGHT, DEFAULT_OVERLAY_WIDTH,
};
use caption_bridge_spout::{SpoutPublisher, SpoutPublisherOptions, NATIVE_SPOUT_SHARE_NAME};
use caption_bridge_syphon::{
    SyphonPublisher, SyphonPublisherOptions, NATIVE_SYPHON_SERVER_NAME, WINDOWS_SYPHON_UNSUPPORTED,
};

use crate::domain::{
    rasterize_live_caption, DebugLaunch, NativeStyleSettings, NATIVE_BROWSER_SOURCE_HINT,
};

/// Holds optional overlay / Syphon / Spout debug publishers for the process lifetime.
pub struct DebugSurfaces {
    pub overlay: Option<OverlayWindow>,
    pub syphon: Option<SyphonPublisher>,
    pub spout: Option<SpoutPublisher>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaptionPublication {
    pub source: String,
    pub translation: String,
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl DebugSurfaces {
    pub fn empty() -> Self {
        Self { overlay: None, syphon: None, spout: None }
    }

    pub fn publish_caption(
        &mut self,
        style: &NativeStyleSettings,
        source: &str,
        translation: &str,
    ) -> Result<Option<CaptionPublication>, String> {
        if self.overlay.is_none() && self.syphon.is_none() && self.spout.is_none() {
            return Ok(None);
        }
        let publication = caption_publication(style, source, translation);
        if let Some(window) = self.overlay.as_mut() {
            window
                .set_pixels(publication.width, publication.height, &publication.pixels)
                .map_err(|error| error.to_string())?;
        }
        if let Some(publisher) = self.syphon.as_mut() {
            publisher
                .publish_rgba(publication.width, publication.height, &publication.pixels)
                .map_err(|error| error.to_string())?;
        }
        if let Some(publisher) = self.spout.as_mut() {
            publisher
                .publish_rgba(publication.width, publication.height, &publication.pixels)
                .map_err(|error| error.to_string())?;
        }
        Ok(Some(publication))
    }
}

pub fn caption_publication(
    style: &NativeStyleSettings,
    source: &str,
    translation: &str,
) -> CaptionPublication {
    let image = rasterize_live_caption(style, source, translation);
    CaptionPublication {
        source: source.to_string(),
        translation: translation.to_string(),
        width: image.width,
        height: image.height,
        pixels: image.pixels,
    }
}

/// Open the requested debug surfaces and publish one shared test pattern.
pub fn start_debug_surfaces(launch: DebugLaunch) -> Result<DebugSurfaces, String> {
    if launch.syphon {
        if let Some(message) = syphon_flag_error() {
            return Err(message);
        }
    }
    if launch.spout {
        if let Some(message) = spout_flag_error() {
            return Err(message);
        }
    }
    if launch.overlay {
        if let Some(message) = overlay_flag_error() {
            return Err(message);
        }
    }
    if !launch.overlay && !launch.syphon && !launch.spout {
        return Ok(DebugSurfaces::empty());
    }
    let width = DEFAULT_OVERLAY_WIDTH as u32;
    let height = DEFAULT_OVERLAY_HEIGHT as u32;
    let pixels = test_pattern_rgba(width, height).map_err(|error| error.to_string())?;
    let overlay = if launch.overlay {
        let mut window = OverlayWindow::open(OverlayWindowOptions::debug_capture())
            .map_err(|error| error.to_string())?;
        window.set_pixels(width, height, &pixels).map_err(|error| error.to_string())?;
        Some(window)
    } else {
        None
    };
    let syphon = if launch.syphon {
        let mut publisher = SyphonPublisher::start(SyphonPublisherOptions::native_debug())
            .map_err(|error| error.to_string())?;
        publisher.publish_rgba(width, height, &pixels).map_err(|error| error.to_string())?;
        Some(publisher)
    } else {
        None
    };
    let spout = if launch.spout {
        let mut publisher = SpoutPublisher::start(SpoutPublisherOptions::native_debug())
            .map_err(|error| error.to_string())?;
        publisher.publish_rgba(width, height, &pixels).map_err(|error| error.to_string())?;
        Some(publisher)
    } else {
        None
    };
    Ok(DebugSurfaces { overlay, syphon, spout })
}

pub fn overlay_flag_error() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        Some(format!(
            "overlay windows are not available on Linux; use the Native browser-source on {NATIVE_BROWSER_SOURCE_HINT}"
        ))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = NATIVE_BROWSER_SOURCE_HINT;
        None
    }
}

pub fn syphon_flag_error() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        Some(WINDOWS_SYPHON_UNSUPPORTED.to_string())
    }
    #[cfg(target_os = "linux")]
    {
        Some(format!(
            "Syphon is macOS-only; on Linux use the Native browser-source on {NATIVE_BROWSER_SOURCE_HINT}"
        ))
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = WINDOWS_SYPHON_UNSUPPORTED;
        None
    }
}

pub fn spout_flag_error() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        Some(
            "Spout2 does not run on macOS; use --syphon to publish Kotoba Beacon Native"
                .to_string(),
        )
    }
    #[cfg(target_os = "linux")]
    {
        Some(format!(
            "Spout2 is Windows-only; on Linux use the Native browser-source on {NATIVE_BROWSER_SOURCE_HINT}"
        ))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

pub fn wants_event_pump(launch: DebugLaunch) -> bool {
    launch.overlay || launch.syphon || launch.spout
}

pub fn print_debug_status(launch: DebugLaunch, surfaces: &Result<DebugSurfaces, String>) {
    match surfaces {
        Ok(started) => {
            if launch.overlay {
                if started.overlay.is_some() {
                    println!("debug overlay: {DEBUG_OVERLAY_TITLE}");
                    println!(
                        "overlay verify: click-through, not always-on-top, transparent outside the teal plate"
                    );
                } else {
                    println!("debug overlay: not started");
                }
            }
            if launch.syphon {
                if started.syphon.is_some() {
                    println!("debug syphon: {NATIVE_SYPHON_SERVER_NAME}");
                    println!("syphon verify: OBS → Syphon Client → {NATIVE_SYPHON_SERVER_NAME}");
                } else {
                    println!("debug syphon: not started");
                }
            }
            if launch.spout {
                if started.spout.is_some() {
                    println!("debug spout: {NATIVE_SPOUT_SHARE_NAME}");
                    println!("spout verify: OBS → Spout2 source → {NATIVE_SPOUT_SHARE_NAME}");
                } else {
                    println!("debug spout: not started");
                }
            }
        }
        Err(error) => println!("debug surfaces failed: {error}"),
    }
}

pub fn pump_debug_loop() {
    println!("debug surfaces running; press Ctrl+C to stop");
    loop {
        let _ = pump_native_events();
        std::thread::sleep(std::time::Duration::from_millis(16));
    }
}

#[cfg(feature = "gpui")]
pub fn open_overlay(surfaces: &mut DebugSurfaces) -> Result<(), String> {
    if surfaces.overlay.is_some() {
        return Ok(());
    }
    if let Some(message) = overlay_flag_error() {
        return Err(message);
    }
    let width = DEFAULT_OVERLAY_WIDTH as u32;
    let height = DEFAULT_OVERLAY_HEIGHT as u32;
    let pixels = test_pattern_rgba(width, height).map_err(|error| error.to_string())?;
    let mut window = OverlayWindow::open(OverlayWindowOptions::debug_capture())
        .map_err(|error| error.to_string())?;
    window.set_pixels(width, height, &pixels).map_err(|error| error.to_string())?;
    surfaces.overlay = Some(window);
    Ok(())
}

#[cfg(feature = "gpui")]
pub fn hide_overlay(surfaces: &mut DebugSurfaces) {
    surfaces.overlay = None;
}

#[cfg(feature = "gpui")]
pub fn start_syphon(surfaces: &mut DebugSurfaces) -> Result<(), String> {
    if surfaces.syphon.is_some() {
        return Ok(());
    }
    if let Some(message) = syphon_flag_error() {
        return Err(message);
    }
    let width = DEFAULT_OVERLAY_WIDTH as u32;
    let height = DEFAULT_OVERLAY_HEIGHT as u32;
    let pixels = test_pattern_rgba(width, height).map_err(|error| error.to_string())?;
    let mut publisher = SyphonPublisher::start(SyphonPublisherOptions::native_debug())
        .map_err(|error| error.to_string())?;
    publisher.publish_rgba(width, height, &pixels).map_err(|error| error.to_string())?;
    surfaces.syphon = Some(publisher);
    Ok(())
}

#[cfg(feature = "gpui")]
pub fn stop_syphon(surfaces: &mut DebugSurfaces) {
    surfaces.syphon = None;
}
