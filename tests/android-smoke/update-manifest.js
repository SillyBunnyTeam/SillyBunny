/* global BigInt */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// A port of android/app/src/main/java/io/github/sillybunnyteam/sillybunny/update/UpdateManifest.kt
// (UpdateManifestParser + UpdateJson), ApkVerifier.normalizeFingerprint and the URL rules of
// UpdateHttpClient.validatedUrl. Keep them in step: generated manifests are only useful if the app
// accepts them.

export const MANIFEST_NAME = 'android-update.json';
export const RELEASES_INDEX_NAME = 'releases.json';
export const MAX_APK_BYTES = 300 * 1024 * 1024;
export const MAX_ASSETS = 16;
export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
export const MAX_URL_LENGTH = 8_192;

const MAX_DEPTH = 32;
const MAX_NODES = 30_000;
const MAX_ENTRIES = 4_096;
// android.util.JsonReader reads unquoted literals through a 1024-char buffer. A longer number becomes
// a STRING token, which the non-lenient reader refuses.
const ANDROID_LITERAL_LIMIT = 1_024;
const LONG_MAX = 9223372036854775807n;
const INT_MAX = 2147483647n;

const HEX_64 = /^[0-9a-fA-F]{64}$/;
const COLON_FINGERPRINT = /^(?:[0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}$/;
const ABI_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}\.apk$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const NUMBER_TOKEN = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
// Kotlin's Char.isWhitespace(): Unicode space, line and paragraph separators plus the ASCII controls.
const KOTLIN_BLANK = /^[\t\n\u000b\f\r\u001c-\u001f\p{Zs}\p{Zl}\p{Zp}]*$/u;

/** A JSON number kept as its literal, like UpdateJson.Number. */
class JsonNumber {
    constructor(literal) {
        this.literal = literal;
    }

    /** @returns {bigint|null} The value when the literal is a positive integer that fits a Kotlin Long. */
    positiveLong() {
        if (!POSITIVE_INTEGER.test(this.literal)) {
            return null;
        }
        const value = BigInt(this.literal);
        return value <= LONG_MAX ? value : null;
    }
}

class Rejection extends Error {}

function reject(reason) {
    throw new Rejection(reason);
}

function validUnicode(value) {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) {
                return false;
            }
            index++;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            return false;
        }
    }
    return true;
}

/** UpdateJson.strictTokens: refuses escapes and literals that Android's strict reader would still accept. */
function strictTokens(json) {
    let index = 0;
    while (index < json.length) {
        const char = json[index++];
        if (' \t\r\n{}[]:,'.includes(char)) {
            continue;
        }
        if (char === '"') {
            let closed = false;
            while (index < json.length) {
                const next = json[index++];
                if (next.charCodeAt(0) < 0x20) {
                    return false;
                }
                if (next === '"') {
                    closed = true;
                    break;
                }
                if (next === '\\') {
                    if (index >= json.length) {
                        return false;
                    }
                    const escape = json[index++];
                    if (escape === 'u') {
                        if (index + 4 > json.length) {
                            return false;
                        }
                        for (let count = 0; count < 4; count++) {
                            if (!'0123456789abcdefABCDEF'.includes(json[index++])) {
                                return false;
                            }
                        }
                    } else if (!'"\\/bfnrt'.includes(escape)) {
                        return false;
                    }
                }
            }
            if (!closed) {
                return false;
            }
            continue;
        }
        if (!'-0123456789tfn'.includes(char)) {
            return false;
        }
        const start = index - 1;
        while (index < json.length && !' \t\r\n{}[]:,'.includes(json[index])) {
            index++;
        }
        const literal = json.slice(start, index);
        if (literal !== 'true' && literal !== 'false' && literal !== 'null' && !JSON_NUMBER.test(literal)) {
            return false;
        }
    }
    return true;
}

/** A strict JSON reader that keeps number literals and refuses duplicate names, like UpdateJson.readValue. */
class StrictJsonReader {
    constructor(text) {
        this.text = text;
        this.index = 0;
        this.remaining = MAX_NODES;
    }

    skipWhitespace() {
        while (this.index < this.text.length && ' \t\r\n'.includes(this.text[this.index])) {
            this.index++;
        }
    }

    peek() {
        this.skipWhitespace();
        return this.text[this.index];
    }

    expect(char) {
        if (this.peek() !== char) {
            reject('json.syntax');
        }
        this.index++;
    }

