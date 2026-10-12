# Web版(リモート HTTP MCP / スマホ Claude アプリ向け)

Claude Desktop / Code は stdio でローカル起動しますが、**スマホの Claude アプリ**は
ローカルプロセスを起動できず、**公開 HTTPS に常駐するリモート MCP サーバー
(カスタムコネクタ)＋ OAuth** にしか接続できません。そのための HTTP エントリポイント
`dist/http.js` を用意しています(stdio 版 `dist/index.js` はそのまま併存)。

- トランスポート: MCP Streamable HTTP(`/mcp` に POST/GET/DELETE)
- 認可: 外部 IdP(Auth0 等)へ委譲する OAuth。`/.well-known/oauth-*` メタデータと
  authorize/token/register の proxy を自動提供し、`/mcp` は Bearer トークンで保護
- **このフェーズでは OAuth は「接続の入口」を守るだけ**。認証ユーザー単位の FHIR
  アクセス制御(SMART on FHIR `user/*`/`patient/*` 相当)は本番データ移行時に対応予定。
  FHIR への接続は従来通り固定の SMART Backend Services クレデンシャルを使います
  (デモ・評価データ前提)。

## 起動

```bash
npm run build
PUBLIC_URL=https://your-host \
OAUTH_ISSUER_URL=https://YOUR_TENANT.auth0.com/ \
OAUTH_AUTHORIZATION_URL=https://YOUR_TENANT.auth0.com/authorize \
OAUTH_TOKEN_URL=https://YOUR_TENANT.auth0.com/oauth/token \
OAUTH_JWKS_URL=https://YOUR_TENANT.auth0.com/.well-known/jwks.json \
OAUTH_AUDIENCE=https://your-host/api \
FHIR_BASE_URL=http://localhost:3000 \
node dist/http.js
```

docker compose で常駐起動する場合(`.env` に上記を書いておく):

```bash
docker compose up fhir-mcp-http    # http://localhost:8080/mcp で待受
```

環境変数はローカルでは `.env`(サンプル: [.env.example](../.env.example))にまとめ、
Node 20+ の `--env-file` で読み込めます:

```bash
npm run build && node --env-file=.env dist/http.js
```

## 外部 IdP(Auth0)の設定

詳細手順は **[auth0-setup.md](./auth0-setup.md)** を参照。要点:

1. API を作成し Identifier を `OAUTH_AUDIENCE` に設定。
2. **テナントの Default Audience をその Identifier に設定**(これをしないと Auth0 が
   JWT ではなく opaque トークンを発行し検証に失敗する — MCP × Auth0 の典型的な落とし穴)。
3. **Dynamic Client Registration を有効化**し、ログイン接続を domain level に昇格
   (Claude アプリがクライアント自己登録するため)。`OAUTH_REGISTRATION_URL` も設定。
4. `.well-known/openid-configuration` の値を `OAUTH_ISSUER_URL` 等に写す。
   IdP は Google / Cognito 等にも差し替え可能。

スマホの前に、M2M トークンで `/mcp` の Bearer 検証が通ることを確認できます
(手順は上記ドキュメント参照)。

## Cloud Run へのデプロイ(想定)

```bash
gcloud run deploy fhir-mcp-server \
  --source . --command node,dist/http.js \
  --set-env-vars PUBLIC_URL=https://SERVICE_URL,OAUTH_ISSUER_URL=...,OAUTH_AUDIENCE=...,FHIR_BASE_URL=...
```

`PORT` は Cloud Run が注入します(`HTTP_PORT` 未設定時のフォールバックとして利用)。
scale-to-zero でデモのコストを最小化できます。

## Render へのデプロイ(Blueprint / Docker)

`render.yaml`(Blueprint)を同梱しています。既存 Dockerfile を使い、起動コマンドを
http 版に上書きする構成です。

1. リポジトリを Render に接続し、**Blueprint** から `render.yaml` を読み込む。
2. `sync: false` の環境変数(`OAUTH_*` / `FHIR_*` / `PUBLIC_URL`)を Render ダッシュボードで設定。
3. 初回デプロイで `https://<service>.onrender.com` が発行されるので、それを `PUBLIC_URL`
   (メタデータ用)に設定して再デプロイ。IdP 側の Allowed Callback にもこの URL を登録。
4. スマホ Claude アプリのカスタムコネクタに `https://<service>.onrender.com/mcp` を登録。

注意点(Free プラン):

- **15分無アクセスでスリープ**し、次アクセスでコールドスタート(数十秒)。初回接続が
  遅延/タイムアウトすることがある。安定させたい場合は `render.yaml` の `plan` を
  `starter` に変更(常時起動)。
- セッションはメモリ保持のため、インスタンス再起動で切断される(低トラフィックのデモは問題なし)。
- `PORT` は Render が注入(`HTTP_PORT` 未設定時のフォールバックで対応済み)。

## スマホ Claude アプリへの登録

Claude アプリの「カスタムコネクタ」に `PUBLIC_URL`(= `https://SERVICE_URL/mcp`)を登録し、
OAuth ログインを済ませると、`get_capabilities` / `search_fhir` 等が実機で使えます。
