#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$ROOT_DIR"

if [[ ! -d node_modules ]]; then
  echo "Missing node_modules in $ROOT_DIR"
  echo "Run: npm install"
  exit 1
fi

exec npm run dev:main
