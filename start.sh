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

is_termux() {
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
            # macOS — Bun CPU bug confirmed on all Mac architectures
            if command -v node >/dev/null 2>&1; then
                echo "[SillyBunny] macOS detected — using Node.js to avoid Bun CPU overhead (oven-sh/bun#26415)"
                return 0
            fi
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

if (( ${#prereq_args[@]} )); then
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

    if command -v git >/dev/null 2>&1 \
        && git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
        && git ls-files --error-unmatch package-lock.json >/dev/null 2>&1 \
        && git diff --quiet -- package-lock.json; then
        restore_package_lock_after_install=1
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

    if command -v git >/dev/null 2>&1 \
        && git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
        && git ls-files --error-unmatch bun.lock >/dev/null 2>&1 \
        && git diff --quiet -- bun.lock; then
        restore_bun_lock_after_install=1
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

if ! "$RUNTIME_CMD" "$SCRIPT_DIR/scripts/dependency-state.js" check "$dependency_profile" >/dev/null 2>&1; then
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

    run_package_install

    if (( restore_package_lock_after_install )) && ! git diff --quiet -- package-lock.json; then
        echo "Restoring tracked package-lock.json after npm metadata rewrite..."
        git restore -- package-lock.json
    fi

    if (( restore_bun_lock_after_install )) && ! git diff --quiet -- bun.lock; then
        echo "Restoring tracked bun.lock after Bun lockfile refresh..."
        git restore -- bun.lock
    fi

    "$RUNTIME_CMD" "$SCRIPT_DIR/scripts/dependency-state.js" mark "$dependency_profile"
else
    echo "Dependencies are up to date."
fi

"$PACKAGE_MANAGER_CMD" run init

if is_truthy "${SILLYBUNNY_BUN_SMOL:-}" && [[ "$runtime_kind" == node ]]; then
    echo "[SillyBunny] SILLYBUNNY_BUN_SMOL is set, but this host resolved to Node.js — --smol is a Bun flag and will be ignored."
    echo "[SillyBunny] For Bun with --smol, use ./start-bun.sh (Termux: bash start-termux-bun.sh)."
fi

echo "Entering SillyBunny..."
export NODE_NO_WARNINGS=1
export SILLYBUNNY_LAUNCHER=1

restart_exit_code=75
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

    if (( server_exit_code == restart_exit_code )); then
        ((server_restart_count += 1))
        echo "Restarting SillyBunny..."
        continue
    fi

    exit "$server_exit_code"
done
