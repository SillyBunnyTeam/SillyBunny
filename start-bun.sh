#!/usr/bin/env bash
# Force SillyBunny to use Bun instead of Node.js.
# Use this when you specifically want Bun behavior on a platform that may prefer Node.js.
unset SILLYBUNNY_USE_NODE
export SILLYBUNNY_USE_BUN=1
export SILLYBUNNY_TERMUX_RUNTIME=bun
exec "$(dirname "${BASH_SOURCE[0]}")/start.sh" "$@"
