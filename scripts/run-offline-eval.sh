#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT_DIR="${1:-$ROOT_DIR/reports/offline-eval}"
mkdir -p "$REPORT_DIR"
cd "$ROOT_DIR"

echo "[offline-eval] checking local dependencies"
command -v node >/dev/null
command -v npm >/dev/null
test -f package-lock.json

echo "[offline-eval] typecheck/lint"
npx tsc --noEmit
npm run lint

echo "[offline-eval] governance and ASR contracts"
TMPDIR=/tmp npx tsx scripts/test-vault-governance.ts
TMPDIR=/tmp npx tsx scripts/test-asr-reliability.ts
TMPDIR=/tmp npx tsx scripts/test-realtime-replay.ts
TMPDIR=/tmp npx tsx scripts/test-model-release.ts
TMPDIR=/tmp npx tsx scripts/test-finetune-dataset.ts
TMPDIR=/tmp npx tsx scripts/build-finetune-dataset.ts --out /tmp/cuemind-finetune-bundle
TMPDIR=/tmp npx tsx scripts/test-vault-exporter.ts

echo "[offline-eval] writing reproducible baseline manifest"
TMPDIR=/tmp npx tsx scripts/model-baseline-matrix.ts "$REPORT_DIR"
cat > "$REPORT_DIR/run-metadata.json" <<EOF
{"offline":true,"node":"$(node --version)","commit":"$(git rev-parse HEAD)","reportDir":"$REPORT_DIR"}
EOF
echo "[offline-eval] complete: $REPORT_DIR"
