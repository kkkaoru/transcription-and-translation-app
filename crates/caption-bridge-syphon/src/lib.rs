//! Standalone Syphon publisher for Native/GPUI OBS verification.
//!
//! Desktop Tauri publishes as `Kotoba Beacon`. This crate uses a Native-only
//! server name so both apps can appear in the Syphon directory at once.
//! Callers supply tightly packed RGBA8 pixels (the same shape as
//! `caption-bridge-overlay::test_pattern_rgba`) so Native can share one fixture.
//!
//! Real publish exists only on macOS, behind `syphon-rs` 0.1.1 (the same crate
//! desktop uses). Other targets return [`SyphonPublishError::UnsupportedPlatform`].

#![cfg_attr(not(target_os = "macos"), forbid(unsafe_code))]

use thiserror::Error;

/// Syphon directory name used by the Native/GPUI debug publisher.
///
/// Must stay distinct from the desktop Tauri server (`Kotoba Beacon`).
pub const NATIVE_SYPHON_SERVER_NAME: &str = "Kotoba Beacon Native";

/// Tightly packed RGBA8 channel count.
pub const RGBA_CHANNELS: usize = 4;

/// Windows callers must use Spout, not Syphon.
pub const WINDOWS_SYPHON_UNSUPPORTED: &str =
    "Syphon is macOS-only; use --spout to publish Kotoba Beacon Native via Spout2";

/// Linux has neither Syphon nor Spout.
pub const LINUX_SYPHON_UNSUPPORTED: &str =
    "Syphon is macOS-only; on Linux use the Native browser-source on http://127.0.0.1:1521";

/// Generic non-macOS Syphon message.
pub const SYPHON_MACOS_ONLY: &str = "Syphon publish is only available on macOS";

/// Failures from constructing or publishing a Syphon server.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum SyphonPublishError {
    /// Syphon servers exist only on macOS.
    #[error("{0}")]
    UnsupportedPlatform(&'static str),
    /// Width or height is zero.
    #[error("Syphon frame is invalid: {0}")]
    InvalidFrame(&'static str),
    /// Pixel buffer length does not match `width * height * 4`.
    #[error("Syphon frame byte length does not match dimensions")]
    PixelSizeMismatch,
    /// Frame dimensions overflow `usize` when computing the expected length.
    #[error("Syphon frame dimensions are too large")]
    DimensionsOverflow,
    /// The server name is empty after trimming.
    #[error("Syphon server name must not be empty")]
    EmptyServerName,
    /// `syphon-rs` could not create or resize the Metal server.
    #[error("Syphon server failed: {0}")]
    Server(&'static str),
}

/// Options for a Syphon publisher.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyphonPublisherOptions {
    /// Name advertised in `SyphonServerDirectory`.
    pub server_name: String,
}

/// A running Syphon server that accepts tightly packed RGBA8 frames.
pub struct SyphonPublisher {
    server_name: String,
    #[cfg(target_os = "macos")]
    inner: macos::MacosPublisher,
}

impl SyphonPublishError {
    /// Platform-specific unsupported error for the current compile target.
    pub const fn unsupported_on_this_os() -> Self {
        #[cfg(target_os = "windows")]
        {
            return Self::UnsupportedPlatform(WINDOWS_SYPHON_UNSUPPORTED);
        }
        #[cfg(target_os = "linux")]
        {
            return Self::UnsupportedPlatform(LINUX_SYPHON_UNSUPPORTED);
        }
        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        {
            Self::UnsupportedPlatform(SYPHON_MACOS_ONLY)
        }
    }
}

impl SyphonPublisherOptions {
    /// Native/GPUI debug identity. Distinct from the Tauri desktop server.
    pub fn native_debug() -> Self {
        Self { server_name: NATIVE_SYPHON_SERVER_NAME.to_string() }
    }
}

impl SyphonPublisher {
    /// Start a Syphon server advertised under `opts.server_name`.
    ///
    /// On macOS this constructs a `syphon-rs` Metal server at 1×1 and publishes
    /// one transparent frame so clients can discover a valid texture immediately.
    /// Size is recreated on the first real [`Self::publish_rgba`] when dimensions
    /// change, matching desktop `native_output`.
    pub fn start(opts: SyphonPublisherOptions) -> Result<Self, SyphonPublishError> {
        let server_name = validated_server_name(&opts.server_name)?;
        #[cfg(not(target_os = "macos"))]
        {
            let _ = server_name;
            return Err(SyphonPublishError::unsupported_on_this_os());
        }
        #[cfg(target_os = "macos")]
        {
            let inner = macos::MacosPublisher::start(&server_name)?;
            Ok(Self { server_name, inner })
        }
    }

    /// Directory name this publisher is advertising.
    pub fn server_name(&self) -> &str {
        &self.server_name
    }

    /// Upload tightly packed RGBA8 pixels and publish them as the current frame.
    pub fn publish_rgba(
        &mut self,
        width: u32,
        height: u32,
        pixels: &[u8],
    ) -> Result<(), SyphonPublishError> {
        validate_rgba(width, height, pixels)?;
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (width, height, pixels);
            Err(SyphonPublishError::unsupported_on_this_os())
        }
        #[cfg(target_os = "macos")]
        {
            self.inner.publish_rgba(width, height, pixels)
        }
    }

    /// Stop the server and remove it from the Syphon directory.
    ///
    /// Dropping [`SyphonPublisher`] has the same effect.
    pub fn stop(self) {}
}

