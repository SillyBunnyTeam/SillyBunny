// The app's android-update.json acceptance rules, mirrored for release tooling (plan §5.4, §5.5).
// Library module without a CLI; update-manifest.mjs --validate exposes it.
//
// Sources mirrored (android/app/src/main/java/io/github/sillybunnyteam/sillybunny/update/):
//   UpdateHttpClient.kt  fetchJson: body <= 2 MiB, strict UTF-8 that keeps a BOM (so a BOM fails later)
//   UpdateManifest.kt    UpdateJson.parse, UpdateManifestParser.parse(json, abis, sdk) with one ABI
//   ApkVerifier.kt       normalizeFingerprint
//   UpdateRepository.kt  checkStable (prerelease must be false), stableDownloadUrl/encodeReleaseTag
// Keep this file in step with those when the app changes. Every check names the Kotlin rule it copies.
//
// Field-by-field mapping. "text(n)" is UpdateManifestParser.text: a JSON string of 1..n UTF-16 units,
// not blank by Kotlin's isWhitespace, without U+0000-U+001F or U+007F. "positiveLong" is a JSON number
// literal matching [1-9][0-9]* that fits a signed 64-bit Long (so 1.0, 1e0, 01, -1 and 0 fail).
//   document            fetchJson + UpdateJson.parse: <= 2 MiB as UTF-8 bytes and as UTF-16 units, strict
//                       UTF-8, strictTokens (JSON-only escapes, lowercase literals, JSON number grammar,
//                       whitespace limited to space/tab/CR/LF, no BOM), a strict JsonReader document whose
//                       top level is an object or array, number literals under 1024 characters,
//                       nesting <= 32, <= 30000 values, <= 4096 entries per object or array, keys
//                       <= 256 units, no duplicate keys, no lone surrogates
//   (root)              must be an object                                  `as? Map<*, *>`
//   schema              positiveLong equal to 1
//   versionCode         positiveLong
//   versionName         text(128)
//   prerelease          JSON boolean
//   releaseTag          text(256)
//   defaultRef          JSON string "release" or "staging"
//   minSdk              positiveLong <= Int.MAX_VALUE, and <= the device SDK when one is given
//   signingCertSha256   normalizeFingerprint: [0-9a-fA-F]{64} or (?:[0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}
//   inputsHash          isSha256: [0-9a-fA-F]{64}
//   assets              object with 1..16 entries, each key matching [a-z0-9][a-z0-9_-]{0,31}
//     <abi>             object
//     <abi>.name        isSafeAssetName: [A-Za-z0-9][A-Za-z0-9._-]{0,191}\.apk without "..";
//                       names are unique across entries
//     <abi>.sha256      isSha256
//     <abi>.size        positiveLong <= 300 MiB (MAX_APK_BYTES)
//     [device ABI]      an entry for the given ABI must exist. The app takes the first ABI in
//                       Build.SUPPORTED_ABIS order that has an entry, so this checks a device that
//                       lists only that ABI
//   runtime             object; node, git, bash and npm are text(128); bun must be present and is
//                       null or text(128)
//   stable channel      UpdateRepository.checkStable: prerelease must be false; stableDownloadUrl:
//                       releaseTag must pass encodeReleaseTag (1..256 units, no leading or trailing
//                       ".", no ".lock" suffix, no "..", no "@{", no whitespace, no ISO control
//                       characters U+0000-U+001F/U+007F-U+009F, none of / \ % ? # ~ ^ : * [, and no
//                       lone surrogates)
// Unknown fields are ignored, as in the app. The device ABI, device SDK and stable-channel checks run
// only when the caller asks for them.

import { isKotlinBlank, isKotlinWhitespace, ReleaseToolError, UsageError } from './common.mjs';

export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
export const MAX_APK_BYTES = 300 * 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 30_000;
const MAX_ENTRIES = 4_096;
const MAX_KEY_LENGTH = 256;
const LONG_MAX = 9223372036854775807n;
const INT_MAX = 2147483647n;

