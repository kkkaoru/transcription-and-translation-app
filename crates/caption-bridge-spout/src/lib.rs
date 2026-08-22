//! Standalone Spout2 publisher for Native/GPUI OBS verification.
//!
//! Desktop Tauri publishes as `Kotoba Beacon`. This crate uses a Native-only
//! share name so both apps can appear in the Spout directory at once.
//!
//! Real `spout2-rs` send exists only on Windows (`#[cfg(target_os = "windows")]`).
//! Every other target still compiles the same public surface and the same
//! validation layer so this Mac can unit-test the contract. Linux start/publish
//! returns [`SpoutPublishError::UnsupportedPlatform`] naming browser-source.

#![cfg_attr(not(target_os = "windows"), forbid(unsafe_code))]

use thiserror::Error;

/// Spout share name used by the Native/GPUI debug publisher.
///
/// Must stay distinct from the desktop Tauri sender (`Kotoba Beacon`).
pub const NATIVE_SPOUT_SHARE_NAME: &str = "Kotoba Beacon Native";

/// Tightly packed RGBA8 channel count.
pub const RGBA_CHANNELS: usize = 4;

/// Failures from constructing or publishing a Spout sender.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum SpoutPublishError {
    /// Spout senders exist only on Windows.
    #[error("{0}")]
    UnsupportedPlatform(&'static str),
    /// Width or height is zero.
    #[error("Spout frame is invalid: {0}")]
    InvalidFrame(&'static str),
    /// Pixel buffer length does not match `width * height * 4`.
    #[error("Spout frame byte length does not match dimensions")]
    PixelSizeMismatch,
    /// Frame dimensions overflow `usize` when computing the expected length.
    #[error("Spout frame dimensions are too large")]
    DimensionsOverflow,
    /// The share name is empty after trimming.
    #[error("Spout share name must not be empty")]
    EmptyShareName,
    /// `spout2-rs` could not create or send a frame.
    #[error("Spout sender failed: {0}")]
    Sender(&'static str),
}

/// Linux Spout is not in v1. Point users at Native browser-source port 1521.
pub const LINUX_SPOUT_UNSUPPORTED: &str = "Spout2 publish is only available on Windows; on Linux use the Native browser-source on http://127.0.0.1:1521";

/// macOS must not pretend Syphon and Spout are interchangeable.
pub const MACOS_SPOUT_UNSUPPORTED: &str =
    "Spout2 publish is only available on Windows; on macOS use --syphon";

/// Options for a Spout publisher.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpoutPublisherOptions {
    /// Name advertised to Spout receivers (OBS Spout source).
    pub share_name: String,
}

/// A running Spout sender that accepts tightly packed RGBA8 frames.
pub struct SpoutPublisher {
    share_name: String,
    #[cfg(target_os = "windows")]
    inner: windows::WindowsPublisher,
}

impl SpoutPublishError {
    /// Platform-specific unsupported error for the current compile target.
    pub const fn unsupported_on_this_os() -> Self {
        #[cfg(target_os = "linux")]
        {
            Self::UnsupportedPlatform(LINUX_SPOUT_UNSUPPORTED)
        }
        #[cfg(target_os = "macos")]
        {
            Self::UnsupportedPlatform(MACOS_SPOUT_UNSUPPORTED)
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            Self::UnsupportedPlatform(
                "Spout2 publish is only available on Windows; use the Native browser-source on http://127.0.0.1:1521",
            )
        }
    }
}

impl SpoutPublisherOptions {
    /// Native/GPUI debug identity. Distinct from the Tauri desktop sender.
    pub fn native_debug() -> Self {
        Self { share_name: NATIVE_SPOUT_SHARE_NAME.to_string() }
    }
}

impl SpoutPublisher {
    /// Start a Spout sender advertised under `opts.share_name`.
    ///
    /// On Windows this constructs a `spout2::dx::Sender`. Other targets return
    /// [`SpoutPublishError::UnsupportedPlatform`] after validating the name.
    pub fn start(opts: SpoutPublisherOptions) -> Result<Self, SpoutPublishError> {
        let share_name = validated_share_name(&opts.share_name)?;
        #[cfg(not(target_os = "windows"))]
        {
            let _ = share_name;
            Err(SpoutPublishError::unsupported_on_this_os())
        }
        #[cfg(target_os = "windows")]
        {
            let inner = windows::WindowsPublisher::start(&share_name)?;
            Ok(Self { share_name, inner })
        }
    }

    /// Share name this publisher is advertising.
    pub fn share_name(&self) -> &str {
        &self.share_name
    }

    /// Upload tightly packed RGBA8 pixels and publish them as the current frame.
    ///
    /// Bytes are swapped to BGRA before `send_image` so OBS does not see red and
    /// blue exchanged (`DXGI_FORMAT_B8G8R8A8_UNORM`).
    pub fn publish_rgba(
        &mut self,
        width: u32,
        height: u32,
        pixels: &[u8],
    ) -> Result<(), SpoutPublishError> {
        validate_rgba(width, height, pixels)?;
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (width, height, pixels);
            Err(SpoutPublishError::unsupported_on_this_os())
        }
        #[cfg(target_os = "windows")]
        {
            self.inner.publish_rgba(width, height, pixels)
        }
    }

    /// Stop the sender and remove it from the Spout directory.
    ///
    /// Dropping [`SpoutPublisher`] has the same effect.
    pub fn stop(self) {}
}

