# fhir-mcp-server 設計ドキュメント

> 本ファイルは設計方針とその背景(rationale)を記録したもの。
> Phase 1〜3(参照系・SMART 認証・書き込み系)は実装済み。Phase 4 は未実装(下記「今後の検討事項」)。
> 実装手順ではなく「なぜこう作ったか」を残すことを目的とする。

## 目的

生成 AI(Claude Desktop / Claude Code / その他 MCP クライアント)から、fhir-server(JP-Core v1.2.0 準拠 FHIR R4 サーバー)のデータを安全に参照・操作できるようにする MCP サーバー。

- リポジトリは fhir-server と分離(接点は HTTP + Bearer トークンのみ)
- fhir-server 側の SMART Backend Services(OAuth2 client_credentials + `system/*` スコープ)のクライアントとして動作する
- ベース URL とクレデンシャルを差し替えれば他の FHIR サーバー(HAPI 等)にも接続できる汎用アダプタとして設計する

## 技術選定

| 項目 | 選定 | 理由 |
|---|---|---|
| 言語 | TypeScript(Node.js 20+) | MCP 公式 SDK(`@modelcontextprotocol/sdk`)が最も成熟。stdio / Streamable HTTP 両トランスポート対応 |
| スキーマ | zod | SDK 標準のツール入力スキーマ定義 |
| HTTP | Node 標準 fetch | 依存最小 |
| テスト | vitest | unit + integration |
| Lint/Format | biome | 単一ツールで完結 |

## アーキテクチャ

```
MCP クライアント(Claude 等)
        │ stdio(現状)/ Streamable HTTP(将来)
        ▼
fhir-mcp-server
  ├── server.ts        MCP サーバー本体(ツール登録)
  ├── tools/*.ts       ツール実装(薄い層)
  ├── fhir-client.ts   FHIR REST 呼び出し(fhir+json、OperationOutcome のエラー整形)
  └── token-manager.ts SMART トークン管理
        │ HTTP(S) + Authorization: Bearer
        ▼
fhir-server(REST API)
```

### TokenManager の仕様と意図

- `POST {FHIR_BASE_URL}/oauth/token` に `grant_type=client_credentials` でトークン取得
- `expires_in`(3600 秒)の 90% 経過で先回り再取得。API 呼び出しが 401 を返したら 1 回だけ再取得してリトライ
- `FHIR_CLIENT_ID` / `FHIR_CLIENT_SECRET` が未設定なら**無認証モード**(Authorization ヘッダーなし)— fhir-server の `FHIR_AUTH_ENABLED=false` 環境向け。ローカル開発を無設定で始められるようにする意図
- トークン・シークレットはログに出さない

## ツール設計

### 参照系(read-only)

| ツール | 入力 | 対応エンドポイント | 備考 |
|---|---|---|---|
| `get_capabilities` | なし | `GET /metadata` | 対応リソース・検索パラメータの一覧を要約して返す。AI が使い方を自己発見する起点 |
| `search_fhir` | `resourceType`, `params`(key-value), `count?` | `GET /{type}?...` | チェーン検索・`_has`・`_include` 等はそのまま `params` で透過。既定 `_count=20`・上限あり。`_elements`/`_summary` を活用してトークン消費を抑えることを README に明記 |
| `read_fhir` | `resourceType`, `id` | `GET /{type}/{id}` | |
| `patient_everything` | `patientId`, `types?`, `since?` | `GET /Patient/{id}/$everything` | 患者コンパートメント一括取得。`_type`/`_since` に対応 |
| `get_history` | `resourceType?`, `id?`, `count?`, `since?` | `GET /{type}/{id}/_history` ほか | インスタンス/タイプ/システムレベルを引数で切替 |
| `validate_fhir` | `resource`(JSON) | `POST /{type}/$validate` | 書き込み前の事前検証にも使える |

設計方針:

- レスポンスは Bundle をそのまま返さず、**entry の resource 配列 + total + 次ページ有無**に整形して返す(トークン効率と可読性)
- FHIR エラー(OperationOutcome)は issue の severity/code/diagnostics を人間可読なメッセージに整形し、MCP のツールエラーとして返す
- 大きすぎるレスポンスは件数を切り詰め、「`_count` や `_elements` で絞り込む」ガイダンスを付けて返す

### 書き込み系(オプトイン)

`FHIR_MCP_ALLOW_WRITES=true` のときだけツールを登録する(未設定なら存在自体しない):

| ツール | 対応エンドポイント |
|---|---|
| `create_fhir` | `POST /{type}`(`If-None-Exist` 対応) |
| `update_fhir` | `PUT /{type}/{id}`(`If-Match` 対応) |
| `patch_fhir` | `PATCH /{type}/{id}`(JSON Patch) |

- **delete はツールとして提供しない**(AI からの破壊的操作は初期スコープ外。必要になれば別フラグで検討)
- 書き込み時は `validate_fhir` での事前検証を推奨する説明文をツール description に含める
- 前提: FHIR サーバー側で `FHIR_CLIENT_ID` のクライアントに `system/*.write` が付与されていること。
  fhir-server では `.write` が create/update/patch/delete をまとめてカバーし、粒度分離は無い
- Web版では認可の粒度がフラグ1つしかない(認証済みユーザー全員が書ける)。ユーザー単位に
  絞る場合は、`src/http.ts` のセッション生成時に `extra.authInfo` の scope を見てツール登録を
  出し分ける改修が必要 → 「今後の検討事項」

## 設定(環境変数)

| 変数 | 既定 | 説明 |
|---|---|---|
| `FHIR_BASE_URL` | `http://localhost:3000` | 接続先 FHIR サーバー |
| `FHIR_CLIENT_ID` / `FHIR_CLIENT_SECRET` | なし | 未設定なら無認証モード |
| `FHIR_MCP_ALLOW_WRITES` | `false` | 書き込みツールの登録可否(FHIR 側の `system/*.write` 付与が前提) |
| `FHIR_MCP_MAX_COUNT` | `50` | search の `_count` 上限 |

## fhir-server 側に依存する前提(連携契約)

fhir-mcp-server は fhir-server の以下の機能に依存する。接続先を差し替える際はこれらの互換性を確認すること。

- SMART Backend Services: `POST /oauth/token`(client_credentials)、`system/*` スコープ、`FHIR_AUTH_ENABLED` トグル
- 検索: チェーン検索・`_has`・`_summary`/`_elements`・`_total`・ページング
- オペレーション: `Patient/$everything`・`$validate`
- ディスカバリ: `/metadata`・`/.well-known/smart-configuration`

## テスト方針

- **unit**: TokenManager(期限内キャッシュ / 先回り更新 / 401 リトライ / 無認証モード)、Bundle 整形、OperationOutcome 整形、`_count` クランプ、書き込み系(条件付き作成ヘッダー / resourceType・id の整合検証 / JSON Patch の Content-Type と `If-Match` 正規化)
- **integration**: docker compose で fhir-server を起動し、search → read → $everything → validate の一連 + 認証有効時の 401/403 経路
- **手動確認**: Claude Code / Claude Desktop から「◯◯という患者の検査結果を要約して」等の自然言語操作

## 今後の検討事項(未実装)

### Phase 4: リモート公開

- Streamable HTTP transport 化 + MCP Authorization 仕様(OAuth 2.1)対応
- fhir-server 側の追加検討事項: CORS、token introspection