/// Expected tightly packed RGBA8 length for `width` × `height`.
pub fn expected_rgba_len(width: u32, height: u32) -> Result<usize, SyphonPublishError> {
    usize::try_from(width)
        .ok()
        .and_then(|width| usize::try_from(height).ok().and_then(|height| width.checked_mul(height)))
        .and_then(|pixels| pixels.checked_mul(RGBA_CHANNELS))
        .ok_or(SyphonPublishError::DimensionsOverflow)
}

/// Reject zero dimensions or a buffer whose length is not `width * height * 4`.
pub fn validate_rgba(width: u32, height: u32, pixels: &[u8]) -> Result<usize, SyphonPublishError> {
    if width == 0 {
        return Err(SyphonPublishError::InvalidFrame("width must be greater than 0"));
    }
    if height == 0 {
        return Err(SyphonPublishError::InvalidFrame("height must be greater than 0"));
    }
    let expected = expected_rgba_len(width, height)?;
    if pixels.len() != expected {
        return Err(SyphonPublishError::PixelSizeMismatch);
    }
    Ok(expected)
}

fn validated_server_name(name: &str) -> Result<String, SyphonPublishError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(SyphonPublishError::EmptyServerName);
    }
    Ok(trimmed.to_string())
}

#[cfg(target_os = "macos")]
mod macos {
    use super::SyphonPublishError;

    const INITIAL_WIDTH: u32 = 1;
    const INITIAL_HEIGHT: u32 = 1;
    const INITIAL_TRANSPARENT_RGBA: [u8; 4] = [0, 0, 0, 0];

    pub(super) struct MacosPublisher {
        server_name: String,
        server: syphon_rs::Server,
        width: u32,
        height: u32,
    }

    impl MacosPublisher {
        pub(super) fn start(server_name: &str) -> Result<Self, SyphonPublishError> {
            let mut server = syphon_rs::Server::new(server_name, INITIAL_WIDTH, INITIAL_HEIGHT)
                .map_err(|_| SyphonPublishError::Server("failed to create Syphon Metal server"))?;
            server.send_frame(&INITIAL_TRANSPARENT_RGBA);
            Ok(Self {
                server_name: server_name.to_string(),
                server,
                width: INITIAL_WIDTH,
                height: INITIAL_HEIGHT,
            })
        }

        pub(super) fn publish_rgba(
            &mut self,
            width: u32,
            height: u32,
            pixels: &[u8],
        ) -> Result<(), SyphonPublishError> {
            if width != self.width || height != self.height {
                // syphon-rs fixes Metal texture size at Server::new. Recreate so
                // clients observe the caller resolution instead of a stale plate.
                self.server =
                    syphon_rs::Server::new(&self.server_name, width, height).map_err(|_| {
                        SyphonPublishError::Server("failed to resize Syphon Metal server")
                    })?;
                self.width = width;
                self.height = height;
            }
            self.server.send_frame(pixels);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        expected_rgba_len, validate_rgba, SyphonPublishError, SyphonPublisher,
        SyphonPublisherOptions,
    };

    #[test]
    fn native_debug_name_is_locked_and_not_the_desktop_tauri_name() {
        let options = SyphonPublisherOptions::native_debug();
        assert_eq!(options.server_name, "Kotoba Beacon Native");
        assert_eq!(super::NATIVE_SYPHON_SERVER_NAME, "Kotoba Beacon Native");
        assert_ne!(options.server_name, "Kotoba Beacon");
        assert_ne!(super::NATIVE_SYPHON_SERVER_NAME, "Kotoba Beacon");
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
            Err(SyphonPublishError::DimensionsOverflow)
        );
    }

