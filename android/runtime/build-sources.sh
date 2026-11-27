#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if ! command -v python3 >/dev/null 2>&1; then
    printf 'python3 is required to build the sources archive. Install it and run the script again.\n' >&2
    exit 1
fi

exec python3 -I -B "$SCRIPT_DIR/sources.py" "$@"
