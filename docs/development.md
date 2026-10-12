# 開発とアーキテクチャ

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

設計の背景・rationale は [DESIGN.md](./DESIGN.md) を参照してください。
