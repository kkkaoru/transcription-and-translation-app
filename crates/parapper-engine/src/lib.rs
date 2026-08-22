//! Portable, in-process Parapper recognition engine.
//!
//! The engine owns Silero VAD, sherpa-onnx ASR, segmentation, and turn state.
//! It has no UI, Tauri, socket, or child-process dependency.

#![deny(unsafe_op_in_unsafe_fn)]

#[cfg(test)]
include!("test_config_macro.rs");

#[doc(hidden)]
pub mod config;
mod delivery;
mod model;
mod noise_cancellation;
mod recognition;

use std::{
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    time::Duration,
};

use anyhow::{Context, Result, bail};
use noise_cancellation::NoiseCancellationEngine;
use recognition::{
    control::{RecognitionDriver, RecognitionDriverHandle, RecognitionShutdownResult},
    segmentation::vad::engine::{OnnxRuntimeSileroVadEngine, VadEngine},
    turn::port::output_sink::ChannelTurnOutputSink,
};

use crate::config::{ParapperConfig, TurnDetector};

pub const SAMPLE_RATE: u32 = 16_000;
pub const VAD_FRAME_SAMPLES: usize = 512;
const EVENT_QUEUE_CAPACITY: usize = 64;
const ASR_STARTUP_TIMEOUT: Duration = Duration::from_secs(60);

