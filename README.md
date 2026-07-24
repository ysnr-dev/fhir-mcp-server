# fhir-mcp-server

FHIR R4 サーバー(JP-Core 準拠の fhir-server や HAPI FHIR 等)に接続する MCP(Model Context Protocol)サーバーです。Claude Desktop / Claude Code などの MCP クライアントから、FHIR データを自然言語で検索・参照・(オプトインで)書き込みできます。

- fhir-server とはリポジトリ分離(接点は HTTP + Bearer トークンのみ)
- SMART Backend Services(OAuth2 `client_credentials` + `system/*` スコープ)のクライアントとして動作
- `FHIR_BASE_URL` とクレデンシャルの差し替えで任意の FHIR R4 サーバーに接続可能

## セットアップ

Node.js 20+ が必要です。

```bash
npm install
npm run build
```

## Docker / docker compose で動かす

Node.js をホストに入れずに動かす場合は Docker イメージを使います。MCP の stdio サーバーなので常駐(`up`)は不要で、クライアントが必要なときに `docker compose run` で起動します。

```bash
docker compose build
```

動作確認(手動で JSON-RPC を流す代わりに、後述のクライアント登録をしてもよい):

```bash
docker compose run --rm -T fhir-mcp
```

- 既定の接続先は `http://host.docker.internal:3000`(= ホストの `localhost:3000`)。fhir-server をホストで直接動かしていても、docker compose(ポート 3000 公開)で動かしていてもそのままつながります
- 接続先やクレデンシャルは環境変数で上書きできます: `FHIR_BASE_URL=... FHIR_CLIENT_ID=... docker compose run --rm -T fhir-mcp`
- fhir-server(Rails)側は HostAuthorization で `host.docker.internal` を許可している必要があります(development.rb の `config.hosts << "host.docker.internal"`)

Docker 経由で Claude Code に登録する場合:

```bash
claude mcp add fhir -- docker compose -f /path/to/fhir-mcp-server/compose.yaml run --rm -T fhir-mcp
```

Claude Desktop の場合:

```json
{
  "mcpServers": {
    "fhir": {
      "command": "docker",
      "args": [
        "compose", "-f", "/path/to/fhir-mcp-server/compose.yaml",
        "run", "--rm", "-T", "fhir-mcp"
      ]
    }
  }
}
```

## Claude クライアントへの接続

### Claude Code

```bash
claude mcp add fhir -- node /path/to/fhir-mcp-server/dist/index.js
```

環境変数を渡す場合:

```bash
claude mcp add fhir \
  -e FHIR_BASE_URL=http://localhost:3000 \
  -e FHIR_CLIENT_ID=... \
  -e FHIR_CLIENT_SECRET=... \
  -- node /path/to/fhir-mcp-server/dist/index.js
```

### Claude Desktop(claude_desktop_config.json)

```json
{
  "mcpServers": {
    "fhir": {
      "command": "node",
      "args": ["/path/to/fhir-mcp-server/dist/index.js"],
      "env": {
        "FHIR_BASE_URL": "http://localhost:3000",
        "FHIR_CLIENT_ID": "...",
        "FHIR_CLIENT_SECRET": "..."
      }
    }
  }
}
```

## Web版(リモート HTTP MCP / スマホ Claude アプリ向け)

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

### 起動

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

### 外部 IdP(例: Auth0)の設定

1. API を1つ作成し、その Identifier を `OAUTH_AUDIENCE` に設定。
2. Dynamic Client Registration を有効化(Claude アプリがクライアント登録を行う)。
   有効化した場合は `OAUTH_REGISTRATION_URL`(例 `https://YOUR_TENANT.auth0.com/oidc/register`)も設定。
3. `OAUTH_ISSUER_URL`/`OAUTH_AUTHORIZATION_URL`/`OAUTH_TOKEN_URL`/`OAUTH_JWKS_URL` を
   テナントの値に合わせる。IdP は Google / Cognito 等にも差し替え可能。

### Cloud Run へのデプロイ(想定)

```bash
gcloud run deploy fhir-mcp-server \
  --source . --command node,dist/http.js \
  --set-env-vars PUBLIC_URL=https://SERVICE_URL,OAUTH_ISSUER_URL=...,OAUTH_AUDIENCE=...,FHIR_BASE_URL=...
```

`PORT` は Cloud Run が注入します(`HTTP_PORT` 未設定時のフォールバックとして利用)。
scale-to-zero でデモのコストを最小化できます。

### Render へのデプロイ(Blueprint / Docker)

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

### スマホ Claude アプリへの登録

Claude アプリの「カスタムコネクタ」に `PUBLIC_URL`(= `https://SERVICE_URL/mcp`)を登録し、
OAuth ログインを済ませると、`get_capabilities` / `search_fhir` 等が実機で使えます。

## 設定(環境変数)

| 変数 | 既定 | 説明 |
|---|---|---|
| `FHIR_BASE_URL` | `http://localhost:3000` | 接続先 FHIR サーバー |
| `FHIR_CLIENT_ID` / `FHIR_CLIENT_SECRET` | なし | SMART Backend Services のクレデンシャル。**両方未設定なら無認証モード**(Authorization ヘッダーを送らない。fhir-server の `FHIR_AUTH_ENABLED=false` 環境向け) |
| `FHIR_MCP_ALLOW_WRITES` | `false` | `true` のときだけ書き込みツール(create/update/patch)を登録 |
| `FHIR_MCP_MAX_COUNT` | `50` | 検索 `_count` の上限 |

