# 外部 IdP セットアップ(Auth0)

Web版(リモート HTTP MCP)の OAuth を Auth0 に委譲するための手順です。このサーバーは
**Resource Server** として振る舞い、authorize/token/register は Auth0 に proxy します。
アクセストークンの検証は、標準 OIDC の **opaque トークンを `/userinfo` で検証**します
(M2M の JWT は JWKS でも検証。`src/auth.ts`)。

> スコープ注記: この段階の OAuth は「MCP サーバーへ接続できる人を絞る入口」まで。
> 認証ユーザー単位の FHIR アクセス制御は本番データ移行時の次フェーズ。

---

## 前提の落とし穴(先に把握しておく)

MCP × Auth0 で必ず踏む2点。手順の中で対処します。

1. **third-party(DCR)クライアントはカスタム API にアクセスできない**
   Claude アプリは DCR で自己登録し、Auth0 ではそのクライアントが **third-party** 扱いになります。
   Auth0 は third-party クライアントに**カスタム API(Resource Server)向けのトークン発行を拒否**し、
   authorize が `Client ... is not authorized to access resource server ...` で失敗します。
   さらに **テナントに Default Audience を設定すると、全 authorize 要求に強制的にその API の
   audience が付く**ため、この拒否が常に発生します。
   → 対処: **Default Audience は設定しない(設定済みなら解除)**。トークンは opaque になり、
   本サーバーは `/userinfo` で検証する。カスタム API 向け JWT は使わない。
   (M2M `client_credentials` は明示 audience を渡すので従来どおり JWT が出る = 検証ツール用)

2. **Dynamic Client Registration(DCR)の有効化と domain connection**
   Claude アプリはクライアントを自己登録(DCR)します。Auth0 で DCR を有効化すると、
   登録されるアプリは **third-party** 扱いになり、**domain level に昇格した接続(connection)**
   でしかログインできません。
   → 対処: DCR を有効化し、使うログイン接続(DB or ソーシャル)を domain level に昇格する。

---

## 手順

### 1. API を作成(= audience / Resource Server)

Auth0 ダッシュボード → **Applications → APIs → Create API**

| 項目 | 値 |
|---|---|
| Name | `fhir-mcp-server` |
| Identifier | `https://fhir-mcp-server/api` (これが `OAUTH_AUDIENCE`) |
| Signing Algorithm | **RS256** |

> Identifier は URL 形式の任意の識別子で、実在エンドポイントである必要はない。
> **作成後に変更できず、トークンの `aud` になる**ため、ホスティング先(Render 等)の
> URL には紐づけず、上記のような安定した論理 URI を使う。`.env` の `OAUTH_AUDIENCE`
> とこの値を**完全一致**(末尾スラッシュ含む)させること。

### 2. Default Audience は設定しない(落とし穴1の対処)

**Settings(Tenant Settings) → General → API Authorization Settings → Default Audience**
は **空のまま**にする(既に設定していれば**削除して保存**)。

これにより interactive フロー(DCR/スマホ)のトークンは opaque になり、third-party
クライアントでも authorize が通る。本サーバーは `/userinfo` でそのトークンを検証する。

> 手順1の API 自体は残しておいてよい(M2M 検証で audience として使う)。ただし
> **テナント全体の Default Audience にはしない**のがポイント。

### 3. DCR を有効化(落とし穴2の対処)

1. **Settings → Advanced → 「OIDC Dynamic Application Registration」** を ON。
2. ログインに使う接続を domain level に昇格:
   - DB 接続を使う場合: **Authentication → Database → (接続) → Applications** ではなく、
     Management API で `is_domain_connection: true` にする(下記)。ソーシャル(Google 等)も同様。
   - Management API 例(Auth0 の Explorer か curl):
     ```
     PATCH /api/v2/connections/{CONNECTION_ID}
     { "is_domain_connection": true }
     ```
3. サードパーティアプリに同意画面をスキップさせたい場合は、テナントで
   「Allow Skipping User Consent」等を検討(任意)。

### 4. エンドポイント値を取得

`https://YOUR_TENANT.us.auth0.com/.well-known/openid-configuration` を開き、以下を `.env` に写す:

| .env 変数 | openid-configuration のキー | 例 |
|---|---|---|
| `OAUTH_ISSUER_URL` | `issuer` | `https://YOUR_TENANT.us.auth0.com/`(末尾スラッシュ込み) |
| `OAUTH_AUTHORIZATION_URL` | `authorization_endpoint` | `.../authorize` |
| `OAUTH_TOKEN_URL` | `token_endpoint` | `.../oauth/token` |
| `OAUTH_JWKS_URL` | `jwks_uri` | `.../.well-known/jwks.json` |
| `OAUTH_REGISTRATION_URL` | `registration_endpoint` | `.../oidc/register` |
| `OAUTH_AUDIENCE` | (手順1の Identifier) | `https://YOUR-SERVICE.onrender.com/api` |

> `OAUTH_ISSUER_URL` は Auth0 の issuer と**完全一致**が必要(末尾スラッシュを消さないこと)。
> 本サーバーの検証(`src/auth.ts`)は `iss`/`aud`/`exp` をチェックします。

---

## 検証(スマホを使う前に、サーバー+Auth0 の JWT 連携を確認)

Claude アプリを介さず、Machine-to-Machine トークンで `/mcp` の Bearer 検証が通ることを先に確認します。

1. **Applications → APIs → fhir-mcp-server → Machine to Machine Applications** で、
   テスト用 M2M アプリを作成(または Applications で M2M アプリを作り、この API を authorize)。
2. client_credentials で JWT を取得(`audience` に API Identifier を渡す):
   ```bash
   curl -s --request POST https://YOUR_TENANT.us.auth0.com/oauth/token \
     -H 'content-type: application/json' \
     -d '{
       "grant_type":"client_credentials",
       "client_id":"M2M_CLIENT_ID",
       "client_secret":"M2M_CLIENT_SECRET",
       "audience":"https://YOUR-SERVICE.onrender.com/api"
     }'
   ```
   返った `access_token` を https://jwt.io 等でデコードし、`aud` が API Identifier、
   `iss` が issuer と一致し、ヘッダの `alg` が RS256 であることを確認(opaque だと落とし穴1)。
3. デプロイ済みサーバーに Bearer 付きで `initialize` を投げる(**Accept 両方**が必須):
   ```bash
   TOKEN=... # 上で取得
   curl -s -i -X POST https://YOUR-SERVICE.onrender.com/mcp \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
   ```
   - **401 が返らず** MCP の初期化応答(または MCP レベルのエラー)が返れば、Bearer 検証は成功。
   - 401 なら `aud`/`iss` の不一致か opaque トークン(落とし穴1)を疑う。

---

## スマホ Claude アプリへの登録

1. Render 等にデプロイし、発行 URL を `PUBLIC_URL` に設定して再デプロイ。
2. Claude アプリの「カスタムコネクタ」に `https://YOUR-SERVICE.onrender.com/mcp` を登録。
3. OAuth ログイン(Auth0 の画面)を済ませると、`get_capabilities` / `search_fhir` 等が使えます。

うまくいかない場合の切り分け:

- 接続時に 401 が出てログイン画面に飛ばない → `/.well-known/oauth-protected-resource/mcp`
  と `WWW-Authenticate` ヘッダが正しく出ているか(本サーバー側は確認済み)。
- ログインは出るがトークンで弾かれる → 落とし穴1(Default Audience 未設定)。
- クライアント登録で失敗 → 落とし穴2(DCR 無効 or domain connection 未昇格)、
  `OAUTH_REGISTRATION_URL` 未設定。
