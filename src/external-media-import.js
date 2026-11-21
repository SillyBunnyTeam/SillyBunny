import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

import ipRegex from 'ip-regex';
import fetch from 'node-fetch';
import sanitize from 'sanitize-filename';

import { getLocalExternalMediaUrl, recordExternalMediaOrigins } from './external-media-manifest.js';
import { getImageExtension, isImageFile } from './image-file-type.js';
import { getUntrustedRequestAgent } from './private-request-filter.js';
import { NO_HARD_LINK_CODES } from './sillybunny-publish-file.js';
import { ensureDirectory, getConfigValue } from './util.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.apng', '.jpg', '.jpeg', '.jfif', '.gif', '.webp', '.avif', '.bmp']);
const MAX_EXTERNAL_MEDIA_BYTES = 25 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const MAX_URLS_PER_IMPORT = 100;
const MAX_CONCURRENT_DOWNLOADS = 4;
const MAX_TOTAL_BYTES_PER_IMPORT = 200 * 1024 * 1024;
const MAX_TOTAL_TIME_PER_IMPORT_MS = 120_000;
const MAX_STEM_LENGTH = 24;
const STORED_HASH_LENGTH = 16;
const USER_AGENT = 'SillyTavern';

// The scan runs on the server's only thread for every text field of an imported file. Each open-ended class also
// excludes the character that starts the next candidate (`[`, `<`, `(`), so a match that fails stops there and the
// scan time stays linear in the text length. Without that, a field of repeated `![`, `<img ` or `url(` takes
// quadratic time.
const MARKDOWN_IMAGE_REGEX = /!\[[^[\]]*\]\(\s*(?:<([^<>\r\n]+)>|([^\s()"']+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/dg;
const HTML_MEDIA_TAG_REGEX = /<(?:img|source|video|audio|image|embed|object)\b[^<>]*>/dgi;
const HTML_MEDIA_ATTR_REGEX = /\b(?:src|poster|data|xlink:href|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/dgi;
const HTML_SRCSET_ATTR_REGEX = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/dgi;
const SRCSET_CANDIDATE_REGEX = /([^\s,]+)(?:\s+[^,]*)?(?:,|$)/dg;
const CSS_URL_REGEX = /\burl\(\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^()\s"']+))\s*\)/dgi;
// A scheme is case-insensitive, and every pattern below is too, so the quick test that skips a text without a URL must be.
const MAY_HOLD_URL_REGEX = /https?:/i;
const BARE_HTTP_URL_REGEX = /https?:\/\/[^\s"'<>)\]]+/dgi;

/**
 * Quotes text from an imported file or a remote host for the console.
 * JSON escapes the C0 controls. DEL, the C1 controls and the direction marks are escaped here, because a terminal can
 * act on a C1 control and a direction mark reorders the line.
 * @param {unknown} value Text to log
 * @returns {string} JSON string literal
 */
function quoteForLog(value) {
    return JSON.stringify(String(value)).replace(/[\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
        char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function decodeURIComponentSafe(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/**
 * Checks whether an HTTP(S) URL is safe to request as external media.
 * Rejects non-HTTP(S) protocols, credentials, custom ports, localhost, and IP literals.
 * @param {string} urlString Candidate URL
 * @returns {boolean} True when the URL is valid and targets a public hostname on the default port
 */
export function isValidExternalMediaUrl(urlString) {
    if (typeof urlString !== 'string' || !urlString || urlString.includes('{{') || urlString.includes('}}')) {
        return false;
    }

    try {
        const urlObj = new URL(urlString);
        if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
            return false;
        }
        if (urlObj.port !== '' || urlObj.username !== '' || urlObj.password !== '') {
            return false;
        }

        const hostname = urlObj.hostname.toLowerCase().replace(/\.+$/, '');
        if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
            return false;
        }

        const bareHostname = hostname.replace(/^\[|\]$/g, '');
        if (ipRegex.v4({ exact: true }).test(bareHostname) || ipRegex.v6({ exact: true }).test(bareHostname)) {
            return false;
        }

        return true;
    } catch {
        return false;
    }
}

/**
 * Checks whether a request field is a true form. Anything that is not `true` or `1`, in any case and with spaces
 * around it, is not.
 * @param {unknown} value Field value from the request
 * @returns {boolean} True for a true form
 */
function isTrueForm(value) {
    if (typeof value === 'boolean') {
        return value;
    }
    return typeof value === 'string' && ['true', '1'].includes(value.trim().toLowerCase());
}

/**
 * Resolves whether external media should be downloaded on import for the current request.
 * Only the request field that the browser sends turns the download on, so a saved setting or another API client
 * cannot do it on its own. The server config can forbid it for every user.
 * @param {import('express').Request} request Express request
 * @returns {boolean} Whether external media localization is enabled
 */
export function shouldImportExternalMedia(request) {
    if (!isTrueForm(request?.body?.import_external_media)) {
        return false;
    }
    if (!getConfigValue('allowExternalMediaImport', true, 'boolean')) {
        console.info('The server config forbids downloading external media on import, so the URLs stay remote');
        return false;
    }
    return true;
}

/**
 * Resolves a safe subfolder name inside directories.userImages.
 * @param {string} name Preferred folder name (card or world name)
 * @param {string} fallbackName Fallback file name
 * @param {import('./users.js').UserDirectoryList} directories User directories
 * @returns {string|null} Validated child folder name, or null if unsafe
 */
export function getExternalMediaFolder(name, fallbackName, directories) {
    if (typeof directories?.userImages !== 'string' || !directories.userImages) {
        return null;
    }

    const folder = (typeof name === 'string' ? sanitize(name) : '')
        || (typeof fallbackName === 'string' ? sanitize(fallbackName) : '')
        || (typeof fallbackName === 'string' ? fallbackName : '');
    if (!folder) {
        return null;
    }
    // The static route decodes the path once more than the router did, so it cannot serve a folder whose name has a percent sign.
    if (folder.includes('%')) {
        return null;
    }

    const isChildFolder = directory => typeof directory === 'string'
        && Boolean(directory)
        && path.dirname(path.resolve(directory, folder)) === path.resolve(directory);

    if (!isChildFolder(directories.userImages)) {
        return null;
    }
    if (typeof directories.characters === 'string' && directories.characters && !isChildFolder(directories.characters)) {
        return null;
    }

    return folder;
}

/**
 * Checks whether a range overlaps one of the spans of a list that is sorted by start and has no overlaps.
 * @param {{start: number, end: number}[]} sortedSpans Spans in text order
 * @param {number} start Range start
 * @param {number} end Range end, exclusive
 * @returns {boolean} True when a span overlaps the range
 */
function overlapsSortedSpans(sortedSpans, start, end) {
    let low = 0;
    let high = sortedSpans.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (sortedSpans[middle].end <= start) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low < sortedSpans.length && sortedSpans[low].start < end;
}

/**
 * Merges two span lists that are each sorted by start and do not overlap each other.
 * @template {{start: number}} T
 * @param {T[]} first Spans in text order
 * @param {T[]} second Spans in text order
 * @returns {T[]} All spans in text order
 */
function mergeSortedSpans(first, second) {
    if (second.length === 0) {
        return first;
    }
    const merged = [];
    let firstIndex = 0;
    let secondIndex = 0;
    while (firstIndex < first.length && secondIndex < second.length) {
        merged.push(first[firstIndex].start <= second[secondIndex].start ? first[firstIndex++] : second[secondIndex++]);
    }
    while (firstIndex < first.length) {
        merged.push(first[firstIndex++]);
    }
    while (secondIndex < second.length) {
        merged.push(second[secondIndex++]);
    }
    return merged;
}

/**
 * Extracts non-overlapping external media URL spans from a text string.
 * Covers Markdown images, HTML media attributes (including srcset), CSS url(), and bare image URLs.
 * @param {string} text Input text
 * @returns {{start: number, end: number, rawUrl: string, fetchUrl: string}[]} Ordered URL spans
 */
export function extractExternalMediaSpans(text) {
    if (typeof text !== 'string' || !MAY_HOLD_URL_REGEX.test(text)) {
        return [];
    }

    /** @type {{start: number, end: number, rawUrl: string, fetchUrl: string}[]} */
    let spans = [];
    /** @type {{start: number, end: number, rawUrl: string, fetchUrl: string}[]} */
    let passSpans = [];

    const addSpan = (start, end) => {
        if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) {
            return;
        }
        const rawUrl = text.slice(start, end);
        if (!rawUrl || rawUrl.includes('{{') || rawUrl.includes('}}')) {
            return;
        }
        const fetchUrl = rawUrl.replaceAll('&amp;', '&');
        if (!/^https?:\/\//i.test(fetchUrl)) {
            return;
        }
        if (overlapsSortedSpans(spans, start, end)) {
            return;
        }
        passSpans.push({ start, end, rawUrl, fetchUrl });
    };

    // A pass finds its spans in text order and they cannot overlap each other, so a span is checked only against
    // the spans of the earlier passes, which take priority, and the two sorted lists are merged once per pass.
    const endPass = () => {
        spans = mergeSortedSpans(spans, passSpans);
        passSpans = [];
    };

    for (const match of text.matchAll(MARKDOWN_IMAGE_REGEX)) {
        const range = match.indices?.[1] ?? match.indices?.[2];
        if (range) {
            addSpan(range[0], range[1]);
        }
    }
    endPass();

    /** @type {{text: string, start: number}[]} */
    const mediaTags = [];
    for (const tagMatch of text.matchAll(HTML_MEDIA_TAG_REGEX)) {
        mediaTags.push({ text: tagMatch[0], start: tagMatch.index ?? 0 });
    }

    for (const tag of mediaTags) {
        for (const attrMatch of tag.text.matchAll(HTML_MEDIA_ATTR_REGEX)) {
            const range = attrMatch.indices?.[1] ?? attrMatch.indices?.[2] ?? attrMatch.indices?.[3];
            if (range) {
                addSpan(tag.start + range[0], tag.start + range[1]);
            }
        }
    }
    endPass();

    for (const tag of mediaTags) {
        for (const srcsetMatch of tag.text.matchAll(HTML_SRCSET_ATTR_REGEX)) {
            const srcsetRange = srcsetMatch.indices?.[1] ?? srcsetMatch.indices?.[2];
            if (!srcsetRange) {
                continue;
            }
            const srcsetText = tag.text.slice(srcsetRange[0], srcsetRange[1]);
            const srcsetOffset = tag.start + srcsetRange[0];
            for (const candidateMatch of srcsetText.matchAll(SRCSET_CANDIDATE_REGEX)) {
                const urlRange = candidateMatch.indices?.[1];
                if (urlRange) {
                    addSpan(srcsetOffset + urlRange[0], srcsetOffset + urlRange[1]);
                }
            }
        }
    }
    endPass();

    for (const cssMatch of text.matchAll(CSS_URL_REGEX)) {
        const range = cssMatch.indices?.[1] ?? cssMatch.indices?.[2] ?? cssMatch.indices?.[3];
        if (range) {
            addSpan(range[0], range[1]);
        }
    }
    endPass();

    for (const bareMatch of text.matchAll(BARE_HTTP_URL_REGEX)) {
        const rawStart = bareMatch.index ?? 0;
        let rawEnd = rawStart + bareMatch[0].length;
        while (rawEnd > rawStart && /[.,;:!?]/.test(text[rawEnd - 1])) {
            rawEnd--;
        }
        if (rawEnd <= rawStart) {
            continue;
        }
        const candidateUrl = text.slice(rawStart, rawEnd).replaceAll('&amp;', '&');
        try {
            const urlObj = new URL(candidateUrl);
            const ext = path.posix.extname(urlObj.pathname).toLowerCase();
            if (IMAGE_EXTENSIONS.has(ext)) {
                addSpan(rawStart, rawEnd);
            }
        } catch {
            // Ignore malformed bare URLs.
        }
    }
    endPass();

    return spans;
}

function discardResponseBody(response) {
    if (!response?.body) {
        return;
    }
    if (typeof response.body.destroy === 'function') {
        response.body.destroy();
    } else if (typeof response.body.cancel === 'function') {
        Promise.resolve(response.body.cancel()).catch(() => {});
    }
}

/**
 * Reads a response body up to a byte limit.
 * @param {any} response Response of the request
 * @param {number} maxBytes Most bytes to accept
 * @param {{bytes: number}} received Receives the count of bytes read, also when the read fails
 * @returns {Promise<Buffer>} Body
 */
async function readResponseBufferBounded(response, maxBytes, received = { bytes: 0 }) {
    const contentLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        discardResponseBody(response);
        throw new Error(`External media exceeds maximum size (${contentLength} > ${maxBytes})`);
    }

    if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
        const chunks = [];
        let totalBytes = 0;
        try {
            for await (const chunk of response.body) {
                const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                totalBytes += bufferChunk.length;
                received.bytes = totalBytes;
                if (totalBytes > maxBytes) {
                    throw new Error(`External media stream exceeded maximum size (${maxBytes} bytes)`);
                }
                chunks.push(bufferChunk);
            }
            return Buffer.concat(chunks, totalBytes);
        } catch (error) {
            discardResponseBody(response);
            throw error;
        }
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    received.bytes = buffer.length;
    if (buffer.length > maxBytes) {
        throw new Error(`External media buffer exceeded maximum size (${buffer.length} > ${maxBytes})`);
    }
    return buffer;
}

function buildContentAddressedFileName(originalUrl, finalUrl, buffer) {
    const originalUrlObj = new URL(originalUrl);
    const finalUrlObj = new URL(finalUrl);
    const candidateExt = path.posix.extname(finalUrlObj.pathname).toLowerCase()
        || path.posix.extname(originalUrlObj.pathname).toLowerCase();

    let ext = null;
    if (candidateExt && isImageFile(candidateExt, buffer)) {
        ext = candidateExt;
    } else {
        ext = getImageExtension(buffer);
    }

    if (!ext) {
        return null;
    }

    const rawPathName = originalUrlObj.pathname || finalUrlObj.pathname || '';
    const rawBaseName = decodeURIComponentSafe(path.posix.basename(rawPathName, path.posix.extname(rawPathName)));
    const stem = rawBaseName
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, MAX_STEM_LENGTH) || 'media';
    const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, STORED_HASH_LENGTH);

    return `${stem}-${hash}${ext}`;
}

/**
 * Issues an HTTP(S) GET request via `node:http` / `node:https` without following redirects.
 * Used under Bun because Bun aliases `node-fetch` to its built-in `fetch()`, which ignores `options.agent`.
 * @param {string} url Target HTTP(S) URL
 * @param {object} [options]
 * @param {Record<string, string>} [options.headers] Request headers
 * @param {import('node:http').Agent | import('agent-base').Agent} [options.agent] Custom HTTP/HTTPS agent (e.g. `getUntrustedRequestAgent()`)
 * @param {AbortSignal} [options.signal] Abort signal
 * @returns {Promise<{ok: boolean, status: number, statusText: string, headers: {get: (name: string) => string|null}, body: import('node:http').IncomingMessage}>}
 */
export function requestWithNodeHttp(url, { headers = {}, agent, signal } = {}) {
    const urlObj = new URL(url);
    const transport = urlObj.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
        const request = transport.request(urlObj, {
            method: 'GET',
            headers,
            agent: /** @type {any} */ (agent),
            signal,
        }, (response) => {
            const status = response.statusCode ?? 0;
            resolve({
                ok: status >= 200 && status < 300,
                status,
                statusText: response.statusMessage ?? '',
                headers: {
                    get(name) {
                        const value = response.headers[String(name).toLowerCase()];
                        if (Array.isArray(value)) {
                            return value.join(', ');
                        }
                        return value ?? null;
                    },
                },
                body: response,
            });
        });

        request.on('error', reject);
        request.end();
    });
}

/**
 * Checks whether a path holds a regular file with exactly the given bytes. A larger file is not read, so a file that
 * the user keeps under the same name cannot make the import read a large amount of data.
 * @param {string} filePath Path to check
 * @param {Buffer} buffer Expected content
 * @returns {Promise<boolean>} True when the file has this content
 */
async function holdsSameBytes(filePath, buffer) {
    const stats = await fsPromises.lstat(filePath);
    return stats.isFile() && stats.size === buffer.length && (await fsPromises.readFile(filePath)).equals(buffer);
}

/**
 * Stores a file under a name that does not exist yet, and never replaces a file that has the name.
 * The bytes go to a temporary file first and then to the name by a hard link that fails when the name exists, so the
 * name never holds a part of the content. A file system without hard links gets an exclusive create instead.
 * @param {string} filePath Target path
 * @param {Buffer} buffer Content
 * @returns {Promise<boolean>} True when the path now holds exactly this content, because it was created or already had it
 */
async function storeWithoutReplacing(filePath, buffer) {
    const tempPath = path.join(path.dirname(filePath), `.${crypto.randomBytes(8).toString('hex')}.tmp`);
    try {
        await fsPromises.writeFile(tempPath, buffer, { flag: 'wx' });
        try {
            await fsPromises.link(tempPath, filePath);
            return true;
        } catch (error) {
            if (error?.code === 'EEXIST') {
                return await holdsSameBytes(filePath, buffer);
            }
            if (!NO_HARD_LINK_CODES.has(error?.code)) {
                throw error;
            }
        }
        try {
            await fsPromises.writeFile(filePath, buffer, { flag: 'wx' });
            return true;
        } catch (error) {
            if (error?.code === 'EEXIST') {
                return await holdsSameBytes(filePath, buffer);
            }
            throw error;
        }
    } finally {
        await fsPromises.rm(tempPath, { force: true });
    }
}

/**
 * Tracks the bytes and the time that one import may use for all of its downloads together. A download reserves its
 * byte limit before it starts and settles with the bytes it read, so downloads that run at the same time cannot pass
 * the total.
 * @param {{totalMaxBytes: number, totalTimeoutMs: number}} limits Total limits
 */
function createImportBudget({ totalMaxBytes, totalTimeoutMs }) {
    let bytesLeft = totalMaxBytes;
    const deadline = Date.now() + totalTimeoutMs;
    return {
        get remainingMs() {
            return Math.max(0, deadline - Date.now());
        },
        get isUsedUp() {
            return bytesLeft <= 0 || Date.now() >= deadline;
        },
        reserveBytes(limit) {
            const granted = Math.max(0, Math.min(limit, bytesLeft));
            bytesLeft -= granted;
            return granted;
        },
        settleBytes(granted, used) {
            bytesLeft += granted - used;
        },
    };
}

/**
 * Downloads one image within the limits of the import and stores it.
 * @param {string} url Image URL
 * @param {object} options
 * @param {import('./users.js').UserDirectoryList} options.directories User directories
 * @param {string} options.folder Folder under user/images
 * @param {typeof fetch} options.fetchImpl Fetch implementation
 * @param {number} options.timeoutMs Time limit of one request
 * @param {number} options.maxBytes Byte limit of one image
 * @param {ReturnType<typeof createImportBudget>} options.budget Budget of the import
 * @returns {Promise<{fileName: string, localPath: string}|null>} The stored file, or null when the URL stays remote
 */
async function downloadAndStoreExternalImage(url, { directories, folder, fetchImpl, timeoutMs, maxBytes, budget }) {
    const reservedBytes = budget.reserveBytes(maxBytes);
    const received = { bytes: 0 };
    try {
        return await fetchAndStoreExternalImage(url, { directories, folder, fetchImpl, timeoutMs, maxBytes: reservedBytes, received, budget });
    } finally {
        budget.settleBytes(reservedBytes, received.bytes);
    }
}

async function fetchAndStoreExternalImage(url, { directories, folder, fetchImpl, timeoutMs, maxBytes, received, budget }) {
    if (!isValidExternalMediaUrl(url)) {
        return null;
    }

    const performRequest = fetchImpl === fetch && typeof process.versions?.bun === 'string'
        ? requestWithNodeHttp
        : fetchImpl;

    let currentUrl = url;
    let response = null;

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
        if (!isValidExternalMediaUrl(currentUrl) || budget.remainingMs <= 0) {
            return null;
        }

        response = await performRequest(currentUrl, {
            method: 'GET',
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'image/*,*/*;q=0.8',
                // Node.js decodes a compressed answer and Bun does not, so ask for none and decode none.
                'Accept-Encoding': 'identity',
            },
            agent: /** @type {any} */ (getUntrustedRequestAgent()),
            compress: false,
            redirect: 'manual',
            signal: AbortSignal.timeout(Math.min(timeoutMs, budget.remainingMs)),
            size: maxBytes,
        });

        if (response && response.status >= 300 && response.status < 400) {
            const location = response.headers?.get?.('location');
            discardResponseBody(response);
            if (!location || redirectCount === MAX_REDIRECTS) {
                return null;
            }
            const nextUrl = new URL(location, currentUrl);
            // A step from https to http lets a party on the network path replace the image.
            if (new URL(currentUrl).protocol === 'https:' && nextUrl.protocol === 'http:') {
                return null;
            }
            currentUrl = nextUrl.toString();
            continue;
        }

        break;
    }

    if (!response?.ok) {
        discardResponseBody(response);
        return null;
    }

    const buffer = await readResponseBufferBounded(response, maxBytes, received);
    const fileName = buildContentAddressedFileName(url, currentUrl, buffer);
    if (!fileName) {
        console.warn(`External media import skipped non-image response from ${quoteForLog(url)}`);
        return null;
    }

    const targetDir = path.join(directories.userImages, folder);
    if (!ensureDirectory(targetDir)) {
        return null;
    }

    const filePath = path.join(targetDir, fileName);
    if (path.dirname(path.resolve(filePath)) !== path.resolve(targetDir)) {
        return null;
    }

    if (!await storeWithoutReplacing(filePath, buffer)) {
        console.warn(`External media import kept the existing file ${quoteForLog(fileName)}, because its content is other than the download, so the URL stays remote`);
        return null;
    }
    return { fileName, localPath: getLocalExternalMediaUrl(folder, fileName) };
}

/**
 * Creates a batch localizer that collects candidate URLs across multiple strings,
 * downloads each unique valid image URL at most once, and rewrites the strings.
 * @param {object} options
 * @param {import('./users.js').UserDirectoryList} options.directories User directories
 * @param {string|null} options.folder Validated subfolder name under user/images
 * @param {typeof fetch} [options.fetchImpl] Custom fetch implementation for testing
 * @param {number} [options.timeoutMs] Per-request timeout in milliseconds
 * @param {number} [options.maxBytes] Max bytes per downloaded image
 * @param {number} [options.totalMaxBytes] Max bytes of all downloads of one import
 * @param {number} [options.totalTimeoutMs] Max time of all downloads of one import in milliseconds
 */
function createExternalMediaLocalizer({
    directories,
    folder,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
    maxBytes = MAX_EXTERNAL_MEDIA_BYTES,
    totalMaxBytes = MAX_TOTAL_BYTES_PER_IMPORT,
    totalTimeoutMs = MAX_TOTAL_TIME_PER_IMPORT_MS,
}) {
    /** @type {Set<string>} */
    const candidateUrls = new Set();
    // The URL as the file wrote it, for the first place that names it. The manifest keeps this form, so an export
    // gives the same text back.
    /** @type {Map<string, string>} */
    const writtenForms = new Map();
    /** @type {Map<string, string|null>} */
    const resolvedUrls = new Map();

    return {
        collectFromText(text) {
            if (typeof text !== 'string' || !MAY_HOLD_URL_REGEX.test(text)) {
                return;
            }
            for (const span of extractExternalMediaSpans(text)) {
                if (candidateUrls.size >= MAX_URLS_PER_IMPORT && !candidateUrls.has(span.fetchUrl)) {
                    break;
                }
                if (isValidExternalMediaUrl(span.fetchUrl)) {
                    candidateUrls.add(span.fetchUrl);
                    if (!writtenForms.has(span.fetchUrl)) {
                        writtenForms.set(span.fetchUrl, span.rawUrl);
                    }
                }
            }
        },

        collectDirectUrl(url) {
            if (typeof url !== 'string' || candidateUrls.size >= MAX_URLS_PER_IMPORT) {
                return;
            }
            const trimmed = url.trim();
            if (isValidExternalMediaUrl(trimmed)) {
                candidateUrls.add(trimmed);
                if (!writtenForms.has(trimmed)) {
                    writtenForms.set(trimmed, url);
                }
            }
        },

        async resolveAll() {
            if (!folder || candidateUrls.size === 0) {
                return 0;
            }

            const urls = [...candidateUrls];
            const budget = createImportBudget({ totalMaxBytes, totalTimeoutMs });
            /** @type {Map<string, string>} */
            const storedFileNames = new Map();
            let downloadedCount = 0;
            let skippedForBudget = 0;

            for (let i = 0; i < urls.length; i += MAX_CONCURRENT_DOWNLOADS) {
                const batch = urls.slice(i, i + MAX_CONCURRENT_DOWNLOADS);
                await Promise.all(batch.map(async (url) => {
                    if (budget.isUsedUp) {
                        skippedForBudget++;
                        resolvedUrls.set(url, null);
                        return;
                    }
                    try {
                        const stored = await downloadAndStoreExternalImage(url, {
                            directories,
                            folder,
                            fetchImpl,
                            timeoutMs,
                            maxBytes,
                            budget,
                        });
                        resolvedUrls.set(url, stored?.localPath ?? null);
                        if (stored) {
                            downloadedCount++;
                            storedFileNames.set(url, stored.fileName);
                        }
                    } catch (error) {
                        console.warn(`External media import failed for ${quoteForLog(url)}: ${quoteForLog(error?.message || error)}`);
                        resolvedUrls.set(url, null);
                    }
                }));
            }

            if (skippedForBudget > 0) {
                console.warn(`External media import used up its size or time limit for one import, so ${skippedForBudget} URL(s) stay remote`);
            }

            // Two URLs with the same file stem and the same bytes give one stored file. The manifest keeps the first of
            // them in text order, whatever order the downloads ended in.
            /** @type {Map<string, string>} */
            const storedOrigins = new Map();
            for (const url of urls) {
                const fileName = storedFileNames.get(url);
                if (fileName && !storedOrigins.has(fileName)) {
                    storedOrigins.set(fileName, writtenForms.get(url) ?? url);
                }
            }

            // The manifest is the only place that keeps the author's URL, and the caller replaces that URL in the card.
            // Without the manifest every URL stays remote.
            try {
                await recordExternalMediaOrigins(path.join(directories.userImages, folder), storedOrigins);
            } catch (error) {
                console.warn(`External media import could not write its manifest, so the URLs stay remote: ${quoteForLog(error?.message || error)}`);
                for (const url of resolvedUrls.keys()) {
                    resolvedUrls.set(url, null);
                }
                return 0;
            }

            return downloadedCount;
        },

        rewriteText(text) {
            if (typeof text !== 'string' || resolvedUrls.size === 0 || !MAY_HOLD_URL_REGEX.test(text)) {
                return { text, changed: false };
            }

            const spans = extractExternalMediaSpans(text);
            if (spans.length === 0) {
                return { text, changed: false };
            }

            let result = '';
            let cursor = 0;
            let changed = false;

            for (const span of spans) {
                const replacement = resolvedUrls.get(span.fetchUrl);
                result += text.slice(cursor, span.start);
                if (replacement) {
                    result += replacement;
                    changed = true;
                } else {
                    result += span.rawUrl;
                }
                cursor = span.end;
            }
            result += text.slice(cursor);

            return { text: changed ? result : text, changed };
        },

        rewriteDirectUrl(url) {
            if (typeof url !== 'string') {
                return { url, changed: false };
            }
            const replacement = resolvedUrls.get(url.trim());
            return replacement ? { url: replacement, changed: true } : { url, changed: false };
        },
    };
}

function walkCharacterBook(book, visitText) {
    if (!book || typeof book !== 'object') {
        return false;
    }

    let changed = false;
    if (typeof book.description === 'string') {
        const next = visitText(book.description);
        if (next !== book.description) {
            book.description = next;
            changed = true;
        }
    }

    const entries = Array.isArray(book.entries)
        ? book.entries
        : (book.entries && typeof book.entries === 'object' ? Object.values(book.entries) : []);

    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        if (typeof entry.content === 'string') {
            const next = visitText(entry.content);
            if (next !== entry.content) {
                entry.content = next;
                changed = true;
            }
        }
        if (typeof entry.comment === 'string') {
            const next = visitText(entry.comment);
            if (next !== entry.comment) {
                entry.comment = next;
                changed = true;
            }
        }
    }

    return changed;
}

