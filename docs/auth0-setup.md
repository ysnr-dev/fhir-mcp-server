# 外部 IdP セットアップ(Auth0)

Web版(リモート HTTP MCP)の OAuth を Auth0 に委譲するための手順です。このサーバーは
**Resource Server** として振る舞い、authorize/token/register を Auth0 に proxy します。

**Auth0 では DCR(動的クライアント登録)は使いません。** ダッシュボードで作成した
**固定の first-party クライアント1つ**を全 MCP クライアントに配ります(理由は落とし穴1)。
アクセストークンは JWT になり、JWKS で検証します(`src/auth.ts`)。

> スコープ注記: この段階の OAuth は「MCP サーバーへ接続できる人を絞る入口」まで。
> 認証ユーザー単位の FHIR アクセス制御は本番データ移行時の次フェーズ。

---

## 前提の落とし穴(先に把握しておく)

MCP × Auth0 で必ず踏む4点。1〜2 は手順の中で、3〜4 はサーバー側の実装で対処済みです。

1. **DCR クライアントには使える audience が存在しない(=DCR は使えない)**
   Claude アプリは DCR で自己登録し、Auth0 ではそのクライアントが **third-party** 扱いに
   なります。third-party クライアントは、要求しうる**2つの audience の両方を拒否されます**:

   | authorize の audience | Auth0 の応答 |
   |---|---|
   | 指定なし(Auth0 が `/userinfo` を暗黙適用) | `The userinfo audience is not allowed for third party clients` |
   | カスタム API(`OAUTH_AUDIENCE`) | `Client ... is not authorized to access resource server ...` |

   選べる audience が残らないため、**ログイン成功後**のトークン発行段階で必ず失敗します
   (Auth0 のログでは `stats.loginsCount: 1` が付いた失敗イベントとして見えます)。
   → 対処: **DCR を使わず、ダッシュボードで作成した first-party クライアントを固定で使う**
   (手順3)。`OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` / `OAUTH_CLIENT_REDIRECT_URIS` を
   設定すると、本サーバーの `/register` は Auth0 に転送せず**その固定クライアントを返します**
   (`src/auth.ts` の `Auth0ProxyOAuthProvider`)。

   > 副次的な効果として、接続を試すたびに Auth0 のアプリが増える問題も消えます。放置すると
   > テナントのエンティティ上限(`too_many_entities`)に達し、登録自体ができなくなります。

2. **テナントの Default Audience は設定しない**
   設定すると全 authorize 要求に強制的にその audience が付き、クライアント側で audience を
   制御できなくなります。本サーバーは authorize ごとに `audience` を明示するため不要です。

3. **`resource` パラメータ(RFC 8707)を Auth0 に転送してはいけない**
   MCP クライアントは仕様に従い `resource=<MCP サーバーの /mcp URL>` を authorize に付けます。
   Auth0 はこれを **API(Resource Server)の Identifier として解決**しようとするため、
   その識別子の API が存在しないと authorize 全体が
   `access_denied : Service not found: <URL>` で 403 になります。
   → 対処: **サーバー側で `resource` を除去し、代わりに Auth0 独自の `audience` を付ける**
   (`src/auth.ts` の `Auth0ProxyOAuthProvider` で `authorize` /
   `exchangeAuthorizationCode` / `exchangeRefreshToken` を override 済み)。

4. **`mcpAuthRouter` の `issuerUrl` に IdP を渡してはいけない**
   SDK のルーターは `issuerUrl` を protected-resource メタデータの
   `authorization_servers` としてそのまま公開します(`auth/router.ts`)。ここに Auth0 を
   指定すると、クライアントは仕様どおりそれを辿って **Auth0 のメタデータを直接取得し、
   Auth0 の authorize/token/register を直接叩きます**。本サーバーのプロキシは一切
   経由されず、落とし穴3の `resource` 除去も DCR クライアントのキャッシュも無効化されます。
   → 対処: **`issuerUrl` には本サーバーの `PUBLIC_URL` を渡す**(`src/auth.ts` の
   `buildAuthRouterOptions`)。

   厄介なのは**失敗が静かなこと**です。ディスカバリは成功し、接続も始まり、
   IdP に着いてから初めて壊れるため、サーバー側のログには何も残りません。

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

### 2. Default Audience は設定しない(落とし穴2の対処)

**Settings(Tenant Settings) → General → API Authorization Settings → Default Audience**
は **空のまま**にする(既に設定していれば**削除して保存**)。

本サーバーは authorize ごとに `audience` を明示するため、テナント既定値は不要です。

### 3. first-party クライアントを作成(落とし穴1の対処 / 最重要)

