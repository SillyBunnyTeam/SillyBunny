#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_DIR="$REPO_DIR/public/scripts/extensions/quick-image-gen"
STATE_FILE="$SCRIPT_DIR/quick-image-gen-sync-state.json"
DEFAULT_UPSTREAM_REPO="https://github.com/platberlitz/sillytavern-image-gen.git"

UPSTREAM_REPO="$DEFAULT_UPSTREAM_REPO"
UPSTREAM_REF="main"
LOCAL_SOURCE=""
CHECK_ONLY=0
METADATA_FILE=""
BASE_COMMIT_OVERRIDE=""

usage() {
    cat <<'EOF'
Usage: bash scripts/sync-quick-image-gen.sh [options]

Syncs the bundled Quick Image Gen extension from upstream. The bundled copy carries
SillyBunny divergences (Conversation capability wiring, scoped generation, lifecycle
hooks), so the sync is a three-way merge instead of an overwrite:

  base     = upstream commit recorded in scripts/quick-image-gen-sync-state.json,
             re-generated through this script's transforms
  upstream = the requested upstream ref, generated through the same transforms
  ours     = the current bundled files

Conflicts are reported with markers left in place for manual resolution.

Options:
  --repo <url>           Upstream repository URL. Defaults to platberlitz/sillytavern-image-gen.
  --ref <git-ref>        Upstream ref to sync. Defaults to main.
  --source <path>        Use an existing local Quick Image Gen checkout instead of cloning.
  --base <commit>        Override the recorded merge base commit.
  --check                Exit with status 1 if the bundled copy is behind the upstream ref.
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
        --base)
            BASE_COMMIT_OVERRIDE="${2:-}"
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

cat > "$TMP_DIR/transform-style.js" <<'NODE'
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

cat > "$TMP_DIR/transform-index.js" <<'NODE'
const fs = require('fs');
const path = require('path');

const indexPath = process.argv[2];
const workDir = process.argv[3];
const bundledExtensionDir = process.argv[4];
let source = fs.readFileSync(indexPath, 'utf8');

// Upstream ships from public/scripts/extensions/third-party/quick-image-gen while the
// bundled copy lives one directory shallower, so every host import that escapes the
// extension directory loses exactly one leading "../". Deriving this instead of listing
// each import keeps the sync working when upstream reaches for new host modules.
const dynamicImportPattern = /(\bimport\(\s*)"(\.[^"]*)"/g;
let rewrittenImports = 0;
source = source.replace(dynamicImportPattern, (match, prefix, specifier) => {
    if (!specifier.startsWith('../')) return match;

    rewrittenImports++;
    return `${prefix}"${specifier.slice(3)}"`;
});

if (!rewrittenImports) {
    console.error('Quick Image Gen index.js has no host imports to rewrite for the bundled location.');
    process.exit(1);
}

for (const [, , specifier] of source.matchAll(dynamicImportPattern)) {
    const resolvedPath = path.resolve(bundledExtensionDir, specifier);
    if (!fs.existsSync(resolvedPath)) {
        console.error(`Quick Image Gen dynamic import does not resolve in the bundled location: ${specifier}`);
        process.exit(1);
    }
}

const modulePaths = [indexPath];
const libDir = path.join(workDir, 'lib');
const collectModules = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) collectModules(entryPath);
        else if (entry.isFile() && entry.name.endsWith('.js')) modulePaths.push(entryPath);
    }
};
if (fs.existsSync(libDir)) collectModules(libDir);

