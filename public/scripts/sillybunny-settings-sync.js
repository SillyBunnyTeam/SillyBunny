const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const textEncoder = new TextEncoder();
const hasEncodeInto = typeof textEncoder.encodeInto === 'function';
const SCRATCH_BUFFER_SIZE = 8192;

/**
 * @param {number} byteLength Length of the canonical JSON in UTF-8 bytes
 * @param {string} hexDigest SHA-256 digest of those bytes, in lowercase hex
 * @returns {string}
 */
function formatFingerprint(byteLength, hexDigest) {
    return `v1:${byteLength}:${hexDigest}`;
}

/**
 * Synchronous SHA-256 hasher for pages without `crypto.subtle`, which browsers hide on insecure origins such as a LAN address over plain HTTP.
 * Uses a single reusable UTF-8 scratch buffer and an inline ASCII fast-path to avoid per-call TextEncoder allocations.
 */
function createSha256Hasher() {
    let h0 = 0x6a09e667;
    let h1 = 0xbb67ae85;
    let h2 = 0x3c6ef372;
    let h3 = 0xa54ff53a;
    let h4 = 0x510e527f;
    let h5 = 0x9b05688c;
    let h6 = 0x1f83d9ab;
    let h7 = 0x5be0cd19;

    const block = new Uint8Array(64);
    const blockView = new DataView(block.buffer);
    const w = new Uint32Array(64);
    const scratch = new Uint8Array(SCRATCH_BUFFER_SIZE);
    let scratchLen = 0;
    let blockLen = 0;
    let totalBytes = 0;

    function compress() {
        for (let i = 0; i < 16; i++) {
            w[i] = blockView.getUint32(i * 4, false);
        }
        for (let i = 16; i < 64; i++) {
            const w15 = w[i - 15];
            const w2 = w[i - 2];
            const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
            const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }

        let a = h0;
        let b = h1;
        let c = h2;
        let d = h3;
        let e = h4;
        let f = h5;
        let g = h6;
        let h = h7;

        for (let i = 0; i < 64; i++) {
            const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const ch = (e & f) ^ (~e & g);
            const temp1 = (h + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
            const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (s0 + maj) >>> 0;

            h = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }

        h0 = (h0 + a) >>> 0;
        h1 = (h1 + b) >>> 0;
        h2 = (h2 + c) >>> 0;
        h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0;
        h5 = (h5 + f) >>> 0;
        h6 = (h6 + g) >>> 0;
        h7 = (h7 + h) >>> 0;
    }

    function updateBytes(bytes, length = bytes.length) {
        totalBytes += length;
        let offset = 0;
        if (blockLen > 0) {
            const take = Math.min(64 - blockLen, length);
            block.set(bytes.subarray(0, take), blockLen);
            blockLen += take;
            offset += take;
            if (blockLen === 64) {
                compress();
                blockLen = 0;
            }
        }
        while (offset + 64 <= length) {
            block.set(bytes.subarray(offset, offset + 64), 0);
            compress();
            offset += 64;
        }
        if (offset < length) {
            block.set(bytes.subarray(offset, length), 0);
            blockLen = length - offset;
        }
    }

    function flushScratch() {
        if (scratchLen > 0) {
            updateBytes(scratch, scratchLen);
            scratchLen = 0;
        }
    }

    function updateString(str) {
        if (!str) return;
        const len = str.length;
        let i = 0;
        while (i < len) {
            const code = str.charCodeAt(i);
            if (code < 0x80) {
                if (scratchLen === SCRATCH_BUFFER_SIZE) {
                    flushScratch();
                }
                scratch[scratchLen++] = code;
                i += 1;
                continue;
            }

            if (hasEncodeInto) {
                if (scratchLen > SCRATCH_BUFFER_SIZE - 4) {
                    flushScratch();
                }
                const remaining = i === 0 ? str : str.slice(i);
                const result = textEncoder.encodeInto(remaining, scratch.subarray(scratchLen));
                scratchLen += result.written;
                if (result.read > 0) {
                    i += result.read;
                    continue;
                }
            }

            flushScratch();
            const encoded = textEncoder.encode(i === 0 ? str : str.slice(i));
            updateBytes(encoded, encoded.length);
            return;
        }
    }

    function digestHex() {
        flushScratch();
        const bitLength = totalBytes * 8;
        block[blockLen++] = 0x80;
        if (blockLen > 56) {
            block.fill(0, blockLen, 64);
            compress();
            blockLen = 0;
        }
        block.fill(0, blockLen, 56);
        blockView.setUint32(56, Math.floor(bitLength / 0x100000000), false);
        blockView.setUint32(60, bitLength >>> 0, false);
        compress();

        const words = [h0, h1, h2, h3, h4, h5, h6, h7];
        return formatFingerprint(totalBytes, words.map(word => word.toString(16).padStart(8, '0')).join(''));
    }

    return { updateString, digestHex };
}

/**
 * Sorts object keys at every level, so that equal settings give equal JSON whatever their key order.
 * @param {unknown} value JSON data
 * @returns {unknown}
 */
function sortKeys(value) {
    if (Array.isArray(value)) {
        return value.map(sortKeys);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
    }
    return value;
}

/**
 * @param {string | Record<string, unknown>} input Settings as JSON text, or as an object that JSON.stringify can serialize
 * @returns {string} The settings without the root `_version`, with sorted keys, as JSON text
 */
function getCanonicalJson(input) {
    const settings = JSON.parse(typeof input === 'string' ? input : JSON.stringify(input));
    delete settings._version;
    return JSON.stringify(sortKeys(settings));
}

function digestCanonicalJsonInJs(canonicalJson) {
    const hasher = createSha256Hasher();
    hasher.updateString(canonicalJson);
    return hasher.digestHex();
}

async function digestCanonicalJson(canonicalJson) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
        return digestCanonicalJsonInJs(canonicalJson);
    }
    try {
        const bytes = textEncoder.encode(canonicalJson);
        const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
        return formatFingerprint(bytes.length, Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join(''));
    } catch {
        return digestCanonicalJsonInJs(canonicalJson);
    }
}

/**
 * Remembers a compact fingerprint of the settings that the page last loaded from the server or saved to it.
 *
 * The page builds every save from objects that it keeps changing, so it remembers a SHA-256 digest of the settings'
 * canonical JSON, not those objects and not the JSON itself, which can be many megabytes with a large preset.
 * A save with the remembered settings would change nothing on the server, and a page whose settings are stale would only
 * get the settings conflict prompt for it.
 * @returns {{ getFingerprint: (input: string | Record<string, unknown>) => Promise<string>, remember: (fingerprint: string) => void, isSynced: (fingerprint: string) => boolean }}
 */
export function createSettingsSync() {
    let syncedFingerprint = null;
    return {
        /**
         * Hashes with the browser's SHA-256 where `crypto.subtle` exists. Browsers hide it on insecure origins, such as a
         * LAN address over plain HTTP, and the digest is then computed in JavaScript, which blocks the page while it runs.
         */
        async getFingerprint(input) {
            return digestCanonicalJson(getCanonicalJson(input));
        },
        remember(fingerprint) {
            syncedFingerprint = fingerprint;
        },
        isSynced(fingerprint) {
            return syncedFingerprint !== null && fingerprint === syncedFingerprint;
        },
    };
}
