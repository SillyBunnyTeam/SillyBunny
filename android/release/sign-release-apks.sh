#!/usr/bin/env bash
# Signs the release APKs (plan §6.3) in release.yml's signing job, the only job that receives the signing secrets.
#
# Usage: android/release/sign-release-apks.sh <unsigned-dir> <out-dir>
#   unsigned-dir  holds SillyBunny-android-<abi>-unsigned.apk for arm64-v8a and armeabi-v7a (build-release-apks.sh)
#   out-dir       absent or empty. Receives SillyBunny-android-<abi>.apk, the asset names android-update.json uses
# Environment: ANDROID_KEYSTORE_B64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD (the
# android-signing environment's secrets); ANDROID_HOME or ANDROID_SDK_ROOT with the build-tools version that
# android/app/build.gradle.kts names; Java for apksigner (JAVA_HOME or PATH).
# Prints one JSON line on stdout, and everything else on stderr:
#   {"signingCertSha256":"<hex>","minSdk":<n>,"targetSdk":<n>,"buildTools":"<dir>"}
# Exit 0 when signed, 1 when a check fails, 2 on a usage error. A failure prints the placeholder line and one
# JSON line {"code": ..., ...} on stderr.
#
# The §6.3 checks:
#   - the keystore is decoded into the ignored android/.gradle/signing/release.keystore and deleted on exit, also on
#     failure; the passwords reach apksigner only as env: references, never as arguments
#   - each unsigned APK is the release package, not debuggable, with native code for exactly its ABI
#   - zipalign (-P 16, 16 KB pages for the uncompressed native libraries) before signing; the signed file is never
#     changed afterwards
#   - v2 and v3 signatures only: no v1 (minSdk is above 24) and no v4, so no .idsig file
#   - after signing: the 16 KB alignment, apksigner verify for minSdk..targetSdk (v3, one signer, no v1, v3.1 or
#     v4) and for API 24..27, where the v2 signature is the one that verifies; one certificate for both APKs, and
#     the signed APK is still not debuggable
set -euo pipefail

# stdout carries only the JSON result; every tool's output goes to stderr.
exec 3>&1 1>&2

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

step() {
    printf '== sign-release-apks: %s\n' "$1" >&2
}

[ "$#" -eq 2 ] || fail_with 2 usage
in=$1
out=$2
abis=(arm64-v8a armeabi-v7a)
package=io.github.sillybunnyteam.sillybunny

root=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
for name in ANDROID_KEYSTORE_B64 ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD; do
    [ -n "${!name:-}" ] || fail signing-variable-missing name "$name"
done

version=$(sed -n 's/^ *buildToolsVersion = "\([0-9][0-9.]*\)"$/\1/p' "$root/android/app/build.gradle.kts")
[ -n "$version" ] && [ "$(printf '%s\n' "$version" | wc -l)" -eq 1 ] || fail build-tools-version-unreadable
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
[ -n "$sdk" ] || fail android-sdk-missing
tools="$sdk/build-tools/$version"
for tool in zipalign apksigner aapt2; do
    [ -x "$tools/$tool" ] || fail build-tool-missing tool "$tools/$tool" package "build-tools;$version"
