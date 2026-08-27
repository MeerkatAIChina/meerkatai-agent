#!/usr/bin/env bash
set -euo pipefail
PAYLOAD="$(cd "$(dirname "$0")/../payload" && pwd)"
PORT="${VERIFY_PORT:-18085}"
DATA_DIR="$(mktemp -d)"
NODE="$PAYLOAD/node/node.exe"
[ -f "$NODE" ] || NODE="$PAYLOAD/node/bin/node"
[ -f "$NODE" ] || NODE="node"

gen_secret() { node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"; }
VERIFY_SIGN_SECRET="${VERIFY_SIGN_SECRET:-$(gen_secret)}"

RUN_DIR="$(mktemp -d)"
cleanup() { kill ${CORE_PID:-} 2>/dev/null || true; sleep 1; cd /; rm -rf "$DATA_DIR" "$RUN_DIR" 2>/dev/null || true; }
trap cleanup EXIT
cp -r "$PAYLOAD/core" "$RUN_DIR/core"

cd "$RUN_DIR/core"
env \
  NODE_ENV=production \
  HOST=127.0.0.1 \
  PORT="$PORT" \
  DATA_DIR="$DATA_DIR" \
  SANDBOX_BACKEND=local \
  SESSION_STORE=sqlite \
  HARNESS=mock \
  ADMIN_GRANTS=meerkat-desktop:org_admin \
  CAPABILITY_SECRET="$(gen_secret)" \
  CONNECTOR_SECRET_KEY="$(gen_secret)" \
  CORE_SIGNING_SECRET="$VERIFY_SIGN_SECRET" \
  PORTAL_IDENTITY_SECRET="$(gen_secret)" \
  SKILL_SIGNING_SECRET="$(gen_secret)" \
  "$NODE" dist/index.mjs &
CORE_PID=$!

if [ -f "$PAYLOAD/sandbox/rootfs.tar.gz" ]; then
  echo "sandbox rootfs staged ($(du -h "$PAYLOAD/sandbox/rootfs.tar.gz" | cut -f1))"
else
  echo "sandbox rootfs absent (mac build or skipped)"
fi

for _ in $(seq 1 20); do
  curl -sf -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf -m 5 "http://127.0.0.1:$PORT/health" >/dev/null && echo "core health ok"

node --input-type=module - "$VERIFY_SIGN_SECRET" "$PORT" <<'EOF'
import { createHmac } from "node:crypto";
const [secret, port] = process.argv.slice(2);
const body = JSON.stringify({
  surface: "desktop",
  actor: { externalId: "smoke-user" },
  conversation: { kind: "dm", threadRef: "smoke-thread" },
  text: "ping",
});
const ts = Math.floor(Date.now() / 1000);
const sig = `v0=${createHmac("sha256", secret).update(`v0:${ts}:POST\n/v1/turns\n${body}`).digest("hex")}`;
const res = await fetch(`http://127.0.0.1:${port}/v1/turns`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-timestamp": String(ts), "x-signature": sig },
  body,
});
if (res.status !== 200) {
  console.error(`turn failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
console.log("turn ok:", (await res.text()).slice(0, 120));
EOF
