#!/usr/bin/env bash
#
# Builds the zip that goes on a GitHub Release.
#
#   npm run package
#
# Ships only what Chrome needs to run the extension — the dev tooling and tests
# stay in the repo but out of the download, so what people install is exactly
# the extension and nothing else.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./manifest.json').version")
NAME=$(node -p "require('./package.json').name")
OUT="dist/${NAME}-${VERSION}.zip"

# Keep the manifest and package versions honest with each other.
PKG_VERSION=$(node -p "require('./package.json').version")
if [ "$VERSION" != "$PKG_VERSION" ]; then
  echo "warning: manifest.json is $VERSION but package.json is $PKG_VERSION" >&2
fi

mkdir -p dist
rm -f "$OUT"

zip -r -q "$OUT" \
  manifest.json \
  icons \
  src \
  README.md \
  docs \
  -x '*.DS_Store'

echo "wrote $OUT ($(du -h "$OUT" | awk '{print $1}'))"
echo
echo "contents:"
unzip -Z1 "$OUT" | sed 's/^/  /'
