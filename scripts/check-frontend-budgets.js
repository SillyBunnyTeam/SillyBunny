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
];

for (const asset of largeExtensionAssets) {
    const size = getPublicFileSize(asset);
    console.log(`${asset}: ${formatBytes(size)}`);

    if (size > budgets.extensionLargeAssetBytes) {
        fail(`${asset} is ${formatBytes(size)}, above budget ${formatBytes(budgets.extensionLargeAssetBytes)}.`);
    }
}
