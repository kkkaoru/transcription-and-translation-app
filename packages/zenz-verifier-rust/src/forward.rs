use crate::gguf::{validate_content, GgufLoadError, ZenzGgufManifest};
use candle_core::quantized::gguf_file::Content;
use candle_core::quantized::QMatMul;
use candle_core::{DType, Device, Module, Result, Tensor, D};
use candle_nn::{Embedding, LayerNorm};
use std::fs::File;
use std::path::Path;

struct QuantizedLinear {
    weight: QMatMul,
    bias: Tensor,
}

impl QuantizedLinear {
    fn load(content: &Content, file: &mut File, name: &str, device: &Device) -> Result<Self> {
        let weight = content.tensor(file, &format!("{name}.weight"), device)?;
        let bias = content.tensor(file, &format!("{name}.bias"), device)?.dequantize(device)?;
        Ok(Self { weight: QMatMul::from_qtensor(weight)?, bias })
    }
}

impl Module for QuantizedLinear {
    fn forward(&self, input: &Tensor) -> Result<Tensor> {
        self.weight.forward(input)?.broadcast_add(&self.bias)
    }
}

struct TransformerBlock {
    attention_norm: LayerNorm,
    attention_qkv: QuantizedLinear,
    attention_output: QuantizedLinear,
    feed_forward_norm: LayerNorm,
    feed_forward_up: QuantizedLinear,
    feed_forward_down: QuantizedLinear,
    head_count: usize,
    head_dimension: usize,
}

impl TransformerBlock {
    fn load(
        content: &Content,
        file: &mut File,
        index: usize,
        manifest: &ZenzGgufManifest,
        device: &Device,
    ) -> Result<Self> {
        let prefix = format!("blk.{index}");
        Ok(Self {
            attention_norm: load_layer_norm(
                content,
                file,
                &format!("{prefix}.attn_norm"),
                manifest.layer_norm_epsilon,
                device,
            )?,
            attention_qkv: QuantizedLinear::load(
                content,
                file,
                &format!("{prefix}.attn_qkv"),
                device,
            )?,
            attention_output: QuantizedLinear::load(
                content,
                file,
                &format!("{prefix}.attn_output"),
                device,
            )?,
            feed_forward_norm: load_layer_norm(
                content,
                file,
                &format!("{prefix}.ffn_norm"),
                manifest.layer_norm_epsilon,
                device,
            )?,
            feed_forward_up: QuantizedLinear::load(
                content,
                file,
                &format!("{prefix}.ffn_up"),
                device,
            )?,
            feed_forward_down: QuantizedLinear::load(
                content,
                file,
                &format!("{prefix}.ffn_down"),
                device,
            )?,
            head_count: manifest.head_count,
            head_dimension: manifest.embedding_length / manifest.head_count,
        })
    }

    fn forward(&self, input: &Tensor, causal_mask: &Tensor) -> Result<Tensor> {
        let (batch_size, sequence_length, embedding_length) = input.dims3()?;
        let normalized = self.attention_norm.forward(input)?;
        let qkv = self.attention_qkv.forward(&normalized)?.chunk(3, D::Minus1)?;
        let reshape = |tensor: &Tensor| {
            tensor
                .reshape((batch_size, sequence_length, self.head_count, self.head_dimension))?
                .transpose(1, 2)
        };
        let query = reshape(&qkv[0])?;
        let key = reshape(&qkv[1])?;
        let value = reshape(&qkv[2])?;
        let attention =
            (query.matmul(&key.transpose(2, 3)?)? / (self.head_dimension as f64).sqrt())?;
        let attention = candle_nn::ops::softmax(&attention.broadcast_add(causal_mask)?, D::Minus1)?;
        let attended = attention.matmul(&value)?.transpose(1, 2)?.contiguous()?.reshape((
            batch_size,
            sequence_length,
            embedding_length,
        ))?;
        let hidden = (input + self.attention_output.forward(&attended)?)?;
        let feed_forward =
            self.feed_forward_up.forward(&self.feed_forward_norm.forward(&hidden)?)?;
        // Zenz was trained and the fork evaluates with the GPT-2 0.044715 tanh
        // approximation. Do not replace this with mathematically exact
        // `gelu_erf`: it silently changes token rankings.
        let feed_forward = feed_forward.gelu()?;
        hidden + self.feed_forward_down.forward(&feed_forward)?
    }
}

