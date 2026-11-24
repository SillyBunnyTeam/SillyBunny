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

    if (( OPTIONAL )); then
        echo "Skipping self-update: $message" >&2
        exit 0
    fi

    echo "Self-update failed: $message" >&2
    exit 1
}

restore_lone_bun_lock_change() {
    local status_output="$1"
    local first_line="${status_output%%$'\n'*}"

    if [[ "$status_output" != "$first_line" || "${first_line:3}" != "bun.lock" ]]; then
        return 1
    fi

    if ! git ls-files --error-unmatch bun.lock >/dev/null 2>&1; then
        return 1
    fi

    echo "Restoring tracked bun.lock before self-update..."
    if git restore --staged --worktree -- bun.lock >/dev/null 2>&1; then
        return 0
    fi

    git reset HEAD -- bun.lock >/dev/null 2>&1 || true
    if ! git checkout -- bun.lock >/dev/null 2>&1; then
        finish_early "could not restore generated bun.lock."
    fi

    return 0
}

read_loose_ref_sha() {
    local ref_file="$1"
    local value=""

    if [[ ! -f "$ref_file" ]]; then
        return 1
    fi

    IFS= read -r value < "$ref_file" || value=""
    value="${value%$'\r'}"
    if [[ "$value" =~ ^[0-9a-fA-F]{40,64}$ ]]; then
        printf '%s\n' "$value"
        return 0
    fi

    return 1
}

cd "$REPO_DIR"

if ! command -v git >/dev/null 2>&1; then
    finish_early "Git is not installed."
fi

git_dir=""
common_dir=""
if [[ -z "${GIT_DIR:-}" && -z "${GIT_WORK_TREE:-}" ]]; then
    if [[ -d "$REPO_DIR/.git" ]]; then
        git_dir="$REPO_DIR/.git"
    elif [[ -f "$REPO_DIR/.git" ]]; then
        IFS= read -r git_dir_line < "$REPO_DIR/.git" || git_dir_line=""
        git_dir_line="${git_dir_line%$'\r'}"
        if [[ "$git_dir_line" == gitdir:\ * ]]; then
            git_dir="${git_dir_line#gitdir: }"
            if [[ "$git_dir" != /* ]]; then
                git_dir="$REPO_DIR/$git_dir"
            fi
        fi
    fi

    if [[ -n "$git_dir" ]]; then
        common_dir="$git_dir"
        if [[ -f "$git_dir/commondir" ]]; then
            IFS= read -r common_rel < "$git_dir/commondir" || common_rel=""
            common_rel="${common_rel%$'\r'}"
            if [[ -n "$common_rel" ]]; then
                if [[ "$common_rel" == /* ]]; then
                    common_dir="$common_rel"
                else
                    common_dir="$git_dir/$common_rel"
                fi
            fi
        fi
    fi
fi

current_branch=""
if [[ -n "$git_dir" && -f "$git_dir/HEAD" ]]; then
    IFS= read -r head_line < "$git_dir/HEAD" || head_line=""
    head_line="${head_line%$'\r'}"
    if [[ "$head_line" == "ref: refs/heads/"* ]]; then
        current_branch="${head_line#ref: refs/heads/}"
    elif [[ "$head_line" =~ ^[0-9a-fA-F]{40,64}$ ]]; then
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

if ! status_output="$(git status --porcelain --untracked-files=normal)"; then
    finish_early "could not read the repository status."
fi

if [[ -n "$status_output" ]] && ! restore_lone_bun_lock_change "$status_output"; then
    finish_early "the working tree is not clean. Commit, stash, or remove local changes first."
fi

upstream_remote="${upstream_ref%%/*}"

echo "Checking for updates on $upstream_ref..."
low_speed_time="${SILLYBUNNY_GIT_LOW_SPEED_TIME:-10}"
if [[ ! "$low_speed_time" =~ ^[1-9][0-9]*$ ]]; then
    low_speed_time=10
fi

if (( OPTIONAL )); then
    if ! git \
        -c "remote.$upstream_remote.tagOpt=--no-tags" \
        -c "http.lowSpeedLimit=1000" \
        -c "http.lowSpeedTime=$low_speed_time" \
        fetch --quiet --no-tags "$upstream_remote"; then
        finish_early "could not fetch from '$upstream_remote'."
    fi
else
    if ! git fetch --quiet "$upstream_remote"; then
        finish_early "could not fetch from '$upstream_remote'."
    fi
fi

if [[ -n "$common_dir" && "$current_branch" != *..* && "$upstream_ref" != *..* ]]; then
    local_sha="$(read_loose_ref_sha "$common_dir/refs/heads/$current_branch" || true)"
    remote_sha="$(read_loose_ref_sha "$common_dir/refs/remotes/$upstream_ref" || true)"
    if [[ -n "$local_sha" && "$local_sha" == "$remote_sha" ]]; then
        echo "SillyBunny is already up to date."
        exit 0
    fi
fi

counts_output="$(git rev-list --left-right --count 'HEAD...@{upstream}')"
read -r ahead behind <<< "$counts_output"

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
if (( OPTIONAL )); then
    if ! git \
        -c "remote.$upstream_remote.tagOpt=--no-tags" \
        -c "http.lowSpeedLimit=1000" \
        -c "http.lowSpeedTime=$low_speed_time" \
        pull --ff-only; then
        finish_early "git pull --ff-only failed."
    fi
else
    if ! git pull --ff-only; then
        finish_early "git pull --ff-only failed."
    fi
fi

after_rev="$(git rev-parse --short HEAD)"
echo "Updated SillyBunny from $before_rev to $after_rev."