/// Expected tightly packed RGBA8 length for `width` × `height`.
pub fn expected_rgba_len(width: u32, height: u32) -> Result<usize, SpoutPublishError> {
    usize::try_from(width)
        .ok()
        .and_then(|width| usize::try_from(height).ok().and_then(|height| width.checked_mul(height)))
        .and_then(|pixels| pixels.checked_mul(RGBA_CHANNELS))
        .ok_or(SpoutPublishError::DimensionsOverflow)
}

/// Reject zero dimensions or a buffer whose length is not `width * height * 4`.
pub fn validate_rgba(width: u32, height: u32, pixels: &[u8]) -> Result<usize, SpoutPublishError> {
    if width == 0 {
        return Err(SpoutPublishError::InvalidFrame("width must be greater than 0"));
    }
    if height == 0 {
        return Err(SpoutPublishError::InvalidFrame("height must be greater than 0"));
    }
    let expected = expected_rgba_len(width, height)?;
    if pixels.len() != expected {
        return Err(SpoutPublishError::PixelSizeMismatch);
    }
    Ok(expected)
}

/// Copy RGBA into `bgra` with red and blue swapped.
///
/// Matches desktop `native_output::prepare_spout_bgra` so Native and Tauri
/// share one texture-format contract. Compiles on every OS so this Mac can
/// test the swap without linking Spout.
pub fn prepare_spout_bgra(
    rgba: &[u8],
    width: u32,
    height: u32,
    bgra: &mut Vec<u8>,
) -> Result<(), SpoutPublishError> {
    let expected = validate_rgba(width, height, rgba)?;
    bgra.clear();
    bgra.extend_from_slice(rgba);
    if bgra.len() != expected {
        return Err(SpoutPublishError::PixelSizeMismatch);
    }
    let mut offset = 0;
    while offset + 3 < bgra.len() {
        bgra.swap(offset, offset + 2);
        offset += RGBA_CHANNELS;
    }
    Ok(())
}

fn validated_share_name(name: &str) -> Result<String, SpoutPublishError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(SpoutPublishError::EmptyShareName);
    }
    Ok(trimmed.to_string())
}

#[cfg(target_os = "windows")]
mod windows {
    use super::{prepare_spout_bgra, SpoutPublishError};

    pub(super) struct WindowsPublisher {
        sender: spout2::dx::Sender,
        bgra: Vec<u8>,
    }

    impl WindowsPublisher {
        pub(super) fn start(share_name: &str) -> Result<Self, SpoutPublishError> {
            let sender = spout2::dx::Sender::new(share_name)
                .map_err(|_| SpoutPublishError::Sender("failed to create Spout2 DirectX sender"))?;
            Ok(Self { sender, bgra: Vec::new() })
        }