/// Candle forward model for the released Zenz GPT-2 GGUF family.
///
/// Dimensions are read from metadata, so both xsmall and small GGUF layouts can
/// be loaded. Product wiring must select `zenz-v3.2-small`; xsmall is retained
/// only as an architecture compatibility fixture because it regresses Japanese
/// proper-noun conversion.
pub struct ZenzForwardModel {
    manifest: ZenzGgufManifest,
    token_embedding: Embedding,
    position_embedding: Embedding,
    blocks: Vec<TransformerBlock>,
    output_norm: LayerNorm,
    output_projection: QMatMul,
    device: Device,
}

impl ZenzForwardModel {
    pub fn load(path: &Path, device: &Device) -> std::result::Result<Self, GgufLoadError> {
        let mut file = File::open(path)?;
        let content = Content::read(&mut file)?;
        let manifest = validate_content(path, &content)?;
        let token_embedding_tensor =
            content.tensor(&mut file, "token_embd.weight", device)?.dequantize(device)?;
        let position_embedding_tensor =
            content.tensor(&mut file, "position_embd.weight", device)?.dequantize(device)?;
        let token_embedding = Embedding::new(token_embedding_tensor, manifest.embedding_length);
        let position_embedding =
            Embedding::new(position_embedding_tensor, manifest.embedding_length);
        let mut blocks = Vec::with_capacity(manifest.block_count);
        for index in 0..manifest.block_count {
            blocks.push(TransformerBlock::load(&content, &mut file, index, &manifest, device)?);
        }
        let output_norm = load_layer_norm(
            &content,
            &mut file,
            "output_norm",
            manifest.layer_norm_epsilon,
            device,
        )?;
        // Keep the Q6_K output projection independent from the Q5_K token
        // embedding. GPT-2 loaders commonly tie these matrices, but this model
        // stores and trains separate tensors; tying gives plausible wrong logits.
        let output_projection =
            QMatMul::from_qtensor(content.tensor(&mut file, "output.weight", device)?)?;
        Ok(Self {
            manifest,
            token_embedding,
            position_embedding,
            blocks,
            output_norm,
            output_projection,
            device: device.clone(),
        })
    }

    pub fn manifest(&self) -> &ZenzGgufManifest {
        &self.manifest
    }

    /// Returns teacher-forced logits shaped `[sequence, vocabulary]`.
    pub fn forward(&self, token_ids: &[u32]) -> Result<Tensor> {
        if token_ids.is_empty() {
            candle_core::bail!("Zenz forward requires at least one token")
        }
        if token_ids.len() > self.manifest.context_length {
            candle_core::bail!(
                "Zenz token count {} exceeds context length {}",
                token_ids.len(),
                self.manifest.context_length
            )
        }
        let tokens = Tensor::new(token_ids, &self.device)?.unsqueeze(0)?;
        let positions = Tensor::arange(0u32, token_ids.len() as u32, &self.device)?.unsqueeze(0)?;
        let mut hidden = (self.token_embedding.forward(&tokens)?
            + self.position_embedding.forward(&positions)?)?;
        let causal_mask = causal_mask(token_ids.len(), &self.device)?;
        for block in &self.blocks {
            hidden = block.forward(&hidden, &causal_mask)?;
        }
        self.output_projection.forward(&self.output_norm.forward(&hidden)?)?.squeeze(0)
    }
}

fn load_layer_norm(
    content: &Content,
    file: &mut File,
    name: &str,
    epsilon: f64,
    device: &Device,
) -> Result<LayerNorm> {
    let weight = content.tensor(file, &format!("{name}.weight"), device)?.dequantize(device)?;
    let bias = content.tensor(file, &format!("{name}.bias"), device)?.dequantize(device)?;
    Ok(LayerNorm::new(weight, bias, epsilon))
}

fn causal_mask(sequence_length: usize, device: &Device) -> Result<Tensor> {
    let mut values = Vec::with_capacity(sequence_length * sequence_length);
    for row in 0..sequence_length {
        for column in 0..sequence_length {
            values.push(if column <= row { 0.0f32 } else { f32::NEG_INFINITY });
        }
    }
    Tensor::from_vec(values, (sequence_length, sequence_length), device)?
        .to_dtype(DType::F32)?
        .unsqueeze(0)?
        .unsqueeze(0)
}
