"""Export NVIDIA's pinned NeMo AmberNet checkpoint and preprocessing constants."""

import json
from pathlib import Path

import torch
from nemo.collections.asr.models import EncDecSpeakerLabelModel  # type: ignore[import-untyped]


def main() -> None:
    model = EncDecSpeakerLabelModel.restore_from(
        "/models/source/ambernet.nemo", map_location="cpu"
    )
    model.eval()
    model.export("/models/nvidia-ambernet/ambernet.onnx")
    labels = list(model.cfg.train_ds.labels)
    Path("/models/nvidia-ambernet/labels.json").write_text(
        json.dumps(labels, separators=(",", ":")), encoding="utf-8"
    )
    featurizer = model.preprocessor.featurizer
    window = torch.nn.functional.pad(
        featurizer.window.detach().cpu(),
        ((featurizer.n_fft - featurizer.win_length) // 2,) * 2,
    )
    preprocessor = {
        "n_fft": featurizer.n_fft,
        "hop_length": featurizer.hop_length,
        "pad_to": featurizer.pad_to,
        "preemphasis": featurizer.preemph,
        "log_zero_guard": float(featurizer.log_zero_guard_value_fn(window)),
        "window": window.tolist(),
        "filter_bank": featurizer.filter_banks.detach().cpu().squeeze(0).tolist(),
    }
    Path("/models/nvidia-ambernet/preprocessor.json").write_text(
        json.dumps(preprocessor, separators=(",", ":")), encoding="utf-8"
    )
    print(f"Exported AmberNet with {len(labels)} labels and official preprocessing constants")


if __name__ == "__main__":
    main()
