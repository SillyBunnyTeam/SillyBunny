#!/usr/bin/env bash

set -euo pipefail

require_bun=1
require_git=0
require_node_runtime=0

while (($#)); do
    case "$1" in
        --require-git)
            require_git=1
            ;;
        --require-node-runtime|--require-node|--node-runtime)
            require_node_runtime=1
            ;;
        --skip-bun|--no-bun)
            require_bun=0
            ;;
        --require-bun)
            require_bun=1
            ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 1
            ;;
    esac
    shift
done

OS_NAME="$(uname -s 2>/dev/null || echo unknown)"
BUN_INSTALL_DIR="${BUN_INSTALL:-$HOME/.bun}"
TERMUX_PREFIX_DEFAULT='/data/data/com.termux/files/usr'
TERMUX_PREFIX="${PREFIX:-$TERMUX_PREFIX_DEFAULT}"
TERMUX_GLIBC_ROOT="${GLIBC_ROOT:-$TERMUX_PREFIX/glibc}"
TERMUX_BUN_WRAPPER_MARKER='SillyBunny Termux Bun wrapper'
# Pinned to bun-termux-manager v1.0.1. This script is piped into bash, so it is
# tracked by commit rather than by branch.
TERMUX_BUN_MANAGER_COMMIT='b9f47733b0198d59dc9775a487a8a731cde322cb'
TERMUX_BUN_MANAGER_URL="https://raw.githubusercontent.com/Happ1ness-dev/bun-termux/$TERMUX_BUN_MANAGER_COMMIT/helper_scripts/bun-termux-manager"
TERMUX_BUN_SOURCE_DIR="${TERMUX_BUN_SOURCE_DIR:-$HOME/bun-termux}"
TERMUX_BUN_SHIM_PATH="$BUN_INSTALL_DIR/lib/bun-shim.so"

have_command() {
    command -v "$1" >/dev/null 2>&1
}

is_termux() {
    if [[ -n "${TERMUX_VERSION:-}" ]]; then
        return 0
    fi

    if [[ "${PREFIX:-}" == "$TERMUX_PREFIX_DEFAULT" ]]; then
        return 0
    fi

    if [[ "$HOME" == /data/data/com.termux/files/home* && -x "$TERMUX_PREFIX_DEFAULT/bin/pkg" ]]; then
        return 0
    fi

    return 1
}

have_working_bun() {
    have_command bun && bun --version >/dev/null 2>&1
}

have_working_termux_bun() {
    local bun_path="$BUN_INSTALL_DIR/bin/bun"

    if ! is_termux; then
        return 1
    fi

    if [[ ! -x "$bun_path" ]]; then
        if ! have_command bun; then
            return 1
        fi

        bun_path="$(command -v bun)"
    fi

    "$bun_path" --version >/dev/null 2>&1 \
        && [[ -x "$BUN_INSTALL_DIR/bin/buno" ]] \
        && [[ -f "$TERMUX_BUN_SHIM_PATH" ]]
}

have_working_git() {
    have_command git && git --version >/dev/null 2>&1
}

have_working_node_runtime() {
    have_command node && node --version >/dev/null 2>&1 && have_command npm && npm --version >/dev/null 2>&1
}

add_to_path() {
    local candidate="$1"

    if [[ -z "$candidate" || ! -d "$candidate" ]]; then
        return
    fi

    case ":$PATH:" in
        *":$candidate:"*)
            ;;
        *)
            export PATH="$candidate:$PATH"
            ;;
    esac
}

refresh_known_paths() {
    add_to_path "$BUN_INSTALL_DIR/bin"
    if is_termux; then
        add_to_path "$TERMUX_PREFIX/bin"
    fi
    add_to_path /opt/homebrew/bin
    add_to_path /usr/local/bin
}

run_with_privilege() {
    if (( EUID == 0 )); then
        "$@"
        return
    fi

    if have_command sudo; then
        sudo "$@"
        return
    fi

    echo "Automatic package installation requires root access or sudo." >&2
    exit 1
}

install_linux_packages() {
    local packages=("$@")

    if have_command apt-get; then
        run_with_privilege apt-get update
        run_with_privilege apt-get install -y "${packages[@]}"
        return
    fi

    if have_command dnf; then
        run_with_privilege dnf install -y "${packages[@]}"
        return
    fi

    if have_command yum; then
        run_with_privilege yum install -y "${packages[@]}"
        return
    fi

    if have_command pacman; then
        run_with_privilege pacman -Sy --noconfirm "${packages[@]}"
        return
    fi

    if have_command zypper; then
        run_with_privilege zypper --non-interactive install "${packages[@]}"
        return
    fi

    if have_command apk; then
        run_with_privilege apk add --no-cache "${packages[@]}"
        return
    fi

    if have_command pkg; then
        pkg install -y "${packages[@]}"
        return
    fi

    echo "Unable to install packages automatically on this system." >&2
    echo "Please install the following manually: ${packages[*]}" >&2
    exit 1
}

