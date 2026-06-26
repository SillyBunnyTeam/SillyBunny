#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_DIR="$REPO_DIR/public/scripts/extensions/quick-image-gen"
DEFAULT_UPSTREAM_REPO="https://github.com/platberlitz/sillytavern-image-gen.git"

UPSTREAM_REPO="$DEFAULT_UPSTREAM_REPO"
UPSTREAM_REF="main"
LOCAL_SOURCE=""
CHECK_ONLY=0
METADATA_FILE=""

usage() {
    cat <<'EOF'
Usage: bash scripts/sync-quick-image-gen.sh [options]

Options:
  --repo <url>           Upstream repository URL. Defaults to platberlitz/sillytavern-image-gen.
  --ref <git-ref>        Upstream ref to sync. Defaults to main.
  --source <path>        Use an existing local Quick Image Gen checkout instead of cloning.
  --check                Exit with status 1 if the bundled files are out of sync.
  --metadata-file <path> Write QIG_VERSION, QIG_COMMIT, QIG_SHORT_COMMIT, QIG_REF, and QIG_REPO.
  -h, --help             Show this help.
EOF
}

while (($#)); do
    case "$1" in
        --repo)
            UPSTREAM_REPO="${2:-}"
            shift 2
            ;;
        --ref)
            UPSTREAM_REF="${2:-}"
            shift 2
            ;;
        --source)
            LOCAL_SOURCE="${2:-}"
            shift 2
            ;;
        --check)
            CHECK_ONLY=1
            shift
            ;;
        --metadata-file)
            METADATA_FILE="${2:-}"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

if [[ -z "$UPSTREAM_REPO" ]]; then
    echo "Missing upstream repository URL." >&2
    exit 1
fi

if [[ -z "$UPSTREAM_REF" ]]; then
    echo "Missing upstream ref." >&2
    exit 1
fi

if [[ -n "$LOCAL_SOURCE" && ! -d "$LOCAL_SOURCE" ]]; then
    echo "Local source does not exist: $LOCAL_SOURCE" >&2
    exit 1
fi

if [[ ! -d "$TARGET_DIR" ]]; then
    echo "Bundled Quick Image Gen target does not exist: $TARGET_DIR" >&2
    exit 1
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

SOURCE_DIR="$LOCAL_SOURCE"
if [[ -z "$SOURCE_DIR" ]]; then
    SOURCE_DIR="$TMP_DIR/source"
    git init --quiet "$SOURCE_DIR"
    git -C "$SOURCE_DIR" remote add origin "$UPSTREAM_REPO"
    git -C "$SOURCE_DIR" fetch --quiet --depth=1 origin "$UPSTREAM_REF"
    git -C "$SOURCE_DIR" checkout --quiet FETCH_HEAD
fi

for required_file in index.js style.css manifest.json; do
    if [[ ! -f "$SOURCE_DIR/$required_file" ]]; then
        echo "Upstream Quick Image Gen source is missing $required_file." >&2
        exit 1
    fi
done

UPSTREAM_COMMIT="$(git -C "$SOURCE_DIR" rev-parse HEAD 2>/dev/null || printf 'local-source')"
UPSTREAM_SHORT_COMMIT="$UPSTREAM_COMMIT"
if [[ "$UPSTREAM_COMMIT" != "local-source" ]]; then
    UPSTREAM_SHORT_COMMIT="$(git -C "$SOURCE_DIR" rev-parse --short=12 HEAD)"
fi

UPSTREAM_VERSION="$(node -e "const fs = require('fs'); const manifest = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); if (!manifest.version) process.exit(1); process.stdout.write(String(manifest.version));" "$SOURCE_DIR/manifest.json")"

WORK_DIR="$TMP_DIR/quick-image-gen"
mkdir -p "$WORK_DIR"
cp "$SOURCE_DIR/index.js" "$WORK_DIR/index.js"
cp "$SOURCE_DIR/style.css" "$WORK_DIR/style.css"

node - "$WORK_DIR/style.css" <<'NODE'
const fs = require('fs');

const stylePath = process.argv[2];
const lines = fs.readFileSync(stylePath, 'utf8').split('\n');

for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const stickyMatch = line.match(/^(\s*)position:\s*sticky;$/);
    const userSelectMatch = line.match(/^(\s*)user-select:\s*(.+);$/);
    const backdropMatch = line.match(/^(\s*)backdrop-filter:\s*(.+);$/);
    const prefix = stickyMatch
        ? `${stickyMatch[1]}position: -webkit-sticky;`
        : userSelectMatch
            ? `${userSelectMatch[1]}-webkit-user-select: ${userSelectMatch[2]};`
            : backdropMatch
                ? `${backdropMatch[1]}-webkit-backdrop-filter: ${backdropMatch[2]};`
                : null;

    if (!prefix || lines[index - 1]?.trim() === prefix.trim()) continue;

    lines.splice(index, 0, prefix);
    index++;
}

fs.writeFileSync(stylePath, lines.join('\n'));
NODE

node - "$WORK_DIR/index.js" "$TARGET_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');