const SHA256_HEX = /^[0-9a-fA-F]{64}$/;
const COLON_FINGERPRINT = /^(?:[0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}$/;
const ABI_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}\.apk$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const TOKEN_DELIMITERS = ' \t\r\n{}[]:,';
const JSON_WHITESPACE = ' \t\r\n';
const HEX_DIGITS = '0123456789abcdefABCDEF';
const TAG_FORBIDDEN = '/\\%?#~^:*[';

/** A JSON number kept as its literal text, like UpdateJson.Number. */
export class JsonNumber {
    constructor(literal) {
        this.literal = literal;
    }
}

function jsonError(detail) {
    return new ReleaseToolError(`android-update.json is not accepted by the app's strict JSON reader: ${detail}`);
}

function fieldError(field, rule) {
    return new ReleaseToolError(`android-update.json ${field} ${rule}`);
}

/** UpdateJson.validUnicode: every surrogate is part of a pair. */
export function isWellFormedUnicode(value) {
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

// UpdateJson.strictTokens, statement for statement.
function strictTokens(json) {
    let index = 0;
    while (index < json.length) {
        const char = json[index++];
        if (TOKEN_DELIMITERS.includes(char)) {
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
                    const escaped = json[index++];
                    if (escaped === 'u') {
                        if (index + 4 > json.length) {
                            return false;
                        }
                        for (let digit = 0; digit < 4; digit++) {
                            if (!HEX_DIGITS.includes(json[index++])) {
                                return false;
                            }
                        }
                    } else if (!'"\\/bfnrt'.includes(escaped)) {
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
        while (index < json.length && !TOKEN_DELIMITERS.includes(json[index])) {
            index++;
        }
        const literal = json.slice(start, index);
        if (literal !== 'true' && literal !== 'false' && literal !== 'null' && !JSON_NUMBER.test(literal)) {
            return false;
        }
    }
    return true;
}

/**
 * UpdateJson.parse: returns Map (objects), Array, string, JsonNumber, boolean or null.
 * Throws a ReleaseToolError where the app would return null.
 */
export function parseUpdateJson(json) {
    if (typeof json !== 'string') {
        throw jsonError('the document is not text');
    }
    if (json.length > MAX_MANIFEST_BYTES || Buffer.byteLength(json, 'utf8') > MAX_MANIFEST_BYTES) {
        throw jsonError('the document is larger than 2 MiB');
    }
    if (!strictTokens(json)) {
        throw jsonError('a token is outside strict JSON (strictTokens)');
    }

    let index = 0;
    let remaining = MAX_NODES;
    const skipWhitespace = () => {
        while (index < json.length && JSON_WHITESPACE.includes(json[index])) {
            index++;
        }
    };
    const syntaxError = () => jsonError(`syntax error at offset ${index}`);

    function readString() {
        index++;
        let value = '';
        while (true) {
            if (index >= json.length) {
                throw syntaxError();
            }
            const char = json[index++];
            if (char === '"') {
                return value;
            }
            if (char !== '\\') {
                value += char;
                continue;
            }
            const escaped = json[index++];
            switch (escaped) {
                case 'b': value += '\b'; break;
                case 'f': value += '\f'; break;
                case 'n': value += '\n'; break;
                case 'r': value += '\r'; break;
                case 't': value += '\t'; break;
                case 'u':
                    value += String.fromCharCode(Number.parseInt(json.slice(index, index + 4), 16));
                    index += 4;
                    break;
                default: value += escaped;
            }
        }
    }

    function readValue(depth) {
        if (depth > MAX_DEPTH) {
            throw jsonError('values are nested deeper than 32 levels');
        }
        if (remaining-- <= 0) {
            throw jsonError('the document has more than 30000 values');
        }
        skipWhitespace();
        const char = json[index];
        if (char === '{') {
            index++;
            const values = new Map();
            skipWhitespace();
            if (json[index] === '}') {
                index++;
                return values;
            }
            while (true) {
                if (values.size >= MAX_ENTRIES) {
                    throw jsonError('an object has more than 4096 entries');
                }
                skipWhitespace();
                if (json[index] !== '"') {
                    throw syntaxError();
                }
                const name = readString();
                if (name.length > MAX_KEY_LENGTH) {
                    throw jsonError('a key is longer than 256 characters');
                }
                if (!isWellFormedUnicode(name)) {
                    throw jsonError('a key has a lone surrogate');
                }
                if (values.has(name)) {
                    throw jsonError(`duplicate key ${JSON.stringify(name)}`);
                }
                skipWhitespace();
                if (json[index] !== ':') {
                    throw syntaxError();
                }
                index++;
                values.set(name, readValue(depth + 1));
                skipWhitespace();
                if (json[index] === ',') {
                    index++;
                } else if (json[index] === '}') {
                    index++;
                    return values;
                } else {
                    throw syntaxError();
                }
            }
        }
        if (char === '[') {
            index++;
            const values = [];
            skipWhitespace();
            if (json[index] === ']') {
                index++;
                return values;
            }
            while (true) {
                if (values.length >= MAX_ENTRIES) {
                    throw jsonError('an array has more than 4096 entries');
                }
                values.push(readValue(depth + 1));
                skipWhitespace();
                if (json[index] === ',') {
                    index++;
                } else if (json[index] === ']') {
                    index++;
                    return values;
                } else {
                    throw syntaxError();
                }
            }
        }
        if (char === '"') {
            const value = readString();
            if (!isWellFormedUnicode(value)) {
                throw jsonError('a string has a lone surrogate');
            }
            return value;
        }
        const start = index;
        while (index < json.length && !TOKEN_DELIMITERS.includes(json[index])) {
            index++;
        }
        const literal = json.slice(start, index);
        if (literal === 'true') {
            return true;
        }
        if (literal === 'false') {
            return false;
        }
        if (literal === 'null') {
            return null;
        }
        // JsonReader keeps literals in a 1024-character buffer; a longer one is read as an
        // unquoted string, which a strict reader rejects.
        if (JSON_NUMBER.test(literal) && literal.length < 1024) {
            return new JsonNumber(literal);
        }
        index = start;
        throw syntaxError();
    }

    skipWhitespace();
    // Android's JsonReader rejects other top-level values when it is not lenient.
    if (json[index] !== '{' && json[index] !== '[') {
        throw jsonError('the top-level value is not an object or an array');
    }
    const root = readValue(0);
    skipWhitespace();
    if (index !== json.length) {
        throw jsonError(`unexpected data after the top-level value at offset ${index}`);
    }
    return root;
}

/** UpdateHttpClient.fetchJson: <= 2 MiB, strict UTF-8, BOM kept (it then fails strictTokens). */
export function decodeManifestBytes(bytes) {
    if (bytes.length > MAX_MANIFEST_BYTES) {
        throw jsonError('the document is larger than 2 MiB');
    }
    try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
        throw jsonError('the document is not valid UTF-8');
    }
}

/** UpdateManifestParser.positiveLong, as a BigInt or null. */
function positiveLong(value) {
    if (!(value instanceof JsonNumber) || !POSITIVE_INTEGER.test(value.literal)) {
        return null;
    }
    const number = BigInt(value.literal);
    return number <= LONG_MAX ? number : null;
}

/** UpdateManifestParser.text. */
export function isManifestText(value, maxLength) {
    if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || isKotlinBlank(value)) {
        return false;
    }
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code < 0x20 || code === 0x7f) {
            return false;
        }
    }
    return true;
}

