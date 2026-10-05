#!/usr/bin/env bash
# SillyBunny bootstrap installer for Linux, macOS and Termux.
#
# Runs before the repository exists (usually as `curl -fsSL <url> | bash`), so it
# must stay self-contained: no sourcing of repo scripts until after the clone.
# Everything lives in main(), called on the last line, so a truncated download
# never runs a partial script.

set -euo pipefail

DEFAULT_REPO='https://github.com/SillyBunnyTeam/SillyBunny.git'
DEFAULT_REF='release'
PROJECT_NAME='sillybunny'

install_dir=''
ref="$DEFAULT_REF"
ref_overridden=0
repo="$DEFAULT_REPO"
migrate_from=''
start_after=1
runtime_override=''
migrated_items=()
# File name of this script; stays empty under `curl | bash`, where no file exists.
installer_name=''

# Track whether any arguments were passed so main() can decide whether to show
# the interactive wizard.
_argc=$#

log() {
    printf '[SillyBunny] %s\n' "$*"
}

die() {
    printf '[SillyBunny] %s\n' "$*" >&2
    exit 1
}

usage() {
    cat <<'EOF'
Usage: install.sh [options]

Installs SillyBunny as a Git checkout so it can update itself.
Re-running it on an existing install updates that install instead.

Run with no options for an interactive setup wizard.

Options:
  --dir <path>            Install directory (default: ~/SillyBunny)
  --ref <branch-or-tag>   Branch or tag to install (default: release)
  --repo <url-or-path>    Repository to clone (default: the official repository)
  --migrate-from <path>   Copy data, settings, plugins and extensions from an
                          old non-Git (ZIP) install. The old folder is not changed.
  --use-bun               Force Bun as the runtime (default on Linux/Windows)
  --use-node              Force Node.js as the runtime (default on macOS)
  --no-start              Install only; do not start SillyBunny afterwards
  -h, --help              Show this help
EOF
}

have_command() {
    command -v "$1" >/dev/null 2>&1
}

is_termux() {
    [[ -n "${TERMUX_VERSION:-}" || "${PREFIX:-}" == /data/data/com.termux/files/usr ]]
}

require_value() {
    local flag="$1"
    local value="${2-}"

    if [[ -z "$value" || "$value" == -* ]]; then
        die "$flag needs a value."
    fi
}

parse_args() {
    while (($#)); do
        case "$1" in
            --dir)
                require_value "$1" "${2-}"
                install_dir="$2"
                shift
                ;;
            --ref)
                require_value "$1" "${2-}"
                ref="$2"
                ref_overridden=1
                shift
                ;;
            --repo)
                require_value "$1" "${2-}"
                repo="$2"
                shift
                ;;
            --migrate-from)
                require_value "$1" "${2-}"
                migrate_from="$2"
                shift
                ;;
            --use-bun)
                runtime_override='bun'
                ;;
            --use-node)
                runtime_override='node'
                ;;
            --no-start)
                start_after=0
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            *)
                usage >&2
                die "Unknown option: $1"
                ;;
        esac
        shift
    done
}

# Absolute, symlink-resolved path, even when the path does not exist yet: the
# nearest existing parent is resolved and the missing tail appended. Termux's
# ~/storage/shared is a symlink into /storage, so resolving matters there.
resolve_path() {
    local path="$1"
    local tail=''

    # A quoted --dir '~/x' arrives unexpanded; match the literal tilde.
    # shellcheck disable=SC2088
    case "$path" in
        '~') path="$HOME" ;;
        '~/'*) path="$HOME/${path#\~/}" ;;
    esac

    if [[ "$path" != /* ]]; then
        path="$PWD/$path"
    fi

    while [[ "$path" != / && "$path" == */ ]]; do
        path="${path%/}"
    done

    while [[ ! -d "$path" ]]; do
        tail="/${path##*/}$tail"
        path="${path%/*}"
        if [[ -z "$path" ]]; then
            path=/
            break
        fi
    done

    path="$(cd "$path" && pwd -P)"
    if [[ "$path" == / ]]; then
        printf '%s\n' "${tail:-/}"
    else
        printf '%s%s\n' "$path" "$tail"
    fi
}

