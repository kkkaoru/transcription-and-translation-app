use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub family: String,
    pub label: String,
    pub description: String,
    pub languages: Vec<String>,
    pub local_artifact: String,
    pub recommended: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelCatalog {
    pub asr: Vec<ModelInfo>,
    pub normalizer: Vec<ModelInfo>,
    pub translator: Vec<ModelInfo>,
}

fn model(
    family: &str,
    id: &str,
    label: &str,
    description: &str,
    local_artifact: &str,
    languages: &[&str],
    recommended: bool,
) -> ModelInfo {
    ModelInfo {
        id: id.to_string(),
        family: family.to_string(),
        label: label.to_string(),
        description: description.to_string(),
        languages: languages.iter().map(|language| language.to_string()).collect(),
        local_artifact: local_artifact.to_string(),
        recommended,
    }
}

pub fn catalog() -> ModelCatalog {
    ModelCatalog {
        asr: vec![model(
            "asr",
            "parapper-ja",
            "Parapper ASR / 日本語",
            "Parapper-ASRを日本語のストリーミング認識に使用します。",
            "Parapper-ASR runtime",
            &["ja"],
            true,
        )],
        normalizer: vec![
            model(
                "normalizer",
                "azookey-rust",
                "AzooKey Rust（辞書・内蔵）",
                "AzooKeyの変換処理をRustのViterbi変換器として実行します。",
                "内蔵辞書 / optional AzooKey dictionary",
                &["ja"],
                true,
            ),
            model(
                "normalizer",
                "zenz-v3.2-xsmall-gguf",
                "AzooKey Zenzai v3.2 xsmall",
                "AzooKey公式のニューラル変換。低レイテンシー向けのxsmall GGUFです。",
                "ggml-model-Q5_K_M.gguf",
                &["ja"],
                false,
            ),
            model(
                "normalizer",
                "zenz-v3.2-small-gguf",
                "AzooKey Zenzai v3.2 small",
                "AzooKey公式のニューラル変換。変換精度を優先するsmall GGUFです。",
                "ggml-model-Q5_K_M.gguf",
                &["ja"],
                false,
            ),
            model(
                "normalizer",
                "zenz-v2-q5-k-m-gguf",
                "AzooKey Zenzai v2 Q5_K_M",
                "低メモリ環境向けのZenzai v2互換GGUFモデルです。",
                "zenz-v2-Q5_K_M.gguf",
                &["ja"],
                false,
            ),
        ],
        translator: vec![
            model(
                "translator",
                "hy-mt2-1.8b-gguf",
                "Hy-MT2 1.8B GGUF",
                "日本語から英語へのライブ字幕に適した標準量子化モデルです。",
                "Hy-MT2-1.8B-GGUF",
                &["ja", "en"],
                true,
            ),
            model(
                "translator",
                "hy-mt2-1.8b-2bit-gguf",
                "Hy-MT2 1.8B 2-bit GGUF",
                "メモリ使用量と速度を優先するモデルです。",
                "Hy-MT2-1.8B-2bit-GGUF",
                &["ja", "en"],
                false,
            ),
            model(
                "translator",
                "hy-mt2-1.8b-1.25bit-gguf",
                "Hy-MT2 1.8B 1.25-bit GGUF",
                "オンデバイス実行のための最小モデルです。",
                "Hy-MT2-1.8B-1.25bit-GGUF",
                &["ja", "en"],
                false,
            ),
            model(
                "translator",
                "hy-mt2-7b-gguf",
                "Hy-MT2 7B GGUF",
                "レイテンシーより翻訳品質を優先するモデルです。",
                "Hy-MT2-7B-GGUF",
                &["ja", "en"],
                false,
            ),
        ],
    }
}
