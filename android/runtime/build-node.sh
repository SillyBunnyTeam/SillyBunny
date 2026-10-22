#!/usr/bin/env bash
# Builds Node for one Android ABI as libnode.so (plan §2.1, §5.2, task 4.2) with S2.1's recipe (S2.1 §3, §4, §6).
#
#   android/runtime/build-node.sh <abi> [output-dir]
#
# <abi> is arm64-v8a, armeabi-v7a or x86_64. Writes <output-dir>/libnode.so (the stripped `node` executable) and
# <output-dir>/node-build.json (provenance, no timestamps); the default output-dir is
# android/runtime/cache/node-build/out/<abi>. Stage the result for the app with fetch-node.py --local.
#
# Every input is pinned. fetch-node.py --build-inputs checks both locks and the patch-set hash, fetches the Node
# source tarball through sources.py's cache by its SHA-256, checks it against the pinned SHASUMS256.txt and, when
# gpgv is installed, that file's signature against the pinned release keyring. The NDK is the pinned zip (size,
# SHA-1 and SHA-256 checked), or NODE_NDK_DIR when its source.properties revision equals the pin.
#
# Environment:
#   NODE_BUILD_JOBS=4          make jobs (S2.1 peaked at 6.5 GiB with 6)
#   NODE_BUILD_DIR=DIR         unpacked NDK and source tree (default android/runtime/cache/node-build)
#   NODE_CACHE_DIR=DIR         download cache shared with sources.py (default android/runtime/cache/sources)
#   NODE_NDK_DIR=DIR           an unpacked NDK to use instead of the pinned zip
#   NODE_OFFLINE=1             never download; every pinned file must already be cached
#   NODE_REQUIRE_SIGNATURE=1   fail unless the SHASUMS256.txt signature was verified (CI sets this)
#   NODE_KEEP_BUILD=1          keep the source and out/ tree after a successful build
set -euo pipefail
umask 022

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
step=arguments
reported=
inputs=
temporary=()

finish() {
    local status=$?
    rm -f -- "${temporary[@]}" ${inputs:+"$inputs"}
    if (( status != 0 )) && [[ -z $reported ]]; then
        printf 'lorum ipsum\n{"code": "build-failed", "status": %d, "step": "%s"}\n' "$status" "$step" >&2
    fi
}
trap finish EXIT

fail() {
    reported=1
    printf 'lorum ipsum\n{"code": "%s", "step": "%s"}\n' "$1" "$step" >&2
    exit 1
}

(( $# >= 1 && $# <= 2 )) || fail usage
abi=$1
# S2.1 §4: android-configure architecture, V8 CPU name and NDK target triple per ABI.
case "$abi" in
    arm64-v8a) arch=arm64 cpu=arm64 triple=aarch64-linux-android ;;
    armeabi-v7a) arch=arm cpu=arm triple=armv7a-linux-androideabi ;;
    x86_64) arch=x86_64 cpu=x64 triple=x86_64-linux-android ;;
    *) fail unknown-abi ;;