const staticImportPatterns = [
    /\bimport\s+(?:[^;"']*?\s+from\s*)?["']([^"']+)["']/g,
    /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g,
];
for (const modulePath of modulePaths) {
    const moduleSource = fs.readFileSync(modulePath, 'utf8');
    const relativeModulePath = path.relative(workDir, modulePath);
    for (const pattern of staticImportPatterns) {
        for (const [, rawSpecifier] of moduleSource.matchAll(pattern)) {
            if (!rawSpecifier.startsWith('.')) continue;

            const specifier = rawSpecifier.split(/[?#]/, 1)[0];
            const generatedPath = path.resolve(path.dirname(modulePath), specifier);
            const bundledModulePath = path.join(bundledExtensionDir, relativeModulePath);
            const bundledPath = path.resolve(path.dirname(bundledModulePath), specifier);
            const resolvedPath = generatedPath.startsWith(`${workDir}${path.sep}`)
                ? generatedPath
                : bundledPath;
            if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
                console.error(`Quick Image Gen static import does not resolve in the bundled location: ${relativeModulePath} -> ${rawSpecifier}`);
                process.exit(1);
            }
        }
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

cat > "$TMP_DIR/transform-manifest.js" <<'NODE'
const fs = require('fs');

const sourcePath = process.argv[2];
const targetPath = process.argv[3];
const manifest = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));

manifest.author = 'platberlitz (vendored by TLD)';
manifest.manifest_version = 3;

fs.writeFileSync(targetPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

cat > "$TMP_DIR/merge-tree.js" <<'NODE'
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const [, , oursDir, baseDir, upstreamDir, outDir] = process.argv;

const listFiles = (root) => {
    const files = [];
    const walk = (directory, relative) => {
        if (!fs.existsSync(directory)) return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(path.join(directory, entry.name), relativePath);
            else if (entry.isFile()) files.push(relativePath);
        }
    };
    walk(root, '');
    return files;
};

const emptyBase = path.join(outDir, '.empty-merge-base');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(emptyBase, '');

const relativePaths = [...new Set([
    ...listFiles(baseDir),
    ...listFiles(upstreamDir),
    ...listFiles(oursDir),
])].sort();

const copy = (from, to) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
};

const conflicts = [];
const removed = [];
for (const relativePath of relativePaths) {
    const ours = path.join(oursDir, relativePath);
    const base = path.join(baseDir, relativePath);
    const upstream = path.join(upstreamDir, relativePath);
    const output = path.join(outDir, relativePath);

    const hasOurs = fs.existsSync(ours);
    const hasBase = fs.existsSync(base);
    const hasUpstream = fs.existsSync(upstream);

    if (!hasOurs && !hasUpstream) continue;

    if (!hasOurs) {
        // Upstream added a file that the bundled copy does not have yet.
        if (!hasBase) copy(upstream, output);
        continue;
    }

    if (!hasUpstream) {
        // Upstream deleted the file, or it only ever existed downstream.
        if (hasBase) removed.push(relativePath);
        else copy(ours, output);
        continue;
    }

    copy(ours, output);
    const result = spawnSync('git', [
        'merge-file',
        '-L', 'SillyBunny',
        '-L', 'upstream base',
        '-L', 'upstream incoming',
        output,
        hasBase ? base : emptyBase,
        upstream,
    ], { encoding: 'utf8' });

    if (result.status === null || result.status < 0) {
        console.error(`Quick Image Gen merge failed for ${relativePath}: ${result.stderr || result.error}`);
        process.exit(1);
    }

    if (result.status > 0) conflicts.push(`${relativePath} (${result.status} conflict${result.status === 1 ? '' : 's'})`);
}

fs.rmSync(emptyBase);

fs.writeFileSync(path.join(path.dirname(outDir), 'merge-report.txt'), JSON.stringify({ conflicts, removed }, null, 2));

for (const relativePath of removed) console.log(`removed upstream: ${relativePath}`);
if (conflicts.length) {
    console.error('Quick Image Gen merge produced conflicts:');
    for (const conflict of conflicts) console.error(`- ${conflict}`);
    process.exit(2);
}
NODE

generate_bundle() {
    local source_dir="$1"
    local out_dir="$2"

    mkdir -p "$out_dir"
    cp "$source_dir/index.js" "$out_dir/index.js"
    cp "$source_dir/style.css" "$out_dir/style.css"
    if [[ -d "$source_dir/lib" ]]; then
        cp -R "$source_dir/lib" "$out_dir/lib"
    fi

    node "$TMP_DIR/transform-style.js" "$out_dir/style.css"
    node "$TMP_DIR/transform-index.js" "$out_dir/index.js" "$out_dir" "$TARGET_DIR"
    node "$TMP_DIR/transform-manifest.js" "$source_dir/manifest.json" "$out_dir/manifest.json"
}

checkout_commit() {
    local dest="$1"
    local commit="$2"

    git init --quiet "$dest"
    git -C "$dest" remote add origin "$UPSTREAM_REPO"
    if ! git -C "$dest" fetch --quiet --depth=1 origin "$commit" 2>/dev/null; then
        git -C "$dest" fetch --quiet origin
    fi
    git -C "$dest" checkout --quiet "$commit"
}

read_state() {
    local key="$1"

    [[ -f "$STATE_FILE" ]] || return 0
    node -e "const fs = require('fs'); const state = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); process.stdout.write(String(state[process.argv[2]] ?? ''));" "$STATE_FILE" "$key"
}

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

BASE_COMMIT="$BASE_COMMIT_OVERRIDE"
if [[ -z "$BASE_COMMIT" ]]; then
    BASE_COMMIT="$(read_state commit)"
fi

if [[ -n "$METADATA_FILE" ]]; then
    {
        printf 'QIG_VERSION=%s\n' "$UPSTREAM_VERSION"
        printf 'QIG_COMMIT=%s\n' "$UPSTREAM_COMMIT"
        printf 'QIG_SHORT_COMMIT=%s\n' "$UPSTREAM_SHORT_COMMIT"
        printf 'QIG_REF=%s\n' "$UPSTREAM_REF"
        printf 'QIG_REPO=%s\n' "$UPSTREAM_REPO"
    } > "$METADATA_FILE"
fi

if (( CHECK_ONLY )); then
    if [[ -z "$BASE_COMMIT" ]]; then
        echo "Quick Image Gen sync state is missing. Run scripts/sync-quick-image-gen.sh to record it." >&2
        exit 1
    fi

    if [[ "$BASE_COMMIT" == "$UPSTREAM_COMMIT" ]]; then
        echo "Quick Image Gen is in sync with $UPSTREAM_REF ($UPSTREAM_SHORT_COMMIT), version $UPSTREAM_VERSION."
        exit 0
    fi

    echo "Quick Image Gen is out of sync with $UPSTREAM_REF ($UPSTREAM_SHORT_COMMIT), version $UPSTREAM_VERSION." >&2
    exit 1
fi

if [[ -z "$BASE_COMMIT" ]]; then
    echo "Quick Image Gen sync state is missing a base commit. Pass --base <commit> for the upstream commit the bundled copy was generated from." >&2
    exit 1
fi

WORK_DIR="$TMP_DIR/upstream"
generate_bundle "$SOURCE_DIR" "$WORK_DIR"

BASE_DIR="$TMP_DIR/base"
if [[ "$BASE_COMMIT" == "$UPSTREAM_COMMIT" ]]; then
    cp -R "$WORK_DIR" "$BASE_DIR"
else
    BASE_SOURCE_DIR="$TMP_DIR/base-source"
    checkout_commit "$BASE_SOURCE_DIR" "$BASE_COMMIT"
    generate_bundle "$BASE_SOURCE_DIR" "$BASE_DIR"
fi

MERGED_DIR="$TMP_DIR/merged/quick-image-gen"
MERGE_STATUS=0
node "$TMP_DIR/merge-tree.js" "$TARGET_DIR" "$BASE_DIR" "$WORK_DIR" "$MERGED_DIR" || MERGE_STATUS=$?

if (( MERGE_STATUS == 2 )); then
    CONFLICT_DIR="$REPO_DIR/.quick-image-gen-merge"
    rm -rf "$CONFLICT_DIR"
    mkdir -p "$CONFLICT_DIR"
    cp -R "$MERGED_DIR/." "$CONFLICT_DIR/"
    echo "Conflicted merge output written to $CONFLICT_DIR. Resolve the markers, copy the files into $TARGET_DIR, then re-run with --base $UPSTREAM_COMMIT." >&2
    exit 1
fi

if (( MERGE_STATUS != 0 )); then
    exit "$MERGE_STATUS"
fi

RECORDED_COMMIT="$(read_state commit)"
if diff -qr "$MERGED_DIR" "$TARGET_DIR" >/dev/null && [[ "$RECORDED_COMMIT" == "$UPSTREAM_COMMIT" ]]; then
    echo "Quick Image Gen is already in sync with $UPSTREAM_REF ($UPSTREAM_SHORT_COMMIT), version $UPSTREAM_VERSION."
    exit 0
fi

rm -rf "$TARGET_DIR"
cp -R "$MERGED_DIR" "$TARGET_DIR"

node -e "
const fs = require('fs');
const [statePath, repo, ref, commit, version] = process.argv.slice(1);
fs.writeFileSync(statePath, \`\${JSON.stringify({ repo, ref, commit, version }, null, 2)}\n\`);
" "$STATE_FILE" "$UPSTREAM_REPO" "$UPSTREAM_REF" "$UPSTREAM_COMMIT" "$UPSTREAM_VERSION"

echo "Synced Quick Image Gen to version $UPSTREAM_VERSION from $UPSTREAM_REF ($UPSTREAM_SHORT_COMMIT)."
