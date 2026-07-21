import { MAX_IMAGE_BYTES } from './security.js';

export const MAX_PNG_FILE_BYTES = MAX_IMAGE_BYTES;
export const MAX_PNG_METADATA_BYTES = 512 * 1024;

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const textDecoder = new TextDecoder();
const latin1Decoder = new TextDecoder('latin1');
const textEncoder = new TextEncoder();

function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError('Expected image bytes');
}

function hasPrefix(bytes, prefix) {
    return prefix.every((value, index) => bytes[index] === value);
}

export function detectImageFormat(value) {
    const bytes = asBytes(value);
    if (bytes.length >= 20 && hasPrefix(bytes, PNG_SIGNATURE)) {
        try {
            readChunks(bytes);
            return { ext: 'png', mime: 'image/png', isPng: true };
        } catch {
            return null;
        }
    }
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
        return { ext: 'jpg', mime: 'image/jpeg', isPng: false };
    }
    if (bytes.length >= 14 && /^GIF8[79]a$/.test(String.fromCharCode(...bytes.subarray(0, 6))) && bytes.at(-1) === 0x3b) {
        return { ext: 'gif', mime: 'image/gif', isPng: false };
    }
    if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') {
        const declaredLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8;
        if (declaredLength === bytes.length) return { ext: 'webp', mime: 'image/webp', isPng: false };
    }
    if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const declaredLength = view.getUint32(2, true);
        const pixelOffset = view.getUint32(10, true);
        if (declaredLength <= bytes.length && pixelOffset >= 14 && pixelOffset <= bytes.length) {
            return { ext: 'bmp', mime: 'image/bmp', isPng: false };
        }
    }
    if (bytes.length >= 8 && ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0) || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 0x2a))) {
        const littleEndian = bytes[0] === 0x49;
        const ifdOffset = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, littleEndian);
        if (ifdOffset >= 8 && ifdOffset + 2 <= bytes.length) return { ext: 'tiff', mime: 'image/tiff', isPng: false };
    }
    if (bytes.length >= 16 && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp') {
        const boxLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
        const brands = String.fromCharCode(...bytes.subarray(8, Math.min(bytes.length, 40)));
        if (boxLength >= 16 && boxLength <= bytes.length && (brands.includes('avif') || brands.includes('avis'))) {
            return { ext: 'avif', mime: 'image/avif', isPng: false };
        }
    }
    return null;
}

function readChunks(value) {
    const bytes = asBytes(value);
    if (bytes.byteLength > MAX_PNG_FILE_BYTES) throw new Error('PNG exceeds the 25 MB limit');
    if (bytes.length < PNG_SIGNATURE.length || !hasPrefix(bytes, PNG_SIGNATURE)) throw new Error('Invalid PNG signature');

    const chunks = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = PNG_SIGNATURE.length;
    let sawIend = false;
    while (offset < bytes.length) {
        if (offset + 12 > bytes.length) throw new Error('Truncated PNG chunk');
        const length = view.getUint32(offset);
        const end = offset + 12 + length;
        if (end > bytes.length) throw new Error('Invalid PNG chunk length');
        const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        if (!/^[A-Za-z]{4}$/.test(type)) throw new Error('Invalid PNG chunk type');
        chunks.push({ type, data: bytes.subarray(offset + 8, offset + 8 + length), raw: bytes.subarray(offset, end) });
        offset = end;
        if (type === 'IEND') {
            sawIend = true;
            if (length !== 0 || offset !== bytes.length) throw new Error('Invalid PNG ending');
            break;
        }
    }
    if (!sawIend) throw new Error('PNG is missing IEND');
    return chunks;
}

