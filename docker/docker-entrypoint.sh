#!/bin/sh

# Mirrors is_truthy in start.sh so SILLYBUNNY_* flags accept the same spellings
# in containers as they do under the shell launchers.
is_truthy() {
    case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
        1|true|yes|on)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

# Function to handle startup logic (Config check + init + Start)
start_sillybunny() {
    local PREFIX="$1"
    shift # Remove the first argument (PREFIX) so $@ contains the rest

    # Config Check
    if [ ! -e "config/config.yaml" ]; then
        echo "Resource not found, copying from defaults: config.yaml"
        $PREFIX cp "default/config.yaml" "config/config.yaml"
    fi

    # Execute init script to auto-populate config.yaml with missing values
    $PREFIX bun run init

    # Start the server
    if is_truthy "${SILLYBUNNY_BUN_SMOL:-}"; then
        # Bun grows the JSC heap freely while RAM looks plentiful, which reads as
        # a leak under a container memory cap. --smol trades throughput for much
        # more aggressive GC.
        echo "[SillyBunny] SILLYBUNNY_BUN_SMOL set — starting Bun in low-memory mode (--smol)."
        exec $PREFIX bun --smol server.js --listen "$@"
    fi

    exec $PREFIX bun server.js --listen "$@"
}

# Dirs that MUST be present at this point (e.g for volumeless docker runs).
# Please update list, if in the future a related perm issue appear.
CORE_DIRS="config data plugins public/scripts/extensions/third-party backups"

# Mounted Volumes (External)
# Parse mounts, handling files vs directories
RAW_MOUNTS=$(awk -v app_path="/home/bun/app" '$2 ~ "^" app_path {print $2}' /proc/mounts)
MOUNTED_DIRS=""

for mount in $RAW_MOUNTS; do
    if [ -f "$mount" ]; then
        # If it is a mounted file (e.g. cert.pem), we want to check its PARENT directory
        # so that the app can write adjacent files (e.g. key.pem).
        PARENT_DIR=$(dirname "$mount")

        # Performance Safety: If the file is in the root of the app,
        # we do NOT add the parent (App Root), or we will recursively scan the whole app.
        [ "$PARENT_DIR" != "/home/node/app" ] && MOUNTED_DIRS="$MOUNTED_DIRS $PARENT_DIR" || MOUNTED_DIRS="$MOUNTED_DIRS $mount"
    else
        # It is a directory, add it directly
        MOUNTED_DIRS="$MOUNTED_DIRS $mount"
    fi
done

# Combine dirs for checks
CHECK_DIRS=$(echo "$CORE_DIRS $MOUNTED_DIRS" | tr ' ' '\n' | sort -u)

# Ensure the needed directories exist
for dir in $CHECK_DIRS; do
    if [ ! -e "$dir" ]; then
        echo "Creating missing directory: $dir"
        mkdir -p "$dir" 2>/dev/null || echo "Warning: Could not create $dir" >&2
    fi
done

# Mode Selection
if [ "$(id -u)" = "0" ]; then
    # Check if PUID/PGID variables are provided
    if [ -n "$PUID" ] && [ -n "$PGID" ]; then
        echo "Mode: PUID/PGID (UID:$PUID GID:$PGID)"

        # Update the internal 'bun' user to match requested IDs
        groupmod -o -g "$PGID" bun
        usermod -o -u "$PUID" -g "$PGID" bun

        for dir in $CHECK_DIRS; do
            if [ -d "$dir" ]; then
                # Runs chown only if there is an mismatch
                DIR_UID=$(stat -c '%u' "$dir")
                DIR_GID=$(stat -c '%g' "$dir")

                if [ "$DIR_UID" != "$PUID" ] || [ "$DIR_GID" != "$PGID" ]; then
                    echo "(Detected mismatch) Adjusting permissions for: $dir."
                    chown -R bun:bun "$dir" || echo "Warning: Failed to update permissions for '$dir'." >&2
                fi
            fi
        done

        # Fix config file specifically
        chown bun:bun "config/config.yaml" 2>/dev/null

        # Set execution prefix to run as 'bun' user
        EXEC_PREFIX="su-exec bun:bun"
    else
        # Default: Run as Root (original behavior)
        echo "Mode: Default (Root)"
        EXEC_PREFIX=""
    fi

else
    # Non-Root Mode (Docker CLI --user flag)
    echo "Mode: Strict Non-Root (UID: $(id -u))"
    # We CANNOT auto-fix permissions in this mode because we lack privileges.
    # Relying solely on the user configuring their host permissions correctly.
    EXEC_PREFIX=""
fi

# Calling function with the determined prefix
start_sillybunny "$EXEC_PREFIX" "$@"
