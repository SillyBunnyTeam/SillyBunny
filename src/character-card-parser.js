import fs from 'node:fs';
import { Buffer } from 'node:buffer';

import encode from './png/encode.js';
// SillyBunny: this extract rejects a chunk that runs past the end of the file before png-chunks-extract reads the chunks.
import extract from './png/extract.js';
import PNGtext from 'png-chunk-text';

const MIRRORED_FIELD_MAPPINGS = {
    name: 'name',
    description: 'description',
    personality: 'personality',
    scenario: 'scenario',
    first_mes: 'first_mes',
    mes_example: 'mes_example',
    tags: 'tags',
    talkativeness: 'extensions.talkativeness',
    fav: 'extensions.fav',
};

/**
 * @param {object} obj
 * @param {string} path
 * @returns {any}
 */
function getPath(obj, path) {
    return path.split('.').reduce((value, key) => value?.[key], obj);
}

/**
 * @param {object} obj
 * @param {string} path
 * @param {any} value
 */
function setPath(obj, path, value) {
    const keys = path.split('.');
    const lastKey = keys.pop();
    let current = obj;

    for (const key of keys) {
        current[key] = current[key] ?? {};
        current = current[key];
    }

    current[lastKey] = value;
}

/**
 * Keeps root-level legacy fields synchronized with the V2/V3 data block.
 * @param {object} card
 * @returns {object}
 */
function normalizeCard(card) {
    const normalized = JSON.parse(JSON.stringify(card));
    normalized.data = normalized.data ?? {};
    normalized.data.extensions = normalized.data.extensions ?? {};

    for (const [legacyField, dataPath] of Object.entries(MIRRORED_FIELD_MAPPINGS)) {
        const rootValue = normalized[legacyField];
        const dataValue = getPath(normalized.data, dataPath);

        if (typeof dataValue !== 'undefined') {
            normalized[legacyField] = dataValue;
            continue;
        }

        if (typeof rootValue !== 'undefined') {
            setPath(normalized.data, dataPath, rootValue);
        }
    }

    if (typeof normalized.data.creator_notes !== 'undefined') {
        normalized.creatorcomment = normalized.data.creator_notes;
    } else if (typeof normalized.creatorcomment !== 'undefined') {
        normalized.data.creator_notes = normalized.creatorcomment;
    }

    return normalized;
}

/**
 * Writes Character metadata to a PNG image buffer.
 * Keeps the legacy root fields mirrored with the V2/V3 data block to avoid spec mismatches.
 * @param {Buffer} image PNG image buffer
 * @param {string} data Character data to write
 * @returns {Buffer} PNG image buffer with metadata
 */
export const write = (image, data) => {
    const chunks = extract(new Uint8Array(image));
    const tEXtChunks = chunks.filter(chunk => chunk.name === 'tEXt');

    // Remove existing tEXt chunks
    for (const tEXtChunk of tEXtChunks) {
        const data = PNGtext.decode(tEXtChunk.data);
        if (data.keyword.toLowerCase() === 'chara' || data.keyword.toLowerCase() === 'ccv3') {
            chunks.splice(chunks.indexOf(tEXtChunk), 1);
        }
    }

    let v2Json = data;
    let v3Json = null;

    try {
        const normalizedCard = normalizeCard(JSON.parse(data));

        const v2Data = JSON.parse(JSON.stringify(normalizedCard));
        v2Data.spec = 'chara_card_v2';
        v2Data.spec_version = '2.0';
        v2Json = JSON.stringify(v2Data);

        const v3Data = JSON.parse(JSON.stringify(normalizedCard));
        v3Data.spec = 'chara_card_v3';
        v3Data.spec_version = '3.0';
        v3Json = JSON.stringify(v3Data);
    } catch (error) {
        // Ignore JSON errors and fall back to writing the raw metadata as-is.
    }

    // Add new v2 chunk before the IEND chunk
    const base64EncodedV2Data = Buffer.from(v2Json, 'utf8').toString('base64');
    chunks.splice(-1, 0, PNGtext.encode('chara', base64EncodedV2Data));

    // Try adding v3 chunk before the IEND chunk
    if (v3Json) {
        const base64EncodedV3Data = Buffer.from(v3Json, 'utf8').toString('base64');
        chunks.splice(-1, 0, PNGtext.encode('ccv3', base64EncodedV3Data));
    }

    const newBuffer = Buffer.from(encode(chunks));
    return newBuffer;
};

/**
 * Reads Character metadata from a PNG image buffer.
 * Supports both V2 (chara) and V3 (ccv3). V3 (ccv3) takes precedence.
 * @param {Buffer} image PNG image buffer
 * @returns {string} Character data
 */
export const read = (image) => {
    const chunks = extract(new Uint8Array(image));

    const textChunks = chunks.filter((chunk) => chunk.name === 'tEXt').map((chunk) => PNGtext.decode(chunk.data));

    if (textChunks.length === 0) {
        console.error('PNG metadata does not contain any text chunks.');
        throw new Error('No PNG metadata.');
    }

    const ccv3Index = textChunks.findIndex((chunk) => chunk.keyword.toLowerCase() === 'ccv3');

    if (ccv3Index > -1) {
        return Buffer.from(textChunks[ccv3Index].text, 'base64').toString('utf8');
    }

    const charaIndex = textChunks.findIndex((chunk) => chunk.keyword.toLowerCase() === 'chara');

    if (charaIndex > -1) {
        return Buffer.from(textChunks[charaIndex].text, 'base64').toString('utf8');
    }

    console.error('PNG metadata does not contain any character data.');
    throw new Error('No PNG metadata.');
};

/**
 * Parses a card image and returns the character metadata.
 * @param {string} cardUrl Path to the card image
 * @param {string} format File format
 * @returns {Promise<string>} Character data
 */
export const parse = async (cardUrl, format) => {
    let fileFormat = format === undefined ? 'png' : format;

    switch (fileFormat) {
        case 'png': {
            const buffer = fs.readFileSync(cardUrl);
            return read(buffer);
        }
    }

    throw new Error('Unsupported format');
};
