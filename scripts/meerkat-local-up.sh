#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DOCKER_BIN="/c/Program Files/Docker/Docker/resources/bin"
[ -d "$DOCKER_BIN" ] && export PATH="$DOCKER_BIN:$PATH"
if [ ! -f "$HOME/.docker/cli-plugins/docker-buildx.exe" ] && [ -f "$DOCKER_BIN/../cli-plugins/docker-buildx.exe" ]; then
  mkdir -p "$HOME/.docker/cli-plugins"
  cp "$DOCKER_BIN/../cli-plugins/docker-buildx.exe" "$HOME/.docker/cli-plugins/"
fi

KIMI_KEY="${MEERKAT_KIMI_KEY:?set MEERKAT_KIMI_KEY to your Kimi Code key (sk-kimi-...)}"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if ! docker image inspect qm-sandbox-local:latest >/dev/null 2>&1; then
    echo "== build sandbox images (first run, slow) =="
    FP=$(node --input-type=module -e 'const { computeSandboxImageFingerprint } = await import("./src/sandbox/local-sandbox.ts"); console.log(await computeSandboxImageFingerprint(process.cwd()) ?? "");')
    docker buildx build --platform linux/amd64 -f fly/Dockerfile -t qm-sandbox-base:dev --load .
    docker buildx build --platform linux/amd64 -f local/Dockerfile --build-arg "BASE=qm-sandbox-base:dev" \
      --label "qm.sandbox-fingerprint=$FP" -t qm-sandbox-local:latest --load .
  fi
else
  echo "warn: docker daemon not reachable — sandboxed tools will be unavailable (chat still works)"
fi

echo "== sidecar :8090 =="
(cd deploy/layers/meerkat/classifier && ROUTES_PATH=local-routes.json PORT=8090 nohup node_modules/.bin/tsx src/server.ts > /tmp/meerkat-sidecar.log 2>&1 &)
sleep 3
curl -sf -m 5 http://localhost:8090/health >/dev/null && echo "sidecar ok"

echo "== core :8081 =="
nohup node --env-file-if-exists=.env src/index.ts > /tmp/meerkat-core.log 2>&1 &
sleep 8
grep -q "listening on :8081" /tmp/meerkat-core.log && echo "core ok"

echo "== register custom provider =="
printf '{"name":"Kimi Code","protocol":"openai","baseUrl":"https://api.kimi.com/coding/v1","models":[{"id":"kimi-k2.6","name":"Kimi K2.6","contextWindow":262144,"maxTokens":32768}],"apiKey":"%s"}' "$KIMI_KEY" > /tmp/provider.json
curl -sf -m 20 -X PUT http://localhost:8081/v1/admin/custom-providers/kimi-code \
  -H 'content-type: application/json' -H 'x-admin-actor: admin-alice@meerkat' \
  --data-binary @/tmp/provider.json >/dev/null && echo "provider ok"

echo "== register + import skill pack =="
PACK=$(curl -sf -m 30 -X POST http://localhost:8081/v1/admin/skill-packs \
  -H 'content-type: application/json' -H 'x-admin-actor: admin-alice@meerkat' \
  -d '{"url":"/E:/projects/meerkatai-agent/skill-pack-staging","ref":"main","trustTier":"internal","subset":"all"}')
PID_PACK=$(printf '%s' "$PACK" | python -c "import json,sys; print(json.load(sys.stdin)['pack']['id'])")
curl -sf -m 60 -X POST "http://localhost:8081/v1/admin/skill-packs/$PID_PACK/import" \
  -H 'content-type: application/json' -H 'x-admin-actor: admin-alice@meerkat' \
  -d '{"selected":"all"}' >/dev/null && echo "skill pack ok ($PID_PACK)"

echo "== org base model =="
curl -sf -m 15 -X PUT "http://localhost:8081/v1/admin/scopes/org:meerkat/base-model" \
  -H 'content-type: application/json' -H 'x-admin-actor: admin-alice@meerkat' \
  -d '{"modelId":"kimi-k2.6"}' >/dev/null && echo "base model ok"

echo "== web-ui :8096 =="
(cd plugins/web-ui && CORE_API_URL=http://localhost:8081 CORE_ORG_ID=meerkat PORT=8096 nohup node server/index.ts > /tmp/meerkat-webui.log 2>&1 &)
sleep 5
curl -sf -m 5 -o /dev/null http://localhost:8096/ && echo "web-ui ok"

echo
echo "open http://localhost:8096 and sign in with any id — org base model is already kimi-k2.6."
