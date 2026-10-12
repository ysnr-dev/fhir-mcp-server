# セットアップと接続

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
