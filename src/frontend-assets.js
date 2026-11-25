import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { serverDirectory } from './server-directory.js';
import { getConfigValue } from './util.js';

export const FRONTEND_DIST_ROOT = path.join(serverDirectory, 'dist', 'frontend');
export const FRONTEND_MANIFEST_FILE = 'asset-manifest.json';
export const FRONTEND_MANIFEST_VERSION = 2;
export const FRONTEND_ASSET_PREFIX = '/frontend-assets/';
export const HASHED_FRONTEND_ASSET_RE = /-[a-f0-9]{8,}\.[a-z0-9]+$/i;

const MANIFEST_UNSET = Symbol('manifest-unset');
const REWRITTEN_HTML_CACHE_MAX_ENTRIES = 16;

const IGNORED_PATH_SEGMENTS = new Set([
    '.git',
    '.github',
    '.playwright-cli',
    '.DS_Store',
    'Thumbs.db',
    'output',
    'node_modules',
]);

// User-owned or gitignored runtime paths inside public/ must never enter dist/frontend or inputsHash.
const EXCLUDED_PUBLIC_FILES = new Set([
    'css/user.css',
    'css/bg_load.css',
    'stats.json',
    'settings.json',
]);

const EXCLUDED_PUBLIC_DIRECTORIES = Object.freeze([
    'scripts/extensions/third-party',
    'chats',
    'characters',
    'User Avatars',
    'backgrounds',
    'groups',
    'group chats',
    'worlds',
    'user',
    'themes',
    'OpenAI Settings',
    'KoboldAI Settings',
    'NovelAI Settings',
    'TextGen Settings',
    'instruct',
    'context',
    'movingUI',
    'QuickReplies',
    'assets',
    'error',
]);

const TEXT_HASH_EXTENSIONS = new Set([
    '.css',
    '.html',
    '.js',
    '.json',
    '.less',
    '.license',
    '.map',
    '.md',
    '.mjs',
    '.patch',
    '.svg',
    '.ts',
    '.txt',
]);

const TEXT_HASH_BASENAMES = new Set([
    'license',
]);

// Legacy v1 manifest HTML replacements (used only when no v2 importMap is present).
const V1_HTML_REPLACEMENT_PATHS = Object.freeze([
    'style.css',
    'css/mobile-styles.css',
    'css/sillybunny-theme.css',
    'css/sillybunny-tabs.css',
    'css/sillybunny-mobile-shell.css',
    'webfonts/AdwaitaSans/AdwaitaSans-Regular-Latin.woff2',
    'webfonts/AdwaitaSans/stylesheet.css',
    'webfonts/NotoSans/stylesheet.css',
    'webfonts/AdwaitaMono/stylesheet.css',
    'webfonts/NotoSansMono/stylesheet.css',
]);

const REWRITABLE_LINK_EXTENSIONS = new Set([
    '.css',
    '.woff2',
    '.woff',
    '.ttf',
    '.png',
    '.jpg',
    '.jpeg',
    '.webp',
    '.gif',
    '.svg',
    '.ico',
]);

let manifestCache = MANIFEST_UNSET;
let inputsHashCache = null;
let warnedMismatchHash = null;

/** @type {Map<string, string>} */
const rewrittenHtmlCache = new Map();
/** @type {Map<string, { mtimeMs: number, size: number, manifestKey: string, html: string }>} */
const fileHtmlCache = new Map();
let htmlCacheHits = 0;
let htmlCacheMisses = 0;

function toPosix(value) {
    return String(value).split(path.sep).join('/');
}

