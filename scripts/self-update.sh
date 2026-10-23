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
    local installed required=null reason='' part branch temporary
    local minimum_parts=()
    local LC_ALL=C

    # Pin the app's check and update to one commit even if the tracking ref moves.
    checked_upstream="$(git rev-parse '@{upstream}' 2>/dev/null)" || finish_early "TODO(copy)"

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
                echo "Skipping self-update: TODO(copy)" >&2
            else
                echo "Self-update failed: TODO(copy)" >&2
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
        rm -f -- "$SILLYBUNNY_ANDROID_STATUS_DIR/update-blocked.json" || finish_early "TODO(copy)"
    fi
}

cd "$REPO_DIR"

if ! command -v git >/dev/null 2>&1; then
    finish_early "Git is not installed."
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    finish_early "this checkout is not a Git repository."
fi

current_branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
if [[ -z "$current_branch" ]]; then
    finish_early "detached HEAD checkouts cannot be updated automatically."
fi

upstream_ref="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
if [[ -z "$upstream_ref" ]]; then
    finish_early "branch '$current_branch' does not have an upstream configured."
fi

restore_lone_bun_lock_change

if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
    finish_early "the working tree is not clean. Commit, stash, or remove local changes first."
fi

upstream_remote="${upstream_ref%%/*}"

echo "Checking for updates on $upstream_ref..."
if ! git fetch --quiet "$upstream_remote"; then
    finish_early "could not fetch from '$upstream_remote'."
fi

read -r ahead behind < <(git rev-list --left-right --count HEAD...@{upstream})

# SillyBunny Android app: other install methods retain their existing update flow.
if [[ "${SILLYBUNNY_ANDROID_APP:-}" == 1 ]]; then
    check_android_app_update
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
        finish_early "TODO(copy)"
    fi
else
    if ! git pull --ff-only; then
        finish_early "git pull --ff-only failed."
    fi
fi

after_rev="$(git rev-parse --short HEAD)"
echo "Updated SillyBunny from $before_rev to $after_rev."
