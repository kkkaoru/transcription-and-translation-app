# Cloudflare Containers checkpoint / snapshot 検証レポート

- 検証日: 2026-08-27〜2026-08-28
- 対象: `apps/zenz-container`
- 対象アーキテクチャ: `linux/amd64`
- 結論: 現行のxsmall llama/N5ではCRIUを本番cold-start経路に採用しない。診断canaryとしてのみ保持し、Cloudflareのネイティブsnapshotが有効になった時点で本レポートの合格基準に従って再測定する。

## 1. Executive summary

Cloudflare Containers内でのCRIU dumpは、Cloudflareカーネルが`kcmp()`を`ENOSYS`で拒否するため成功しなかった。一方、完全一致する外部x86_64環境で作成したcheckpointのrestoreは成功し、復元後の`/health`と`/completion`もHTTP 200を返した。

R2を耐久ソース、Workers Cacheをデータセンター内L1として使う経路では、checkpoint downloadの中央値を231.160 msから35.077 msへ84.8%短縮できた。しかしContainer割り当て時間は239〜16,432 msと大きく変動し、Cacheはエンドツーエンドの高速化を保証しなかった。

checkpointをContainer imageへ展開済みで同梱し、専用Rust bootstrapから直接restoreする構成も検証した。実際のUIデフォルト相当である`standard-3 / xsmall / N5-off / 2 threads`では、通常起動がCRIUより速かった。N5-onのプロセスツリーcheckpointも復元自体は成功したが、匿名メモリのため圧縮97 MiB・展開144 MiBとなり、true-x86 QEMUの事前ゲートで通常起動より205 ms遅かった。

現行のCRIUはプロセス状態を復元できても、新しいCloudflare VMのLinux page cacheを復元しない。GGUFのfile-backed pageを最初の推論で再度faultするため、warm checkpointでも最初のcompletionが通常起動より遅かった。ネイティブsnapshotが将来、単なるfilesystem snapshotではなくVMメモリとpage cacheまで復元する場合に限り、この制約を解消できる可能性がある。

## 2. 検証コード

| 目的 | 実装 |
| --- | --- |
| Cloudflare CRIU capability、R2 restore、dump失敗理由 | `src/criu-poc.ts`, `src/criu-poc.test.ts`, `wrangler.criu.jsonc` |
| Workers Cache → R2 fallback付きcheckpoint delivery | `src/criu-cache-poc.ts`, `src/criu-cache-poc.test.ts`, `wrangler.criu-cache.jsonc` |
| image-baked CRIUと通常起動のcold benchmark | `src/baked-criu-benchmark.ts`, `src/baked-criu-benchmark.test.ts`, `wrangler.baked-criu-benchmark.jsonc` |
| Cloudflare native snapshotの作成・復元・cold control比較 | `src/snapshot-poc.ts`, `src/snapshot-poc.test.ts`, `wrangler.snapshot.jsonc` |
| 直接restore用の最小bootstrap | `criu-bootstrap/` |
| Cloudflare向けCRIU 4.2.1互換patch | `criu-poc/pr-set-mm-order.patch` |
| 再現用xsmall checkpoint fixture | `criu-poc/llama-xsmall-amd64.tar.gz` |
| 診断用image stage | `Dockerfile`の`runtime-snapshot-diagnostic`、`runtime-diagnostic*`、`runtime-criu-baked` |

診断Workerはすべてproduction class・binding・routingから分離している。`max_instances: 1`、`sleepAfter: 30s`、`enableInternet: false`を使用し、`/run`と`/last`はWrangler secretで認証する。secret値はrepositoryへ保存しない。

## 3. 固定したartifactと互換条件

### 3.1 CRIU

- CRIU: 4.2.1
- source SHA-256: `feffdf4638125ebb12d2434754f80a1d7bbba85a3e6bee98c216f88fb99a5d96`
- Cloudflareへdeployしたpatched binary SHA-256: `371a164ecbf67c3d00f5f65441ca77ddc5435b591447fb2b0af6b302b9c71ad6`
- patch: `criu-poc/pr-set-mm-order.patch`

Cloudflare Firecracker環境ではatomic `PR_SET_MM_MAP`が失敗し、legacy `PR_SET_MM` fallbackも元の順序では範囲検証に失敗した。patchはcode/data/argument/environment/BRKの上限を先に設定してから下限を設定する。

### 3.2 repository fixture

- path: `criu-poc/llama-xsmall-amd64.tar.gz`
- bytes: `1,061,548`
- SHA-256: `03b99a129b5e64ecf61b78c99bfab081092c120db411141ecdb7d797d9aa9537`
- server: warmed xsmall `llama-server`
- address: `0.0.0.0:8080`
- checkpoint PID: 2000
- dump / restore: `setarch x86_64 -R`

