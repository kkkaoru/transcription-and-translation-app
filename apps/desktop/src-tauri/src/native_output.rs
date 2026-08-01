#[cfg(not(any(windows, target_os = "macos")))]
use std::sync::mpsc::SyncSender;
#[cfg(any(windows, target_os = "macos"))]
use std::sync::mpsc::{self, SyncSender, TrySendError};
#[cfg(any(windows, target_os = "macos"))]
use std::time::Duration;

pub struct OverlayFrame {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

pub struct NativeOutputHandle {
    sender: Option<SyncSender<OverlayFrame>>,
    kind: String,
}

impl NativeOutputHandle {
    pub fn new(width: u32, height: u32) -> Self {
        let _ = (width, height);
        #[cfg(windows)]
        if let Some(sender) = start_spout(width, height) {
            return Self { sender: Some(sender), kind: "spout2".to_string() };
        }

        #[cfg(target_os = "macos")]
        if let Some(sender) = start_syphon(width, height) {
            return Self { sender: Some(sender), kind: "syphon".to_string() };
        }

        Self { sender: None, kind: "transparent-window".to_string() }
    }

    pub fn kind(&self) -> &str {
        &self.kind
    }

    pub fn publish(&self, frame: OverlayFrame) -> Result<(), String> {
        let expected_length = usize::try_from(frame.width)
            .ok()
            .and_then(|width| {
                usize::try_from(frame.height).ok().and_then(|height| width.checked_mul(height))
            })
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| "native output frame dimensions are too large".to_string())?;
        if frame.rgba.len() != expected_length {
            return Err("native output frame byte length does not match dimensions".to_string());
        }
        let Some(sender) = self.sender.as_ref() else {
            return Ok(());
        };
        #[cfg(any(windows, target_os = "macos"))]
        return match sender.try_send(frame) {
            Ok(()) | Err(TrySendError::Full(_)) => Ok(()),
            Err(TrySendError::Disconnected(_)) => Err("native output worker stopped".to_string()),
        };
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = (sender, frame);
            Ok(())
        }
    }
}

#[cfg(windows)]
fn start_spout(width: u32, height: u32) -> Option<SyncSender<OverlayFrame>> {
    let (frame_sender, frame_receiver) = mpsc::sync_channel::<OverlayFrame>(2);
    let (ready_sender, ready_receiver) = mpsc::channel::<bool>();
    std::thread::spawn(move || {
        // The DirectX path owns its D3D11 device and accepts CPU RGBA pixels,
        // so the Tauri WebView does not need to expose or share a GL context.
        let mut sender = match spout2::dx::Sender::new("Kotoba Beacon") {
            Ok(sender) => sender,
            Err(_) => {
                let _ = ready_sender.send(false);
                return;
            }
        };
        let _ = ready_sender.send(true);
        for frame in frame_receiver
            .into_iter()
            .filter(|frame| frame.width == width && frame.height == height)
        {
            let _ = sender.send_image(&frame.rgba, frame.width, frame.height);
        }
    });
    ready_receiver
        .recv_timeout(Duration::from_secs(2))
        .ok()
        .filter(|ready| *ready)
        .map(|_| frame_sender)
}

#[cfg(target_os = "macos")]
fn start_syphon(width: u32, height: u32) -> Option<SyncSender<OverlayFrame>> {
    let (frame_sender, frame_receiver) = mpsc::sync_channel::<OverlayFrame>(2);
    let (ready_sender, ready_receiver) = mpsc::channel::<bool>();
    std::thread::spawn(move || {
        let mut server = match syphon_rs::Server::new("Kotoba Beacon", width, height) {
            Ok(server) => server,
            Err(_) => {
                let _ = ready_sender.send(false);
                return;
            }
        };
        let _ = ready_sender.send(true);
        for frame in frame_receiver
            .into_iter()
            .filter(|frame| frame.width == width && frame.height == height)
        {
            server.send_frame(&frame.rgba);
        }
    });
    ready_receiver
        .recv_timeout(Duration::from_secs(2))
        .ok()
        .filter(|ready| *ready)
        .map(|_| frame_sender)
}
