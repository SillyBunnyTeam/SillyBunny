#!/usr/bin/env node
// android-update.json for the Android APK release assets (plan §5.4, §5.5): generate it, or validate one.
//
// Generate:
//   node android/release/update-manifest.mjs --prerelease <true|false> --release-tag <tag>
//       --inputs-hash <hex> --signing-cert-sha256 <hex|AA:BB:..> --min-sdk <n>
//       --apk arm64-v8a=<file> --apk armeabi-v7a=<file>
//       [--default-ref <staging|release>] [--version-code <n> --version-name <name>] [--app-version <file>]
//       [--runtime-lock <file>] [--node-version <x.y.z>] [--npm-version <x.y.z>]
//       [--verify-tools <auto|require|skip>] [--apksigner <path>] [--aapt2 <path>] [--out <file>]
//     --prerelease           the channel (steps.tag.outputs.prerelease); prerelease manifests get defaultRef
//                            staging and stable ones release
//     --release-tag          the GitHub release the APKs are attached to; stable updates download from it
//     --inputs-hash          from inputs-hash.mjs or the release decision
//     --signing-cert-sha256  the expected SHA-256 of the release signing certificate (apksigner's
//                            "certificate SHA-256 digest" or keytool's colon form); written as AA:BB:...
//     --min-sdk              the APKs' minSdk (29 today)
//     --apk                  once per ABI, exactly arm64-v8a and armeabi-v7a. Upload each file under the
//                            asset name the manifest gives it, SillyBunny-android-<abi>.apk
//     --default-ref          optional; must match the channel
//     --version-code, --version-name
//                            both or neither; default: --app-version (android/app-version.properties
//                            next to this script)
//     --runtime-lock         default: android/runtime.lock next to this script. runtime.git and runtime.bash
//                            are its Termux git and bash versions; runtime.node and runtime.npm are the
//                            "version" strings of its node and npm pins, or --node-version/--npm-version
//                            while those pins are null (a flag that disagrees with a pin fails);
//                            runtime.bun is null
//     --verify-tools         auto (default): check every APK with apksigner and aapt2 when they are found and
//                            name the skipped check on stderr when not; require: fail without them; skip.
//                            The checks: apksigner verifies, one signer whose certificate SHA-256 is
//                            --signing-cert-sha256; aapt2 reports package io.github.sillybunnyteam.sillybunny,
//                            the manifest's versionCode, versionName and minSdk, native code for exactly the
//                            asset's ABI, and no application-debuggable
//     --apksigner, --aapt2   tool paths, also APKSIGNER/AAPT2; a configured tool must exist and be runnable,
//                            or generation fails. Otherwise PATH, then the newest build-tools in ANDROID_HOME
//                            or ANDROID_SDK_ROOT that can run the tool (on Windows apksigner runs as java -jar
//                            lib/apksigner.jar)
//     --out                  write the manifest to this file (default stdout)
//   Whatever --verify-tools says, every APK's assets/runtime-manifest.json (runtime-packaging.gradle.kts)
//   must name the manifest's runtime versions (versions.node, npm, git and bash) and describe exactly the
//   release ABIs in "abis". So the runtime fields match the bundled payloads, and APKs from a build with
//   -PincludeX86_64 (which adds x86_64 to every split APK's runtime-manifest.json) are refused. Release builds
//   may vary only -PdefaultRef, and the rest of the build recipe stays fixed (inputs-hash.mjs).
//
// Validate a manifest file with the app's rules (manifest-rules.mjs):
//   node android/release/update-manifest.mjs --validate <file> [--abi <abi>] [--sdk <n>] [--prerelease <true|false>]
//       [--inputs-hash <hex>] [--apk <abi>=<file> ...]
//     --abi, --sdk           also apply the device checks for a device that lists only that ABI, at that
//                            SDK level
//     --prerelease           the manifest must be for that channel; false adds the stable channel's checks
//     --inputs-hash          the manifest's inputsHash must be this one
//     --apk                  once per ABI the manifest lists, all of them: each file must have the size and
//                            SHA-256 the manifest gives. A re-attach (release-decision.mjs) checks the
//                            downloaded android-update.json and APKs of the previous release this way.
//   Prints a JSON summary.
//
// Exit 0 ok, 1 when a rule fails (message on stderr), 2 on a usage error.
//
// Beyond the app's parser (manifest-rules.mjs), a generated manifest must have: both release ABIs with
// their stable asset names, defaultRef matching the channel, versionCode within the Gradle build's range
// (1..2100000000), a lowercase inputsHash, a releaseTag the stable channel can use, and runtime.bun null.
// The exact bytes written are re-validated for every release ABI at --min-sdk before they are returned.

import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import {
    defaultRefFor,
    isMainModule,
    isPlainObject,
    MAX_VERSION_CODE,
    parseAppVersionProperties,
    parseBooleanOption,
    parseCliArgs,
    parsePositiveIntegerOption,
    RELEASE_ABIS,
    ReleaseToolError,
    requireOption,
    runCli,
    runtimeLockPins,
    sha256File,
    UsageError,
} from './common.mjs';
import {
    isManifestText,
    isStableDownloadTag,
    MAX_APK_BYTES,
    normalizeFingerprint,
    validateManifestBytes,
} from './manifest-rules.mjs';

