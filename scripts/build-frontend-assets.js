#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { minify } from 'terser';
import webpack from 'webpack';

import {
    FRONTEND_ASSET_PREFIX,
    FRONTEND_MANIFEST_FILE,
    FRONTEND_MANIFEST_VERSION,
    computeFrontendInputsHash,
    isExcludedFrontendPublicPath,
} from '../src/frontend-assets.js';
import getPublicLibConfig from '../webpack.config.js';

const defaultRepoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const HASHED_EXTENSIONS = new Set([
    '.css',
    '.js',
    '.mjs',
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
    '.mp3',
    '.wav',
    '.wasm',
]);

const CLASSIC_SCRIPT_PATHS = new Set([
    'sw.js',
    'scripts/sillybunny-restart-cache-clear.js',
    'scripts/sillybunny-splash.js',
    'scripts/sillybunny-splash-loop.js',
    'scripts/sillybunny-boot-guard.js',
    'scripts/extensions/sillybunny-debugger/lib/eruda.js',
    'scripts/extensions/gallery/jquery.nanogallery2.min.js',
]);

const PREMINIFIED_JS_PATHS = new Set([
    'lib.js',
    'scripts/extensions/tts/lib/kokoro.web.js',
    'scripts/extensions/sillybunny-debugger/lib/eruda.js',
]);

function toPosix(value) {
    return String(value).split(path.sep).join('/');
}

function compareLex(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

function getHash(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
}

function getOutputName(relativePath, hash) {
    const parsed = path.parse(relativePath);
    return path.join(parsed.dir, `${parsed.name}-${hash}${parsed.ext}`);
}

function isClassicScript(sourcePosix) {
    if (CLASSIC_SCRIPT_PATHS.has(sourcePosix)) {
        return true;
    }

    if (sourcePosix.startsWith('scripts/extensions/quick-reply/lib/') || sourcePosix.startsWith('scripts/extensions/tts/lib/')) {
        return true;
    }

    if (sourcePosix.startsWith('lib/')) {
        return !(
            sourcePosix.endsWith('.mjs')
            || sourcePosix === 'lib/dialog-polyfill.esm.js'
            || sourcePosix === 'lib/eventemitter.js'
            || sourcePosix === 'lib/swiped-events.js'
            || sourcePosix.startsWith('lib/structured-clone/')
        );
    }

    return false;
}

function shouldSkipJsMinification(sourcePosix) {
    if (PREMINIFIED_JS_PATHS.has(sourcePosix)) {
        return true;
    }

    return /\.min\.m?js$/i.test(sourcePosix);
}

/**
 * Strips CSS block comments while preserving quoted string literals verbatim.
 * @param {string} source Raw CSS text
 * @returns {string}
 */
function stripCssComments(source) {
    let result = '';
    let index = 0;
    const length = source.length;

    while (index < length) {
        const char = source[index];
        const next = source[index + 1];

        if (char === '/' && next === '*') {
            const closeIndex = source.indexOf('*/', index + 2);
            if (closeIndex === -1) {
                break;
            }
            index = closeIndex + 2;
            continue;
        }

        if (char === '"' || char === '\'') {
            const quote = char;
            result += char;
            index += 1;
            while (index < length) {
                const current = source[index];
                result += current;
                index += 1;
                if (current === '\\' && index < length) {
                    result += source[index];
                    index += 1;
                    continue;
                }
                if (current === quote) {
                    break;
                }
            }
            continue;
        }

        result += char;
        index += 1;
    }

    return result;
}

/**
 * Minifies CSS safely without corrupting strings, url(...) tokens, or calc(... + ... / - ...) whitespace.
 * @param {string} source Flattened CSS source
 * @returns {string}
 */
export function minifyCss(source) {
    const clean = stripCssComments(source);
    const preserved = [];

    const masked = clean.replace(/url\(\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^)]*)\s*\)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gi, (token) => {
        const placeholder = `__SB_CSS_TOKEN_${preserved.length}__`;
        preserved.push(token);
        return placeholder;
    });

    const compacted = masked
        .replace(/\s+/g, ' ')
        .replace(/:\s+(?=[;}])/g, '__SB_CSS_EMPTY_VAL__')
        .replace(/\s*([{};,>~])\s*/g, '$1')
        .replace(/:\s+/g, ':')
        .replace(/;}/g, '}')
        .replace(/__SB_CSS_EMPTY_VAL__/g, ': ')
        .trim();

    return compacted.replace(/__SB_CSS_TOKEN_(\d+)__/g, (_, index) => preserved[Number(index)]);
}

