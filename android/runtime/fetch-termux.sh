#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if ! command -v python3 >/dev/null 2>&1; then
    printf 'Termux runtime: python3 is required.\n' >&2
    exit 1
fi

exec python3 -I "$SCRIPT_DIR/package-termux.py" "$@"