export { RELEASE_ABIS };
export const RELEASE_PACKAGE = 'io.github.sillybunnyteam.sillybunny';
const VERIFY_MODES = ['auto', 'require', 'skip'];

/** The stable release asset name of an ABI's APK (§5.4). */
export function releaseAssetName(abi) {
    return `SillyBunny-android-${abi}.apk`;
}

/** A signing certificate SHA-256 in the manifest's form, AA:BB:... (both forms the app accepts). */
export function formatSigningCert(value) {
    const hex = normalizeFingerprint(value);
    if (hex === null) {
        throw new ReleaseToolError('the signing certificate SHA-256 must be 64 hex digits or 32 colon-separated hex pairs');
    }
    return hex.toUpperCase().match(/../g).join(':');
}

/** runtime versions for the manifest from a parsed android/runtime.lock (see the header). */
export function runtimeVersionsFromLock(lock, { nodeVersion, npmVersion } = {}) {
    if (!isPlainObject(lock) || lock.schema !== 1 || !isPlainObject(lock.termux) || !Array.isArray(lock.termux.packages)) {
        throw new ReleaseToolError('android/runtime.lock must be a schema 1 lock with termux.packages');
    }
    const termuxVersion = name => {
        const pins = lock.termux.packages.filter(pin => isPlainObject(pin) && pin.name === name);
        if (pins.length !== 1 || typeof pins[0].version !== 'string' || pins[0].version === '') {
            throw new ReleaseToolError(`android/runtime.lock must pin exactly one Termux ${name} package with a version`);
        }
        return pins[0].version;
    };
    const pins = runtimeLockPins(lock);
    const pinnedVersion = (name, explicit) => {
        const pin = pins[name];
        if (pin === null) {
            if (explicit === undefined) {
                throw new ReleaseToolError(`android/runtime.lock does not pin ${name} yet; pass --${name}-version`);
            }
            return explicit;
        }
        if (explicit !== undefined && explicit !== pin) {
            throw new ReleaseToolError(`--${name}-version ${explicit} differs from ${name} ${pin} in android/runtime.lock`);
        }
        return pin;
    };
    if (lock.bun !== null && lock.bun !== undefined) {
        throw new ReleaseToolError('android/runtime.lock pins bun, but APKs do not bundle Bun (plan §9.10) and runtime.bun must stay null');
    }
    return {
        node: pinnedVersion('node', nodeVersion),
        bun: null,
        git: termuxVersion('git'),
        bash: termuxVersion('bash'),
        npm: pinnedVersion('npm', npmVersion),
    };
}

/**
 * Builds android-update.json from already measured assets ({ <abi>: { sha256, size } }).
 * Pure: returns { manifest, text } or throws a ReleaseToolError naming the rule.
 */
export function buildManifest({
    prerelease,
    defaultRef,
    releaseTag,
    inputsHash,
    signingCertSha256,
    minSdk,
    versionCode,
    versionName,
    assets,
    runtime,
} = {}) {
    if (typeof prerelease !== 'boolean') {
        throw new UsageError('prerelease must be true or false');
    }
    const channelRef = defaultRefFor(prerelease);
    if (defaultRef !== undefined && defaultRef !== channelRef) {
        throw new ReleaseToolError(`defaultRef ${defaultRef} does not match a ${prerelease ? 'prerelease' : 'stable release'}, which uses ${channelRef}`);
    }
    if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > MAX_VERSION_CODE) {
        throw new ReleaseToolError(`versionCode must be an integer from 1 to ${MAX_VERSION_CODE}`);
    }
    if (!isManifestText(versionName, 128)) {
        throw new ReleaseToolError('versionName must be a non-blank string of at most 128 characters without control characters');
    }
    if (!isStableDownloadTag(releaseTag)) {
        throw new ReleaseToolError(`releaseTag ${JSON.stringify(releaseTag)} cannot form the app's stable download URL (UpdateRepository.encodeReleaseTag)`);
    }
    if (typeof inputsHash !== 'string' || !/^[0-9a-f]{64}$/.test(inputsHash)) {
        throw new ReleaseToolError('inputsHash must be 64 lowercase hex digits');
    }
    if (!Number.isSafeInteger(minSdk) || minSdk < 1 || minSdk > 2147483647) {
        throw new ReleaseToolError('minSdk must be a positive integer');
    }
    const abis = Object.keys(assets ?? {}).sort();
    if (abis.join(',') !== [...RELEASE_ABIS].sort().join(',')) {
        throw new ReleaseToolError(`release APKs must be exactly ${RELEASE_ABIS.join(' and ')}, not ${abis.join(', ') || 'none'}`);
    }
    const manifestAssets = {};
    for (const abi of RELEASE_ABIS) {
        const { sha256, size } = assets[abi];
        if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
            throw new ReleaseToolError(`the ${abi} APK sha256 must be 64 lowercase hex digits`);
        }
        if (!Number.isSafeInteger(size) || size < 1 || size > MAX_APK_BYTES) {
            throw new ReleaseToolError(`the ${abi} APK size must be 1 to ${MAX_APK_BYTES} bytes`);
        }
        manifestAssets[abi] = { name: releaseAssetName(abi), sha256, size };
    }
    if (!isPlainObject(runtime) || runtime.bun !== null) {
        throw new ReleaseToolError('runtime.bun must be null: APKs do not bundle Bun (plan §9.10)');
    }
    const manifest = {
        schema: 1,
        versionCode,
        versionName,
        prerelease,
        releaseTag,
        defaultRef: channelRef,
        minSdk,
        signingCertSha256: formatSigningCert(signingCertSha256),
        inputsHash,
        assets: manifestAssets,
        runtime: { node: runtime.node, bun: null, git: runtime.git, bash: runtime.bash, npm: runtime.npm },
    };
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    const bytes = Buffer.from(text, 'utf8');
    for (const abi of RELEASE_ABIS) {
        validateManifestBytes(bytes, { abi, sdk: minSdk, stableChannel: !prerelease });
    }
    return { manifest, text };
}

