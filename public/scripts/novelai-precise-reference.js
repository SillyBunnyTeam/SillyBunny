export const MAX_PRECISE_REFERENCE_BYTES = 25 * 1024 * 1024;
export const MAX_PRECISE_REFERENCES = 16;
export const PRECISE_REFERENCE_FILE_PREFIX = 'sb-nai-ref-';
export const PRECISE_REFERENCE_FILE_PATTERN = /^\/user\/files\/sb-nai-ref-[0-9a-f]{12,64}\.png$/;

const REFERENCE_TYPES = new Set(['character', 'style', 'character&style']);

export function supportsNovelAIPreciseReference(model) {
    return /^nai-diffusion-4-5-(?:full|curated)(?:-inpainting)?$/.test(model);
}

export function normalizeNovelAIPreciseReferencePath(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (!trimmed) return '';
    const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return PRECISE_REFERENCE_FILE_PATTERN.test(normalized) ? normalized : '';
}

export function getNovelAIPreciseReferenceByteSize(reference) {
    if (Number.isFinite(reference?.bytes) && reference.bytes > 0) return reference.bytes;
    if (typeof reference?.image === 'string' && reference.image.length) return Math.ceil(reference.image.length * 0.75);
    return 0;
}

export function arrayBufferToBase64(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (typeof btoa !== 'function') {
        return globalThis.Buffer.from(bytes).toString('base64');
    }
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

export function getNovelAIPreciseReferenceSize(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error('Reference image dimensions are invalid');
    }
    const ratio = width / height;
    const sizes = [[1024, 1536], [1536, 1024], [1472, 1472]];
    const [targetWidth, targetHeight] = sizes.reduce((best, size) => Math.abs(size[0] / size[1] - ratio) < Math.abs(best[0] / best[1] - ratio) ? size : best);
    return { width: targetWidth, height: targetHeight };
}

function validateMetadata(reference) {
    if (!REFERENCE_TYPES.has(reference?.type)) throw new Error('Choose Character, Style, or Character & Style for each reference');
    for (const field of ['strength', 'fidelity']) {
        if (!Number.isFinite(reference[field])) {
            throw new Error(`Reference ${field} must be a finite number`);
        }
    }
}

function validateRequestGuards(model, references, { anlasGuard = false } = {}) {
    if (!Array.isArray(references)) throw new Error('Precise Reference images must be an array');
    if (!references.length) return false;
    if (references.length > MAX_PRECISE_REFERENCES) throw new Error('Precise Reference supports up to 16 images');
    if (!supportsNovelAIPreciseReference(model)) {
        throw new Error('Precise Reference requires NovelAI V4.5. Choose a supported model or disable Precise Reference.');
    }
    if (anlasGuard) {
        throw new Error('Precise Reference costs additional Anlas. Disable Precise Reference or turn off "Avoid spending Anlas".');
    }
    return true;
}

function validateImage(image) {
    if (typeof image !== 'string' || image.length < 44 || image.length % 4 !== 0
        || image.length * 0.75 > MAX_PRECISE_REFERENCE_BYTES
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(image)) {
        throw new Error('Precise Reference requires a prepared PNG image smaller than 25 MiB');
    }
    const header = atob(image.slice(0, 44));
    if (!header.startsWith('\x89PNG\r\n\x1a\n') || header.slice(12, 16) !== 'IHDR') {
        throw new Error('Precise Reference requires PNG images. Remove and upload the reference again.');
    }
    const dimension = offset => ((header.charCodeAt(offset) * 0x1000000)
        + (header.charCodeAt(offset + 1) << 16) + (header.charCodeAt(offset + 2) << 8) + header.charCodeAt(offset + 3));
    const width = dimension(16);
    const height = dimension(20);
    if (!((width === 1024 && height === 1536) || (width === 1536 && height === 1024) || (width === 1472 && height === 1472))) {
        throw new Error('Precise Reference images must be padded to 1024×1536, 1536×1024, or 1472×1472. Remove and upload the reference again.');
    }
}

/** Builds aligned native NovelAI arrays; empty references leave ordinary generation unchanged. */
export function buildNovelAIPreciseReferenceParameters(model, references, { anlasGuard = false } = {}) {
    if (!validateRequestGuards(model, references, { anlasGuard })) return {};
    const parameters = {
        director_reference_images: [],
        director_reference_descriptions: [],
        director_reference_information_extracted: [],
        director_reference_strength_values: [],
        director_reference_secondary_strength_values: [],
    };
    let bytes = 0;
    for (const reference of references) {
        validateImage(reference?.image);
        bytes += reference.image.length * 0.75;
        if (bytes > MAX_PRECISE_REFERENCE_BYTES) throw new Error('Reference images are limited to 25 MiB total');
        validateMetadata(reference);
        parameters.director_reference_images.push(reference.image);
        parameters.director_reference_descriptions.push({ caption: { base_caption: reference.type, char_captions: [] }, legacy_uc: false });
        parameters.director_reference_information_extracted.push(1);
        parameters.director_reference_strength_values.push(reference.strength);
        // The first-party editor inverts Fidelity before passing it to the image API.
        parameters.director_reference_secondary_strength_values.push(1 - reference.fidelity);
    }
    return parameters;
}

/**
 * Resolves user-file reference entries into validated base64 payloads and NovelAI provider fields.
 * Legacy entries that already carry inline base64 `image` remain supported alongside stored `path` entries.
 */
export async function resolveNovelAIPreciseReferences(model, references, { anlasGuard = false, fetchFn = globalThis.fetch } = {}) {
    if (!validateRequestGuards(model, references, { anlasGuard })) {
        return { references: [], parameters: {} };
    }
    for (const reference of references) validateMetadata(reference);
    const resolved = [];
    let bytes = 0;
    for (const reference of references) {
        let image;
        if (typeof reference?.path === 'string' && reference.path.trim()) {
            const path = normalizeNovelAIPreciseReferencePath(reference.path);
            if (!path) {
                throw new Error('A saved reference image path is invalid. Remove and add it again.');
            }
            if (typeof fetchFn !== 'function') {
                throw new Error('A saved reference image could not be loaded. Remove and add it again.');
            }
            const response = await fetchFn(path, { credentials: 'same-origin' });
            if (!response?.ok) {
                throw new Error('A saved reference image could not be found. Remove and add it again.');
            }
            const buffer = await response.arrayBuffer();
            bytes += buffer.byteLength;
            if (bytes > MAX_PRECISE_REFERENCE_BYTES) throw new Error('Reference images are limited to 25 MiB total');
            image = arrayBufferToBase64(buffer);
        } else {
            validateImage(reference?.image);
            bytes += reference.image.length * 0.75;
            if (bytes > MAX_PRECISE_REFERENCE_BYTES) throw new Error('Reference images are limited to 25 MiB total');
            image = reference.image;
        }
        resolved.push({ image, type: reference.type, strength: reference.strength, fidelity: reference.fidelity });
    }
    const parameters = buildNovelAIPreciseReferenceParameters(model, resolved, { anlasGuard });
    return { references: resolved, parameters };
}
