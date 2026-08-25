use std::{borrow::Cow, collections::HashMap, path::Path};

use anyhow::{Context, Result, anyhow};
use ort::{
    memory::Allocator,
    session::{Session, SessionInputValue, SessionOutputs},
    value::{DynTensor, DynValue, Tensor, TensorElementType, ValueType},
};
use tokenizers::Tokenizer;

use crate::{
    config::{LocalTranslationModel, TranslationLanguage},
    model::onnx_runtime::init_onnx_runtime,
};

const TOKENIZER_FILE_NAME: &str = "tokenizer.json";
const MAX_LFM2_INPUT_TOKENS: usize = 512;
const MAX_CAT_TRANSLATE_INPUT_TOKENS: usize = 4_096;
const MAX_NEW_TOKENS: usize = 256;

pub(crate) struct LocalTranslationEngine {
    local_model: LocalTranslationModel,
    tokenizer: Tokenizer,
    session: Session,
    input_specs: Vec<OnnxInputSpec>,
}

#[derive(Clone)]
struct OnnxInputSpec {
    name: String,
    element_type: TensorElementType,
    shape: Vec<i64>,
}

struct DecoderState {
    past_values: HashMap<String, DynValue>,
    total_sequence_len: usize,
}

struct DecoderStep {
    next_token: u32,
    state: DecoderState,
}

impl LocalTranslationEngine {
    pub(crate) fn load(model_dir: &Path, local_model: LocalTranslationModel) -> Result<Self> {
        Self::load_with_intra_threads(model_dir, local_model, 4)
    }

    fn load_with_intra_threads(
        model_dir: &Path,
        local_model: LocalTranslationModel,
        intra_threads: usize,
    ) -> Result<Self> {
        init_onnx_runtime()?;
        let tokenizer_path = model_dir.join(TOKENIZER_FILE_NAME);
        let model_path = model_dir.join(local_model.onnx_file_name());
        let tokenizer = Tokenizer::from_file(&tokenizer_path)
            .map_err(|err| anyhow!("{err}"))
            .with_context(|| {
                format!("Failed to load local translation tokenizer: {}", tokenizer_path.display())
            })?;
        let session = Session::builder()
            .map_err(|err| anyhow!("Failed to create local translation session builder: {err}"))?
            .with_intra_threads(intra_threads)
            .map_err(|err| anyhow!("Failed to configure local translation session: {err}"))?
            // Decoder sequence lengths change on every token. Retaining ORT memory patterns for
            // those shapes raises steady-state RSS without changing translation output.
            .with_memory_pattern(false)
            .map_err(|err| anyhow!("Failed to disable translation memory patterns: {err}"))?
            .commit_from_file(&model_path)
            .map_err(|err| {
                anyhow!(
                    "Failed to load local translation ONNX model {}: {err}",
                    model_path.display()
                )
            })
            .with_context(|| {
                format!("Failed to load local translation ONNX model: {}", model_path.display())
            })?;
        let input_specs = session
            .inputs()
            .iter()
            .map(|input| {
                let ValueType::Tensor { ty, shape, .. } = input.dtype() else {
                    anyhow::bail!("Unsupported local translation input type: {}", input.name());
                };
                Ok(OnnxInputSpec {
                    name: input.name().to_string(),
                    element_type: *ty,
                    shape: shape.iter().copied().collect(),
                })
            })
            .collect::<Result<Vec<_>>>()?;

        if !input_specs.iter().any(|input| input.name == "input_ids")
            || !input_specs.iter().any(|input| input.name == "attention_mask")
        {
            anyhow::bail!("Local translation model is missing input_ids or attention_mask");
        }

        Ok(Self { local_model, tokenizer, session, input_specs })
    }