/** Size and SHA-256 of one APK file, both taken from the same read. */
export async function measureApk(abi, file) {
    let stats;
    try {
        stats = statSync(file);
    } catch (error) {
        throw new ReleaseToolError(`the ${abi} APK ${file} cannot be read: ${error.code ?? error.message}`);
    }
    if (!stats.isFile()) {
        throw new ReleaseToolError(`the ${abi} APK ${file} is not a regular file`);
    }
    if (stats.size < 1 || stats.size > MAX_APK_BYTES) {
        throw new ReleaseToolError(`the ${abi} APK ${file} is ${stats.size} bytes; the app accepts 1 to ${MAX_APK_BYTES}`);
    }
    let measured;
    try {
        measured = await sha256File(file);
    } catch (error) {
        throw new ReleaseToolError(`the ${abi} APK ${file} cannot be read: ${error.code ?? error.message}`);
    }
    if (measured.size !== stats.size) {
        throw new ReleaseToolError(`the ${abi} APK ${file} changed while it was read`);
    }
    return measured;
}

/**
 * Checks APK files against a manifest normalized by manifest-rules.mjs: exactly one file for every ABI
 * the manifest lists, each with the listed size and SHA-256. This is how a re-attach (§6.1) confirms
 * that the previous release's downloaded assets are byte for byte the ones its manifest describes.
 * Returns the checked ABIs.
 */
export async function checkApksAgainstManifest(manifest, apks) {
    const expected = Object.keys(manifest.assets).sort();
    const given = Object.keys(apks ?? {}).sort();
    if (given.join(',') !== expected.join(',')) {
        throw new ReleaseToolError(`the APKs must be exactly the manifest's ${expected.join(', ')}, not ${given.join(', ') || 'none'}`);
    }
    for (const abi of expected) {
        const { sha256, size } = await measureApk(abi, apks[abi]);
        const asset = manifest.assets[abi];
        if (size !== asset.size || sha256 !== asset.sha256) {
            throw new ReleaseToolError(`the ${abi} APK ${apks[abi]} has ${size} bytes and SHA-256 ${sha256}; android-update.json lists ${asset.size} bytes and ${asset.sha256}`);
        }
    }
    return expected;
}

const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_END_LENGTH = 22;
const MAX_ZIP_ENTRY_BYTES = 2 * 1024 * 1024;

const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit++) {
        crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    return crc >>> 0;
});

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function readExactly(fd, position, length) {
    const buffer = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
        const count = readSync(fd, buffer, done, length - done, position + done);
        if (count === 0) {
            throw new ReleaseToolError('the file ends inside a ZIP record');
        }
        done += count;
    }
    return buffer;
}

/**
 * The uncompressed bytes of one entry of a ZIP archive (an APK), or null when it has no entry of that name.
 * Reads only the end record, the central directory and that entry, so the APK Signing Block in front of the
 * central directory does not matter. Stored and deflated entries of up to 2 MiB are supported; ZIP64,
 * multi-disk archives, encrypted entries and duplicate names are refused, and the size and CRC-32 are checked.
 */