ensure_download_tool() {
    if have_command curl || have_command wget; then
        return
    fi

    echo "A download tool was not found. Installing curl automatically..."

    case "$OS_NAME" in
        Linux|GNU/Linux)
            install_linux_packages curl
            ;;
        *)
            echo "Neither curl nor wget is available." >&2
            echo "Install curl manually so Bun can be downloaded from https://bun.sh/." >&2
            exit 1
            ;;
    esac
}

termux_glibc_runner_path() {
    if have_command grun; then
        command -v grun
        return 0
    fi

    if [[ -x "$TERMUX_PREFIX/bin/grun" ]]; then
        printf '%s\n' "$TERMUX_PREFIX/bin/grun"
        return 0
    fi

    return 1
}

# bun-termux needs the glibc dynamic linker, not just the 'grun' launcher, and it
# aborts on a missing linker with an error that names glibc-repo/glibc-runner as
# unavailable even when 'grun' resolves fine. Check both signals so a half
# provisioned glibc is repaired here instead of failing later inside bun-termux.
termux_glibc_ready() {
    termux_glibc_runner_path >/dev/null 2>&1 \
        && compgen -G "$TERMUX_GLIBC_ROOT/lib/ld-linux-*.so.*" >/dev/null 2>&1
}

install_termux_glibc_runner() {
    if ! is_termux; then
        return 0
    fi

    if termux_glibc_ready; then
        return 0
    fi

    echo "Termux detected. Installing glibc support for Bun..."
    if have_command pkg; then
        pkg update -y || true
        if ! pkg install -y glibc-repo || ! pkg install -y glibc-runner; then
            echo "Termux could not install the glibc packages Bun depends on." >&2
            echo "Run 'pkg update && pkg install glibc-repo glibc-runner' manually to see why, then rerun this launcher." >&2
            echo "To start now without Bun, use Node.js instead: bash start-termux-node.sh" >&2
            exit 1
        fi
    else
        install_linux_packages glibc-repo
        install_linux_packages glibc-runner
    fi
    refresh_known_paths

    if ! termux_glibc_ready; then
        echo "Termux glibc support installation finished, but Bun still cannot run through it in this session." >&2
        if ! termux_glibc_runner_path >/dev/null 2>&1; then
            echo "'grun' is unavailable on PATH." >&2
        else
            echo "'grun' resolves, but no glibc dynamic linker was found in '$TERMUX_GLIBC_ROOT/lib'." >&2
            echo "Reinstall with 'pkg install --reinstall glibc-runner', or set GLIBC_ROOT if your glibc lives elsewhere." >&2
        fi
        echo "To start now without Bun, use Node.js instead: bash start-termux-node.sh" >&2
        exit 1
    fi
}

install_termux_bun_manager() {
    if ! is_termux; then
        return 1
    fi

    echo "Termux detected. Installing Bun through bun-termux..."
    ensure_download_tool

    if have_command curl; then
        curl -fsSL "$TERMUX_BUN_MANAGER_URL" | BUN_INSTALL="$BUN_INSTALL_DIR" GLIBC_ROOT="$TERMUX_GLIBC_ROOT" bash -s install --source "$TERMUX_BUN_SOURCE_DIR"
    else
        wget -qO- "$TERMUX_BUN_MANAGER_URL" | BUN_INSTALL="$BUN_INSTALL_DIR" GLIBC_ROOT="$TERMUX_GLIBC_ROOT" bash -s install --source "$TERMUX_BUN_SOURCE_DIR"
    fi
}

is_termux_bun_wrapper() {
    local bun_path="$BUN_INSTALL_DIR/bin/bun"

    [[ -f "$bun_path" ]] && grep -aq "$TERMUX_BUN_WRAPPER_MARKER" "$bun_path"
}

