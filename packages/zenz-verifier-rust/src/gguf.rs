//! Candle-gated GGUF loading for the embedded Zenz verifier.
//!
//! This module deliberately stops at validated, independently loaded input and
//! output projections. Forward evaluation is not implemented until its argmax
//! is proven equal to the forked `kotoba-zenz-server` reference.

use candle_core::quantized::gguf_file::{Content, Value, VersionedMagic};
use candle_core::quantized::QTensor;
use candle_core::Device;
use std::error::Error;
use std::fmt;
use std::fs::File;
use std::path::{Path, PathBuf};

pub const TOKEN_EMBEDDING_NAME: &str = "token_embd.weight";
pub const OUTPUT_PROJECTION_NAME: &str = "output.weight";
pub const EXPECTED_VOCAB_SIZE: usize = 6000;
pub const EXPECTED_MERGE_COUNT: usize = 5764;

#[derive(Debug, Clone, PartialEq)]
pub struct ZenzGgufManifest {
    pub path: PathBuf,
    pub architecture: String,
    pub tokenizer_model: String,
    pub tokenizer_pre: String,
    pub vocabulary_size: usize,
    pub merge_count: usize,
    pub block_count: usize,
    pub context_length: usize,
    pub embedding_length: usize,
    pub head_count: usize,
    pub feed_forward_length: usize,
    pub layer_norm_epsilon: f64,
    pub token_embedding_dtype: String,
    pub output_projection_dtype: String,
    pub token_embedding_shape: Vec<usize>,
    pub output_projection_shape: Vec<usize>,
}

/// The two matrices are loaded from their own GGUF tensor records.
///
/// They must never be tied: released Zenz GGUFs quantize `token_embd.weight`
/// and `output.weight` differently, so substituting one for the other produces
/// plausible but incorrect logits without an explicit runtime error.
pub struct UntiedEmbeddingWeights {
    pub token_embedding: QTensor,
    pub output_projection: QTensor,
}

pub fn inspect_gguf(path: &Path) -> Result<ZenzGgufManifest, GgufLoadError> {
    let mut file = File::open(path)?;
    let content = Content::read(&mut file)?;
    validate_content(path, &content)
}

pub fn load_untied_embedding_weights(
    path: &Path,
    device: &Device,
) -> Result<(ZenzGgufManifest, UntiedEmbeddingWeights), GgufLoadError> {
    let mut file = File::open(path)?;
    let content = Content::read(&mut file)?;
    let manifest = validate_content(path, &content)?;
    let token_info = content
        .tensor_infos
        .get(TOKEN_EMBEDDING_NAME)
        .ok_or_else(|| GgufLoadError::MissingTensor(TOKEN_EMBEDDING_NAME))?;
    let output_info = content
        .tensor_infos
        .get(OUTPUT_PROJECTION_NAME)
        .ok_or_else(|| GgufLoadError::MissingTensor(OUTPUT_PROJECTION_NAME))?;

    // Two independent reads are intentional. Do not replace the output tensor
    // with a clone/reference to the token embedding even when shapes match.
    let token_embedding = token_info.read(&mut file, content.tensor_data_offset, device)?;
    let output_projection = output_info.read(&mut file, content.tensor_data_offset, device)?;
    Ok((manifest, UntiedEmbeddingWeights { token_embedding, output_projection }))
}

