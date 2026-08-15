# 08:07 バイナリの発話判定手順

読む人: specialist-advisor。実装ではない。ユーザーが話したあと、この順で叩く。

判定対象は **2026-08-16 08:07 に入れたバイナリ** だけ。
`build_id=b20260815230707709-7219c7ccf06868ce527a7647903f125e5bed4071-ed5c977e`
これ以外なら、今日揃えた観測の前提が崩れている。数字を読まない。

7B 警告（9200c1e）はこのバイナリに乗っていない。発話判定の前提ではない。見なくてよい。

## 0. 叩く前

起動時刻をメモする。例: `2026-08-16T09:00:00`。`--after` に使う。
古いログ（00:26、normalize n=243）が同じファイルに残っている。窓を切らないと今日の発話ではない。

**`--after` が切る行と切らない行がある。**

| 切る | 切らない |
| --- | --- |
| normalize / turn.final / translation decision / translation result / stage=translate | `runtime config` / `caption display lifecycle` / `caption overflow` |

display と overflow はファイル全体を見る。このログに旧セッションの lifecycle / overflow はまだ無い（00:26 判定で `no_display_events` / `no_overflow_events`）。初回発話なら混ざるものはない。2回目以降は、前回の display/overflow が残る。そのときはログを目で見て時刻を確認する。judge はここを切らない。

`runtime config` も窓の外。複数行あれば **最後の1行** を使う。起動し直していれば最後が今回。

## 1. コマンド

リポジトリ根から。`--log` を省略しない（省略しても同じ既定パスだが、usage を見て止まる失敗を今日やった）。

```bash
python3 scripts/judge-live-session.py \
  --log "$HOME/Library/Logs/com.kotobabeacon.desktop/kotoba-beacon.log" \
  --after 2026-08-16T09:00:00
```

`--after` は起動時刻に合わせる。`YYYY-MM-DDTHH:MM:SS`。ローカル時刻。ログの `[2026-08-16][09:00:00]` と同じ。

任意で認識開始後に1回:

```bash
pgrep -lf kotoba-parapper
```

`--turn-check-silence-ms` が `480` か。ログの `turn_check_silence_ms=480` と一致すれば契約検査1の限界（関数だけ見ていた）が閉じる。不一致なら数字より先にそれを書く。プロセスが無いのは「まだ認識していない」。判定不能。アプリを止めない。

## 2. 読む順

出力は上からこの順。上から読む。下から症状を拾わない。

1. `runtime_config`
2. `turn`
3. `normalize`（あれば `normalize_long`）
4. `translation`
5. `display`
6. `overflow_single_line`
7. `overflow_wrapped`

`gates …` は定数の再掲。判定結果ではない。

## 3. 行が期待と違うとき

イベントが無いことと、症状が無いことは違う。`no_*` と `ok` / `fits` / `cleared` を混ぜない。

### runtime_config

| 出たもの | 意味 | 次 |
| --- | --- | --- |
| `verdict=unknown` | このファイルに `runtime config` が1行も無い | 08:07 バイナリではない。または起動していない。`build_id=` を `rg` しない。**ここで止める。** 数字は読まない |
| `app_version=unknown build_id=unknown` なのに他のキーはある | 3091994 以降・08:07 より前（07:10）。設定は出るがビルドは分からない | 08:07 ではない。**止める** |
| `build_id=` が `b20260815230707709-7219c7c…ed5c977e` 以外 | 別ビルド | **止める** |
| `build_id` 一致、`turn_check_silence_ms` が 480 以外 | 設定が想定と違う | 遅延の数字を「480 導入後」とは言えない。未確定 |
| `normalizer` が `azookey-rust` 以外 | normalize p95 の意味が変わる | 遅い／速いはその normalizer の話。azookey の 3000ms 門と比較しない |
| `translator` が `hy-mt2-7b-gguf` | RSS 4.93GiB 経路 | 翻訳遅延は 1.8B の数字と比較しない |
| `hold_clear_ms` が 5000 以外 | 残留の前提が違う | stale 8000 は門のまま。hold 設計値が違うと解釈がずれる |
| `rows>=2` | 起動が複数回 | 最後の行が今回か、ログで確認 |

