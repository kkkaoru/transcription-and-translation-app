use std::sync::mpsc::SyncSender;

use crate::{
    CaptionUpdateMode, EngineEvent, config::ParapperConfig, delivery::RecognizedTextOutput,
    recognition::RecognitionStreamOutput, recognition::control::events::RecognizedTextUpdateMode,
};

pub(crate) trait TurnOutputSink: Send {
    fn update_config(&mut self, _config: &ParapperConfig) {}
    fn requires_audio(&self) -> bool {
        true
    }
    fn emit(&mut self, output: RecognizedTextOutput);
    fn emit_segment_closed(&mut self, _segment_id: u64) {}
    fn emit_partial_window(&mut self, _output: RecognitionStreamOutput) {}
}

pub(crate) struct ChannelTurnOutputSink {
    sender: SyncSender<EngineEvent>,
}

impl ChannelTurnOutputSink {
    pub(crate) fn new(sender: SyncSender<EngineEvent>) -> Self {
        Self { sender }
    }
}

impl TurnOutputSink for ChannelTurnOutputSink {
    fn requires_audio(&self) -> bool {
        false
    }

    fn emit(&mut self, output: RecognizedTextOutput) {
        let speech_start_at = output.caption_latency.speech_start_at;
        let speech_to_first_partial_millis = output
            .caption_latency
            .first_partial_at
            .zip(speech_start_at)
            .map(|(caption_at, speech_at)| caption_at.saturating_sub(speech_at));
        let speech_to_final_millis = output
            .caption_latency
            .asr_final_at
            .zip(speech_start_at)
            .map(|(caption_at, speech_at)| caption_at.saturating_sub(speech_at));
        let event = EngineEvent::Caption {
            turn_id: output.meta.id.clone(),
            turn_session_id: output.meta.source.turn_session_id,
            logical_turn_id: output.meta.source.turn_id,
            text: output.text,
            azookey_input_text: output.azookey_input_text,
            is_final: output.meta.is_final,
            update_mode: match output.meta.update_mode {
                RecognizedTextUpdateMode::Append => CaptionUpdateMode::Append,
                RecognizedTextUpdateMode::Replace => CaptionUpdateMode::Replace,
            },
            elapsed_millis: output.elapsed_millis,
            speech_to_first_partial_millis,
            speech_to_final_millis,
        };
        let _ = self.sender.send(event);
    }

    fn emit_partial_window(&mut self, output: RecognitionStreamOutput) {
        let starts_turn = output.output.meta.source.previous_segment_id.is_none();
        let turn_session_id = output.output.meta.source.turn_session_id;
        let logical_turn_id = output.output.meta.source.turn_id;
        let text = output.source_text.unwrap_or(output.output.text);
        let event = EngineEvent::PartialWindow {
            turn_id: output.output.meta.id,
            turn_session_id,
            logical_turn_id,
            text,
            starts_turn,
        };
        let _ = self.sender.try_send(event);
    }
}

#[cfg(test)]
pub(crate) struct NoopTurnOutputSink;

#[cfg(test)]
impl TurnOutputSink for NoopTurnOutputSink {
    fn requires_audio(&self) -> bool {
        false
    }

    fn emit(&mut self, _output: RecognizedTextOutput) {}
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::{ChannelTurnOutputSink, TurnOutputSink};
    use crate::config::{AsrLanguage, AsrModel};
    use crate::delivery::{RecognizedTextMeta, RecognizedTextOutput};
    use crate::recognition::control::events::RecognitionSourceMeta;
    use crate::{EngineEvent, recognition::RecognitionStreamOutput};

    #[test]
    fn portable_caption_channel_does_not_request_discarded_pcm_copies() {
        let (sender, _receiver) = mpsc::sync_channel(1);
        let sink = ChannelTurnOutputSink::new(sender);

        assert!(!sink.requires_audio());
    }

    #[test]
    fn partial_window_channel_marks_only_the_root_segment_as_turn_start() {
        let (sender, receiver) = mpsc::sync_channel(2);
        let mut sink = ChannelTurnOutputSink::new(sender);
        for (sequence, previous_segment_id) in [(1, None), (2, Some(7))] {
            let source = RecognitionSourceMeta {
                turn_session_id: 1,
                turn_id: 2,
                turn_revision: 0,
                output_sequence: sequence,
                segment_id: 8,
                previous_segment_id,
            };
            let meta = RecognizedTextMeta::replace_turn_output(
                "partial-window".to_string(),
                source,
                false,
            );
            let output = RecognizedTextOutput::new(
                Vec::new(),
                "長時間発話".to_string(),
                AsrModel::ReazonSpeechK2V2,
                AsrLanguage::Japanese,
                None,
                meta,
                10,
            );
            sink.emit_partial_window(RecognitionStreamOutput {
                output,
                source_text: None,
                azookey_input_text: None,
            });
        }

        assert!(matches!(
            receiver.try_recv(),
            Ok(EngineEvent::PartialWindow { starts_turn: true, .. })
        ));
        assert!(matches!(
            receiver.try_recv(),
            Ok(EngineEvent::PartialWindow { starts_turn: false, .. })
        ));
    }

    #[test]
    fn caption_channel_preserves_the_canonical_azookey_reading() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut sink = ChannelTurnOutputSink::new(sender);
        let source = RecognitionSourceMeta {
            turn_session_id: 1,
            turn_id: 2,
            turn_revision: 3,
            output_sequence: 4,
            segment_id: 5,
            previous_segment_id: None,
        };
        let meta = RecognizedTextMeta::replace_turn_output("turn-2".to_string(), source, true);
        let mut output = RecognizedTextOutput::new(
            Vec::new(),
            "こんにちは聞超えますか".to_string(),
            AsrModel::ReazonSpeechK2V2,
            AsrLanguage::Japanese,
            None,
            meta,
            10,
        );
        output.azookey_input_text = Some("こんにちはきこえますか".to_string());
        output.caption_latency.speech_start_at = Some(1_000);
        output.caption_latency.first_partial_at = Some(1_120);
        output.caption_latency.asr_final_at = Some(1_480);

        sink.emit(output);

        assert!(matches!(
            receiver.try_recv(),
            Ok(EngineEvent::Caption {
                text,
                azookey_input_text: Some(reading),
                speech_to_first_partial_millis: Some(120),
                speech_to_final_millis: Some(480),
                ..
            }) if text == "こんにちは聞超えますか" && reading == "こんにちはきこえますか"
        ));
    }
}