    readDocument() {
        const first = this.peek();
        // Android's non-lenient JsonReader only accepts an object or array at the top level.
        if (first !== '{' && first !== '[') {
            reject('json.top-level');
        }
        const value = this.readValue(0);
        if (this.peek() !== undefined) {
            reject('json.trailing');
        }
        return value;
    }

    readValue(depth) {
        if (depth > MAX_DEPTH || this.remaining-- <= 0) {
            reject('json.limits');
        }
        const char = this.peek();
        if (char === '{') {
            this.index++;
            const values = new Map();
            if (this.peek() === '}') {
                this.index++;
                return values;
            }
            while (true) {
                if (values.size >= MAX_ENTRIES) {
                    reject('json.limits');
                }
                const name = this.readString();
                if (name.length > 256 || !validUnicode(name) || values.has(name)) {
                    reject('json.name');
                }
                this.expect(':');
                values.set(name, this.readValue(depth + 1));
                const next = this.peek();
                this.index++;
                if (next === '}') {
                    return values;
                }
                if (next !== ',') {
                    reject('json.syntax');
                }
            }
        }
        if (char === '[') {
            this.index++;
            const values = [];
            if (this.peek() === ']') {
                this.index++;
                return values;
            }
            while (true) {
                if (values.length >= MAX_ENTRIES) {
                    reject('json.limits');
                }
                values.push(this.readValue(depth + 1));
                const next = this.peek();
                this.index++;
                if (next === ']') {
                    return values;
                }
                if (next !== ',') {
                    reject('json.syntax');
                }
            }
        }
        if (char === '"') {
            const value = this.readString();
            if (!validUnicode(value)) {
                reject('json.unicode');
            }
            return value;
        }
        for (const [literal, value] of [['true', true], ['false', false], ['null', null]]) {
            if (this.text.startsWith(literal, this.index)) {
                this.index += literal.length;
                return value;
            }
        }
        NUMBER_TOKEN.lastIndex = this.index;
        const match = NUMBER_TOKEN.exec(this.text);
        if (!match) {
            reject('json.syntax');
        }
        if (match[0].length >= ANDROID_LITERAL_LIMIT) {
            reject('json.literal');
        }
        this.index += match[0].length;
        return new JsonNumber(match[0]);
    }

    readString() {
        if (this.peek() !== '"') {
            reject('json.syntax');
        }
        this.index++;
        let value = '';
        while (this.index < this.text.length) {
            const char = this.text[this.index++];
            if (char === '"') {
                return value;
            }
            if (char !== '\\') {
                value += char;
                continue;
            }
            const escape = this.text[this.index++];
            const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[escape];
            if (simple !== undefined) {
                value += simple;
            } else if (escape === 'u') {
                value += String.fromCharCode(Number.parseInt(this.text.slice(this.index, this.index + 4), 16));
                this.index += 4;
            } else {
                reject('json.escape');
            }
        }
        reject('json.syntax');
    }
}

/**
 * Parses JSON like UpdateJson.parse: objects become Maps and numbers keep their literals.
 * @param {string} json JSON text.
 * @returns {any} Parsed value; throws a rejection reason on failure.
 */
function parseStrictJson(json) {
    if (typeof json !== 'string' || json.length > MAX_MANIFEST_BYTES || Buffer.byteLength(json, 'utf8') > MAX_MANIFEST_BYTES) {
        reject('json.size');
    }
    if (!strictTokens(json)) {
        reject('json.tokens');
    }
    return new StrictJsonReader(json).readDocument();
}

/**
 * ApkVerifier.normalizeFingerprint: plain or colon-separated SHA-256 hex to 32 bytes.
 * @param {string} value Fingerprint.
 * @returns {Buffer|null} Bytes.
 */
export function normalizeFingerprint(value) {
    if (typeof value !== 'string' || (!HEX_64.test(value) && !COLON_FINGERPRINT.test(value))) {
        return null;
    }
    return Buffer.from(value.replaceAll(':', ''), 'hex');
}

/**
 * UpdateManifestParser.isSafeAssetName.
 * @param {string} name Asset name.
 * @returns {boolean} True when the app accepts the name.
 */
export function isSafeAssetName(name) {
    return typeof name === 'string' && ASSET_NAME.test(name) && !name.includes('..');
}

/**
 * UpdateManifestParser.isSha256.
 * @param {string} value Hex digest.
 * @returns {boolean} True for 64 hex characters.
 */