function walkByafScenarios(scenarios, visitText) {
    if (!Array.isArray(scenarios)) {
        return false;
    }

    let changed = false;
    for (const scenario of scenarios) {
        if (!scenario || typeof scenario !== 'object') {
            continue;
        }
        for (const key of ['narrative', 'formattingInstructions']) {
            if (typeof scenario[key] === 'string') {
                const next = visitText(scenario[key]);
                if (next !== scenario[key]) {
                    scenario[key] = next;
                    changed = true;
                }
            }
        }
        for (const listKey of ['firstMessages', 'exampleMessages']) {
            if (!Array.isArray(scenario[listKey])) {
                continue;
            }
            for (const item of scenario[listKey]) {
                if (item && typeof item.text === 'string') {
                    const next = visitText(item.text);
                    if (next !== item.text) {
                        item.text = next;
                        changed = true;
                    }
                }
            }
        }
        if (Array.isArray(scenario.messages)) {
            for (const message of scenario.messages) {
                if (!message || typeof message !== 'object') {
                    continue;
                }
                if (typeof message.text === 'string') {
                    const next = visitText(message.text);
                    if (next !== message.text) {
                        message.text = next;
                        changed = true;
                    }
                }
                if (Array.isArray(message.outputs)) {
                    for (const output of message.outputs) {
                        if (output && typeof output.text === 'string') {
                            const next = visitText(output.text);
                            if (next !== output.text) {
                                output.text = next;
                                changed = true;
                            }
                        }
                    }
                }
            }
        }
    }

    return changed;
}

