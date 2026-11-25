import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import zlib from 'node:zlib';

import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';

import {
    createDeterministicTarGz,
    flattenCssFile,
    minifyCss,
} from '../scripts/build-frontend-assets.js';
import {
    FRONTEND_ASSET_PREFIX,
    FRONTEND_MANIFEST_VERSION,
    clearFrontendManifestCache,
    computeFrontendInputsHash,
    getFrontendHtmlCacheStats,
    getFrontendManifestPath,
    isExcludedFrontendPublicPath,
    loadFrontendManifest,
    rewriteFrontendHtml,
} from '../src/frontend-assets.js';
import { shouldServeFrontendAssets } from '../src/middleware/frontend-assets.js';
import { setConfigFilePath } from '../src/util.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(repoRoot, 'public');
const indexHtmlPath = path.join(publicRoot, 'index.html');
const buildScriptPath = path.join(repoRoot, 'scripts', 'build-frontend-assets.js');
const releaseWorkflowPath = path.join(repoRoot, '.github', 'workflows', 'release.yml');
const webpackConfigPath = path.join(repoRoot, 'webpack.config.js');

const ORIGIN = 'http://127.0.0.1:8000';

/**
 * Spec-exact W3C / HTML Standard import map resolver (imports + scopes) for testing runtime module identity.
 * @param {string} specifier Raw import specifier
 * @param {string} referrerUrl Full referring module URL
 * @param {{ imports?: Record<string, string>, scopes?: Record<string, Record<string, string>> }} importMap Parsed import map
 * @returns {string} Resolved URL
 */
function resolveWithImportMap(specifier, referrerUrl, importMap) {
    const asUrl = new URL(specifier, referrerUrl).href;

    const normalizedScopes = Object.entries(importMap.scopes ?? {})
        .map(([scopePrefix, scopeMap]) => [new URL(scopePrefix, `${ORIGIN}/`).href, scopeMap])
        .sort((a, b) => b[0].length - a[0].length);

    for (const [scopePrefix, scopeMap] of normalizedScopes) {
        if (referrerUrl === scopePrefix || (scopePrefix.endsWith('/') && referrerUrl.startsWith(scopePrefix))) {
            for (const [rawKey, rawTarget] of Object.entries(scopeMap)) {
                const resolvedKey = new URL(rawKey, `${ORIGIN}/`).href;
                if (resolvedKey === asUrl) {
                    return new URL(rawTarget, `${ORIGIN}/`).href;
                }
            }
        }
    }

    for (const [rawKey, rawTarget] of Object.entries(importMap.imports ?? {})) {
        const resolvedKey = new URL(rawKey, `${ORIGIN}/`).href;
        if (resolvedKey === asUrl) {
            return new URL(rawTarget, `${ORIGIN}/`).href;
        }
    }

    return asUrl;
}

function collectPublicJsModules(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        const relPosix = path.relative(publicRoot, fullPath).split(path.sep).join('/');
        if (isExcludedFrontendPublicPath(relPosix)) {
            continue;
        }
        if (entry.isDirectory()) {
            collectPublicJsModules(fullPath, out);
        } else if (entry.isFile() && /\.(?:js|mjs)$/i.test(entry.name)) {
            out.push(relPosix);
        }
    }
    return out;
}