**Applications → Applications → Create Application** で
**Regular Web Application** を作成します(この経路で作れば first-party になります)。

作成後、**Settings** タブで:

| 項目 | 値 |
|---|---|
| Allowed Callback URLs | `https://claude.ai/api/mcp/auth_callback` |
| Application Type | Regular Web Application |
| Token Endpoint Authentication Method | `Post` または `Basic` |

**Advanced Settings → Grant Types** で `Authorization Code` と `Refresh Token` を有効化。

> **APIs(APIアクセス)タブでの明示的な認可は不要**です。認可コードフローでは
> **first-party であること自体**が条件で、`audience` を要求できます(実測で確認済み)。
> あのタブのトグルは client grant を作るもので、`client_credentials` を使う
> M2M アプリ向けです。third-party クライアントだと、ここを何も触らない状態で
> `Client ... is not authorized to access resource server` になります。

Client ID / Client Secret を `.env` に写します:

```
OAUTH_CLIENT_ID=<Client ID>
OAUTH_CLIENT_SECRET=<Client Secret>
OAUTH_CLIENT_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback
```

> **DCR(OIDC Dynamic Application Registration)は有効化不要**です。有効なままでも、
> 本サーバーの `/register` は Auth0 に転送せずこの固定クライアントを返すため使われません。
> 接続に使う connection は、この作成したアプリケーションで有効化されていれば十分で、
> domain level への昇格も不要です。

### 4. エンドポイント値を取得

`https://YOUR_TENANT.us.auth0.com/.well-known/openid-configuration` を開き、以下を `.env` に写す:

| .env 変数 | openid-configuration のキー | 例 |
|---|---|---|
| `OAUTH_ISSUER_URL` | `issuer` | `https://YOUR_TENANT.us.auth0.com/`(末尾スラッシュ込み) |
| `OAUTH_AUTHORIZATION_URL` | `authorization_endpoint` | `.../authorize` |
| `OAUTH_TOKEN_URL` | `token_endpoint` | `.../oauth/token` |
| `OAUTH_JWKS_URL` | `jwks_uri` | `.../.well-known/jwks.json` |
| `OAUTH_REGISTRATION_URL` | `registration_endpoint` | `.../oidc/register`(DCR 用。Auth0 では未使用) |
| `OAUTH_AUDIENCE` | (手順1の Identifier) | `https://fhir-mcp-server/api` |

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
- ログインは通るがその後に失敗する → 落とし穴1。`OAUTH_CLIENT_ID` /
  `OAUTH_CLIENT_SECRET` / `OAUTH_CLIENT_REDIRECT_URIS` が設定されているか、
  手順3で API を Authorize したかを確認。

**Auth0 の「Oops!, something went wrong」が出た場合**、そのページの
**TECHNICAL DETAILS を開くと実際の原因が書いてあります**(切り分けはここが起点)。

| TECHNICAL DETAILS の表示 | 原因 |
|---|---|
| `The userinfo audience is not allowed for third party clients` | 落とし穴1。DCR クライアントが使われている。`OAUTH_CLIENT_*` が未設定か、Auth0 側に反映されていない |
| `Client ... is not authorized to access resource server ...` | third-party クライアントで custom API の audience を要求している。DCR 由来の client_id が使われていないか確認 |
| `access_denied : Service not found: <URL>` | 落とし穴3。`resource` が Auth0 に転送されている |
| `invalid_request : Unknown client: tpc_...` | その client_id が Auth0 に無い。DCR 時代の古い client_id を Claude が保持している。**Claude のコネクタを削除して登録し直す** |

なお、自サーバーが返す `400 {"error":"invalid_client"}`(JSON)は別物で、送られた
client_id が `OAUTH_CLIENT_ID` と一致しないことを示します(Claude が DCR 時代の
古い client_id を保持している場合など)。Auth0 の HTML エラーページとは区別すること。

### Auth0 のログでプロキシのバイパスを見分ける

Auth0 ダッシュボード → **Monitoring → Logs** で該当イベントの `details.qs` を見ます。
本サーバーの `/authorize` は URL を組み立て直すため、**転送するのは
`client_id` / `response_type` / `redirect_uri` / `code_challenge` /
`code_challenge_method` / `state` / `scope` の7つだけ**です。

`qs` にそれ以外(`prompt`、`resource` 等)が入っていたら、**クライアントが
プロキシを経由せず Auth0 を直接叩いている**ということです(落とし穴4)。
`client_name` が `Claude` のように**こちらが登録していない名前**になっているのも
同じ兆候で、DCR も直接 Auth0 に対して行われています。
