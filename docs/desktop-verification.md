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
   - Confirm an OPEN-segment prediction is appended after the completed source in low opacity and wraps within the shared two-line source area.
   - Start a new utterance after a completed translated caption. The completed translation should remain visible while the low-opacity prediction updates.
   - Confirm the prediction is replaced normally when the new source caption is committed.

## Reading diagnostics

On macOS, inspect the application's existing log before asking the user to copy
diagnostic JSON:

```bash
LOG="$HOME/Library/Logs/com.kotobabeacon.desktop/kotoba-beacon.log"
rg '\[pipeline_stage\]' "$LOG"
```

Completed ASR, normalize, and translation stages are written there with model,
status, duration, utterance ID, capture generation, and bounded input/output
samples. Current builds also append `input_chars` and `output_chars`, which are
counts from the complete stage values before the 160-character samples are
truncated. These fields distinguish a genuinely short input from a censored
long-caption sample.

The log can contain speech samples. Read it locally, do not attach or persist a
copy by default, and report numeric aggregates or redacted rows. For a
privacy-safe timing view that removes the bounded text fields:

```bash
rg '\[pipeline_stage\]' "$LOG" \
  | sed -E 's/ in=.* out=.* generation=/ generation=/'
```

Use **設定 → 診断 JSON をコピー** only when the local log is unavailable or
the investigation needs current configuration, sidecar health, the retained
translation decision ring, or the in-progress `zenzVerifierLoad` snapshot. The
snapshot is top-level diagnostics rather than a completed stage, so it can show
`status: "loading"` while capture startup is still waiting for the verifier.

Record the installed build/commit with every diagnostic report. This prevents
events from one display policy being interpreted against another version.

## Live-session numeric judge

After a user-started capture, judge the local log with numeric gates only. The
script never prints transcript text, model paths, or session UUIDs:

```bash
python3 scripts/judge-live-session.py --after 2026-08-16T00:47:00
```

Precommitted turn-length gates:

| Verdict | Condition |
| --- | --- |
| `success` | max≤100, p95≤48, ≥129-character turns = 0 |
| `strong_success` | success and max≤40 |
| `fail_long` | max≥200 or ≥129-character turns ≥3 |
| `fail_oversplit` | p50≤8 or share of ≤4-character turns ≥0.25 |
| `fail_mixed` | both long-turn and oversplit conditions |

A normalize p95 ≤3000 ms is a secondary timing check, not a turn-length gate.
Translation is judged separately from `turn.final` / `translation decision` /
`translation result` / `stage=translate` counts.

## Translation decision guide

Inspect the retained pipeline stages and `captionTranslationDispositions` in the copied JSON. For kana-to-kanji corruption, first check the recorded `normalize` model: custom dictionary and AzooKey quality conclusions apply only when it is `azookey-rust`; a Zenz output must not be diagnosed as an AzooKey conversion.

| Evidence | Interpretation |
| --- | --- |
| `normalize` model is not `azookey-rust` | AzooKey and its custom dictionary were not used; resolve the selected normalizer before investigating AzooKey quality |
| No successful Rust `translate` stage, or a failed stage | Translation backend/pipeline issue |
| `decisionSource: "merge"` with a drop reason | The merge reason rejected the translation |
| `decisionSource: "display"`, `reason: "no-displayable-translation"` | The merged output contained no displayable letter or number |
| `decisionSource: "display"`, `reason: "displayed"` | The shared display gate emitted the translation; investigate downstream DOM/CSS/native canvas/Syphon rendering |
| No merge or display decision despite a successful translate stage | Check IPC/event delivery and include the full diagnostic JSON |

The ring stores reasons, character counts, and equality flags, not transcript text.

## Development note: coverage serialization

`check:all` and `test:coverage` use shared `coverage/` directories. Never run them concurrently in parallel-agent work; serialize them to prevent cleanup races and excessive memory pressure.
