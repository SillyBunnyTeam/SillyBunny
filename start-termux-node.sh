#!/usr/bin/env bash
# Termux-friendly launcher that explicitly uses Node.js + npm.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/start-node.sh" "$@"