function splitUrlParts(rawUrl) {
    const hashIndex = rawUrl.indexOf('#');
    const beforeHash = hashIndex >= 0 ? rawUrl.slice(0, hashIndex) : rawUrl;
    const fragment = hashIndex >= 0 ? rawUrl.slice(hashIndex) : '';
    const queryIndex = beforeHash.indexOf('?');
    const cleanPath = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;
    const query = queryIndex >= 0 ? beforeHash.slice(queryIndex) : '';
    return { cleanPath, query, fragment };
}

function resolveCssTargetPath(currentCssPosix, rawTarget) {
    const trimmed = String(rawTarget).trim();
    if (!trimmed) {
        return null;
    }

    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#|%22|%27)/i.test(trimmed)) {
        return null;
    }

    const { cleanPath, query, fragment } = splitUrlParts(trimmed);
    if (!cleanPath) {
        return null;
    }

    let resolved;
    if (cleanPath.startsWith('/')) {
        resolved = path.posix.normalize(cleanPath).replace(/^\/+/, '');
    } else {
        const currentDir = path.posix.dirname(currentCssPosix);
        const joined = currentDir === '.' ? cleanPath : path.posix.join(currentDir, cleanPath);
        resolved = path.posix.normalize(joined).replace(/^\/+/, '');
    }

    if (!resolved || resolved.startsWith('..') || resolved.includes('/../')) {
        return null;
    }

    return {
        resolved,
        query,
        fragment,
        wasRootRelative: cleanPath.startsWith('/'),
    };
}

function rewriteCssUrls(cssText, currentCssPosix, assets) {
    return cssText.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)/gi, (match, doubleQuoted, singleQuoted, unquoted) => {
        const rawUrl = doubleQuoted ?? singleQuoted ?? unquoted ?? '';
        const parsed = resolveCssTargetPath(currentCssPosix, rawUrl);
        if (!parsed) {
            return match;
        }

        const { resolved, query, fragment, wasRootRelative } = parsed;
        if (resolved === 'css/user.css') {
            return 'url("/css/user.css")';
        }

        const builtEntry = assets?.[resolved];
        if (builtEntry && typeof builtEntry.output === 'string') {
            return `url("${FRONTEND_ASSET_PREFIX}${builtEntry.output}${fragment}")`;
        }

        if (!wasRootRelative) {
            return `url("/${resolved}${query}${fragment}")`;
        }

        return match;
    });
}

function rewriteFontDisplayBlock(cssText) {
    return cssText.replace(/font-display\s*:\s*block\b/gi, 'font-display: swap');
}

function parseImportStatement(statement) {
    const match = statement.match(
        /^@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)|"([^"]*)"|'([^']*)')\s*([\s\S]*?)\s*;$/i,
    );
    if (!match) {
        return null;
    }

    const targetUrl = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '';
    const mediaCondition = (match[6] ?? '').trim();
    return { targetUrl, mediaCondition };
}

/**
 * Recursively flattens local @import chains for a CSS file under public/, preserving @media conditions,
 * rewriting relative url(...) paths against each source file's directory, resolving hashed /frontend-assets/... URLs,
 * rewriting font-display: block -> swap, and strictly excluding /css/user.css.
 *
 * @param {string} cssPosixPath Relative POSIX path under public/ (e.g. 'style.css')
 * @param {object} options
 * @param {string} options.publicRoot Absolute path to public/
 * @param {Record<string, { output: string }>} [options.assets={}] Pass-1 built asset map
 * @param {Set<string>} [options.ancestors] Active recursion stack for cycle prevention
 * @param {string[]} [options.inlinedImports] Accumulator for inlined CSS paths
 * @param {boolean} [options.isRoot=true] Whether this is the top-level stylesheet
 * @returns {{ css: string, inlinedImports: string[] }}
 */