    #[test]
    fn validate_rgba_accepts_matching_buffer() {
        assert_eq!(validate_rgba(1, 1, &[1, 2, 3, 4]), Ok(4));
        assert_eq!(validate_rgba(2, 1, &[0, 0, 0, 0, 255, 0, 255, 255]), Ok(8));
    }

    #[test]
    fn validate_rgba_rejects_mismatched_pixel_length() {
        assert_eq!(validate_rgba(2, 1, &[0, 0, 0, 0]), Err(SyphonPublishError::PixelSizeMismatch));
        assert_eq!(validate_rgba(1, 1, &[0, 0, 0]), Err(SyphonPublishError::PixelSizeMismatch));
        assert_eq!(
            validate_rgba(1, 1, &[0, 0, 0, 0, 0]),
            Err(SyphonPublishError::PixelSizeMismatch)
        );
    }

    #[test]
    fn validate_rgba_rejects_zero_dimensions() {
        assert_eq!(
            validate_rgba(0, 1, &[0, 0, 0, 0]),
            Err(SyphonPublishError::InvalidFrame("width must be greater than 0"))
        );
        assert_eq!(
            validate_rgba(1, 0, &[0, 0, 0, 0]),
            Err(SyphonPublishError::InvalidFrame("height must be greater than 0"))
        );
    }

    #[test]
    fn start_rejects_empty_server_name() {
        match SyphonPublisher::start(SyphonPublisherOptions { server_name: String::new() }) {
            Err(error) => assert_eq!(error, SyphonPublishError::EmptyServerName),
            Ok(_) => panic!("empty name must be rejected"),
        }
        match SyphonPublisher::start(SyphonPublisherOptions { server_name: "   ".to_string() }) {
            Err(error) => assert_eq!(error, SyphonPublishError::EmptyServerName),
            Ok(_) => panic!("whitespace-only name must be rejected"),
        }
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_start_is_unsupported() {
        let error = SyphonPublisher::start(SyphonPublisherOptions::native_debug())
            .expect_err("non-macOS must stub start");
        match error {
            SyphonPublishError::UnsupportedPlatform(message) => {
                assert!(
                    message == super::WINDOWS_SYPHON_UNSUPPORTED
                        || message == super::LINUX_SYPHON_UNSUPPORTED
                        || message == super::SYPHON_MACOS_ONLY,
                    "unexpected unsupported message: {message}"
                );
            }
            other => panic!("unexpected start error: {other}"),
        }
    }

    #[test]
    fn windows_and_linux_syphon_messages_are_locked() {
        assert_eq!(
            super::WINDOWS_SYPHON_UNSUPPORTED,
            "Syphon is macOS-only; use --spout to publish Kotoba Beacon Native via Spout2"
        );
        assert_eq!(
            super::LINUX_SYPHON_UNSUPPORTED,
            "Syphon is macOS-only; on Linux use the Native browser-source on http://127.0.0.1:1521"
        );
    }

    #[test]
    fn publish_rgba_rejects_mismatched_pixel_length_before_transport() {
        match SyphonPublisher::start(SyphonPublisherOptions::native_debug()) {
            Ok(mut publisher) => {
                assert_eq!(publisher.server_name(), "Kotoba Beacon Native");
                let error = publisher
                    .publish_rgba(2, 1, &[0, 0, 0, 0])
                    .expect_err("undersized buffer must be rejected");
                assert_eq!(error, SyphonPublishError::PixelSizeMismatch);
                publisher.stop();
            }
            Err(SyphonPublishError::UnsupportedPlatform(_)) => {}
            Err(SyphonPublishError::Server(_)) => {
                assert_eq!(
                    validate_rgba(2, 1, &[0, 0, 0, 0]),
                    Err(SyphonPublishError::PixelSizeMismatch)
                );
            }
            Err(error) => panic!("unexpected start error: {error}"),
        }
    }

    /// Needs a display / GPU and a linked Syphon.framework. Not part of the
    /// default `cargo test` gate.
    #[test]
    #[ignore]
    fn live_publish_rgba_to_syphon_directory() {
        let mut publisher = SyphonPublisher::start(SyphonPublisherOptions::native_debug())
            .expect("live Syphon server requires Metal and Syphon.framework");
        assert_eq!(publisher.server_name(), "Kotoba Beacon Native");
        publisher
            .publish_rgba(2, 1, &[255, 0, 255, 255, 0, 160, 160, 255])
            .expect("2x1 RGBA frame must publish");
        publisher.stop();
    }
}
