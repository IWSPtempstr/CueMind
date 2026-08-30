#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${CUEMIND_COMPOSE_FILE:-$ROOT_DIR/docker-compose.yml}"
case "${1:-}" in
  start) docker compose -f "$COMPOSE_FILE" up -d ;;
  stop) docker compose -f "$COMPOSE_FILE" down ;;
  restart) docker compose -f "$COMPOSE_FILE" restart ;;
  upgrade) docker compose -f "$COMPOSE_FILE" up -d --build ;;
  rollback) test -n "${CUEMIND_IMAGE_TAG:-}"; docker compose -f "$COMPOSE_FILE" pull "$CUEMIND_IMAGE_TAG" 2>/dev/null || true; docker compose -f "$COMPOSE_FILE" up -d ;;
  *) echo "usage: $0 {start|stop|restart|upgrade|rollback}" >&2; exit 2 ;;
esac
