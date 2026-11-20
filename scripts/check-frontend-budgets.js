#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const indexPath = path.join(repoRoot, 'public', 'index.html');
const publicRoot = path.join(repoRoot, 'public');

const budgets = Object.freeze({
    blockingStylesheetCount: 16,
    blockingStylesheetBytes: 1024 * 1024,
    startupScriptCount: 26,
    startupScriptBytes: 3_600 * 1024,
    extensionLargeAssetBytes: 2_250 * 1024,
});

// Local user CSS is intentionally gitignored and may be absent in CI.
const optionalPublicAssets = new Set([
    'css/user.css',
]);

const indexHtml = fs.readFileSync(indexPath, 'utf8');
const normalizedTextAssetExtensions = new Set(['.css', '.html', '.js', '.json', '.map', '.mjs', '.svg', '.txt']);

function stripQuery(value) {
    return String(value).split(/[?#]/)[0];
}

function getAttribute(tag, name) {
    const match = tag.match(new RegExp(`\\s${name}=(["'])(.*?)\\1`, 'i'));
    return match?.[2] ?? '';
}

function getPublicFileSize(url) {
    const cleanUrl = stripQuery(url).replace(/^\/+/, '');
    const filePath = path.resolve(publicRoot, cleanUrl);
    const isPublicPath = filePath === publicRoot || filePath.startsWith(`${publicRoot}${path.sep}`);

    if (!isPublicPath) {
        fail(`Asset path escapes public directory: ${url}`);
        return 0;
    }

    if (!fs.existsSync(filePath)) {
        if (optionalPublicAssets.has(cleanUrl)) {
            return 0;
        }

        fail(`Referenced asset is missing: ${url}`);
        return 0;
    }

    if (normalizedTextAssetExtensions.has(path.extname(filePath).toLowerCase())) {
        const source = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
        return Buffer.byteLength(source, 'utf8');
    }

    return fs.statSync(filePath).size;
}

function formatBytes(bytes) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
}

function fail(message) {
    console.error(message);
    process.exitCode = 1;
}

const blockingStylesheets = Array.from(indexHtml.matchAll(/<link\b[^>]*>/gi))
    .map(match => match[0])
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

// Sheets with a width media query still block the first render when the viewport matches, so a phone waits for them.
// They are reported for information only and are outside the budgets above.
const widthMediaStylesheets = Array.from(indexHtml.matchAll(/<link\b[^>]*>/gi))
    .map(match => match[0])
    .filter(tag => /\brel=(["'])stylesheet\1/i.test(tag))
    .filter(tag => /\bwidth\b/i.test(getAttribute(tag, 'media')))
    .map(tag => ({
        href: getAttribute(tag, 'href'),
        size: getPublicFileSize(getAttribute(tag, 'href')),
    }))
    .filter(asset => asset.href);

// A sheet that style.css imports is fetched only after style.css arrives, and it blocks rendering like style.css itself.
function collectImportedStylesheets(cssUrl, seen = new Set()) {
    const cssPath = path.resolve(publicRoot, stripQuery(cssUrl).replace(/^\/+/, ''));
    if (!cssPath.startsWith(`${publicRoot}${path.sep}`) || !fs.existsSync(cssPath)) {
        return [];
    }
    const source = fs.readFileSync(cssPath, 'utf8');
    const imports = [];
    for (const match of source.matchAll(/@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1/gi)) {
        const target = match[2];
        if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(target) || target.startsWith('data:')) {
            continue;
        }
        const resolved = path.relative(publicRoot, path.resolve(path.dirname(cssPath), stripQuery(target))).split(path.sep).join('/');
        if (seen.has(resolved)) {
            continue;
        }
        seen.add(resolved);
        const importedPath = path.join(publicRoot, resolved);
        imports.push({ href: resolved, size: fs.existsSync(importedPath) ? fs.statSync(importedPath).size : 0 });
        imports.push(...collectImportedStylesheets(resolved, seen));
    }
    return imports;
}

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

const blockingStylesheetBytes = blockingStylesheets.reduce((total, asset) => total + asset.size, 0);
const startupScriptBytes = startupScripts.reduce((total, asset) => total + asset.size, 0);

console.log(`Blocking stylesheets: ${blockingStylesheets.length}, ${formatBytes(blockingStylesheetBytes)}`);
console.log(`Width-media stylesheets (information only): ${widthMediaStylesheets.length}, ${formatBytes(widthMediaStylesheets.reduce((total, asset) => total + asset.size, 0))}`);
console.log(`Imported stylesheets (information only): ${importedStylesheets.length}, ${formatBytes(importedStylesheets.reduce((total, asset) => total + asset.size, 0))}`);
console.log(`Startup scripts: ${startupScripts.length}, ${formatBytes(startupScriptBytes)}`);

if (blockingStylesheets.length > budgets.blockingStylesheetCount) {
    fail(`Blocking stylesheet count ${blockingStylesheets.length} exceeds budget ${budgets.blockingStylesheetCount}.`);
}

if (blockingStylesheetBytes > budgets.blockingStylesheetBytes) {
    fail(`Blocking stylesheet bytes ${formatBytes(blockingStylesheetBytes)} exceed budget ${formatBytes(budgets.blockingStylesheetBytes)}.`);
}

if (startupScripts.length > budgets.startupScriptCount) {
    fail(`Startup script count ${startupScripts.length} exceeds budget ${budgets.startupScriptCount}.`);
}

if (startupScriptBytes > budgets.startupScriptBytes) {
    fail(`Startup script bytes ${formatBytes(startupScriptBytes)} exceed budget ${formatBytes(budgets.startupScriptBytes)}.`);
}

const largeExtensionAssets = [
    'scripts/extensions/tts/lib/kokoro.web.js',
    'scripts/extensions/gallery/jquery.nanogallery2.min.js',
    'scripts/extensions/sillybunny-debugger/lib/eruda.js',
];

for (const asset of largeExtensionAssets) {
    const size = getPublicFileSize(asset);
    console.log(`${asset}: ${formatBytes(size)}`);

    if (size > budgets.extensionLargeAssetBytes) {
        fail(`${asset} is ${formatBytes(size)}, above budget ${formatBytes(budgets.extensionLargeAssetBytes)}.`);
    }
}