/** UpdateManifestParser.isSha256. */
export function isSha256(value) {
    return typeof value === 'string' && SHA256_HEX.test(value);
}

/** UpdateManifestParser.isSafeAssetName. */
export function isSafeAssetName(value) {
    return typeof value === 'string' && ASSET_NAME.test(value) && !value.includes('..');
}

/** UpdateManifestParser's abiName check for asset keys and the device ABI. */
export function isAbiName(value) {
    return typeof value === 'string' && ABI_NAME.test(value);
}

/** ApkVerifier.normalizeFingerprint, as 64 lowercase hex digits or null. */
export function normalizeFingerprint(value) {
    if (typeof value !== 'string' || (!SHA256_HEX.test(value) && !COLON_FINGERPRINT.test(value))) {
        return null;
    }
    return value.replaceAll(':', '').toLowerCase();
}

/** UpdateRepository.encodeReleaseTag succeeds (the stable channel builds its APK URL from the tag). */
export function isStableDownloadTag(tag) {
    if (typeof tag !== 'string' || tag.length < 1 || tag.length > 256) {
        return false;
    }
    if (tag.startsWith('.') || tag.endsWith('.') || tag.endsWith('.lock') || tag.includes('..') || tag.includes('@{')) {
        return false;
    }
    for (let index = 0; index < tag.length; index++) {
        const code = tag.charCodeAt(index);
        // Character.isISOControl covers U+0000-U+001F and U+007F-U+009F.
        if (isKotlinWhitespace(code) || code <= 0x1f || (code >= 0x7f && code <= 0x9f) || TAG_FORBIDDEN.includes(tag[index])) {
            return false;
        }
    }
    return isWellFormedUnicode(tag);
}

