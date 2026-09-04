#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ -d dist ]; then
    rm -rf dist
fi

if [ -d build ]; then
    rm -rf build
fi

MAJOR=0
MINOR=1
BUILD_DATE="2026-07-17"
DAYS=$(printf "%04d" $(( ( $(date +%s) - $(date -d "$BUILD_DATE" +%s) ) / 86400 )))
TIMESTAMP=$(date +%s)
LAST4=$(printf "%04d" $((TIMESTAMP % 10000)))
VERSION=$(python _version.py)

echo "==> Building Open Axle v${VERSION} with PyInstaller..."
pyinstaller --noconfirm --clean --distpath dist/output --workpath build axle.spec

echo "==> Copying skills (excluding __pycache__)..."
rm -rf dist/output/skills
mkdir -p dist/output
cp -R skills dist/output/skills
find dist/output/skills -type d -name __pycache__ -prune -exec rm -rf {} +

echo "==> Packaging dist/output into dist/open-axle_${VERSION}.tar.gz..."
tar -czf "dist/open-axle_${VERSION}.tar.gz" -C dist/output .

echo "Build complete: dist/open-axle_${VERSION}.tar.gz"