pub(crate) fn validate_content(
    path: &Path,
    content: &Content,
) -> Result<ZenzGgufManifest, GgufLoadError> {
    if content.magic != VersionedMagic::GgufV3 {
        return Err(GgufLoadError::InvalidModel(format!(
            "expected GGUFv3, got {:?}",
            content.magic
        )));
    }
    let architecture = string_metadata(content, "general.architecture")?;
    if architecture != "gpt2" {
        return Err(GgufLoadError::InvalidModel(format!(
            "expected architecture gpt2, got {architecture:?}"
        )));
    }
    let tokenizer_model = string_metadata(content, "tokenizer.ggml.model")?;
    if tokenizer_model != "gpt2" {
        return Err(GgufLoadError::InvalidModel(format!(
            "expected tokenizer model gpt2, got {tokenizer_model:?}"
        )));
    }
    let tokenizer_pre = string_metadata(content, "tokenizer.ggml.pre")?;
    if tokenizer_pre != "gpt2-small-japanese-char" {
        return Err(GgufLoadError::InvalidModel(format!(
            "unexpected tokenizer preprocessor {tokenizer_pre:?}"
        )));
    }
    let vocabulary_size = array_metadata_len(content, "tokenizer.ggml.tokens")?;
    if vocabulary_size != EXPECTED_VOCAB_SIZE {
        return Err(GgufLoadError::InvalidModel(format!(
            "expected {EXPECTED_VOCAB_SIZE} vocabulary entries, got {vocabulary_size}"
        )));
    }
    let merge_count = array_metadata_len(content, "tokenizer.ggml.merges")?;
    if merge_count != EXPECTED_MERGE_COUNT {
        return Err(GgufLoadError::InvalidModel(format!(
            "expected {EXPECTED_MERGE_COUNT} BPE merges, got {merge_count}"
        )));
    }
    let block_count = usize_metadata(content, "gpt2.block_count")?;
    let context_length = usize_metadata(content, "gpt2.context_length")?;
    let embedding_length = usize_metadata(content, "gpt2.embedding_length")?;
    let head_count = usize_metadata(content, "gpt2.attention.head_count")?;
    let feed_forward_length = usize_metadata(content, "gpt2.feed_forward_length")?;
    let layer_norm_epsilon = f64_metadata(content, "gpt2.attention.layer_norm_epsilon")?;
    if block_count == 0
        || embedding_length == 0
        || head_count == 0
        || !embedding_length.is_multiple_of(head_count)
    {
        return Err(GgufLoadError::InvalidModel(format!(
            "invalid GPT-2 dimensions: blocks={block_count}, embedding={embedding_length}, heads={head_count}"
        )));
    }

    let token_info = content
        .tensor_infos
        .get(TOKEN_EMBEDDING_NAME)
        .ok_or(GgufLoadError::MissingTensor(TOKEN_EMBEDDING_NAME))?;
    let output_info = content
        .tensor_infos
        .get(OUTPUT_PROJECTION_NAME)
        .ok_or(GgufLoadError::MissingTensor(OUTPUT_PROJECTION_NAME))?;
    if token_info.offset == output_info.offset {
        return Err(GgufLoadError::InvalidModel(
            "input embedding and output projection share a GGUF offset".to_string(),
        ));
    }

    Ok(ZenzGgufManifest {
        path: path.to_path_buf(),
        architecture: architecture.to_string(),
        tokenizer_model: tokenizer_model.to_string(),
        tokenizer_pre: tokenizer_pre.to_string(),
        vocabulary_size,
        merge_count,
        block_count,
        context_length,
        embedding_length,
        head_count,
        feed_forward_length,
        layer_norm_epsilon,
        token_embedding_dtype: format!("{:?}", token_info.ggml_dtype),
        output_projection_dtype: format!("{:?}", output_info.ggml_dtype),
        token_embedding_shape: token_info.shape.dims().to_vec(),
        output_projection_shape: output_info.shape.dims().to_vec(),
    })
}

fn string_metadata<'a>(content: &'a Content, key: &str) -> Result<&'a str, GgufLoadError> {
    match content.metadata.get(key) {
        Some(Value::String(value)) => Ok(value),
        Some(value) => {
            Err(GgufLoadError::InvalidModel(format!("metadata {key:?} is not a string: {value:?}")))
        }
        None => Err(GgufLoadError::MissingMetadata(key.to_string())),
    }
}

fn usize_metadata(content: &Content, key: &str) -> Result<usize, GgufLoadError> {
    let value = match content.metadata.get(key) {
        Some(Value::U32(value)) => usize::try_from(*value).ok(),
        Some(Value::U64(value)) => usize::try_from(*value).ok(),
        Some(value) => {
            return Err(GgufLoadError::InvalidModel(format!(
                "metadata {key:?} is not an unsigned integer: {value:?}"
            )));
        }
        None => return Err(GgufLoadError::MissingMetadata(key.to_string())),
    };
    value.ok_or_else(|| GgufLoadError::InvalidModel(format!("metadata {key:?} exceeds usize")))
}

fn f64_metadata(content: &Content, key: &str) -> Result<f64, GgufLoadError> {
    match content.metadata.get(key) {
        Some(Value::F32(value)) => Ok(f64::from(*value)),
        Some(Value::F64(value)) => Ok(*value),
        Some(value) => Err(GgufLoadError::InvalidModel(format!(
            "metadata {key:?} is not floating point: {value:?}"
        ))),
        None => Err(GgufLoadError::MissingMetadata(key.to_string())),
    }
}

fn array_metadata_len(content: &Content, key: &str) -> Result<usize, GgufLoadError> {
    match content.metadata.get(key) {
        Some(Value::Array(values)) => Ok(values.len()),
        Some(value) => {
            Err(GgufLoadError::InvalidModel(format!("metadata {key:?} is not an array: {value:?}")))
        }
        None => Err(GgufLoadError::MissingMetadata(key.to_string())),
    }
}

#[derive(Debug)]
pub enum GgufLoadError {
    Io(std::io::Error),
    Candle(candle_core::Error),
    MissingMetadata(String),
    MissingTensor(&'static str),
    InvalidModel(String),
}

impl fmt::Display for GgufLoadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "GGUF I/O error: {error}"),
            Self::Candle(error) => write!(formatter, "GGUF parse/load error: {error}"),
            Self::MissingMetadata(key) => write!(formatter, "GGUF metadata is missing {key:?}"),
            Self::MissingTensor(name) => write!(formatter, "GGUF tensor is missing {name:?}"),
            Self::InvalidModel(message) => write!(formatter, "invalid Zenz GGUF: {message}"),
        }
    }
}

impl Error for GgufLoadError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Candle(error) => Some(error),
            Self::MissingMetadata(_) | Self::MissingTensor(_) | Self::InvalidModel(_) => None,
        }
    }
}

impl From<std::io::Error> for GgufLoadError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<candle_core::Error> for GgufLoadError {
    fn from(error: candle_core::Error) -> Self {
        Self::Candle(error)
    }
}
