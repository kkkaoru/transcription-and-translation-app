use std::path::PathBuf;

use anyhow::{Context, Result};
use parapper_engine::LocalTranslator;

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let models_root =
        PathBuf::from(args.next().context("usage: verify_translation MODELS_ROOT TEXT")?);
    let source = args.next().context("usage: verify_translation MODELS_ROOT TEXT")?;
    if !models_root.is_absolute() {
        anyhow::bail!("models root must be absolute: {}", models_root.display());
    }
    let mut translator = LocalTranslator::load(&models_root)?;
    let translation = translator.translate_ja_to_en(&source)?;
    println!(
        "{}",
        serde_json::json!({
            "result": "PASS",
            "source": source,
            "translation": translation,
            "processArchitecture": "in-process"
        })
    );
    Ok(())
}