checkpointは、llama.cpp binary、GGUF、shared libraries、arguments、CRIU、ASLR条件が一致する場合にのみ有効である。現在の診断restoreは`--cpu-cap=none`を使うため、productionへ昇格させる場合はCPU featureとartifact identityの検証が追加で必要になる。

## 4. 実験結果

### 4.1 Cloudflare内dumpと外部checkpoint restore

Cloudflare Containerはroot、`CAP_CHECKPOINT_RESTORE`、`CAP_SYS_PTRACE`、`CAP_SYS_ADMIN`、seccomp無効、および`clone3(set_tid)`を提供した。しかしdumpは次で失敗した。

```text
kcmp failed: Function not implemented
Can't make VM id
Dumping FAILED
```

`criu check --all`にも次が残った。

```text
sys/kernel/ns_last_pid sysctl is inaccessible: No such file or directory
```

これはCloudflare内でcheckpointを生成できないことを示す。外部のtrue x86_64 QEMU環境で生成したcheckpointのrestoreは成功した。

```text
restored_pid=2000
/health: HTTP 200
/completion: HTTP 200
```

RosettaはCRIUのFPU register / ptrace要件を満たさなかったため使用していない。

### 4.2 R2とWorkers Cache

検証経路:

```text
Container
  -> ContainerProxy / outbound handler
  -> Workers Cache
  -> R2 on MISS
```

歴史的なCache測定では、機能的に同等な1,076,203-byte checkpointを用いた。

```text
median R2 MISS download:          231.160 ms
median Workers Cache HIT:          35.077 ms
median download reduction:          84.8%
median MISS restore pipeline:      953 ms
median HIT restore pipeline:       826 ms
median pipeline reduction:          13.3%
Container allocation range: 239〜16,432 ms
```

Workers Cacheはcheckpoint bodyを保存し、Container再起動後に`MISS -> HIT`を確認した。両方でbyte count、SHA-256、CRIU restore、health、completionを検証した。ただしWorkers Cacheはデータセンターlocal、evictable、非耐久である。R2 fallbackは常に必要であり、Cache HITを前提にした起動経路にはできない。

### 4.3 basic / xsmall

5件中央値:

```text
normal mmap:              ready 1008 ms, completion  77 ms, total 1093 ms
baked CRIU mmap:          ready  929 ms, completion 202 ms, total 1245 ms
baked CRIU no-mmap:       ready 1102 ms, completion  63 ms, total 1158 ms
normal no-mmap:           ready  775 ms, completion  50 ms, total  825 ms
```

5組の交互測定でも通常`--no-mmap`は通常mmapよりtotal p50を1,175 msから825 msへ350 ms（29.8%）短縮した。このため`basic/xsmall/n5-off`にはCRIUではなく通常`--no-mmap`を採用した。

### 4.4 standard-3 / xsmall / N5-off

実際のUIデフォルト相当で、各runはfresh Durable Objectを用い、順序を交互にした。

```text
                                      ready p50  first p50  total p50  total p95
normal mmap, warmed-checkpoint run        501 ms       15 ms     524 ms    2230 ms
normal --no-mmap, same run                542 ms       15 ms     560 ms     939 ms
warmed CRIU                               521 ms       69 ms     556 ms     943 ms
normal mmap, ready-checkpoint run         532 ms       20 ms     554 ms    1550 ms
normal --no-mmap, same run                526 ms        7 ms     542 ms    1095 ms
ready-only CRIU                           516 ms       74 ms     623 ms    1600 ms
```

ready-only checkpointは約1.3 MiBから809 KiBへ縮小したが、first completion penaltyは解消しなかった。20件の通常起動を合算したtotal p50はmmap 543 ms、`--no-mmap` 547 msであり、standard productionはmmapのまま変更していない。

### 4.5 standard-3 / xsmall / N5-on process tree

`zenz-entrypoint`と子`llama-server`を同時にcheckpointした。local restore後にllama health/completionとN5 health/rescoreはすべて成功した。

```text
compressed checkpoint: 97 MiB
expanded anonymous pages: 144 MiB
```

true-x86 QEMUの5組交互測定:

```text
                              ready p50  concurrent inference p50  total p50
normal N5-on                      3035 ms                     752 ms    3787 ms
baked process-tree CRIU           3371 ms                     825 ms    3992 ms
```

CRIUは205 ms（5.4%）遅く、checkpointも大きいためCloudflareへdeployする前の性能ゲートで不採用とした。97 MiB artifactはrepositoryへ含めていない。

## 5. CRIUが高速化しなかった原因

通常起動:

