#[cfg(any(windows, target_os = "macos", test))]
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
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

#[cfg(any(windows, target_os = "macos", test))]
enum ReceiveOutcome {
    Frame(OverlayFrame),
    Closed,
    Wait,
}

impl LatestFrameSender {
    #[cfg(any(windows, target_os = "macos", test))]
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

    #[cfg(any(windows, target_os = "macos", test))]
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

#[cfg(any(windows, target_os = "macos", test))]
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

/// Drain the latest-wins mailbox into a native transport (Spout/Syphon).
///
/// Frame dimensions are the configured overlay resolution from the publisher.
/// Transports that fix size at construction (Syphon) recreate when the frame
/// size changes so clients always see the settings resolution, not a stale
/// plate from an earlier config. On the first transport error the mailbox is
/// closed so subsequent `NativeOutputHandle::publish` calls return an error
/// instead of enqueueing frames that can never reach OBS.
#[cfg(any(windows, target_os = "macos", test))]
fn pump_native_frames<F>(receiver: &LatestFrameSender, mut send: F)
where
    F: FnMut(&OverlayFrame) -> Result<(), String>,
{
    while let Some(frame) = receiver.receive() {
        if let Err(error) = send(&frame) {
            log::error!(
                "native output transport failed: {error}; closing mailbox so publishers surface the failure"
            );
            receiver.close();
            break;
        }
    }
}

/// A running native-output worker: the latest-wins mailbox the renderer
/// publishes into, plus the thread's join handle so teardown can wait for the
/// worker to exit instead of leaking a detached thread.
struct NativeOutputWorker {
    sender: LatestFrameSender,
    join_handle: std::thread::JoinHandle<()>,
}

/// Run a native-output worker body with panic containment. A panic inside the
/// worker (e.g. a panicking transport call) must not leave `closed == false`,
/// which would let publishers keep receiving `Ok(())` while OBS freezes on a
/// stale texture. Closing the mailbox here gives publish the same error
/// contract as the transport-failure path.
#[cfg(any(windows, target_os = "macos", test))]
fn run_worker<F>(frame_receiver: LatestFrameSender, body: F)
where
    F: FnOnce() + std::panic::UnwindSafe,
{
    if let Err(panic) = std::panic::catch_unwind(body) {
        log::error!(
            "native output worker panicked: {}; closing mailbox so publishers surface the failure",
            panic_message(&panic)
        );
        frame_receiver.close();
    }
}

#[cfg(any(windows, target_os = "macos", test))]
fn panic_message(panic: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = panic.downcast_ref::<&str>() {
        message.to_string()
    } else if let Some(message) = panic.downcast_ref::<String>() {
        message.clone()
    } else {
        "unknown panic payload".to_string()
    }
}

/// Wait up to `timeout` for the worker to report readiness. A constructor that
/// never finishes (or reports failure) must not leave the worker thread blocked
/// forever in `receive()`: closing the mailbox unblocks it via the Closed state
/// so the thread exits instead of leaking.
#[cfg(any(windows, target_os = "macos", test))]
fn await_ready_or_close(
    ready_receiver: mpsc::Receiver<bool>,
    frame_sender: &LatestFrameSender,
    timeout: Duration,
) -> Option<LatestFrameSender> {
    match ready_receiver.recv_timeout(timeout) {
        Ok(true) => Some(frame_sender.clone()),
        Ok(false) | Err(_) => {
            frame_sender.close();
            None
        }
    }
}

/// How long teardown waits for the Syphon/Spout worker to observe mailbox
/// close, drop the native server (`SyphonMetalServer::stop` / Spout sender),
/// and exit. Longer than a single video frame so a clean app quit unregisters
/// the server from the Syphon directory before the process disappears.
const WORKER_JOIN_TIMEOUT: Duration = Duration::from_millis(2_000);

/// Close the worker's mailbox and wait briefly for the worker thread to exit.
/// A worker stuck inside a blocking constructor (e.g. SyphonServer::new or
/// D3D11 device creation hanging) must never block teardown indefinitely, so
/// the wait is bounded and the thread is detached when it does not finish.
fn join_worker(worker: NativeOutputWorker) {
    worker.sender.close();
    let deadline = std::time::Instant::now() + WORKER_JOIN_TIMEOUT;
    while !worker.join_handle.is_finished() {
        if std::time::Instant::now() >= deadline {
            log::warn!(
                "native output worker did not exit within {}ms; detaching so app shutdown can continue",
                WORKER_JOIN_TIMEOUT.as_millis()
            );
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let _ = worker.join_handle.join();
}

pub struct NativeOutputHandle {
    worker: Option<NativeOutputWorker>,
    kind: String,
    width: u32,
    height: u32,
}

impl NativeOutputHandle {
    /// Prefer the transparent-window lane. Syphon/Spout2 only start when the
    /// user explicitly enables native output in settings.
    pub fn new(width: u32, height: u32) -> Self {
        Self::transparent_window(width, height)
    }

    pub fn with_native_enabled(width: u32, height: u32, enabled: bool) -> Self {
        if !enabled {
            return Self::transparent_window(width, height);
        }
        #[cfg(windows)]
        if let Some(worker) = start_spout(width, height) {
            return Self {
                worker: Some(worker),
                kind: "spout2".to_string(),
                width,
                height,
            };
        }

        // The vendored Syphon.framework is a universal build with the Metal
        // server classes, so macOS (arm64 and x86_64) publishes captions over
        // Syphon. Test builds skip the real transport so unit tests stay
        // hermetic (no Metal device or Syphon directory registration).
        #[cfg(all(target_os = "macos", not(test)))]
        if let Some(worker) = start_syphon(width, height) {
            return Self {
                worker: Some(worker),
                kind: "syphon".to_string(),
                width,
                height,
            };
        }

        Self::transparent_window(width, height)
    }

    fn transparent_window(width: u32, height: u32) -> Self {
        Self { worker: None, kind: "transparent-window".to_string(), width, height }
    }

    /// Idle handle used during app teardown. Dropping a previous handle stops
    /// Syphon/Spout; this placeholder keeps the managed mutex occupied without
    /// re-registering a native server.
    pub fn inactive() -> Self {
        Self { worker: None, kind: "stopped".to_string(), width: 0, height: 0 }
    }

    pub fn kind(&self) -> &str {
        &self.kind
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    /// Build a handle reporting an arbitrary kind without starting a real
    /// transport. `NativeOutputHandle::new` cannot produce "spout2"/"syphon"
    /// in test builds (the real transports are gated `not(test)`), so callers
    /// outside this module that need to exercise a native-output-active code
    /// path in their own unit tests construct one through this helper instead
    /// of reaching into private fields.
    #[cfg(test)]
    pub(crate) fn for_test_kind(kind: &str) -> Self {
        Self { worker: None, kind: kind.to_string(), width: 0, height: 0 }
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
        let Some(worker) = self.worker.as_ref() else {
            return Ok(());
        };
        match worker.sender.send_latest(frame)? {
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
        if let Some(worker) = self.worker.take() {
            join_worker(worker);
        }
    }
}

/// Copy an RGBA pixel buffer into `bgra` with the red and blue channels
/// swapped, validating the byte length against `width * height * 4` first.
///
/// Spout's shared texture defaults to `DXGI_FORMAT_B8G8R8A8_UNORM` and
/// `spout2::dx::Sender::send_image` uploads CPU pixels verbatim with no channel
/// conversion, while the overlay canvas produces premultiplied RGBA bytes
/// (`premultiplyStraightRgba` in NativeFramePublisher). Without this swap the
/// bytes would not match the texture format and OBS would render captions with
/// red and blue exchanged. Premultiplied alpha is preserved so transparent
/// regions stay see-through when the Spout source allows transparency. The
/// buffer is reused across frames so the native worker thread does not allocate
/// per frame.
#[cfg(any(windows, test))]
fn prepare_spout_bgra(
    rgba: &[u8],
    width: u32,
    height: u32,
    bgra: &mut Vec<u8>,
) -> Result<(), String> {
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "spout frame dimensions overflow".to_string())?;
    if rgba.len() != expected {
        return Err(format!(
            "spout frame byte length {} does not match dimensions {}x{}",
            rgba.len(),
            width,
            height
        ));
    }
    bgra.clear();
    bgra.extend_from_slice(rgba);
    for pixel in bgra.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    Ok(())
}

#[cfg(windows)]
fn start_spout(width: u32, height: u32) -> Option<NativeOutputWorker> {
    let frame_sender = LatestFrameSender::new();
    let frame_receiver = frame_sender.clone();
    let (ready_sender, ready_receiver) = mpsc::channel::<bool>();
    let join_handle = std::thread::spawn(move || {
        let body_receiver = frame_receiver.clone();
        run_worker(
            frame_receiver,
            std::panic::AssertUnwindSafe(move || {
                // The DirectX path owns its D3D11 device, so the Tauri WebView does
                // not need to expose or share a GL context. The canvas produces
                // RGBA pixels; `prepare_spout_bgra` swaps them to BGRA to match
                // Spout's default B8G8R8A8 shared-texture format so OBS does not
                // see red/blue swapped.
                let mut sender = match spout2::dx::Sender::new("Kotoba Beacon") {
                    Ok(sender) => sender,
                    Err(error) => {
                        eprintln!("[native-output] Spout2 sender failed to start: {error}");
                        let _ = ready_sender.send(false);
                        return;
                    }
                };
                // Spout registers the sender in `SendImage`, not in `Sender::new`.
                // Publish one transparent frame before reporting readiness so an
                // OBS Spout client can discover the source immediately, even when
                // the overlay webview has not painted its first caption yet.
                let initial_len = (width as usize)
                    .checked_mul(height as usize)
                    .and_then(|pixels| pixels.checked_mul(4));
                let Some(initial_len) = initial_len else {
                    let _ = ready_sender.send(false);
                    return;
                };
                let mut bgra = vec![0u8; initial_len];
                if let Err(error) = sender.send_image(&bgra, width, height) {
                    log::warn!("spout initial transparent frame failed: {error}");
                    let _ = ready_sender.send(false);
                    return;
                }
                let _ = ready_sender.send(true);
                let mut current_width = width;
                let mut current_height = height;
                pump_native_frames(&body_receiver, |frame| {
                    // Spout accepts per-frame dimensions; keep the reusable
                    // BGRA buffer matched to the configured overlay resolution
                    // the publisher sends (settings width×height).
                    if frame.width != current_width || frame.height != current_height {
                        eprintln!(
                            "[native-output] Spout2 resizing {}x{} -> {}x{}",
                            current_width, current_height, frame.width, frame.height
                        );
                        current_width = frame.width;
                        current_height = frame.height;
                    }
                    prepare_spout_bgra(&frame.rgba, frame.width, frame.height, &mut bgra)?;
                    sender
                        .send_image(&bgra, frame.width, frame.height)
                        .map_err(|error| format!("spout send_image failed: {error}"))
                });
            }),
        );
    });
    let ready = await_ready_or_close(ready_receiver, &frame_sender, Duration::from_secs(2));
    if ready.is_none() {
        // Keep ownership of the handle on startup failure. Closing the mailbox
        // wakes a worker already waiting in `receive`; `join_worker` also gives
        // a slow native constructor the same bounded teardown as normal Drop.
        join_worker(NativeOutputWorker { sender: frame_sender, join_handle });
        return None;
    }
    ready.map(|sender| NativeOutputWorker { sender, join_handle })
}

#[cfg(all(target_os = "macos", not(test)))]
#[allow(clippy::excessive_nesting)]
fn start_syphon(width: u32, height: u32) -> Option<NativeOutputWorker> {
    let frame_sender = LatestFrameSender::new();
    let frame_receiver = frame_sender.clone();
    let (ready_sender, ready_receiver) = mpsc::channel::<bool>();
    let join_handle = std::thread::spawn(move || {
        let body_receiver = frame_receiver.clone();
        run_worker(
            frame_receiver,
            std::panic::AssertUnwindSafe(move || {
                let mut server = match syphon_rs::Server::new("Kotoba Beacon", width, height) {
                    Ok(server) => server,
                    Err(error) => {
                        // Surface the concrete failure (missing Metal class,
                        // wrong-arch framework, device unavailable) so a silent
                        // fallback to transparent-window is diagnosable in logs.
                        eprintln!("[native-output] Syphon server failed to start: {error:?}");
                        let _ = ready_sender.send(false);
                        return;
                    }
                };
                eprintln!(
                    "[native-output] Syphon server ready: name=Kotoba Beacon size={width}x{height}"
                );
                // Publish an initial transparent frame so Syphon clients can
                // render a valid texture immediately after discovery, before the
                // overlay webview sends its first caption frame.
                let initial_len = (width as usize)
                    .checked_mul(height as usize)
                    .and_then(|pixels| pixels.checked_mul(4));
                let Some(initial_len) = initial_len else {
                    let _ = ready_sender.send(false);
                    return;
                };
                let initial_frame = vec![0u8; initial_len];
                server.send_frame(&initial_frame);
                let _ = ready_sender.send(true);
                // syphon-rs fixes Metal texture size at Server::new. When the
                // publisher switches to a new settings resolution, recreate the
                // server so clients observe the configured width×height instead
                // of a stale plate (dropping mismatched frames would leave the
                // old size visible forever).
                let mut current_width = width;
                let mut current_height = height;
                let mut server = Some(server);
                pump_native_frames(&body_receiver, |frame| {
                    let expected = (frame.width as usize)
                        .checked_mul(frame.height as usize)
                        .and_then(|pixels| pixels.checked_mul(4))
                        .ok_or_else(|| "syphon frame dimensions overflow".to_string())?;
                    if frame.rgba.len() != expected {
                        return Err(format!(
                            "syphon frame byte length {} does not match dimensions {}x{}",
                            frame.rgba.len(),
                            frame.width,
                            frame.height
                        ));
                    }
                    if frame.width != current_width || frame.height != current_height {
                        eprintln!(
                            "[native-output] Syphon resizing {}x{} -> {}x{} (settings resolution)",
                            current_width, current_height, frame.width, frame.height
                        );
                        // Drop calls SyphonMetalServer::stop and removes the
                        // directory entry before the replacement registers.
                        server = None;
                        server = Some(
                            syphon_rs::Server::new("Kotoba Beacon", frame.width, frame.height)
                                .map_err(|error| format!("syphon resize failed: {error:?}"))?,
                        );
                        current_width = frame.width;
                        current_height = frame.height;
                    }
                    let active = server
                        .as_mut()
                        .ok_or_else(|| "syphon server missing after resize".to_string())?;
                    active.send_frame(&frame.rgba);
                    Ok(())
                });
            }),
        );
    });
    let ready = await_ready_or_close(ready_receiver, &frame_sender, Duration::from_secs(2));
    if ready.is_none() {
        // Keep ownership of the handle on startup failure. Closing the mailbox
        // wakes a worker already waiting in `receive`; `join_worker` also gives
        // a slow native constructor the same bounded teardown as normal Drop.
        join_worker(NativeOutputWorker { sender: frame_sender, join_handle });
        return None;
    }
    ready.map(|sender| NativeOutputWorker { sender, join_handle })
}

#[cfg(test)]
mod tests {
    use super::{LatestFrameSender, OverlayFrame};
    use std::sync::{Arc, Condvar, Mutex};

    fn sender() -> LatestFrameSender {
        LatestFrameSender::new()
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

    #[test]
    #[allow(clippy::excessive_nesting)]
    fn transport_send_failure_closes_mailbox_so_publishers_see_the_error() {
        let sender = sender();
        let worker = sender.clone();
        assert!(matches!(sender.send_latest(frame(1)), Ok(super::EnqueueOutcome::Enqueued)));

        let pump = std::thread::spawn(move || {
            super::pump_native_frames(&worker, |_frame| {
                Err("simulated spout/syphon failure".to_string())
            });
        });
        pump.join().expect("pump thread should finish after the first send error");

        // The renderer-side publish path enqueues through send_latest. After a
        // transport failure the mailbox must reject new frames rather than
        // silently accepting them while OBS stays frozen on the last good frame.
        assert!(matches!(
            sender.send_latest(frame(2)),
            Err(error) if error == "native output worker stopped"
        ));
        assert!(sender.receive().is_none());
    }

    #[test]
    #[allow(clippy::excessive_nesting)]
    fn transport_send_success_keeps_mailbox_open_until_close() {
        let sender = sender();
        let worker = sender.clone();
        assert!(matches!(sender.send_latest(frame(1)), Ok(super::EnqueueOutcome::Enqueued)));
        assert!(matches!(
            sender.send_latest(frame(2)),
            Ok(super::EnqueueOutcome::Replaced { replacements: 1 })
        ));

        let (done_sender, done_receiver) = std::sync::mpsc::channel();
        let pump = std::thread::spawn(move || {
            let mut sent = Vec::new();
            super::pump_native_frames(&worker, |frame| {
                sent.push(frame.rgba[0]);
                let _ = done_sender.send(sent.len());
                Ok(())
            });
            sent
        });
        // Wait until the latest pending frame has been delivered, then close.
        assert_eq!(done_receiver.recv().expect("first delivery"), 1);
        sender.close();
        let sent = pump.join().expect("pump should exit after close");
        assert_eq!(sent, vec![2]);
        assert!(matches!(
            sender.send_latest(frame(3)),
            Err(error) if error == "native output worker stopped"
        ));
    }

    #[cfg(any(windows, test))]
    #[test]
    fn prepare_spout_bgra_swaps_red_and_blue_to_match_bgra_texture() {
        let mut bgra = Vec::new();
        super::prepare_spout_bgra(&[255, 0, 0, 255, 0, 255, 0, 128], 2, 1, &mut bgra)
            .expect("2x1 frame is valid");
        // red (255, 0, 0) -> blue (0, 0, 255); green (0, 255, 0) is unchanged.
        assert_eq!(bgra, [0, 0, 255, 255, 0, 255, 0, 128]);
    }

    #[cfg(any(windows, test))]
    #[test]
    fn prepare_spout_bgra_rejects_byte_length_mismatch() {
        let mut bgra = Vec::new();
        let error = super::prepare_spout_bgra(&[0; 4], 2, 1, &mut bgra)
            .expect_err("undersized buffer must be rejected");
        assert!(error.contains("does not match dimensions 2x1"), "unexpected error: {error}");
    }

    #[cfg(any(windows, test))]
    #[test]
    fn prepare_spout_bgra_reuses_buffer_without_growing_per_frame() {
        let mut bgra = vec![0u8; 16];
        let capacity = bgra.capacity();
        super::prepare_spout_bgra(&[1, 2, 3, 4], 1, 1, &mut bgra).expect("1x1 frame is valid");
        assert_eq!(bgra, [3, 2, 1, 4]);
        super::prepare_spout_bgra(&[5, 6, 7, 8], 1, 1, &mut bgra).expect("second 1x1 frame");
        assert_eq!(bgra, [7, 6, 5, 8]);
        assert_eq!(bgra.capacity(), capacity, "buffer must not reallocate per frame");
    }

    #[test]
    fn closing_the_mailbox_unblocks_a_waiting_worker_thread_and_makes_it_joinable() {
        let sender = sender();
        let worker = sender.clone();
        let (started_sender, started_receiver) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(move || {
            started_sender.send(()).expect("test receiver should be alive");
            worker.receive()
        });
        started_receiver.recv().expect("worker should begin waiting in receive()");
        sender.close();

        assert!(
            handle.join().expect("worker thread must exit after the mailbox closes").is_none(),
            "a closed mailbox must unblock receive() with None"
        );
    }

    #[test]
    #[allow(clippy::excessive_nesting)]
    fn panicking_worker_body_closes_the_mailbox_so_publishers_see_the_error() {
        let sender = sender();
        let worker = sender.clone();
        assert!(matches!(sender.send_latest(frame(1)), Ok(super::EnqueueOutcome::Enqueued)));

        let handle = std::thread::spawn(move || {
            let body_receiver = worker.clone();
            super::run_worker(
                worker,
                std::panic::AssertUnwindSafe(move || {
                    super::pump_native_frames(&body_receiver, |_frame| {
                        panic!("simulated native transport panic");
                    });
                }),
            );
        });
        handle.join().expect("worker thread must exit after the panic is contained");

        // A panicked worker must not leave the mailbox open: publishers keep
        // receiving Ok(()) while OBS freezes on a stale texture. The panic
        // wrapper closes it with the same error contract as a transport failure.
        assert!(matches!(
            sender.send_latest(frame(2)),
            Err(error) if error == "native output worker stopped"
        ));
        assert!(sender.receive().is_none());
    }

    #[test]
    fn readiness_timeout_closes_the_mailbox_so_the_worker_thread_exits() {
        let sender = sender();
        let worker = sender.clone();
        // ready_sender stays alive through the wait so recv_timeout observes a
        // timeout, not a disconnect; both paths close the mailbox, but the
        // timeout is the slow-constructor regression being guarded here.
        let (ready_sender, ready_receiver) = std::sync::mpsc::channel::<bool>();
        let handle = std::thread::spawn(move || worker.receive());
        std::thread::sleep(std::time::Duration::from_millis(50));
        let result = super::await_ready_or_close(
            ready_receiver,
            &sender,
            std::time::Duration::from_millis(10),
        );
        assert!(result.is_none(), "a timed-out constructor must not yield a sender");
        assert!(
            handle.join().expect("worker thread must exit after the mailbox closes").is_none(),
            "closing the mailbox on readiness timeout must unblock the worker"
        );
        assert!(matches!(
            sender.send_latest(frame(1)),
            Err(error) if error == "native output worker stopped"
        ));
        drop(ready_sender);
    }

    #[test]
    fn not_ready_worker_closes_the_mailbox_so_the_worker_thread_exits() {
        let sender = sender();
        let worker = sender.clone();
        let (ready_sender, ready_receiver) = std::sync::mpsc::channel::<bool>();
        let handle = std::thread::spawn(move || worker.receive());
        std::thread::sleep(std::time::Duration::from_millis(50));
        ready_sender.send(false).expect("test channel should be open");
        let result =
            super::await_ready_or_close(ready_receiver, &sender, std::time::Duration::from_secs(1));
        assert!(result.is_none(), "a failed constructor must not yield a sender");
        assert!(
            handle.join().expect("worker thread must exit after the mailbox closes").is_none(),
            "closing the mailbox on not-ready must unblock the worker"
        );
        assert!(matches!(
            sender.send_latest(frame(1)),
            Err(error) if error == "native output worker stopped"
        ));
    }

    #[test]
    fn readiness_success_keeps_the_mailbox_open() {
        let sender = sender();
        let (ready_sender, ready_receiver) = std::sync::mpsc::channel::<bool>();
        ready_sender.send(true).expect("test channel should be open");
        let result = super::await_ready_or_close(
            ready_receiver,
            &sender,
            std::time::Duration::from_millis(100),
        );
        let alive = result.expect("a ready worker must yield a sender");
        // The success path must keep the mailbox open: frames enqueue and the
        // worker can still drain them.
        assert!(matches!(alive.send_latest(frame(1)), Ok(super::EnqueueOutcome::Enqueued)));
        assert_eq!(
            alive.receive().expect("ready worker must still deliver frames").rgba,
            vec![1; 4]
        );
        sender.close();
    }

    /// Targets without a native transport (Linux, ...) must construct a
    /// no-op `transparent-window` handle: `publish` succeeds without a worker
    /// while `kind()` stays honest about the absence of a Spout2/Syphon
    /// sender. Windows and macOS test builds are excluded because they would
    /// start real transport workers.
    #[cfg(not(any(windows, target_os = "macos")))]
    #[test]
    fn no_transport_platforms_fall_back_to_a_noop_transparent_window_handle() {
        let output = super::NativeOutputHandle::new(1280, 720);
        assert_eq!(output.kind(), "transparent-window");
        let frame = OverlayFrame { rgba: vec![0; 1280 * 720 * 4], width: 1280, height: 720 };
        assert!(
            output.publish(frame).is_ok(),
            "a no-op handle must accept frames without a worker"
        );
    }

    /// A worker stuck inside a blocking transport call (e.g. a hung
    /// Spout/Syphon constructor or send) must not block teardown
    /// indefinitely: `join_worker` closes the mailbox, waits a bounded
    /// timeout, and detaches the thread when it cannot finish. `Drop` for
    /// `NativeOutputHandle` — and therefore `save_config` replacement and app
    /// shutdown — depends on this bound.
    #[test]
    #[allow(clippy::excessive_nesting)]
    fn join_worker_bounds_teardown_when_the_worker_thread_never_finishes() {
        let sender = sender();
        let worker_sender = sender.clone();
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let worker_gate = gate.clone();
        let (released_sender, released_receiver) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(move || {
            // Park on an unrelated condvar to simulate a transport call that
            // can neither observe the mailbox close nor finish on its own.
            let (lock, condvar) = &*worker_gate;
            let released = condvar
                .wait_while(lock.lock().expect("gate lock"), |released| !*released)
                .expect("gate condvar");
            drop(released);
            let _ = released_sender.send(());
            drop(worker_sender);
        });
        // Sleep briefly so the thread is parked before the bounded wait
        // starts; the thread cannot finish until it is released below.
        std::thread::sleep(std::time::Duration::from_millis(50));
        let output = super::NativeOutputWorker { sender: sender.clone(), join_handle: handle };
        let began = std::time::Instant::now();
        super::join_worker(output);
        assert!(
            began.elapsed() < std::time::Duration::from_secs(5),
            "join_worker must not block teardown indefinitely on a stuck worker"
        );
        assert!(matches!(
            sender.send_latest(frame(1)),
            Err(error) if error == "native output worker stopped"
        ));
        // Release the parked thread so it does not leak across the test
        // process, then confirm it observed the release.
        let (lock, condvar) = &*gate;
        let mut released = lock.lock().expect("gate lock");
        *released = true;
        condvar.notify_all();
        drop(released);
        released_receiver.recv().expect("stuck worker must exit after release");
    }

    #[test]
    fn dropping_the_handle_closes_the_mailbox_and_joins_the_worker_thread() {
        let sender = sender();
        let worker = sender.clone();
        let (started_sender, started_receiver) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(move || {
            started_sender.send(()).expect("test receiver should be alive");
            let _ = worker.receive();
        });
        started_receiver.recv().expect("worker should begin waiting");
        let output = super::NativeOutputHandle {
            worker: Some(super::NativeOutputWorker { sender: sender.clone(), join_handle: handle }),
            kind: "test".to_string(),
            width: 1,
            height: 1,
        };
        drop(output);
        assert!(matches!(
            sender.send_latest(frame(1)),
            Err(error) if error == "native output worker stopped"
        ));
    }
}
