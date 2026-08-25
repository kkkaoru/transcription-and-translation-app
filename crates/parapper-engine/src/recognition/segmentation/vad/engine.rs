use std::path::Path;

use anyhow::{Result, anyhow};
use ort::{
    inputs,
    session::Session,
    value::{Tensor, TensorRef},
};

use crate::{audio::ASR_SAMPLE_RATE, model::onnx_runtime::init_onnx_runtime};

const SILERO_CHUNK_SAMPLES: usize = 512;
const SILERO_CONTEXT_SAMPLES: usize = 64;
const SILERO_INPUT_SAMPLES: usize = SILERO_CONTEXT_SAMPLES + SILERO_CHUNK_SAMPLES;
const SILERO_STATE_LEN: usize = 2 * 128;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VadResult {
    pub probability: f32,
    pub is_speech: bool,
}

pub trait VadEngine: Send {
    fn process(&mut self, samples: &[f32]) -> Result<VadResult>;
    fn set_threshold(&mut self, _threshold: f32) {}
}

pub struct OnnxRuntimeSileroVadEngine {
    session: Session,
    sample_rate: Tensor<i64>,
    state: [f32; SILERO_STATE_LEN],
    context: [f32; SILERO_CONTEXT_SAMPLES],
    input_samples: [f32; SILERO_INPUT_SAMPLES],
    threshold: f32,
}

impl OnnxRuntimeSileroVadEngine {
    pub fn new(model_path: &Path, threshold: f32) -> Result<Self> {
        init_onnx_runtime()?;

        if !model_path.is_file() {
            return Err(anyhow!("VAD model not found: {}", model_path.display()));
        }

        let session = Session::builder()
            .map_err(|err| anyhow!("Failed to create VAD session builder: {err}"))?
            .with_intra_threads(1)
            .map_err(|err| anyhow!("Failed to configure VAD session: {err}"))?
            .commit_from_file(model_path)
            .map_err(|err| anyhow!("Failed to load VAD model {}: {err}", model_path.display()))?;

        let sample_rate = Tensor::from_array(((), vec![i64::from(ASR_SAMPLE_RATE)]))?;
        Ok(Self {
            session,
            sample_rate,
            state: [0.0; SILERO_STATE_LEN],
            context: [0.0; SILERO_CONTEXT_SAMPLES],
            input_samples: [0.0; SILERO_INPUT_SAMPLES],
            threshold,
        })
    }
}

impl VadEngine for OnnxRuntimeSileroVadEngine {
    fn process(&mut self, samples: &[f32]) -> Result<VadResult> {
        if samples.is_empty() {
            return Ok(VadResult { probability: 0.0, is_speech: false });
        }

        // Silero's ONNX graph accepts one 512-sample (32 ms) window. A
        // configured Parapper VAD interval may be larger than that window,
        // so run each model window in sequence and expose one aggregate result
        // to the segment builder. Using the maximum probability preserves a
        // short speech burst inside a larger configured interval instead of
        // silently discarding all samples after the first 32 ms.
        let mut probability: f32 = 0.0;
        let mut is_speech = false;
        for chunk in samples.chunks(SILERO_CHUNK_SAMPLES) {
            let chunk_probability = self.process_model_chunk(chunk)?;
            probability = probability.max(chunk_probability);
            is_speech |= chunk_probability > self.threshold;
        }

        Ok(VadResult { probability, is_speech })
    }

    fn set_threshold(&mut self, threshold: f32) {
        self.threshold = threshold;
    }
}

impl OnnxRuntimeSileroVadEngine {
    fn process_model_chunk(&mut self, samples: &[f32]) -> Result<f32> {
        let copy_len = prepare_model_input(&self.context, samples, &mut self.input_samples);
        let input = TensorRef::from_array_view((
            [1_usize, SILERO_INPUT_SAMPLES],
            self.input_samples.as_slice(),
        ))?;
        let state = TensorRef::from_array_view(([2_usize, 1, 128], self.state.as_slice()))?;

        let outputs = self.session.run(inputs![
            "input" => input,
            "sr" => &self.sample_rate,
            "state" => state,
        ])?;

        let (_, out) = outputs[0].try_extract_tensor::<f32>()?;
        let (_, state_out) = outputs[1].try_extract_tensor::<f32>()?;

        if state_out.len() == self.state.len() {
            self.state.copy_from_slice(state_out);
        }
        // For a 16 ms configured interval the model window is zero-padded to
        // 512 samples. Keep the context sourced from the real audio tail
        // rather than carrying padded silence into the next model invocation.
        self.context.fill(0.0);
        let context_start = copy_len.saturating_sub(SILERO_CONTEXT_SAMPLES);
        let context_len = copy_len - context_start;
        self.context[SILERO_CONTEXT_SAMPLES - context_len..].copy_from_slice(
            &self.input_samples
                [SILERO_CONTEXT_SAMPLES + context_start..SILERO_CONTEXT_SAMPLES + copy_len],
        );

        Ok(out.first().copied().unwrap_or(0.0))
    }
}

fn prepare_model_input(
    context: &[f32; SILERO_CONTEXT_SAMPLES],
    samples: &[f32],
    input_samples: &mut [f32; SILERO_INPUT_SAMPLES],
) -> usize {
    input_samples[..SILERO_CONTEXT_SAMPLES].copy_from_slice(context);
    input_samples[SILERO_CONTEXT_SAMPLES..].fill(0.0);
    let copy_len = samples.len().min(SILERO_CHUNK_SAMPLES);
    input_samples[SILERO_CONTEXT_SAMPLES..SILERO_CONTEXT_SAMPLES + copy_len]
        .copy_from_slice(&samples[..copy_len]);
    copy_len
}

#[cfg(test)]
mod tests {
    use std::{
        sync::mpsc,
        thread,
        time::{Duration, Instant},
    };

    use crate::model::onnx_runtime::init_onnx_runtime;

    use super::{SILERO_CONTEXT_SAMPLES, SILERO_INPUT_SAMPLES, prepare_model_input};

    #[test]
    fn model_input_reuses_fixed_storage_and_zero_pads_short_chunks() {
        let context = [0.25; SILERO_CONTEXT_SAMPLES];
        let samples = [0.5; 128];
        let mut input = [1.0; SILERO_INPUT_SAMPLES];

        let copied = prepare_model_input(&context, &samples, &mut input);

        assert_eq!(copied, 128);
        assert_eq!(&input[..SILERO_CONTEXT_SAMPLES], &[0.25; SILERO_CONTEXT_SAMPLES]);
        assert_eq!(&input[SILERO_CONTEXT_SAMPLES..SILERO_CONTEXT_SAMPLES + 128], &[0.5; 128]);
        assert!(input[SILERO_CONTEXT_SAMPLES + 128..].iter().all(|sample| *sample == 0.0));
    }

    #[test]
    fn onnx_runtime_initializes_without_hanging() {
        let (sender, receiver) = mpsc::channel();
        let started_at = Instant::now();
        thread::spawn(move || {
            let _ = sender.send(init_onnx_runtime());
        });

        match receiver.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => {}
            Ok(Err(err)) => panic!("ONNX Runtime initialization failed: {err:#}"),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                panic!(
                    "ONNX Runtime initialization did not finish within {:?}",
                    started_at.elapsed()
                );
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                panic!("ONNX Runtime initialization thread stopped without returning a result");
            }
        }
    }
}
