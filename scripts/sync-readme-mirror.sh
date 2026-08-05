#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_README="$REPO_DIR/README.md"
TARGET_README="$REPO_DIR/.github/readme.md"
MODE="${1:-sync}"
MIRROR_NOTICE='<!-- This file mirrors the root README so GitHub renders the correct project homepage copy. -->'

case "$MODE" in
    sync|--sync)
        ;;
    check|--check)
        MODE="check"
        ;;
    -h|--help)
        cat <<'EOF'
Usage: bash scripts/sync-readme-mirror.sh [sync|--sync|check|--check]

sync / --sync   Update .github/readme.md from README.md
check / --check Exit with status 1 when the mirror is out of sync
EOF
        exit 0
        ;;
    *)
        echo "Unknown mode: $MODE" >&2
        exit 1
        ;;
esac

TMP_FILE="$(mktemp)"
cleanup() {
    rm -f "$TMP_FILE"
}
trap cleanup EXIT

printf '%s\n\n' "$MIRROR_NOTICE" > "$TMP_FILE"
# The mirror lives under .github, so language links from the root need one
# directory component removed while image paths remain relative to .github.
sed 's#](\.github/readme-#](readme-#g' "$SOURCE_README" >> "$TMP_FILE"

if cmp -s "$TMP_FILE" "$TARGET_README"; then
    echo "README mirror is already in sync."
    exit 0
fi

if [[ "$MODE" == "check" ]]; then
    echo "README mirror is out of sync with README.md." >&2
    echo "Run: bash scripts/sync-readme-mirror.sh" >&2
    exit 1
fi

cp "$TMP_FILE" "$TARGET_README"
echo "Updated .github/readme.md from README.md."
