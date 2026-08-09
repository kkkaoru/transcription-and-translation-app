# Cloudflare デプロイ作業引き継ぎ

最終更新: 2026-08-10。ブランチは `main`。
Workers はデプロイ済み。**compare に Access（OTP + Managed OAuth）を適用済み。**

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

compare Worker version（JWT ゲート込み）: `e5d8b161-4e15-4012-9e33-434d649b9882`。

---

## 決めたアーキテクチャ

```
Browser
  → Access (OTP + Managed OAuth, teadea allow)
  → https://azookey-compare.kaoru.workers.dev
       ├ Access JWT gate（POLICY_AUD + TEAM_DOMAIN secrets）
       ├ static Next export (`out/` + ASSETS)
       └ /ws/azookey, /v1/azookey
            → service binding INFERENCE
            → kotoba-beacon-inference（workers.dev 無し。Worker destination Access + deny everyone）
```

- compare Access app は **public destination**（hostname）。Worker destination は WebSocket upgrade を 403 にするため使わない。
- inference Access app は **worker destination** + deny everyone + Managed OAuth。公開 hostname は閉じたまま。
- Google IdP は env に `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` が無いので **未作成・スキップ**。
- compare Worker secrets: `POLICY_AUD`, `TEAM_DOMAIN`（値は invent しない・print しない）。

---

## 今まで行ったこと

### MCP

Cursor Cloudflare plugin（docs / bindings / builds / observability）は実呼び出し成功。
`.cursor/mcp.json` は Code Mode 無しの空 plugin 方針。`bun run mcp:cloudflare`。

### compare / inference Workers

compare と inference は本番デプロイ済み。inference `CORS_ORIGIN` は compare origin。`workers_dev: false`。

本番 compare UI は HEAD（architecture / `page.tsx` WIP はデプロイに含めていない）。

### Access / IdP / Managed OAuth

`bun run access:setup` 成功（exit 0）。token の Access 書き込み 403 は解消済み。

- OTP IdP: `onetimepin`（作成または既存を再利用）
- Google IdP: env 無しのためスキップ
- compare app `azookey-compare`: self_hosted、public destination、Managed OAuth on、allow `kaoru@teadea.net` + `@teadea.net`、allowed IdP 1（OTP）
- inference app `kotoba-beacon-inference`: self_hosted、worker destination、Managed OAuth on、deny everyone

Allow は everyone / login_method-only OTP ではない。

### JWT

compare Worker secrets に `POLICY_AUD` と `TEAM_DOMAIN` を設定し、JWT ゲート付き HEAD UI をデプロイ済み。
未認証で Access エッジが 302/401 するため、ブラウザ未ログインでは Worker JWT まで到達しない（防御層）。

### 検証

- compare `/` HTML（`Accept: text/html`、リダイレクト非追従）→ **302** Access login
- compare `/` および `/v1/azookey`（API / 非 HTML）→ **401** + `WWW-Authenticate: Bearer`（Managed OAuth）
- inference 直 `/v1/azookey` → **404**（workers.dev 無効、error 1042）
- 未認証 401/302 は **合格**。200 を期待しない。`POLICY_AUD` は外さない。
- 認証後 UI / health / WS はブラウザログインが必要。推測で突破しない。
- `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` は `.env` に無いため **ST 付き health はスキップ**。
- ローカル portable ABI（Node `WebAssembly`、worker-server の実 `.wasm` + `system.azkdict.gz`）:
  - `きょうはいいてんき` → `今日はいい天気`
  - dict sha256 `84f605a5c76e09480ef1a0a02d91982fb8c9426a8a7a18fb64d9f27210641b22`
  - compare へ辞書/WASM を複製していない。inference は同じ成果物、compare は `INFERENCE` binding。
  - 確認コマンド: `node scripts/verify-azookey-wasm-parity.mjs` / `node --test scripts/verify-azookey-wasm-parity.test.mjs`

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

`apps/desktop/**`、`packages/azookey-rust/examples/probe_*.rs`、`packages/azookey-rust/src/kana_kanji/viterbi.rs`、compare architecture UI、`page.tsx` / `globals.css` / `VibratoModeSelector` などの未コミット差分。**混ぜて commit しない。**

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

Wrangler: `CLOUDFLARE_ACCOUNT_ID` を使う。`account_id` は `wrangler.jsonc` に書かない。

---

## 参考リンク

- [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
- [One-time PIN IdP](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)
- [workers.dev Access](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/#manage-access-to-workers-dev)
- [Validate Access JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#cloudflare-workers-example)
- ランブック: `docs/cloudflare-worker-deployment.md`