function collectStaticReachableModules(entryRelPaths) {
    const visited = new Set();
    const queue = [...entryRelPaths];

    while (queue.length > 0) {
        const current = queue.shift();
        if (!current || visited.has(current)) {
            continue;
        }
        const fullPath = path.join(publicRoot, current);
        if (!fs.existsSync(fullPath)) {
            continue;
        }
        visited.add(current);
        const source = fs.readFileSync(fullPath, 'utf8');
        const re = /(?:(?:^|[;\n])\s*(?:import|export)\s+(?:[^;'"()]*?\s+from\s*)?|\bimport\s*\(\s*|new\s+URL\(\s*)['"]([^'"]+)['"]/g;
        const currentDir = path.posix.dirname(current);
        for (const match of source.matchAll(re)) {
            const spec = match[1];
            if (!spec || (!spec.startsWith('.') && !spec.startsWith('/'))) {
                continue;
            }
            const clean = spec.split(/[?#]/)[0];
            if (!/\.(?:js|mjs)$/i.test(clean)) {
                continue;
            }
            const resolved = clean.startsWith('/')
                ? path.posix.normalize(clean).replace(/^\/+/, '')
                : path.posix.normalize(currentDir === '.' ? clean : path.posix.join(currentDir, clean)).replace(/^\/+/, '');
            if (!resolved.startsWith('..') && !isExcludedFrontendPublicPath(resolved) && resolved !== 'sw.js') {
                queue.push(resolved);
            }
        }
    }

    return visited;
}

function parseTarEntryNames(tarBuffer) {
    const entries = [];
    let offset = 0;
    let pendingPaxPath = null;

    while (offset + 512 <= tarBuffer.length) {
        const header = tarBuffer.subarray(offset, offset + 512);
        if (header.every(byte => byte === 0)) {
            break;
        }

        const magic = header.subarray(257, 262).toString('ascii');
        expect(magic).toBe('ustar');

        const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
        const rawPrefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
        const typeflag = header.subarray(156, 157).toString('ascii');
        const sizeOctal = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
        const size = parseInt(sizeOctal || '0', 8);

        const dataStart = offset + 512;
        const data = tarBuffer.subarray(dataStart, dataStart + size);

        if (typeflag === 'x') {
            const paxText = data.toString('utf8');
            const pathMatch = paxText.match(/ path=([^\n]+)\n/);
            pendingPaxPath = pathMatch ? pathMatch[1] : null;
        } else {
            const fullName = pendingPaxPath ?? (rawPrefix ? `${rawPrefix}/${rawName}` : rawName);
            pendingPaxPath = null;
            entries.push({ name: fullName, size });
        }

        const paddedSize = Math.ceil(size / 512) * 512;
        offset = dataStart + paddedSize;
    }

    return entries;
}

describe('PR 13: extension-safe ESM importmap, flattened CSS, and slim lib.js', () => {
    let tmpWorkDir;
    let tmpDistDir;
    let tmpTarballPath;
    let manifest;

    const manifestPath = getFrontendManifestPath();
    const manifestDir = path.dirname(manifestPath);
    const distParentDir = path.dirname(manifestDir);
    let previousManifestContent = null;
    let hadManifestDirBeforeTest = false;
    let hadDistParentBeforeTest = false;
    let previousSbDev;

    beforeAll(() => {
        tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-pr13-test-'));
        tmpDistDir = path.join(tmpWorkDir, 'dist', 'frontend');
        tmpTarballPath = path.join(tmpWorkDir, 'sillybunny-frontend-assets.tar.gz');

        const tmpConfigPath = path.join(tmpWorkDir, 'config.yaml');
        fs.writeFileSync(tmpConfigPath, 'performance:\n  frontendBuild:\n    enabled: true\n    immutableMaxAge: 31536000\n', 'utf8');
        setConfigFilePath(tmpConfigPath);

        // Run the real CLI builder in a child process so Webpack/Terser memory does not linger in Jest --runInBand.
        execFileSync(process.execPath, [buildScriptPath, '--dist', tmpDistDir, '--tarball', tmpTarballPath], {
            cwd: repoRoot,
            stdio: 'pipe',
        });
        manifest = JSON.parse(fs.readFileSync(path.join(tmpDistDir, 'asset-manifest.json'), 'utf8'));
    }, 120000);

    afterAll(() => {
        setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));
        if (tmpWorkDir && fs.existsSync(tmpWorkDir)) {
            fs.rmSync(tmpWorkDir, { recursive: true, force: true });
        }
    });

    afterEach(() => {
        if (previousSbDev === undefined) {
            delete process.env.SB_DEV;
        } else {
            process.env.SB_DEV = previousSbDev;
        }
        previousSbDev = undefined;

        if (previousManifestContent === null) {
            fs.rmSync(manifestPath, { force: true });
            if (!hadManifestDirBeforeTest && fs.existsSync(manifestDir) && fs.readdirSync(manifestDir).length === 0) {
                fs.rmdirSync(manifestDir);
            }
            if (!hadDistParentBeforeTest && fs.existsSync(distParentDir) && fs.readdirSync(distParentDir).length === 0) {
                fs.rmdirSync(distParentDir);
            }
        } else {
            fs.mkdirSync(manifestDir, { recursive: true });
            fs.writeFileSync(manifestPath, previousManifestContent, 'utf8');
        }
        previousManifestContent = null;
        hadManifestDirBeforeTest = false;
        hadDistParentBeforeTest = false;
        clearFrontendManifestCache();
    });

    function installManifestForServerTest(customManifest) {
        previousSbDev = process.env.SB_DEV;
        delete process.env.SB_DEV;
        hadDistParentBeforeTest = fs.existsSync(distParentDir);
        hadManifestDirBeforeTest = fs.existsSync(manifestDir);
        previousManifestContent = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : null;
        fs.mkdirSync(manifestDir, { recursive: true });
        fs.writeFileSync(manifestPath, JSON.stringify(customManifest), 'utf8');
        clearFrontendManifestCache();
    }

    test('(a) importmap covers 100% of /lib.js, /script.js, public/scripts/**, and every reachable module', () => {
        expect(manifest.version).toBe(FRONTEND_MANIFEST_VERSION);
        expect(typeof manifest.inputsHash).toBe('string');
        expect(manifest.inputsHash).toHaveLength(64);
        expect(manifest.inputsHash).toBe(computeFrontendInputsHash({ repoRoot, publicRoot }));

        const imports = manifest.importMap?.imports ?? {};
        const scoped = manifest.importMap?.scopes?.[FRONTEND_ASSET_PREFIX] ?? {};

        expect(imports['/lib.js']).toMatch(/^\/frontend-assets\/lib-[a-f0-9]{12}\.js$/);
        expect(imports['/script.js']).toMatch(/^\/frontend-assets\/script-[a-f0-9]{12}\.js$/);
        expect(imports['/sw.js']).toBeUndefined();

        const allScriptsModules = collectPublicJsModules(path.join(publicRoot, 'scripts'));
        const reachableFromScript = collectStaticReachableModules(['script.js', ...allScriptsModules]);
        const expectedModules = new Set(['lib.js', 'script.js', ...allScriptsModules, ...reachableFromScript]);

        const missingFromImports = [];
        const missingFromScope = [];
        const missingOnDisk = [];

        for (const relPosix of expectedModules) {
            const importTarget = imports[`/${relPosix}`];
            const scopeTarget = scoped[`${FRONTEND_ASSET_PREFIX}${relPosix}`];
            if (!importTarget) {
                missingFromImports.push(relPosix);
                continue;
            }
            if (scopeTarget !== importTarget) {
                missingFromScope.push(relPosix);
            }
            const outputRel = importTarget.slice(FRONTEND_ASSET_PREFIX.length);
            if (!fs.existsSync(path.join(tmpDistDir, outputRel))) {
                missingOnDisk.push(outputRel);
            }
        }

        expect(missingFromImports).toEqual([]);
        expect(missingFromScope).toEqual([]);
        expect(missingOnDisk).toEqual([]);
        expect(Object.keys(imports).length).toBeGreaterThan(600);
    });

    test('(b) rewriteFrontendHtml injects strictly ONE <script type="importmap"> before the first modulepreload/module and caches in RAM', () => {
        installManifestForServerTest(manifest);

        const rawHtml = fs.readFileSync(indexHtmlPath, 'utf8');
        const rewritten = rewriteFrontendHtml(rawHtml, { enabled: true });

        const importMapTags = [...rewritten.matchAll(/<script\b[^>]*\btype="importmap"[^>]*>([\s\S]*?)<\/script>/gi)];
        expect(importMapTags).toHaveLength(1);

        const parsedImportMap = JSON.parse(importMapTags[0][1]);
        expect(parsedImportMap.imports['/script.js']).toBe(manifest.importMap.imports['/script.js']);
        expect(parsedImportMap.imports['/lib.js']).toBe(manifest.importMap.imports['/lib.js']);

        const headOpenIndex = rewritten.search(/<head\b[^>]*>/i);
        const baseTagIndex = rewritten.search(/<base\b[^>]*>/i);
        const metaCharsetMatch = /<meta\b[^>]*\bcharset\s*=\s*["']utf-8["'][^>]*>/i.exec(rewritten);
        const criticalStyleIndex = rewritten.search(/<style\b[^>]*>/i);
        const stylePreloadIndex = rewritten.search(/<link\b[^>]*\brel="preload"[^>]*\bas="style"[^>]*>/i);
        const importMapIndex = rewritten.search(/<script\b[^>]*\btype="importmap"[^>]*>/i);
        const firstModulePreloadIndex = rewritten.search(/<link\b[^>]*\brel="modulepreload"[^>]*>/i);
        const firstModuleScriptIndex = rewritten.search(/<script\b[^>]*\btype="module"[^>]*>/i);

        expect(metaCharsetMatch).not.toBeNull();
        const metaCharsetEndBytes = Buffer.byteLength(
            rewritten.slice(0, metaCharsetMatch.index + metaCharsetMatch[0].length),
            'utf8',
        );
        // HTML5 charset prescan requires <meta charset="utf-8"> to finish within the first 1,024 bytes.
        expect(metaCharsetEndBytes).toBeLessThan(1024);

        expect(importMapIndex).toBeGreaterThan(headOpenIndex);
        expect(importMapIndex).toBeGreaterThan(baseTagIndex);
        expect(importMapIndex).toBeGreaterThan(metaCharsetMatch.index);
        expect(importMapIndex).toBeGreaterThan(criticalStyleIndex);
        expect(importMapIndex).toBeGreaterThan(stylePreloadIndex);
        expect(importMapIndex).toBeLessThan(firstModulePreloadIndex);
        expect(importMapIndex).toBeLessThan(firstModuleScriptIndex);

        expect(rewritten).toContain(`<link rel="modulepreload" href="${manifest.importMap.imports['/script.js']}">`);
        expect(rewritten).toContain(`<script type="module" src="${manifest.importMap.imports['/script.js']}"></script>`);
        expect(rewritten).toContain(`href="${FRONTEND_ASSET_PREFIX}${manifest.assets['style.css'].output}"`);
        expect(rewritten).toContain(`href="${FRONTEND_ASSET_PREFIX}${manifest.assets['css/solid.min.css'].output}"`);
        expect(rewritten).toContain('href="css/user.css"');
        expect(rewritten).not.toContain('/frontend-assets/css/user');

        // Attribute rewriting must not interpolate $ replacement patterns or choke on nested quotes.
        const specialManifest = {
            ...manifest,
            assets: {
                ...manifest.assets,
                'style.css': { output: 'style-$&$1-abcdef123456.css' },
            },
        };
        installManifestForServerTest(specialManifest);
        const specialHtml = '<head><base href="/"><meta charset="utf-8"><link rel="stylesheet" href="style.css?v=a\'b"></head>';
        const rewrittenSpecial = rewriteFrontendHtml(specialHtml, { enabled: true });
        expect(rewrittenSpecial).toContain('href="/frontend-assets/style-$&$1-abcdef123456.css"');

        // Reinstall the standard manifest to check RAM cache hits on index.html.
        installManifestForServerTest(manifest);
        const cachedFirst = rewriteFrontendHtml(rawHtml, { enabled: true });
        const statsBefore = getFrontendHtmlCacheStats();
        const rewrittenAgain = rewriteFrontendHtml(rawHtml, { enabled: true });
        const statsAfter = getFrontendHtmlCacheStats();

        expect(cachedFirst).toBe(rewritten);
        expect(rewrittenAgain).toBe(rewritten);
        expect(statsAfter.hits).toBe(statsBefore.hits + 1);
        expect(statsAfter.misses).toBe(statsBefore.misses);
    });

    test('(c) live ESM singleton identity holds when a mock 3rd-party extension imports ../../../../script.js and ../../../extensions.js', async () => {
        const scriptHashedUrl = new URL(manifest.importMap.imports['/script.js'], `${ORIGIN}/`).href;
        const extensionsHashedUrl = new URL(manifest.importMap.imports['/scripts/extensions.js'], `${ORIGIN}/`).href;
        const tabsHashedUrl = new URL(manifest.importMap.imports['/scripts/sillybunny-tabs.js'], `${ORIGIN}/`).href;
        const serverToolsHashedUrl = new URL(manifest.importMap.imports['/scripts/sillybunny-server-tools.js'], `${ORIGIN}/`).href;
        const thirdPartyExtUrl = `${ORIGIN}/scripts/extensions/third-party/mock-ext/index.js`;

        // Verify exact spec URL resolution for core modules, import.meta.url deferred loads, and 3rd-party extensions.
        expect(resolveWithImportMap('../../../../script.js', thirdPartyExtUrl, manifest.importMap)).toBe(scriptHashedUrl);
        expect(resolveWithImportMap('../../../extensions.js', thirdPartyExtUrl, manifest.importMap)).toBe(extensionsHashedUrl);
        expect(resolveWithImportMap('../script.js', extensionsHashedUrl, manifest.importMap)).toBe(scriptHashedUrl);
        expect(resolveWithImportMap('../script.js', tabsHashedUrl, manifest.importMap)).toBe(scriptHashedUrl);
        expect(resolveWithImportMap(new URL('./sillybunny-server-tools.js', tabsHashedUrl).href, tabsHashedUrl, manifest.importMap)).toBe(serverToolsHashedUrl);

        // Execute real ES modules in vm.SourceTextModule linked strictly via manifest.importMap.
        const evalCounts = new Map();
        const context = vm.createContext({
            recordEval: (id) => evalCounts.set(id, (evalCounts.get(id) ?? 0) + 1),
        });

        const virtualSources = new Map([
            [scriptHashedUrl, `
                recordEval('script.js');
                export let chat = ['boot'];
                export let this_chid = 0;
                export function pushMessage(msg) { chat.push(msg); }
                export function setCharacter(id) { this_chid = id; }
            `],
            [extensionsHashedUrl, `
                recordEval('extensions.js');
                import { chat, setCharacter } from '../script.js';
                export const extension_settings = { loadedByCore: true };
                export function getCoreChat() { return chat; }
                export function selectCoreChar(id) { setCharacter(id); }
            `],
            [thirdPartyExtUrl, `
                recordEval('mock-ext');
                import { chat, this_chid, pushMessage } from '../../../../script.js';
                import { extension_settings, getCoreChat, selectCoreChar } from '../../../extensions.js';
                pushMessage('from-3p-ext');
                extension_settings.fromThirdParty = true;
                selectCoreChar(7);
                export const observed = {
                    chatRef: chat,
                    coreChatRef: getCoreChat(),
                    liveChid: () => this_chid,
                    settingsRef: extension_settings,
                };
            `],
        ]);

        const moduleRegistry = new Map();
        async function loadModule(url) {
            if (moduleRegistry.has(url)) {
                return moduleRegistry.get(url);
            }
            const source = virtualSources.get(url);
            if (!source) {
                throw new Error(`Unexpected unmapped module URL: ${url}`);
            }
            const mod = new vm.SourceTextModule(source, { identifier: url, context });
            moduleRegistry.set(url, mod);
            await mod.link(async (specifier, referencingModule) => {
                const resolved = resolveWithImportMap(specifier, referencingModule.identifier, manifest.importMap);
                return loadModule(resolved);
            });
            await mod.evaluate();
            return mod;
        }

        const coreScript = await loadModule(scriptHashedUrl);
        const coreExtensions = await loadModule(extensionsHashedUrl);
        const thirdPartyExt = await loadModule(thirdPartyExtUrl);

        expect(evalCounts.get('script.js')).toBe(1);
        expect(evalCounts.get('extensions.js')).toBe(1);
        expect(evalCounts.get('mock-ext')).toBe(1);

        expect(thirdPartyExt.namespace.observed.chatRef).toBe(coreScript.namespace.chat);
        expect(thirdPartyExt.namespace.observed.coreChatRef).toBe(coreScript.namespace.chat);
        expect(thirdPartyExt.namespace.observed.settingsRef).toBe(coreExtensions.namespace.extension_settings);
        expect(coreScript.namespace.chat).toEqual(['boot', 'from-3p-ext']);
        expect(coreExtensions.namespace.extension_settings.fromThirdParty).toBe(true);
        expect(thirdPartyExt.namespace.observed.liveChid()).toBe(7);
        expect(coreScript.namespace.this_chid).toBe(7);
    });

    test('(d) falls back to raw public/ on inputsHash mismatch or SB_DEV=1', () => {
        const sampleHtml = fs.readFileSync(indexHtmlPath, 'utf8');

        // 1. Stale inputsHash mismatch must reject manifest and return raw HTML untouched.
        installManifestForServerTest({
            ...manifest,
            inputsHash: '0'.repeat(64),
        });

        expect(loadFrontendManifest()).toBeNull();
        expect(shouldServeFrontendAssets()).toBe(false);
        expect(rewriteFrontendHtml(sampleHtml, { enabled: true })).toBe(sampleHtml);

        // 2. Fresh manifest enables frontend serving; SB_DEV=1 overrides it back to raw public/.
        installManifestForServerTest(manifest);
        expect(loadFrontendManifest()).not.toBeNull();
        expect(shouldServeFrontendAssets()).toBe(true);

        process.env.SB_DEV = '1';
        expect(shouldServeFrontendAssets()).toBe(false);
        expect(rewriteFrontendHtml(sampleHtml, { enabled: true })).toBe(sampleHtml);

        // 3. computeFrontendInputsHash ignores .DS_Store/Thumbs.db, normalizes CRLF across tracked text files,
        // and invalidates when package.json or scripts/build-frontend-assets.js changes.
        const hashFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-hash-fixture-'));
        try {
            const fixturePublic = path.join(hashFixture, 'public');
            fs.mkdirSync(path.join(fixturePublic, 'nested'), { recursive: true });
            fs.mkdirSync(path.join(hashFixture, 'scripts'), { recursive: true });
            fs.writeFileSync(path.join(hashFixture, 'webpack.config.js'), 'export default {};\n', 'utf8');
            fs.writeFileSync(path.join(hashFixture, 'package.json'), '{"version":"1.0.0"}\n', 'utf8');
            fs.writeFileSync(path.join(hashFixture, 'scripts', 'build-frontend-assets.js'), '// builder v1\n', 'utf8');
            fs.writeFileSync(path.join(fixturePublic, 'global.d.ts'), 'declare const x: number;\n', 'utf8');
            fs.writeFileSync(path.join(fixturePublic, 'style.less'), '.a { color: red; }\n', 'utf8');
            fs.writeFileSync(path.join(fixturePublic, 'fix.patch'), '--- a\n+++ b\n', 'utf8');
            fs.writeFileSync(path.join(fixturePublic, 'tool.LICENSE'), 'MIT\n', 'utf8');
            fs.writeFileSync(path.join(fixturePublic, 'nested', 'LICENSE'), 'Apache-2.0\n', 'utf8');

            const lfHash = computeFrontendInputsHash({ repoRoot: hashFixture, publicRoot: fixturePublic });

            // Adding OS junk files must not change inputsHash.
            fs.writeFileSync(path.join(fixturePublic, '.DS_Store'), 'junk', 'utf8');
            fs.writeFileSync(path.join(fixturePublic, 'nested', 'Thumbs.db'), 'junk', 'utf8');
            expect(computeFrontendInputsHash({ repoRoot: hashFixture, publicRoot: fixturePublic })).toBe(lfHash);

            // Converting tracked text files (.ts, .less, .patch, .license, LICENSE) to CRLF must keep the same hash.
            fs.writeFileSync(path.join(fixturePublic, 'global.d.ts'), 'declare const x: number;\r\n', 'utf8');
            fs.writeFileSync(path.join(fixturePublic, 'style.less'), '.a { color: red; }\r\n', 'utf8');
            fs.writeFileSync(path.join(fixturePublic, 'fix.patch'), '--- a\r\n+++ b\r\n', 'utf8');
            fs.writeFileSync(path.join(fixturePublic, 'tool.LICENSE'), 'MIT\r\n', 'utf8');
            fs.writeFileSync(path.join(fixturePublic, 'nested', 'LICENSE'), 'Apache-2.0\r\n', 'utf8');
            expect(computeFrontendInputsHash({ repoRoot: hashFixture, publicRoot: fixturePublic })).toBe(lfHash);

            // Editing package.json or scripts/build-frontend-assets.js must invalidate inputsHash.
            fs.writeFileSync(path.join(hashFixture, 'package.json'), '{"version":"1.0.1"}\n', 'utf8');
            const afterPkgHash = computeFrontendInputsHash({ repoRoot: hashFixture, publicRoot: fixturePublic });
            expect(afterPkgHash).not.toBe(lfHash);

            fs.writeFileSync(path.join(hashFixture, 'scripts', 'build-frontend-assets.js'), '// builder v2\n', 'utf8');
            const afterBuilderHash = computeFrontendInputsHash({ repoRoot: hashFixture, publicRoot: fixturePublic });
            expect(afterBuilderHash).not.toBe(afterPkgHash);
        } finally {
            fs.rmSync(hashFixture, { recursive: true, force: true });
        }
    });

    test('(e) flattened style.css has 0 local @imports, valid rewritten url(...)s, font-display: swap in bundled CSS, preserves @media & calc(), and excludes /css/user.css', () => {
        const styleBundle = manifest.cssBundles['style.css'];
        expect(styleBundle).toBeDefined();
        expect(styleBundle.inlinedImports.length).toBeGreaterThanOrEqual(19);
        expect(styleBundle.inlinedImports).toContain('css/popup.css');
        expect(styleBundle.inlinedImports).toContain('lib/dialog-polyfill.css');
        expect(styleBundle.inlinedImports).toContain('css/popup-safari-fix.css');
        expect(styleBundle.inlinedImports).not.toContain('css/user.css');

        const flattenedStyleCss = fs.readFileSync(path.join(tmpDistDir, styleBundle.output), 'utf8');
        expect(flattenedStyleCss).not.toMatch(/@import\b/i);
        expect(flattenedStyleCss).not.toContain('user.css');
        expect(flattenedStyleCss).toContain('.poly_dialog');
        expect(flattenedStyleCss).toContain('calc(var(--topBarIconSize) + var(--topBarBlockPadding))');

        const urlMatches = [...flattenedStyleCss.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)/gi)]
            .map(match => match[1] ?? match[2] ?? match[3] ?? '');
        expect(urlMatches.length).toBeGreaterThan(0);

        for (const url of urlMatches) {
            if (url.startsWith('data:') || /^https?:/i.test(url)) {
                continue;
            }
            expect(url.startsWith(FRONTEND_ASSET_PREFIX)).toBe(true);
            const distFile = path.join(tmpDistDir, url.slice(FRONTEND_ASSET_PREFIX.length).split('#')[0]);
            expect(fs.existsSync(distFile)).toBe(true);
        }

        // Bundled icon font sheets must rewrite font-display: block -> swap and reference hashed woff2 assets.
        for (const iconSheet of ['css/solid.min.css', 'css/brands.min.css']) {
            const builtCss = fs.readFileSync(path.join(tmpDistDir, manifest.assets[iconSheet].output), 'utf8');
            expect(builtCss).not.toMatch(/font-display\s*:\s*block\b/i);
            expect(builtCss).toMatch(/font-display\s*:\s*swap\b/i);
            expect(builtCss).toContain(`${FRONTEND_ASSET_PREFIX}webfonts/`);
        }

        // minifyCss must never strip descendant-combinator whitespace before : / :: or corrupt space-only custom props.
        expect(minifyCss('.last_swipe :is(.swipes-counter, .swipe_right) { display: none; }'))
            .toBe('.last_swipe :is(.swipes-counter,.swipe_right){display:none}');
        expect(minifyCss('.mes_text :where(p, li) { color: red; }'))
            .toBe('.mes_text :where(p,li){color:red}');
        expect(minifyCss('.foo ::before { content: ""; }'))
            .toBe('.foo ::before{content:""}');
        expect(minifyCss(':root { --x: ; --y: 1px; }'))
            .toBe(':root{--x: ;--y:1px}');

        // Verify 0 corrupted descendant pseudo-selectors across every built CSS asset in dist/frontend/.
        expect(flattenedStyleCss).toContain('.last_swipe :is(.swipes-counter,.swipe_right)');
        expect(flattenedStyleCss).toContain('.mes_text :where(p,li,blockquote,q,span)');
        const descendantPseudoRe = /([a-zA-Z0-9_\])*])\s+(::?(?:is|where|not|has|hover|focus|focus-visible|focus-within|active|checked|disabled|enabled|first-child|last-child|nth-child|nth-of-type|empty|root|before|after|placeholder|selection|backdrop|scope|-webkit-|-moz-))/gi;
        const corruptedCssFiles = [];
        for (const [sourcePath, entry] of Object.entries(manifest.assets)) {
            if (!sourcePath.endsWith('.css')) {
                continue;
            }
            const rawFlattened = flattenCssFile(sourcePath, { publicRoot, assets: manifest.assets }).css;
            const builtCss = fs.readFileSync(path.join(tmpDistDir, entry.output), 'utf8');
            const sourceCount = [...rawFlattened.matchAll(descendantPseudoRe)].length;
            const builtCount = [...builtCss.matchAll(descendantPseudoRe)].length;
            if (builtCount < sourceCount) {
                corruptedCssFiles.push(`${sourcePath} (expected >=${sourceCount}, got ${builtCount})`);
            }
        }
        expect(corruptedCssFiles).toEqual([]);

        // Synthetic @charset + @media + nested relative url() + hoisted /css/user.css exclusion check.
        const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-css-fixture-'));
        try {
            fs.mkdirSync(path.join(fixtureRoot, 'nested'), { recursive: true });
            fs.writeFileSync(path.join(fixtureRoot, 'nested', 'mobile.css'), '.m :is(.a, .b) { background: url("../img/pic.png"); font-display: block; }\n', 'utf8');
            fs.writeFileSync(
                path.join(fixtureRoot, 'entry.css'),
                '@charset "UTF-8";\n@import url("./nested/mobile.css") screen and (max-width: 768px);\n@import url("/css/user.css");\n.x { width: calc(10px + 20px); }\n',
                'utf8',
            );

            const flattened = flattenCssFile('entry.css', {
                publicRoot: fixtureRoot,
                assets: { 'img/pic.png': { output: 'img/pic-abcdef123456.png' } },
            });
            const minified = minifyCss(flattened.css);

            expect(flattened.inlinedImports).toEqual(['nested/mobile.css']);
            expect(minified).toContain('@media screen and (max-width:768px){.m :is(.a,.b){background:url("/frontend-assets/img/pic-abcdef123456.png");font-display:swap}}');
            expect(minified).toContain('@import url("/css/user.css");');
            // Un-inlined @import must be hoisted after @charset and BEFORE any @media or style rules to remain valid CSS.
            const charsetIdx = minified.indexOf('@charset "UTF-8";');
            const userImportIdx = minified.indexOf('@import url("/css/user.css");');
            const mediaIdx = minified.indexOf('@media screen');
            expect(charsetIdx).toBe(0);
            expect(userImportIdx).toBeGreaterThan(charsetIdx);
            expect(userImportIdx).toBeLessThan(mediaIdx);
            expect(minified).toContain('calc(10px + 20px)');
        } finally {
            fs.rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    test('(f) slim lib.js reduces bundle size, registers core hljs languages/aliases with safe unknown fallback, and preserves all exports & shims', async () => {
        const libEntry = manifest.assets['lib.js'];
        expect(libEntry).toBeDefined();
        // Baseline Node lib.js was ~2060 KiB (2.01 MiB); slim build must drop by >45%.
        expect(libEntry.bytes).toBeLessThan(1100 * 1024);

        const webpackSource = fs.readFileSync(webpackConfigPath, 'utf8');
        expect(webpackSource).toContain('ContextReplacementPlugin');
        expect(webpackSource).not.toContain('IgnorePlugin');
        expect(webpackSource).not.toContain('terser-webpack-plugin');
        expect(webpackSource).not.toContain('chevrotain-esm-alias-v1');

        const builtLibPath = path.join(tmpDistDir, libEntry.output);
        const builtLibSource = fs.readFileSync(builtLibPath, 'utf8');

        const mockWindow = {
            document: {
                createElement: () => ({ href: '', setAttribute() {}, appendChild() {} }),
                getElementsByTagName: () => [null],
                documentElement: {},
            },
            navigator: { userAgent: 'Mozilla/5.0' },
            location: { href: `${ORIGIN}/`, origin: ORIGIN, protocol: 'http:' },
            console,
            setTimeout,
            clearTimeout,
            TextEncoder,
            TextDecoder,
            URL,
            URLSearchParams,
        };
        mockWindow.window = mockWindow;
        mockWindow.self = mockWindow;
        mockWindow.globalThis = mockWindow;

        const libContext = vm.createContext(mockWindow);
        const libVmModule = new vm.SourceTextModule(builtLibSource, {
            identifier: `${ORIGIN}${FRONTEND_ASSET_PREFIX}${libEntry.output}`,
            context: libContext,
        });
        await libVmModule.link(() => {
            throw new Error('Compiled lib.js must be self-contained with zero external module imports.');
        });
        await libVmModule.evaluate();
        const libModule = libVmModule.namespace;

        const nonNamespaceExportNames = [
            'lodash', 'Fuse', 'DOMPurify', 'hljs', 'localforage', 'Handlebars',
            'css', 'Bowser', 'DiffMatchPatch', 'Readability', 'isProbablyReaderable',
            'SVGInject', 'showdown', 'markdownit', 'markdownItEmoji', 'markdownItCjkFriendly',
            'moment', 'seedrandom', 'droll', 'morphdom', 'slideToggle',
            'chalk', 'yaml', 'gzipSync', 'gzip', 'sha256',
        ];
        const namespaceExportNames = ['Popper', 'chevrotain'];
        const expectSameNamespace = (actual, expected) => {
            const actualKeys = Object.keys(actual).sort();
            const expectedKeys = Object.keys(expected).sort();
            expect(actualKeys.length).toBeGreaterThan(0);
            expect(actualKeys).toEqual(expectedKeys);
            for (const key of expectedKeys) {
                expect(actual[key]).toBe(expected[key]);
            }
        };

        for (const name of nonNamespaceExportNames) {
            expect(libModule[name]).toBeDefined();
            expect(libModule.default[name]).toBe(libModule[name]);
        }
        for (const name of namespaceExportNames) {
            expect(libModule[name]).toBeDefined();
            expectSameNamespace(libModule.default[name], libModule[name]);
        }
        expect(typeof libModule.initLibraryShims).toBe('function');

        // Verify window.* compatibility shims.
        libModule.initLibraryShims();
        expect(mockWindow.Fuse).toBe(libModule.Fuse);
        expect(mockWindow.DOMPurify).toBe(libModule.DOMPurify);
        expect(mockWindow.hljs).toBe(libModule.hljs);
        expect(mockWindow.localforage).toBe(libModule.localforage);
        expect(mockWindow.Handlebars).toBe(libModule.Handlebars);
        expect(mockWindow.diff_match_patch).toBe(libModule.DiffMatchPatch);
        expect(mockWindow.SVGInject).toBe(libModule.SVGInject);
        expect(mockWindow.showdown).toBe(libModule.showdown);
        expect(mockWindow.moment).toBe(libModule.moment);
        expectSameNamespace(mockWindow.Popper, libModule.Popper);
        expect(mockWindow.droll).toBe(libModule.droll);

        // Verify highlight.js uses core + ~31 languages (not 194) and all standard aliases work.
        const { hljs, moment } = libModule;
        expect(hljs.listLanguages().length).toBeGreaterThanOrEqual(30);
        expect(hljs.listLanguages().length).toBeLessThan(40);

        for (const langOrAlias of [
            'javascript', 'js', 'typescript', 'ts', 'python', 'py', 'json',
            'bash', 'sh', 'shell', 'xml', 'html', 'css', 'scss', 'sql',
            'yaml', 'yml', 'markdown', 'md', 'c', 'cpp', 'c++', 'csharp', 'cs',
            'java', 'kotlin', 'kt', 'go', 'rust', 'ruby', 'rb', 'php', 'swift',
            'diff', 'ini', 'plaintext', 'txt', 'lua', 'dockerfile', 'powershell',
            'ps1', 'makefile', 'regex', 'graphql', 'dos',
        ]) {
            expect(hljs.getLanguage(langOrAlias)).toBeTruthy();
        }

        // Unknown fence tags must never throw in highlight() or highlightElement().
        const unknownResult = hljs.highlight('fn main() { 1 < 2 }', { language: 'nonexistent-rare-fence' });
        expect(unknownResult.language).toBe('plaintext');
        expect(unknownResult.value).toContain('&lt;');

        const fakeCodeElement = {
            textContent: 'SELECT 1 < 2;',
            children: [],
            className: 'language-nonexistent-rare-fence',
            classList: { contains: () => false, add: () => {} },
            dataset: {},
            innerHTML: '',
        };
        expect(() => hljs.highlightElement(fakeCodeElement)).not.toThrow();
        expect(fakeCodeElement.innerHTML).toContain('&lt;');

        // Standalone nohighlight class must still skip highlighting even alongside an unknown language-* tag.
        const noHighlightElement = {
            textContent: 'SELECT 1 < 2;',
            children: [],
            className: 'nohighlight language-nonexistent-rare-fence',
            classList: { contains: () => false, add: () => {} },
            dataset: {},
            innerHTML: '',
        };
        expect(() => hljs.highlightElement(noHighlightElement)).not.toThrow();
        expect(noHighlightElement.innerHTML).toBe('');
        expect(noHighlightElement.dataset.highlighted).toBeUndefined();

        // Runtime custom language registration (e.g. STscript) still works.
        hljs.registerLanguage('stscript-test', () => ({ keywords: 'echo' }));
        expect(hljs.getLanguage('stscript-test')).toBeTruthy();

        // Moment preserves English plus all 16 SillyBunny UI locales and regional en/pt while pruning unused locales.
        const sampleIso = '2026-01-15T12:00:00Z';
        expect(moment(sampleIso).locale('en').format('YYYY-MM-DD')).toBe('2026-01-15');
        expect(moment(sampleIso).locale('en-gb').format('LL')).toBe('15 January 2026');
        expect(moment(sampleIso).locale('ja-jp').format('LL')).toBe('2026年1月15日');
        expect(moment(sampleIso).locale('zh-cn').format('LL')).toBe('2026年1月15日');
        expect(moment(sampleIso).locale('zh-tw').format('LL')).toBe('2026年1月15日');
        expect(moment(sampleIso).locale('de-de').format('LL')).toBe('15. Januar 2026');
        expect(moment(sampleIso).locale('fr-fr').format('LL')).toBe('15 janvier 2026');
        expect(moment(sampleIso).locale('ar-sa').locale()).toBe('ar-sa');
        expect(moment(sampleIso).locale('ar-sa').format('LL')).not.toBe('January 15, 2026');
        expect(moment(sampleIso).locale('pt-br').format('LL')).toBe('15 de janeiro de 2026');
        expect(moment.duration(125000).locale('ja-jp').humanize()).toBe('2分');

        const uiLangCatalog = JSON.parse(fs.readFileSync(path.join(publicRoot, 'locales', 'lang.json'), 'utf8'));
        for (const entry of uiLangCatalog) {
            expect(moment(sampleIso).locale(entry.lang).locale()).not.toBe('en');
        }
        // Also touch regional locales to verify total bundled count stays tightly bounded.
        for (const regional of ['en-au', 'en-ca', 'en-gb', 'pt-br']) {
            expect(moment(sampleIso).locale(regional).locale()).toBe(regional);
        }
        // Unused locales remain stripped and safely fall back to English.
        for (const unused of ['tlh', 'af', 'eo']) {
            expect(moment(sampleIso).locale(unused).locale()).toBe('en');
        }
        // moment.locales() includes negative-cache keys for failed alias lookups (e.g. de-de, tlh);
        // count distinct genuinely loaded locale definitions via localeData().
        const loadedLocales = new Set(
            moment.locales()
                .map(loc => moment.localeData(loc)?._abbr)
                .filter(Boolean),
        );
        expect(loadedLocales.size).toBe(21);
        expect(loadedLocales.size).toBeLessThanOrEqual(25);
        expect(loadedLocales.has('tlh')).toBe(false);
        expect(loadedLocales.has('af')).toBe(false);
        expect(loadedLocales.has('eo')).toBe(false);
    });

    test('(g) --tarball produces a deterministic pure-Node POSIX .tar.gz archive and release.yml attaches it', async () => {
        expect(fs.existsSync(tmpTarballPath)).toBe(true);

        const secondTarballPath = path.join(tmpWorkDir, 'second.tar.gz');
        await createDeterministicTarGz(tmpDistDir, secondTarballPath);

        const firstGz = fs.readFileSync(tmpTarballPath);
        const secondGz = fs.readFileSync(secondTarballPath);
        expect(firstGz.equals(secondGz)).toBe(true);

        const tarBuffer = zlib.gunzipSync(firstGz);
        const entries = parseTarEntryNames(tarBuffer);
        const names = new Set(entries.map(entry => entry.name));

        expect(names.has('dist/frontend/asset-manifest.json')).toBe(true);
        expect(names.has(`dist/frontend/${manifest.assets['lib.js'].output}`)).toBe(true);
        expect(names.has(`dist/frontend/${manifest.assets['script.js'].output}`)).toBe(true);
        expect(names.has(`dist/frontend/${manifest.assets['style.css'].output}`)).toBe(true);

        const releaseYml = fs.readFileSync(releaseWorkflowPath, 'utf8');
        expect(releaseYml).toContain('SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)" npm run build:frontend -- --tarball "$out/sillybunny-frontend-assets.tar.gz"');
    });
});
