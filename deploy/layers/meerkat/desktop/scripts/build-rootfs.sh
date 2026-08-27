#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
DESKTOP="$ROOT/deploy/layers/meerkat/desktop"
OUT="$DESKTOP/payload-sandbox"
mkdir -p "$OUT"

export PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"

UPSTREAM_FP="$(node -e 'import("./src/sandbox/local-sandbox.ts").then(m => m.computeSandboxImageFingerprint(process.cwd())).then(f => console.log(f ?? "dev"))')"
FINGERPRINT="$({ printf '%s\n' "$UPSTREAM_FP"; cat "$DESKTOP/rootfs/Dockerfile" "$DESKTOP/rootfs/egress-lock.sh" "$DESKTOP/rootfs/egress-proxy.mjs"; } | sha256sum | cut -d' ' -f1)"
echo "fingerprint: $FINGERPRINT (upstream: $UPSTREAM_FP)"

docker build --platform linux/amd64 --build-arg "FINGERPRINT=$FINGERPRINT" \
  -f "$DESKTOP/rootfs/Dockerfile" -t meerkat-sandbox-rootfs "$ROOT"
cid="$(docker create meerkat-sandbox-rootfs)"
docker export "$cid" | gzip -9 > "$OUT/rootfs.tar.gz"
docker rm "$cid" >/dev/null
printf '%s' "$FINGERPRINT" > "$OUT/fingerprint.txt"
ls -lh "$OUT/rootfs.tar.gz"
