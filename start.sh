#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SCRIPT_DIR"

is_truthy() {
    local value
    value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"

    case "$value" in
        1|true|yes|on)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

# SillyBunny: the Android app (android/) sets this. It bundles git, Node.js and
# npm, so it skips the Termux, prerequisite and runtime detection paths.
is_android_app() {
    [[ "${SILLYBUNNY_ANDROID_APP:-}" == 1 ]]
}

is_termux() {
    # SillyBunny: the Android app ships its own tools and paths, so it never takes
    # the Termux paths, even with a Termux variable set.
    if is_android_app; then
        return 1
    fi

    [[ -n "${TERMUX_VERSION:-}" || "${PREFIX:-}" == /data/data/com.termux/files/usr ]]
}

is_termux_shared_storage_repo() {
    if ! is_termux; then
        return 1
    fi

    case "$SCRIPT_DIR" in
        /storage/*|/sdcard/*)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

prefer_node_runtime() {
    # Forced via environment variable
    if is_truthy "${SILLYBUNNY_USE_NODE:-}"; then
        return 0
    fi

    # Forced Bun override for users who accept the ARM/macOS CPU tradeoff
    if is_truthy "${SILLYBUNNY_USE_BUN:-}"; then
        return 1
    fi

    # SillyBunny: the APK bundles Node.js but not Bun.
    if is_android_app; then
        return 0
    fi

    # Termux always prefers Node unless overridden
    if is_termux; then
        case "${SILLYBUNNY_TERMUX_RUNTIME:-auto}" in
            bun) return 1 ;;
            *) return 0 ;;
        esac
    fi

    # macOS and ARM platforms: Bun has high idle CPU usage (oven-sh/bun#26415)
    # Auto-switch to Node.js if available
    local os arch
    os="$(uname -s 2>/dev/null || echo Unknown)"
    arch="$(uname -m 2>/dev/null || echo Unknown)"

    case "$os" in
        Darwin)
            # macOS — Bun CPU bug confirmed on all Mac architectures. The
            # prerequisites step installs Node.js here when it is missing.
            echo "[SillyBunny] macOS detected — using Node.js to avoid Bun CPU overhead (oven-sh/bun#26415)"
            return 0
            ;;
    esac

    case "$arch" in
        aarch64|arm64|armv7l|armv8l)
            # ARM — Bun event loop issue causes 90%+ idle CPU
            if command -v node >/dev/null 2>&1; then
                echo "[SillyBunny] ARM platform detected — using Node.js to avoid Bun CPU overhead (oven-sh/bun#26415)"
                return 0
            fi
            ;;
    esac

    return 1
}

resolve_runtime_command() {
    local runtime_kind="${1:-bun}"

    if [[ "$runtime_kind" == node ]]; then
        if command -v node >/dev/null 2>&1; then
            command -v node
            return 0
        fi

        return 1
    fi

    if command -v bun >/dev/null 2>&1; then
        command -v bun
        return 0
    fi

    if [[ -x "$BUN_INSTALL/bin/bun" ]]; then
        printf '%s\n' "$BUN_INSTALL/bin/bun"
        return 0
    fi

    return 1
}

resolve_package_manager_command() {
    local runtime_kind="${1:-bun}"

    if [[ "$runtime_kind" == node ]]; then
        if command -v npm >/dev/null 2>&1; then
            command -v npm
            return 0
        fi

        return 1
    fi

    resolve_runtime_command bun
}

self_update_requested=0
self_update_only=0
skip_auto_update=0
server_args=()

while (($#)); do
    case "$1" in
        --self-update)
            self_update_requested=1
            ;;
        --self-update-only)
            self_update_requested=1
            self_update_only=1
            ;;
        --skip-self-update)
            skip_auto_update=1
            ;;
        --)
            shift
            server_args+=("$@")
            break
            ;;
        *)
            server_args+=("$1")
            ;;
    esac
    shift
done

if (( ! self_update_only )) && is_termux_shared_storage_repo; then
    echo "[SillyBunny] Termux installs must stay in your Termux home, not Android shared storage." >&2
    echo "[SillyBunny] Android blocks the node_modules links Bun and npm need under paths like /storage/emulated/0." >&2
    echo "[SillyBunny] Reclone into '$HOME/SillyBunny', then rerun this launcher. Use 'termux-setup-storage' only to grant file access." >&2
    exit 1
fi

auto_update_enabled=0
if (( self_update_requested )); then
    auto_update_enabled=1
elif (( ! skip_auto_update )) && is_truthy "${SILLYBUNNY_AUTO_UPDATE:-1}"; then
    auto_update_enabled=1
fi

prereq_args=()
if (( self_update_only )); then
    prereq_args+=(--skip-bun)
fi

runtime_kind=bun
if (( ! self_update_only )) && prefer_node_runtime; then
    runtime_kind=node
    prereq_args+=(--require-node-runtime --skip-bun)
fi

if (( auto_update_enabled )) && [[ -d "$SCRIPT_DIR/.git" ]]; then
    prereq_args+=(--require-git)
fi

if is_android_app; then
    # SillyBunny: the APK ships every prerequisite, and the download tools the
    # installer relies on may not exist on Android.
    :
elif (( ${#prereq_args[@]} )); then
    bash "$SCRIPT_DIR/scripts/install-prerequisites.sh" "${prereq_args[@]}"
else
    bash "$SCRIPT_DIR/scripts/install-prerequisites.sh"
fi

if (( self_update_requested )); then
    bash "$SCRIPT_DIR/scripts/self-update.sh"
elif (( auto_update_enabled )); then
    bash "$SCRIPT_DIR/scripts/self-update.sh" --optional
fi

if (( self_update_only )); then
    exit 0
fi

export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
if [[ -d "$BUN_INSTALL/bin" ]]; then
    export PATH="$BUN_INSTALL/bin:$PATH"
fi

# Where install-prerequisites.sh puts Node.js on macOS.
macos_node_bin="${SILLYBUNNY_NODE_INSTALL:-$HOME/.sillybunny/node}/bin"
if [[ "$(uname -s 2>/dev/null)" == Darwin && -d "$macos_node_bin" ]]; then
    export PATH="$macos_node_bin:$PATH"
fi

if is_termux; then
    export TMPDIR="${TMPDIR:-${PREFIX:-/data/data/com.termux/files/usr}/tmp}"
    mkdir -p "$TMPDIR"
fi

RUNTIME_CMD="$(resolve_runtime_command "$runtime_kind")"
PACKAGE_MANAGER_CMD="$(resolve_package_manager_command "$runtime_kind")"

has_existing_dev_dependencies() {
    [[ -f "$SCRIPT_DIR/node_modules/eslint/package.json" ]]
}

export NODE_ENV=production
install_args=()
restore_package_lock_after_install=0
restore_bun_lock_after_install=0
dependency_profile="${runtime_kind}-production"
if [[ "$runtime_kind" == node ]]; then
    if [[ -f package-lock.json ]]; then
        install_args=(ci --no-audit --no-fund)
    else
        install_args=(install --no-audit --no-fund)
    fi

    if has_existing_dev_dependencies; then
        dependency_profile=node-development
    else
        install_args+=(--omit=dev)
    fi
else
    install_args=(install --frozen-lockfile --no-progress --no-summary)
    if has_existing_dev_dependencies; then
        dependency_profile=bun-development
    else
        install_args+=(--production)
    fi

    if is_termux; then
        install_args+=(--backend=copyfile)
    fi
fi

run_package_install() {
    if [[ "$runtime_kind" != bun ]]; then
        "$PACKAGE_MANAGER_CMD" "${install_args[@]}"
        return
    fi

    if "$PACKAGE_MANAGER_CMD" "${install_args[@]}"; then
        return
    fi

    local fallback_args=()
    local arg
    for arg in "${install_args[@]}"; do
        if [[ "$arg" != --frozen-lockfile ]]; then
            fallback_args+=("$arg")
        fi
    done

    echo "Bun lockfile check failed; retrying without --frozen-lockfile so bun.lock can refresh."
    "$PACKAGE_MANAGER_CMD" "${fallback_args[@]}"
}

# SillyBunny: fast warm-boot stamp helpers avoid extra Node and npm spawns on unchanged Android launches.
android_git_head() {
    local head_file="$SCRIPT_DIR/.git/HEAD"
    local line ref_path
    [[ -f "$head_file" ]] || return 1
    IFS= read -r line < "$head_file" || return 1
    if [[ "$line" == ref:\ * ]]; then
        ref_path="$SCRIPT_DIR/.git/${line#ref: }"
        if [[ -f "$ref_path" ]]; then
            IFS= read -r line < "$ref_path" || return 1
            printf '%s' "$line"
            return 0
        fi
        git rev-parse HEAD 2>/dev/null && return 0
        return 1
    fi
    printf '%s' "$line"
}

android_file_stamp() {
    local target="$1"
    if [[ ! -f "$target" ]]; then
        printf 'missing'
        return
    fi
    stat -c '%s:%Y' "$target" 2>/dev/null || stat -f '%z:%m' "$target" 2>/dev/null || printf 'present'
}

android_boot_stamp_key() {
    local head_sha
    head_sha="$(android_git_head)" || return 1
    [[ -n "$head_sha" ]] || return 1
    printf 'v1|%s|%s|%s|%s|%s|%s' \
        "$dependency_profile" \
        "$head_sha" \
        "${SILLYBUNNY_ANDROID_APP_VERSION_CODE:-}" \
        "$(android_file_stamp "$SCRIPT_DIR/package.json")" \
        "$(android_file_stamp "$SCRIPT_DIR/package-lock.json")" \
        "$(android_file_stamp "$SCRIPT_DIR/default/config.yaml")"
}

android_fast_boot_valid() {
    local stamp_file="$SCRIPT_DIR/node_modules/.sillybunny-android-boot-stamp"
    local expected actual
    is_android_app || return 1
    [[ "$runtime_kind" == node ]] || return 1
    [[ -d "$SCRIPT_DIR/node_modules" && -f "$SCRIPT_DIR/node_modules/.sillybunny-dependencies.json" ]] || return 1
    [[ -f "$SCRIPT_DIR/config.yaml" && ! -f "$SCRIPT_DIR/config.conf" ]] || return 1
    [[ -f "$stamp_file" ]] || return 1
    expected="$(android_boot_stamp_key)" || return 1
    IFS= read -r actual < "$stamp_file" || return 1
    [[ "$actual" == "$expected" ]]
}

write_android_boot_stamp() {
    local stamp_file="$SCRIPT_DIR/node_modules/.sillybunny-android-boot-stamp"
    local stamp_tmp="$stamp_file.tmp.$$"
    local value
    is_android_app || return 0
    [[ "$runtime_kind" == node ]] || return 0
    [[ -d "$SCRIPT_DIR/node_modules" && -f "$SCRIPT_DIR/config.yaml" && ! -f "$SCRIPT_DIR/config.conf" ]] || return 0
    value="$(android_boot_stamp_key)" || return 0
    if printf '%s\n' "$value" > "$stamp_tmp" 2>/dev/null; then
        mv -f "$stamp_tmp" "$stamp_file" 2>/dev/null || rm -f "$stamp_tmp" 2>/dev/null || true
    fi
}

cleanup_android_npm_cache() {
    is_android_app || return 0
    [[ "$runtime_kind" == node ]] || return 0
    if [[ -n "${HOME:-}" && -d "$HOME/.npm" ]]; then
        rm -rf "$HOME/.npm" || true
    fi
    if [[ -n "${TMPDIR:-}" && -d "$TMPDIR/npm-cache" ]]; then
        rm -rf "$TMPDIR/npm-cache" || true
    fi
}

# SillyBunny: zero-feature-loss Android node_modules prune (keeps sillytavern-transformers active WASMs and all package.json).
prune_android_node_modules() {
    is_android_app || return 0
    [[ "$runtime_kind" == node ]] || return 0
    [[ -d "$SCRIPT_DIR/node_modules" ]] || return 0
    "$RUNTIME_CMD" -e '
        const fs = require("node:fs");
        const path = require("node:path");
        const nmRoot = process.argv[1];
        if (!nmRoot) process.exit(0);
        const removableDirs = new Set(["docs", "test", "tests", "__tests__"]);
        const dupOrtWasms = [
            "ort-wasm-simd-threaded.wasm",
            "ort-wasm-simd.wasm",
            "ort-wasm-threaded.wasm",
            "ort-wasm.wasm",
        ];
        const hasPackageJson = (dir) => {
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return true; }
            for (const entry of entries) {
                if (entry.isSymbolicLink()) continue;
                if (entry.name === "package.json") return true;
                if (entry.isDirectory() && hasPackageJson(path.join(dir, entry.name))) return true;
            }
            return false;
        };
        const pruneDir = (dir, atPackageRoot) => {
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                if (entry.isSymbolicLink()) continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === "node_modules") {
                        walkNodeModules(full);
                        continue;
                    }
                    if (atPackageRoot && removableDirs.has(entry.name) && !hasPackageJson(full)) {
                        try { fs.rmSync(full, { recursive: true, force: true }); } catch {}
                        continue;
                    }
                    pruneDir(full, false);
                } else if (entry.isFile()) {
                    if (entry.name === "package.json") continue;
                    if (entry.name.endsWith(".map") || /\.d\.(?:ts|mts|cts)$/.test(entry.name)) {
                        try { fs.unlinkSync(full); } catch {}
                    }
                }
            }
        };
        const walkNodeModules = (root) => {
            let entries;
            try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                if (entry.isSymbolicLink() || !entry.isDirectory() || entry.name.startsWith(".")) continue;
                const full = path.join(root, entry.name);
                if (entry.name.startsWith("@")) {
                    let scoped;
                    try { scoped = fs.readdirSync(full, { withFileTypes: true }); } catch { continue; }
                    for (const pkg of scoped) {
                        if (!pkg.isSymbolicLink() && pkg.isDirectory()) pruneDir(path.join(full, pkg.name), true);
                    }
                } else {
                    pruneDir(full, true);
                }
            }
        };
        walkNodeModules(nmRoot);
        const transformersDist = path.join(nmRoot, "sillytavern-transformers", "dist");
        const ortDist = path.join(nmRoot, "onnxruntime-web", "dist");
        const activeWasmsPresent = dupOrtWasms.every((name) => {
            try {
                const st = fs.lstatSync(path.join(transformersDist, name));
                return !st.isSymbolicLink() && st.isFile() && st.size > 0;
            } catch {
                return false;
            }
        });
        if (activeWasmsPresent) {
            for (const name of dupOrtWasms) {
                const dup = path.join(ortDist, name);
                try {
                    const st = fs.lstatSync(dup);
                    if (!st.isSymbolicLink() && st.isFile()) fs.unlinkSync(dup);
                } catch {}
            }
        }
    ' "$SCRIPT_DIR/node_modules" || true
}

# SillyBunny: optional manifest-verified prebuilt node_modules bundle for Android first-run installs.
resolve_android_node_modules_bundle_dir() {
    if [[ -n "${SILLYBUNNY_ANDROID_NODE_MODULES_BUNDLE_DIR:-}" ]]; then
        printf '%s' "$SILLYBUNNY_ANDROID_NODE_MODULES_BUNDLE_DIR"
        return 0
    fi
    if [[ -n "${OPENSSL_MODULES:-}" ]]; then
        printf '%s/node_modules-bundle' "$(dirname "$OPENSSL_MODULES")"
        return 0
    fi
    if [[ -n "${SILLYBUNNY_ANDROID_NPM_CLI:-}" ]]; then
        local runtime_root="${SILLYBUNNY_ANDROID_NPM_CLI%/lib/node_modules/npm/bin/npm-cli.js}"
        if [[ "$runtime_root" != "$SILLYBUNNY_ANDROID_NPM_CLI" ]]; then
            printf '%s/node_modules-bundle' "$runtime_root"
            return 0
        fi
    fi
    return 1
}

try_install_android_node_modules_bundle() {
    local bundle_dir
    is_android_app || return 1
    [[ "$runtime_kind" == node && "$dependency_profile" == node-production ]] || return 1
    [[ -f "$SCRIPT_DIR/package-lock.json" && -f "$SCRIPT_DIR/scripts/build-android-node-modules-bundle.mjs" ]] || return 1
    bundle_dir="$(resolve_android_node_modules_bundle_dir)" || return 1
    [[ -d "$bundle_dir" && -f "$bundle_dir/node_modules.manifest.json" ]] || return 1

    if "$RUNTIME_CMD" "$SCRIPT_DIR/scripts/build-android-node-modules-bundle.mjs" \
        --install \
        --bundle-dir "$bundle_dir" \
        --project-dir "$SCRIPT_DIR" >/dev/null 2>&1; then
        echo "Installed prebuilt Android node_modules bundle."
        return 0
    fi

    echo "Prebuilt Android node_modules bundle unavailable or mismatched; falling back to npm..."
    return 1
}

if android_fast_boot_valid; then
    echo "Dependencies are up to date."
else
    if ! "$RUNTIME_CMD" "$SCRIPT_DIR/scripts/dependency-state.js" check "$dependency_profile" >/dev/null 2>&1; then
        if try_install_android_node_modules_bundle; then
            "$RUNTIME_CMD" "$SCRIPT_DIR/scripts/dependency-state.js" mark "$dependency_profile"
        else
            if [[ "$dependency_profile" == *development ]]; then
                if [[ "$runtime_kind" == node ]]; then
                    echo "Installing packages via npm including development tooling (Node.js mode)..."
                else
                    echo "Installing Bun packages including development tooling..."
                fi
            elif [[ "$runtime_kind" == node ]]; then
                echo "Installing packages via npm (Node.js mode)..."
            else
                echo "Installing Bun packages..."
            fi

            if [[ "$runtime_kind" == node ]]; then
                if command -v git >/dev/null 2>&1 \
                    && git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
                    && git ls-files --error-unmatch package-lock.json >/dev/null 2>&1 \
                    && git diff --quiet -- package-lock.json; then
                    restore_package_lock_after_install=1
                fi
            else
                if command -v git >/dev/null 2>&1 \
                    && git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
                    && git ls-files --error-unmatch bun.lock >/dev/null 2>&1 \
                    && git diff --quiet -- bun.lock; then
                    restore_bun_lock_after_install=1
                fi
            fi

            run_package_install
            cleanup_android_npm_cache
            prune_android_node_modules

            if (( restore_package_lock_after_install )) && ! git diff --quiet -- package-lock.json; then
                echo "Restoring tracked package-lock.json after npm metadata rewrite..."
                git restore -- package-lock.json
            fi

            if (( restore_bun_lock_after_install )) && ! git diff --quiet -- bun.lock; then
                echo "Restoring tracked bun.lock after Bun lockfile refresh..."
                git restore -- bun.lock
            fi

            "$RUNTIME_CMD" "$SCRIPT_DIR/scripts/dependency-state.js" mark "$dependency_profile"
        fi
    else
        echo "Dependencies are up to date."
    fi

    "$PACKAGE_MANAGER_CMD" run init
    write_android_boot_stamp
fi

if is_truthy "${SILLYBUNNY_BUN_SMOL:-}" && [[ "$runtime_kind" == node ]]; then
    echo "[SillyBunny] SILLYBUNNY_BUN_SMOL is set, but this host resolved to Node.js — --smol is a Bun flag and will be ignored."
    echo "[SillyBunny] For Bun with --smol, use ./start-bun.sh (Termux: bash start-termux-bun.sh)."
fi

echo "Entering SillyBunny..."
export NODE_NO_WARNINGS=1
export SILLYBUNNY_LAUNCHER=1

restart_exit_code=75
supervisor_reload_exit_code=77
server_restart_count=0

run_server() {
    if [[ "$runtime_kind" == node ]]; then
        "$RUNTIME_CMD" --no-warnings server.js "$@"
    elif is_truthy "${SILLYBUNNY_BUN_SMOL:-}"; then
        # Bun grows the JSC heap freely while RAM looks plentiful, so on small
        # hosts RSS sawtooths by more than a gigabyte between collections.
        # --smol trades throughput for much more aggressive GC, matching the
        # start:mobile script in package.json.
        "$RUNTIME_CMD" --smol server.js "$@"
    else
        "$RUNTIME_CMD" server.js "$@"
    fi
}

while true; do
    if (( server_restart_count > 0 )); then
        export SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH=1
    fi

    if (( ${#server_args[@]} )); then
        if run_server "${server_args[@]}"; then
            server_exit_code=0
        else
            server_exit_code=$?
        fi
    else
        if run_server; then
            server_exit_code=0
        else
            server_exit_code=$?
        fi
    fi

    if (( server_exit_code == restart_exit_code || server_exit_code == supervisor_reload_exit_code )); then
        ((server_restart_count += 1))
        echo "Restarting SillyBunny..."
        continue
    fi

    exit "$server_exit_code"
done
