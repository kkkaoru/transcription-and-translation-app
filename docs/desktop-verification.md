# Desktop verification and translation diagnostics

This checklist is for manual verification without automating the UI or changing audio devices, volume, or log level.

## Manual verification

1. Launch the installed **Kotoba Beacon** app normally when ready to test.
2. Confirm the top tabs are **配信 / 文字の装飾 / カスタム辞書 / アプリ設定**.
3. Open **カスタム辞書**:
   - On a fresh profile, confirm `ぶいあーるちゃっと` → `VRC` is present.
   - Speak that reading and confirm the converted source contains `VRC`.
   - Import a UTF-8 CSV with `よみ,単語` columns. Import appends to the current draft; select **辞書を保存** to apply it.
   - Export CSV and confirm the current entries are included.
4. Open **文字の装飾**:
   - Confirm the sample caption remains visible when the app window is narrow.
   - Switch between **1行表示** and **2行表示**.
   - Confirm the font-family select contains the current value and installed OS fonts, and selecting a font updates the sample.
5. In **配信**, without changing the selected input device:
   - Confirm an OPEN-segment prediction stays within the configured caption width.
   - Start a new utterance after a completed translated caption. The old caption should switch immediately to the low-opacity new prediction instead of hiding the new text behind the five-second hold.
   - Confirm the completed source and translation replace that prediction normally.

## Copying diagnostics

After reproducing an issue, open **設定** and select **診断 JSON をコピー**. The translation decision ring survives capture stop.

Record the installed build/commit with every diagnostic report. This prevents events from one display policy being interpreted against another version.

## Translation decision guide

Inspect the retained pipeline stages and `captionTranslationDispositions` in the copied JSON:

| Evidence | Interpretation |
| --- | --- |
| No successful Rust `translate` stage, or a failed stage | Translation backend/pipeline issue |
| `decisionSource: "merge"` with a drop reason | The merge reason rejected the translation |
| `decisionSource: "display"`, `reason: "prediction-only-plate"` | Translation was merged, then intentionally hidden because the next utterance prediction replaced the completed plate |
| `decisionSource: "display"`, `reason: "no-displayable-translation"` | The merged output contained no displayable letter or number |
| `decisionSource: "display"`, `reason: "displayed"` | The shared display gate emitted the translation; investigate downstream DOM/CSS/native canvas/Syphon rendering |
| No merge or display decision despite a successful translate stage | Check IPC/event delivery and include the full diagnostic JSON |

The ring stores reasons, character counts, and equality flags, not transcript text.

## Development note: coverage serialization

`check:all` and `test:coverage` use shared `coverage/` directories. Never run them concurrently in parallel-agent work; serialize them to prevent cleanup races and excessive memory pressure.
