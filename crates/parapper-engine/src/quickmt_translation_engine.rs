use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};
use ct2rs::tokenizers::sentencepiece::Tokenizer;
use ct2rs::{ComputeType, Config, Device, TranslationOptions, Translator};

pub const QUICKMT_JA_EN_MODEL_DIR: &str = "quickmt-ja-en";

const QUICKMT_MAX_INPUT_TOKENS: usize = 256;
const QUICKMT_MAX_OUTPUT_TOKENS: usize = 256;
const QUICKMT_REQUIRED_FILES: &[&str] = &[
    "config.json",
    "model.bin",
    "source_vocabulary.json",
    "target_vocabulary.json",
    "src.spm.model",
    "tgt.spm.model",
];

pub(crate) struct QuickMtJaEnEngine {
    translator: Translator<Tokenizer>,
    options: TranslationOptions<String, String>,
}

impl QuickMtJaEnEngine {
    pub(crate) fn load(models_root: &Path) -> Result<Self> {
        let model_dir = quickmt_ja_en_model_dir(models_root);
        validate_quickmt_model_dir(&model_dir)?;
        let tokenizer =
            Tokenizer::from_file(model_dir.join("src.spm.model"), model_dir.join("tgt.spm.model"))
                .with_context(|| {
                    format!("could not load QuickMT tokenizers from {}", model_dir.display())
                })?;
        let translator = Translator::with_tokenizer(&model_dir, tokenizer, &quickmt_config())
            .with_context(|| {
                format!("could not load INT8 QuickMT translator from {}", model_dir.display())
            })?;
        Ok(Self { translator, options: quickmt_options() })
    }

    pub(crate) fn translate(&self, text: &str) -> Result<String> {
        let source = text.trim();
        if source.is_empty() {
            return Ok(String::new());
        }
        let mut results = self
            .translator
            .translate_batch(&[source], &self.options, None)
            .context("QuickMT Japanese-to-English inference failed")?;
        let (translation, _) = results
            .pop()
            .ok_or_else(|| anyhow!("QuickMT returned no Japanese-to-English translation"))?;
        Ok(translation.trim().to_string())
    }
}

pub fn quickmt_ja_en_model_installed(models_root: &Path) -> bool {
    let model_dir = quickmt_ja_en_model_dir(models_root);
    QUICKMT_REQUIRED_FILES.iter().all(|name| model_dir.join(name).is_file())
}

fn quickmt_ja_en_model_dir(models_root: &Path) -> PathBuf {
    models_root.join(QUICKMT_JA_EN_MODEL_DIR)
}

fn validate_quickmt_model_dir(model_dir: &Path) -> Result<()> {
    let missing =
        QUICKMT_REQUIRED_FILES.iter().find(|name| !model_dir.join(name).is_file()).copied();
    if let Some(name) = missing {
        anyhow::bail!("QuickMT model file is missing: {}", model_dir.join(name).display());
    }
    Ok(())
}

fn quickmt_config() -> Config {
    Config {
        device: Device::CPU,
        compute_type: ComputeType::INT8,
        device_indices: vec![0],
        tensor_parallel: false,
        num_threads_per_replica: 1,
        max_queued_batches: 1,
        cpu_core_offset: -1,
    }
}

fn quickmt_options() -> TranslationOptions<String, String> {
    TranslationOptions {
        max_input_length: QUICKMT_MAX_INPUT_TOKENS,
        max_decoding_length: QUICKMT_MAX_OUTPUT_TOKENS,
        max_batch_size: 1,
        ..TranslationOptions::default()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        QUICKMT_JA_EN_MODEL_DIR, quickmt_config, quickmt_ja_en_model_dir,
        quickmt_ja_en_model_installed, quickmt_options, validate_quickmt_model_dir,
    };
    use ct2rs::{ComputeType, Device};
    use std::path::Path;

    #[test]
    fn model_directory_selects_only_japanese_to_english_quickmt() {
        assert_eq!(
            quickmt_ja_en_model_dir(Path::new("models")),
            Path::new("models").join("quickmt-ja-en")
        );
        assert_eq!(QUICKMT_JA_EN_MODEL_DIR, "quickmt-ja-en");
    }

    #[test]
    fn runtime_uses_one_cpu_replica_with_int8_weights() {
        let config = quickmt_config();

        assert_eq!(config.device, Device::CPU);
        assert_eq!(config.compute_type, ComputeType::INT8);
        assert_eq!(config.device_indices, vec![0]);
        assert!(!config.tensor_parallel);
        assert_eq!(config.num_threads_per_replica, 1);
        assert_eq!(config.max_queued_batches, 1);
        assert_eq!(config.cpu_core_offset, -1);
    }

    #[test]
    fn translation_options_preserve_beam_quality_and_limit_batching() {
        let options = quickmt_options();

        assert_eq!(options.beam_size, 2);
        assert_eq!(options.max_input_length, 256);
        assert_eq!(options.max_decoding_length, 256);
        assert_eq!(options.max_batch_size, 1);
        assert_eq!(options.num_hypotheses, 1);
    }

    #[test]
    fn missing_model_is_reported_before_loading_native_runtime() {
        let models_root =
            std::env::temp_dir().join(format!("parapper-quickmt-missing-{}", std::process::id()));
        let model_dir = models_root.join("quickmt-ja-en");

        assert!(!quickmt_ja_en_model_installed(&models_root));
        let error = validate_quickmt_model_dir(&model_dir).unwrap_err().to_string();
        assert!(error.starts_with("QuickMT model file is missing: "));
        assert!(error.ends_with("config.json"));
    }
}
