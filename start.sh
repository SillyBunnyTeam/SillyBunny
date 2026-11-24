#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SCRIPT_DIR"

HOST_OS="$(uname -s 2>/dev/null || echo Unknown)"
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
macos_node_bin="${SILLYBUNNY_NODE_INSTALL:-$HOME/.sillybunny/node}/bin"

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

refresh_launcher_paths() {
    if [[ -d "$BUN_INSTALL/bin" ]]; then
        case ":$PATH:" in
            *":$BUN_INSTALL/bin:"*) ;;
            *) export PATH="$BUN_INSTALL/bin:$PATH" ;;
        esac
    fi

    # install-prerequisites.sh installs Node.js here on macOS when no system Node exists.
    if [[ "$HOST_OS" == Darwin && -d "$macos_node_bin" ]]; then
        case ":$PATH:" in
            *":$macos_node_bin:"*) ;;
            *) export PATH="$macos_node_bin:$PATH" ;;
        esac
    fi
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
    local arch
    arch="$(uname -m 2>/dev/null || echo Unknown)"

    case "$HOST_OS" in
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

have_required_prerequisites() {
    if (( auto_update_enabled )) && [[ -e "$SCRIPT_DIR/.git" ]]; then
        if ! command -v git >/dev/null 2>&1; then
            return 1
        fi
    fi

    if (( self_update_only )); then
        return 0
    fi

    if [[ "$runtime_kind" == node ]]; then
        command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1
        return $?
    fi

    if is_termux; then
        resolve_runtime_command bun >/dev/null 2>&1 \
            && [[ -x "$BUN_INSTALL/bin/buno" && -f "$BUN_INSTALL/lib/bun-shim.so" ]]
        return $?
    fi

    resolve_runtime_command bun >/dev/null 2>&1
}