export function isSha256(value) {
    return typeof value === 'string' && HEX_64.test(value);
}

function positiveLong(map, key) {
    const value = map.get(key);
    return value instanceof JsonNumber ? value.positiveLong() : null;
}

function text(map, key, maxLength) {
    const value = map.get(key);
    if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || KOTLIN_BLANK.test(value)) {
        return null;
    }
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code < 0x20 || code === 0x7f) {
            return null;
        }
    }
    return value;
}

function toNumber(value) {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

function parseManifestValue(root, abi, sdk) {
    if (!(root instanceof Map)) {
        reject('root');
    }
    // The device SDK is a Kotlin Int.
    if (!Number.isInteger(sdk) || sdk <= 0 || sdk > Number(INT_MAX) || typeof abi !== 'string' || !ABI_NAME.test(abi)) {
        reject('device');
    }
    if (positiveLong(root, 'schema') !== 1n) {
        reject('schema');
    }
    const versionCode = positiveLong(root, 'versionCode') ?? reject('versionCode');
    const versionName = text(root, 'versionName', 128) ?? reject('versionName');
    const prerelease = root.get('prerelease');
    if (typeof prerelease !== 'boolean') {
        reject('prerelease');
    }
    const releaseTag = text(root, 'releaseTag', 256) ?? reject('releaseTag');
    const defaultRef = root.get('defaultRef');
    if (defaultRef !== 'release' && defaultRef !== 'staging') {
        reject('defaultRef');
    }
    const minSdk = positiveLong(root, 'minSdk');
    if (minSdk === null || minSdk > BigInt(sdk) || minSdk > INT_MAX) {
        reject('minSdk');
    }
    const fingerprint = normalizeFingerprint(root.get('signingCertSha256')) ?? reject('signingCertSha256');
    const inputsHash = root.get('inputsHash');
    if (!isSha256(inputsHash)) {
        reject('inputsHash');
    }

    const assets = root.get('assets');
    if (!(assets instanceof Map) || assets.size === 0 || assets.size > MAX_ASSETS) {
        reject('assets');
    }
    let selected = null;
    const names = new Set();
    for (const [key, value] of assets) {
        if (!ABI_NAME.test(key)) {
            reject(`assets.${key}`);
        }
        if (!(value instanceof Map)) {
            reject(`assets.${key}`);
        }
        const name = value.get('name');
        if (!isSafeAssetName(name)) {
            reject(`assets.${key}.name`);
        }
        if (names.has(name)) {
            reject(`assets.${key}.name.duplicate`);
        }
        names.add(name);
        const sha256 = value.get('sha256');
        if (!isSha256(sha256)) {
            reject(`assets.${key}.sha256`);
        }
        const size = positiveLong(value, 'size');
        if (size === null || size > BigInt(MAX_APK_BYTES)) {
            reject(`assets.${key}.size`);
        }
        if (key === abi) {
            selected = { name, sha256: sha256.toLowerCase(), size: Number(size) };
        }
    }

    const runtime = root.get('runtime');
    if (!(runtime instanceof Map)) {
        reject('runtime');
    }
    for (const name of ['node', 'git', 'bash', 'npm']) {
        if (text(runtime, name, 128) === null) {
            reject(`runtime.${name}`);
        }
    }
    if (!runtime.has('bun') || (runtime.get('bun') !== null && text(runtime, 'bun', 128) === null)) {
        reject('runtime.bun');
    }
    if (!selected) {
        reject('assets.abi');
    }

    return {
        versionCode: toNumber(versionCode),
        versionName,
        prerelease,
        releaseTag,
        defaultRef,
        minSdk: Number(minSdk),
        signingCertSha256: fingerprint.toString('hex'),
        inputsHash: inputsHash.toLowerCase(),
        asset: selected,
    };
}

/**
 * Checks manifest text the way UpdateManifestParser.parse does for one device.
 * @param {string} json Manifest text.
 * @param {string} abi Device ABI.
 * @param {number} sdk Device SDK level.
 * @returns {{ok: true, manifest: object}|{ok: false, reason: string}} Result with the parsed manifest or the first rejection.
 */
export function checkUpdateManifest(json, abi, sdk) {
    try {
        return { ok: true, manifest: parseManifestValue(parseStrictJson(json), abi, sdk) };
    } catch (error) {
        if (error instanceof Rejection) {
            return { ok: false, reason: error.message };
        }
        return { ok: false, reason: 'error' };
    }
}

/**
 * UpdateManifestParser.parse: the parsed manifest for one device, or null when the app would reject it.
 * @param {string} json Manifest text.
 * @param {string} abi Device ABI.
 * @param {number} sdk Device SDK level.
 * @returns {object|null} Parsed manifest.
 */
export function parseUpdateManifest(json, abi, sdk) {
    const result = checkUpdateManifest(json, abi, sdk);
    return result.ok ? result.manifest : null;
}

// RFC 3986 characters that java.net.URI also takes in a path: it refuses space, quotes, braces and
// backslash everywhere, and square brackets outside an IPv6 host (which this check never accepts).
const URL_CHARACTERS = /^[A-Za-z0-9\-._~:/?@!$&'()*+,;=%]+$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const TOP_LABEL = /^[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** A host java.net.URI parses as a server-based host: an IPv4 address or an RFC 2396 hostname. */
function isUriHost(host) {
    if (/^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/.test(host)) {
        return host.split('.').every(part => Number(part) <= 255);
    }
    const labels = (host.endsWith('.') ? host.slice(0, -1) : host).split('.');
    return labels.every(label => DOMAIN_LABEL.test(label)) && TOP_LABEL.test(labels[labels.length - 1]);
}

/**
 * UpdateHttpClient.isAllowedUrl, conservatively: https, or http to exactly 127.0.0.1 in debug builds;
 * no user info, no fragment, at most 8,192 characters. Anything this accepts, the app accepts.
 * @param {string} url URL.
 * @param {object} [options] Options.
 * @param {boolean} [options.allowDebugLoopback] Debug builds also allow `http://127.0.0.1` (default true).
 * @returns {boolean} True when the app would fetch the URL.
 */
export function isAllowedUpdateUrl(url, { allowDebugLoopback = true } = {}) {
    if (typeof url !== 'string' || url.length < 1 || url.length > MAX_URL_LENGTH || !URL_CHARACTERS.test(url) || /%(?![0-9A-Fa-f]{2})/.test(url)) {
        return false;
    }
    // The scheme comparison is case-sensitive in the app (URI.scheme != "https"); '#' is not allowed above.
    const match = /^(https|http):\/\/([^/?]*)(?:[/?].*)?$/.exec(url);
    const authority = match ? /^([^:@[\]]+)(?::([0-9]*))?$/.exec(match[2]) : null;
    if (!authority || !isUriHost(authority[1])) {
        return false;
    }
    if (authority[2] && (Number(authority[2]) < 1 || Number(authority[2]) > 65_535)) {
        return false;
    }
    return match[1] === 'https' || (allowDebugLoopback && authority[1] === '127.0.0.1');
}

/**
 * Checks a releases index (the prerelease channel's GitHub releases API response) against what
 * UpdateRepository.checkReleases needs from every release: a JSON array of non-draft releases whose
 * `assets` hold exactly one android-update.json, unique names and allowed download URLs.
 * @param {string} json Index text.
 * @param {object} [options] Options.
 * @param {boolean} [options.allowDebugLoopback] Debug builds also allow `http://127.0.0.1` (default true).
 * @returns {{ok: true, releases: {manifestUrl: string, assets: Record<string, string>}[]}|{ok: false, reason: string}} Result.
 */
export function checkReleasesIndex(json, { allowDebugLoopback = true } = {}) {
    try {
        const root = parseStrictJson(json);
        if (!Array.isArray(root) || root.length === 0) {
            reject('releases');
        }
        const releases = root.map((release, index) => {
            const where = `releases.${index}`;
            if (!(release instanceof Map)) {
                reject(where);
            }
            if (release.get('draft') !== false) {
                reject(`${where}.draft`);
            }
            const assets = release.get('assets');
            if (!Array.isArray(assets)) {
                reject(`${where}.assets`);
            }
            /** @type {Record<string, string>} */
            const urls = {};
            for (const asset of assets) {
                const name = asset instanceof Map ? asset.get('name') : null;
                if (typeof name !== 'string' || Object.hasOwn(urls, name)) {
                    reject(`${where}.assets.name`);
                }
                const url = asset.get('browser_download_url');
                if (!isAllowedUpdateUrl(url, { allowDebugLoopback })) {
                    reject(`${where}.assets.${name}.url`);
                }
                urls[name] = url;
            }
            if (!Object.hasOwn(urls, MANIFEST_NAME)) {
                reject(`${where}.manifest`);
            }
            return { manifestUrl: urls[MANIFEST_NAME], assets: urls };
        });
        return { ok: true, releases };
    } catch (error) {
        if (error instanceof Rejection) {
            return { ok: false, reason: error.message };
        }
        return { ok: false, reason: 'error' };
    }
}

/**
 * The stable release asset name for an ABI.
 * @param {string} abi ABI.
 * @returns {string} Asset name.
 */
export function assetNameForAbi(abi) {
    return `SillyBunny-android-${abi}.apk`;
}

/**
 * Hashes a file.
 * @param {string} file File path.
 * @returns {Promise<{sha256: string, size: number}>} Lowercase SHA-256 and size.
 */
export async function hashFile(file) {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of fs.createReadStream(file)) {
        hash.update(chunk);
        size += chunk.length;
    }
    return { sha256: hash.digest('hex'), size };
}

/**
 * Formats 32 digest bytes as colon-separated uppercase hex, the style of the §5.4 example.
 * @param {string} hex 64 hex characters.
 * @returns {string} Fingerprint.
 */
export function colonFingerprint(hex) {
    const bytes = normalizeFingerprint(hex);
    if (!bytes) {
        throw new Error(`Not a SHA-256 fingerprint: ${hex}`);
    }
    return [...bytes].map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

function compareVersions(left, right) {
    const a = left.split('.').map(part => Number.parseInt(part, 10) || 0);
    const b = right.split('.').map(part => Number.parseInt(part, 10) || 0);
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0) {
            return difference;
        }
    }
    return 0;
}