    pub(crate) fn translate(
        &mut self,
        source_lang: TranslationLanguage,
        target_lang: TranslationLanguage,
        text: &str,
    ) -> Result<String> {
        if source_lang == target_lang {
            return Ok(text.to_string());
        }

        let prompt = local_translation_prompt(self.local_model, source_lang, target_lang, text);
        let encoding = self
            .tokenizer
            .encode(prompt, false)
            .map_err(|err| anyhow!("{err}"))
            .context("Failed to tokenize local translation prompt")?;
        let prompt_token_ids = encoding.get_ids().to_vec();
        let max_input_tokens = local_translation_max_input_tokens(self.local_model);
        if prompt_token_ids.len() > max_input_tokens {
            anyhow::bail!(
                "Local translation prompt is too long: {} tokens > {}",
                prompt_token_ids.len(),
                max_input_tokens
            );
        }

        let mut generated_token_ids = Vec::new();
        let mut decoder_state = None;
        for _ in 0..MAX_NEW_TOKENS {
            let step = self.next_token(
                decoder_input_tokens(&prompt_token_ids, &generated_token_ids),
                decoder_state.as_ref(),
            )?;
            decoder_state = Some(step.state);
            if step.next_token == local_translation_eos_token_id(self.local_model) {
                break;
            }
            generated_token_ids.push(step.next_token);
        }

        let decoded = self
            .tokenizer
            .decode(&generated_token_ids, true)
            .map_err(|err| anyhow!("{err}"))
            .context("Failed to decode local translation output")?;
        Ok(trim_local_translation_output(self.local_model, &decoded))
    }

    fn next_token(
        &mut self,
        input_token_ids: &[u32],
        decoder_state: Option<&DecoderState>,
    ) -> Result<DecoderStep> {
        let total_sequence_len = decoder_total_sequence_len(input_token_ids.len(), decoder_state);
        let mut inputs: Vec<(Cow<'_, str>, SessionInputValue<'_>)> =
            Vec::with_capacity(self.input_specs.len());
        for spec in &self.input_specs {
            let value =
                build_input_value(spec, input_token_ids, total_sequence_len, decoder_state)?;
            inputs.push((Cow::Owned(spec.name.clone()), value));
        }

        let mut outputs = self.session.run(inputs)?;
        if outputs.len() == 0 {
            anyhow::bail!("Local translation model did not return logits");
        }
        let next_token = {
            let logits = outputs.get("logits").unwrap_or(&outputs[0]);
            let (shape, values) = logits
                .try_extract_tensor::<f32>()
                .context("Failed to extract local translation logits")?;
            greedy_next_token(shape, values)?
        };
        let state =
            decoder_state_from_outputs(&mut outputs, &self.input_specs, total_sequence_len)?;
        Ok(DecoderStep { next_token, state })
    }
}

fn build_input_value<'a>(
    spec: &OnnxInputSpec,
    input_token_ids: &[u32],
    total_sequence_len: usize,
    decoder_state: Option<&'a DecoderState>,
) -> Result<SessionInputValue<'a>> {
    match spec.name.as_str() {
        "input_ids" => {
            let ids =
                input_token_ids.iter().map(|token_id| i64::from(*token_id)).collect::<Vec<_>>();
            let input_len = i64::try_from(input_token_ids.len())
                .context("local translation input token count exceeds i64")?;
            Ok(Tensor::from_array((vec![1_i64, input_len], ids))?.into())
        }
        "attention_mask" => {
            let mask = vec![1_i64; total_sequence_len];
            let sequence_len = i64::try_from(total_sequence_len)
                .context("local translation sequence length exceeds i64")?;
            Ok(Tensor::from_array((vec![1_i64, sequence_len], mask))?.into())
        }
        name if name.starts_with("past_conv.") => {
            if let Some(state) = decoder_state {
                let value = state.past_values.get(name).ok_or_else(|| {
                    anyhow!("Local translation decoder cache is missing input {name}")
                })?;
                return Ok(value.into());
            }
            let shape = concrete_past_shape(&spec.shape, total_sequence_len, false)?;
            build_zero_tensor(spec.element_type, shape)
        }
        name if name.starts_with("past_key_values.") => {
            if let Some(state) = decoder_state {
                let value = state.past_values.get(name).ok_or_else(|| {
                    anyhow!("Local translation decoder cache is missing input {name}")
                })?;
                return Ok(value.into());
            }
            let shape = concrete_past_shape(&spec.shape, total_sequence_len, true)?;
            build_zero_tensor(spec.element_type, shape)
        }
        _ => anyhow::bail!("Unsupported local translation model input: {}", spec.name),
    }
}