export function flattenCssFile(cssPosixPath, {
    publicRoot,
    assets = {},
    ancestors = new Set(),
    inlinedImports = [],
    hoistedImports = [],
    isRoot = true,
}) {
    const normalizedPath = toPosix(cssPosixPath).replace(/^\/+/, '');
    const fullPath = path.join(publicRoot, normalizedPath);
    const rawSource = fsSync.readFileSync(fullPath, 'utf8');
    let source = stripCssComments(rawSource);

    // Preserve a single @charset at the top of the root stylesheet only; strip from inlined children.
    let rootCharset = '';
    const charsetMatch = source.match(/^\s*(@charset\s+["'][^"']+["']\s*;)/i);
    if (charsetMatch) {
        if (isRoot) {
            rootCharset = charsetMatch[1];
        }
        source = source.slice(charsetMatch[0].length);
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(normalizedPath);

    const importRuleRe = /@import\s+(?:url\(\s*(?:"[^"]*"|'[^']*'|[^)\s]+)\s*\)|"[^"]*"|'[^']*')[^;]*;/gi;
    const chunks = [];
    let lastIndex = 0;

    for (const match of source.matchAll(importRuleRe)) {
        const segment = source.slice(lastIndex, match.index);
        if (segment) {
            chunks.push(rewriteCssUrls(segment, normalizedPath, assets));
        }
        lastIndex = match.index + match[0].length;

        const parsedImport = parseImportStatement(match[0]);
        if (!parsedImport) {
            chunks.push(match[0]);
            continue;
        }

        const resolvedTarget = resolveCssTargetPath(normalizedPath, parsedImport.targetUrl);
        if (!resolvedTarget || resolvedTarget.resolved === 'css/user.css') {
            hoistedImports.push(match[0]);
            continue;
        }

        const targetPosix = resolvedTarget.resolved;
        const targetFullPath = path.join(publicRoot, targetPosix);
        if (nextAncestors.has(targetPosix) || !fsSync.existsSync(targetFullPath) || !fsSync.statSync(targetFullPath).isFile()) {
            const mediaSuffix = parsedImport.mediaCondition ? ` ${parsedImport.mediaCondition}` : '';
            const preservedUrl = resolvedTarget.wasRootRelative
                ? parsedImport.targetUrl
                : `/${targetPosix}${resolvedTarget.query}${resolvedTarget.fragment}`;
            hoistedImports.push(`@import url("${preservedUrl}")${mediaSuffix};`);
            continue;
        }

        inlinedImports.push(targetPosix);
        const child = flattenCssFile(targetPosix, {
            publicRoot,
            assets,
            ancestors: nextAncestors,
            inlinedImports,
            hoistedImports,
            isRoot: false,
        });

        if (parsedImport.mediaCondition) {
            chunks.push(`@media ${parsedImport.mediaCondition} {\n${child.css}\n}`);
        } else {
            chunks.push(child.css);
        }
    }

    const trailing = source.slice(lastIndex);
    if (trailing) {
        chunks.push(rewriteCssUrls(trailing, normalizedPath, assets));
    }

    const body = chunks.join('\n');
    const combinedRaw = isRoot
        ? [rootCharset, ...hoistedImports, body].filter(Boolean).join('\n')
        : body;
    const combined = rewriteFontDisplayBlock(combinedRaw);
    return {
        css: combined,
        inlinedImports,
    };
}

function extractModuleSpecifiers(source) {
    const specifiers = [];
    const patterns = [
        /(?:^|[;\n])\s*(?:import|export)\s+(?:[^;'"()]*?\s+from\s*)?['"]([^'"]+)['"]/g,
        /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        /new\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
    ];

    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
            const specifier = match[1];
            if (specifier) {
                specifiers.push(specifier);
            }
        }
    }

    return specifiers;
}

/**
 * Collects all public/ .js/.mjs modules reachable from index.html module scripts, public/script.js,
 * and every module under public/scripts/** (excluding excluded/third-party paths).
 * @param {string} publicRoot
 * @param {string[]} builtJsFiles Relative POSIX paths of built .js/.mjs assets
 * @returns {string[]} Deterministically sorted relative POSIX paths
 */
export function collectImportMapModules(publicRoot, builtJsFiles) {
    const builtSet = new Set(builtJsFiles);
    const included = new Set();
    const queue = [];

    const enqueue = (relPosix) => {
        const normalized = toPosix(relPosix).replace(/^\/+/, '');
        if (!normalized || normalized === 'sw.js' || isExcludedFrontendPublicPath(normalized)) {
            return;
        }
        if (!builtSet.has(normalized) || included.has(normalized)) {
            return;
        }
        included.add(normalized);
        queue.push(normalized);
    };

    enqueue('lib.js');
    enqueue('script.js');

    for (const relPosix of builtJsFiles) {
        if (relPosix.startsWith('scripts/')) {
            enqueue(relPosix);
        }
    }

    const indexPath = path.join(publicRoot, 'index.html');
    if (fsSync.existsSync(indexPath)) {
        const indexHtml = fsSync.readFileSync(indexPath, 'utf8');
        const entryMatches = [
            ...indexHtml.matchAll(/<script\b[^>]*\btype\s*=\s*(?:"module"|'module')[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi),
            ...indexHtml.matchAll(/<script\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*\btype\s*=\s*(?:"module"|'module')[^>]*>/gi),
            ...indexHtml.matchAll(/<link\b[^>]*\brel\s*=\s*(?:"[^"]*\bmodulepreload\b[^"]*"|'[^']*\bmodulepreload\b[^']*')[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi),
            ...indexHtml.matchAll(/<link\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*\brel\s*=\s*(?:"[^"]*\bmodulepreload\b[^"]*"|'[^']*\bmodulepreload\b[^']*')[^>]*>/gi),
        ];
        for (const match of entryMatches) {
            const raw = match[1] ?? match[2] ?? '';
            const clean = splitUrlParts(raw).cleanPath.replace(/^\/+/, '');
            enqueue(clean);
        }
    }

    while (queue.length > 0) {
        const current = queue.shift();
        const fullPath = path.join(publicRoot, current);
        if (!fsSync.existsSync(fullPath)) {
            continue;
        }

        const source = fsSync.readFileSync(fullPath, 'utf8');
        const specifiers = extractModuleSpecifiers(source);
        const currentDir = path.posix.dirname(current);

        for (const specifier of specifiers) {
            if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
                continue;
            }
            const clean = splitUrlParts(specifier).cleanPath;
            if (!/\.(?:js|mjs)$/i.test(clean)) {
                continue;
            }
            const resolved = clean.startsWith('/')
                ? path.posix.normalize(clean).replace(/^\/+/, '')
                : path.posix.normalize(currentDir === '.' ? clean : path.posix.join(currentDir, clean)).replace(/^\/+/, '');
            if (!resolved.startsWith('..')) {
                enqueue(resolved);
            }
        }
    }

    return Array.from(included).sort(compareLex);
}

/**
 * Builds the deterministic v2 importMap containing both root `/...` mappings (for root imports and
 * unhashed third-party extensions) and `/frontend-assets/` scoped mappings (for hashed module relative imports
 * and `new URL(..., import.meta.url)` dynamic imports).
 * @param {string[]} modulePaths Sorted relative POSIX paths
 * @param {Record<string, { output: string }>} assets Built asset map
 * @returns {{ imports: Record<string, string>, scopes: Record<string, Record<string, string>> }}
 */
export function buildImportMap(modulePaths, assets) {
    const imports = {};
    const frontendAssetsScope = {};

    for (const relPosix of modulePaths) {
        const entry = assets[relPosix];
        if (!entry?.output) {
            continue;
        }

        const target = `${FRONTEND_ASSET_PREFIX}${entry.output}`;
        imports[`/${relPosix}`] = target;
        frontendAssetsScope[`${FRONTEND_ASSET_PREFIX}${relPosix}`] = target;
    }

    return {
        imports,
        scopes: {
            [FRONTEND_ASSET_PREFIX]: frontendAssetsScope,
        },
    };
}

function createTarHeader(entryName, size, typeflag = '0') {
    const header = Buffer.alloc(512, 0);
    const nameBytes = Buffer.from(entryName, 'utf8');
    let nameField = nameBytes;
    let prefixField = Buffer.alloc(0);

    if (nameBytes.length > 100) {
        let splitAt = -1;
        for (let i = 0; i < nameBytes.length; i++) {
            if (nameBytes[i] === 0x2f && i <= 155 && (nameBytes.length - i - 1) <= 100) {
                splitAt = i;
            }
        }

        if (splitAt > 0) {
            prefixField = nameBytes.subarray(0, splitAt);
            nameField = nameBytes.subarray(splitAt + 1);
        } else {
            throw new Error(`TAR entry path exceeds POSIX ustar limits: ${entryName}`);
        }
    }

    nameField.copy(header, 0, 0, Math.min(nameField.length, 100));
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header.write(typeflag, 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.write('0000000\0', 329, 8, 'ascii');
    header.write('0000000\0', 337, 8, 'ascii');
    if (prefixField.length > 0) {
        prefixField.copy(header, 345, 0, Math.min(prefixField.length, 155));
    }

    let checksum = 0;
    for (let i = 0; i < 512; i++) {
        checksum += header[i];
    }
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');

    return header;
}

function createPaxPathRecord(entryPath) {
    const body = ` path=${entryPath}\n`;
    let length = Buffer.byteLength(body, 'utf8') + 1;
    while (true) {
        const candidate = `${length}${body}`;
        const candidateBytes = Buffer.byteLength(candidate, 'utf8');
        if (candidateBytes === length) {
            return Buffer.from(candidate, 'utf8');
        }
        length = candidateBytes;
    }
}

function appendTarEntry(chunks, archivePath, dataBuffer) {
    const pathBytes = Buffer.byteLength(archivePath, 'utf8');
    let needsPax = pathBytes > 100;

    if (needsPax && pathBytes <= 255) {
        let splitAt = -1;
        const buf = Buffer.from(archivePath, 'utf8');
        for (let i = 0; i < buf.length; i++) {
            if (buf[i] === 0x2f && i <= 155 && (buf.length - i - 1) <= 100) {
                splitAt = i;
            }
        }
        if (splitAt > 0) {
            needsPax = false;
        }
    }

    if (needsPax) {
        const paxData = createPaxPathRecord(archivePath);
        const paxName = `PaxHeader/${path.posix.basename(archivePath).slice(0, 80)}`;
        chunks.push(createTarHeader(paxName, paxData.length, 'x'));
        chunks.push(paxData);
        const paxPad = (512 - (paxData.length % 512)) % 512;
        if (paxPad > 0) {
            chunks.push(Buffer.alloc(paxPad, 0));
        }

        const truncatedName = archivePath.slice(-100);
        chunks.push(createTarHeader(truncatedName, dataBuffer.length, '0'));
    } else {
        chunks.push(createTarHeader(archivePath, dataBuffer.length, '0'));
    }

    chunks.push(dataBuffer);
    const pad = (512 - (dataBuffer.length % 512)) % 512;
    if (pad > 0) {
        chunks.push(Buffer.alloc(pad, 0));
    }
}

async function walkDirectoryFiles(directory, baseDir, out = []) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            await walkDirectoryFiles(fullPath, baseDir, out);
        } else if (entry.isFile()) {
            out.push({
                fullPath,
                relPosix: toPosix(path.relative(baseDir, fullPath)),
            });
        }
    }
    return out;
}

/**
 * Creates a deterministic pure-Node POSIX ustar .tar.gz archive of a directory (zero external tar binary).
 * @param {string} sourceDir Directory to archive
 * @param {string} outputTarballPath Destination .tar.gz file path
 * @param {object} [options]
 * @param {string} [options.archivePrefix='dist/frontend'] Prefix applied inside the archive
 * @returns {Promise<{ bytes: number, fileCount: number }>}
 */
export async function createDeterministicTarGz(sourceDir, outputTarballPath, { archivePrefix = 'dist/frontend' } = {}) {
    const files = await walkDirectoryFiles(sourceDir, sourceDir);
    files.sort((a, b) => compareLex(a.relPosix, b.relPosix));

    const prefix = archivePrefix.replace(/^\/+|\/+$/g, '');
    const chunks = [];

    for (const file of files) {
        const archivePath = prefix ? `${prefix}/${file.relPosix}` : file.relPosix;
        const data = await fs.readFile(file.fullPath);
        appendTarEntry(chunks, archivePath, data);
    }

    // Two 512-byte zero blocks terminate a POSIX tar archive.
    chunks.push(Buffer.alloc(1024, 0));

    const tarBuffer = Buffer.concat(chunks);
    const gzBuffer = zlib.gzipSync(tarBuffer, { level: 9 });

    // Normalize gzip header MTIME (bytes 4..7 = 0) and OS byte (byte 9 = 3 / Unix) for cross-OS determinism.
    if (gzBuffer.length >= 10) {
        gzBuffer[4] = 0;
        gzBuffer[5] = 0;
        gzBuffer[6] = 0;
        gzBuffer[7] = 0;
        gzBuffer[9] = 3;
    }

    await fs.mkdir(path.dirname(outputTarballPath), { recursive: true });
    await fs.writeFile(outputTarballPath, gzBuffer);

    return {
        bytes: gzBuffer.length,
        fileCount: files.length,
    };
}

async function runWebpackCompiler(config) {
    const compiler = webpack(config);

    return new Promise((resolve, reject) => {
        compiler.run((error, stats) => {
            const output = stats?.toString(config.stats);
            if (output) {
                console.log(output);
            }

            compiler.close((closeError) => {
                const compileError = error ?? closeError;
                if (compileError) {
                    reject(compileError);
                    return;
                }

                if (stats?.hasErrors()) {
                    reject(new Error('Webpack failed to compile frontend libraries.'));
                    return;
                }

                resolve();
            });
        });
    });
}

async function buildPublicLibBundle() {
    const temporaryOutputPath = await fs.mkdtemp(path.join(os.tmpdir(), 'sillybunny-public-lib-'));
    const config = getPublicLibConfig({
        forceDist: true,
        outputPath: temporaryOutputPath,
    });

    try {
        await runWebpackCompiler(config);
        return await fs.readFile(path.join(temporaryOutputPath, 'lib.js'));
    } finally {
        await fs.rm(temporaryOutputPath, { recursive: true, force: true });
    }
}

async function optimizeJsAsset(inputPath, sourcePosix, ext, warnings, sourceBuffer = null) {
    const buffer = sourceBuffer ?? await fs.readFile(inputPath);

    if (shouldSkipJsMinification(sourcePosix)) {
        return buffer;
    }

    const source = buffer.toString('utf8');
    try {
        const result = await minify(source, {
            module: ext === '.mjs' || !isClassicScript(sourcePosix),
            compress: {
                passes: 1,
            },
            mangle: true,
            format: {
                comments: false,
            },
        });

        if (result.code) {
            return Buffer.from(result.code, 'utf8');
        }
    } catch (error) {
        warnings.push(`Skipped JS minification for ${sourcePosix}: ${error.message}`);
    }

    return buffer;
}

async function walkPublicAssets(directory, publicRoot, files = []) {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        const relPosix = toPosix(path.relative(publicRoot, fullPath));

        if (isExcludedFrontendPublicPath(relPosix)) {
            continue;
        }

        if (entry.isDirectory()) {
            await walkPublicAssets(fullPath, publicRoot, files);
        } else if (entry.isFile()) {
            files.push({
                inputPath: fullPath,
                relativePath: path.relative(publicRoot, fullPath),
                source: relPosix,
                ext: path.extname(relPosix).toLowerCase(),
            });
        }
    }

    return files;
}