期待（デフォルトのままなら）:
`app_version=0.1.1 build_id=b20260815230707709-7219c7ccf06868ce527a7647903f125e5bed4071-ed5c977e turn_check_silence_ms=480 normalizer=azookey-rust translator=hy-mt2-1.8b-gguf hold_clear_ms=5000 source_max_chars=28 translation_max_chars=48 streaming_interim_asr=false`

### turn

| verdict | 次 |
| --- | --- |
| `insufficient` / turns が極端に少ない | 発話が足りない。もう話す。判定不能 |
| `fail_long`（max>=200 or ge129>=3） | 480 でも長いターンが残っている。**確定候補**。ただし normalize が insufficient なら n 不足で未確定 |
| `fail_oversplit`（p50<=8 or le4_share>=0.25） | 切りすぎ。480 が短すぎる可能性。確定候補 |
| `ok` / `strong_success` | 長さの門は通った。遅延そのものはこの行では分からない |

### normalize

| verdict | 次 |
| --- | --- |
| `no_normalize_events` | 変換が1回も走っていない。認識が動いていないか、窓が未来。display も空なら認識自体が動いていない |
| `insufficient`（n<20） | 短い。p95 を読まない。もう話す。判定不能 |
| `slow_normalize` | n>=20 かつ (p95>3000 or max>10000)。`normalizer=` を見てから言う。azookey-rust なら遅い。zenz なら別物 |
| `ok` | 変換時間の門は通った |
| `normalize_long` だけ大きい | 長い発話の変換コスト。ターン長の fail_long とセットで読む |

### translation

| verdict | 次 |
| --- | --- |
| `no_final_received` | `turn.final` が無い。認識が final を出していない。字幕が出ていても翻訳判定は不能 |
| spawn=0 で skip だけ | 理由を `translation_reasons` で見る。final が来ていない／既に訳した、など |
| failed / discarded が多い | 翻訳経路。ターン長とは別 |

### display

| verdict | 次 |
| --- | --- |
| `no_display_events` | **残留が無い、ではない。** 観測が1回も無い。字幕が画面に出たかユーザーに聞く。出ていれば 08:07 の frontend ログが乗っていない（古いフロント）。出ていなければ認識が動いていない。判定不能 |
| `stale_caption_held`（age_ms>=8000） | 残っている。**確定**。hold 設計 5000、門 8000 |
| `hold_without_clear` | hold のあと clear も次の visible も無い。セッション末で切った可能性。ログ末尾の時刻と発話終了を照合。確定しきれなければ未確定 |
| `cleared` | 残留の門は通った。hold→clear または hold→次の visible |

### overflow

2行ある。混ぜない。`line_count=1` と `>=2` は次の手が違う。

| verdict | 次 |
| --- | --- |
| 両方 `no_overflow_events` | **溢れていない、ではない。** 観測が無い。display に visible があるのに overflow が空なら、観測が動いていない（08:07 フロントが乗っていない）。visible も無ければ認識の問題。判定不能 |
| `overflow_single_line` が `overflowed` | wrap が効いていない。幅か max_chars。`source_max_chars` / `translation_max_chars` を runtime_config で確認 |
| `overflow_wrapped` が `overflowed` | wrap したうえで収まっていない。行数かフォント。single_line とは別件 |
| `fits` | そのバケットでは溢れていない。観測は動いている |

## 4. 報告の型

3症状それぞれを **確定 / 未確定 / 判定不能** のどれか1つで書く。数字だけ並べない。`runtime_config` の `build_id` を1行目に置く。

| 症状 | 確定 | 未確定 | 判定不能 |
| --- | --- | --- | --- |
| ターン長・分割（480 の効果） | turn が fail_long または fail_oversplit で、normalize n>=20、build_id 一致、silence=480 | 門は割ったが n<20、または silence が 480 と確認できない | runtime_config unknown、または normalize が no_normalize_events |
| 字幕残留 | display=stale_caption_held、build_id 一致 | hold_without_clear だけ | no_display_events |
| 見切れ | overflowed=true の行がある（single / wrapped を分けて書く） | overflow イベントはあるが解釈が割れる | 両方 no_overflow_events。visible の有無を添える |

書いてはいけないこと:

- `no_display_events` を「残留なし」
- `no_overflow_events` を「見切れなし」
- `insufficient` の p95 を遅さの証拠
- 08:07 以外の build_id の数字を、今日入れた観測の成果として話す
- ログ本文・発話テキスト・パス・Access トークン
