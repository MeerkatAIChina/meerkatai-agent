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

# shellcheck disable=SC1091
[ -f .env ] && source .env

for p in 8090 8081 8096; do
  OLD=$(netstat -ano | grep ":$p" | grep LISTENING | awk '{print $5}' | head -1)
  [ -n "$OLD" ] && taskkill //F //PID "$OLD" >/dev/null 2>&1 || true
done
sleep 1

# shellcheck disable=SC1091
source deploy/layers/meerkat/models.conf
: "${MODEL_ID:?models.conf: MODEL_ID required}"
: "${ROUTE_MODEL_ID:?models.conf: ROUTE_MODEL_ID required}"
: "${ROUTE_PROVIDER_ID:?models.conf: ROUTE_PROVIDER_ID required}"

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
printf '{\n  "local-secure": { "harnessId": "pi", "modelId": "%s", "providerId": "%s" },\n  "meerkat-triz-v1": { "harnessId": "pi", "modelId": "%s", "providerId": "%s" }\n}\n' \
  "$ROUTE_MODEL_ID" "$ROUTE_PROVIDER_ID" "$ROUTE_MODEL_ID" "$ROUTE_PROVIDER_ID" > deploy/layers/meerkat/classifier/local-routes.json
(cd deploy/layers/meerkat/classifier && ROUTES_PATH=local-routes.json PORT=8090 nohup node_modules/.bin/tsx src/server.ts > /tmp/meerkat-sidecar.log 2>&1 &)
sleep 3
curl -sf -m 5 http://localhost:8090/health >/dev/null && echo "sidecar ok"

echo "== core :8081 =="
nohup node --env-file-if-exists=.env src/index.ts > /tmp/meerkat-core.log 2>&1 &
sleep 8
grep -q "listening on :8081" /tmp/meerkat-core.log && echo "core ok"

echo "== register custom providers =="
ALL_MODEL_IDS=""
for conf in deploy/layers/meerkat/providers/*.conf; do
  (
    # shellcheck disable=SC1090
    source "$conf"
    KEY_VAR="$(printf '%s' "$PROVIDER_ID" | tr 'a-z-' 'A-Z_')_API_KEY"
    API_KEY="${!KEY_VAR:?set $KEY_VAR in .env for provider $PROVIDER_ID}"
    printf '{"name":"%s","protocol":"%s","baseUrl":"%s","models":%s,"apiKey":"%s"}' \
      "$PROVIDER_NAME" "$PROTOCOL" "$BASE_URL" "$MODELS_JSON" "$API_KEY" > /tmp/provider-$PROVIDER_ID.json
    curl -sf -m 20 -X PUT "http://localhost:8081/v1/admin/custom-providers/$PROVIDER_ID" \
      -H 'content-type: application/json' -H 'x-admin-actor: admin-alice@meerkat' \
      --data-binary @/tmp/provider-$PROVIDER_ID.json >/dev/null && echo "provider $PROVIDER_ID ok"
    printf '%s' "$MODELS_JSON" | python -c "import json,sys; print(' '.join(m['id'] for m in json.load(sys.stdin)))" > "/tmp/models-$PROVIDER_ID.txt"
  )
  ALL_MODEL_IDS="$ALL_MODEL_IDS $(cat "/tmp/models-$(basename "$conf" .conf).txt" 2>/dev/null)"
done

echo "== register + import skill pack =="
PACK=$(curl -sf -m 30 -X POST http://localhost:8081/v1/admin/skill-packs \
  -H 'content-type: application/json' -H 'x-admin-actor: admin-alice@meerkat' \
  -d '{"url":"/E:/projects/meerkatai-agent/skill-pack-staging","ref":"main","trustTier":"internal","subset":"all"}')
PID_PACK=$(printf '%s' "$PACK" | python -c "import json,sys; print(json.load(sys.stdin)['pack']['id'])")
curl -sf -m 60 -X POST "http://localhost:8081/v1/admin/skill-packs/$PID_PACK/import" \
  -H 'content-type: application/json' -H 'x-admin-actor: admin-alice@meerkat' \
  -d '{"selected":"all"}' >/dev/null && echo "skill pack ok ($PID_PACK)"

echo "== org base model =="
IDS_JSON=$(python -c "
import json
ids = '''$MODEL_ID $ALL_MODEL_IDS'''.split()
seen = []
for i in ids:
    if i not in seen: seen.append(i)
print(json.dumps(seen))")
curl -sf -m 15 -X PUT "http://localhost:8081/v1/admin/scopes/org:meerkat/base-model" \
  -H 'content-type: application/json' -H 'x-admin-actor: admin-alice@meerkat' \
  -d "{\"modelId\":\"$MODEL_ID\"}" >/dev/null && echo "base model ok"
curl -sf -m 15 -X PUT "http://localhost:8081/v1/admin/scopes/org:meerkat/webui-models" \
  -H 'content-type: application/json' -H 'x-admin-actor: admin-alice@meerkat' \
  -d "{\"ids\":$IDS_JSON}" >/dev/null && echo "webui models ok: $IDS_JSON"

echo "== web-ui :8096 =="
(cd plugins/web-ui && CORE_API_URL=http://localhost:8081 CORE_ORG_ID=meerkat PORT=8096 nohup node server/index.ts > /tmp/meerkat-webui.log 2>&1 &)
sleep 5
curl -sf -m 5 -o /dev/null http://localhost:8096/ && echo "web-ui ok"

echo
echo "open http://localhost:8096 and sign in with any id — org base model is $MODEL_ID."