fn decoder_input_tokens<'a>(
    prompt_token_ids: &'a [u32],
    generated_token_ids: &'a [u32],
) -> &'a [u32] {
    generated_token_ids.last().map_or(prompt_token_ids, std::slice::from_ref)
}

fn decoder_total_sequence_len(
    input_token_count: usize,
    decoder_state: Option<&DecoderState>,
) -> usize {
    decoder_state.map_or(input_token_count, |state| state.total_sequence_len + input_token_count)
}

fn decoder_state_from_outputs(
    outputs: &mut SessionOutputs<'_>,
    input_specs: &[OnnxInputSpec],
    total_sequence_len: usize,
) -> Result<DecoderState> {
    let mut past_values = HashMap::new();
    for spec in input_specs {
        let Some(output_name) = present_output_name_for_past_input(&spec.name) else {
            continue;
        };
        let value = outputs.remove(&output_name).ok_or_else(|| {
            anyhow!(
                "Local translation model did not return cache output {} for input {}; outputs: {}",
                output_name,
                spec.name,
                output_names(outputs)
            )
        })?;
        past_values.insert(spec.name.clone(), value);
    }

    if past_values.is_empty() {
        anyhow::bail!("Local translation model did not return any decoder cache outputs");
    }

    Ok(DecoderState { past_values, total_sequence_len })
}

fn present_output_name_for_past_input(input_name: &str) -> Option<String> {
    input_name.strip_prefix("past_conv.").map(|rest| format!("present_conv.{rest}")).or_else(|| {
        input_name.strip_prefix("past_key_values.").map(|rest| format!("present.{rest}"))
    })
}

fn output_names(outputs: &SessionOutputs<'_>) -> String {
    outputs.keys().collect::<Vec<_>>().join(", ")
}

fn concrete_past_shape(
    template: &[i64],
    seq_len: usize,
    empty_sequence_dim: bool,
) -> Result<Vec<i64>> {
    template
        .iter()
        .enumerate()
        .map(|(index, dim)| {
            if *dim > 0 {
                Ok(*dim)
            } else if index == 0 {
                Ok(1)
            } else if empty_sequence_dim && index == 2 {
                Ok(0)
            } else if !empty_sequence_dim && index == 2 {
                Ok(3)
            } else {
                i64::try_from(seq_len).context("local translation sequence length exceeds i64")
            }
        })
        .collect()
}

fn build_zero_tensor(
    element_type: TensorElementType,
    shape: Vec<i64>,
) -> Result<SessionInputValue<'static>> {
    match element_type {
        TensorElementType::Float16 | TensorElementType::Float32 => {
            Ok(DynTensor::new(&Allocator::default(), element_type, shape)?.into())
        }
        _ => anyhow::bail!("Unsupported local translation past tensor type: {element_type}"),
    }
}

fn local_translation_prompt(
    local_model: LocalTranslationModel,
    source_lang: TranslationLanguage,
    target_lang: TranslationLanguage,
    text: &str,
) -> String {
    match local_model {
        LocalTranslationModel::Lfm2Q4 => lfm2_translation_prompt(target_lang, text),
        LocalTranslationModel::CatTranslate0_8BQ4KQuant => {
            cat_translate_prompt(source_lang, target_lang, text)
        }
    }
}

fn local_translation_eos_token_id(local_model: LocalTranslationModel) -> u32 {
    match local_model {
        LocalTranslationModel::Lfm2Q4 => 7,
        LocalTranslationModel::CatTranslate0_8BQ4KQuant => 2,
    }
}

