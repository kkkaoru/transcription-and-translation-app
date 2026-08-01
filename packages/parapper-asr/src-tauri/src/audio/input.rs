use std::{
    path::Path,
    sync::mpsc::{Receiver, channel},
};

use anyhow::{Context, Result, anyhow};
use cpal::{Stream, traits::StreamTrait};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::{
    config::ParapperConfig,
    error_event::{ErrorSeverity, ParapperErrorType, emit_parapper_error},
    model::{noise_cancellation_model_dir, noise_cancellation_model_dir_from_root},
};

use super::{
    device::selected_input_device,
    noise_cancellation::{NoiseCancellationEngine, UlUnasNoiseCancellationEngine},
    resampler::{MonoFastFixedInResampler, validated_vad_interval_ms},
    stream::{InputChunk, build_input_stream, peak_level},
};

pub const ASR_SAMPLE_RATE: u32 = 16_000;
const INPUT_LEVEL_EMIT_CHUNKS: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioChunkEvent {
    pub source_sample_rate: u32,
    pub sample_rate: u32,
    pub frames: usize,
    pub level: f32,
    pub pre_gain_level: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputLevelEvent {
    pub pre_gain_level: f32,
    pub post_gain_level: f32,
}

pub struct RunningAudioInput {
    stream: Option<Stream>,
}

pub(crate) struct RunningAudioInputStartup {
    pub(crate) input: RunningAudioInput,
    pub(crate) receiver: Receiver<InputChunk>,
    pub(crate) source_sample_rate: u32,
}

impl RunningAudioInput {
    pub(crate) fn start(config: &ParapperConfig) -> Result<RunningAudioInputStartup> {
        let selection = selected_input_device(config)?;
        let source_sample_rate = selection.stream_config.sample_rate;
        // Intentionally unbounded: recognition quality depends on preserving the
        // exact audio stream, and the CPAL callback must not block or drop chunks.
        // The worker drains this queue before each VAD step.
        let (sender, receiver) = channel();
        let stream = build_input_stream(
            &selection.device,
            &selection.stream_config,
            selection.sample_format,
            sender,
        )?;
        stream.play().context("Failed to start input stream")?;

        Ok(RunningAudioInputStartup {
            input: Self { stream: Some(stream) },
            receiver,
            source_sample_rate,
        })
    }
}

impl Drop for RunningAudioInput {
    fn drop(&mut self) {
        drop(self.stream.take());
    }
}

pub(crate) struct AudioInputProcessor {
    handle: Option<AppHandle>,
    resampler: MonoFastFixedInResampler,
    resampled_chunks: Vec<Vec<f32>>,
    noise_cancellation: Option<Box<dyn NoiseCancellationEngine>>,
    input_level_emitter: InputLevelEmitter,
    source_sample_rate: u32,
}

impl AudioInputProcessor {
    pub(crate) fn initialize(
        handle: AppHandle,
        config: &ParapperConfig,
        source_sample_rate: u32,
    ) -> Result<Self> {
        Self::initialize_with_model_root(Some(handle), None, config, source_sample_rate)
    }

    #[cfg(test)]
    pub(crate) fn initialize_without_handle_at_model_root(
        config: &ParapperConfig,
        source_sample_rate: u32,
        model_root: &Path,
    ) -> Result<Self> {
        Self::initialize_with_model_root(None, Some(model_root), config, source_sample_rate)
    }

    fn initialize_with_model_root(
        handle: Option<AppHandle>,
        model_root: Option<&Path>,
        config: &ParapperConfig,
        source_sample_rate: u32,
    ) -> Result<Self> {
        let vad_interval_ms = validated_vad_interval_ms(config.segmentation.vad_interval_ms);
        let resampler = match MonoFastFixedInResampler::new(
            source_sample_rate,
            ASR_SAMPLE_RATE,
            vad_interval_ms,
        ) {
            Ok(resampler) => resampler,
            Err(err) => {
                emit_audio_input_error(
                    handle.as_ref(),
                    ParapperErrorType::Resampler,
                    ErrorSeverity::Fatal,
                    &err,
                );
                return Err(err);
            }
        };
        let noise_cancellation =
            match create_noise_cancellation_engine(handle.as_ref(), model_root, config) {
                Ok(noise_cancellation) => noise_cancellation,
                Err(err) => {
                    emit_audio_input_error(
                        handle.as_ref(),
                        ParapperErrorType::AudioInput,
                        ErrorSeverity::Fatal,
                        &err,
                    );
                    return Err(err);
                }
            };
        Ok(Self {
            handle,
            resampler,
            resampled_chunks: Vec::with_capacity(1),
            noise_cancellation,
            input_level_emitter: InputLevelEmitter::default(),
            source_sample_rate,
        })
    }

    pub(crate) fn process(
        &mut self,
        chunk: &InputChunk,
        config: &ParapperConfig,
        mut on_processed_chunk: impl FnMut(Vec<f32>),
    ) {
        let input_gain = input_volume_db_to_gain(config.input.volume_db);
        let Ok(()) = self.resampler.push_into(&chunk.samples, &mut self.resampled_chunks) else {
            emit_audio_input_error(
                self.handle.as_ref(),
                ParapperErrorType::Resampler,
                ErrorSeverity::Warning,
                &anyhow!("Failed to resample input audio"),
            );
            return;
        };
        let mut resampled_chunks = std::mem::take(&mut self.resampled_chunks);
        for mut samples in resampled_chunks.drain(..) {
            let pre_gain_level = peak_level(&samples);
            apply_input_gain(&mut samples, input_gain);
            if let Some(noise_cancellation) = self.noise_cancellation.as_deref_mut() {
                samples = match noise_cancellation.process(&samples) {
                    Ok(samples) => samples,
                    Err(err) => {
                        emit_audio_input_error(
                            self.handle.as_ref(),
                            ParapperErrorType::AudioInput,
                            ErrorSeverity::Warning,
                            &err,
                        );
                        continue;
                    }
                };
            }
            let post_gain_level = peak_level(&samples);
            let handle = self.handle.clone();
            self.input_level_emitter.push(pre_gain_level, post_gain_level, |event| {
                if let Some(handle) = handle.as_ref() {
                    let _ = handle.emit("parapper://input-level", event);
                }
            });
            let event = AudioChunkEvent {
                source_sample_rate: self.source_sample_rate,
                sample_rate: ASR_SAMPLE_RATE,
                frames: samples.len(),
                level: post_gain_level,
                pre_gain_level,
            };
            if let Some(handle) = self.handle.as_ref() {
                let _ = handle.emit("parapper://audio-chunk", event);
            }
            on_processed_chunk(samples);
        }
        self.resampled_chunks = resampled_chunks;
    }
}

fn create_noise_cancellation_engine(
    handle: Option<&AppHandle>,
    model_root: Option<&Path>,
    config: &ParapperConfig,
) -> Result<Option<Box<dyn NoiseCancellationEngine>>> {
    if !config.noise_cancellation.enabled {
        return Ok(None);
    }

    let model_dir = if let Some(root) = model_root {
        noise_cancellation_model_dir_from_root(root, config.noise_cancellation.model)
    } else {
        let handle = handle.ok_or_else(|| {
            anyhow!("an AppHandle is required to resolve the noise cancellation model directory")
        })?;
        noise_cancellation_model_dir(handle, config.noise_cancellation.model)?
    };
    create_noise_cancellation_engine_at(&model_dir, config)
}

fn create_noise_cancellation_engine_at(
    model_dir: &Path,
    config: &ParapperConfig,
) -> Result<Option<Box<dyn NoiseCancellationEngine>>> {
    if !config.noise_cancellation.enabled {
        return Ok(None);
    }

    Ok(Some(Box::new(UlUnasNoiseCancellationEngine::new(model_dir)?)))
}

fn emit_audio_input_error(
    handle: Option<&AppHandle>,
    error_type: ParapperErrorType,
    severity: ErrorSeverity,
    error: &anyhow::Error,
) {
    if let Some(handle) = handle {
        emit_parapper_error(handle, error_type, severity, Some(error.to_string()));
    }
}

fn input_volume_db_to_gain(volume_db: f32) -> f32 {
    let volume_db = if volume_db.is_finite() { volume_db.clamp(-30.0, 30.0) } else { 0.0 };
    10.0_f32.powf(volume_db / 20.0)
}

fn apply_input_gain(samples: &mut [f32], gain: f32) {
    let gain = if gain.is_finite() { gain } else { 1.0 };
    for sample in samples {
        *sample *= gain;
    }
}

#[derive(Default)]
struct InputLevelEmitter {
    chunks_since_emit: u32,
    pre_gain_peak_level: f32,
    post_gain_peak_level: f32,
}

impl InputLevelEmitter {
    fn push(
        &mut self,
        pre_gain_level: f32,
        post_gain_level: f32,
        mut emit: impl FnMut(InputLevelEvent),
    ) {
        self.chunks_since_emit += 1;
        if pre_gain_level.is_finite() {
            self.pre_gain_peak_level = self.pre_gain_peak_level.max(pre_gain_level);
        }
        if post_gain_level.is_finite() {
            self.post_gain_peak_level = self.post_gain_peak_level.max(post_gain_level);
        }

        if self.chunks_since_emit >= INPUT_LEVEL_EMIT_CHUNKS {
            emit(InputLevelEvent {
                pre_gain_level: self.pre_gain_peak_level,
                post_gain_level: self.post_gain_peak_level,
            });
            self.chunks_since_emit = 0;
            self.pre_gain_peak_level = 0.0;
            self.post_gain_peak_level = 0.0;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        ASR_SAMPLE_RATE, AudioInputProcessor, InputLevelEmitter, apply_input_gain,
        input_volume_db_to_gain,
    };
    use crate::audio::stream::peak_level;
    use crate::config::{NoiseCancellationModel, ParapperConfig};

    #[test]
    fn input_volume_db_to_gain_uses_decibel_scale() {
        assert!((input_volume_db_to_gain(0.0) - 1.0).abs() < f32::EPSILON);
        assert!((input_volume_db_to_gain(20.0) - 10.0).abs() < 0.0001);
        assert!((input_volume_db_to_gain(-20.0) - 0.1).abs() < 0.0001);
    }

    #[test]
    fn apply_input_gain_does_not_clip_audio_sample_range() {
        let mut samples = vec![-0.25, 0.25, 0.75];

        apply_input_gain(&mut samples, 2.0);

        assert_f32_slice_close(&samples, &[-0.5, 0.5, 1.5]);
    }

    #[test]
    fn input_level_peak_preserves_values_above_display_range() {
        let mut samples = vec![-0.5, 0.25, 0.75];

        apply_input_gain(&mut samples, 4.0);

        assert_f32_slice_close(&samples, &[-2.0, 1.0, 3.0]);
        assert!((peak_level(&samples) - 3.0).abs() < f32::EPSILON);
    }

    #[test]
    fn audio_input_processor_fails_when_noise_cancellation_model_is_missing() {
        let config = parapper_config! {
            noise_cancellation_enabled: true,
            noise_cancellation_model: NoiseCancellationModel::UlUnas,
            model_dir: Some(missing_model_dir("noise-cancellation-init-failure")),
            ..ParapperConfig::default()
        };

        let err = AudioInputProcessor::initialize_without_handle_at_model_root(
            &config,
            ASR_SAMPLE_RATE,
            std::path::Path::new(config.models.dir.as_deref().unwrap()),
        )
        .err()
        .expect("missing noise cancellation model should fail audio input startup");

        assert!(
            err.to_string().contains("Noise cancellation model not found"),
            "unexpected noise cancellation init error: {err}"
        );
    }

    #[test]
    fn input_level_emitter_emits_every_three_chunks_and_resets_peaks() {
        let mut events = Vec::new();
        let mut emitter = InputLevelEmitter::default();

        emitter.push(0.1, 0.2, |event| events.push(event));
        emitter.push(f32::NAN, f32::INFINITY, |event| events.push(event));
        assert!(events.is_empty(), "input level should not emit before three chunks");
        emitter.push(0.5, 0.6, |event| events.push(event));
        let first = events.pop().expect("third chunk should emit input level");
        assert_f32_close(first.pre_gain_level, 0.5);
        assert_f32_close(first.post_gain_level, 0.6);

        emitter.push(0.1, 0.1, |event| events.push(event));
        emitter.push(0.2, 0.2, |event| events.push(event));
        emitter.push(0.3, 0.3, |event| events.push(event));
        let second = events.pop().expect("sixth chunk should emit input level after reset");
        assert_f32_close(second.pre_gain_level, 0.3);
        assert_f32_close(second.post_gain_level, 0.3);
    }

    fn assert_f32_close(actual: f32, expected: f32) {
        assert!((actual - expected).abs() < f32::EPSILON, "actual={actual}, expected={expected}");
    }

    fn assert_f32_slice_close(actual: &[f32], expected: &[f32]) {
        assert_eq!(actual.len(), expected.len());
        for (index, (actual, expected)) in actual.iter().zip(expected.iter()).enumerate() {
            assert!(
                (*actual - *expected).abs() < f32::EPSILON,
                "index={index}, actual={actual}, expected={expected}"
            );
        }
    }

    fn missing_model_dir(test_name: &str) -> String {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after unix epoch")
            .as_nanos();
        std::env::temp_dir()
            .join(format!(
                "parapper-missing-audio-input-model-{test_name}-{}-{unique}",
                std::process::id()
            ))
            .to_string_lossy()
            .into_owned()
    }
}