### Web版(HTTP)の追加設定

| 変数 | 既定 | 説明 |
|---|---|---|
| `HTTP_PORT` / `PORT` | `8080` | HTTP 待受ポート(`PORT` は Cloud Run 用フォールバック) |
| `PUBLIC_URL` | (必須) | このサーバーの公開 URL。OAuth メタデータ・リソース識別子に使用 |
| `OAUTH_ISSUER_URL` | (必須) | 外部 IdP の issuer |
| `OAUTH_AUTHORIZATION_URL` | (必須) | IdP の authorization エンドポイント |
| `OAUTH_TOKEN_URL` | (必須) | IdP の token エンドポイント |
| `OAUTH_JWKS_URL` | (必須) | アクセストークン検証用の JWKS |
| `OAUTH_AUDIENCE` | (必須) | アクセストークンに期待する `aud` |
| `OAUTH_REGISTRATION_URL` | なし | IdP の Dynamic Client Registration エンドポイント(任意) |

### 認証(SMART Backend Services)

`FHIR_CLIENT_ID` / `FHIR_CLIENT_SECRET` を設定すると、`POST {FHIR_BASE_URL}/oauth/token` に `grant_type=client_credentials` でアクセストークンを取得します。

- トークンは `expires_in` の 90% 経過で先回り再取得
- API が 401 を返した場合は 1 回だけトークンを再取得してリトライ
- トークン・シークレットはログに出力しません

fhir-server 側のクライアント登録例:

```bash
bin/rails "fhir:register_client[fhir-mcp-server,system/*.read]"
# 書き込みも許可する場合は system/*.write スコープを付与
```

## ツール一覧

### 参照系(常時登録)

| ツール | 対応エンドポイント | 説明 |
|---|---|---|
| `get_capabilities` | `GET /metadata` | 対応リソース・検索パラメータ・オペレーションの要約。使い方の自己発見の起点 |
| `search_fhir` | `GET /{type}?...` | 検索。チェーン検索・`_has`・`_include` 等は `params` でそのまま透過 |
| `read_fhir` | `GET /{type}/{id}` | 単一リソース取得 |
| `patient_everything` | `GET /Patient/{id}/$everything` | 患者コンパートメント一括取得(`_type`/`_since` 対応) |
| `get_history` | `GET [/{type}[/{id}]]/_history` | インスタンス/タイプ/システムレベルの履歴 |
| `validate_fhir` | `POST /{type}/$validate` | 保存せずにリソースを検証 |

### 書き込み系(`FHIR_MCP_ALLOW_WRITES=true` のときのみ登録)

| ツール | 対応エンドポイント | 説明 |
|---|---|---|
| `create_fhir` | `POST /{type}` | 作成(`If-None-Exist` による条件付き作成対応) |
| `update_fhir` | `PUT /{type}/{id}` | 全置換更新(`If-Match` による楽観ロック対応) |
| `patch_fhir` | `PATCH /{type}/{id}` | JSON Patch(RFC 6902)による部分更新 |

delete はツールとして提供しません(AI からの破壊的操作は初期スコープ外)。

### トークン消費を抑えるコツ

検索結果の Bundle はそのまま返さず、`{ total, returned, hasNextPage, resources }` に整形して返します。それでも大きい場合は件数を切り詰め、絞り込みのガイダンスを付けます。以下を活用してください:

- `_elements=id,name,birthDate` — 必要なフィールドだけ取得
- `_summary=true` — サマリー要素のみ取得
- `_count` — ページサイズを絞る(既定 20)
- `patient_everything` では `types` / `since` で範囲を限定

## 開発

```bash
npm run dev        # tsx で直接実行
npm test           # unit テスト(fetch モック)
npm run lint       # biome
npm run build      # tsc → dist/
```

### integration テスト

実サーバー相手の e2e は `FHIR_INTEGRATION_BASE_URL` を設定したときだけ実行されます:

```bash
# fhir-server を docker compose 等で起動しておく
FHIR_INTEGRATION_BASE_URL=http://localhost:3000 npm test

# 認証ありモードを試す場合
FHIR_INTEGRATION_BASE_URL=http://localhost:3000 \
FHIR_INTEGRATION_CLIENT_ID=... \
FHIR_INTEGRATION_CLIENT_SECRET=... \
npm test
```

## アーキテクチャ

```
MCP クライアント(Claude 等)
        │ stdio
        ▼
fhir-mcp-server
  ├── src/index.ts          エントリポイント(stdio transport)
  ├── src/http.ts           エントリポイント(Streamable HTTP transport + OAuth)
  ├── src/auth.ts           外部 IdP へ委譲する OAuth プロバイダ・JWT 検証
  ├── src/server.ts         McpServer 構築・ツール登録(トランスポート非依存)
  ├── src/config.ts         環境変数の読み込み・検証
  ├── src/fhir-client.ts    FHIR REST 呼び出し(fhir+json、OperationOutcome 整形、401 リトライ)
  ├── src/token-manager.ts  SMART トークン管理(先回り更新)
  ├── src/format.ts         Bundle / CapabilityStatement の要約整形
  └── src/tools/*.ts        ツール実装(薄い層)
        │ HTTP(S) + Authorization: Bearer
        ▼
FHIR R4 サーバー(fhir-server / HAPI など)
```

設計の背景・rationale は [docs/DESIGN.md](./docs/DESIGN.md) を参照してください。
