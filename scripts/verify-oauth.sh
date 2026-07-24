#!/usr/bin/env bash
# Web版(HTTP MCP)の OAuth 疎通をローカルで一気通貫に検証するスクリプト。
#
#   1. .env を読み込む
#   2. node dist/http.js をバックグラウンド起動し /healthz を待つ
#   3. Auth0 の M2M(client_credentials)で JWT アクセストークンを取得
#   4. トークンの alg/iss/aud を検証(opaque や不一致を検出)
#   5. Bearer 付きで /mcp に initialize を投げ、401 でないこと(=Bearer 検証成功)を確認
#   6. サーバーを停止
#
# 事前準備:
#   - docs/auth0-setup.md に沿って Auth0 の API/Default Audience/DCR を設定
#   - Auth0 で M2M アプリを作り、対象 API を authorize
#   - .env.example をコピーして .env を作成し、OAUTH_* / OAUTH_AUDIENCE と
#     検証用の VERIFY_M2M_CLIENT_ID / VERIFY_M2M_CLIENT_SECRET を記入
#
# 使い方:  npm run build && bash scripts/verify-oauth.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "ERROR: .env が見つかりません。.env.example をコピーして値を記入してください。" >&2
  exit 1
fi

# .env を読み込む(既存のシェル環境は上書きしない範囲で)
set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${OAUTH_TOKEN_URL:?OAUTH_TOKEN_URL が .env にありません}"
: "${OAUTH_AUDIENCE:?OAUTH_AUDIENCE が .env にありません}"
: "${VERIFY_M2M_CLIENT_ID:?VERIFY_M2M_CLIENT_ID が .env にありません(検証用 M2M アプリの client_id)}"
: "${VERIFY_M2M_CLIENT_SECRET:?VERIFY_M2M_CLIENT_SECRET が .env にありません(検証用 M2M アプリの client_secret)}"

PORT="${HTTP_PORT:-${PORT:-8080}}"
BASE="http://localhost:${PORT}"

if [[ ! -f dist/http.js ]]; then
  echo "ERROR: dist/http.js がありません。先に npm run build を実行してください。" >&2
  exit 1
fi

echo "==> サーバー起動(node dist/http.js, :${PORT})"
node --env-file=.env dist/http.js >/tmp/fhir-mcp-verify.log 2>&1 &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT

# /healthz を最大10秒待つ
for _ in $(seq 1 20); do
  if curl -sf -o /dev/null "${BASE}/healthz"; then break; fi
  sleep 0.5
done
if ! curl -sf -o /dev/null "${BASE}/healthz"; then
  echo "ERROR: サーバーが起動しませんでした。ログ:" >&2
  cat /tmp/fhir-mcp-verify.log >&2
  exit 1
fi
echo "    OK: /healthz"

echo "==> M2M トークン取得(client_credentials, audience=${OAUTH_AUDIENCE})"
TOKEN_JSON=$(curl -s --request POST "${OAUTH_TOKEN_URL}" \
  -H 'content-type: application/json' \
  -d "{\"grant_type\":\"client_credentials\",\"client_id\":\"${VERIFY_M2M_CLIENT_ID}\",\"client_secret\":\"${VERIFY_M2M_CLIENT_SECRET}\",\"audience\":\"${OAUTH_AUDIENCE}\"}")

ACCESS_TOKEN=$(printf '%s' "$TOKEN_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);if(!j.access_token){console.error("token error:",s);process.exit(1)}process.stdout.write(j.access_token)}catch(e){console.error("bad token response:",s);process.exit(1)}})')

echo "==> トークン検証(ヘッダ/クレーム)"
printf '%s' "$ACCESS_TOKEN" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const parts=s.split(".");
  if(parts.length!==3){console.error("  NG: JWT ではありません(opaque トークン?)。Default Audience 未設定を疑う。");process.exit(1)}
  const dec=p=>JSON.parse(Buffer.from(p.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString());
  const h=dec(parts[0]), p=dec(parts[1]);
  console.log("    alg:", h.alg, "| iss:", p.iss, "| aud:", JSON.stringify(p.aud));
  const okAlg=h.alg==="RS256";
  const aud=Array.isArray(p.aud)?p.aud:[p.aud];
  const okAud=aud.includes(process.env.OAUTH_AUDIENCE);
  const okIss=!process.env.OAUTH_ISSUER_URL || p.iss===process.env.OAUTH_ISSUER_URL;
  if(!okAlg){console.error("  NG: alg が RS256 ではありません");process.exit(1)}
  if(!okAud){console.error("  NG: aud が OAUTH_AUDIENCE と一致しません");process.exit(1)}
  if(!okIss){console.error("  NG: iss が OAUTH_ISSUER_URL と一致しません(末尾スラッシュに注意)");process.exit(1)}
  console.log("    OK: RS256 / aud 一致 / iss 一致");
});'

echo "==> /mcp に initialize(Bearer 付き)"
HTTP_CODE=$(curl -s -o /tmp/fhir-mcp-initialize.out -w "%{http_code}" -X POST "${BASE}/mcp" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify","version":"0"}}}')

echo "    HTTP ${HTTP_CODE}"
if [[ "$HTTP_CODE" == "401" ]]; then
  echo "  NG: 401。トークンが弾かれました(aud/iss 不一致 or opaque)。" >&2
  cat /tmp/fhir-mcp-initialize.out >&2; echo >&2
  exit 1
fi

echo ""
echo "✅ Bearer 検証を通過しました(HTTP ${HTTP_CODE})。サーバー + Auth0 の JWT 連携は OK。"
echo "   応答(先頭):"
head -c 300 /tmp/fhir-mcp-initialize.out; echo