function walkCharacterCard(card, visitText, visitDirectUrl, scenarios = undefined) {
    if (!card || typeof card !== 'object') {
        return false;
    }

    let changed = false;
    const data = card.data && typeof card.data === 'object' ? card.data : null;

    const sharedFields = [
        ['description', 'description'],
        ['personality', 'personality'],
        ['scenario', 'scenario'],
        ['first_mes', 'first_mes'],
        ['mes_example', 'mes_example'],
        ['creatorcomment', 'creator_notes'],
    ];

    for (const [topKey, dataKey] of sharedFields) {
        const sourceValue = typeof data?.[dataKey] === 'string'
            ? data[dataKey]
            : (typeof card[topKey] === 'string' ? card[topKey] : undefined);
        if (typeof sourceValue === 'string') {
            const next = visitText(sourceValue);
            if (next !== sourceValue) {
                changed = true;
            }
            if (typeof card[topKey] === 'string' || next !== sourceValue) {
                card[topKey] = next;
            }
            if (data && (typeof data[dataKey] === 'string' || next !== sourceValue)) {
                data[dataKey] = next;
            }
        }
    }

    if (data) {
        for (const key of ['system_prompt', 'post_history_instructions']) {
            if (typeof data[key] === 'string') {
                const next = visitText(data[key]);
                if (next !== data[key]) {
                    data[key] = next;
                    changed = true;
                }
            }
        }

        for (const arrayKey of ['alternate_greetings', 'group_only_greetings']) {
            if (Array.isArray(data[arrayKey])) {
                for (let i = 0; i < data[arrayKey].length; i++) {
                    if (typeof data[arrayKey][i] === 'string') {
                        const next = visitText(data[arrayKey][i]);
                        if (next !== data[arrayKey][i]) {
                            data[arrayKey][i] = next;
                            changed = true;
                        }
                    }
                }
            }
        }

        if (data.creator_notes_multilang && typeof data.creator_notes_multilang === 'object' && !Array.isArray(data.creator_notes_multilang)) {
            for (const [lang, notes] of Object.entries(data.creator_notes_multilang)) {
                if (typeof notes === 'string') {
                    const next = visitText(notes);
                    if (next !== notes) {
                        data.creator_notes_multilang[lang] = next;
                        changed = true;
                    }
                }
            }
        }

        if (typeof data.extensions?.depth_prompt?.prompt === 'string') {
            const next = visitText(data.extensions.depth_prompt.prompt);
            if (next !== data.extensions.depth_prompt.prompt) {
                data.extensions.depth_prompt.prompt = next;
                changed = true;
            }
        }

        if (Array.isArray(data.extensions?.regex_scripts)) {
            for (const script of data.extensions.regex_scripts) {
                if (script && typeof script.replaceString === 'string') {
                    const next = visitText(script.replaceString);
                    if (next !== script.replaceString) {
                        script.replaceString = next;
                        changed = true;
                    }
                }
            }
        }

        if (walkCharacterBook(data.character_book, visitText)) {
            changed = true;
        }

        if (Array.isArray(data.assets)) {
            for (const asset of data.assets) {
                const assetType = typeof asset?.type === 'string' ? asset.type.toLowerCase() : '';
                if (asset && typeof asset === 'object' && assetType !== 'icon' && assetType !== 'user_icon' && typeof asset.uri === 'string') {
                    const next = visitDirectUrl(asset.uri);
                    if (next !== asset.uri) {
                        asset.uri = next;
                        changed = true;
                    }
                }
            }
        }
    }

    if (walkByafScenarios(scenarios, visitText)) {
        changed = true;
    }

    return changed;
}

