# AGENTS.md

## ビルド生成物とディスク容量

- Rust coverage は必ず `make rust-native-coverage` または
  `make rust-parapper-engine-coverage` から実行する。裸の
  `cargo llvm-cov`、独自の `CARGO_TARGET_DIR`、エージェントごとの並列coverageは
  禁止する。Native診断Analyzerのcoverageは
  `bun run native:diagnostics:test:coverage` から実行する。
- macOS の `TMPDIR` とworktreeは通常同じAPFSボリュームにあるため、生成物を
  一時ディレクトリへ移すだけでは容量対策とみなさない。
- 正式なcoverage runnerは、全エージェント間の実行を直列化し、開始前に古い
  Rust/Flutter/coverageキャッシュを回収し、空き容量が12 GiB未満ならコンパイル前に
  失敗させ、成功・失敗のどちらでも計測用targetを直後に削除する。この契約を
  迂回するスクリプトやコマンドを追加しない。
- 中断されたビルドやcoverageの後、またはworktreeが肥大化した場合は
  `make clean-build-artifacts` を実行する。実行中のCargo/rustcを手動でkillしたり、
  そのtargetを直接削除したりしない。クリーンアップスクリプトの実行中判定に任せる。
- 容量調査では、worktreeの`du`だけでなく`df -h .`でボリューム全体の空き容量も
  確認する。coverage完了後に`llvm-cov-target`や`kotoba-rust-coverage-*`を残さない。
- `.cargo/config.toml`のdev/test incremental無効化と縮小デバッグ情報は容量上限の
  一部である。測定結果と明示的な承認なしに削除しない。

## カバレッジ品質ゲート

- Nativeのcaption pipeline（`apps/native/src/capture.rs` と
  `apps/native/src/pipeline_diagnostics.rs`）、Parapper Engineの変更された実行可能行、
  Native診断Analyzerは95%以上を必須とする。閾値を下げたり、対象ソースを除外したり、
  計測対象コードへcoverage無効化属性を追加して通過させてはならない。
- Rustの独立した`tests.rs`はcargo-llvm-covの実行コードレポートに現れないため、変更行の
  分母には含めない。一方、通常の`.rs`がレポートに存在しない場合は設定漏れとして失敗
  させる。この区別を緩めない。
- coverage runner、95%判定、LCOV解析、ディスク下限、lock、cleanupを変更した場合は
  `node --test scripts/run-rust-coverage.test.mjs scripts/clean-build-artifacts.test.mjs`を
  実行する。診断Analyzerを変更した場合は
  `bun run native:diagnostics:test:coverage`を実行する。

## Git hooks

- clone/worktree作成後は`make setup-git-hooks`を一度実行し、
  `git config --get core.hooksPath`が`.githooks`であることを確認する。
- `.githooks/pre-push`はpush対象のremote SHAをbaselineとして、Native、Engine、診断
  Analyzerの95%ゲートをすべて実行する。hookとCIのcoverage対象を乖離させない。
- coverage hookの失敗を`git push --no-verify`で回避しない。外部障害などで明示的な承認を
  得て一時回避した場合も、push前後に同じMake targetを手動実行して結果を記録する。

## 既存作業の保護

- 作業開始前に`git status --short`を確認し、他エージェントの未コミット変更を
  上書き・revert・整形しない。変更対象は依頼に必要なファイルへ限定する。
- coverage runnerが別のCargo/rustcを検出して清掃を延期した場合は、そのプロセスの完了を
  待って正式targetを再実行する。プロセスをkillしたり、lock・targetを手動削除したり、
  runnerを迂回したりしない。
