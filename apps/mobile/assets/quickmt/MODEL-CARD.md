---
language:
- en
- ja
tags:
- translation
license: cc-by-4.0
datasets:
- quickmt/quickmt-train.ja-en
- quickmt/madlad400-en-backtranslated-ja
- quickmt/newscrawl2024-en-backtranslated-ja
model-index:
- name: quickmt-ja-en
  results:
  - task:
      name: Translation jap-eng
      type: translation
      args: jpn-eng
    dataset:
      name: flores101-devtest
      type: flores_101
      args: jpn_Jpan eng_Latn devtest
    metrics:
    - name: BLEU
      type: bleu
      value: 28.87 
    - name: CHRF
      type: chrf
      value: 58.56
    - name: COMET
      type: comet
      value: 87.83
---

<a href="https://huggingface.co/spaces/quickmt/quickmt-gui"><img src="https://huggingface.co/datasets/huggingface/badges/resolve/main/open-in-hf-spaces-lg-dark.svg" alt="Open in Spaces"></a>

# `quickmt-ja-en` Neural Machine Translation Model 

`quickmt-ja-en` is a reasonably fast and reasonably accurate neural machine translation model for translation from `ja` into `en`.

`quickmt` models are roughly 3 times faster for GPU inference than OpusMT models and roughly [40 times](https://huggingface.co/spaces/quickmt/quickmt-vs-libretranslate) faster than [LibreTranslate](https://huggingface.co/spaces/quickmt/quickmt-vs-libretranslate)/[ArgosTranslate](github.com/argosopentech/argos-translate). 


## *UPDATED!* 

This model was trained with back-translated data and a slightly different configuration and has improved translation quality!


## Try it on our Huggingface Space

Give it a try before downloading here: https://huggingface.co/spaces/quickmt/QuickMT-gui


## Model Information

* Trained using [`eole`](https://github.com/eole-nlp/eole) 
* 200M parameter seq2seq transformer
* 32k separate Sentencepiece vocabs
* Exported for fast inference to [CTranslate2](https://github.com/OpenNMT/CTranslate2) format
* The pytorch model (for use with [`eole`](https://github.com/eole-nlp/eole)) is available in this repository in the `eole-model` folder

See the `eole` model configuration in this repository for further details and the `eole-model` for the raw `eole` (pytorch) model.


## Usage with `quickmt`

You must install the Nvidia cuda toolkit first, if you want to do GPU inference.

Next, install the `quickmt` [python library](github.com/quickmt/quickmt). 

```bash
git clone https://github.com/quickmt/quickmt.git
pip install ./quickmt/
```

Finally, use the model in python:

```python
from quickmt import Translator
from huggingface_hub import snapshot_download

# Download Model (if not downloaded already) and return path to local model
# Device is either 'auto', 'cpu' or 'cuda'
mt = Translator(
    snapshot_download("quickmt/quickmt-ja-en", ignore_patterns="eole-model/*"),
    device="cpu"
)

# Translate - set beam size to 1 for faster speed (but lower quality)
sample_text = 'ノバスコシア州ハリファックスにあるダルハウジー大学医学部教授でカナダ糖尿病協会の臨床・科学部門の責任者を務めるエフード・ウル博士は、この研究はまだ初期段階にあるとして注意を促しました。'

mt(sample_text, beam_size=5)
```

> 'Dr Ehud Ulu, professor of medicine at Dalhousie University in Halifax, Nova Scotia and head of the clinical and scientific division of the Canadian Diabetes Association, urged caution as the study is still in its infancy.'

```python
# Get alternative translations by sampling
# You can pass any cTranslate2 `translate_batch` arguments
mt([sample_text], sampling_temperature=1.2, beam_size=1, sampling_topk=50, sampling_topp=0.9)
```

> 'Dr Ehud Ulu, Professor of Medicine at Dalhousie University in Halifax, Nova Scotia and head of clinical and scientific departments for the Canadian Diabetes Society, urged caution, saying the research was still in its early stages.'

The model is in `ctranslate2` format, and the tokenizers are `sentencepiece`, so you can use `ctranslate2` directly instead of through `quickmt`. It is also possible  to get this model to work with e.g. [LibreTranslate](https://libretranslate.com/) which also uses `ctranslate2` and `sentencepiece`. A model in safetensors format to be used with `eole` is also provided.


## Metrics

`bleu` and `chrf2` are calculated with [sacrebleu](https://github.com/mjpost/sacrebleu) on the [Flores200 `devtest` test set](https://huggingface.co/datasets/facebook/flores), `comet22` with the [`comet`](https://github.com/Unbabel/COMET) library and the [default model](https://huggingface.co/Unbabel/wmt22-comet-da). "Time (s)" is the time in seconds to translate the flores-devtest dataset (1012 sentences) on an RTX 4070s GPU with batch size 32.


|                                        |   bleu |   chrf2 |   comet22 |   Time (s) |
|:---------------------------------------|-------:|--------:|----------:|-----------:|
| quickmt/quickmt-ja-en                  |  28.87 |   58.56 |     87.83 |       1.10 |
| Helsink-NLP/opus-mt-ja-en              |  19.22 |   49.15 |     82.64 |       3.54 |
| facebook/m2m100_418M                   |  18.82 |   49.55 |     82.59 |      18.27 |
| facebook/nllb-200-distilled-600M       |  24.05 |   53.39 |     85.84 |      22.5  |
| tencent/Hunyuan-MT-7B-fp8              |  22.84 |   56.76 |     87.92 |      22    |
| facebook/m2m100_1.2B                   |  23.32 |   53.46 |     85.43 |      35.44 |
| facebook/nllb-200-distilled-1.3B       |  28.4  |   56.96 |     87.47 |      37.15 |
| CohereLabs/aya-expanse-8b (bnb quant)  |  26.40 |   56.92 |     87.97 |       73   |