/**
 * Downloads and rewrites external image URLs embedded across all character card fields
 * (including alternate greetings, embedded lorebook entries, creator notes, and BYAF scenarios).
 * @param {object} card Normalized character card object
 * @param {object} options
 * @param {import('express').Request} options.request Express request
 * @param {string} options.fileName Card file name without extension
 * @param {object[]} [options.scenarios] Optional BYAF scenarios array
 * @param {typeof fetch} [options.fetchImpl] Custom fetch implementation for testing
 * @param {number} [options.maxBytes] Max bytes per downloaded image, for testing
 * @param {number} [options.timeoutMs] Per-request timeout in milliseconds, for testing
 * @param {number} [options.totalMaxBytes] Max bytes of all downloads of one import, for testing
 * @param {number} [options.totalTimeoutMs] Max time of all downloads of one import in milliseconds, for testing
 * @returns {Promise<{changed: boolean, downloaded: number}>}
 */
export async function localizeCharacterExternalMedia(card, { request, fileName, scenarios, fetchImpl = fetch, ...limits }) {
    if (!shouldImportExternalMedia(request)) {
        return { changed: false, downloaded: 0 };
    }

    const directories = request?.user?.directories;
    const cardName = card?.data?.name || card?.name || '';
    const folder = getExternalMediaFolder(cardName, fileName, directories);
    if (!folder) {
        return { changed: false, downloaded: 0 };
    }

    const localizer = createExternalMediaLocalizer({ directories, folder, fetchImpl, ...limits });
    walkCharacterCard(
        card,
        (text) => {
            localizer.collectFromText(text);
            return text;
        },
        (url) => {
            localizer.collectDirectUrl(url);
            return url;
        },
        scenarios,
    );

    const downloaded = await localizer.resolveAll();
    if (downloaded === 0) {
        return { changed: false, downloaded: 0 };
    }

    const changed = walkCharacterCard(
        card,
        (text) => localizer.rewriteText(text).text,
        (url) => localizer.rewriteDirectUrl(url).url,
        scenarios,
    );

    return { changed, downloaded };
}

