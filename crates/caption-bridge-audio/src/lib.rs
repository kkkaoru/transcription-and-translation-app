//! Native microphone capture for the Caption Bridge GPUI application.
//!
//! The crate owns device discovery and cpal stream lifecycle, while the pure
//! conversion and gate helpers are usable without a live audio device. cpal
//! does not provide browser-style noise suppression, echo cancellation, or
//! automatic gain control; those settings must be implemented as a separate DSP
//! stage if the native app needs them.

use std::sync::mpsc::{self, Receiver, Sender, SyncSender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, StreamConfig};
use rubato::{Async, FixedAsync, PolynomialDegree, Resampler};
use thiserror::Error;

pub const TARGET_SAMPLE_RATE: u32 = 16_000;
pub const DEFAULT_CHUNK_MS: u32 = 640;
pub const DEFAULT_SILENCE_GATE_DB: f32 = -50.0;
pub const MIN_SUPPORTED_SAMPLE_RATE: u32 = 8_000;
pub const MAX_SUPPORTED_SAMPLE_RATE: u32 = 96_000;
const MAX_PCM_QUEUE_FRAMES: usize = 8;
const RESAMPLER_CHUNK_FRAMES: usize = 1_024;
const ADAPTIVE_MIN_ABSOLUTE_DB: f32 = -70.0;
const ADAPTIVE_AMBIENT_CEILING_DB: f32 = -64.0;
const ADAPTIVE_WARMUP_CHUNKS: usize = 2;
const ADAPTIVE_MARGIN_DB: f32 = 9.0;
const ADAPTIVE_FLOOR_ADMIT_DB: f32 = 3.0;
const ADAPTIVE_FLOOR_RISE_RATIO: f32 = 0.2;