function compareLex(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

function stripAssetQuery(value) {
    return String(value).split(/[?#]/)[0];
}

function isExternalAssetUrl(value) {
    return /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(String(value).trim());
}

/**
 * Returns true if a relative POSIX path under public/ is excluded from frontend builds and inputsHash.
 * @param {string} relativePath Relative path inside public/
 * @returns {boolean}
 */
export function isExcludedFrontendPublicPath(relativePath) {
    const normalized = toPosix(relativePath).replace(/^\/+/, '');
    if (!normalized) {
        return true;
    }

    const segments = normalized.split('/');
    if (segments.some(segment => IGNORED_PATH_SEGMENTS.has(segment))) {
        return true;
    }

    if (EXCLUDED_PUBLIC_FILES.has(normalized)) {
        return true;
    }

    return EXCLUDED_PUBLIC_DIRECTORIES.some(dir => normalized === dir || normalized.startsWith(`${dir}/`));
}

/**
 * Returns true when SB_DEV disables prebuilt frontend assets so raw public/ files are served directly.
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean}
 */
export function isFrontendDevMode(env = process.env) {
    const value = String(env?.SB_DEV ?? '').trim().toLowerCase();
    return value === '1' || value === 'true' || value === 'yes';
}

function walkPublicInputsSync(directory, publicRoot, files = []) {
    if (!fs.existsSync(directory)) {
        return files;
    }

    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        const relPosix = toPosix(path.relative(publicRoot, fullPath));

        if (isExcludedFrontendPublicPath(relPosix)) {
            continue;
        }

        if (entry.isDirectory()) {
            walkPublicInputsSync(fullPath, publicRoot, files);
        } else if (entry.isFile()) {
            files.push({ fullPath, relPosix });
        }
    }

    return files;
}

function readNormalizedBytesForHash(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const base = path.basename(filePath).toLowerCase();
    if (TEXT_HASH_EXTENSIONS.has(ext) || TEXT_HASH_BASENAMES.has(base)) {
        const text = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
        return Buffer.from(text, 'utf8');
    }

    return fs.readFileSync(filePath);
}

/**
 * Computes a fast deterministic SHA-256 fingerprint over all buildable public/ inputs (plus webpack.config.js,
 * package.json, and scripts/build-frontend-assets.js).
 * Normalizes line endings on text files so CI Linux builds match Windows/macOS checkouts identically.
 * @param {object} [options]
 * @param {string} [options.repoRoot=serverDirectory]
 * @param {string} [options.publicRoot]
 * @returns {string}
 */
export function computeFrontendInputsHash({
    repoRoot = serverDirectory,
    publicRoot = path.join(repoRoot, 'public'),
} = {}) {
    const hasher = crypto.createHash('sha256');
    hasher.update(`frontend-inputs-v${FRONTEND_MANIFEST_VERSION}\0`);

    const rootBuildInputs = [
        'webpack.config.js',
        'package.json',
        'scripts/build-frontend-assets.js',
    ];
    for (const relPosix of rootBuildInputs) {
        const fullPath = path.join(repoRoot, ...relPosix.split('/'));
        if (fs.existsSync(fullPath)) {
            hasher.update(`${relPosix}\0`);
            hasher.update(readNormalizedBytesForHash(fullPath));
            hasher.update('\0');
        }
    }

    const files = walkPublicInputsSync(publicRoot, publicRoot);
    files.sort((a, b) => compareLex(a.relPosix, b.relPosix));

    for (const file of files) {
        hasher.update(file.relPosix);
        hasher.update('\0');
        hasher.update(readNormalizedBytesForHash(file.fullPath));
        hasher.update('\0');
    }

    return hasher.digest('hex');
}

function getCachedFrontendInputsHash() {
    if (inputsHashCache === null) {
        inputsHashCache = computeFrontendInputsHash();
    }
    return inputsHashCache;
}

export function getFrontendManifestPath() {
    return path.join(FRONTEND_DIST_ROOT, FRONTEND_MANIFEST_FILE);
}

export function getFrontendAssetsEnabled() {
    if (isFrontendDevMode()) {
        return false;
    }

    return getConfigValue('performance.frontendBuild.enabled', false, 'boolean');
}

export function getFrontendImmutableMaxAge() {
    const value = getConfigValue('performance.frontendBuild.immutableMaxAge', 31536000, 'number');
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 31536000;
}

export function clearFrontendManifestCache() {
    manifestCache = MANIFEST_UNSET;
    inputsHashCache = null;
    warnedMismatchHash = null;
    rewrittenHtmlCache.clear();
    fileHtmlCache.clear();
    htmlCacheHits = 0;
    htmlCacheMisses = 0;
}

export function getFrontendHtmlCacheStats() {
    return {
        entries: rewrittenHtmlCache.size,
        fileEntries: fileHtmlCache.size,
        hits: htmlCacheHits,
        misses: htmlCacheMisses,
    };
}

function isManifestFresh(manifest) {
    if (!manifest || typeof manifest !== 'object') {
        return false;
    }

    const version = Number(manifest.version ?? 1);
    const hasInputsHash = typeof manifest.inputsHash === 'string' && manifest.inputsHash.length > 0;

    if (version >= FRONTEND_MANIFEST_VERSION && !hasInputsHash) {
        return false;
    }

    if (hasInputsHash) {
        const expectedHash = getCachedFrontendInputsHash();
        if (manifest.inputsHash !== expectedHash) {
            const mismatchKey = `${manifest.inputsHash}:${expectedHash}`;
            if (warnedMismatchHash !== mismatchKey) {
                warnedMismatchHash = mismatchKey;
                console.warn('Frontend asset manifest inputsHash mismatch; falling back to raw public/ assets.');
            }
            return false;
        }
    }

    return true;
}

export function loadFrontendManifest() {
    if (manifestCache !== MANIFEST_UNSET) {
        return manifestCache;
    }

    const manifestPath = getFrontendManifestPath();
    if (!fs.existsSync(manifestPath)) {
        manifestCache = null;
        return null;
    }

    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifestCache = isManifestFresh(manifest) ? manifest : null;
    } catch (error) {
        console.warn('Failed to read frontend asset manifest.', error);
        manifestCache = null;
    }

    return manifestCache;
}

export function resolveFrontendAssetPath(publicPath, manifest = loadFrontendManifest()) {
    const assets = manifest?.assets;

    if (!assets || typeof assets !== 'object') {
        return null;
    }

    const normalizedPath = String(publicPath).replace(/^\/+/, '');
    if (normalizedPath === 'css/user.css') {
        return null;
    }

    const entry = assets[normalizedPath];

    if (!entry || typeof entry.output !== 'string') {
        return null;
    }

    return `${FRONTEND_ASSET_PREFIX}${entry.output}`;
}

function hasValidImportMap(manifest) {
    const imports = manifest?.importMap?.imports;
    return Boolean(imports && typeof imports === 'object' && Object.keys(imports).length > 0);
}

function serializeImportMapScript(importMap) {
    const safeJson = JSON.stringify(importMap).replace(/</g, '\\u003c');
    return `<script type="importmap">${safeJson}</script>`;
}

function getTagAttribute(tag, attrName) {
    const match = tag.match(new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
    return match ? (match[1] ?? match[2] ?? '') : '';
}

function replaceTagAttribute(tag, attrName, newValue) {
    return tag.replace(
        new RegExp(`(\\b${attrName}\\s*=\\s*)(?:"[^"]*"|'[^']*')`, 'i'),
        (match, prefix) => {
            const quote = match[prefix.length];
            return `${prefix}${quote}${newValue}${quote}`;
        },
    );
}

function hasTagAttribute(tag, attrName) {
    return new RegExp(`\\b${attrName}(?:\\s*=|[\\s/>])`, 'i').test(tag);
}

function appendTagAttribute(tag, attrText) {
    return tag.replace(/\s*(\/?>)$/, ` ${attrText}$1`);
}

function injectSingleImportMap(html, importMap) {
    const scriptTag = serializeImportMapScript(importMap);

    // Strip any pre-existing importmap tags so the document always contains strictly one.
    const withoutExisting = html.replace(/<script\b[^>]*\btype\s*=\s*(?:"importmap"|'importmap')[^>]*>[\s\S]*?<\/script>\s*/gi, '');

    const headOpenMatch = /<head\b[^>]*>/i.exec(withoutExisting);
    const firstModuleMatch = /<link\b[^>]*\brel\s*=\s*(?:"[^"]*\bmodulepreload\b[^"]*"|'[^']*\bmodulepreload\b[^']*')[^>]*>|<script\b[^>]*\btype\s*=\s*(?:"module"|'module')[^>]*>/i.exec(withoutExisting);

    if (headOpenMatch) {
        const headStart = headOpenMatch.index + headOpenMatch[0].length;
        const headCloseIndex = withoutExisting.search(/<\/head>/i);
        const headEnd = headCloseIndex >= 0 ? headCloseIndex : withoutExisting.length;
        const searchEnd = Math.min(
            headEnd,
            firstModuleMatch ? firstModuleMatch.index : withoutExisting.length,
        );
        const headPrefix = withoutExisting.slice(headStart, Math.max(headStart, searchEnd));
        const baseMatch = /<base\b[^>]*>/i.exec(headPrefix);
        const minInsertIndex = baseMatch
            ? headStart + baseMatch.index + baseMatch[0].length
            : headStart;

        // Place the importmap immediately before the first modulepreload/module tag inside <head>
        // so <meta charset="utf-8">, viewport, critical <style>, and style preloads stay near byte 0.
        if (firstModuleMatch && firstModuleMatch.index >= minInsertIndex && firstModuleMatch.index <= headEnd) {
            const insertIndex = firstModuleMatch.index;
            return `${withoutExisting.slice(0, insertIndex)}${scriptTag}\n    ${withoutExisting.slice(insertIndex)}`;
        }

        return `${withoutExisting.slice(0, minInsertIndex)}\n    ${scriptTag}${withoutExisting.slice(minInsertIndex)}`;
    }

    if (firstModuleMatch) {
        return `${withoutExisting.slice(0, firstModuleMatch.index)}${scriptTag}${withoutExisting.slice(firstModuleMatch.index)}`;
    }

    return `${scriptTag}${withoutExisting}`;
}

function rewriteHtmlLegacyV1(html, manifest) {
    let rewritten = html;

    for (const source of V1_HTML_REPLACEMENT_PATHS) {
        const target = resolveFrontendAssetPath(source, manifest);
        if (!target) {
            continue;
        }

        const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        rewritten = rewritten.replace(new RegExp(`(["'])${escaped}(?:\\?v=[^"']*)?\\1`, 'g'), `$1${target}$1`);
    }

    return rewritten;
}

function rewriteHtmlWithImportMapV2(html, manifest) {
    const imports = manifest.importMap.imports;

    let rewritten = html.replace(/<link\b[^>]*>/gi, (tag) => {
        const href = getTagAttribute(tag, 'href');
        if (!href || isExternalAssetUrl(href)) {
            return tag;
        }

        const cleanPath = stripAssetQuery(href).replace(/^\/+/, '');
        if (!cleanPath || cleanPath === 'css/user.css') {
            return tag;
        }

        const relTokens = getTagAttribute(tag, 'rel').toLowerCase().split(/\s+/).filter(Boolean);

        if (relTokens.includes('modulepreload')) {
            const mapped = imports[`/${cleanPath}`];
            return mapped ? replaceTagAttribute(tag, 'href', mapped) : tag;
        }

        const ext = path.posix.extname(cleanPath).toLowerCase();
        if (!REWRITABLE_LINK_EXTENSIONS.has(ext)) {
            return tag;
        }

        const target = resolveFrontendAssetPath(cleanPath, manifest);
        if (!target) {
            return tag;
        }

        let updatedTag = replaceTagAttribute(tag, 'href', target);
        if (hasTagAttribute(updatedTag, 'data-sb-deferred-style') && !hasTagAttribute(updatedTag, 'data-sb-source-href')) {
            updatedTag = appendTagAttribute(updatedTag, `data-sb-source-href="${cleanPath}"`);
        }

        return updatedTag;
    });

    rewritten = rewritten.replace(/<script\b[^>]*>/gi, (tag) => {
        const src = getTagAttribute(tag, 'src');
        if (!src || isExternalAssetUrl(src)) {
            return tag;
        }

        const cleanPath = stripAssetQuery(src).replace(/^\/+/, '');
        if (!cleanPath) {
            return tag;
        }

        const scriptType = getTagAttribute(tag, 'type').trim().toLowerCase();
        if (scriptType === 'module') {
            const mapped = imports[`/${cleanPath}`];
            return mapped ? replaceTagAttribute(tag, 'src', mapped) : tag;
        }

        const target = resolveFrontendAssetPath(cleanPath, manifest);
        if (target && HASHED_FRONTEND_ASSET_RE.test(target)) {
            return replaceTagAttribute(tag, 'src', target);
        }

        return tag;
    });

    return injectSingleImportMap(rewritten, manifest.importMap);
}

function getManifestCacheKey(manifest) {
    if (typeof manifest.inputsHash === 'string' && manifest.inputsHash.length > 0) {
        return manifest.inputsHash;
    }

    return crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

export function rewriteFrontendHtml(html, { enabled = getFrontendAssetsEnabled() } = {}) {
    if (!enabled || isFrontendDevMode() || typeof html !== 'string') {
        return html;
    }

    const manifest = loadFrontendManifest();
    if (!manifest || !manifest.assets || typeof manifest.assets !== 'object') {
        return html;
    }

    const manifestKey = getManifestCacheKey(manifest);
    const rawHtmlHash = crypto.createHash('sha256').update(html).digest('hex');
    const cacheKey = `${manifestKey}:${rawHtmlHash}`;

    const cached = rewrittenHtmlCache.get(cacheKey);
    if (cached !== undefined) {
        htmlCacheHits += 1;
        return cached;
    }

    htmlCacheMisses += 1;
    const rewritten = hasValidImportMap(manifest)
        ? rewriteHtmlWithImportMapV2(html, manifest)
        : rewriteHtmlLegacyV1(html, manifest);

    if (rewrittenHtmlCache.size >= REWRITTEN_HTML_CACHE_MAX_ENTRIES) {
        const oldestKey = rewrittenHtmlCache.keys().next().value;
        if (oldestKey !== undefined) {
            rewrittenHtmlCache.delete(oldestKey);
        }
    }
    rewrittenHtmlCache.set(cacheKey, rewritten);

    return rewritten;
}

/**
 * Reads an HTML file and returns its RAM-cached rewritten contents, avoiding repeated disk reads and regex passes on GET /.
 * @param {string} filePath Absolute path to the HTML file
 * @param {object} [options]
 * @param {boolean} [options.enabled]
 * @returns {string}
 */
export function readRewrittenFrontendHtml(filePath, { enabled = getFrontendAssetsEnabled() } = {}) {
    const manifest = enabled && !isFrontendDevMode() ? loadFrontendManifest() : null;
    const manifestKey = manifest ? getManifestCacheKey(manifest) : 'raw';

    try {
        const stats = fs.statSync(filePath);
        const cached = fileHtmlCache.get(filePath);
        if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size && cached.manifestKey === manifestKey) {
            htmlCacheHits += 1;
            return cached.html;
        }

        const rawHtml = fs.readFileSync(filePath, 'utf8');
        const resultHtml = manifest ? rewriteFrontendHtml(rawHtml, { enabled: true }) : rawHtml;

        if (fileHtmlCache.size >= REWRITTEN_HTML_CACHE_MAX_ENTRIES) {
            const oldestKey = fileHtmlCache.keys().next().value;
            if (oldestKey !== undefined) {
                fileHtmlCache.delete(oldestKey);
            }
        }
        fileHtmlCache.set(filePath, {
            mtimeMs: stats.mtimeMs,
            size: stats.size,
            manifestKey,
            html: resultHtml,
        });

        return resultHtml;
    } catch (error) {
        console.warn(`Failed to read frontend HTML file at ${filePath}.`, error);
        return '';
    }
}

export function applyFrontendAssetHeaders(res, filePath) {
    const relativePath = path.relative(FRONTEND_DIST_ROOT, filePath).split(path.sep).join('/');

    if (HASHED_FRONTEND_ASSET_RE.test(relativePath)) {
        res.setHeader('Cache-Control', `public, max-age=${getFrontendImmutableMaxAge()}, immutable`);
        return;
    }

    res.setHeader('Cache-Control', 'no-cache');
}