/**
 * Downloads and rewrites external image URLs embedded in a World Info / lorebook object.
 * @param {object} worldContent Parsed World Info JSON object
 * @param {object} options
 * @param {import('express').Request} options.request Express request
 * @param {string} options.worldName Canonical World Info name
 * @param {typeof fetch} [options.fetchImpl] Custom fetch implementation for testing
 * @param {number} [options.maxBytes] Max bytes per downloaded image, for testing
 * @param {number} [options.timeoutMs] Per-request timeout in milliseconds, for testing
 * @param {number} [options.totalMaxBytes] Max bytes of all downloads of one import, for testing
 * @param {number} [options.totalTimeoutMs] Max time of all downloads of one import in milliseconds, for testing
 * @returns {Promise<{changed: boolean, downloaded: number}>}
 */
export async function localizeWorldInfoExternalMedia(worldContent, { request, worldName, fetchImpl = fetch, ...limits }) {
    if (!shouldImportExternalMedia(request)) {
        return { changed: false, downloaded: 0 };
    }

    const directories = request?.user?.directories;
    const folder = getExternalMediaFolder(worldName, '', directories);
    if (!folder) {
        return { changed: false, downloaded: 0 };
    }

    const localizer = createExternalMediaLocalizer({ directories, folder, fetchImpl, ...limits });

    walkCharacterBook(worldContent, (text) => {
        localizer.collectFromText(text);
        return text;
    });
    walkCharacterBook(worldContent?.originalData, (text) => {
        localizer.collectFromText(text);
        return text;
    });

    const downloaded = await localizer.resolveAll();
    if (downloaded === 0) {
        return { changed: false, downloaded: 0 };
    }

    const entriesChanged = walkCharacterBook(worldContent, (text) => localizer.rewriteText(text).text);
    const originalChanged = walkCharacterBook(worldContent?.originalData, (text) => localizer.rewriteText(text).text);

    return { changed: entriesChanged || originalChanged, downloaded };
}
