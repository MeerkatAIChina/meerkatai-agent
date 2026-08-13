#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
DESKTOP="$ROOT/deploy/layers/meerkat/desktop"
PAYLOAD="$DESKTOP/payload"
CACHE="$DESKTOP/.node-cache"
NODE_VERSION="${NODE_VERSION:-v24.15.0}"

npm_run() {
  if command -v npm >/dev/null 2>&1; then
    npm "$@"
  else
    cmd //c "npm.cmd $*"
  fi
}

rm -rf "$PAYLOAD"
mkdir -p "$PAYLOAD/node" "$PAYLOAD/config/seeds" "$CACHE"

case "${MEERKAT_TARGET:-$(uname -s)}" in
  MINGW*|MSYS*|CYGWIN*|windows) NODE_ARCH="win-x64"; NODE_PKG="zip" ;;
  Darwin)
    NODE_PKG="tar.gz"
    if [ "$(uname -m)" = "arm64" ]; then NODE_ARCH="darwin-arm64"; else NODE_ARCH="darwin-x64"; fi
    ;;
  Linux)
    NODE_PKG="tar.gz"
    if [ "$(uname -m)" = "aarch64" ]; then NODE_ARCH="linux-arm64"; else NODE_ARCH="linux-x64"; fi
    ;;
  *) echo "unsupported platform: $(uname -s)" >&2; exit 1 ;;
esac
NODE_DIST="node-$NODE_VERSION-$NODE_ARCH"
if [ ! -d "$CACHE/$NODE_DIST" ]; then
  url="https://nodejs.org/dist/$NODE_VERSION/$NODE_DIST.$NODE_PKG"
  echo "fetching $url"
  curl -fSL "$url" -o "$CACHE/$NODE_DIST.$NODE_PKG"
  if [ "$NODE_PKG" = "zip" ]; then
    (cd "$CACHE" && unzip -q -o "$NODE_DIST.zip")
  else
    (cd "$CACHE" && tar xzf "$NODE_DIST.tar.gz")
  fi
fi
if [ "$NODE_PKG" = "zip" ]; then
  cp "$CACHE/$NODE_DIST/node.exe" "$PAYLOAD/node/"
else
  mkdir -p "$PAYLOAD/node/bin"
  cp "$CACHE/$NODE_DIST/bin/node" "$PAYLOAD/node/bin/"
fi

node "$DESKTOP/scripts/bundle.mjs"
mkdir -p "$PAYLOAD/core/dist/protocols"
cp "$ROOT"/src/resolution/protocols/*.md "$PAYLOAD/core/dist/protocols/"
cp "$ROOT/node_modules/tiktoken/tiktoken_bg.wasm" "$PAYLOAD/core/dist/"

(cd "$ROOT/plugins/web-ui" && npm_run run build)
mkdir -p "$PAYLOAD/web-ui"
cp -r "$ROOT/plugins/web-ui/dist-web" "$PAYLOAD/web-ui/dist-web"
mkdir -p "$PAYLOAD/web-ui/server"
cp "$ROOT/plugins/web-ui/server/setup.html" "$PAYLOAD/web-ui/server/"
cp "$ROOT/plugins/web-ui/server/locks.html" "$PAYLOAD/web-ui/server/"

STAGE_CLS="$(mktemp -d)"
cp "$ROOT/deploy/layers/meerkat/classifier/package.json" "$ROOT/deploy/layers/meerkat/classifier/package-lock.json" "$STAGE_CLS/" 2>/dev/null || true
(cd "$STAGE_CLS" && npm_run ci --omit=dev --ignore-scripts)
mkdir -p "$PAYLOAD/classifier"
cp -r "$ROOT/deploy/layers/meerkat/classifier/src" "$PAYLOAD/classifier/src"
cp "$ROOT/deploy/layers/meerkat/classifier/package.json" "$PAYLOAD/classifier/"
cp -r "$STAGE_CLS/node_modules" "$PAYLOAD/classifier/node_modules"
rm -rf "$STAGE_CLS"

cp -r "$DESKTOP/seeds"/* "$PAYLOAD/config/seeds/"

du -sh "$PAYLOAD" "$PAYLOAD"/* 2>/dev/null || true
