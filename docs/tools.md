# ツール一覧

## 参照系(常時登録)

| ツール | 対応エンドポイント | 説明 |
|---|---|---|
| `get_capabilities` | `GET /metadata` | 対応リソース・検索パラメータ・オペレーションの要約。使い方の自己発見の起点 |
| `search_fhir` | `GET /{type}?...` | 検索。チェーン検索・`_has`・`_include` 等は `params` でそのまま透過 |
| `read_fhir` | `GET /{type}/{id}` | 単一リソース取得 |
| `patient_everything` | `GET /Patient/{id}/$everything` | 患者コンパートメント一括取得(`_type`/`_since` 対応) |
| `get_history` | `GET [/{type}[/{id}]]/_history` | インスタンス/タイプ/システムレベルの履歴 |
| `validate_fhir` | `POST /{type}/$validate` | 保存せずにリソースを検証 |

## 書き込み系(`FHIR_MCP_ALLOW_WRITES=true` のときのみ登録)

| ツール | 対応エンドポイント | 説明 |
|---|---|---|
| `create_fhir` | `POST /{type}` | 作成(`If-None-Exist` による条件付き作成対応) |
| `update_fhir` | `PUT /{type}/{id}` | 全置換更新(`If-Match` による楽観ロック対応) |
| `patch_fhir` | `PATCH /{type}/{id}` | JSON Patch(RFC 6902)による部分更新 |

delete はツールとして提供しません(AI からの破壊的操作は初期スコープ外)。

## トークン消費を抑えるコツ

検索結果の Bundle はそのまま返さず、`{ total, returned, hasNextPage, resources }` に整形して返します。それでも大きい場合は件数を切り詰め、絞り込みのガイダンスを付けます。以下を活用してください:

- `_elements=id,name,birthDate` — 必要なフィールドだけ取得
- `_summary=true` — サマリー要素のみ取得
- `_count` — ページサイズを絞る(既定 20)
- `patient_everything` では `types` / `since` で範囲を限定