/**
 * Finds apksigner as `java -jar <build-tools>/lib/apksigner.jar` (the .bat wrapper cannot be spawned
 * directly on Windows). Looks at APKSIGNER_JAR, then the newest build-tools under ANDROID_HOME or
 * ANDROID_SDK_ROOT; Java comes from JAVA_HOME or PATH.
 * @param {Record<string, string|undefined>} [env] Environment.
 * @returns {{command: string, args: string[]}|null} Command prefix, or null when unavailable.
 */
export function findApksigner(env = process.env) {
    let jar = env.APKSIGNER_JAR && fs.existsSync(env.APKSIGNER_JAR) ? env.APKSIGNER_JAR : null;
    for (const sdk of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
        if (jar || !sdk) {
            continue;
        }
        const buildTools = path.join(sdk, 'build-tools');
        let versions = [];
        try {
            versions = fs.readdirSync(buildTools).sort(compareVersions).reverse();
        } catch {
            continue;
        }
        for (const version of versions) {
            const candidate = path.join(buildTools, version, 'lib', 'apksigner.jar');
            if (fs.existsSync(candidate)) {
                jar = candidate;
                break;
            }
        }
    }
    if (!jar) {
        return null;
    }
    const javaName = process.platform === 'win32' ? 'java.exe' : 'java';
    const java = env.JAVA_HOME && fs.existsSync(path.join(env.JAVA_HOME, 'bin', javaName))
        ? path.join(env.JAVA_HOME, 'bin', javaName)
        : 'java';
    return { command: java, args: ['-jar', jar] };
}

