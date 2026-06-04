#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

chmod +x "$SCRIPT_DIR/start.sh" >/dev/null 2>&1 || true
chmod +x "$SCRIPT_DIR/start-node.sh" >/dev/null 2>&1 || true
chmod +x "$SCRIPT_DIR/scripts/install-prerequisites.sh" >/dev/null 2>&1 || true
chmod +x "$SCRIPT_DIR/scripts/self-update.sh" >/dev/null 2>&1 || true

if ! "$SCRIPT_DIR/start-node.sh" "$@"; then
    echo
    read -r -p "Startup failed. Press Enter to close this window..."
    exit 1
fi
