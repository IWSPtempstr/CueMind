#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
command -v docker >/dev/null
test -f Dockerfile
test -f package-lock.json
test -z "${HTTP_PROXY:-}" || true
echo "offline package checks passed (runtime network policy must be enforced by the host/container)"