// apksigner prints `Signer #1 certificate ...` (older releases) or per scheme, e.g.
// `V2 Signer: certificate ...` and `V3.1 Signer (minSdkVersion=33, ...): certificate ...`.
// Source stamp lines describe the stamp, not the app signer, and never match.
const SIGNER_DIGEST_LINE = /^(?:Signer #\d+|V\d+(?:\.\d+)? Signer(?: #\d+)?(?: \([^)]*\))?):? certificate SHA-256 digest: ([0-9a-fA-F]{64})$/;

/**
 * Reads the signing certificate SHA-256 with `apksigner verify --print-certs`. The APK must have
 * exactly one signer certificate, which is what the app's ApkVerifier accepts.
 * @param {string} apk APK path.
 * @param {object} [options] Options.
 * @param {{command: string, args: string[]}|null} [options.apksigner] Command from {@link findApksigner}.
 * @param {number} [options.minSdk] Lowest platform to verify for (the app's minSdk).
 * @returns {string} Lowercase hex digest.
 */
export function readSigningCertSha256(apk, { apksigner = findApksigner(), minSdk = 29 } = {}) {
    if (!apksigner) {
        throw new Error('apksigner was not found; pass signingCertSha256 instead.');
    }
    const result = spawnSync(apksigner.command, [
        ...apksigner.args,
        'verify',
        '--print-certs',
        '--min-sdk-version',
        String(minSdk),
        apk,
    ], { encoding: 'utf8', windowsHide: true });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`apksigner verify failed (${result.status}): ${String(result.stderr).trim()}`);
    }
    const digests = new Set();
    for (const line of String(result.stdout).split(/\r?\n/)) {
        const match = SIGNER_DIGEST_LINE.exec(line.trim());
        if (match) {
            digests.add(match[1].toLowerCase());
        }
    }
    if (digests.size !== 1) {
        throw new Error(`Expected exactly one signer in ${apk}, found ${digests.size}.`);
    }
    return [...digests][0];
}