compute_boot_stamp() {
    local git_dir="" head_state="nogit" line="" ref_rel="" ref_sha="" common_rel=""
    local existing_files=() missing_files="" stat_out="" path_item

    if [[ -d "$SCRIPT_DIR/.git" ]]; then
        git_dir="$SCRIPT_DIR/.git"
    elif [[ -f "$SCRIPT_DIR/.git" ]]; then
        IFS= read -r line < "$SCRIPT_DIR/.git" || line=""
        line="${line%$'\r'}"
        if [[ "$line" == gitdir:\ * ]]; then
            git_dir="${line#gitdir: }"
            if [[ "$git_dir" != /* ]]; then
                git_dir="$SCRIPT_DIR/$git_dir"
            fi
        fi
    fi

    if [[ -n "$git_dir" && -f "$git_dir/HEAD" ]]; then
        IFS= read -r head_state < "$git_dir/HEAD" || head_state=""
        head_state="${head_state%$'\r'}"
        if [[ "$head_state" == "ref: "* ]]; then
            ref_rel="${head_state#ref: }"
            if [[ -f "$git_dir/$ref_rel" ]]; then
                IFS= read -r ref_sha < "$git_dir/$ref_rel" || ref_sha=""
                head_state="$head_state@${ref_sha%$'\r'}"
            elif [[ -f "$git_dir/commondir" ]]; then
                IFS= read -r common_rel < "$git_dir/commondir" || common_rel=""
                common_rel="${common_rel%$'\r'}"
                if [[ "$common_rel" != /* ]]; then
                    common_rel="$git_dir/$common_rel"
                fi
                if [[ -f "$common_rel/$ref_rel" ]]; then
                    IFS= read -r ref_sha < "$common_rel/$ref_rel" || ref_sha=""
                    head_state="$head_state@${ref_sha%$'\r'}"
                elif [[ -f "$common_rel/packed-refs" ]]; then
                    existing_files+=("$common_rel/packed-refs")
                fi
            elif [[ -f "$git_dir/packed-refs" ]]; then
                existing_files+=("$git_dir/packed-refs")
            fi
        fi
    fi

    for path_item in package.json package-lock.json bun.lock default/config.yaml; do
        if [[ -f "$SCRIPT_DIR/$path_item" ]]; then
            existing_files+=("$path_item")
        else
            missing_files="$missing_files;$path_item=missing"
        fi
    done

    if (( ${#existing_files[@]} > 0 )); then
        if [[ "$HOST_OS" == Darwin ]]; then
            stat_out="$(stat -f '%N=%m:%z' "${existing_files[@]}" 2>/dev/null | tr '\n' ';')"
        else
            stat_out="$(stat -c '%n=%Y:%s' "${existing_files[@]}" 2>/dev/null | tr '\n' ';')"
            if [[ -z "$stat_out" ]]; then
                stat_out="$(stat -f '%N=%m:%z' "${existing_files[@]}" 2>/dev/null | tr '\n' ';')"
            fi
        fi
    fi

    printf 'v1;%s;%s;%s;%s;%s%s\n' \
        "$runtime_kind" \
        "$dependency_profile" \
        "${NODE_ENV:-}" \
        "$head_state" \
        "$stat_out" \
        "$missing_files"
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

refresh_launcher_paths

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

if (( auto_update_enabled )) && [[ -e "$SCRIPT_DIR/.git" ]]; then
    prereq_args+=(--require-git)
fi

if ! have_required_prerequisites; then
    if (( ${#prereq_args[@]} )); then
        bash "$SCRIPT_DIR/scripts/install-prerequisites.sh" "${prereq_args[@]}"
    else
        bash "$SCRIPT_DIR/scripts/install-prerequisites.sh"
    fi
    refresh_launcher_paths
fi

if (( self_update_requested )); then
    bash "$SCRIPT_DIR/scripts/self-update.sh"
elif (( auto_update_enabled )); then
    bash "$SCRIPT_DIR/scripts/self-update.sh" --optional
fi

if (( self_update_only )); then
    exit 0
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
dependency_profile="${runtime_kind}-production"
if has_existing_dev_dependencies; then
    dependency_profile="${runtime_kind}-development"
fi

install_args=()
restore_package_lock_after_install=0
restore_bun_lock_after_install=0

prepare_package_install() {
    if [[ "$runtime_kind" == node ]]; then
        if [[ -f package-lock.json ]]; then
            install_args=(ci --no-audit --no-fund)
        else
            install_args=(install --no-audit --no-fund)
        fi

        if [[ "$dependency_profile" != *development ]]; then
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
        if [[ "$dependency_profile" != *development ]]; then
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
}

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

boot_stamp_file="$SCRIPT_DIR/node_modules/.cache/.sillybunny-boot-stamp"
boot_stamp="$(compute_boot_stamp)"
warm_boot_hit=0

if ! is_truthy "${SILLYBUNNY_FORCE_INIT:-}" \
    && [[ -f "$boot_stamp_file" ]] \
    && [[ -f "$SCRIPT_DIR/node_modules/.sillybunny-dependencies.json" ]] \
    && [[ -f "$SCRIPT_DIR/config.yaml" ]] \
    && [[ -f "$SCRIPT_DIR/public/index.html" ]] \
    && [[ ! -e "$SCRIPT_DIR/config.conf" ]]; then
    IFS= read -r saved_boot_stamp < "$boot_stamp_file" || saved_boot_stamp=""
    if [[ "$saved_boot_stamp" == "$boot_stamp" ]]; then
        warm_boot_hit=1
    fi
fi

if (( warm_boot_hit )); then
    echo "Dependencies are up to date."
else
    if ! "$RUNTIME_CMD" "$SCRIPT_DIR/scripts/dependency-state.js" check "$dependency_profile" >/dev/null 2>&1; then
        prepare_package_install

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

    "$RUNTIME_CMD" "$SCRIPT_DIR/src/server-init.js"
    mkdir -p "$SCRIPT_DIR/node_modules/.cache"
    printf '%s\n' "$boot_stamp" > "$boot_stamp_file"
fi

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