function crc32(data) {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function createChunk(type, data) {
    const typeBytes = textEncoder.encode(type);
    const chunk = new Uint8Array(data.length + 12);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    chunk.set(typeBytes, 4);
    chunk.set(data, 8);
    const crcInput = new Uint8Array(typeBytes.length + data.length);
    crcInput.set(typeBytes);
    crcInput.set(data, typeBytes.length);
    view.setUint32(data.length + 8, crc32(crcInput));
    return chunk;
}

function parameterKeywordEnd(data) {
    const end = data.indexOf(0);
    if (end < 0 || end > 79) return -1;
    return latin1Decoder.decode(data.subarray(0, end)) === 'parameters' ? end : -1;
}

function isParametersChunk(chunk) {
    return (chunk.type === 'tEXt' || chunk.type === 'zTXt' || chunk.type === 'iTXt') && parameterKeywordEnd(chunk.data) >= 0;
}

export function embedPngMetadata(value, text) {
    const chunks = readChunks(value);
    const textBytes = textEncoder.encode(String(text ?? ''));

    const keyword = textEncoder.encode('parameters');
    const data = new Uint8Array(keyword.length + 5 + textBytes.length);
    if (data.byteLength > MAX_PNG_METADATA_BYTES) throw new Error('PNG metadata exceeds the 512 KB limit');
    data.set(keyword);
    let cursor = keyword.length;
    data[cursor++] = 0; // keyword terminator
    data[cursor++] = 0; // uncompressed
    data[cursor++] = 0; // compression method
    data[cursor++] = 0; // language tag
    data[cursor++] = 0; // translated keyword
    data.set(textBytes, cursor);
    const metadataChunk = createChunk('iTXt', data);

    const outputParts = [PNG_SIGNATURE];
    for (const chunk of chunks) {
        if (isParametersChunk(chunk)) continue;
        if (chunk.type === 'IEND') outputParts.push(metadataChunk);
        outputParts.push(chunk.raw);
    }
    const total = outputParts.reduce((sum, part) => sum + part.length, 0);
    if (total > MAX_PNG_FILE_BYTES) throw new Error('PNG with metadata exceeds the 25 MB limit');
    const output = new Uint8Array(total);
    let offset = 0;
    for (const part of outputParts) {
        output.set(part, offset);
        offset += part.length;
    }
    return output.buffer;
}

async function decompressBounded(data, maxBytes) {
    if (typeof DecompressionStream !== 'function') return null;
    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel('PNG metadata is too large');
                throw new Error('Decompressed PNG metadata exceeds the 512 KB limit');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

async function decodeParametersChunk(chunk) {
    if (chunk.data.byteLength > MAX_PNG_METADATA_BYTES) throw new Error('PNG metadata chunk exceeds the 512 KB limit');
    const keywordEnd = parameterKeywordEnd(chunk.data);
    if (keywordEnd < 0) return null;
    if (chunk.type === 'tEXt') return latin1Decoder.decode(chunk.data.subarray(keywordEnd + 1));
    if (chunk.type === 'zTXt') {
        if (chunk.data[keywordEnd + 1] !== 0) return null;
        const decompressed = await decompressBounded(chunk.data.subarray(keywordEnd + 2), MAX_PNG_METADATA_BYTES);
        return decompressed ? textDecoder.decode(decompressed) : null;
    }

    let cursor = keywordEnd + 1;
    if (cursor + 2 > chunk.data.length) return null;
    const compressed = chunk.data[cursor++];
    const method = chunk.data[cursor++];
    for (let field = 0; field < 2; field++) {
        while (cursor < chunk.data.length && chunk.data[cursor] !== 0) cursor++;
        if (cursor >= chunk.data.length) return null;
        cursor++;
    }
    let textBytes = chunk.data.subarray(cursor);
    if (compressed === 1) {
        if (method !== 0) return null;
        textBytes = await decompressBounded(textBytes, MAX_PNG_METADATA_BYTES);
        if (!textBytes) return null;
    } else if (compressed !== 0) {
        return null;
    }
    return textDecoder.decode(textBytes);
}

export async function readPngMetadata(value) {
    const chunks = readChunks(value);
    let result = null;
    for (const chunk of chunks) {
        if (!isParametersChunk(chunk)) continue;
        const decoded = await decodeParametersChunk(chunk);
        if (decoded !== null) result = decoded;
    }
    return result;
}

export function parseGenerationParameters(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    const bounded = text.slice(0, MAX_PNG_METADATA_BYTES);
    const lines = bounded.split('\n');
    const parameterLinePattern = /(?:^|,\s*)(?:Steps|Sampler|Scheduler|CFG scale|Seed|Size|Provider|Model|Backend):\s*[^,\n]+/;
    let params = parameterLinePattern.test(lines.at(-1) || '') ? lines.pop().trim() : '';
    const body = lines.join('\n');
    const negativeMarker = '\nNegative prompt: ';
    const negativeIndex = body.lastIndexOf(negativeMarker);
    let prompt = (negativeIndex >= 0 ? body.slice(0, negativeIndex) : body).trim();
    let negativePrompt = '';
    if (negativeIndex >= 0) negativePrompt = body.slice(negativeIndex + negativeMarker.length).trim();

    const getParam = (key) => params.match(new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: ([^,\n]+)`))?.[1]?.trim() || null;
    const result = { prompt: prompt.slice(0, 16 * 1024), negativePrompt: negativePrompt.slice(0, 16 * 1024) };
    const clampNumber = (value, min, max, integer = false) => {
        if (value == null || value === '') return undefined;
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return undefined;
        const clamped = Math.min(max, Math.max(min, parsed));
        return integer ? Math.trunc(clamped) : clamped;
    };
    const steps = clampNumber(getParam('Steps'), 1, 150, true);
    const cfgScale = clampNumber(getParam('CFG scale'), 1, 30);
    const seed = clampNumber(getParam('Seed'), 0, 0xffffffff, true);
    const size = getParam('Size')?.match(/^(\d+)x(\d+)$/i);
    if (steps !== undefined) result.steps = steps;
    if (cfgScale !== undefined) result.cfgScale = cfgScale;
    if (seed !== undefined) result.seed = seed;
    if (size) {
        result.width = clampNumber(size[1], 256, 2048, true);
        result.height = clampNumber(size[2], 256, 2048, true);
    }
    for (const [key, outputKey] of [['Sampler', 'sampler'], ['Scheduler', 'scheduler'], ['Provider', 'provider'], ['Model', 'model'], ['Backend', 'backend']]) {
        const value = getParam(key);
        if (value) result[outputKey] = value.slice(0, 200);
    }
    return result;
}

export function sanitizeServerSubfolder(value, fallback = 'QuickImageGen') {
    const sanitized = String(value ?? '')
        .normalize('NFKC')
        .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_')
        .replace(/\.{2,}/g, '_')
        .replace(/_+/g, '_')
        .replace(/^\.+|\.+$/g, '')
        .trim()
        .slice(0, 80);
    return sanitized && sanitized !== '.' && sanitized !== '..' ? sanitized : fallback;
}