export function readZipEntry(file, entryName) {
    const fd = openSync(file, 'r');
    try {
        const fileSize = fstatSync(fd).size;
        const tailLength = Math.min(fileSize, ZIP_END_LENGTH + 0xffff);
        const tail = readExactly(fd, fileSize - tailLength, tailLength);
        let end = -1;
        for (let index = tailLength - ZIP_END_LENGTH; index >= 0; index--) {
            if (tail.readUInt32LE(index) === ZIP_END_SIGNATURE && index + ZIP_END_LENGTH + tail.readUInt16LE(index + 20) === tailLength) {
                end = index;
                break;
            }
        }
        if (end === -1) {
            throw new ReleaseToolError('it has no ZIP end of central directory record');
        }
        const count = tail.readUInt16LE(end + 10);
        const directorySize = tail.readUInt32LE(end + 12);
        const directoryOffset = tail.readUInt32LE(end + 16);
        if (tail.readUInt16LE(end + 4) !== 0 || tail.readUInt16LE(end + 6) !== 0 || tail.readUInt16LE(end + 8) !== count
            || count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
            throw new ReleaseToolError('multi-disk and ZIP64 archives are not supported');
        }
        if (directoryOffset + directorySize > fileSize - tailLength + end) {
            throw new ReleaseToolError('its central directory lies outside the file');
        }
        const directory = readExactly(fd, directoryOffset, directorySize);
        const wanted = Buffer.from(entryName, 'utf8');
        let found = null;
        let position = 0;
        for (let index = 0; index < count; index++) {
            if (position + 46 > directory.length || directory.readUInt32LE(position) !== ZIP_CENTRAL_SIGNATURE) {
                throw new ReleaseToolError('its central directory is corrupt');
            }
            const nameLength = directory.readUInt16LE(position + 28);
            const next = position + 46 + nameLength + directory.readUInt16LE(position + 30) + directory.readUInt16LE(position + 32);
            if (next > directory.length) {
                throw new ReleaseToolError('its central directory is corrupt');
            }
            if (directory.subarray(position + 46, position + 46 + nameLength).equals(wanted)) {
                if (found !== null) {
                    throw new ReleaseToolError(`it has more than one ${entryName} entry`);
                }
                found = {
                    flags: directory.readUInt16LE(position + 8),
                    method: directory.readUInt16LE(position + 10),
                    crc: directory.readUInt32LE(position + 16),
                    compressedSize: directory.readUInt32LE(position + 20),
                    size: directory.readUInt32LE(position + 24),
                    offset: directory.readUInt32LE(position + 42),
                };
            }
            position = next;
        }
        if (found === null) {
            return null;
        }
        if (found.flags & 1) {
            throw new ReleaseToolError(`its ${entryName} entry is encrypted`);
        }
        if (found.size > MAX_ZIP_ENTRY_BYTES || found.compressedSize > 2 * MAX_ZIP_ENTRY_BYTES) {
            throw new ReleaseToolError(`its ${entryName} entry is larger than 2 MiB`);
        }
        const local = readExactly(fd, found.offset, 30);
        if (local.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE) {
            throw new ReleaseToolError(`the local header of its ${entryName} entry is corrupt`);
        }
        const dataOffset = found.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        if (dataOffset + found.compressedSize > directoryOffset) {
            throw new ReleaseToolError(`its ${entryName} entry overlaps the central directory`);
        }
        const raw = readExactly(fd, dataOffset, found.compressedSize);
        let data;
        if (found.method === 0) {
            data = raw;
        } else if (found.method === 8) {
            try {
                data = inflateRawSync(raw, { maxOutputLength: MAX_ZIP_ENTRY_BYTES });
            } catch (error) {
                throw new ReleaseToolError(`its ${entryName} entry cannot be inflated: ${error.message}`);
            }
        } else {
            throw new ReleaseToolError(`its ${entryName} entry uses the unsupported compression method ${found.method}`);
        }
        if (data.length !== found.size || crc32(data) !== found.crc) {
            throw new ReleaseToolError(`its ${entryName} entry fails the size or CRC-32 check`);
        }
        return data;
    } finally {
        closeSync(fd);
    }
}

/** The asset in which runtime-packaging.gradle.kts describes the bundled runtime. */
export const RUNTIME_MANIFEST_ENTRY = 'assets/runtime-manifest.json';
const RUNTIME_VERSION_NAMES = ['node', 'npm', 'git', 'bash'];

/**
 * The runtime an APK bundles, from its assets/runtime-manifest.json (runtime-packaging.gradle.kts):
 * { versions: the flat "versions" map, abis: the sorted keys of "abis", the ABIs the build packaged }.
 */
export function readApkRuntimeManifest(abi, file) {
    let bytes;
    try {
        bytes = readZipEntry(file, RUNTIME_MANIFEST_ENTRY);
    } catch (error) {
        const detail = error instanceof ReleaseToolError ? error.message : error.code ?? error.message;
        throw new ReleaseToolError(`the ${abi} APK ${file} cannot be read as an APK: ${detail}`);
    }
    if (bytes === null) {
        throw new ReleaseToolError(`the ${abi} APK ${file} has no ${RUNTIME_MANIFEST_ENTRY}; release builds package it (runtime-packaging.gradle.kts)`);
    }
    let value;
    try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
        value = null;
    }
    if (!isPlainObject(value) || value.schema !== 1 || !isPlainObject(value.versions) || !isPlainObject(value.abis)) {
        throw new ReleaseToolError(`the ${abi} APK's ${RUNTIME_MANIFEST_ENTRY} is not schema 1 JSON with "versions" and "abis"`);
    }
    return { versions: value.versions, abis: Object.keys(value.abis).sort() };
}

