use std::sync::mpsc::SyncSender;

use crate::{
    config::ParapperConfig, delivery::RecognizedTextOutput,
    recognition::control::events::RecognizedTextUpdateMode, recognition::RecognitionStreamOutput,
    CaptionUpdateMode, EngineEvent,
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
        let event = EngineEvent::Caption {
            turn_id: output.meta.id.clone(),
            text: output.text,
            azookey_input_text: output.azookey_input_text,
            is_final: output.meta.is_final,
            update_mode: match output.meta.update_mode {
                RecognizedTextUpdateMode::Append => CaptionUpdateMode::Append,
                RecognizedTextUpdateMode::Replace => CaptionUpdateMode::Replace,
            },
            elapsed_millis: output.elapsed_millis,
        };
        let _ = self.sender.send(event);
    }

    fn emit_partial_window(&mut self, output: RecognitionStreamOutput) {
        let text = output.source_text.unwrap_or(output.output.text);
        let event = EngineEvent::PartialWindow { turn_id: output.output.meta.id, text };
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
    use crate::EngineEvent;

    #[test]
    fn portable_caption_channel_does_not_request_discarded_pcm_copies() {
        let (sender, _receiver) = mpsc::sync_channel(1);
        let sink = ChannelTurnOutputSink::new(sender);

        assert!(!sink.requires_audio());
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

        sink.emit(output);

        assert!(matches!(
            receiver.try_recv(),
            Ok(EngineEvent::Caption {
                text,
                azookey_input_text: Some(reading),
                ..
            }) if text == "こんにちは聞超えますか" && reading == "こんにちはきこえますか"
        ));
    }
}