configure_termux_bun_wrapper() {
    local bin_dir="$BUN_INSTALL_DIR/bin"
    local bun_path="$bin_dir/bun"
    local bun_real_path="$bin_dir/buno"
    local glibc_runner

    if ! is_termux; then
        return 1
    fi

    glibc_runner="$(termux_glibc_runner_path)" || return 1

    mkdir -p "$bin_dir"

    if [[ -x "$bun_path" ]] && ! is_termux_bun_wrapper; then
        mv -f "$bun_path" "$bun_real_path"
    fi

    if [[ ! -x "$bun_real_path" ]]; then
        return 1
    fi

    cat >"$bun_path" <<EOF
#!/usr/bin/env bash
set -euo pipefail

# $TERMUX_BUN_WRAPPER_MARKER
REAL_BUN="$bun_real_path"
GLIBC_RUNNER="$glibc_runner"

if [[ ! -x "\$REAL_BUN" ]]; then
    echo "SillyBunny could not find the Termux Bun runtime at '\$REAL_BUN'." >&2
    exit 1
fi

if [[ ! -x "\$GLIBC_RUNNER" ]]; then
    echo "SillyBunny could not find Termux glibc-runner at '\$GLIBC_RUNNER'." >&2
    exit 1
fi

exec "\$GLIBC_RUNNER" "\$REAL_BUN" "\$@"
EOF
    chmod +x "$bun_path"
}

repair_termux_bun() {
    if ! is_termux; then
        return 1
    fi

    if have_working_termux_bun; then
        return 0
    fi

    # Provision glibc first. bun-termux bails out early when the dynamic linker
    # is missing, so delegating this to it turns a fixable glibc problem into an
    # opaque wrapper failure.
    install_termux_glibc_runner

    if install_termux_bun_manager; then
        refresh_known_paths
        have_working_termux_bun && return 0
    fi

    configure_termux_bun_wrapper || return 1
    refresh_known_paths
    have_working_bun
}

install_git() {
    if have_working_git; then
        return
    fi

    echo "Git was not found. Installing it automatically..."

    case "$OS_NAME" in
        Darwin)
            if have_command xcode-select && ! xcode-select -p >/dev/null 2>&1; then
                echo "Opening the macOS Command Line Tools installer..."
                xcode-select --install >/dev/null 2>&1 || true
                echo "Finish installing the Command Line Tools, then rerun the launcher." >&2
                exit 1
            fi

            if have_working_git; then
                return
            fi

            echo "Git still is not available on this Mac." >&2
            echo "Run 'xcode-select --install' or install Git manually, then rerun the launcher." >&2
            exit 1
            ;;
        Linux|GNU/Linux)
            install_linux_packages git
            ;;
        *)
            echo "Automatic Git installation is not supported on this platform." >&2
            echo "Install Git manually from https://git-scm.com/downloads" >&2
            exit 1
            ;;
    esac

    refresh_known_paths

    if ! have_working_git; then
        echo "Git installation finished, but 'git' is still unavailable in this session." >&2
        exit 1
    fi
}

install_node_runtime() {
    if ! (( require_node_runtime )); then
        return
    fi

    if have_working_node_runtime; then
        return
    fi

    echo "Node.js was not found. Installing it automatically..."

    case "$OS_NAME" in
        Linux|GNU/Linux)
            if is_termux; then
                if have_command pkg; then
                    pkg install -y nodejs-lts
                else
                    install_linux_packages nodejs-lts
                fi
            else
                install_linux_packages nodejs npm
            fi
            ;;
        Darwin)
            echo "Automatic Node.js installation is not supported on this platform by this launcher." >&2
            echo "Install Node.js manually, then rerun the launcher." >&2
            exit 1
            ;;
        *)
            echo "Automatic Node.js installation is not supported on this platform." >&2
            echo "Install Node.js manually, then rerun the launcher." >&2
            exit 1
            ;;
    esac

    refresh_known_paths

    if ! have_working_node_runtime; then
        echo "Node.js installation finished, but 'node' and 'npm' are still unavailable in this session." >&2
        exit 1
    fi
}

install_bun() {
    if is_termux; then
        if have_working_termux_bun; then
            return
        fi

        if repair_termux_bun; then
            return
        fi

        echo "Termux Bun installation finished, but a Termux-compatible Bun wrapper is still unavailable in this session." >&2
        echo "SillyBunny uses bun-termux on native Termux so Bun can install packages and run from normal home-directory checkouts." >&2
        echo "If it still fails, rerun with network access or install manually via:" >&2
        echo "curl -fsSL '$TERMUX_BUN_MANAGER_URL' | bash -s install" >&2
        exit 1
    fi

    # Everything below is the non-Termux path; the branch above always returns or exits.
    if have_working_bun; then
        return
    fi

    echo "Bun was not found. Installing it automatically..."

    ensure_download_tool

    if have_command curl; then
        curl -fsSL https://bun.sh/install | bash
    else
        wget -qO- https://bun.sh/install | bash
    fi

    refresh_known_paths

    if ! have_working_bun; then
        echo "Bun installation finished, but 'bun' is still unavailable in this session." >&2
        echo "Install Bun manually from https://bun.sh/" >&2
        exit 1
    fi
}

refresh_known_paths

if (( require_git )); then
    install_git
fi

if (( require_node_runtime )); then
    install_node_runtime
fi

if (( require_bun )); then
    install_bun
fi