```text
Container allocation
-> llama-server exec
-> GGUF metadata / mmap
-> listen
-> first completion page faults
```

CRIU:

```text
Container allocation（同じ）
-> Rust bootstrap / setarch / criu
-> checkpoint image read
-> PID / VMAs / threads / futexes / FDs / sockets restore
-> GGUF file mapping restore
-> listen resumes
-> first completion page faults（残る）
```

主因:

1. **Container allocationを短縮しない。** Worker、Durable Object、VM割り当て、image配置はCRIUの外側にある。
2. **GGUFのLinux page cacheを復元しない。** mmap情報は戻るが、新しいVMでは最初の推論時にfile-backed pageを再読込する。
3. **xsmallのuser-space初期化が軽い。** `exec + mmap`よりCRIUの復元処理が単純ではない。
4. **no-mmapはcheckpointを肥大化させる。** weightが匿名ページに入り、通常の逐次読込よりrestoreが重くなる。
5. **N5の再利用可能状態は匿名メモリで大きい。** 初期化を省略しても144 MiBの復元コストが上回る。
6. **warm KV状態の再利用範囲が小さい。** STT入力はユーザーごとに異なり、固定warmup promptの計算を十分再利用できない。

## 6. 現在のCloudflare native snapshot結果

`src/snapshot-poc.ts`は次を自動実行する。

1. `snapshotContainer()`と`snapshotDirectory()`のruntime availability確認
2. 通常起動、health、completion
3. filesystem marker、VM boot ID、PID 1 start ticksの記録
4. native snapshot作成
5. snapshot descriptorのWorkers Cache round-trip
6. snapshotなしcold control
7. snapshot restore
8. filesystem、VM identity、process identity、startup、first completionの比較
9. Durable Object storageへのreport保存とContainer破棄

2026-08-27のCloudflare実行では両APIが次で拒否された。

```text
Snapshots are not available because the container does not meet the required snapshot prerequisites.
```

Workers Cacheで成功したのはsnapshot-shaped metadataのput/match（各4 ms）だけで、snapshot payloadの作成・保存・復元ではない。

## 7. 将来Cloudflare snapshotが有効になった場合の期待値

### 7.1 現在公式に記載されている範囲

Cloudflare Containers FAQとlifecycle docsは、現在のdiskをephemeralと説明し、Containerがsleepした後はimageで定義されたfresh diskから開始するとしている。同じ文書はsnapshotを「coming soon」とし、entire containerまたはdirectoryの**disk**を高速にpersist / restoreする機能として説明している。

この記述どおりfilesystem snapshotだけが提供される場合、今回のllama cold startへの期待値は低い。

| 将来機能の実体 | 期待するprobe結果 | 性能期待 |
| --- | --- | --- |
| directory snapshot | `filesystemRestored=true`, VM/process identityはfalse | immutable GGUFは既にimage layerにあるため、通常起動より速くなる根拠はない |
| whole-container disk snapshot | filesystem markerは復元、entrypointは再実行 | mutable disk準備には有効だが、llama process / KV / page cacheは復元されず、first completion改善は期待しない |
| process-memory snapshot | process identityとwarm inference stateが復元 | llama/N5のuser-space初期化省略が可能。ただしpage cacheが別ならCRIUと同じfirst completion penaltyが残り得る |
| whole-VM memory/page-cache snapshot | VM/process identity、warm completionが復元 | 今回のCRIUで残ったpage faultを解消できる最も有望なケース |

公式Container Interfaceには、現時点で`snapshotContainer()`、`snapshotDirectory()`、`containerSnapshot`の公開契約が記載されていない。repositoryのprobeはruntime typesに存在するexperimental shapeを隔離して検証するものであり、API安定性を前提にしない。

### 7.2 期待できる改善と上限

ネイティブsnapshotでもWorker/DO routing、配置選択、VM/Container割り当ては残る。したがって、CRIUで観測した最大16秒超のallocation varianceをsnapshotだけで消せるとは期待しない。

一方、Cloudflareがhypervisorレベルで次をローカルかつlazyに復元できるなら、CRIUより有利になる。

- warmed anonymous memoryをuser-space archiveとして読み直さない
- GGUF-backed page cacheまたは同等のmemory pageを復元する
- threads、sockets、allocator、N5 parsed stateを一括で復元する
- snapshot imageを配置先にpre-positionする

これは特に144 MiBのN5状態で効果が見込める可能性があるが、実際のrestore page数、圧縮、lazy paging、配置、課金モデルが未公開なので数値改善を断定しない。

### 7.3 production採用ゲート

native snapshotが利用可能になっても、API成功だけでは採用しない。最低20件の交互・fresh-instance試験を行い、次をすべて満たすこと。

