#!/usr/bin/env bash
# The APK release build recipe (plan §6.1, §6.2). release.yml's build job runs it with only the channel and an
# output directory, so every option that changes the APK bytes lives in this file, under android/, where
# inputsHash (inputs-hash.mjs) covers it. Release builds vary only -PdefaultRef.
#
# Usage: android/release/build-release-apks.sh <staging|release> <out-dir>
#   staging    a prerelease build: -PdefaultRef=staging
#   release    a stable build: -PdefaultRef=release
#   out-dir    absent or empty. Receives SillyBunny-android-<abi>-unsigned.apk for arm64-v8a and armeabi-v7a,
#              which sign-release-apks.sh signs, and the sources archive SillyBunny-android-sources.tar.zst.
# Exit 0 when built, 1 when a check or step fails, 2 on a usage error. A failure prints the placeholder line and
# one JSON line {"code": ..., ...} on stderr.
#
# The steps, in one checkout and in track p45b's order:
#   1. android/runtime/fetch-termux.sh
#   2. android/runtime/fetch-node.py for the release ABIs, from the GHCR digests android/runtime.lock pins;
#      never --local, because releases ship only the published Node builds
#   3. android/runtime/build-npm.py
#   4. android/runtime/build-sources.sh --require-node: the sources archive. It also leaves the pinned Node source
#      tarball in android/runtime/cache/sources, where the Gradle notices task reads it
#   5. check-staged-runtime.mjs: node.json and npm.json carry their source attribution and match runtime.lock
#   6. Gradle :app:assembleRelease -PdefaultRef=<channel>, unsigned (the signing variables must be unset) and
#      without -PincludeX86_64 (update-manifest.mjs refuses APKs whose runtime lists x86_64)
# The host needs Linux, network access, python3 with pyelftools, patchelf, zstd, oras, Node.js, JDK 21 (JAVA_HOME,
# or java on PATH) and the Android SDK packages android/app/build.gradle.kts names (ANDROID_HOME or
# ANDROID_SDK_ROOT).
set -euo pipefail

json_text() {
    local value=${1//\\/\\\\}
    printf '%s' "${value//\"/\\\"}" | tr -d '\000-\037'
}

# fail_with <status> <code> [<name> <value>]...: the placeholder line, then {"code":"<code>","<name>":"<value>"}.
fail_with() {
    local status=$1 json
    json="{\"code\":\"$2\""
    shift 2
    while [ "$#" -ge 2 ]; do
        json+=",\"$1\":\"$(json_text "$2")\""
        shift 2
    done
    printf 'TODO(copy)\n%s}\n' "$json" >&2
    exit "$status"
}

fail() {
    fail_with 1 "$@"
}

# run_step <name> <command>...: runs one recipe step and fails with its name and exit status.
run_step() {
    local name=$1 status=0
    shift
    printf '== build-release-apks: %s\n' "$name" >&2
    "$@" || status=$?
    [ "$status" -eq 0 ] || fail step-failed step "$name" status "$status"
}

[ "$#" -eq 2 ] || fail_with 2 usage
channel=$1
out=$2
case "$channel" in
    staging | release) ;;
    *) fail_with 2 invalid-channel channel "$channel" ;;
esac

root=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
runtime="$root/android/runtime"

# The signing job signs; this build must stay unsigned and never see the signing secrets.
for name in ANDROID_KEYSTORE_B64 ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD; do
    [ -z "${!name:-}" ] || fail signing-variable-set name "$name"
done
spec=$("${JAVA_HOME:+$JAVA_HOME/bin/}java" -XshowSettings:properties -version 2>&1 | sed -n 's/^ *java\.specification\.version = //p') || spec=''
[ "$spec" = 21 ] || fail jdk-21-required found "$spec"
command -v node > /dev/null || fail node-required

mkdir -p "$out"
[ -z "$(ls -A "$out")" ] || fail output-not-empty dir "$out"
out=$(CDPATH='' cd -- "$out" && pwd)

run_step fetch-termux bash "$runtime/fetch-termux.sh"
run_step fetch-node python3 -I -B "$runtime/fetch-node.py" --abi arm64-v8a --abi armeabi-v7a
run_step build-npm python3 -I -B "$runtime/build-npm.py"
run_step build-sources bash "$runtime/build-sources.sh" --require-node --output "$out/SillyBunny-android-sources.tar.zst"
run_step check-staged-runtime node "$root/android/release/check-staged-runtime.mjs"
run_step assemble-release bash -c 'cd "$1/android" && ./gradlew --no-daemon --console=plain "-PdefaultRef=$2" :app:assembleRelease' \
    gradle "$root" "$channel"

for abi in arm64-v8a armeabi-v7a; do
    apk="$root/android/app/build/outputs/apk/release/app-$abi-release-unsigned.apk"
    [ -f "$apk" ] || fail apk-missing file "$apk"
    cp "$apk" "$out/SillyBunny-android-$abi-unsigned.apk"
done
printf '== build-release-apks: done\n' >&2
ls -l "$out" >&2
