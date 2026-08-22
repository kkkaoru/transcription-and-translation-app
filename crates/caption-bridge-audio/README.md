# caption-bridge-audio

Native microphone capture for the future GPUI Caption Bridge application.

## API

- `list_input_devices()` enumerates input devices as `InputDevice { id, name, is_default }`.
- `AudioCapture::start(Some(id))` opens a persisted device id; `start(None)` uses the system default input. Read complete frames with `next_frame()` or non-blocking `try_next_frame()`, then call `stop()`.
- Capture frames are mono PCM16 at 16,000 Hz. The default frame duration is 640 ms and can be changed with `AudioCaptureConfig::chunk_ms`.
- `rms_dbfs()` provides RMS metering and `passes_silence_gate()` implements the fixed dBFS gate.
- `AdaptiveNoiseFloor` is opt-in through `AudioCaptureConfig::adaptive_noise_floor`; it fails open until ambient input is observed and speech-like chunks never define or raise the floor.

## Device IDs and permissions

The public device id is cpal's host-qualified `DeviceId` string (`host:backend-device-id`). cpal documents that these ids are intended to be stable across runs, disconnections, and reboots where the platform can provide a stable backend id. Device names are display labels only and are not used for selection. A future macOS application bundle must include the microphone usage description and request microphone permission under its final bundle id; cpal itself does not replace the macOS TCC permission flow.

## Resampling and browser-processing gap

The crate uses `rubato`'s cubic polynomial asynchronous resampler for deterministic chunk conversion, after interleaved channel averaging to mono. `cpal` supplies device I/O only: it does not provide browser `getUserMedia` noise suppression, echo cancellation, or automatic gain control. Those features need a separate DSP stage or platform audio-processing integration. The native path therefore exposes raw microphone audio plus the fixed/adaptive gate and RMS meter, rather than claiming parity with browser NS/AEC/AGC.

## Host backends

cpal selects a platform host; this crate does not wrap TCC/WASAPI/Pulse itself.

| OS | Typical cpal host | Permission / session notes |
|----|-------------------|----------------------------|
| macOS | Core Audio | TCC microphone prompt under the hosting bundle id (`com.kotobabeacon.native` for GPUI, `com.kotobabeacon.desktop` for Tauri). |
| Windows | WASAPI | Windows microphone privacy settings for the process. |
| Linux | ALSA, PulseAudio, or PipeWire | User session audio; PipeWire is the usual modern host. |