/**
 * Checks every APK's assets/runtime-manifest.json against the manifest: its versions.node, npm, git and bash
 * must be the manifest's runtime fields, and its "abis" exactly the release ABIs, so that android-update.json
 * describes the bundled runtime and the build packaged no other ABI (-PincludeX86_64 adds x86_64 to the
 * runtime-manifest.json of every split APK). Returns a note for stderr.
 */
export function checkApkRuntimeManifests(manifest, apks) {
    const releaseAbis = [...RELEASE_ABIS].sort().join(', ');
    for (const abi of RELEASE_ABIS) {
        const { versions, abis } = readApkRuntimeManifest(abi, apks[abi]);
        for (const name of RUNTIME_VERSION_NAMES) {
            if (versions[name] !== manifest.runtime[name]) {
                const bundled = typeof versions[name] === 'string' ? `${name} ${versions[name]}` : `no ${name} version`;
                throw new ReleaseToolError(`the ${abi} APK's ${RUNTIME_MANIFEST_ENTRY} names ${bundled}, but android-update.json would say ${manifest.runtime[name]}`);
            }
        }
        if (abis.join(', ') !== releaseAbis) {
            throw new ReleaseToolError(`the ${abi} APK's ${RUNTIME_MANIFEST_ENTRY} describes the ABIs ${abis.join(', ') || 'none'}, not exactly ${releaseAbis}; build release APKs without -PincludeX86_64`);
        }
    }
    const { node, npm, git, bash } = manifest.runtime;
    return `${RUNTIME_MANIFEST_ENTRY} of ${RELEASE_ABIS.length} APKs matches: node ${node}, npm ${npm}, git ${git}, bash ${bash}, ABIs ${releaseAbis}`;
}

function compareVersionNames(left, right) {
    const a = left.split(/[.-]/);
    const b = right.split(/[.-]/);
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const x = a[index] ?? '';
        const y = b[index] ?? '';
        if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
            if (Number(x) !== Number(y)) {
                return Number(x) - Number(y);
            }
        } else if (x !== y) {
            return x < y ? -1 : 1;
        }
    }
    return 0;
}

function toolFiles(name, platform) {
    if (platform !== 'win32') {
        return [name];
    }
    return name === 'apksigner' ? ['apksigner.bat'] : [`${name}.exe`];
}

function pathCandidates(name, env, platform) {
    const candidates = [];
    for (const directory of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
        for (const file of toolFiles(name, platform)) {
            const candidate = directory && path.join(directory, file);
            if (candidate && existsSync(candidate)) {
                candidates.push(candidate);
            }
        }
    }
    return candidates;
}

function sdkCandidates(name, env, platform) {
    const candidates = [];
    for (const sdk of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
        if (!sdk) {
            continue;
        }
        let versions;
        try {
            versions = readdirSync(path.join(sdk, 'build-tools'));
        } catch {
            continue;
        }
        for (const version of versions.sort(compareVersionNames).reverse()) {
            for (const file of toolFiles(name, platform)) {
                const candidate = path.join(sdk, 'build-tools', version, file);
                if (existsSync(candidate)) {
                    candidates.push(candidate);
                }
            }
        }
    }
    return candidates;
}

// The command that runs a tool file, or { missingJar } when the jar that apksigner wraps is absent.
function toolCommand(name, file, env, platform) {
    // apksigner.bat cannot be spawned without a shell; run the jar it wraps instead.
    const jar = file.endsWith('.jar')
        ? file
        : name === 'apksigner' && platform === 'win32' ? path.join(path.dirname(file), 'lib', 'apksigner.jar') : null;
    if (jar === null) {
        return { command: file, args: [], path: file };
    }
    if (!existsSync(jar)) {
        return { missingJar: jar };
    }
    const java = env.JAVA_HOME ? path.join(env.JAVA_HOME, 'bin', platform === 'win32' ? 'java.exe' : 'java') : 'java';
    return { command: java, args: ['-jar', jar], path: jar };
}

/**
 * Locates apksigner and aapt2 (see the header). A tool configured by flag or by APKSIGNER/AAPT2 must be a
 * file that can be run, or this throws a ReleaseToolError naming it. Discovery on PATH and in the SDK
 * skips candidates that cannot be run; a tool it does not find is null, and its checks are then skipped.
 */