esac
build_root=${NODE_BUILD_DIR:-$here/cache/node-build}
cache=${NODE_CACHE_DIR:-$here/cache/sources}
output=${2:-}
# The build later runs inside the source tree, so relative paths are fixed to the caller's directory now.
[[ -z $output || $output == /* ]] || output=$PWD/$output
[[ $cache == /* ]] || cache=$PWD/$cache
jobs=${NODE_BUILD_JOBS:-4}
[[ $jobs =~ ^[1-9][0-9]{0,2}$ ]] || fail invalid-jobs

step=tools
needed=(python3 make patch tar xz gcc g++ ar df)
[[ -n ${NODE_NDK_DIR:-} ]] || needed+=(unzip)
for tool in "${needed[@]}"; do
    command -v "$tool" > /dev/null || fail "missing-tool-$tool"
done

step=inputs
mkdir -p -- "$build_root" "$cache"
build_root=$(cd -- "$build_root" && pwd -P)
output=${output:-$build_root/out/$abi}
inputs=$(mktemp)
fetch_arguments=(--build-inputs "$abi" --cache "$cache")
[[ ${NODE_OFFLINE:-} != 1 ]] || fetch_arguments+=(--offline)
[[ -n ${NODE_NDK_DIR:-} ]] || fetch_arguments+=(--with-ndk)
python3 -B "$here/fetch-node.py" "${fetch_arguments[@]}" > "$inputs"
# shellcheck source=/dev/null
. "$inputs"
if [[ ${NODE_REQUIRE_SIGNATURE:-} == 1 && $NODE_SIGNATURE != verified ]]; then
    fail node-signature-required
fi

step=ndk
if [[ -n ${NODE_NDK_DIR:-} ]]; then
    ndk=$(cd -- "$NODE_NDK_DIR" && pwd -P)
    ndk_from=directory
else
    unpacked=$build_root/ndk/$NDK_SHA256
    if [[ ! -d $unpacked ]]; then
        (( $(df --output=avail -B1 -- "$build_root" | tail -n 1) > 3 * 1024 ** 3 )) || fail low-disk-ndk
        rm -rf -- "$unpacked.partial"
        mkdir -p -- "$unpacked.partial"
        unzip -q "$NDK_ZIP" -d "$unpacked.partial"
        mv -- "$unpacked.partial" "$unpacked"
    fi
    shopt -s nullglob
    tops=("$unpacked"/android-ndk-*/)
    shopt -u nullglob
    (( ${#tops[@]} == 1 )) || fail ndk-layout
    ndk=${tops[0]%/}
    ndk_from=pinned-zip
fi
revision=$(sed -n 's/^Pkg\.Revision[[:space:]]*=[[:space:]]*//p' "$ndk/source.properties" | tr -d '\r')
[[ $revision == "$NDK_REVISION" ]] || fail ndk-revision
toolchain=$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin
for tool in "$triple$NODE_API-clang" "$triple$NODE_API-clang++" clang clang++ llvm-ar llvm-ranlib llvm-strip; do
    [[ -x $toolchain/$tool ]] || fail ndk-toolchain
done

step=host
work=$build_root/work/$abi
rm -rf -- "$work"
mkdir -p -- "$work"
if [[ $abi == armeabi-v7a ]]; then
    # S2.1 §3: the 32-bit host mksnapshot links with g++ -m32, which needs the i386 libraries of g++-multilib.
    printf 'int main() { return 0; }\n' > "$work/m32.cc"
    g++ -m32 -o "$work/m32" "$work/m32.cc" || fail host-multilib
fi
(( $(df --output=avail -B1 -- "$build_root" | tail -n 1) > 4 * 1024 ** 3 )) || fail low-disk

step=extract
tar -xJf "$NODE_TARBALL" -C "$work" --no-same-owner --no-same-permissions
source=$work/node-v$NODE_VERSION
[[ -x $source/android-configure && -x $source/configure ]] || fail source-layout

step=patch
for name in "${NODE_PATCHES[@]}"; do
    patch --batch --forward --fuzz=0 --no-backup-if-mismatch -p1 -d "$source" < "$here/patches/node/$name"
done

step=configure
# S2.1 §4, exactly: API-level NDK drivers, explicit 16 KB pages and a static C++ runtime for every ABI, and for
# ARMv7 NDK Clang -m32 host compilers with the g++ -m32 host linker.
export PATH="$toolchain:$PATH"
export CC="$toolchain/$triple$NODE_API-clang"
export CXX="$toolchain/$triple$NODE_API-clang++"
export AR="$toolchain/llvm-ar"
export RANLIB="$toolchain/llvm-ranlib"
export CC_host=gcc CXX_host=g++ AR_host=ar LINK_host=g++ LDFLAGS_host=
if [[ $abi == armeabi-v7a ]]; then
    export CC_host="$toolchain/clang -m32" CXX_host="$toolchain/clang++ -m32" LINK_host='g++ -m32'
fi
export LDFLAGS='-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384 -static-libstdc++'
export GYP_CROSSCOMPILE=1
export GYP_DEFINES="target_arch=$cpu v8_target_arch=$cpu android_target_arch=$cpu host_os=linux OS=android android_ndk_path=$ndk"
cd -- "$source"
rm -f config.gypi config.mk config.status icu_config.gypi
./android-configure "$ndk" "$NODE_API" "$arch" 2>&1 | tee "$work/configure.log"
# The wrapper ignores configure's exit status: require its success marker, fresh outputs and S2.1's assertions.
grep -q 'INFO: configure completed successfully' "$work/configure.log" || fail configure-failed
[[ -f config.gypi && -f out/Makefile ]] || fail configure-output
python3 -B "$here/fetch-node.py" --check-config "$abi=$source" --ndk "$ndk" > "$work/config.json"

step=make
make -j"$jobs"
[[ -f out/Release/node && ! -L out/Release/node ]] || fail node-missing

step=strip
mkdir -p -- "$output"
library=$(mktemp "$output/.libnode.so.XXXXXX")
record=$(mktemp "$output/.node-build.json.XXXXXX")
temporary+=("$library" "$record")
"$toolchain/llvm-strip" --strip-all -o "$library" out/Release/node
chmod 0755 -- "$library"

step=audit
python3 -B "$here/fetch-node.py" --audit "$abi=$library" > "$work/audit.json"

step=record
python3 -B -I - "$record" "$work/audit.json" "$work/config.json" \
    "abi=$abi" "version=$NODE_VERSION" "tag=$NODE_TAG" "tarball=$NODE_TARBALL_NAME" \
    "tarballSha256=$NODE_TARBALL_SHA256" "signature=$NODE_SIGNATURE" "signers=$NODE_SIGNERS" \
    "patchSet=$NODE_PATCH_SET" "series=${NODE_PATCHES[*]}" "ndkRevision=$NDK_REVISION" "ndkSha256=$NDK_SHA256" \
    "ndkFrom=$ndk_from" "api=$NODE_API" "icu=$NODE_ICU" "toolchain=$toolchain/" "cc=$CC" "cxx=$CXX" \
    "ccHost=$CC_host" "cxxHost=$CXX_host" "linkHost=$LINK_host" "ldflags=$LDFLAGS" \
    "hostCompiler=$(gcc --version | head -n 1)" <<'PY'
import json
import sys

record_path, audit_path, config_path, *pairs = sys.argv[1:]
values = dict(pair.split('=', 1) for pair in pairs)
with open(audit_path, encoding='utf-8') as stream:
    audit = json.load(stream)
with open(config_path, encoding='utf-8') as stream:
    config = json.load(stream)


def tool(name):
    # NDK tools are recorded relative to the NDK's LLVM bin directory, so the record does not depend on the build path.
    return values[name].replace(values['toolchain'], 'ndk:')


record = {
    'schema': 1,
    'abi': values['abi'],
    'version': values['version'],
    'tag': values['tag'],
    'libnode': {'sha256': audit['sha256'], 'size': audit['size']},
    'source': {
        'tarball': values['tarball'],
        'sha256': values['tarballSha256'],
        'signature': values['signature'],
        'signers': [signer for signer in values['signers'].split(',') if signer],
    },
    'patchSet': {'sha256': values['patchSet'], 'series': values['series'].split()},
    'ndk': {'revision': values['ndkRevision'], 'pinnedSha256': values['ndkSha256'], 'from': values['ndkFrom']},
    'api': int(values['api']),
    'icu': values['icu'],
    'toolchain': {
        'cc': tool('cc'), 'cxx': tool('cxx'), 'ccHost': tool('ccHost'), 'cxxHost': tool('cxxHost'),
        'linkHost': tool('linkHost'), 'ldflags': values['ldflags'], 'hostCompiler': values['hostCompiler'],
    },
    'configure': config['variables'],
    'elf': {key: value for key, value in audit.items() if key not in ('abi', 'sha256', 'size')},
}
with open(record_path, 'w', encoding='utf-8') as stream:
    stream.write(json.dumps(record, indent=4, sort_keys=True) + '\n')
PY
chmod 0644 -- "$record"
mv -f -- "$library" "$output/libnode.so"
mv -f -- "$record" "$output/node-build.json"

step=cleanup
cd -- "$here"
[[ ${NODE_KEEP_BUILD:-} == 1 ]] || rm -rf -- "$work"
python3 -B -I - "$output" <<'PY'
import json
import sys

with open(sys.argv[1] + '/node-build.json', encoding='utf-8') as stream:
    record = json.load(stream)
print(json.dumps({'abi': record['abi'], 'output': sys.argv[1], 'sha256': record['libnode']['sha256'],
                  'size': record['libnode']['size'], 'tag': record['tag']}, sort_keys=True))
PY
