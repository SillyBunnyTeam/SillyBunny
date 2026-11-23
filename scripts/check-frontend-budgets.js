#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(__dirname, '..');

// Ratchet budgets match the measured frontend state. Lower them when assets shrink.
export const FRONTEND_BUDGETS = Object.freeze({
    blockingStylesheetCount: 16,
    blockingStylesheetBytes: 1024 * 1024,
    widthMediaStylesheetCount: 3,
    widthMediaStylesheetBytes: 110 * 1024,
    importedStylesheetCount: 19,
    importedStylesheetBytes: 160 * 1024,
    startupScriptCount: 26,
    startupScriptBytes: 3_600 * 1024,
    extensionLargeAssetBytes: 2_250 * 1024,
    forkWillChangeCount: 3,
    forkBackdropFilterCount: 38,
});

// Local user CSS is intentionally gitignored and may be absent in CI.
const OPTIONAL_PUBLIC_ASSETS = new Set([
    'css/user.css',
]);

const NORMALIZED_TEXT_ASSET_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.map', '.mjs', '.svg', '.txt']);

const LARGE_EXTENSION_ASSETS = Object.freeze([
    'scripts/extensions/tts/lib/kokoro.web.js',
    'scripts/extensions/gallery/jquery.nanogallery2.min.js',
    'scripts/extensions/sillybunny-debugger/lib/eruda.js',
]);

