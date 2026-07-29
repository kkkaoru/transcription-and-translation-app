#[cfg(any(
    all(windows, feature = "native-output"),
    all(target_os = "macos", feature = "native-output")
))]
use std::sync::mpsc;
use std::sync::mpsc::Sender;
#[cfg(any(
    all(windows, feature = "native-output"),
    all(target_os = "macos", feature = "native-output")
))]
use std::time::Duration;

pub struct OverlayFrame {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

pub struct NativeOutputHandle {
    sender: Option<Sender<OverlayFrame>>,
    kind: String,
}

impl NativeOutputHandle {
    pub fn new(width: u32, height: u32) -> Self {
        let _ = (width, height);
        #[cfg(all(windows, feature = "native-output"))]
        {
            if let Some(sender) = start_spout(width, height) {
                return Self { sender: Some(sender), kind: "spout2".to_string() };
            }
        }

        #[cfg(all(target_os = "macos", feature = "native-output"))]
        {
            if let Some(sender) = start_syphon(width, height) {
                return Self { sender: Some(sender), kind: "syphon".to_string() };
            }
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
        match &self.sender {
            Some(sender) => {
                sender.send(frame).map_err(|_| "native output worker stopped".to_string())
            }
            None => Ok(()),
        }
    }
}

#[cfg(all(windows, feature = "native-output"))]
fn start_spout(width: u32, height: u32) -> Option<Sender<OverlayFrame>> {
    let (frame_sender, frame_receiver) = mpsc::channel::<OverlayFrame>();
    let (ready_sender, ready_receiver) = mpsc::channel::<bool>();
    std::thread::spawn(move || {
        // The DirectX path owns its D3D11 device and accepts CPU RGBA pixels,
        // so the Tauri WebView does not need to expose or share a GL context.
        let mut sender = match spout2::dx::Sender::new("Caption Bridge") {
            Ok(sender) => sender,
            Err(_) => {
                let _ = ready_sender.send(false);
                return;
            }
        };
        let _ = ready_sender.send(true);
        for frame in frame_receiver {
            if frame.width == width && frame.height == height {
                let _ = sender.send_image(&frame.rgba, frame.width, frame.height);
            }
        }
    });
    ready_receiver
        .recv_timeout(Duration::from_secs(2))
        .ok()
        .filter(|ready| *ready)
        .map(|_| frame_sender)
}

#[cfg(all(target_os = "macos", feature = "native-output"))]
fn start_syphon(width: u32, height: u32) -> Option<Sender<OverlayFrame>> {
    let (frame_sender, frame_receiver) = mpsc::channel::<OverlayFrame>();
    let (ready_sender, ready_receiver) = mpsc::channel::<bool>();
    std::thread::spawn(move || {
        let mut server = match syphon_rs::Server::new("Caption Bridge", width, height) {
            Ok(server) => server,
            Err(_) => {
                let _ = ready_sender.send(false);
                return;
            }
        };
        let _ = ready_sender.send(true);
        for frame in frame_receiver {
            if frame.width == width && frame.height == height {
                server.send_frame(&frame.rgba);
            }
        }
    });
    ready_receiver
        .recv_timeout(Duration::from_secs(2))
        .ok()
        .filter(|ready| *ready)
        .map(|_| frame_sender)
}
