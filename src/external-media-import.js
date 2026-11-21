import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

import ipRegex from 'ip-regex';
import fetch from 'node-fetch';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { SETTINGS_FILE } from './constants.js';
import { getImageExtension, isImageFile } from './image-file-type.js';
import { getUntrustedRequestAgent } from './private-request-filter.js';
import { ensureDirectory, getConfigValue, tryParse } from './util.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.apng', '.jpg', '.jpeg', '.jfif', '.gif', '.webp', '.avif', '.bmp']);
const MAX_EXTERNAL_MEDIA_BYTES = 25 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const MAX_URLS_PER_IMPORT = 100;
const MAX_CONCURRENT_DOWNLOADS = 4;
const MAX_STEM_LENGTH = 24;
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
const BARE_HTTP_URL_REGEX = /https?:\/\/[^\s"'<>)\]]+/dgi;

/**
 * Quotes text from an imported file or a remote host for the console, so that its control characters are escaped.
 * @param {unknown} value Text to log
 * @returns {string} JSON string literal
 */
function quoteForLog(value) {
    return JSON.stringify(String(value));
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
 * Resolves whether external media should be downloaded on import for the current request.
 * Checks the request body override first, then the user's persisted power_user setting, then config.yaml.
 * @param {import('express').Request} request Express request
 * @returns {boolean} Whether external media localization is enabled
 */
export function shouldImportExternalMedia(request) {
    const rawOverride = request?.body?.import_external_media;
    if (typeof rawOverride === 'boolean') {
        return rawOverride;
    }
    if (typeof rawOverride === 'string') {
        const normalized = rawOverride.trim().toLowerCase();
        if (normalized === 'true' || normalized === '1') {
            return true;
        }
        if (normalized === 'false' || normalized === '0') {
            return false;
        }
    }

    const userRoot = request?.user?.directories?.root;
    if (typeof userRoot === 'string' && userRoot) {
        const settingsPath = path.join(userRoot, SETTINGS_FILE);
        if (fs.existsSync(settingsPath)) {
            try {
                const settings = tryParse(fs.readFileSync(settingsPath, 'utf8'));
                if (typeof settings?.power_user?.import_external_media === 'boolean') {
                    return settings.power_user.import_external_media;
                }
            } catch {
                // Fall back to config.yaml if settings.json cannot be read.
            }
        }
    }

    return Boolean(getConfigValue('importExternalMedia', false, 'boolean'));
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
    if (typeof text !== 'string' || !text.includes('http')) {
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

async function readResponseBufferBounded(response, maxBytes) {
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
    const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 8);

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

async function downloadAndStoreExternalImage(url, { directories, folder, fetchImpl = fetch, timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS, maxBytes = MAX_EXTERNAL_MEDIA_BYTES }) {
    if (!isValidExternalMediaUrl(url)) {
        return null;
    }

    const performRequest = fetchImpl === fetch && typeof process.versions?.bun === 'string'
        ? requestWithNodeHttp
        : fetchImpl;

    let currentUrl = url;
    let response = null;

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
        if (!isValidExternalMediaUrl(currentUrl)) {
            return null;
        }

        response = await performRequest(currentUrl, {
            method: 'GET',
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'image/*,*/*;q=0.8',
            },
            agent: /** @type {any} */ (getUntrustedRequestAgent()),
            redirect: 'manual',
            signal: AbortSignal.timeout(timeoutMs),
            size: maxBytes,
        });

        if (response && response.status >= 300 && response.status < 400) {
            const location = response.headers?.get?.('location');
            discardResponseBody(response);
            if (!location || redirectCount === MAX_REDIRECTS) {
                return null;
            }
            currentUrl = new URL(location, currentUrl).toString();
            continue;
        }

        break;
    }

    if (!response?.ok) {
        discardResponseBody(response);
        return null;
    }

    const buffer = await readResponseBufferBounded(response, maxBytes);
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

    writeFileAtomicSync(filePath, buffer);
    return `/user/images/${encodeURIComponent(folder)}/${fileName}`;
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
 */
function createExternalMediaLocalizer({ directories, folder, fetchImpl = fetch, timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS, maxBytes = MAX_EXTERNAL_MEDIA_BYTES }) {
    /** @type {Set<string>} */
    const candidateUrls = new Set();
    /** @type {Map<string, string|null>} */
    const resolvedUrls = new Map();

    return {
        collectFromText(text) {
            if (typeof text !== 'string' || !text.includes('http')) {
                return;
            }
            for (const span of extractExternalMediaSpans(text)) {
                if (candidateUrls.size >= MAX_URLS_PER_IMPORT && !candidateUrls.has(span.fetchUrl)) {
                    break;
                }
                if (isValidExternalMediaUrl(span.fetchUrl)) {
                    candidateUrls.add(span.fetchUrl);
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
            }
        },

        async resolveAll() {
            if (!folder || candidateUrls.size === 0) {
                return 0;
            }

            const urls = [...candidateUrls];
            let downloadedCount = 0;

            for (let i = 0; i < urls.length; i += MAX_CONCURRENT_DOWNLOADS) {
                const batch = urls.slice(i, i + MAX_CONCURRENT_DOWNLOADS);
                await Promise.all(batch.map(async (url) => {
                    try {
                        const localPath = await downloadAndStoreExternalImage(url, {
                            directories,
                            folder,
                            fetchImpl,
                            timeoutMs,
                            maxBytes,
                        });
                        resolvedUrls.set(url, localPath);
                        if (localPath) {
                            downloadedCount++;
                        }
                    } catch (error) {
                        console.warn(`External media import failed for ${quoteForLog(url)}: ${quoteForLog(error?.message || error)}`);
                        resolvedUrls.set(url, null);
                    }
                }));
            }

            return downloadedCount;
        },

        rewriteText(text) {
            if (typeof text !== 'string' || resolvedUrls.size === 0 || !text.includes('http')) {
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
 * @returns {Promise<{changed: boolean, downloaded: number}>}
 */
export async function localizeCharacterExternalMedia(card, { request, fileName, scenarios, fetchImpl = fetch }) {
    if (!shouldImportExternalMedia(request)) {
        return { changed: false, downloaded: 0 };
    }

    const directories = request?.user?.directories;
    const cardName = card?.data?.name || card?.name || '';
    const folder = getExternalMediaFolder(cardName, fileName, directories);
    if (!folder) {
        return { changed: false, downloaded: 0 };
    }

    const localizer = createExternalMediaLocalizer({ directories, folder, fetchImpl });
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
 * @returns {Promise<{changed: boolean, downloaded: number}>}
 */
export async function localizeWorldInfoExternalMedia(worldContent, { request, worldName, fetchImpl = fetch }) {
    if (!shouldImportExternalMedia(request)) {
        return { changed: false, downloaded: 0 };
    }

    const directories = request?.user?.directories;
    const folder = getExternalMediaFolder(worldName, '', directories);
    if (!folder) {
        return { changed: false, downloaded: 0 };
    }

    const localizer = createExternalMediaLocalizer({ directories, folder, fetchImpl });

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
