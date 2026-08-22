use std::sync::mpsc::SyncSender;

use crate::{
    CaptionUpdateMode, EngineEvent, config::ParapperConfig, delivery::RecognizedTextOutput,
    recognition::RecognitionStreamOutput, recognition::control::events::RecognizedTextUpdateMode,
};

pub(crate) trait TurnOutputSink: Send {
    fn update_config(&mut self, _config: &ParapperConfig) {}
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
    fn emit(&mut self, output: RecognizedTextOutput) {
        let event = EngineEvent::Caption {
            turn_id: output.meta.id.clone(),
            text: output.text,
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
    fn emit(&mut self, _output: RecognizedTextOutput) {}
}