is_shared_storage_path() {
    case "$1" in
        /storage|/storage/*|/sdcard|/sdcard/*) return 0 ;;
        *) return 1 ;;
    esac
}

is_sillybunny_dir() {
    [[ -f "$1/package.json" ]] && grep -Eq "\"name\"[[:space:]]*:[[:space:]]*\"$PROJECT_NAME\"" "$1/package.json"
}

is_empty_dir() {
    [[ -d "$1" ]] && [[ -z "$(ls -A "$1")" ]]
}

# git clones only into an empty folder, and people often save the installer into
# the folder they want to install to.
holds_installer() {
    [[ -n "$installer_name" && -f "$1/$installer_name" ]]
}

run_with_privilege() {
    if (( EUID == 0 )); then
        "$@"
    elif have_command sudo; then
        sudo "$@"
    else
        die "Installing Git needs root access or sudo. Install Git manually, then rerun this installer."
    fi
}

have_working_git() {
    have_command git && git --version >/dev/null 2>&1
}

install_git() {
    if have_working_git; then
        return
    fi

    log 'Git was not found. Installing it...'

    if is_termux; then
        pkg install -y git
    else
        case "$(uname -s 2>/dev/null || echo unknown)" in
            Darwin)
                # /usr/bin/git is a shim until the Command Line Tools exist.
                xcode-select --install >/dev/null 2>&1 || true
                die 'Finish installing the macOS Command Line Tools in the window that opened, then rerun this installer.'
                ;;
            Linux)
                if have_command apt-get; then
                    run_with_privilege apt-get update
                    run_with_privilege apt-get install -y git
                elif have_command dnf; then
                    run_with_privilege dnf install -y git
                elif have_command yum; then
                    run_with_privilege yum install -y git
                elif have_command pacman; then
                    run_with_privilege pacman -Sy --noconfirm git
                elif have_command zypper; then
                    run_with_privilege zypper --non-interactive install git
                elif have_command apk; then
                    run_with_privilege apk add --no-cache git
                else
                    die 'No supported package manager found. Install Git from https://git-scm.com/downloads, then rerun this installer.'
                fi
                ;;
            *)
                die 'Automatic Git installation is not supported here. Install Git from https://git-scm.com/downloads, then rerun this installer.'
                ;;
        esac
    fi

    hash -r
    have_working_git || die "Git was installed, but 'git' is still unavailable in this shell."
}

# Prints the data root relative to the install folder, or an absolute path.
read_data_root() {
    local config="$1/config.yaml"
    local value=''

    if [[ -f "$config" ]]; then
        value="$(sed -n 's/^dataRoot:[[:space:]]*//p' "$config" | head -n 1)"
        value="${value%%#*}"
        value="${value%$'\r'}"
        value="$(printf '%s' "$value" | sed -e 's/[[:space:]]*$//' -e "s/^[\"']//" -e "s/[\"']\$//")"
    fi

    printf '%s\n' "${value:-./data}"
}

validate_migration_source() {
    [[ -d "$migrate_from" ]] || die "The folder to migrate from does not exist: $migrate_from"
    is_sillybunny_dir "$migrate_from" || die "This doesn't look like a SillyBunny folder: $migrate_from"

    if [[ -d "$migrate_from/.git" ]]; then
        # A proper bootstrap-managed Git install has scripts/self-update.sh alongside
        # .git. Old ZIP releases that were packaged from a git clone also contain .git
        # but do not have the self-update script, so migration from them is allowed.
        if [[ -f "$migrate_from/scripts/self-update.sh" ]]; then
            die "$migrate_from is already a Git install and updates itself. Run its start.sh instead of migrating."
        fi
        log "Note: $migrate_from contains a .git folder but no self-update script; treating it as a ZIP release."
    fi

    if [[ "$migrate_from" == "$install_dir" ]]; then
        die "The old install is at the target folder. Pick a new folder with --dir, for example: --dir \"$HOME/SillyBunny-new\""
    fi

    case "$install_dir/" in
        "$migrate_from/"*) die 'The new install folder cannot be inside the old one.' ;;
    esac

    local data_root
    data_root="$(read_data_root "$migrate_from")"
    if [[ "$data_root" != /* ]]; then
        data_root="${data_root#./}"
        case "/$data_root/" in
            */../*|//) die "The old config.yaml has a dataRoot outside its folder ($data_root). Set an absolute dataRoot there, then rerun." ;;
        esac
    fi
}

# Copies the entries of an old folder, skipping anything the new clone tracks
# (bundled plugins and extensions stay at the version that was just installed).
copy_untracked_entries() {
    local relative="$1"
    local source="$migrate_from/$relative"
    local target="$install_dir/$relative"
    local entry name

    [[ -d "$source" ]] || return 0
    mkdir -p "$target"

    for entry in "$source"/* "$source"/.[!.]* "$source"/..?*; do
        [[ -e "$entry" || -L "$entry" ]] || continue
        name="${entry##*/}"
        if git -C "$install_dir" ls-files --error-unmatch -- "$relative/$name" >/dev/null 2>&1; then
            continue
        fi
        cp -Rp "$entry" "$target/"
        migrated_items+=("$relative/$name")
    done
}

