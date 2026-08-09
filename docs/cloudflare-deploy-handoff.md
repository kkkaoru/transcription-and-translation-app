# Cloudflare デプロイ作業引き継ぎ

最終更新: 2026-08-10。ブランチは `main`。
Workers はデプロイ済み。**compare に Access（OTP + Managed OAuth）を適用済み。**
**ブラウザ簡潔（Browser Vibrato → Browser AzooKey WASM、`/ws/azookey` 非使用）を compare に載せた。**

**秘密情報（API トークン、OAuth secret、`.env` の値、`POLICY_AUD`）は書かない・コミットしない・ログに出さない。**

---

## 本番 URL

- compare: `https://azookey-compare.kaoru.workers.dev`
  WS: `wss://azookey-compare.kaoru.workers.dev/ws/azookey`
  未認証: HTML `302`（Access login）、API `401` + `WWW-Authenticate: Bearer`（Managed OAuth）。
- inference: `kotoba-beacon-inference`
  公開 `workers.dev` は **無効**（`workers_dev: false`、直 URL は 404 / error 1042）。
  変換は compare の service binding `INFERENCE` のみ。

アカウント（非秘密）: Personal `78109ec18c7c85b194b19fb32e3bb149` / `kaoru@teadea.net` / `*.kaoru.workers.dev`。

compare Worker version（ブラウザ簡潔 + JWT ゲート + 2f6b234 inference Bearer 注入）: `1100b27e-3888-4af4-8f4e-6e9150aba219`。

---

## 決めたアーキテクチャ

```
Browser
  → Access (OTP + Managed OAuth, teadea allow)
  → https://azookey-compare.kaoru.workers.dev
       ├ Access JWT gate（POLICY_AUD + TEAM_DOMAIN secrets）
       ├ static Next export (`out/` + ASSETS)
       │    browser-compact: Vibrato WASM + AzooKey WASM in-page（/ws/azookey は呼ばない）
       └ worker-vibrato only: /ws/azookey, /v1/azookey
            → strip client Authorization, inject AZOOKEY_API_TOKEN Bearer when set
            → service binding INFERENCE
            → kotoba-beacon-inference（workers.dev 無し。Worker destination Access + deny everyone）
```

- compare Access app は **public destination**（hostname）。Worker destination は WebSocket upgrade を 403 にするため使わない。
- inference Access app は **worker destination** + deny everyone + Managed OAuth。公開 hostname は閉じたまま。
- Google IdP は env に `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` が無いので **未作成・スキップ**。
- compare Worker secrets: `POLICY_AUD`, `TEAM_DOMAIN`（値は invent しない・print しない）。`AZOOKEY_API_TOKEN` は **未設定**（`.env` にも無い。invent しない）。proxy は token があるときだけ Bearer を付ける。
- Service Token は API 403（`Access: Service Tokens Write` 不足）で未作成。ST verify はスキップ。

---

## 今まで行ったこと

### MCP

Cursor Cloudflare plugin（docs / bindings / builds / observability）は実呼び出し成功。
`.cursor/mcp.json` は Code Mode 無しの空 plugin 方針。`bun run mcp:cloudflare`。

### compare / inference Workers

compare と inference は本番デプロイ済み。inference `CORS_ORIGIN` は compare origin。`workers_dev: false`。

本番 compare UI はブラウザ簡潔込み（`page.tsx` は pipeline + `warmupBrowserAzookey`）。architecture UI / `globals.css` / `VibratoModeSelector` WIP はデプロイ・commit に含めていない。

wasm/dict は Worker 成果物がソース。compare `public/azookey/` は **ビルド時コピー + gitignore**（10MB を git に複製しない）。`copy:azookey-assets` → Next export。

inference proxy（`2f6b234`）: client `Authorization` を剥がし、`AZOOKEY_API_TOKEN` があれば Bearer 注入。`worker.ts` / `inference-proxy.ts` はこの担当では未編集。`wrangler.jsonc` の `secrets.required: [AZOOKEY_API_TOKEN]` は token 未設定だと deploy が止まるため外した（injection コードは残置）。

### Access / IdP / Managed OAuth

`bun run access:setup` 成功（exit 0）。token の Access 書き込み 403 は解消済み。

- OTP IdP: `onetimepin`（作成または既存を再利用）
- Google IdP: env 無しのためスキップ
- compare app `azookey-compare`: self_hosted、public destination、Managed OAuth on、allow `kaoru@teadea.net` + `@teadea.net`、allowed IdP 1（OTP）
- inference app `kotoba-beacon-inference`: self_hosted、worker destination、Managed OAuth on、deny everyone

