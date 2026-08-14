#!/usr/bin/env bash
set -u
export PATH="$PATH:/c/Program Files/nodejs"
ROOT="E:/projects/meerkatai-agent"
PAYLOAD="$ROOT/deploy/layers/meerkat/desktop/payload"
T="$ROOT/.tmp-desktop-test"
rm -rf "$T"
mkdir -p "$T/data"

GIT_PROXY="${SKILL_PACK_GIT_PROXY:-http://127.0.0.1:7890}"

CORE_PORT=57614
WEB_PORT=57615
SIGN_SECRET="test-signing-secret-0123456789abcdef"
PORTAL_SECRET="test-portal-secret-0123456789abcdef"

(
  cd "$PAYLOAD/core"
  NODE_ENV=production HARNESS=pi ORG_ID=meerkat HOST=127.0.0.1 PORT=$CORE_PORT \
    DATA_DIR="$T/data" SANDBOX_BACKEND=local SESSION_STORE=sqlite \
    ALLOW_LOCAL_SKILL_PACKS=1 ADMIN_GRANTS="meerkat-desktop:org_admin" \
    CAPABILITY_SECRET=test-cap-secret CONNECTOR_SECRET_KEY=test-connector-key-0123456789abcdef \
    CORE_SIGNING_SECRET="$SIGN_SECRET" PORTAL_IDENTITY_SECRET="$PORTAL_SECRET" \
    SKILL_SIGNING_SECRET=test-skill-signing-secret-0123456789abcdef \
    SKILL_PACK_GIT_PROXY="$GIT_PROXY" \
    node dist/index.mjs > "$T/core.log" 2>&1
) &
CORE_PID=$!

(
  cd "$PAYLOAD/web-ui"
  HOST=127.0.0.1 PORT=$WEB_PORT MEERKAT_DESKTOP=1 MEERKAT_DATA_DIR="$T/data" \
    MEERKAT_SEEDS_DIR="$PAYLOAD/config/seeds" CORE_ORG_ID=meerkat \
    CORE_API_URL="http://127.0.0.1:$CORE_PORT" \
    CORE_SIGNING_SECRET="$SIGN_SECRET" PORTAL_IDENTITY_SECRET="$PORTAL_SECRET" \
    node dist-server/index.mjs > "$T/webui.log" 2>&1
) &
WEB_PID=$!

cleanup() {
  for p in $(netstat -ano | grep -E "$CORE_PORT|$WEB_PORT" | grep LISTENING | awk '{print $5}' | sort -u); do
    taskkill //PID $p //T //F 2>/dev/null
  done
}
trap cleanup EXIT

for i in $(seq 1 30); do
  grep -q "surface on" "$T/webui.log" 2>/dev/null && break
  sleep 1
done
echo "=== web-ui up after ${i}s ==="

TOKEN=$(node -e "
const {createHmac}=require('node:crypto');
const payload=Buffer.from(JSON.stringify({p:'meerkat-desktop',exp:Date.now()+3600_000})).toString('base64url');
console.log(payload+'.'+createHmac('sha256','$PORTAL_SECRET').update(payload).digest('base64url'));
")

curl -s -o /dev/null -w "root page with token: %{http_code}\n" "http://127.0.0.1:$WEB_PORT/?portal_token=$TOKEN"

for i in $(seq 1 90); do
  if grep -q "skill pack import ok\|gave up\|register failed" "$T/webui.log" 2>/dev/null; then break; fi
  sleep 2
done
sleep 3

echo "=== skills list via web-ui ==="
curl -s "http://127.0.0.1:$WEB_PORT/api/skills?portal_token=$TOKEN" | head -c 2000
echo

echo "=== webui.log ==="
cat "$T/webui.log"
echo "=== core.log (tail) ==="
tail -20 "$T/core.log"