migrate_old_install() {
    local data_root

    log "Copying your data from $migrate_from. The old folder is left as it is."

    if [[ -f "$migrate_from/config.yaml" ]]; then
        cp -p "$migrate_from/config.yaml" "$install_dir/config.yaml"
        migrated_items+=('config.yaml')
    fi

    data_root="$(read_data_root "$migrate_from")"
    if [[ "$data_root" == /* ]]; then
        log "Your data root is $data_root, outside the old folder; the new install will keep using it."
    else
        data_root="${data_root#./}"
        if [[ -d "$migrate_from/$data_root" ]]; then
            mkdir -p "$install_dir/$data_root"
            cp -Rp "$migrate_from/$data_root/." "$install_dir/$data_root/"
            migrated_items+=("$data_root/")
        fi
    fi

    copy_untracked_entries plugins
    copy_untracked_entries public/scripts/extensions/third-party

    if [[ -f "$migrate_from/secrets.json" ]]; then
        cp -p "$migrate_from/secrets.json" "$install_dir/secrets.json"
        migrated_items+=('secrets.json')
    fi

    if [[ -d "$migrate_from/certs" ]]; then
        cp -Rp "$migrate_from/certs" "$install_dir/"
        migrated_items+=('certs/')
    fi

    if (( ${#migrated_items[@]} )); then
        log 'Copied:'
        printf '    %s\n' "${migrated_items[@]}"
    else
        log 'Nothing to copy was found in the old folder.'
    fi
}

clone_install() {
    log "Downloading SillyBunny ($ref) into $install_dir..."
    mkdir -p "$(dirname "$install_dir")"
    git -c advice.detachedHead=false clone --filter=blob:none --branch "$ref" -- "$repo" "$install_dir"

    if ! git -C "$install_dir" symbolic-ref --quiet HEAD >/dev/null 2>&1; then
        log "Installed tag $ref. Automatic updates are off for a pinned tag."
        log "To follow stable releases later, run: git -C \"$install_dir\" checkout release"
    fi
}

update_install() {
    log "SillyBunny is already installed in $install_dir. Updating it instead of reinstalling."
    if (( ref_overridden )); then
        log "--ref is ignored for an existing install."
    fi
    bash "$install_dir/scripts/self-update.sh" --optional
}

start_install() {
    if (( ! start_after )); then
        log "Done. Start SillyBunny with: bash \"$install_dir/start.sh\""
        return
    fi

    log 'Starting SillyBunny...'
    cd "$install_dir"
    case "$runtime_override" in
        bun)  SILLYBUNNY_USE_BUN=1  exec bash ./start.sh ;;
        node) SILLYBUNNY_USE_NODE=1 exec bash ./start.sh ;;
        *)                          exec bash ./start.sh ;;
    esac
}

# Expand a user-typed path: handle literal ~ from read without word-splitting.
expand_path() {
    local p="$1"
    # shellcheck disable=SC2088
    case "$p" in
        '~') printf '%s\n' "$HOME" ;;
        '~/'*) printf '%s\n' "$HOME/${p#\~/}" ;;
        *) printf '%s\n' "$p" ;;
    esac
}

# Interactive setup wizard. Called by main() when no arguments were passed and
# stdin is a terminal. Sets install_dir, migrate_from, and start_after.
run_wizard() {
    local answer=''

    printf '\n'
    printf '[SillyBunny] Setup\n'
    printf '══════════════════════════════════════════\n'
    printf '\n'

    # Step 1 — install directory
    local default_dir="$HOME/SillyBunny"
    printf 'Install directory\n'
    printf '  Where should SillyBunny be installed?\n'
    printf '  Leave blank for the default: %s\n' "$default_dir"
    while true; do
        printf '  > '
        read -r answer
        local candidate
        candidate="$(resolve_path "$(expand_path "${answer:-$default_dir}")")"
        if holds_installer "$candidate"; then
            printf '  That folder holds this installer (%s), and the install needs an empty folder.\n' "$installer_name"
            printf '  Pick another folder, for example: %s/SillyBunny\n' "$candidate"
            continue
        fi
        if [[ -n "$answer" ]]; then
            install_dir="$(expand_path "$answer")"
        fi
        break
    done

    # Step 2 — migration
    printf '\n'
    printf 'Migrate from an older installation? (optional)\n'
    printf '  If you have a previous SillyBunny ZIP release, enter its folder path\n'
    printf '  to copy your chats, settings, and plugins to the new install.\n'
    printf '  Leave blank to skip.\n'
    while true; do
        printf '  > '
        read -r answer
        if [[ -z "$answer" ]]; then
            migrate_from=''
            break
        fi
        local expanded
        expanded="$(expand_path "$answer")"
        if [[ ! -d "$expanded" ]]; then
            printf '  That folder does not exist. Try again, or leave blank to skip.\n'
            continue
        fi
        migrate_from="$expanded"
        break
    done

    # Step 3 — runtime (Linux/Termux only; macOS auto-selects Node)
    if [[ "$(uname -s 2>/dev/null)" != Darwin ]]; then
        printf '\n'
        printf 'Runtime\n'
        printf '  Which JavaScript runtime should SillyBunny use?\n'
        printf '  Bun is faster; Node.js is the fallback for systems where Bun has issues.\n'
        printf '  [B]un / [n]ode (default: Bun) '
        read -r answer
        case "${answer,,}" in
            n|node) runtime_override='node' ;;
            *)      runtime_override='bun'  ;;
        esac
    fi

    # Step 4 — start after install
    printf '\n'
    printf 'Start SillyBunny when setup finishes? [Y/n] '
    read -r answer
    case "${answer,,}" in
        n|no) start_after=0 ;;
    esac

    local start_label='Yes'
    (( start_after == 0 )) && start_label='No'
    local runtime_label='default'
    [[ "$runtime_override" == 'bun'  ]] && runtime_label='Bun'
    [[ "$runtime_override" == 'node' ]] && runtime_label='Node.js'
    printf '\n'
    printf '══════════════════════════════════════════\n'
    printf '  Install to:          %s\n' "${install_dir:-$default_dir}"
    if [[ -n "$migrate_from" ]]; then
        printf '  Migrate from:        %s\n' "$migrate_from"
    fi
    if [[ "$(uname -s 2>/dev/null)" != Darwin ]]; then
        printf '  Runtime:             %s\n' "$runtime_label"
    fi
    printf '  Start after install: %s\n' "$start_label"
    printf '══════════════════════════════════════════\n'
    printf 'Press Enter to begin, or Ctrl+C to cancel. '
    read -r _
    printf '\n'
}

main() {
    parse_args "$@"

    if [[ -f "${BASH_SOURCE[0]:-}" ]]; then
        installer_name="$(basename "${BASH_SOURCE[0]}")"
    fi

    # Show the interactive wizard when the script is run directly with no
    # arguments in a terminal. Piped or scripted invocations skip it.
    if [[ -t 0 && $_argc -eq 0 ]]; then
        run_wizard
    fi

    [[ "$ref" != -* && "$repo" != -* ]] || die 'Invalid --ref or --repo value.'

    install_dir="$(resolve_path "${install_dir:-$HOME/SillyBunny}")"
    if [[ -n "$migrate_from" ]]; then
        migrate_from="$(resolve_path "$migrate_from")"
    fi

    if is_termux && is_shared_storage_path "$install_dir"; then
        die "Termux installs must stay in your Termux home, not Android shared storage. Use the default ($HOME/SillyBunny) or another folder under $HOME."
    fi

    install_git

    if [[ -d "$install_dir/.git" ]]; then
        is_sillybunny_dir "$install_dir" || die "$install_dir is a Git checkout of something else. Pick another folder with --dir."
        if [[ -n "$migrate_from" ]]; then
            die "$install_dir already has an install. Migrate into a new folder with --dir."
        fi
        update_install
        start_install
        return
    fi

    if [[ -e "$install_dir" ]] && ! is_empty_dir "$install_dir"; then
        if is_sillybunny_dir "$install_dir"; then
            die "$install_dir is an old ZIP install. Install into a new folder and copy your data across with: --dir \"$HOME/SillyBunny-new\" --migrate-from \"$install_dir\""
        fi
        if holds_installer "$install_dir"; then
            die "$install_dir holds this installer ($installer_name), and the install needs an empty folder. Install into a subfolder instead: --dir \"$install_dir/SillyBunny\""
        fi
        die "$install_dir exists and isn't empty. Pick another folder with --dir."
    fi

    if [[ -n "$migrate_from" ]]; then
        validate_migration_source
    fi

    clone_install

    if [[ -n "$migrate_from" ]]; then
        migrate_old_install
    fi

    start_install
}

main "$@"
