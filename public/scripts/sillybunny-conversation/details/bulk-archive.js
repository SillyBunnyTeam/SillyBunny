/**
 * The archive that Export (Chats) and Download (Media and Files) make: the names of its files, which addresses may be
 * fetched into it, how the files are fetched, and the ZIP itself. The ZIP library is not imported here: the caller hands
 * it in, so that this module costs nothing at startup and the unit tests can pass the library as it is.
 */

import { toSafeAttachmentUrl } from '../safe-url.js';

/** Windows and most file managers refuse a longer name; the count is of UTF-8 bytes, which is what the archive stores. */
const MAX_NAME_BYTES = 120;
const FORBIDDEN_CHARACTERS = /[/\\:*?"<>|]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const DEFAULT_CONCURRENCY = 4;
const FAILED_FILES_SHOWN = 3;

const encoder = new TextEncoder();

function cutToBytes(text, limit) {
    let cut = '';
    let bytes = 0;
    for (const character of text) {
        bytes += encoder.encode(character).length;
        if (bytes > limit) {
            break;
        }
        cut += character;
    }
    return cut;
}

/**
 * A name that is one file in an archive on every system: no path, no character that a file name cannot hold, no leading
 * or trailing dot or space, and not a name that Windows reserves.
 * @param {unknown} name
 * @param {string} fallback Used when nothing is left of the name.
 */
export function sanitiseFileName(name, fallback) {
    const cleaned = String(name ?? '')
        .replace(CONTROL_CHARACTERS, ' ')
        .replace(FORBIDDEN_CHARACTERS, '_')
        .replace(/\s+/g, ' ')
        .replace(/^[.\s]+|[.\s]+$/g, '');
    if (!cleaned) {
        return fallback;
    }
    const firstDot = cleaned.indexOf('.');
    const stem = firstDot < 0 ? cleaned : cleaned.slice(0, firstDot);
    const safe = RESERVED_NAME.test(stem) ? `${stem}_${cleaned.slice(stem.length)}` : cleaned;
    return cutToBytes(safe, MAX_NAME_BYTES).replace(/[.\s]+$/, '') || fallback;
}

function splitExtension(name) {
    const dot = name.lastIndexOf('.');
    return dot > 0 && name.length - dot <= 10 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
}

/**
 * Gives each entry of an archive a name of its own. A name that is taken gets " (2)", " (3)" and so on before its
 * extension, and names are compared without regard to case because archives are unpacked on systems that do.
 * @param {{ name?: string, fallback: string }[]} candidates
 * @param {string} [extension] Added to every name, as `.jsonl` is to a chat name.
 * @returns {string[]} One name for each candidate, in the same order.
 */
export function planArchiveNames(candidates, extension = '') {
    const taken = new Set();
    return candidates.map(({ name, fallback }) => {
        const [stem, own] = splitExtension(`${sanitiseFileName(name, fallback)}${extension}`);
        let attempt = `${stem}${own}`;
        for (let number = 2; taken.has(attempt.toLowerCase()); number++) {
            attempt = `${stem} (${number})${own}`;
        }
        taken.add(attempt.toLowerCase());
        return attempt;
    });
}

/** The file name at the end of an address, decoded; empty when the address has none, as a data address has not. */
export function fileNameFromUrl(url) {
    const text = String(url ?? '');
    if (/^data:/i.test(text)) {
        return '';
    }
    const segment = text.split(/[?#]/)[0].split('/').pop() ?? '';
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

/**
 * Whether the archive may fetch an address: one of the page's own origin (its own picture, its own file) or a picture
 * that carries its data. An address of another site is never fetched, so that the page does not send a request on
 * behalf of a message to a place the user never chose.
 * @param {unknown} url
 * @param {string} base The address of the page.
 */
export function isFetchableAttachmentUrl(url, base) {
    const safe = toSafeAttachmentUrl(url, { allowDataImage: true });
    if (!safe) {
        return false;
    }
    if (/^data:/i.test(safe)) {
        return true;
    }
    try {
        return new URL(safe, base).origin === new URL(base).origin;
    } catch {
        return false;
    }
}

/**
 * Fetches the files of an archive a few at a time. A file that fails does not stop the others; it is reported by name.
 * @param {{ name: string, url: string }[]} candidates Names are final: see {@link planArchiveNames}.
 * @param {(url: string) => Promise<Uint8Array|ArrayBuffer|null>} fetchBytes
 * @returns {Promise<{ entries: { name: string, data: Uint8Array|ArrayBuffer }[], failed: { name: string, error: unknown }[] }>}
 * Entries keep the order of the candidates.
 */
export async function fetchArchiveEntries(candidates, fetchBytes, { concurrency = DEFAULT_CONCURRENCY } = {}) {
    const results = new Array(candidates.length);
    let next = 0;
    async function worker() {
        while (next < candidates.length) {
            const index = next++;
            const { name, url } = candidates[index];
            try {
                const data = await fetchBytes(url);
                results[index] = data ? { name, data } : { name, error: new Error('The file gave no data.') };
            } catch (error) {
                results[index] = { name, error };
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
    return {
        entries: results.filter(result => result && !('error' in result)),
        failed: results.filter(result => result && 'error' in result),
    };
}

/** The names of the files that failed, as one line for a toast: the first few, then how many more. */
export function formatFailedFiles(names) {
    if (names.length <= FAILED_FILES_SHOWN) {
        return names.join(', ');
    }
    return `${names.slice(0, FAILED_FILES_SHOWN).join(', ')} and ${names.length - FAILED_FILES_SHOWN} more`;
}

/**
 * Writes the entries into one ZIP.
 * @param {new () => { file: (name: string, data: any) => any, generateAsync: (options: object) => Promise<Uint8Array> }} JSZip
 * The library; it is imported by the caller when a download starts.
 * @param {{ name: string, data: string|Uint8Array|ArrayBuffer }[]} entries
 * @returns {Promise<Blob>}
 */
export async function createArchive(JSZip, entries) {
    const zip = new JSZip();
    for (const { name, data } of entries) {
        zip.file(name, data);
    }
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    return new Blob([bytes], { type: 'application/zip' });
}