function canonicalJson(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

/**
 * Builds and validates manifest text. Every asset ABI is parsed back with the app's rules at the
 * manifest's own minSdk; anything the app would reject throws.
 * @param {object} options Manifest fields.
 * @param {number} options.versionCode Positive versionCode.
 * @param {string} options.versionName versionName.
 * @param {boolean} [options.prerelease] Prerelease flag.
 * @param {string} options.releaseTag Release tag.
 * @param {'release'|'staging'} [options.defaultRef] Default ref.
 * @param {number} [options.minSdk] Minimum SDK.
 * @param {string} options.signingCertSha256 Signing certificate SHA-256 (plain or colon hex).
 * @param {string} [options.inputsHash] 64-hex inputs hash; derived from the other fields when omitted.
 * @param {Record<string, {name: string, sha256: string, size: number}>} options.assets Assets by ABI.
 * @param {{node: string, git: string, bash: string, npm: string}} options.runtime Bundled runtime versions.
 * @returns {{manifest: object, json: string}} Manifest object and its text.
 */
export function createUpdateManifest({
    versionCode,
    versionName,
    prerelease = false,
    releaseTag,
    defaultRef = 'release',
    minSdk = 29,
    signingCertSha256,
    inputsHash,
    assets,
    runtime,
}) {
    const fingerprint = normalizeFingerprint(signingCertSha256);
    const manifest = {
        schema: 1,
        versionCode,
        versionName,
        prerelease,
        releaseTag,
        defaultRef,
        minSdk,
        signingCertSha256: fingerprint ? colonFingerprint(fingerprint.toString('hex')) : signingCertSha256,
        inputsHash: inputsHash ?? createHash('sha256').update(canonicalJson({
            assets,
            defaultRef,
            minSdk,
            runtime,
            versionCode,
        })).digest('hex'),
        assets: Object.fromEntries(Object.entries(assets ?? {}).map(([abi, asset]) => [abi, {
            name: asset?.name,
            sha256: asset?.sha256,
            size: asset?.size,
        }])),
        runtime: {
            node: runtime?.node,
            bun: null,
            git: runtime?.git,
            bash: runtime?.bash,
            npm: runtime?.npm,
        },
    };
    const json = `${JSON.stringify(manifest, null, 4)}\n`;
    const abis = Object.keys(manifest.assets);
    if (abis.length === 0) {
        throw new Error('Invalid update manifest: assets');
    }
    const deviceSdk = Number.isInteger(minSdk) && minSdk > 0 && minSdk <= Number(INT_MAX) ? minSdk : 1;
    for (const abi of abis) {
        const result = checkUpdateManifest(json, abi, deviceSdk);
        if (!result.ok) {
            throw new Error(`Invalid update manifest: ${result.reason}`);
        }
    }
    return { manifest, json };
}

function writeAtomic(file, contents) {
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, contents);
    fs.renameSync(temporary, file);
}

