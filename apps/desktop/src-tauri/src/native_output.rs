#[cfg(any(windows, all(target_os = "macos", target_arch = "x86_64")))]
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
#[cfg(any(windows, all(target_os = "macos", target_arch = "x86_64")))]
use std::time::Duration;

pub struct OverlayFrame {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// A bounded, latest-wins mailbox for native frame delivery.
///
/// The publisher can draw faster than Spout/Syphon accepts frames. Keeping
/// exactly one pending frame bounds memory while replacing an obsolete pending
/// frame ensures a temporary native-output stall cannot leave OBS displaying
/// an older caption once it catches up.
#[derive(Clone)]
struct LatestFrameSender {
    mailbox: Arc<LatestFrameMailbox>,
}

struct LatestFrameMailbox {
    state: Mutex<LatestFrameMailboxState>,
    available: Condvar,
}

struct LatestFrameMailboxState {
    pending: Option<OverlayFrame>,
    closed: bool,
    replacements: u64,
}

enum EnqueueOutcome {
    Enqueued,
    Replaced { replacements: u64 },
}

#[cfg(any(windows, all(target_os = "macos", target_arch = "x86_64"), test))]
enum ReceiveOutcome {
    Frame(OverlayFrame),
    Closed,
    Wait,
}

impl LatestFrameSender {
    #[cfg(any(windows, all(target_os = "macos", target_arch = "x86_64")))]
    fn new() -> Self {
        Self {
            mailbox: Arc::new(LatestFrameMailbox {
                state: Mutex::new(LatestFrameMailboxState {
                    pending: None,
                    closed: false,
                    replacements: 0,
                }),
                available: Condvar::new(),
            }),
        }
    }

    /// Store one pending frame, replacing an older pending frame when the
    /// native sender is backpressured. A replacement is intentionally visible
    /// in the native log (rate-limited by the caller), rather than silently
    /// losing the newest caption as `SyncSender::try_send` did.
    fn send_latest(&self, frame: OverlayFrame) -> Result<EnqueueOutcome, String> {
        let mut state = self
            .mailbox
            .state
            .lock()
            .map_err(|_| "native output mailbox lock poisoned".to_string())?;
        if state.closed {
            return Err("native output worker stopped".to_string());
        }
        let replaced = state.pending.replace(frame).is_some();
        let outcome = if replaced {
            state.replacements = state.replacements.saturating_add(1);
            EnqueueOutcome::Replaced { replacements: state.replacements }
        } else {
            EnqueueOutcome::Enqueued
        };
        self.mailbox.available.notify_one();
        Ok(outcome)
    }

    #[cfg(any(windows, all(target_os = "macos", target_arch = "x86_64"), test))]
    fn receive(&self) -> Option<OverlayFrame> {
        let mut state = self.mailbox.state.lock().ok()?;
        loop {
            match receive_outcome(&mut state) {
                ReceiveOutcome::Frame(frame) => return Some(frame),
                ReceiveOutcome::Closed => return None,
                ReceiveOutcome::Wait => state = self.mailbox.available.wait(state).ok()?,
            }
        }
    }

    fn close(&self) {
        if let Ok(mut state) = self.mailbox.state.lock() {
            state.closed = true;
            state.pending = None;
            self.mailbox.available.notify_all();
        }
    }
}

#[cfg(any(windows, all(target_os = "macos", target_arch = "x86_64"), test))]
fn receive_outcome(state: &mut LatestFrameMailboxState) -> ReceiveOutcome {
    match (state.pending.take(), state.closed) {
        (Some(frame), _) => ReceiveOutcome::Frame(frame),
        (None, true) => ReceiveOutcome::Closed,
        (None, false) => ReceiveOutcome::Wait,
    }
}

fn report_replacement(replacements: u64) {
    if replacements.is_power_of_two() {
        log::warn!(
            "native output backpressure: replaced {replacements} stale pending frame(s); latest frame retained"
        );
    }
}

pub struct NativeOutputHandle {
    sender: Option<LatestFrameSender>,
    kind: String,
}

impl NativeOutputHandle {
    pub fn new(width: u32, height: u32) -> Self {
        let _ = (width, height);
        #[cfg(windows)]
        if let Some(sender) = start_spout(width, height) {
            return Self { sender: Some(sender), kind: "spout2".to_string() };
        }

        // The vendored Syphon.framework is x86_64-only. Apple-silicon builds
        // intentionally use the transparent-window output until a universal
        // framework is supplied, rather than attempting a runtime load that
        // is known to be incompatible.
        #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
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
        match sender.send_latest(frame)? {
            EnqueueOutcome::Enqueued => Ok(()),
            EnqueueOutcome::Replaced { replacements } => {
                // Report at powers of two: a persistently stalled native sender
                // is visible in diagnostics without flooding the log at video
                // frame rate. The worker will publish the newest queued frame.
                report_replacement(replacements);
                Ok(())
            }
        }
    }
}

impl Drop for NativeOutputHandle {
    fn drop(&mut self) {
        if let Some(sender) = self.sender.take() {
            sender.close();
        }
    }
}

#[cfg(windows)]
fn start_spout(width: u32, height: u32) -> Option<LatestFrameSender> {
    let frame_sender = LatestFrameSender::new();
    let frame_receiver = frame_sender.clone();
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
        while let Some(frame) = frame_receiver.receive() {
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

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn start_syphon(width: u32, height: u32) -> Option<LatestFrameSender> {
    let frame_sender = LatestFrameSender::new();
    let frame_receiver = frame_sender.clone();
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
        while let Some(frame) = frame_receiver.receive() {
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

#[cfg(test)]
mod tests {
    use super::{LatestFrameMailbox, LatestFrameMailboxState, LatestFrameSender, OverlayFrame};
    use std::sync::{Arc, Condvar, Mutex};

    fn sender() -> LatestFrameSender {
        LatestFrameSender {
            mailbox: Arc::new(LatestFrameMailbox {
                state: Mutex::new(LatestFrameMailboxState {
                    pending: None,
                    closed: false,
                    replacements: 0,
                }),
                available: Condvar::new(),
            }),
        }
    }

    fn frame(value: u8) -> OverlayFrame {
        OverlayFrame { rgba: vec![value; 4], width: 1, height: 1 }
    }

    #[test]
    fn latest_wins_mailbox_replaces_an_obsolete_pending_frame() {
        let sender = sender();
        assert!(matches!(sender.send_latest(frame(1)), Ok(super::EnqueueOutcome::Enqueued)));
        assert!(matches!(
            sender.send_latest(frame(2)),
            Ok(super::EnqueueOutcome::Replaced { replacements: 1 })
        ));

        let latest = sender.receive().expect("latest frame should be available");
        assert_eq!(latest.rgba, vec![2; 4]);
        assert_eq!(latest.width, 1);
        assert_eq!(latest.height, 1);
    }

    #[test]
    fn closed_mailbox_rejects_new_frames_and_unblocks_the_worker() {
        let sender = sender();
        let worker = sender.clone();
        let (started_sender, started_receiver) = std::sync::mpsc::channel();
        let waiter = std::thread::spawn(move || {
            started_sender.send(()).expect("test receiver should be alive");
            worker.receive()
        });
        started_receiver.recv().expect("worker should begin waiting");
        sender.close();

        assert!(waiter.join().expect("worker should not panic").is_none());
        assert!(matches!(
            sender.send_latest(frame(3)),
            Err(error) if error == "native output worker stopped"
        ));
    }
}