export function findBuildTools({ env = process.env, platform = process.platform, apksigner, aapt2 } = {}) {
    const resolve = (name, explicit, variable) => {
        const configured = explicit ?? (env[variable] || undefined);
        if (configured === undefined) {
            for (const file of [...pathCandidates(name, env, platform), ...sdkCandidates(name, env, platform)]) {
                const tool = toolCommand(name, file, env, platform);
                if (!tool.missingJar) {
                    return tool;
                }
            }
            return null;
        }
        const source = explicit === undefined ? variable : `--${name}`;
        if (!existsSync(configured)) {
            throw new ReleaseToolError(`${name} ${configured} (${source}) does not exist`);
        }
        if (!statSync(configured).isFile()) {
            throw new ReleaseToolError(`${name} ${configured} (${source}) is not a file`);
        }
        const tool = toolCommand(name, configured, env, platform);
        if (tool.missingJar) {
            throw new ReleaseToolError(`${name} ${configured} (${source}) cannot be run: ${tool.missingJar}, the jar it wraps, does not exist`);
        }
        return tool;
    };
    return { apksigner: resolve('apksigner', apksigner, 'APKSIGNER'), aapt2: resolve('aapt2', aapt2, 'AAPT2') };
}

function spawnTool(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000, windowsHide: true });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error ?? null };
}

/** Signer certificate digests from `apksigner verify --verbose --print-certs` (old and new formats). */
export function parseApksignerOutput(stdout) {
    let signerCount = null;
    const digests = new Set();
    for (const line of stdout.split(/\r?\n/)) {
        const count = /^Number of signers: (\d+)$/.exec(line.trim());
        if (count) {
            signerCount = Number(count[1]);
        }
        const digest = /^(.*?)certificate SHA-256 digest: ([0-9a-fA-F]{64})$/.exec(line.trim());
        if (digest && !/^source stamp/i.test(digest[1])) {
            digests.add(digest[2].toLowerCase());
        }
    }
    return { signerCount, digests: [...digests] };
}

/** The fields this tooling checks from `aapt2 dump badging`. */
export function parseBadging(stdout) {
    const lines = stdout.split(/\r?\n/);
    const packageLine = lines.find(line => line.startsWith('package: ')) ?? '';
    const attribute = name => new RegExp(`(?:^package: |\\s)${name}='([^']*)'`).exec(packageLine)?.[1] ?? null;
    const sdkLine = lines.map(line => /^minSdkVersion:'(\d+)'$/.exec(line)).find(Boolean)
        ?? lines.map(line => /^sdkVersion:'(\d+)'$/.exec(line)).find(Boolean);
    const nativeLine = lines.find(line => line.startsWith('native-code:'));
    return {
        packageName: attribute('name'),
        versionCode: attribute('versionCode'),
        versionName: attribute('versionName'),
        minSdk: sdkLine ? Number(sdkLine[1]) : null,
        nativeCode: nativeLine ? [...nativeLine.matchAll(/'([^']*)'/g)].map(match => match[1]) : [],
        debuggable: lines.some(line => line.trim() === 'application-debuggable'),
    };
}

/**
 * Checks the APKs against the manifest with apksigner and aapt2 (see the header).
 * Returns stderr notes; throws a ReleaseToolError on a mismatch, or for a missing tool in require mode.
 */
export function verifyApksWithTools({ apks, manifest, tools, mode = 'auto', run = spawnTool }) {
    const notes = [];
    const expectedSigner = normalizeFingerprint(manifest.signingCertSha256);
    for (const [name, tool] of [['apksigner', tools.apksigner], ['aapt2', tools.aapt2]]) {
        if (!tool) {
            if (mode === 'require') {
                throw new ReleaseToolError(`${name} was not found and --verify-tools require was given`);
            }
            notes.push(`${name} not found (pass --${name}, set ${name.toUpperCase()}, put it on PATH or set ANDROID_HOME); skipped its APK checks`);
        }
    }
    for (const abi of RELEASE_ABIS) {
        const file = apks[abi];
        if (tools.apksigner) {
            const result = run(tools.apksigner.command, [...tools.apksigner.args, 'verify', '--verbose', '--print-certs', file]);
            if (result.error || result.status !== 0) {
                const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map(line => line.trim());
                const detail = result.error?.message ?? lines.find(line => line.startsWith('ERROR'))
                    ?? lines.find(line => /not verify/i.test(line)) ?? `exit ${result.status}`;
                throw new ReleaseToolError(`apksigner does not verify the ${abi} APK: ${detail}`);
            }
            const { signerCount, digests } = parseApksignerOutput(result.stdout);
            if ((signerCount !== null && signerCount !== 1) || digests.length !== 1) {
                // Key rotation (v3.1) reports one signer with two certificates; count certificates then.
                const count = digests.length === 1 ? signerCount : digests.length;
                throw new ReleaseToolError(`the ${abi} APK has ${count} signers; the updater supports exactly one (plan §5.5)`);
            }
            if (digests[0] !== expectedSigner) {
                throw new ReleaseToolError(`the ${abi} APK is signed by certificate ${digests[0]}, not the expected ${expectedSigner}`);
            }
        }
        if (tools.aapt2) {
            const result = run(tools.aapt2.command, [...tools.aapt2.args, 'dump', 'badging', file]);
            if (result.error || result.status !== 0) {
                throw new ReleaseToolError(`aapt2 cannot read the ${abi} APK: ${result.error ? result.error.message : result.stderr.trim().split(/\r?\n/)[0] || `exit ${result.status}`}`);
            }
            const badging = parseBadging(result.stdout);
            const problems = [];
            if (badging.packageName !== RELEASE_PACKAGE) {
                problems.push(`package ${badging.packageName} is not ${RELEASE_PACKAGE}`);
            }
            if (badging.versionCode !== String(manifest.versionCode)) {
                problems.push(`versionCode ${badging.versionCode} is not ${manifest.versionCode}`);
            }
            if (badging.versionName !== manifest.versionName) {
                problems.push(`versionName ${JSON.stringify(badging.versionName)} is not ${JSON.stringify(manifest.versionName)}`);
            }
            if (badging.minSdk !== manifest.minSdk) {
                problems.push(`minSdk ${badging.minSdk} is not ${manifest.minSdk}`);
            }
            if (badging.nativeCode.length !== 1 || badging.nativeCode[0] !== abi) {
                problems.push(`native code is ${badging.nativeCode.join(' ') || 'missing'}, not ${abi} alone`);
            }
            if (badging.debuggable) {
                problems.push('it is debuggable');
            }
            if (problems.length > 0) {
                throw new ReleaseToolError(`the ${abi} APK does not match the manifest: ${problems.join('; ')}`);
            }
        }
    }
    if (tools.apksigner || tools.aapt2) {
        const checked = [tools.apksigner && 'apksigner', tools.aapt2 && 'aapt2'].filter(Boolean).join(' and ');
        notes.push(`${checked} checked ${RELEASE_ABIS.length} APKs: versionCode ${manifest.versionCode}, signer ${manifest.signingCertSha256}`);
    }
    return notes;
}