1. `/health`、最初の`/completion`、N5-onでは`/rescore`が100%成功する。
2. snapshotなしcold controlに対し、ready + first useful inferenceのp50を**100 ms以上かつ15%以上**短縮する。
3. p95を悪化させない。
4. snapshot lookup / restoreを含むbilled runtimeを短縮する。
5. snapshot miss、eviction、version mismatch時に通常image起動へ安全にfallbackする。
6. binary、model、libraries、arguments、CPU feature、snapshot formatのidentityを検証する。
7. rollout後も30秒scale-to-zero、`max_instances: 1`、明示的`destroy()`を維持する。
8. 複数のAPAC配置とimage/cache cold状態で再現する。

現在のbest baselineから導く合格ライン:

```text
basic/xsmall/n5-off:    total p50 825 ms -> target <= 701 ms（15%基準が厳しい）
standard/xsmall/n5-off: total p50 543 ms -> target <= 443 ms（100 ms基準が厳しい）
```

`src/snapshot-poc.ts`はcold controlとsnapshot pathを同じrun内で比較し、次をreportする。

- `filesystemRestored`
- `vmIdentityRestored`
- `processIdentityRestored`
- `startupAccelerated`, `startupDeltaMs`, `startupDeltaPercent`
- `firstCompletionAccelerated`, `completionDeltaMs`, `completionDeltaPercent`

boot IDとprocess start ticksの一致はexecution identityの証拠であり、単独で全メモリ内容の完全性を証明するものではない。最初のcompletion短縮と機能テストを併用して判定する。

## 8. 再実行手順

### 8.1 共通検証

```bash
cd apps/zenz-container
bun install --frozen-lockfile
bun run typecheck
bun run test
bunx biome check src \
  wrangler.criu.jsonc \
  wrangler.criu-cache.jsonc \
  wrangler.baked-criu-benchmark.jsonc \
  wrangler.snapshot.jsonc

cd criu-bootstrap
cargo fmt --check
cargo check --locked
cargo clippy --locked -- -D warnings
cargo test --locked
```

### 8.2 R2 fixture更新

R2を耐久ソースとして使うprobeでは、repository fixtureと同じobjectを明示的にuploadする。

```bash
bunx wrangler r2 object put \
  kotoba-beacon-zenz-criu-poc/checkpoints/llama-xsmall-amd64-criu-4.2.1.tar.gz \
  --file criu-poc/llama-xsmall-amd64.tar.gz \
  --content-type application/gzip \
  --remote
```

### 8.3 診断Worker

secretは対話入力または権限を制限した一時ファイルから設定し、shell historyやrepositoryへ残さない。

```bash
bunx wrangler secret put CRIU_DIAGNOSTIC_TOKEN --config wrangler.criu.jsonc
bunx wrangler deploy --config wrangler.criu.jsonc

bunx wrangler secret put CRIU_CACHE_DIAGNOSTIC_TOKEN --config wrangler.criu-cache.jsonc
bunx wrangler deploy --config wrangler.criu-cache.jsonc

bunx wrangler secret put BAKED_CRIU_BENCHMARK_TOKEN \
  --config wrangler.baked-criu-benchmark.jsonc
bunx wrangler deploy --config wrangler.baked-criu-benchmark.jsonc

bunx wrangler secret put SNAPSHOT_DIAGNOSTIC_TOKEN --config wrangler.snapshot.jsonc
bunx wrangler deploy --config wrangler.snapshot.jsonc
```

各Workerは`POST /run`で測定し、認証付き`GET /last`で最後の永続reportを取得する。Cache probeには`POST /cached`と`GET /last-cached`もある。benchmark Workerは`POST /normal`、`POST /normal-nommap`、`POST /baked-criu`を提供する。

本番routingへ接続せず、測定後は`wrangler containers info <application-id>`で`active: 0`を確認する。

## 9. 参照

2026-08-28参照:

- Cloudflare Containers FAQ: <https://developers.cloudflare.com/containers/faq/>
- Lifecycle of a Container: <https://developers.cloudflare.com/containers/platform-details/architecture/>
- Container Interface: <https://developers.cloudflare.com/containers/container-class/>
- CRIU 4.2.1: <https://github.com/checkpoint-restore/criu/releases/tag/v4.2.1>

公式docsの現在の要点:

- cold startはimage sizeやentrypoint実行時間に依存する。
- imageはCloudflare Networkへ配布・pre-fetchされる。
- Container instanceは個別VM内で動く。
- diskはephemeralで、sleep後はimage由来のfresh diskになる。
- snapshotはcoming soonで、entire containerまたはdirectoryのdisk persist / restoreとして説明されている。
