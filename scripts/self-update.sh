#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OPTIONAL=0

if [[ "${1:-}" == "--optional" ]]; then
    OPTIONAL=1
    shift
fi

finish_early() {
    local message="$1"

    # The APK gate logs before status I/O, then passes an empty message to exit once.
    if (( OPTIONAL )); then
        if [[ -n "$message" ]]; then
            echo "Skipping self-update: $message" >&2
        fi
        exit 0
    fi

    if [[ -n "$message" ]]; then
        echo "Self-update failed: $message" >&2
    fi
    exit 1
}

restore_lone_bun_lock_change() {
    if ! git ls-files --error-unmatch bun.lock >/dev/null 2>&1; then
        return
    fi

    local status_output first_line
    if ! status_output="$(git status --porcelain --untracked-files=normal)"; then
        finish_early "could not read the repository status."
    fi

    if [[ -z "$status_output" ]]; then
        return
    fi

    first_line="${status_output%%$'\n'*}"
    if [[ "$status_output" != "$first_line" || "${first_line:3}" != "bun.lock" ]]; then
        return
    fi

    echo "Restoring tracked bun.lock before self-update..."
    if git restore --staged --worktree -- bun.lock >/dev/null 2>&1; then
        return
    fi

    git reset HEAD -- bun.lock >/dev/null 2>&1 || true
    if ! git checkout -- bun.lock >/dev/null 2>&1; then
        finish_early "could not restore generated bun.lock."
    fi
}