pub(crate) mod audio {
    pub(crate) const ASR_SAMPLE_RATE: u32 = super::SAMPLE_RATE;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineConfig {
    pub models_root: PathBuf,
    pub asr_threads: i32,
    pub noise_cancellation_enabled: bool,
    pub partial_window_asr_enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptionUpdateMode {
    Append,
    Replace,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineEvent {
    Caption {
        turn_id: String,
        text: String,
        is_final: bool,
        update_mode: CaptionUpdateMode,
        elapsed_millis: u128,
    },
    PartialWindow {
        turn_id: String,
        text: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownResult {
    Completed,
    TimedOut,
}

pub struct ParapperEngine {
    config: ParapperConfig,
    noise_cancellation: Option<noise_cancellation::UlUnasNoiseCancellationEngine>,
    driver: RecognitionDriver,
    vad: OnnxRuntimeSileroVadEngine,
    events: Receiver<EngineEvent>,
    pending_audio: Vec<f32>,
}

impl EngineConfig {
    pub fn new(models_root: impl Into<PathBuf>) -> Self {
        Self {
            models_root: models_root.into(),
            asr_threads: 2,
            noise_cancellation_enabled: false,
            partial_window_asr_enabled: false,
        }
    }
}

impl ParapperEngine {
    pub fn load(engine_config: &EngineConfig) -> Result<Self> {
        validate_models_root(&engine_config.models_root)?;
        let mut config = ParapperConfig::default();
        config.turn.detector = TurnDetector::Namo;
        config.turn.interim_result_enabled = true;
        config.turn.rerecognize_full_on_complete = true;
        config.turn.check_silence_ms = 480;
        config.asr.normalize_input_audio = true;
        config.asr.num_threads = engine_config.asr_threads;
        config.noise_cancellation.enabled = engine_config.noise_cancellation_enabled;
        config.segmentation.vad_interval_ms = 32;
        config.segmentation.vad_threshold = 0.5;

        let noise_cancellation = if engine_config.noise_cancellation_enabled {
            let model_dir = engine_config.models_root.join("ul-unas");
            Some(
                noise_cancellation::UlUnasNoiseCancellationEngine::new(&model_dir).with_context(
                    || format!("could not load UL-UNAS from {}", model_dir.display()),
                )?,
            )
        } else {
            None
        };
        let vad_path = engine_config.models_root.join("silero_vad_v6").join("silero_vad.onnx");
        let vad = OnnxRuntimeSileroVadEngine::new(&vad_path, config.segmentation.vad_threshold)
            .with_context(|| format!("could not load Silero VAD from {}", vad_path.display()))?;
        let (event_sender, events) = mpsc::sync_channel(EVENT_QUEUE_CAPACITY);
        let (startup_sender, startup_receiver) = mpsc::channel();
        let output_sink = Box::new(ChannelTurnOutputSink::new(event_sender));
        let driver = RecognitionDriver::new_portable(
            &engine_config.models_root,
            &config,
            Some(startup_sender),
            engine_config.partial_window_asr_enabled,
            output_sink,
        );
        match startup_receiver.recv_timeout(ASR_STARTUP_TIMEOUT) {
            Ok(Ok(())) => {}
            Ok(Err(errors)) => bail!("ASR models could not be loaded: {}", errors.join("; ")),
            Err(RecvTimeoutError::Timeout) => bail!("ASR model loading timed out"),
            Err(RecvTimeoutError::Disconnected) => {
                bail!("ASR worker stopped before model loading completed")
            }
        }
        Ok(Self {
            config,
            noise_cancellation,
            driver,
            vad,
            events,
            pending_audio: Vec::with_capacity(VAD_FRAME_SAMPLES),
        })
    }

    pub fn set_vad_threshold(&mut self, threshold: f32) -> Result<()> {
        if !threshold.is_finite() || !(0.0..=1.0).contains(&threshold) {
            bail!("VAD threshold must be a finite value between 0 and 1");
        }
        self.config.segmentation.vad_threshold = threshold;
        self.vad.set_threshold(threshold);
        self.driver.update_config(&self.config);
        Ok(())
    }

    pub fn push_audio(&mut self, samples: &[f32]) -> Result<Vec<EngineEvent>> {
        if let Some(noise_cancellation) = self.noise_cancellation.as_mut() {
            let enhanced = noise_cancellation.process(samples)?;
            self.pending_audio.extend_from_slice(&enhanced);
        } else {
            self.pending_audio.extend_from_slice(samples);
        }
        while self.pending_audio.len() >= VAD_FRAME_SAMPLES {
            let remaining = self.pending_audio.split_off(VAD_FRAME_SAMPLES);
            let frame = std::mem::replace(&mut self.pending_audio, remaining);
            let vad_result = self.vad.process(&frame)?;
            self.driver.push_vad_frame(&frame, vad_result);
            self.driver.step();
        }
        self.driver.step();
        Ok(self.drain_events())
    }

    pub fn tick(&mut self) -> Vec<EngineEvent> {
        self.driver.step();
        self.drain_events()
    }

    pub fn shutdown(mut self) -> (ShutdownResult, Vec<EngineEvent>) {
        if !self.pending_audio.is_empty() {
            let mut frame = std::mem::take(&mut self.pending_audio);
            frame.resize(VAD_FRAME_SAMPLES, 0.0);
            if let Ok(vad_result) = self.vad.process(&frame) {
                self.driver.push_vad_frame(&frame, vad_result);
            }
        }
        let result = self.driver.shutdown();
        (result.into(), self.drain_events())
    }

    fn drain_events(&mut self) -> Vec<EngineEvent> {
        self.events.try_iter().collect()
    }
}

impl From<RecognitionShutdownResult> for ShutdownResult {
    fn from(value: RecognitionShutdownResult) -> Self {
        match value {
            RecognitionShutdownResult::Completed => Self::Completed,
            RecognitionShutdownResult::TimedOut => Self::TimedOut,
        }
    }
}

fn validate_models_root(root: &Path) -> Result<()> {
    if !root.is_absolute() {
        bail!("models root must be absolute: {}", root.display());
    }
    if !root.is_dir() {
        bail!("models root does not exist: {}", root.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{EngineConfig, validate_models_root};

    #[test]
    fn engine_config_uses_bounded_resource_defaults() {
        let config = EngineConfig::new("/tmp/models");
        assert_eq!(config.asr_threads, 2);
        assert!(!config.noise_cancellation_enabled);
        assert!(!config.partial_window_asr_enabled);
    }

    #[test]
    fn relative_models_root_is_rejected() {
        let error = validate_models_root(std::path::Path::new("models"))
            .expect_err("relative model root must fail");
        assert_eq!(error.to_string(), "models root must be absolute: models");
    }
}