const indexPath = process.argv[2];
const bundledExtensionDir = process.argv[3];
let source = fs.readFileSync(indexPath, 'utf8');

const importRewrites = new Map([
    ['await import("../../../extensions.js")', 'await import("../../extensions.js")'],
    ['await import("../../../../script.js")', 'await import("../../../script.js")'],
    ['await import("../../../openai.js")', 'await import("../../openai.js")'],
    ['await import("../../../utils.js")', 'await import("../../utils.js")'],
    ['await import("../../../RossAscends-mods.js")', 'await import("../../RossAscends-mods.js")'],
    ['await import("../../../../scripts/secrets.js")', 'await import("../../secrets.js")'],
]);

for (const [upstreamImport, bundledImport] of importRewrites) {
    if (!source.includes(upstreamImport)) {
        console.error(`Upstream Quick Image Gen index.js is missing expected import: ${upstreamImport}`);
        process.exit(1);
    }

    source = source.replaceAll(upstreamImport, bundledImport);
}

const remainingUpstreamImports = [...importRewrites.keys()].filter(importPath => source.includes(importPath));
if (remainingUpstreamImports.length) {
    console.error('Quick Image Gen index.js still contains upstream-depth imports after rewriting:');
    for (const importPath of remainingUpstreamImports) {
        console.error(`- ${importPath}`);
    }
    process.exit(1);
}

const dynamicImportPattern = /await\s+import\("([^"]+)"\)/g;
for (const [, specifier] of source.matchAll(dynamicImportPattern)) {
    if (!specifier.startsWith('.')) continue;

    const resolvedPath = path.resolve(bundledExtensionDir, specifier);
    if (!fs.existsSync(resolvedPath)) {
        console.error(`Quick Image Gen dynamic import does not resolve in the bundled location: ${specifier}`);
        process.exit(1);
    }
}

const bridgeExports = [
    'getSettings',
    'getGenerationSettingsForRun',
    'generateForProvider',
    'finalizeGeneratedEntry',
    'withTransientGenerationSettings',
];
for (const symbol of bridgeExports) {
    if (!new RegExp(`\\b(?:async\\s+)?function\\s+${symbol}\\b`).test(source)) {
        console.error(`Quick Image Gen index.js is missing expected Expressions bridge helper: ${symbol}`);
        process.exit(1);
    }
}

const moduleExport = 'export { extensionName };';
if (!source.includes(moduleExport)) {
    console.error('Quick Image Gen index.js is missing expected module export.');
    process.exit(1);
}

const bridgeExportBlock = `

// SillyBunny divergence: minimal helper exports for the Expressions Agent bridge.
// These are kept intentionally small so upstream syncs only need to preserve this
// one export block. The actual sprite-generation logic lives outside QIG in
// public/scripts/extensions/expressions/expression-sprite-bridge.js.
export {
    getSettings,
    getGenerationSettingsForRun,
    generateForProvider,
    finalizeGeneratedEntry,
    withTransientGenerationSettings,
};`;

source = source.replace(moduleExport, `${moduleExport}${bridgeExportBlock}`);

fs.writeFileSync(indexPath, source);
NODE

node - "$SOURCE_DIR/manifest.json" "$WORK_DIR/manifest.json" <<'NODE'
const fs = require('fs');

const sourcePath = process.argv[2];
const targetPath = process.argv[3];
const manifest = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));

manifest.author = 'platberlitz (vendored by TLD)';
manifest.manifest_version = 3;

fs.writeFileSync(targetPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

if [[ -n "$METADATA_FILE" ]]; then
    {
        printf 'QIG_VERSION=%s\n' "$UPSTREAM_VERSION"
        printf 'QIG_COMMIT=%s\n' "$UPSTREAM_COMMIT"
        printf 'QIG_SHORT_COMMIT=%s\n' "$UPSTREAM_SHORT_COMMIT"
        printf 'QIG_REF=%s\n' "$UPSTREAM_REF"
        printf 'QIG_REPO=%s\n' "$UPSTREAM_REPO"
    } > "$METADATA_FILE"
fi

if cmp -s "$WORK_DIR/index.js" "$TARGET_DIR/index.js" \
    && cmp -s "$WORK_DIR/style.css" "$TARGET_DIR/style.css" \
    && cmp -s "$WORK_DIR/manifest.json" "$TARGET_DIR/manifest.json"; then
    echo "Quick Image Gen is already in sync with $UPSTREAM_REF ($UPSTREAM_SHORT_COMMIT), version $UPSTREAM_VERSION."
    exit 0
fi

if (( CHECK_ONLY )); then
    echo "Quick Image Gen is out of sync with $UPSTREAM_REF ($UPSTREAM_SHORT_COMMIT), version $UPSTREAM_VERSION." >&2
    exit 1
fi

cp "$WORK_DIR/index.js" "$TARGET_DIR/index.js"
cp "$WORK_DIR/style.css" "$TARGET_DIR/style.css"
cp "$WORK_DIR/manifest.json" "$TARGET_DIR/manifest.json"

echo "Synced Quick Image Gen to version $UPSTREAM_VERSION from $UPSTREAM_REF ($UPSTREAM_SHORT_COMMIT)."
