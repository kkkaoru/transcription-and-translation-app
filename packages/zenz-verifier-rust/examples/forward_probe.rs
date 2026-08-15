#[cfg(feature = "candle")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use candle_core::{Device, IndexOp};
    use caption_bridge_zenz_verifier::{CandidatePrompt, ZenzForwardModel, ZenzPromptTokenizer};
    use std::path::Path;

    let model_path =
        std::env::args().nth(1).ok_or("usage: forward_probe <model.gguf> <tokenizer-dir>")?;
    let tokens = [490u32, 304, 253, 801, 704, 246, 255, 3];
    let model = ZenzForwardModel::load(Path::new(&model_path), &Device::Cpu)?;
    let logits = model.forward(&tokens)?;
    let mut top_tokens = Vec::with_capacity(tokens.len());
    for position in 0..tokens.len() {
        let row = logits.i(position)?.to_vec1::<f32>()?;
        let (token, _) = row
            .iter()
            .copied()
            .enumerate()
            .max_by(|left, right| left.1.total_cmp(&right.1))
            .ok_or("empty logits")?;
        top_tokens.push(token);
    }
    println!("config={:?}", model.manifest());
    println!("tokens={tokens:?}");
    println!("top1={top_tokens:?}");

    let tokenizer_dir =
        std::env::args().nth(2).ok_or("usage: forward_probe <model.gguf> <tokenizer-dir>")?;
    let mut tokenizer = ZenzPromptTokenizer::from_dir(Path::new(&tokenizer_dir))?;
    let mut evaluation_tokens = tokenizer
        .encode_candidate_prompt(CandidatePrompt {
            left_context: "",
            right_context: "",
            input: "トウキョウ",
        })
        .into_iter()
        .map(|token| token as u32)
        .collect::<Vec<_>>();
    let prompt_length = evaluation_tokens.len();
    let candidate_tokens = tokenizer.encode_candidate("東京");
    evaluation_tokens.extend(candidate_tokens.iter().map(|token| *token as u32));
    let logits = model.forward(&evaluation_tokens)?;
    let mut predicted = Vec::with_capacity(candidate_tokens.len());
    for candidate_offset in 0..candidate_tokens.len() {
        let row = logits.i(prompt_length + candidate_offset - 1)?.to_vec1::<f32>()?;
        let (token, _) = row
            .iter()
            .copied()
            .enumerate()
            .max_by(|left, right| left.1.total_cmp(&right.1))
            .ok_or("empty logits")?;
        predicted.push(token);
    }
    println!("tokyo_prompt={:?}", &evaluation_tokens[..prompt_length]);
    println!("tokyo_candidate={candidate_tokens:?}");
    println!("tokyo_predicted={predicted:?}");
    println!("tokyo_verified={}", predicted == candidate_tokens);
    Ok(())
}

#[cfg(not(feature = "candle"))]
fn main() {
    eprintln!("forward_probe requires --features candle");
    std::process::exit(2);
}