/**
 * Writes an updater fixture directory: each APK copied under its stable asset name, the
 * `android-update.json` for them and, when `baseUrl` is given, a `releases.json` in the shape of the
 * GitHub releases API for the prerelease channel.
 * @param {object} options Options.
 * @param {string} options.dir Directory the static server serves.
 * @param {Record<string, string>} options.apks APK path by ABI.
 * @param {number} options.versionCode versionCode of the APKs.
 * @param {string} options.versionName versionName of the APKs.
 * @param {string} options.releaseTag Release tag.
 * @param {boolean} [options.prerelease] Prerelease flag.
 * @param {'release'|'staging'} [options.defaultRef] Default ref.
 * @param {number} [options.minSdk] Minimum SDK.
 * @param {string} [options.signingCertSha256] Signing certificate SHA-256; read with apksigner when omitted.
 * @param {string} [options.inputsHash] Inputs hash.
 * @param {{node: string, git: string, bash: string, npm: string}} options.runtime Bundled runtime versions.
 * @param {string} [options.baseUrl] URL the device uses for `dir` (the update service's device URL), for
 *     releases.json download URLs. It must pass {@link isAllowedUpdateUrl}, so `http://127.0.0.1:<port>`.
 * @param {{command: string, args: string[]}|null} [options.apksigner] apksigner command.
 * @returns {Promise<{manifest: object, manifestPath: string, releasesPath: string|null, assets: object}>} Result.
 */
export async function writeUpdateFixture({
    dir,
    apks,
    signingCertSha256,
    baseUrl,
    apksigner,
    ...fields
}) {
    const base = baseUrl === undefined ? null : String(baseUrl).replace(/\/+$/, '');
    if (base !== null && !isAllowedUpdateUrl(`${base}/${MANIFEST_NAME}`)) {
        // The app would refuse every download URL in releases.json (UpdateHttpClient.validatedUrl).
        throw new Error(`Invalid releases index: baseUrl ${baseUrl}`);
    }
    const sources = Object.entries(apks ?? {});
    for (const [abi] of sources) {
        // Asset file names are built from the ABI, so refuse an unsafe one before it reaches a path.
        if (!ABI_NAME.test(abi)) {
            throw new Error(`Invalid update manifest: assets.${abi}`);
        }
    }
    const assets = {};
    const signers = new Set();
    for (const [abi, apk] of sources) {
        assets[abi] = { name: assetNameForAbi(abi), ...(await hashFile(apk)) };
        if (!signingCertSha256) {
            const minSdk = fields.minSdk ?? 29;
            signers.add(readSigningCertSha256(apk, apksigner === undefined ? { minSdk } : { apksigner, minSdk }));
        }
    }
    if (!signingCertSha256 && signers.size !== 1) {
        throw new Error(`Expected one signing certificate across the APKs, found ${signers.size}.`);
    }
    const { manifest, json } = createUpdateManifest({
        ...fields,
        signingCertSha256: signingCertSha256 ?? [...signers][0],
        assets,
    });
    let releasesJson = null;
    if (base !== null) {
        const releases = [{
            id: manifest.versionCode,
            tag_name: manifest.releaseTag,
            draft: false,
            prerelease: manifest.prerelease,
            assets: [
                {
                    name: MANIFEST_NAME,
                    size: Buffer.byteLength(json),
                    content_type: 'application/json',
                    browser_download_url: `${base}/${MANIFEST_NAME}`,
                },
                ...Object.values(assets).map(asset => ({
                    name: asset.name,
                    size: asset.size,
                    content_type: 'application/vnd.android.package-archive',
                    browser_download_url: `${base}/${asset.name}`,
                })),
            ],
        }];
        releasesJson = `${JSON.stringify(releases, null, 4)}\n`;
        const check = checkReleasesIndex(releasesJson);
        if (!check.ok) {
            throw new Error(`Invalid releases index: ${check.reason}`);
        }
    }

    // Everything is validated before anything is written, so a refused fixture leaves the directory as it was.
    fs.mkdirSync(dir, { recursive: true });
    for (const [abi, apk] of sources) {
        const target = path.join(dir, assets[abi].name);
        if (path.resolve(apk) === path.resolve(target)) {
            continue;
        }
        // Copy beside the target and rename, so a running static server never serves a partial APK.
        const temporary = `${target}.${process.pid}.tmp`;
        fs.copyFileSync(apk, temporary);
        const copied = await hashFile(temporary);
        if (copied.sha256 !== assets[abi].sha256 || copied.size !== assets[abi].size) {
            fs.rmSync(temporary, { force: true });
            throw new Error(`APK changed while the fixture was written: ${apk}`);
        }
        fs.renameSync(temporary, target);
    }
    const manifestPath = path.join(dir, MANIFEST_NAME);
    writeAtomic(manifestPath, json);
    let releasesPath = null;
    if (releasesJson !== null) {
        releasesPath = path.join(dir, RELEASES_INDEX_NAME);
        writeAtomic(releasesPath, releasesJson);
    }
    return { manifest, manifestPath, releasesPath, assets };
}