# SillyBunny Android app: normalize decimal version codes without shell integer overflow.
normalize_android_version() {
    local value="$1"

    [[ "$value" =~ ^[0-9]+$ ]] || return 1
    while [[ ${#value} -gt 1 && "$value" == 0* ]]; do
        value="${value#0}"
    done
    printf '%s' "$value"
}

# SillyBunny Android app: gate the fetched code before any update decision.
check_android_app_update() {
    local installed required=null reason='' part branch temporary status_file
    local minimum_parts=()
    local LC_ALL=C

    if (( behind > 0 )); then
        installed="$(normalize_android_version "${SILLYBUNNY_ANDROID_APP_VERSION_CODE:-}")" || installed=0

        # NUL-delimited fields retain whitespace, detect binary input and carry git's result.
        while IFS= read -r -d '' part; do
            minimum_parts+=("$part")
        done < <(if git show "$checked_upstream:android/min-app-version" 2>/dev/null; then
            printf '\0ok\0'
        else
            printf '\0missing\0'
        fi)

        # Missing files predate the app's launch-token/update gates; never treat them as 0.
        if [[ "${minimum_parts[${#minimum_parts[@]}-1]}" == missing ]]; then
            reason=missing
        elif (( ${#minimum_parts[@]} != 2 )) || [[ ! "${minimum_parts[0]}" =~ ^[[:space:]]*([0-9]+)[[:space:]]*$ ]]; then
            reason=invalid
        else
            required="$(normalize_android_version "${BASH_REMATCH[1]}")"
            if (( ${#required} > ${#installed} )) \
                || { (( ${#required} == ${#installed} )) && [[ "$required" > "$installed" ]]; }; then
                reason=newer
            fi
        fi

        if [[ -n "$reason" ]]; then
            if (( OPTIONAL )); then
                echo "Skipping self-update: the update needs a newer SillyBunny app, or its android/min-app-version file is missing or invalid." >&2
            else
                echo "Self-update failed: the update needs a newer SillyBunny app, or its android/min-app-version file is missing or invalid." >&2
            fi
            if [[ -n "${SILLYBUNNY_ANDROID_STATUS_DIR:-}" ]]; then
                branch="${current_branch//\\/\\\\}"
                branch="${branch//\"/\\\"}"
                temporary="$SILLYBUNNY_ANDROID_STATUS_DIR/.update-blocked.json.$$"
                # Keep the shared status format atomic; a status I/O error must not allow a pull.
                if ! { mkdir -p -- "$SILLYBUNNY_ANDROID_STATUS_DIR" \
                    && printf '{"required":%s,"installed":%s,"reason":"%s","upstream":"%s","branch":"%s"}\n' \
                        "$required" "$installed" "$reason" "$checked_upstream" "$branch" > "$temporary" \
                    && mv -f -- "$temporary" "$SILLYBUNNY_ANDROID_STATUS_DIR/update-blocked.json"; }; then
                    rm -f -- "$temporary" || true
                fi
            fi
            finish_early ""
        fi
    fi

    if [[ -n "${SILLYBUNNY_ANDROID_STATUS_DIR:-}" ]]; then
        status_file="$SILLYBUNNY_ANDROID_STATUS_DIR/update-blocked.json"
        if [[ -e "$status_file" || -L "$status_file" ]]; then
            rm -f -- "$status_file" || finish_early "could not remove the update-blocked.json status file."
        fi
    fi
}

cd "$REPO_DIR"

if ! command -v git >/dev/null 2>&1; then
    finish_early "Git is not installed."
fi

current_branch=""
if [[ -d .git && -d .git/objects && -d .git/refs && -f .git/HEAD ]]; then
    IFS= read -r head_contents < .git/HEAD || head_contents=""
    head_contents="${head_contents%$'\r'}"
    if [[ "$head_contents" == ref:\ refs/heads/* ]]; then
        current_branch="${head_contents#ref: refs/heads/}"
    elif [[ -n "$head_contents" && "$head_contents" != ref:\ * ]]; then
        finish_early "detached HEAD checkouts cannot be updated automatically."
    fi
fi

if [[ -z "$current_branch" ]]; then
    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        finish_early "this checkout is not a Git repository."
    fi

    current_branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
    if [[ -z "$current_branch" ]]; then
        finish_early "detached HEAD checkouts cannot be updated automatically."
    fi
fi

upstream_ref="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
if [[ -z "$upstream_ref" ]]; then
    finish_early "branch '$current_branch' does not have an upstream configured."
fi

if [[ "${SILLYBUNNY_ANDROID_APP:-}" != 1 ]]; then
    restore_lone_bun_lock_change
fi

if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
    finish_early "the working tree is not clean. Commit, stash, or remove local changes first."
fi

upstream_remote="${upstream_ref%%/*}"

echo "Checking for updates on $upstream_ref..."
if [[ "${SILLYBUNNY_ANDROID_APP:-}" == 1 ]] && (( OPTIONAL )); then
    # Bound stalled mobile connections and skip fetching release tags during automatic Android cold-start checks.
    if ! GIT_CONFIG_COUNT=3 \
        GIT_CONFIG_KEY_0=http.lowSpeedLimit GIT_CONFIG_VALUE_0=1024 \
        GIT_CONFIG_KEY_1=http.lowSpeedTime GIT_CONFIG_VALUE_1=5 \
        GIT_CONFIG_KEY_2="remote.$upstream_remote.tagOpt" GIT_CONFIG_VALUE_2=--no-tags \
        git fetch --quiet "$upstream_remote"; then
        finish_early "could not fetch from '$upstream_remote'."
    fi
elif ! git fetch --quiet "$upstream_remote"; then
    finish_early "could not fetch from '$upstream_remote'."
fi

# SillyBunny Android app: other install methods retain their existing update flow.
if [[ "${SILLYBUNNY_ANDROID_APP:-}" == 1 ]]; then
    # Pin the app's check and update to one commit even if the tracking ref moves.
    checked_upstream="$(git rev-parse '@{upstream}' 2>/dev/null)" || finish_early "could not read the upstream commit."
    local_head=""
    if [[ -f ".git/refs/heads/$current_branch" ]]; then
        IFS= read -r local_head < ".git/refs/heads/$current_branch" || local_head=""
        local_head="${local_head%$'\r'}"
    fi
    if [[ "$local_head" =~ ^[0-9a-fA-F]{40,64}$ && "$local_head" == "$checked_upstream" ]]; then
        ahead=0
        behind=0
    else
        read -r ahead behind < <(git rev-list --left-right --count "HEAD...$checked_upstream")
    fi
    check_android_app_update
else
    read -r ahead behind < <(git rev-list --left-right --count HEAD...@{upstream})
fi

if (( ahead > 0 && behind > 0 )); then
    finish_early "branch '$current_branch' has diverged from '$upstream_ref'. Resolve it manually before using self-update."
fi

if (( ahead > 0 )); then
    echo "Local branch '$current_branch' is already ahead of '$upstream_ref'; nothing to pull."
    exit 0
fi

if (( behind == 0 )); then
    echo "SillyBunny is already up to date."
    exit 0
fi

before_rev="$(git rev-parse --short HEAD)"

echo "Updating SillyBunny..."
if [[ "${SILLYBUNNY_ANDROID_APP:-}" == 1 ]]; then
    # A pull would refetch and could merge an unchecked commit in the Android app.
    if ! git merge --ff-only "$checked_upstream"; then
        finish_early "git merge --ff-only failed."
    fi
else
    if ! git pull --ff-only; then
        finish_early "git pull --ff-only failed."
    fi
fi

after_rev="$(git rev-parse --short HEAD)"
echo "Updated SillyBunny from $before_rev to $after_rev."
