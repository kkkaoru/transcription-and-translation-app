pub(crate) mod control;
pub(crate) mod segmentation;
pub(crate) mod transcription;
pub(crate) mod turn;

use crate::delivery::RecognizedTextOutput;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RecognitionStreamOutput {
    pub(crate) output: RecognizedTextOutput,
    pub(crate) source_text: Option<String>,
    pub(crate) azookey_input_text: Option<String>,
}