done
case "$tools" in
    *[\"\\]*) fail build-tools-path-unusable path "$tools" ;;
esac

for abi in "${abis[@]}"; do
    [ -f "$in/SillyBunny-android-$abi-unsigned.apk" ] || fail unsigned-apk-missing file "$in/SillyBunny-android-$abi-unsigned.apk"
done
mkdir -p "$out"
[ -z "$(ls -A "$out")" ] || fail output-not-empty dir "$out"

# Reads the aapt2 badging fields the checks use into the badging_* variables.
badging() {
    local file=$1
    "$tools/aapt2" dump badging "$file" > "$work/badging.txt" || fail aapt2-failed file "$file"
    badging_package=$(sed -n "s/^package: name='\([^']*\)'.*/\1/p" "$work/badging.txt")
    badging_min_sdk=$(sed -n "s/^minSdkVersion:'\([0-9]*\)'$/\1/p" "$work/badging.txt")
    badging_target_sdk=$(sed -n "s/^targetSdkVersion:'\([0-9]*\)'$/\1/p" "$work/badging.txt")
    badging_native=$(sed -n "s/^native-code: //p" "$work/badging.txt")
    if grep -qx 'application-debuggable' "$work/badging.txt"; then
        badging_debuggable=true
    else
        badging_debuggable=false
    fi
}

check_badging() {
    local abi=$1 file=$2
    badging "$file"
    [ "$badging_package" = "$package" ] || fail apk-package abi "$abi" package "$badging_package" expected "$package"
    [ "$badging_debuggable" = false ] || fail apk-debuggable abi "$abi" file "$file"
    [ "$badging_native" = "'$abi'" ] || fail apk-native-code abi "$abi" nativeCode "$badging_native"
    [[ "$badging_min_sdk" =~ ^[1-9][0-9]*$ ]] || fail apk-min-sdk-missing abi "$abi"
    [[ "$badging_target_sdk" =~ ^[1-9][0-9]*$ ]] || fail apk-target-sdk-missing abi "$abi"
}

keystore="$root/android/.gradle/signing/release.keystore"
[ ! -e "$keystore" ] || fail keystore-exists file "$keystore"
work=''
cleanup() {
    rm -f -- "$keystore"
    if [ -n "$work" ]; then
        rm -rf -- "$work"
    fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
umask 077
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/sign-release-apks.XXXXXXXX")

min_sdk=''
target_sdk=''
for abi in "${abis[@]}"; do
    step "check unsigned $abi"
    check_badging "$abi" "$in/SillyBunny-android-$abi-unsigned.apk"
    if [ -z "$min_sdk" ]; then
        min_sdk=$badging_min_sdk
        target_sdk=$badging_target_sdk
    fi
    [ "$badging_min_sdk" = "$min_sdk" ] && [ "$badging_target_sdk" = "$target_sdk" ] \
        || fail apk-sdk-mismatch abi "$abi" minSdk "$badging_min_sdk" targetSdk "$badging_target_sdk"
done
[ "$min_sdk" -ge 24 ] || fail min-sdk-below-24 minSdk "$min_sdk"
[ "$target_sdk" -ge "$min_sdk" ] || fail target-sdk-below-min-sdk minSdk "$min_sdk" targetSdk "$target_sdk"

step 'decode keystore'
mkdir -p "$(dirname -- "$keystore")"
# printf is a shell builtin, so the secret never appears in a process's arguments.
printf '%s' "$ANDROID_KEYSTORE_B64" | tr -d '[:space:]' | base64 --decode > "$keystore" || fail keystore-not-base64
[ -s "$keystore" ] || fail keystore-empty

cert=''
for abi in "${abis[@]}"; do
    unsigned="$in/SillyBunny-android-$abi-unsigned.apk"
    aligned="$work/$abi-aligned.apk"
    signed="$out/SillyBunny-android-$abi.apk"

    step "zipalign and sign $abi"
    "$tools/zipalign" -P 16 -f 4 "$unsigned" "$aligned" || fail zipalign-failed abi "$abi"
    "$tools/apksigner" sign \
        --ks "$keystore" --ks-pass env:ANDROID_KEYSTORE_PASSWORD \
        --ks-key-alias "$ANDROID_KEY_ALIAS" --key-pass env:ANDROID_KEY_PASSWORD \
        --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled false \
        --out "$signed" "$aligned" || fail sign-failed abi "$abi"
    [ ! -e "$signed.idsig" ] || fail v4-signature-written file "$signed.idsig"

    step "verify $abi"
    "$tools/zipalign" -c -P 16 4 "$signed" > "$work/zipalign.txt" 2>&1 \
        || { cat "$work/zipalign.txt"; fail not-aligned abi "$abi"; }
    "$tools/apksigner" verify --min-sdk-version "$min_sdk" --max-sdk-version "$target_sdk" --verbose --print-certs \
        "$signed" > "$work/verify.txt" 2>&1 \
        || { cat "$work/verify.txt"; fail verify-failed abi "$abi" minSdk "$min_sdk" maxSdk "$target_sdk"; }
    cat "$work/verify.txt"
    for expected in \
        'Verifies' \
        'Verified using v1 scheme (JAR signing): false' \
        'Verified using v3 scheme (APK Signature Scheme v3): true' \
        'Verified using v3.1 scheme (APK Signature Scheme v3.1): false' \
        'Verified using v4 scheme (APK Signature Scheme v4): false' \
        'Number of signers: 1'; do
        grep -qxF "$expected" "$work/verify.txt" || fail verify-line-missing abi "$abi" line "$expected"
    done
    digests=$(sed -n 's/^.*[Ss]igner.*certificate SHA-256 digest: \([0-9a-f]\{64\}\)$/\1/p' "$work/verify.txt" | sort -u)
    [ -n "$digests" ] && [ "$(printf '%s\n' "$digests" | wc -l)" -eq 1 ] || fail certificate-count abi "$abi"
    "$tools/apksigner" verify --min-sdk-version 24 --max-sdk-version 27 --verbose "$signed" > "$work/verify-v2.txt" 2>&1 \
        || { cat "$work/verify-v2.txt"; fail v2-verify-failed abi "$abi"; }
    grep -qxF 'Verified using v2 scheme (APK Signature Scheme v2): true' "$work/verify-v2.txt" \
        || fail v2-signature-missing abi "$abi"
    check_badging "$abi" "$signed"
    if [ -z "$cert" ]; then
        cert=$digests
    fi
    [ "$digests" = "$cert" ] || fail certificate-mismatch abi "$abi" certificate "$digests" expected "$cert"
done

step "signed: certificate SHA-256 $cert"
printf '{"signingCertSha256":"%s","minSdk":%s,"targetSdk":%s,"buildTools":"%s"}\n' \
    "$cert" "$min_sdk" "$target_sdk" "$tools" >&3