/**
 * Measures the APKs, builds the manifest, compares it with each APK's assets/runtime-manifest.json and
 * optionally checks the APKs with the SDK tools.
 * `apks` maps each release ABI to a file; `runtimeLock` is the parsed android/runtime.lock.
 * `tools` (resolved commands) overrides discovery, which otherwise uses `toolPaths` and `env`.
 * Returns { manifest, text, notes }.
 */
export async function generateManifest({
    apks,
    runtimeLock,
    nodeVersion,
    npmVersion,
    verifyTools = 'auto',
    tools,
    toolPaths = {},
    run,
    env = process.env,
    ...fields
} = {}) {
    if (!VERIFY_MODES.includes(verifyTools)) {
        throw new UsageError(`--verify-tools must be ${VERIFY_MODES.join(', ')}`);
    }
    const abis = Object.keys(apks ?? {}).sort();
    if (abis.join(',') !== [...RELEASE_ABIS].sort().join(',')) {
        throw new ReleaseToolError(`release APKs must be exactly ${RELEASE_ABIS.join(' and ')}, not ${abis.join(', ') || 'none'}`);
    }
    const runtime = runtimeVersionsFromLock(runtimeLock, { nodeVersion, npmVersion });
    const assets = {};
    for (const abi of RELEASE_ABIS) {
        assets[abi] = await measureApk(abi, apks[abi]);
    }
    const { manifest, text } = buildManifest({ ...fields, assets, runtime });
    const notes = [checkApkRuntimeManifests(manifest, apks)];
    notes.push(...(verifyTools === 'skip'
        ? ['--verify-tools skip: the APKs were not checked with apksigner or aapt2']
        : verifyApksWithTools({ apks, manifest, tools: tools ?? findBuildTools({ env, ...toolPaths }), mode: verifyTools, run })));
    return { manifest, text, notes };
}

const releaseDir = path.dirname(fileURLToPath(import.meta.url));

function readJsonFile(file, what) {
    let text;
    try {
        text = readFileSync(file, 'utf8');
    } catch (error) {
        throw new ReleaseToolError(`cannot read ${what} ${file}: ${error.code ?? error.message}`);
    }
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new ReleaseToolError(`${what} ${file} is not JSON: ${error.message}`);
    }
}

function parseApkOptions(values) {
    const apks = {};
    for (const option of values ?? []) {
        const separator = option.indexOf('=');
        const abi = option.slice(0, separator);
        if (separator < 1 || option.length === separator + 1) {
            throw new UsageError(`--apk must look like <abi>=<file>, not ${JSON.stringify(option)}`);
        }
        if (Object.hasOwn(apks, abi)) {
            throw new UsageError(`--apk ${abi} is given twice`);
        }
        apks[abi] = option.slice(separator + 1);
    }
    return apks;
}

function rejectOptions(values, names, reason) {
    const given = names.filter(name => values[name] !== undefined);
    if (given.length > 0) {
        throw new UsageError(`--${given[0]} ${reason}`);
    }
}

const GENERATE_ONLY_OPTIONS = ['release-tag', 'signing-cert-sha256', 'min-sdk', 'default-ref', 'version-code', 'version-name',
    'app-version', 'runtime-lock', 'node-version', 'npm-version', 'verify-tools', 'apksigner', 'aapt2', 'out'];