#[derive(Debug, Error)]
pub enum AudioError {
    #[error("audio host is unavailable")]
    HostUnavailable,
    #[error("no input device is available")]
    NoInputDevice,
    #[error("input device not found: {0}")]
    DeviceNotFound(String),
    #[error("input device has no supported configuration: {0}")]
    UnsupportedConfiguration(String),
    #[error("input stream failed: {0}")]
    Stream(String),
    #[error("audio capture is already running")]
    AlreadyRunning,
    #[error("audio capture is not running")]
    NotRunning,
    #[error("invalid audio configuration: {0}")]
    InvalidConfiguration(String),
    #[error("resampling failed: {0}")]
    Resampling(String),
    #[error("audio callback channel closed")]
    CallbackChannelClosed,
    #[error("audio frame queue is full")]
    FrameQueueFull,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputDevice {
    /// cpal's host-qualified backend identifier, suitable for persistence.
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioFormat {
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: SampleFormat,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AudioCaptureConfig {
    pub chunk_ms: u32,
    pub silence_gate_db: f32,
    pub adaptive_noise_floor: bool,
}

impl Default for AudioCaptureConfig {
    fn default() -> Self {
        Self {
            chunk_ms: DEFAULT_CHUNK_MS,
            silence_gate_db: DEFAULT_SILENCE_GATE_DB,
            adaptive_noise_floor: true,
        }
    }
}

impl AudioCaptureConfig {
    fn validate(self) -> Result<Self, AudioError> {
        if !(1..=10_000).contains(&self.chunk_ms) {
            return Err(AudioError::InvalidConfiguration(
                "chunk duration must be between 1 and 10,000 ms".to_string(),
            ));
        }
        if !self.silence_gate_db.is_finite()
            || !(f32::from(-90_i8)..=f32::from(0_i8)).contains(&self.silence_gate_db)
        {
            return Err(AudioError::InvalidConfiguration(
                "silence gate must be finite and between -90 and 0 dBFS".to_string(),
            ));
        }
        Ok(self)
    }

    pub fn chunk_samples(self) -> usize {
        (u64::from(TARGET_SAMPLE_RATE) * u64::from(self.chunk_ms) / 1_000)
            .try_into()
            .unwrap_or(usize::MAX)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CaptureStats {
    pub input_sample_rate: u32,
    pub input_channels: u16,
    pub output_frames: usize,
    pub dropped_frames: usize,
    /// RMS of the most recently emitted (gate-passing) frame in dBFS.
    pub last_rms_dbfs: Option<f32>,
    /// RMS of the most recent input chunk, including silence-gated ones.
    pub last_input_rms_dbfs: Option<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureEvent {
    Frame,
    Error,
}

#[derive(Debug)]
enum CapturePayload {
    Frame(Vec<i16>),
    Level(f32),
    Error(AudioError),
}

#[derive(Debug)]
struct CaptureMessage {
    payload: CapturePayload,
    input_sample_rate: u32,
    input_channels: u16,
}

#[derive(Debug)]
struct CaptureThread {
    stop: Sender<()>,
    join: Option<thread::JoinHandle<()>>,
}

#[derive(Debug)]
pub struct AudioCapture {
    config: AudioCaptureConfig,
    selected_device_id: Option<String>,
    thread: Option<CaptureThread>,
    receiver: Option<Receiver<CaptureMessage>>,
    stats: CaptureStats,
}

impl AudioCapture {
    pub fn new(config: AudioCaptureConfig) -> Result<Self, AudioError> {
        Ok(Self {
            config: config.validate()?,
            selected_device_id: None,
            thread: None,
            receiver: None,
            stats: CaptureStats {
                input_sample_rate: 0,
                input_channels: 0,
                output_frames: 0,
                dropped_frames: 0,
                last_rms_dbfs: None,
                last_input_rms_dbfs: None,
            },
        })
    }

    pub fn config(&self) -> AudioCaptureConfig {
        self.config
    }

    pub fn is_running(&self) -> bool {
        self.thread.is_some()
    }

    pub fn selected_device_id(&self) -> Option<&str> {
        self.selected_device_id.as_deref()
    }

    pub fn stats(&self) -> CaptureStats {
        self.stats
    }

    /// Start capture from a persisted cpal device id. `None` selects the host default input.
    pub fn start(&mut self, device_id: Option<&str>) -> Result<(), AudioError> {
        if self.is_running() {
            return Err(AudioError::AlreadyRunning);
        }
        let host = cpal::default_host();
        if !cpal::Host::is_available() {
            return Err(AudioError::HostUnavailable);
        }
        let device = choose_input_device(&host, device_id)?;
        let actual_id = device.id().map_err(|error| AudioError::Stream(error.to_string()))?;
        let supported = device
            .default_input_config()
            .map_err(|error| AudioError::UnsupportedConfiguration(error.to_string()))?;
        let input_rate = supported.sample_rate();
        let channels = supported.channels();
        let sample_format = supported.sample_format();
        let stream_config = StreamConfig {
            channels,
            sample_rate: input_rate,
            buffer_size: cpal::BufferSize::Default,
        };
        let (message_tx, message_rx) = mpsc::sync_channel(MAX_PCM_QUEUE_FRAMES);
        let (stop_tx, stop_rx) = mpsc::channel();
        let config = self.config;
        let stream = build_input_stream(
            StreamBuildArgs {
                device: &device,
                stream_config,
                sample_format,
                input_rate,
                input_channels: channels,
                config,
                message_tx,
            },
            stop_rx,
        )?;
        stream.play().map_err(|error| AudioError::Stream(error.to_string()))?;
        let join = thread::spawn(move || {
            // Keeping the stream owned by a dedicated thread prevents it from being dropped
            // until the stop signal has arrived, while cpal invokes the callback on its own host
            // thread. This thread remains idle and only holds the stream lifetime.
            let _stream = stream;
            thread::park();
        });
        self.selected_device_id = Some(actual_id.to_string());
        self.stats.input_sample_rate = input_rate;
        self.stats.input_channels = channels;
        self.receiver = Some(message_rx);
        self.thread = Some(CaptureThread { stop: stop_tx, join: Some(join) });
        Ok(())
    }

    /// Apply one queued capture message and return a speech frame when present.
    fn apply_message(&mut self, message: CaptureMessage) -> Result<Option<Vec<i16>>, AudioError> {
        self.stats.input_sample_rate = message.input_sample_rate;
        self.stats.input_channels = message.input_channels;
        match message.payload {
            CapturePayload::Frame(frame) => {
                self.stats.output_frames = self.stats.output_frames.saturating_add(frame.len());
                let rms = rms_dbfs(&frame);
                self.stats.last_rms_dbfs = Some(rms);
                self.stats.last_input_rms_dbfs = Some(rms);
                Ok(Some(frame))
            }
            CapturePayload::Level(rms) => {
                self.stats.last_input_rms_dbfs = Some(rms);
                Ok(None)
            }
            CapturePayload::Error(error) => {
                if matches!(error, AudioError::FrameQueueFull) {
                    self.stats.dropped_frames = self.stats.dropped_frames.saturating_add(1);
                }
                Err(error)
            }
        }
    }

    /// Return the next complete configured-size PCM16 mono frame, if one has arrived.
    ///
    /// Level-only observations are applied to [`CaptureStats::last_input_rms_dbfs`]
    /// and skipped so a caller can drain speech frames without treating silence as EOF.
    pub fn try_next_frame(&mut self) -> Result<Option<Vec<i16>>, AudioError> {
        loop {
            let message = {
                let receiver = self.receiver.as_ref().ok_or(AudioError::NotRunning)?;
                match receiver.try_recv() {
                    Ok(message) => message,
                    Err(TryRecvError::Empty) => return Ok(None),
                    Err(TryRecvError::Disconnected) => {
                        return Err(AudioError::CallbackChannelClosed);
                    }
                }
            };
            if let Some(frame) = self.apply_message(message)? {
                return Ok(Some(frame));
            }
        }
    }

    /// Block until the next complete frame or stream error arrives.
    pub fn next_frame(&mut self) -> Result<Vec<i16>, AudioError> {
        loop {
            let message = {
                let receiver = self.receiver.as_ref().ok_or(AudioError::NotRunning)?;
                receiver.recv().map_err(|_| AudioError::CallbackChannelClosed)?
            };
            if let Some(frame) = self.apply_message(message)? {
                return Ok(frame);
            }
        }
    }

    pub fn stop(&mut self) -> Result<(), AudioError> {
        let Some(mut capture_thread) = self.thread.take() else {
            self.receiver = None;
            self.selected_device_id = None;
            return Ok(());
        };
        capture_thread.stop.send(()).map_err(|_| AudioError::CallbackChannelClosed)?;
        if let Some(join) = capture_thread.join.take() {
            join.thread().unpark();
            join.join().map_err(|_| AudioError::Stream("capture thread panicked".to_string()))?;
        }
        self.receiver = None;
        self.selected_device_id = None;
        Ok(())
    }
}

impl Drop for AudioCapture {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

/// True when the stream error text is a recoverable producer-side condition
/// (full queue, lagged consumer) rather than a disappeared device or denied mic.
pub fn is_recoverable_stream_error(error: &AudioError) -> bool {
    match error {
        AudioError::FrameQueueFull => true,
        AudioError::Stream(message) => {
            let lower = message.to_ascii_lowercase();
            lower.contains("would block")
                || lower.contains("tryagain")
                || lower.contains("try again")
                || lower.contains("temporarily")
                || lower.contains("resource temporarily unavailable")
        }
        _ => false,
    }
}

/// True when a cpal/host error should be presented as a microphone permission problem.
pub fn is_permission_denied_error(error: &AudioError) -> bool {
    match error {
        AudioError::Stream(message) | AudioError::UnsupportedConfiguration(message) => {
            let lower = message.to_ascii_lowercase();
            lower.contains("permission")
                || lower.contains("notauthorized")
                || lower.contains("not authorized")
                || lower.contains("denied")
                || lower.contains("tcc")
                || lower.contains("avauthorization")
                || lower.contains("errorkisdenied")
        }
        _ => false,
    }
}

fn choose_input_device(
    host: &cpal::Host,
    requested_id: Option<&str>,
) -> Result<Device, AudioError> {
    if let Some(requested_id) =
        requested_id.filter(|value| !value.is_empty() && *value != "default")
    {
        let device_id = requested_id
            .parse::<cpal::DeviceId>()
            .map_err(|error| AudioError::DeviceNotFound(error.to_string()))?;
        return host
            .device_by_id(&device_id)
            .ok_or_else(|| AudioError::DeviceNotFound(requested_id.to_string()));
    }
    host.default_input_device().ok_or(AudioError::NoInputDevice)
}

pub fn list_input_devices() -> Result<Vec<InputDevice>, AudioError> {
    let host = cpal::default_host();
    if !cpal::Host::is_available() {
        return Err(AudioError::HostUnavailable);
    }
    let default_id =
        host.default_input_device().and_then(|device| device.id().ok()).map(|id| id.to_string());
    let devices = host
        .input_devices()
        .map_err(|error| AudioError::Stream(error.to_string()))?
        .filter_map(|device| {
            let id = device.id().ok()?.to_string();
            let name = device.description().ok()?.name().to_string();
            Some(InputDevice { is_default: default_id.as_deref() == Some(id.as_str()), id, name })
        })
        .collect::<Vec<_>>();
    Ok(devices)
}

fn build_input_stream(
    args: StreamBuildArgs<'_>,
    stop_rx: Receiver<()>,
) -> Result<cpal::Stream, AudioError> {
    let StreamBuildArgs {
        device,
        stream_config,
        sample_format,
        input_rate,
        input_channels,
        config,
        message_tx,
    } = args;
    let (stream, callback_tx) = build_stream_for_format(StreamBuildArgs {
        device,
        stream_config,
        sample_format,
        input_rate,
        input_channels,
        config,
        message_tx,
    })?;
    thread::spawn(move || {
        let _ = stop_rx.recv();
        if let Ok(mut sender) = callback_tx.lock() {
            sender.take();
        }
    });
    Ok(stream)
}

#[derive(Debug)]
struct StreamBuildArgs<'a> {
    device: &'a Device,
    stream_config: StreamConfig,
    sample_format: SampleFormat,
    input_rate: u32,
    input_channels: u16,
    config: AudioCaptureConfig,
    message_tx: SyncSender<CaptureMessage>,
}

type SenderSlot = Arc<Mutex<Option<SyncSender<CaptureMessage>>>>;

fn build_stream_for_format(
    args: StreamBuildArgs<'_>,
) -> Result<(cpal::Stream, SenderSlot), AudioError> {
    let StreamBuildArgs {
        device,
        stream_config,
        sample_format,
        input_rate,
        input_channels,
        config,
        message_tx,
    } = args;
    let callback_tx = Arc::new(Mutex::new(Some(message_tx)));
    let stream_error_tx = Arc::clone(&callback_tx);
    let error_callback = move |error: cpal::Error| {
        if let Ok(mut sender) = stream_error_tx.lock() {
            if let Some(sender) = sender.take() {
                let _ = sender.send(CaptureMessage {
                    payload: CapturePayload::Error(AudioError::Stream(error.to_string())),
                    input_sample_rate: input_rate,
                    input_channels,
                });
            }
        }
    };
    let data_callback_tx = Arc::clone(&callback_tx);
    let mut chunker = PcmChunker::new(input_rate, input_channels, config)?;
    let stream = match sample_format {
        SampleFormat::I8 => device.build_input_stream::<i8, _, _>(
            stream_config,
            move |data, _| push_samples(data, &mut chunker, &data_callback_tx),
            error_callback,
            None,
        ),
        SampleFormat::I16 => device.build_input_stream::<i16, _, _>(
            stream_config,
            move |data, _| push_samples(data, &mut chunker, &data_callback_tx),
            error_callback,
            None,
        ),
        SampleFormat::I24 => device.build_input_stream::<cpal::I24, _, _>(
            stream_config,
            move |data, _| push_samples(data, &mut chunker, &data_callback_tx),
            error_callback,
            None,
        ),
        SampleFormat::I32 => device.build_input_stream::<i32, _, _>(
            stream_config,
            move |data, _| push_samples(data, &mut chunker, &data_callback_tx),
            error_callback,
            None,
        ),
        SampleFormat::I64 => device.build_input_stream::<i64, _, _>(
            stream_config,
            move |data, _| push_samples(data, &mut chunker, &data_callback_tx),
            error_callback,
            None,
        ),
        SampleFormat::U8 => device.build_input_stream::<u8, _, _>(
            stream_config,
            move |data, _| push_samples(data, &mut chunker, &data_callback_tx),
            error_callback,
            None,
        ),
        SampleFormat::U16 => device.build_input_stream::<u16, _, _>(
            stream_config,
            move |data, _| push_samples(data, &mut chunker, &data_callback_tx),
            error_callback,
            None,
        ),
        SampleFormat::U24 => device.build_input_stream::<cpal::U24, _, _>(
            stream_config,
            move |data, _| push_samples(data, &mut chunker, &data_callback_tx),
            error_callback,
            None,
        ),
        SampleFormat::U32 => device.build_input_stream::<u32, _, _>(
            stream_config,
            move |data, _| push_samples(data, &mut chunker, &data_callback_tx),
            error_callback,
            None,
        ),
        SampleFormat::U64 => device.build_input_stream::<u64, _, _>(
            stream_config,
            move |data, _| push_samples(data, &mut chunker, &data_callback_tx),
            error_callback,
            None,
        ),
        SampleFormat::F32 => device.build_input_stream::<f32, _, _>(
            stream_config,
            move |data, _| push_samples(data, &mut chunker, &data_callback_tx),
            error_callback,
            None,
        ),
        SampleFormat::F64 => device.build_input_stream::<f64, _, _>(
            stream_config,
            move |data, _| push_samples(data, &mut chunker, &data_callback_tx),
            error_callback,
            None,
        ),
        _ => return Err(AudioError::UnsupportedConfiguration(sample_format.to_string())),
    }
    .map_err(|error| AudioError::Stream(error.to_string()))?;
    Ok((stream, callback_tx))
}

trait ToFloatSample {
    fn to_float(self) -> f32;
}

macro_rules! signed_to_float {
    ($($type:ty),* $(,)?) => {$ (
        impl ToFloatSample for $type {
            fn to_float(self) -> f32 {
                self as f32 / <$type>::MAX as f32
            }
        }
    )* };
}

macro_rules! unsigned_to_float {
    ($($type:ty),* $(,)?) => {$ (
        impl ToFloatSample for $type {
            fn to_float(self) -> f32 {
                (self as f32 - <$type>::MAX as f32 / 2.0) / (<$type>::MAX as f32 / 2.0)
            }
        }
    )* };
}

signed_to_float!(i8, i16, i32, i64);
unsigned_to_float!(u8, u16, u32, u64);

impl ToFloatSample for cpal::I24 {
    fn to_float(self) -> f32 {
        self.inner() as f32 / 8_388_607.0
    }
}

impl ToFloatSample for cpal::U24 {
    fn to_float(self) -> f32 {
        (self.inner() as f32 - 8_388_608.0) / 8_388_608.0
    }
}

impl ToFloatSample for f32 {
    fn to_float(self) -> f32 {
        self
    }
}

impl ToFloatSample for f64 {
    fn to_float(self) -> f32 {
        self as f32
    }
}

fn send_capture_message(sender: &SyncSender<CaptureMessage>, message: CaptureMessage) {
    match sender.try_send(message) {
        Ok(()) | Err(mpsc::TrySendError::Disconnected(_)) => {}
        Err(mpsc::TrySendError::Full(full)) => {
            let _ = sender.try_send(CaptureMessage {
                payload: CapturePayload::Error(AudioError::FrameQueueFull),
                input_sample_rate: full.input_sample_rate,
                input_channels: full.input_channels,
            });
        }
    }
}

fn push_samples<T: ToFloatSample + Copy>(
    data: &[T],
    chunker: &mut PcmChunker,
    sender: &Arc<Mutex<Option<SyncSender<CaptureMessage>>>>,
) {
    if let Ok(sender) = sender.lock() {
        if let Some(sender) = sender.as_ref() {
            chunker.push(data, sender);
        }
    }
}

#[derive(Debug)]
struct PcmChunker {
    input_rate: u32,
    channels: u16,
    config: AudioCaptureConfig,
    input: Vec<f32>,
    floor: AdaptiveNoiseFloor,
}

impl PcmChunker {
    fn new(input_rate: u32, channels: u16, config: AudioCaptureConfig) -> Result<Self, AudioError> {
        if !(MIN_SUPPORTED_SAMPLE_RATE..=MAX_SUPPORTED_SAMPLE_RATE).contains(&input_rate) {
            return Err(AudioError::UnsupportedConfiguration(format!(
                "sample rate {input_rate} is outside 8–96 kHz"
            )));
        }
        if channels == 0 {
            return Err(AudioError::UnsupportedConfiguration(
                "device reports zero channels".to_string(),
            ));
        }
        Ok(Self {
            input_rate,
            channels,
            config,
            input: Vec::new(),
            floor: AdaptiveNoiseFloor::default(),
        })
    }

    fn push<T: ToFloatSample + Copy>(&mut self, data: &[T], sender: &SyncSender<CaptureMessage>) {
        self.input.extend(data.iter().map(|sample| sample.to_float()));
        let input_chunk = (u64::from(self.input_rate) * u64::from(self.config.chunk_ms) / 1_000)
            .try_into()
            .unwrap_or(usize::MAX);
        let target_chunk = self.config.chunk_samples();
        let required = input_chunk.saturating_mul(usize::from(self.channels));
        while self.input.len() >= required && required > 0 {
            let source = self.input.drain(..required).collect::<Vec<_>>();
            let pcm = match resample_f32_to_pcm16(&source, self.input_rate, self.channels) {
                Ok(pcm) => pcm,
                Err(error) => {
                    send_capture_message(
                        sender,
                        CaptureMessage {
                            payload: CapturePayload::Error(error),
                            input_sample_rate: self.input_rate,
                            input_channels: self.channels,
                        },
                    );
                    continue;
                }
            };
            let mut output = pcm;
            output.truncate(target_chunk.saturating_add(1));
            let chunk_db = rms_dbfs(&output);
            let pass = if self.config.adaptive_noise_floor {
                let pass = self.floor.passes(chunk_db);
                self.floor.observe(chunk_db, pass);
                pass
            } else {
                passes_silence_gate(chunk_db, self.config.silence_gate_db)
            };
            let payload =
                if pass { CapturePayload::Frame(output) } else { CapturePayload::Level(chunk_db) };
            send_capture_message(
                sender,
                CaptureMessage {
                    payload,
                    input_sample_rate: self.input_rate,
                    input_channels: self.channels,
                },
            );
        }
    }
}

fn interleaved_to_mono(samples: &[f32], channels: u16) -> Vec<f32> {
    if channels == 1 {
        return samples.to_vec();
    }
    samples
        .chunks_exact(usize::from(channels))
        .map(|frame| frame.iter().copied().sum::<f32>() / f32::from(channels))
        .collect()
}

/// Convert interleaved f32 frames to mono PCM16 at 16 kHz.
///
/// `rubato::Async` uses cubic interpolation here and keeps a small fixed input
/// block. It is intentionally reset per complete capture chunk, which gives a
/// deterministic frame count and avoids carrying stale state across a gated gap.
pub fn resample_f32_to_pcm16(
    interleaved_f32: &[f32],
    input_sample_rate: u32,
    input_channels: u16,
) -> Result<Vec<i16>, AudioError> {
    if interleaved_f32.is_empty() {
        return Ok(Vec::new());
    }
    if input_channels == 0 || !interleaved_f32.len().is_multiple_of(usize::from(input_channels)) {
        return Err(AudioError::InvalidConfiguration(
            "interleaved input length is not divisible by channel count".to_string(),
        ));
    }
    if !(MIN_SUPPORTED_SAMPLE_RATE..=MAX_SUPPORTED_SAMPLE_RATE).contains(&input_sample_rate) {
        return Err(AudioError::InvalidConfiguration(
            "input sample rate is outside the supported range".to_string(),
        ));
    }
    let mono = interleaved_to_mono(interleaved_f32, input_channels);
    if input_sample_rate == TARGET_SAMPLE_RATE {
        return Ok(mono_to_pcm16(&mono));
    }
    let input_frames = mono.len();
    let mut resampler = Async::<f32>::new_poly(
        f64::from(TARGET_SAMPLE_RATE) / f64::from(input_sample_rate),
        1.0,
        PolynomialDegree::Cubic,
        RESAMPLER_CHUNK_FRAMES,
        1,
        FixedAsync::Input,
    )
    .map_err(|error| AudioError::Resampling(error.to_string()))?;
    let input =
        rubato::audioadapter_buffers::owned::InterleavedOwned::new_from(mono, 1, input_frames)
            .map_err(|error| AudioError::Resampling(error.to_string()))?;
    let output = resampler
        .process_all(&input, input_frames, None)
        .map_err(|error| AudioError::Resampling(error.to_string()))?;
    Ok(mono_to_pcm16(&output.take_data()))
}

fn mono_to_pcm16(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|sample| {
            let sample = sample.clamp(-1.0, 1.0);
            if sample < 0.0 {
                (sample * 32_768.0).round() as i16
            } else {
                (sample * 32_767.0).round() as i16
            }
        })
        .collect()
}

/// Return RMS in dBFS. Digital silence is represented as negative infinity.
pub fn rms_dbfs(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return f32::NEG_INFINITY;
    }
    let sum = samples
        .iter()
        .map(|sample| {
            let normalized = f32::from(*sample) / 32_768.0;
            normalized * normalized
        })
        .sum::<f32>();
    let rms = (sum / samples.len() as f32).sqrt();
    if rms <= f32::EPSILON {
        f32::NEG_INFINITY
    } else {
        20.0 * rms.log10()
    }
}

pub fn passes_silence_gate(rms_db: f32, silence_gate_db: f32) -> bool {
    rms_db.is_finite() && rms_db >= silence_gate_db
}

#[derive(Debug, Clone, Copy, Default)]
pub struct AdaptiveNoiseFloor {
    floor_db: Option<f32>,
    fed_chunks: usize,
}

impl AdaptiveNoiseFloor {
    pub fn floor_db(&self) -> Option<f32> {
        self.floor_db
    }

    pub fn passes(&self, chunk_db: f32) -> bool {
        if !chunk_db.is_finite() || chunk_db <= ADAPTIVE_MIN_ABSOLUTE_DB {
            return false;
        }
        if self.fed_chunks < ADAPTIVE_WARMUP_CHUNKS || self.floor_db.is_none() {
            return true;
        }
        self.floor_db.map(|floor| chunk_db >= floor + ADAPTIVE_MARGIN_DB).unwrap_or(true)
    }

    pub fn observe(&mut self, chunk_db: f32, passed: bool) {
        if !chunk_db.is_finite()
            || chunk_db <= ADAPTIVE_MIN_ABSOLUTE_DB
            || chunk_db > ADAPTIVE_AMBIENT_CEILING_DB
        {
            self.fed_chunks = self.fed_chunks.saturating_add(1);
            return;
        }
        match self.floor_db {
            None => self.floor_db = Some(chunk_db),
            Some(floor) if self.fed_chunks < ADAPTIVE_WARMUP_CHUNKS => {
                self.floor_db = Some(floor.min(chunk_db));
            }
            Some(floor) if !passed && chunk_db < floor => self.floor_db = Some(chunk_db),
            Some(floor) if !passed && chunk_db < floor + ADAPTIVE_FLOOR_ADMIT_DB => {
                self.floor_db = Some(floor + (chunk_db - floor) * ADAPTIVE_FLOOR_RISE_RATIO);
            }
            _ => {}
        }
        self.fed_chunks = self.fed_chunks.saturating_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        is_permission_denied_error, is_recoverable_stream_error, passes_silence_gate,
        resample_f32_to_pcm16, rms_dbfs, AdaptiveNoiseFloor, AudioError, TARGET_SAMPLE_RATE,
    };
    use std::f32::consts::PI;

    #[test]
    fn silence_rms_is_very_low() {
        assert!(rms_dbfs(&[0; 1_024]).is_infinite());
    }

    #[test]
    fn full_scale_sine_is_near_minus_three_dbfs() {
        let samples = (0..16_000)
            .map(|index| {
                let phase = 2.0 * PI * 440.0 * index as f32 / 16_000.0;
                (phase.sin() * 32_767.0).round() as i16
            })
            .collect::<Vec<_>>();
        let db = rms_dbfs(&samples);
        assert!((-3.2..=-2.8).contains(&db), "{db} dBFS");
    }

    #[test]
    fn fixed_gate_drops_silence_and_keeps_speech_like_chunk() {
        assert!(!passes_silence_gate(f32::NEG_INFINITY, -50.0));
        assert!(passes_silence_gate(-20.0, -50.0));
    }

    #[test]
    fn resampler_converts_48khz_stereo_to_16khz_mono() {
        let frames = 4_800;
        let input = (0..frames)
            .flat_map(|index| {
                let value = (index as f32 / frames as f32) * 0.5;
                [value, value]
            })
            .collect::<Vec<_>>();
        let output = resample_f32_to_pcm16(&input, 48_000, 2).expect("resample should work");
        assert!((output.len() as isize - 1_600).abs() <= 1);
        assert!(output.iter().any(|sample| *sample != 0));
        assert_eq!(TARGET_SAMPLE_RATE, 16_000);
    }

    #[test]
    fn adaptive_floor_fails_open_when_speech_arrives_before_ambient() {
        let mut floor = AdaptiveNoiseFloor::default();
        assert!(floor.passes(-20.0));
        floor.observe(-20.0, true);
        assert!(floor.passes(-21.0));
        floor.observe(-21.0, true);
        assert_eq!(floor.floor_db(), None);
        assert!(floor.passes(-25.0));
    }

    #[test]
    fn adaptive_floor_does_not_raise_from_loud_speech_after_ambient() {
        let mut floor = AdaptiveNoiseFloor::default();
        floor.observe(-65.0, false);
        floor.observe(-66.0, false);
        assert!(floor.floor_db().is_some());
        let before = floor.floor_db();
        assert!(floor.passes(-20.0));
        floor.observe(-20.0, true);
        assert_eq!(floor.floor_db(), before);
        assert!(floor.passes(-20.0));
    }

    #[test]
    fn full_queue_and_would_block_are_recoverable_stream_errors() {
        assert!(is_recoverable_stream_error(&AudioError::FrameQueueFull));
        assert!(is_recoverable_stream_error(&AudioError::Stream(
            "Would block while writing audio".to_string()
        )));
        assert!(is_recoverable_stream_error(&AudioError::Stream(
            "resource temporarily unavailable".to_string()
        )));
        assert!(!is_recoverable_stream_error(&AudioError::CallbackChannelClosed));
        assert!(!is_recoverable_stream_error(&AudioError::DeviceNotFound(
            "CoreAudio:42".to_string()
        )));
        assert!(!is_recoverable_stream_error(&AudioError::NoInputDevice));
    }

    #[test]
    fn permission_denied_detects_tcc_and_authorization_wording() {
        assert!(is_permission_denied_error(&AudioError::Stream(
            "TCC denied microphone access".to_string()
        )));
        assert!(is_permission_denied_error(&AudioError::UnsupportedConfiguration(
            "AVAuthorizationStatusDenied".to_string()
        )));
        assert!(is_permission_denied_error(&AudioError::Stream(
            "not authorized to use the microphone".to_string()
        )));
        assert!(!is_permission_denied_error(&AudioError::Stream(
            "device disconnected".to_string()
        )));
        assert!(!is_permission_denied_error(&AudioError::FrameQueueFull));
        assert!(!is_permission_denied_error(&AudioError::NoInputDevice));
    }
}
