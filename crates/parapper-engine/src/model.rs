use std::path::{Path, PathBuf};

use crate::config::{AsrLanguage, AsrModel, ParapperConfig};

pub(crate) mod onnx_runtime {
    include!("onnx_runtime.rs");
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum NamoTurnDetectorModel {
    Japanese,
    English,
    Multilingual,
}

impl NamoTurnDetectorModel {
    pub(crate) fn for_asr_language(language: AsrLanguage) -> Self {
        match language {
            AsrLanguage::Japanese => Self::Japanese,
            AsrLanguage::English => Self::English,
            AsrLanguage::EuropeanMultilingual | AsrLanguage::Multilingual => Self::Multilingual,
        }
    }
}

pub(crate) fn asr_model_dir_for(root: &Path, config: &ParapperConfig, model: AsrModel) -> PathBuf {
    if model == config.asr.model
        && let Some(path) =
            config.models.dir.as_deref().map(str::trim).filter(|path| !path.is_empty())
    {
        return PathBuf::from(path);
    }
    root.join(asr_model_dir_name(model))
}

pub(crate) fn language_id_model_dir(root: &Path) -> PathBuf {
    root.join("speechbrain-lang-id-voxlingua107-ecapa-onnx")
}

pub(crate) fn namo_turn_detector_model_dir_from_root(
    root: &Path,
    model: NamoTurnDetectorModel,
) -> PathBuf {
    let directory = match model {
        NamoTurnDetectorModel::Japanese => "namo-turn-detector-v1-japanese",
        NamoTurnDetectorModel::English => "namo-turn-detector-v1-english",
        NamoTurnDetectorModel::Multilingual => "namo-turn-detector-v1-multilingual",
    };
    root.join(directory)
}

pub(crate) fn japanese_morph_dictionary_paths_from_root(root: &Path) -> Vec<PathBuf> {
    let directory = root.join("unidic-cwj-3_1_1");
    ["system.dic.zst", "system.dic"].into_iter().map(|name| directory.join(name)).collect()
}

pub(crate) fn asr_model_dir_name(model: AsrModel) -> &'static str {
    match model {
        AsrModel::ReazonSpeechK2V2 => "sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01",
        AsrModel::NemoParakeetTdtCtc0_6BJa35000Int8 => {
            "sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8"
        }
        AsrModel::NemoParakeetTdt0_6BV2Int8 => "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
        AsrModel::NemoParakeetTdt0_6BV3Int8 => "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
        AsrModel::NemotronSpeechStreamingEn0_6B160MsInt8 => {
            "sherpa-onnx-nemotron-speech-streaming-en-0.6b-160ms-int8-2026-04-25"
        }
        AsrModel::NemotronSpeechStreamingEn0_6B560MsInt8 => {
            "sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25"
        }
        AsrModel::Nemotron3_5AsrStreaming0_6B160MsInt8 => {
            "sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-160ms-int8-2026-06-11"
        }
        AsrModel::Nemotron3_5AsrStreaming0_6B560MsInt8 => {
            "sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11"
        }
    }
}
