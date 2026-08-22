use std::{
    borrow::Cow,
    path::Path,
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
        mpsc::{Receiver, RecvTimeoutError, Sender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use crate::{
    config::ParapperConfig,
    recognition::{
        control::engine_cache::AsrEngineCache,
        segmentation::segment::builder::SegmentCloseReason,
        transcription::asr::{
            input::{
                PreparedAsrInput, maybe_shift_transcript_timestamps_for_leading_padding,
                normalize_asr_input_audio, prepare_asr_input_audio, prepare_nemotron_input_audio,
                prepare_nemotron_streaming_bootstrap_audio,
            },
            task::{AsrRequest, AsrResult, AsrResultStatus, AsrTaskKind},
        },
    },
};

const ASR_WORKER_JOIN_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) trait AsrRequestRunner {
    fn update_config(&mut self, _config: &ParapperConfig) {}
    fn reset_streaming_sessions(&mut self) {}
    fn submit(&mut self, request: AsrRequest) -> bool;
    fn try_recv_result(&mut self) -> Option<AsrResult>;
    fn shutdown(&mut self) {}
}

pub(crate) type AsrWorkerStartupResult = Result<(), Vec<String>>;
pub(crate) type AsrWorkerStartupSender = Sender<AsrWorkerStartupResult>;

#[cfg(test)]
pub(crate) struct NoopAsrRequestRunner;

#[cfg(test)]
impl AsrRequestRunner for NoopAsrRequestRunner {
    fn submit(&mut self, _request: AsrRequest) -> bool {
        true
    }

    fn try_recv_result(&mut self) -> Option<AsrResult> {
        None
    }
}

pub(crate) struct EngineAsrRequestRunner {
    request_sender: Option<Sender<AsrWorkerCommand>>,
    result_receiver: Receiver<AsrResult>,
    config: Arc<RwLock<ParapperConfig>>,
    stop_requested: Arc<AtomicBool>,
    join_handle: Option<JoinHandle<()>>,
}

enum AsrWorkerCommand {
    Request(Box<AsrRequest>),
    ResetStreamingSessions,
}

impl EngineAsrRequestRunner {
    pub(crate) fn new(
        models_root: &Path,
        config: &ParapperConfig,
        startup_sender: Option<AsrWorkerStartupSender>,
    ) -> Self {
        let (request_sender, request_receiver) = std::sync::mpsc::channel();
        let (result_sender, result_receiver) = std::sync::mpsc::channel();
        let config = Arc::new(RwLock::new(config.clone()));
        let stop_requested = Arc::new(AtomicBool::new(false));
        let worker_config = config.clone();
        let worker_stop = stop_requested.clone();
        let startup_sender_for_spawn_error = startup_sender.clone();
        let worker_models_root = models_root.to_path_buf();
        let join_handle = match thread::Builder::new()
            .name("parapper-next-asr-runner".to_string())
            .spawn(move || {
                run_engine_asr_request_worker(
                    &worker_models_root,
                    &worker_config,
                    &request_receiver,
                    &result_sender,
                    &worker_stop,
                    startup_sender,
                );
            }) {
            Ok(join_handle) => Some(join_handle),
            Err(err) => {
                let reason = format!("Failed to spawn ASR request worker: {err}");
                log::warn!("{reason}");
                if let Some(sender) = startup_sender_for_spawn_error {
                    let _ = sender.send(Err(vec![reason]));
                }
                None
            }
        };

        Self {
            request_sender: Some(request_sender),
            result_receiver,
            config,
            stop_requested,
            join_handle,
        }
    }
}

impl AsrRequestRunner for EngineAsrRequestRunner {
    fn update_config(&mut self, config: &ParapperConfig) {
        if let Ok(mut current) = self.config.write() {
            *current = config.clone();
        }
    }

    fn reset_streaming_sessions(&mut self) {
        let Some(sender) = self.request_sender.as_ref() else {
            log::warn!(
                "Failed to reset ASR streaming sessions because the request sender is closed"
            );
            return;
        };
        if let Err(err) = sender.send(AsrWorkerCommand::ResetStreamingSessions) {
            log::warn!(
                "Failed to submit ASR streaming session reset to next runtime runner: {err}"
            );
        }
    }

    fn submit(&mut self, request: AsrRequest) -> bool {
        let Some(sender) = self.request_sender.as_ref() else {
            log::warn!("Failed to submit ASR request because the request sender is closed");
            return false;
        };
        if let Err(err) = sender.send(AsrWorkerCommand::Request(Box::new(request))) {
            log::warn!("Failed to submit ASR request to next runtime runner: {err}");
            return false;
        }
        true
    }

    fn try_recv_result(&mut self) -> Option<AsrResult> {
        self.result_receiver.try_recv().ok()
    }

    fn shutdown(&mut self) {
        self.stop_requested.store(true, Ordering::Release);
        self.request_sender.take();
        if let Some(join_handle) = self.join_handle.take() {
            let started_at = Instant::now();
            while !join_handle.is_finished() && started_at.elapsed() < ASR_WORKER_JOIN_TIMEOUT {
                thread::sleep(Duration::from_millis(1));
            }
            if join_handle.is_finished() {
                if let Err(err) = join_handle.join() {
                    log::warn!("RecognitionSession ASR runner thread panicked: {err:?}");
                }
            } else {
                log::warn!(
                    "Timed out waiting for recognition ASR runner shutdown; detaching worker"
                );
            }
        }
    }
}

impl Drop for EngineAsrRequestRunner {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn run_engine_asr_request_worker(
    models_root: &Path,
    config: &Arc<RwLock<ParapperConfig>>,
    request_receiver: &Receiver<AsrWorkerCommand>,
    result_sender: &Sender<AsrResult>,
    stop_requested: &Arc<AtomicBool>,
    startup_sender: Option<AsrWorkerStartupSender>,
) {
    let startup_config =
        config.read().map_or_else(|_| ParapperConfig::default(), |config| config.clone());
    let mut asr = AsrEngineCache::default();
    let startup_errors = asr.preload_required(models_root, &startup_config);
    for reason in &startup_errors {
        log::warn!("{reason}");
    }
    if let Some(sender) = startup_sender {
        let _ = sender.send(if startup_errors.is_empty() { Ok(()) } else { Err(startup_errors) });
    }

    while !stop_requested.load(Ordering::Acquire) {
        let command = match request_receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(command) => command,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let AsrWorkerCommand::Request(request) = command else {
            asr.clear_streaming_sessions();
            continue;
        };
        let request = *request;
        let current_config =
            config.read().map_or_else(|_| startup_config.clone(), |config| config.clone());
        for reason in asr.preload_required(models_root, &current_config) {
            log::warn!("{reason}");
        }
        let result = run_engine_asr_request(&current_config, &mut asr, &request);
        if result_sender.send(result).is_err() {
            break;
        }
    }
}

pub(crate) fn run_engine_asr_request(
    config: &ParapperConfig,
    asr: &mut AsrEngineCache,
    request: &AsrRequest,
) -> AsrResult {
    let request_id = request.request_id;
    let kind = request.kind;
    let target = request.target.clone();
    let route = request.route;
    let completed_at_frame = request.created_at_frame;
    let started_at = Instant::now();
    let mut decode_millis = None;
    let status = if is_nemotron_streaming_interim_request(request) {
        let session = request.streaming_session_key();
        let existing_leading_padding = asr.streaming_leading_padding_samples(session);
        let prepared = if existing_leading_padding.is_some() {
            PreparedAsrInput {
                audio: Cow::Borrowed(request.audio.as_slice()),
                leading_padding_samples: 0,
            }
        } else {
            let bootstrap_audio = if request.source_audio.is_empty() {
                request.audio.as_slice()
            } else {
                request.source_audio.as_slice()
            };
            let bootstrap_vad_results = if request.source_vad_results.is_empty() {
                request.vad_results.as_slice()
            } else {
                request.source_vad_results.as_slice()
            };
            prepare_nemotron_streaming_bootstrap_audio(bootstrap_audio, bootstrap_vad_results)
        };
        let audio = normalize_asr_input_audio(config, prepared.audio.as_ref());
        match asr.transcribe_streaming_delta(
            route,
            session,
            audio.as_ref(),
            prepared.leading_padding_samples,
        ) {
            Ok((mut transcript, leading_padding_samples)) => {
                maybe_shift_transcript_timestamps_for_leading_padding(
                    &mut transcript,
                    leading_padding_samples,
                );
                AsrResultStatus::Ok(transcript)
            }
            Err(err) => {
                log::warn!("Streaming ASR failed: {err}");
                AsrResultStatus::Failed(err.to_string())
            }
        }
    } else {
        asr.clear_streaming_sessions();
        let prepared = if route.model.is_nemotron() {
            prepare_nemotron_input_audio(&request.audio, &request.vad_results)
        } else {
            prepare_asr_input_audio(&request.audio, &request.vad_results)
        };
        let audio = normalize_asr_input_audio(config, prepared.audio.as_ref());
        let decode_started_at = Instant::now();
        let transcribe_result = asr.transcribe(route, audio.as_ref());
        decode_millis = Some(decode_started_at.elapsed().as_millis());
        if kind == AsrTaskKind::PartialWindow {
            log::info!(
                "{}",
                serde_json::json!({
                    "event": "partial_window_asr_decode",
                    "input_duration_ms": u64::try_from(audio.len()).unwrap_or(u64::MAX).saturating_mul(1_000) / u64::from(crate::audio::ASR_SAMPLE_RATE),
                    "decode_ms": decode_millis,
                    "end_to_end_ms": started_at.elapsed().as_millis(),
                    "route": format!("{:?}", route),
                    "model": format!("{:?}", route.model),
                    "status": if transcribe_result.is_ok() { "ok" } else { "failed" },
                })
            );
        }
        match transcribe_result {
            Ok(mut transcript) => {
                maybe_shift_transcript_timestamps_for_leading_padding(
                    &mut transcript,
                    prepared.leading_padding_samples,
                );
                AsrResultStatus::Ok(transcript)
            }
            Err(err) => {
                log::warn!("ASR failed: {err}");
                AsrResultStatus::Failed(err.to_string())
            }
        }
    };

    AsrResult {
        request_id,
        kind,
        target,
        route,
        status,
        completed_at_frame,
        elapsed_millis: started_at.elapsed().as_millis(),
        decode_millis,
    }
}

fn is_nemotron_streaming_interim_request(request: &AsrRequest) -> bool {
    request.route.model.is_nemotron()
        && request.kind == AsrTaskKind::InterimDisplay
        && request.close_reason == Some(SegmentCloseReason::InterimChunkReached)
}
