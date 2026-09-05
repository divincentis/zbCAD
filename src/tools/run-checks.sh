#!/bin/sh
# Rebuild from src/ and re-run the static checks.
set -e
cd "$(dirname "$0")/.."
python3 tools/graph.py
node tools/build.mjs
for f in $(find src -name '*.js'); do node --check "$f"; done
echo "checks passed"