        pub(super) fn publish_rgba(
            &mut self,
            width: u32,
            height: u32,
            pixels: &[u8],
        ) -> Result<(), SpoutPublishError> {
            prepare_spout_bgra(pixels, width, height, &mut self.bgra)?;
            self.sender
                .send_image(&self.bgra, width, height)
                .map_err(|_| SpoutPublishError::Sender("spout send_image failed"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        expected_rgba_len, prepare_spout_bgra, validate_rgba, SpoutPublishError, SpoutPublisher,
        SpoutPublisherOptions, LINUX_SPOUT_UNSUPPORTED, MACOS_SPOUT_UNSUPPORTED,
        NATIVE_SPOUT_SHARE_NAME,
    };

    #[test]
    fn native_debug_name_is_locked_and_not_the_desktop_tauri_name() {
        let options = SpoutPublisherOptions::native_debug();
        assert_eq!(options.share_name, "Kotoba Beacon Native");
        assert_eq!(NATIVE_SPOUT_SHARE_NAME, "Kotoba Beacon Native");
        assert_ne!(options.share_name, "Kotoba Beacon");
        assert_ne!(NATIVE_SPOUT_SHARE_NAME, "Kotoba Beacon");
    }

    #[test]
    fn expected_rgba_len_is_width_times_height_times_four() {
        assert_eq!(expected_rgba_len(1, 1), Ok(4));
        assert_eq!(expected_rgba_len(2, 1), Ok(8));
        assert_eq!(expected_rgba_len(80, 40), Ok(12800));
        assert_eq!(expected_rgba_len(1280, 720), Ok(3686400));
    }

    #[test]
    fn expected_rgba_len_rejects_overflowing_dimensions() {
        assert_eq!(
            expected_rgba_len(u32::MAX, u32::MAX),
            Err(SpoutPublishError::DimensionsOverflow)
        );
    }

    #[test]
    fn validate_rgba_accepts_matching_buffer() {
        assert_eq!(validate_rgba(1, 1, &[1, 2, 3, 4]), Ok(4));
        assert_eq!(validate_rgba(2, 1, &[0, 0, 0, 0, 255, 0, 255, 255]), Ok(8));
    }

    #[test]
    fn validate_rgba_rejects_mismatched_pixel_length() {
        assert_eq!(validate_rgba(2, 1, &[0, 0, 0, 0]), Err(SpoutPublishError::PixelSizeMismatch));
        assert_eq!(validate_rgba(1, 1, &[0, 0, 0]), Err(SpoutPublishError::PixelSizeMismatch));
        assert_eq!(
            validate_rgba(1, 1, &[0, 0, 0, 0, 0]),
            Err(SpoutPublishError::PixelSizeMismatch)
        );
    }

    #[test]
    fn validate_rgba_rejects_zero_dimensions() {
        assert_eq!(
            validate_rgba(0, 1, &[0, 0, 0, 0]),
            Err(SpoutPublishError::InvalidFrame("width must be greater than 0"))
        );
        assert_eq!(
            validate_rgba(1, 0, &[0, 0, 0, 0]),
            Err(SpoutPublishError::InvalidFrame("height must be greater than 0"))
        );
    }

    #[test]
    fn prepare_spout_bgra_swaps_red_and_blue() {
        let mut bgra = Vec::new();
        prepare_spout_bgra(&[255, 0, 0, 255, 0, 255, 0, 128], 2, 1, &mut bgra)
            .expect("2x1 RGBA is valid");
        assert_eq!(bgra, vec![0, 0, 255, 255, 0, 255, 0, 128]);
    }

    #[test]
    fn prepare_spout_bgra_rejects_byte_length_mismatch() {
        let mut bgra = Vec::new();
        assert_eq!(
            prepare_spout_bgra(&[0, 0, 0, 0], 2, 1, &mut bgra),
            Err(SpoutPublishError::PixelSizeMismatch)
        );
    }

    #[test]
    fn start_rejects_empty_share_name() {
        match SpoutPublisher::start(SpoutPublisherOptions { share_name: String::new() }) {
            Err(error) => assert_eq!(error, SpoutPublishError::EmptyShareName),
            Ok(_) => panic!("empty name must be rejected"),
        }
        match SpoutPublisher::start(SpoutPublisherOptions { share_name: "   ".to_string() }) {
            Err(error) => assert_eq!(error, SpoutPublishError::EmptyShareName),
            Ok(_) => panic!("whitespace-only name must be rejected"),
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn non_windows_start_is_unsupported() {
        match SpoutPublisher::start(SpoutPublisherOptions::native_debug()) {
            Err(SpoutPublishError::UnsupportedPlatform(message)) => {
                assert!(
                    message == MACOS_SPOUT_UNSUPPORTED || message == LINUX_SPOUT_UNSUPPORTED,
                    "unexpected unsupported message: {message}"
                );
            }
            Err(other) => panic!("unexpected start error: {other}"),
            Ok(_) => panic!("non-Windows must stub start"),
        }
    }

    #[test]
    fn macos_and_linux_messages_are_locked() {
        assert_eq!(
            MACOS_SPOUT_UNSUPPORTED,
            "Spout2 publish is only available on Windows; on macOS use --syphon"
        );
        assert_eq!(
            LINUX_SPOUT_UNSUPPORTED,
            "Spout2 publish is only available on Windows; on Linux use the Native browser-source on http://127.0.0.1:1521"
        );
    }

    #[test]
    fn publish_rgba_rejects_mismatched_pixel_length_before_transport() {
        match SpoutPublisher::start(SpoutPublisherOptions::native_debug()) {
            Ok(mut publisher) => {
                assert_eq!(publisher.share_name(), "Kotoba Beacon Native");
                let error = publisher
                    .publish_rgba(2, 1, &[0, 0, 0, 0])
                    .expect_err("undersized buffer must be rejected");
                assert_eq!(error, SpoutPublishError::PixelSizeMismatch);
                publisher.stop();
            }
            Err(SpoutPublishError::UnsupportedPlatform(_)) => {}
            Err(SpoutPublishError::Sender(_)) => {
                assert_eq!(
                    validate_rgba(2, 1, &[0, 0, 0, 0]),
                    Err(SpoutPublishError::PixelSizeMismatch)
                );
            }
            Err(error) => panic!("unexpected start error: {error}"),
        }
    }
}
