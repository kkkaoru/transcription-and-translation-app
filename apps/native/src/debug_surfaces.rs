//! Optional Syphon and Spout publishers.

use caption_bridge_spout::{SpoutPublisher, SpoutPublisherOptions, NATIVE_SPOUT_SHARE_NAME};
use caption_bridge_syphon::{
    SyphonPublisher, SyphonPublisherOptions, NATIVE_SYPHON_SERVER_NAME, WINDOWS_SYPHON_UNSUPPORTED,
};

use crate::domain::{rasterize_live_caption, DebugLaunch, NativeStyleSettings};

pub struct DebugSurfaces {
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
        Self { syphon: None, spout: None }
    }

    pub fn publish_caption(
        &mut self,
        style: &NativeStyleSettings,
        source: &str,
        translation: &str,
        last_published_caption: Option<&(String, String)>,
    ) -> Result<Option<CaptionPublication>, String> {
        let Some(publication) = prepare_caption_publication_with(
            self.syphon.is_some() || self.spout.is_some(),
            last_published_caption,
            style,
            source,
            translation,
            caption_publication,
        ) else {
            return Ok(None);
        };
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

pub(crate) fn prepare_caption_publication_with<R>(
    has_active_surface: bool,
    last_published_caption: Option<&(String, String)>,
    style: &NativeStyleSettings,
    source: &str,
    translation: &str,
    rasterize: R,
) -> Option<CaptionPublication>
where
    R: FnOnce(&NativeStyleSettings, &str, &str) -> CaptionPublication,
{
    if !has_active_surface {
        return None;
    }
    if last_published_caption.is_some_and(|last| last.0 == source && last.1 == translation) {
        return None;
    }
    Some(rasterize(style, source, translation))
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
    let syphon = if launch.syphon {
        Some(
            SyphonPublisher::start(SyphonPublisherOptions::native_debug())
                .map_err(|error| error.to_string())?,
        )
    } else {
        None
    };
    let spout = if launch.spout {
        Some(
            SpoutPublisher::start(SpoutPublisherOptions::native_debug())
                .map_err(|error| error.to_string())?,
        )
    } else {
        None
    };
    Ok(DebugSurfaces { syphon, spout })
}

pub fn syphon_flag_error() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        Some(WINDOWS_SYPHON_UNSUPPORTED.to_string())
    }
    #[cfg(target_os = "linux")]
    {
        Some("Syphon is available only on macOS".to_string())
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
        Some("Spout is available only on Windows".to_string())
    }
    #[cfg(target_os = "linux")]
    {
        Some("Spout is available only on Windows".to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

pub fn print_debug_status(launch: DebugLaunch, surfaces: &Result<DebugSurfaces, String>) {
    match surfaces {
        Ok(started) => {
            if launch.syphon && started.syphon.is_some() {
                println!("Syphon: {NATIVE_SYPHON_SERVER_NAME}");
            }
            if launch.spout && started.spout.is_some() {
                println!("Spout: {NATIVE_SPOUT_SHARE_NAME}");
            }
        }
        Err(error) => println!("output initialization failed: {error}"),
    }
}

#[cfg(feature = "gpui")]
pub fn start_syphon(surfaces: &mut DebugSurfaces) -> Result<(), String> {
    if surfaces.syphon.is_some() {
        return Ok(());
    }
    if let Some(message) = syphon_flag_error() {
        return Err(message);
    }
    surfaces.syphon = Some(
        SyphonPublisher::start(SyphonPublisherOptions::native_debug())
            .map_err(|error| error.to_string())?,
    );
    Ok(())
}

#[cfg(feature = "gpui")]
pub fn stop_syphon(surfaces: &mut DebugSurfaces) {
    surfaces.syphon = None;
}