function getBuildTimestamp() {
    if (process.env.SOURCE_DATE_EPOCH && /^\d+$/.test(process.env.SOURCE_DATE_EPOCH)) {
        return new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString();
    }

    return new Date().toISOString();
}

function parseCliArgs(argv) {
    let tarballPath = null;
    let distPath = null;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--tarball') {
            const next = argv[i + 1];
            if (!next || next.startsWith('--')) {
                throw new Error('--tarball requires an output file path.');
            }
            tarballPath = next;
            i += 1;
        } else if (arg.startsWith('--tarball=')) {
            tarballPath = arg.slice('--tarball='.length);
            if (!tarballPath) {
                throw new Error('--tarball requires a non-empty output file path.');
            }
        } else if (arg === '--dist') {
            const next = argv[i + 1];
            if (!next || next.startsWith('--')) {
                throw new Error('--dist requires an output directory path.');
            }
            distPath = next;
            i += 1;
        } else if (arg.startsWith('--dist=')) {
            distPath = arg.slice('--dist='.length);
            if (!distPath) {
                throw new Error('--dist requires a non-empty output directory path.');
            }
        }
    }

    return { tarballPath, distPath };
}

export async function buildFrontendAssets({
    repoRoot = defaultRepoRoot,
    publicRoot = path.join(repoRoot, 'public'),
    distRoot = path.join(repoRoot, 'dist', 'frontend'),
    tarballPath = null,
} = {}) {
    await fs.rm(distRoot, { recursive: true, force: true });
    await fs.mkdir(distRoot, { recursive: true });

    const inputsHash = computeFrontendInputsHash({ repoRoot, publicRoot });
    const files = await walkPublicAssets(publicRoot, publicRoot);
    files.sort((a, b) => compareLex(a.source, b.source));

    const assetSourceBuffers = new Map([
        ['lib.js', await buildPublicLibBundle()],
    ]);

    const assets = {};
    const cssBundles = {};
    const skipped = [];
    const warnings = [];
    const cssFiles = [];
    const builtJsFiles = [];

    // Pass 1: Build and hash all non-CSS assets first so CSS url(...) rewriting resolves hashed font/image URLs.
    for (const file of files) {
        const { inputPath, relativePath, source, ext } = file;

        if (ext === '.css') {
            cssFiles.push(file);
            continue;
        }

        if (HASHED_EXTENSIONS.has(ext)) {
            const sourceBuffer = assetSourceBuffers.get(source) ?? null;
            const buffer = (ext === '.js' || ext === '.mjs')
                ? await optimizeJsAsset(inputPath, source, ext, warnings, sourceBuffer)
                : (sourceBuffer ?? await fs.readFile(inputPath));
            const hash = getHash(buffer);
            const output = getOutputName(relativePath, hash);
            const outputPosix = toPosix(output);

            await fs.mkdir(path.dirname(path.join(distRoot, output)), { recursive: true });
            await fs.writeFile(path.join(distRoot, output), buffer);

            assets[source] = {
                hash,
                output: outputPosix,
                bytes: buffer.length,
            };

            if (ext === '.js' || ext === '.mjs') {
                builtJsFiles.push(source);
            }
            continue;
        }

        skipped.push(source);
    }

    // Pass 2: Recursively flatten @import chains, rewrite url(...) paths, rewrite font-display: block -> swap, and hash CSS.
    for (const file of cssFiles) {
        const { relativePath, source } = file;
        const flattened = flattenCssFile(source, { publicRoot, assets });
        const minified = minifyCss(flattened.css);
        const buffer = Buffer.from(minified, 'utf8');
        const hash = getHash(buffer);
        const output = getOutputName(relativePath, hash);
        const outputPosix = toPosix(output);

        await fs.mkdir(path.dirname(path.join(distRoot, output)), { recursive: true });
        await fs.writeFile(path.join(distRoot, output), buffer);

        assets[source] = {
            hash,
            output: outputPosix,
            bytes: buffer.length,
        };

        if (flattened.inlinedImports.length > 0) {
            cssBundles[source] = {
                hash,
                output: outputPosix,
                bytes: buffer.length,
                inlinedImports: flattened.inlinedImports,
            };
        }
    }

    const importMapModules = collectImportMapModules(publicRoot, builtJsFiles);
    const importMap = buildImportMap(importMapModules, assets);

    const sortedAssets = Object.fromEntries(
        Object.keys(assets).sort(compareLex).map(key => [key, assets[key]]),
    );

    const manifest = {
        version: FRONTEND_MANIFEST_VERSION,
        generatedAt: getBuildTimestamp(),
        publicRoot: 'public',
        inputsHash,
        importMap,
        cssBundles,
        assets: sortedAssets,
        skipped: skipped.sort(compareLex),
        warnings,
    };

    await fs.writeFile(path.join(distRoot, FRONTEND_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);

    let tarballInfo = null;
    if (tarballPath) {
        const resolvedTarballPath = path.resolve(repoRoot, tarballPath);
        tarballInfo = await createDeterministicTarGz(distRoot, resolvedTarballPath);
    }

    const hashedCount = Object.values(sortedAssets).filter(asset => asset.hash).length;
    console.log(
        `Built ${Object.keys(sortedAssets).length} frontend assets (${hashedCount} hashed, ${Object.keys(importMap.imports).length} importmap entries, ${Object.keys(cssBundles).length} flattened CSS bundles) in ${path.relative(repoRoot, distRoot)}`,
    );
    if (tarballInfo) {
        console.log(`Packaged ${tarballInfo.fileCount} files into ${tarballPath} (${(tarballInfo.bytes / 1024).toFixed(1)} KiB)`);
    }
    warnings.forEach(warning => console.warn(warning));

    return {
        manifest,
        tarballInfo,
    };
}

const isDirectExecution = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
    const { tarballPath, distPath } = parseCliArgs(process.argv.slice(2));
    buildFrontendAssets({
        distRoot: distPath ? path.resolve(defaultRepoRoot, distPath) : undefined,
        tarballPath,
    }).catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
