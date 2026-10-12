# fhir-mcp-server

FHIR R4 サーバー(JP-Core 準拠の fhir-server や HAPI FHIR 等)に接続する MCP(Model Context Protocol)サーバーです。Claude Desktop / Claude Code などの MCP クライアントから、FHIR データを自然言語で検索・参照・(オプトインで)書き込みできます。

- fhir-server とはリポジトリ分離(接点は HTTP + Bearer トークンのみ)
- SMART Backend Services(OAuth2 `client_credentials` + `system/*` スコープ)のクライアントとして動作
- `FHIR_BASE_URL` とクレデンシャルの差し替えで任意の FHIR R4 サーバーに接続可能

## クイックスタート

Node.js 20+ が必要です。

```bash
npm install
npm run build

# Claude Code に登録(認証なしの fhir-server が localhost:3000 で動いている場合)
claude mcp add fhir -e FHIR_BASE_URL=http://localhost:3000 -- node /path/to/fhir-mcp-server/dist/index.js
```

- 認証ありの FHIR サーバーには `FHIR_CLIENT_ID` / `FHIR_CLIENT_SECRET` を渡します(両方未設定なら無認証モード)。
- 書き込みツールは `FHIR_MCP_ALLOW_WRITES=true` のときだけ登録されます。
- Node.js を入れずに Docker で動かす方法と Claude Desktop の設定は [docs/setup.md](./docs/setup.md) を参照してください。

## ドキュメント

| ドキュメント | 内容 |
|---|---|
| [docs/setup.md](./docs/setup.md) | セットアップ、Docker / docker compose、Claude Code・Desktop への接続、環境変数、SMART Backend Services 認証 |
| [docs/web.md](./docs/web.md) | Web版(リモート HTTP MCP)の起動、Auth0 の要点、Cloud Run・Render へのデプロイ、スマホ Claude アプリへの登録 |
| [docs/auth0-setup.md](./docs/auth0-setup.md) | Web版の OAuth を Auth0 に委譲するための詳細手順 |
| [docs/tools.md](./docs/tools.md) | ツール一覧(参照系・書き込み系)とトークン消費を抑えるコツ |
| [docs/development.md](./docs/development.md) | 開発コマンド、integration テスト、ソース構成 |
| [docs/DESIGN.md](./docs/DESIGN.md) | 設計方針とその背景 |