function stripQuery(value) {
    return String(value).split(/[?#]/)[0];
}

function getAttribute(tag, name) {
    const match = tag.match(new RegExp(`\\s${name}=(["'])(.*?)\\1`, 'i'));
    return match?.[2] ?? '';
}

export function stripCssComments(cssSource) {
    return String(cssSource ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
}

export function formatBytes(bytes) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function countForkCssHazards(publicRoot) {
    const cssDir = path.join(publicRoot, 'css');
    if (!fs.existsSync(cssDir)) {
        return { willChange: 0, backdropFilter: 0, files: [] };
    }

    let willChange = 0;
    let backdropFilter = 0;
    const files = [];

    for (const fileName of fs.readdirSync(cssDir).filter(name => name.startsWith('sillybunny-') && name.endsWith('.css')).sort()) {
        const source = stripCssComments(fs.readFileSync(path.join(cssDir, fileName), 'utf8'));
        const fileWillChange = (source.match(/\bwill-change\s*:/gi) ?? []).length;
        const fileBackdropFilter = (source.match(/(?:-webkit-)?backdrop-filter\s*:/gi) ?? []).length;
        willChange += fileWillChange;
        backdropFilter += fileBackdropFilter;
        if (fileWillChange > 0 || fileBackdropFilter > 0) {
            files.push({ file: fileName, willChange: fileWillChange, backdropFilter: fileBackdropFilter });
        }
    }

    return { willChange, backdropFilter, files };
}

export function collectFrontendAssetSnapshot(repoRoot = defaultRepoRoot) {
    const publicRoot = path.join(repoRoot, 'public');
    const indexPath = path.join(publicRoot, 'index.html');
    const indexHtml = fs.readFileSync(indexPath, 'utf8');
    const errors = [];

    function getPublicFileSize(url) {
        const cleanUrl = stripQuery(url).replace(/^\/+/, '');
        const filePath = path.resolve(publicRoot, cleanUrl);
        const isPublicPath = filePath === publicRoot || filePath.startsWith(`${publicRoot}${path.sep}`);

        if (!isPublicPath) {
            errors.push(`Asset path escapes public directory: ${url}`);
            return 0;
        }

        if (!fs.existsSync(filePath)) {
            if (OPTIONAL_PUBLIC_ASSETS.has(cleanUrl)) {
                return 0;
            }

            errors.push(`Referenced asset is missing: ${url}`);
            return 0;
        }

        if (NORMALIZED_TEXT_ASSET_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
            const source = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
            return Buffer.byteLength(source, 'utf8');
        }

        return fs.statSync(filePath).size;
    }

    // A sheet that style.css imports is fetched only after style.css arrives and blocks rendering.
    function collectImportedStylesheets(cssUrl, seen = new Set()) {
        const cssPath = path.resolve(publicRoot, stripQuery(cssUrl).replace(/^\/+/, ''));
        if (!cssPath.startsWith(`${publicRoot}${path.sep}`) || !fs.existsSync(cssPath)) {
            return [];
        }
        const source = stripCssComments(fs.readFileSync(cssPath, 'utf8'));
        const imports = [];
        for (const match of source.matchAll(/@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1/gi)) {
            const target = stripQuery(match[2]);
            if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(target) || target.startsWith('data:')) {
                continue;
            }
            const resolvedPath = target.startsWith('/')
                ? path.resolve(publicRoot, target.replace(/^\/+/, ''))
                : path.resolve(path.dirname(cssPath), target);
            const resolved = path.relative(publicRoot, resolvedPath).split(path.sep).join('/');
            if (seen.has(resolved)) {
                continue;
            }
            seen.add(resolved);
            imports.push({ href: resolved, size: getPublicFileSize(resolved) });
            imports.push(...collectImportedStylesheets(resolved, seen));
        }
        return imports;
    }

    const linkTags = Array.from(indexHtml.matchAll(/<link\b[^>]*>/gi)).map(match => match[0]);

    const blockingStylesheets = linkTags
        .filter(tag => /\brel=(["'])stylesheet\1/i.test(tag))
        .filter(tag => {
            const media = getAttribute(tag, 'media');
            return !media || media === 'all' || media === 'screen';
        })
        .map(tag => ({
            href: getAttribute(tag, 'href'),
            size: getPublicFileSize(getAttribute(tag, 'href')),
        }))
        .filter(asset => asset.href);

    const widthMediaStylesheets = linkTags
        .filter(tag => /\brel=(["'])stylesheet\1/i.test(tag))
        .filter(tag => /\bwidth\b/i.test(getAttribute(tag, 'media')))
        .map(tag => ({
            href: getAttribute(tag, 'href'),
            size: getPublicFileSize(getAttribute(tag, 'href')),
        }))
        .filter(asset => asset.href);

    const importedStylesheetSeen = new Set();
    const importedStylesheets = blockingStylesheets
        .filter(asset => stripQuery(asset.href).endsWith('.css'))
        .flatMap(asset => collectImportedStylesheets(asset.href, importedStylesheetSeen));

    const startupScripts = Array.from(indexHtml.matchAll(/<script\b[^>]*>/gi))
        .map(match => match[0])
        .map(tag => ({
            src: getAttribute(tag, 'src'),
            size: getPublicFileSize(getAttribute(tag, 'src')),
        }))
        .filter(asset => asset.src);

    const largeExtensionAssets = LARGE_EXTENSION_ASSETS.map(asset => ({
        asset,
        size: getPublicFileSize(asset),
    }));

    const forkCssHazards = countForkCssHazards(publicRoot);

    return {
        errors,
        blockingStylesheets,
        blockingStylesheetBytes: blockingStylesheets.reduce((total, asset) => total + asset.size, 0),
        widthMediaStylesheets,
        widthMediaStylesheetBytes: widthMediaStylesheets.reduce((total, asset) => total + asset.size, 0),
        importedStylesheets,
        importedStylesheetBytes: importedStylesheets.reduce((total, asset) => total + asset.size, 0),
        startupScripts,
        startupScriptBytes: startupScripts.reduce((total, asset) => total + asset.size, 0),
        largeExtensionAssets,
        forkCssHazards,
    };
}

export function evaluateFrontendBudgets(snapshot, budgets = FRONTEND_BUDGETS) {
    const failures = [...(snapshot.errors ?? [])];

    if (snapshot.blockingStylesheets.length > budgets.blockingStylesheetCount) {
        failures.push(`Blocking stylesheet count ${snapshot.blockingStylesheets.length} exceeds budget ${budgets.blockingStylesheetCount}.`);
    }
    if (snapshot.blockingStylesheetBytes > budgets.blockingStylesheetBytes) {
        failures.push(`Blocking stylesheet bytes ${formatBytes(snapshot.blockingStylesheetBytes)} exceed budget ${formatBytes(budgets.blockingStylesheetBytes)}.`);
    }
    if (snapshot.widthMediaStylesheets.length > budgets.widthMediaStylesheetCount) {
        failures.push(`Width-media stylesheet count ${snapshot.widthMediaStylesheets.length} exceeds budget ${budgets.widthMediaStylesheetCount}.`);
    }
    if (snapshot.widthMediaStylesheetBytes > budgets.widthMediaStylesheetBytes) {
        failures.push(`Width-media stylesheet bytes ${formatBytes(snapshot.widthMediaStylesheetBytes)} exceed budget ${formatBytes(budgets.widthMediaStylesheetBytes)}.`);
    }
    if (snapshot.importedStylesheets.length > budgets.importedStylesheetCount) {
        failures.push(`Imported stylesheet count ${snapshot.importedStylesheets.length} exceeds budget ${budgets.importedStylesheetCount}.`);
    }
    if (snapshot.importedStylesheetBytes > budgets.importedStylesheetBytes) {
        failures.push(`Imported stylesheet bytes ${formatBytes(snapshot.importedStylesheetBytes)} exceed budget ${formatBytes(budgets.importedStylesheetBytes)}.`);
    }
    if (snapshot.startupScripts.length > budgets.startupScriptCount) {
        failures.push(`Startup script count ${snapshot.startupScripts.length} exceeds budget ${budgets.startupScriptCount}.`);
    }
    if (snapshot.startupScriptBytes > budgets.startupScriptBytes) {
        failures.push(`Startup script bytes ${formatBytes(snapshot.startupScriptBytes)} exceed budget ${formatBytes(budgets.startupScriptBytes)}.`);
    }
    if ((snapshot.forkCssHazards?.willChange ?? 0) > budgets.forkWillChangeCount) {
        failures.push(`Fork CSS will-change declarations ${snapshot.forkCssHazards.willChange} exceed budget ${budgets.forkWillChangeCount}.`);
    }
    if ((snapshot.forkCssHazards?.backdropFilter ?? 0) > budgets.forkBackdropFilterCount) {
        failures.push(`Fork CSS backdrop-filter declarations ${snapshot.forkCssHazards.backdropFilter} exceed budget ${budgets.forkBackdropFilterCount}.`);
    }
    for (const { asset, size } of snapshot.largeExtensionAssets ?? []) {
        if (size > budgets.extensionLargeAssetBytes) {
            failures.push(`${asset} is ${formatBytes(size)}, above budget ${formatBytes(budgets.extensionLargeAssetBytes)}.`);
        }
    }

    return failures;
}

export function run(repoRoot = defaultRepoRoot, budgets = FRONTEND_BUDGETS) {
    const snapshot = collectFrontendAssetSnapshot(repoRoot);
    const failures = evaluateFrontendBudgets(snapshot, budgets);

    console.log(`Blocking stylesheets: ${snapshot.blockingStylesheets.length}, ${formatBytes(snapshot.blockingStylesheetBytes)}`);
    console.log(`Width-media stylesheets: ${snapshot.widthMediaStylesheets.length}, ${formatBytes(snapshot.widthMediaStylesheetBytes)}`);
    console.log(`Imported stylesheets: ${snapshot.importedStylesheets.length}, ${formatBytes(snapshot.importedStylesheetBytes)}`);
    console.log(`Startup scripts: ${snapshot.startupScripts.length}, ${formatBytes(snapshot.startupScriptBytes)}`);
    console.log(`Fork CSS hazards: will-change=${snapshot.forkCssHazards.willChange}, backdrop-filter=${snapshot.forkCssHazards.backdropFilter}`);
    for (const { asset, size } of snapshot.largeExtensionAssets) {
        console.log(`${asset}: ${formatBytes(size)}`);
    }

    for (const failure of failures) {
        console.error(failure);
        process.exitCode = 1;
    }

    return { snapshot, failures };
}

function isDirectRun() {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isDirectRun()) {
    run();
}
