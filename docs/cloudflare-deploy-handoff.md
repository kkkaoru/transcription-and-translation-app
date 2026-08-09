# Cloudflare デプロイ作業引き継ぎ

最終更新: 2026-08-10。ブランチは `main`。
Workers はデプロイ済み。Access（OTP / Managed OAuth）は **API 書き込み 403 で未完了**。

**秘密情報（API トークン、OAuth secret、`.env` の値）は書かない・コミットしない・ログに出さない。**

---

## 本番 URL

- compare: `https://azookey-compare.kaoru.workers.dev`
  WS: `wss://azookey-compare.kaoru.workers.dev/ws/azookey`
- inference: `kotoba-beacon-inference`
  公開 `workers.dev` は **無効**（`workers_dev: false`、直 URL は 404）。
  変換は compare の service binding `INFERENCE` のみ。

アカウント（非秘密）: Personal `78109ec18c7c85b194b19fb32e3bb149` / `kaoru@teadea.net` / `*.kaoru.workers.dev`。

---

## 決めたアーキテクチャ

```
Browser
  → Access (OTP + Google + Managed OAuth)   ← 未適用（権限不足）
  → https://azookey-compare.kaoru.workers.dev
       ├ static Next export (`out/` + ASSETS)
       └ /ws/azookey, /v1/azookey
            → service binding INFERENCE
            → kotoba-beacon-inference（Access / workers.dev を経由しない）
```

- compare は `output: 'export'` + 薄い Worker（`apps/azookey-compare/src/worker.ts`）。
- inference 公開 hostname は閉じた。binding 経路は Access をバイパスする（JWT 検証は未実装。残リスク）。
- 本番 WS は compare 同源。`build:worker` が `NEXT_PUBLIC_AZOO_KEY_WORKER_WS_URL` を焼く。dirty な `page.tsx` WIP は触っていない。
- inference `CORS_ORIGIN` は compare origin にピン止め。CORS は認証ではない。
- Google IdP は env に `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` が無いので **未作成・スキップ**。

---

## 今まで行ったこと

### MCP

Cursor Cloudflare plugin（docs / bindings / builds / observability）は **このセッションで実呼び出し成功**（`workers_list` と docs 検索）。
`.cursor/mcp.json` は Code Mode 無しの空 plugin 方針。`bun run mcp:cloudflare`。

### compare Workers 化 + デプロイ

デプロイ済み（version `e9dbbebe-e46f-4704-b20b-6a36a49ba803`）。
未認証で UI / `/v1/azookey` は **200**（Access 未適用）。
`/v1/azookey` health: `auth.configured=true`, `websocketPath=/ws/azookey`。

`compatibility_date` は `2026-08-09`（UTC。`2026-08-10` は Cloudflare が future date として拒否）。

本番ビルドは HEAD の compare UI を使用。作業ツリーの architecture UI / `page.tsx` WIP はデプロイに含めていない。

### inference CORS + 公開 URL 閉鎖 + デプロイ

デプロイ済み（version `ada3874c-0ea0-4862-8b10-1ecff6aa8938`）。
`CORS_ORIGIN=https://azookey-compare.kaoru.workers.dev`。
`workers_dev: false`。直 URL は 404。compare 経由の health は 200。

`bun run worker:deploy` の `build:wasm` は dirty な `packages/azookey-rust` WIP で落ちる。今回は既存検証済み wasm のまま `wrangler deploy` した。クリーンツリーでは通常の `bun run worker:deploy` でよい。

### Access / IdP / Managed OAuth

スクリプト: `bun run access:setup`（`scripts/setup-cloudflare-access.mjs`）。
OTP +（env があれば Google）+ self-hosted worker destination + `oauth_configuration.enabled` + teadea allow / inference deny。

**ブロッカー:** 現行 `CLOUDFLARE_API_TOKEN` / debug token / Wrangler OAuth はすべて:

- `GET access/apps` → 200（0 件）
- `POST access/apps` → 403（code 1010）
- `GET/POST access/identity_providers` → 403
- `GET access/organizations` → 403

必要な Account 権限（Edit/Write）:

- `Access: Organizations, Identity Providers, and Groups`
- `Access: Apps and Policies`

ダッシュボード one-click Access もブラウザ未ログインで不可。
Google IdP は env 無しのためスキップ（invent しない）。

権限を足したら:

```sh
export CLOUDFLARE_ACCOUNT_ID=78109ec18c7c85b194b19fb32e3bb149
set -a && source .env && set +a
bun run access:setup
```

Allow 対象: `kaoru@teadea.net` と `@teadea.net`。世界公開 OTP にはしない。

### 検証

- compare `/` → 200（未認証のまま。Access 後は 302/401 想定）
- compare `/v1/azookey` → 200, `auth.configured=true`
- inference 直 `/v1/azookey` → 404（workers.dev off）
- WS 変換のブラウザ実測は Access 未適用のため未実施（同源 URL はデプロイ済み）

### 残リスク

- compare は現時点で **世界公開**。Access 適用が最優先の次アクション。
- service binding は Access JWT を検証しない。Access が外れても binding は通る。
- `*.workers.dev` cookie スコープ。将来は自前ドメイン推奨。

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

Wrangler: `CLOUDFLARE_ACCOUNT_ID` を使う。`account_id` は `wrangler.jsonc` に書かない。

---

## 参考リンク

- [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
- [One-time PIN IdP](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)
- [workers.dev Access](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/#manage-access-to-workersdev)
- ランブック: `docs/cloudflare-worker-deployment.md`