Allow は everyone / login_method-only OTP ではない。

### JWT

compare Worker secrets に `POLICY_AUD` と `TEAM_DOMAIN` を設定し、JWT ゲート付き UI をデプロイ済み。`POLICY_AUD` は外さない。
未認証で Access エッジが 302/401 するため、ブラウザ未ログインでは Worker JWT まで到達しない（防御層）。
OTP 待ち・人手 QA はしない。Access JWT 付きブラウザ検証は cookie が無いためスキップ。ST 無しなので本番 ST verify もスキップ。

### 検証

- compare `/` HTML（`Accept: text/html`、リダイレクト非追従）→ **302** Access login
- compare `/` および `/v1/azookey`（API / 非 HTML）→ **401** + `WWW-Authenticate: Bearer`（Managed OAuth）
- inference 直 `/` および `/v1/azookey` → **404**（workers.dev 無効、error 1042）
- 未認証 401/302 は **合格**。200 を期待しない。`POLICY_AUD` は外さない。
- 認証後 UI / health / WS はブラウザログインが必要。推測で突破しない。OTP を人に頼って止めない。
- `CF_ACCESS_*` / `AZOOKEY_API_TOKEN` は `.env` に無い。**ST 付き health / 本番 ST verify はスキップ**。
- ローカル portable ABI（compare `browser-azookey`、worker-server の実 `.wasm` + gunzip `system.azkdict.gz`）:
  - `きょうはいいてんき` → `今日はいい天気`
  - `あしたのてんきははれ` → `明日の天気は晴れ`
  - dict sha256 `84f605a5c76e09480ef1a0a02d91982fb8c9426a8a7a18fb64d9f27210641b22`
  - WS 未使用: `conversion-pipeline` の `browser-vibrato` は `usedWebSocket: false`、`connectWorker`/`convertWithWorker` 未呼び出し。Zenzai は明示エラー（Worker へサイレントフォールバックしない）。
  - compare `public/azookey/` は gitignore。ソースは worker-server。`node scripts/verify-generated-assets.mjs` でコピー一致 + ignored を確認。
  - 確認コマンド: `node scripts/verify-azookey-wasm-parity.mjs` / compare `bun run test:coverage`

### 残リスク

- `*.workers.dev` cookie スコープ。将来は自前ドメイン推奨。
- Google ログインは env が無いので使えない。OTP のみ。
- inference の worker-destination Access は公開 URL が無い間は実トラフィックに乗らない。`workers.dev` を戻さない。

---

## ユーザー次アクション

1. ブラウザで `https://azookey-compare.kaoru.workers.dev` を開き、Access OTP で `kaoru@teadea.net`（または `@teadea.net`）としてログインする。
2. 認証後 UI、`/v1/azookey` health、`wss://azookey-compare.kaoru.workers.dev/ws/azookey` を確認する。
3. Google も使いたい場合は `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` を `.env` に入れて `bun run access:setup` を再実行する。invent しない。

---

## 触らない WIP（作業ツリーに残っている）

`apps/desktop/**`、`packages/azookey-rust/examples/probe_*.rs`、`packages/azookey-rust/src/kana_kanji/viterbi.rs`、compare architecture UI（`ArchitectureAssetTable` / `ComparisonPathDiagram` / `architecture-*.ts`）、`globals.css` / `VibratoModeSelector` / `web-speech` caption WIP。**混ぜて commit しない。**
ブラウザ簡潔の `page.tsx` pipeline 配線は本 feature に含む。

---

## 環境変数（gitignored `.env`）

存在する想定（値は書かない）:

- `CLOUDFLARE_API_TOKEN`（または `CLOUDFLARE_DEBUG_TOKEN`）
- `R2_ACCOUNT_ID`（Personal account と同じ id。`CLOUDFLARE_ACCOUNT_ID` は dotenv に無いので deploy 時に export）

任意:

- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`（無ければ Google IdP スキップ）

compare Worker secrets（ダッシュボードまたは wrangler。git に書かない）:

- `POLICY_AUD`
- `TEAM_DOMAIN`
- （任意・未設定）`AZOOKEY_API_TOKEN` — inference proxy Bearer。invent しない。

Wrangler: `CLOUDFLARE_ACCOUNT_ID` を使う。`account_id` は `wrangler.jsonc` に書かない。

---

## 参考リンク

- [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
- [One-time PIN IdP](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)
- [workers.dev Access](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/#manage-access-to-workers-dev)
- [Validate Access JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#cloudflare-workers-example)
- ランブック: `docs/cloudflare-worker-deployment.md`