async function validateCli(values) {
    rejectOptions(values, GENERATE_ONLY_OPTIONS, 'cannot be used with --validate');
    const prerelease = values.prerelease === undefined ? undefined : parseBooleanOption(values.prerelease, 'prerelease');
    const sdk = values.sdk === undefined ? undefined : parsePositiveIntegerOption(values.sdk, 'sdk');
    const inputsHash = values['inputs-hash'];
    if (inputsHash !== undefined && !/^[0-9a-f]{64}$/.test(inputsHash)) {
        throw new UsageError('--inputs-hash must be 64 lowercase hex digits');
    }
    const apks = values.apk === undefined ? null : parseApkOptions(values.apk);
    let bytes;
    try {
        bytes = readFileSync(values.validate);
    } catch (error) {
        throw new ReleaseToolError(`cannot read ${values.validate}: ${error.code ?? error.message}`);
    }
    const manifest = validateManifestBytes(bytes, { abi: values.abi, sdk, stableChannel: prerelease === false });
    if (prerelease !== undefined && manifest.prerelease !== prerelease) {
        throw new ReleaseToolError(`android-update.json prerelease is ${manifest.prerelease}, expected ${prerelease}`);
    }
    if (inputsHash !== undefined && manifest.inputsHash !== inputsHash) {
        throw new ReleaseToolError(`android-update.json inputsHash is ${manifest.inputsHash}, expected ${inputsHash}`);
    }
    const checkedApks = apks === null ? [] : await checkApksAgainstManifest(manifest, apks);
    process.stdout.write(`${JSON.stringify({
        valid: true,
        versionCode: manifest.versionCode.toString(),
        versionName: manifest.versionName,
        prerelease: manifest.prerelease,
        releaseTag: manifest.releaseTag,
        defaultRef: manifest.defaultRef,
        inputsHash: manifest.inputsHash,
        abis: Object.keys(manifest.assets),
        assets: Object.fromEntries(Object.entries(manifest.assets).map(([abi, asset]) => [abi, asset.name])),
        checkedApks,
    }, null, 2)}\n`);
}

async function main(argv) {
    const values = parseCliArgs(argv, {
        'validate': { type: 'string' },
        'abi': { type: 'string' },
        'sdk': { type: 'string' },
        'prerelease': { type: 'string' },
        'release-tag': { type: 'string' },
        'inputs-hash': { type: 'string' },
        'signing-cert-sha256': { type: 'string' },
        'min-sdk': { type: 'string' },
        'apk': { type: 'string', multiple: true },
        'default-ref': { type: 'string' },
        'version-code': { type: 'string' },
        'version-name': { type: 'string' },
        'app-version': { type: 'string' },
        'runtime-lock': { type: 'string' },
        'node-version': { type: 'string' },
        'npm-version': { type: 'string' },
        'verify-tools': { type: 'string' },
        'apksigner': { type: 'string' },
        'aapt2': { type: 'string' },
        'out': { type: 'string' },
    });
    if (values.validate !== undefined) {
        await validateCli(values);
        return;
    }
    rejectOptions(values, ['abi', 'sdk'], 'needs --validate');

    let version;
    if (values['version-code'] !== undefined || values['version-name'] !== undefined) {
        rejectOptions(values, ['app-version'], 'cannot be combined with --version-code and --version-name');
        version = {
            versionCode: parsePositiveIntegerOption(requireOption(values, 'version-code'), 'version-code'),
            versionName: requireOption(values, 'version-name'),
        };
    } else {
        const file = values['app-version'] ?? path.join(releaseDir, '..', 'app-version.properties');
        let bytes;
        try {
            bytes = readFileSync(file);
        } catch (error) {
            throw new ReleaseToolError(`cannot read ${file}: ${error.code ?? error.message}`);
        }
        version = parseAppVersionProperties(bytes, file);
    }

    const result = await generateManifest({
        prerelease: parseBooleanOption(requireOption(values, 'prerelease'), 'prerelease'),
        defaultRef: values['default-ref'],
        releaseTag: requireOption(values, 'release-tag'),
        inputsHash: requireOption(values, 'inputs-hash'),
        signingCertSha256: requireOption(values, 'signing-cert-sha256'),
        minSdk: parsePositiveIntegerOption(requireOption(values, 'min-sdk'), 'min-sdk'),
        ...version,
        apks: parseApkOptions(values.apk),
        runtimeLock: readJsonFile(values['runtime-lock'] ?? path.join(releaseDir, '..', 'runtime.lock'), 'runtime lock'),
        nodeVersion: values['node-version'],
        npmVersion: values['npm-version'],
        verifyTools: values['verify-tools'] ?? 'auto',
        toolPaths: { apksigner: values.apksigner, aapt2: values.aapt2 },
    });
    for (const note of result.notes) {
        process.stderr.write(`update-manifest: ${note}\n`);
    }
    if (values.out === undefined) {
        process.stdout.write(result.text);
    } else {
        writeFileSync(values.out, result.text);
    }
}

if (isMainModule(import.meta.url)) {
    await runCli('update-manifest', main);
}
