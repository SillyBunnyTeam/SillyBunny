export const MAX_PRECISE_REFERENCE_BYTES = 25 * 1024 * 1024;
export const MAX_PRECISE_REFERENCES = 16;

const REFERENCE_TYPES = new Set(['character', 'style', 'character&style']);

export function supportsNovelAIPreciseReference(model) {
    return /^nai-diffusion-4-5-(?:full|curated)(?:-inpainting)?$/.test(model);
}

export function getNovelAIPreciseReferenceSize(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error('Reference image dimensions are invalid.');
    }
    const ratio = width / height;
    const sizes = [[1024, 1536], [1536, 1024], [1472, 1472]];
    const [targetWidth, targetHeight] = sizes.reduce((best, size) => Math.abs(size[0] / size[1] - ratio) < Math.abs(best[0] / best[1] - ratio) ? size : best);
    return { width: targetWidth, height: targetHeight };
}

function validateImage(image) {
    if (typeof image !== 'string' || image.length < 44 || image.length % 4 !== 0
        || image.length * 0.75 > MAX_PRECISE_REFERENCE_BYTES
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(image)) {
        throw new Error('Precise Reference requires a prepared PNG image smaller than 25 MiB.');
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
    if (!Array.isArray(references)) throw new Error('Precise Reference images must be an array.');
    if (!references.length) return {};
    if (references.length > MAX_PRECISE_REFERENCES) throw new Error('Precise Reference supports up to 16 images.');
    if (!supportsNovelAIPreciseReference(model)) {
        throw new Error('Precise Reference requires NovelAI V4.5. Choose a supported model or disable Precise Reference.');
    }
    if (anlasGuard) {
        throw new Error('Precise Reference costs additional Anlas. Disable Precise Reference or turn off "Avoid spending Anlas".');
    }
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
        if (bytes > MAX_PRECISE_REFERENCE_BYTES) throw new Error('Reference images are limited to 25 MiB total.');
        if (!REFERENCE_TYPES.has(reference.type)) throw new Error('Choose Character, Style, or Character & Style for each reference.');
        for (const field of ['strength', 'fidelity']) {
            if (!Number.isFinite(reference[field])) {
                throw new Error(`Reference ${field} must be a finite number.`);
            }
        }
        parameters.director_reference_images.push(reference.image);
        parameters.director_reference_descriptions.push({ caption: { base_caption: reference.type, char_captions: [] }, legacy_uc: false });
        parameters.director_reference_information_extracted.push(1);
        parameters.director_reference_strength_values.push(reference.strength);
        // The first-party editor inverts Fidelity before passing it to the image API.
        parameters.director_reference_secondary_strength_values.push(1 - reference.fidelity);
    }
    return parameters;
}