/**
 * UpdateManifestParser.parseManifest on a parsed document, plus optional consumer checks:
 * `abi` (the only ABI of the device), `sdk` (device SDK) and `stableChannel` (UpdateRepository.checkStable).
 * Returns the normalized manifest: versionCode is a BigInt; hashes are lowercase.
 */
export function validateManifestValue(root, { abi, sdk, stableChannel = false } = {}) {
    if (sdk !== undefined && !(Number.isSafeInteger(sdk) && sdk > 0)) {
        throw new UsageError('the device SDK must be a positive integer');
    }
    if (abi !== undefined && !isAbiName(abi)) {
        throw new UsageError(`the device ABI ${JSON.stringify(abi)} is not a valid ABI name`);
    }
    if (!(root instanceof Map)) {
        throw fieldError('document', 'must be a JSON object');
    }
    if (positiveLong(root.get('schema')) !== 1n) {
        throw fieldError('schema', 'must be the integer 1');
    }
    const versionCode = positiveLong(root.get('versionCode'));
    if (versionCode === null) {
        throw fieldError('versionCode', 'must be a positive integer literal that fits a 64-bit Long');
    }
    const versionName = root.get('versionName');
    if (!isManifestText(versionName, 128)) {
        throw fieldError('versionName', 'must be a non-blank string of at most 128 characters without control characters');
    }
    const prerelease = root.get('prerelease');
    if (typeof prerelease !== 'boolean') {
        throw fieldError('prerelease', 'must be a JSON boolean');
    }
    const releaseTag = root.get('releaseTag');
    if (!isManifestText(releaseTag, 256)) {
        throw fieldError('releaseTag', 'must be a non-blank string of at most 256 characters without control characters');
    }
    const defaultRef = root.get('defaultRef');
    if (defaultRef !== 'release' && defaultRef !== 'staging') {
        throw fieldError('defaultRef', 'must be "release" or "staging"');
    }
    const minSdk = positiveLong(root.get('minSdk'));
    if (minSdk === null || minSdk > INT_MAX) {
        throw fieldError('minSdk', 'must be a positive integer literal no larger than 2147483647');
    }
    if (sdk !== undefined && minSdk > BigInt(sdk)) {
        throw fieldError('minSdk', `${minSdk} is above the device SDK ${sdk}`);
    }
    const signingCertSha256 = root.get('signingCertSha256');
    const signingCert = normalizeFingerprint(signingCertSha256);
    if (signingCert === null) {
        throw fieldError('signingCertSha256', 'must be 64 hex digits or 32 colon-separated hex pairs');
    }
    const inputsHash = root.get('inputsHash');
    if (!isSha256(inputsHash)) {
        throw fieldError('inputsHash', 'must be 64 hex digits');
    }

    const assets = root.get('assets');
    if (!(assets instanceof Map) || assets.size === 0 || assets.size > 16) {
        throw fieldError('assets', 'must be an object with 1 to 16 entries');
    }
    const normalizedAssets = {};
    const names = new Set();
    for (const [key, entry] of assets) {
        if (!isAbiName(key)) {
            throw fieldError(`assets key ${JSON.stringify(key)}`, 'is not a valid ABI name');
        }
        if (!(entry instanceof Map)) {
            throw fieldError(`assets.${key}`, 'must be an object');
        }
        const name = entry.get('name');
        if (!isSafeAssetName(name)) {
            throw fieldError(`assets.${key}.name`, 'must be a safe .apk file name');
        }
        if (names.has(name)) {
            throw fieldError(`assets.${key}.name`, `repeats ${name}`);
        }
        names.add(name);
        const sha256 = entry.get('sha256');
        if (!isSha256(sha256)) {
            throw fieldError(`assets.${key}.sha256`, 'must be 64 hex digits');
        }
        const size = positiveLong(entry.get('size'));
        if (size === null || size > BigInt(MAX_APK_BYTES)) {
            throw fieldError(`assets.${key}.size`, `must be a positive integer literal no larger than ${MAX_APK_BYTES}`);
        }
        normalizedAssets[key] = { name, sha256: sha256.toLowerCase(), size: Number(size) };
    }

    const runtime = root.get('runtime');
    if (!(runtime instanceof Map)) {
        throw fieldError('runtime', 'must be an object');
    }
    for (const name of ['node', 'git', 'bash', 'npm']) {
        if (!isManifestText(runtime.get(name), 128)) {
            throw fieldError(`runtime.${name}`, 'must be a non-blank string of at most 128 characters without control characters');
        }
    }
    if (!runtime.has('bun')) {
        throw fieldError('runtime.bun', 'must be present (null when Bun is not bundled)');
    }
    const bun = runtime.get('bun');
    if (bun !== null && !isManifestText(bun, 128)) {
        throw fieldError('runtime.bun', 'must be null or a non-blank string of at most 128 characters');
    }

    if (abi !== undefined && !Object.hasOwn(normalizedAssets, abi)) {
        throw fieldError('assets', `has no entry for the device ABI ${abi}`);
    }
    if (stableChannel) {
        if (prerelease) {
            throw fieldError('prerelease', 'must be false for the stable channel (UpdateRepository.checkStable)');
        }
        if (!isStableDownloadTag(releaseTag)) {
            throw fieldError('releaseTag', `${JSON.stringify(releaseTag)} cannot form the stable download URL (UpdateRepository.encodeReleaseTag)`);
        }
    }

    return {
        schema: 1,
        versionCode,
        versionName,
        prerelease,
        releaseTag,
        defaultRef,
        minSdk: Number(minSdk),
        signingCertSha256,
        signingCert,
        inputsHash: inputsHash.toLowerCase(),
        assets: normalizedAssets,
        runtime: {
            node: runtime.get('node'),
            bun,
            git: runtime.get('git'),
            bash: runtime.get('bash'),
            npm: runtime.get('npm'),
        },
    };
}

/** parseUpdateJson + validateManifestValue: what UpdateManifestParser.parse accepts, given as text. */
export function validateManifestText(text, options = {}) {
    return validateManifestValue(parseUpdateJson(text), options);
}

/** decodeManifestBytes + validateManifestText: what the app accepts as a downloaded body. */
export function validateManifestBytes(bytes, options = {}) {
    return validateManifestText(decodeManifestBytes(bytes), options);
}
