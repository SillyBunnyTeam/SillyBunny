#!/usr/bin/env bash
# Force SillyBunny to use Node.js instead of Bun.
# Use this if Bun causes high CPU usage on your platform.
unset SILLYBUNNY_USE_BUN
export SILLYBUNNY_USE_NODE=1
export SILLYBUNNY_TERMUX_RUNTIME=node
exec "$(dirname "${BASH_SOURCE[0]}")/start.sh" "$@"