fn local_translation_max_input_tokens(local_model: LocalTranslationModel) -> usize {
    match local_model {
        LocalTranslationModel::Lfm2Q4 => MAX_LFM2_INPUT_TOKENS,
        LocalTranslationModel::CatTranslate0_8BQ4KQuant => MAX_CAT_TRANSLATE_INPUT_TOKENS,
    }
}

fn lfm2_translation_prompt(target_lang: TranslationLanguage, text: &str) -> String {
    let system_prompt = match target_lang {
        TranslationLanguage::Ja => "Translate to Japanese.",
        TranslationLanguage::En => "Translate to English.",
    };
    format!(
        "<|startoftext|><|im_start|>system\n{system_prompt}<|im_end|>\n<|im_start|>user\n{text}<|im_end|>\n<|im_start|>assistant\n"
    )
}

fn cat_translate_prompt(
    source_lang: TranslationLanguage,
    target_lang: TranslationLanguage,
    text: &str,
) -> String {
    let user_prompt = format!(
        "Translate the following {} text into {}.\n\n{}",
        translation_language_name(source_lang),
        translation_language_name(target_lang),
        text
    );
    format!("<|user|>{user_prompt}</s><|assistant|>")
}

fn translation_language_name(language: TranslationLanguage) -> &'static str {
    match language {
        TranslationLanguage::Ja => "Japanese",
        TranslationLanguage::En => "English",
    }
}

fn trim_local_translation_output(local_model: LocalTranslationModel, text: &str) -> String {
    match local_model {
        LocalTranslationModel::Lfm2Q4 => trim_lfm2_translation_output(text),
        LocalTranslationModel::CatTranslate0_8BQ4KQuant => trim_cat_translate_output(text),
    }
}

fn trim_lfm2_translation_output(text: &str) -> String {
    text.split("<|im_end|>")
        .next()
        .unwrap_or(text)
        .trim()
        .trim_start_matches("- ")
        .trim_start_matches("• ")
        .trim()
        .to_string()
}

fn trim_cat_translate_output(text: &str) -> String {
    text.split("</s>")
        .next()
        .unwrap_or(text)
        .trim()
        .trim_start_matches("<|assistant|>")
        .trim()
        .to_string()
}

fn greedy_next_token(shape: &[i64], values: &[f32]) -> Result<u32> {
    let [_, sequence_len, vocab_size] = shape else {
        anyhow::bail!("Unexpected local translation logits shape: {shape:?}");
    };
    let sequence_len = usize::try_from(*sequence_len)
        .ok()
        .filter(|len| *len > 0)
        .ok_or_else(|| anyhow!("Unexpected local translation sequence length: {sequence_len}"))?;
    let vocab_size = usize::try_from(*vocab_size)
        .ok()
        .filter(|len| *len > 0)
        .ok_or_else(|| anyhow!("Unexpected local translation vocab size: {vocab_size}"))?;
    let start = (sequence_len - 1) * vocab_size;
    let logits = values
        .get(start..start + vocab_size)
        .ok_or_else(|| anyhow!("Local translation logits buffer is shorter than its shape"))?;
    let (token_id, _) = logits
        .iter()
        .enumerate()
        .max_by(|(_, left), (_, right)| {
            left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal)
        })
        .ok_or_else(|| anyhow!("Local translation logits were empty"))?;
    u32::try_from(token_id).context("local translation vocabulary index exceeds u32")
}

#[cfg(test)]
mod tests {
    use super::trim_lfm2_translation_output;

    #[test]
    fn lfm2_output_removes_chat_token_and_list_prefix() {
        assert_eq!(trim_lfm2_translation_output("- Hello.<|im_end|>ignored"), "Hello.");
        assert_eq!(trim_lfm2_translation_output("• Hello."), "Hello.");
    }
}
