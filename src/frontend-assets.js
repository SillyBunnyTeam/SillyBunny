import fs from 'node:fs';
import path from 'node:path';

import { serverDirectory } from './server-directory.js';
import { getConfigValue } from './util.js';

export const FRONTEND_DIST_ROOT = path.join(serverDirectory, 'dist', 'frontend');
export const FRONTEND_MANIFEST_FILE = 'asset-manifest.json';
export const FRONTEND_ASSET_PREFIX = '/frontend-assets/';
export const HASHED_FRONTEND_ASSET_RE = /-[a-f0-9]{8,}\.[a-z0-9]+$/i;

let manifestCache = null;

export function getFrontendManifestPath() {
    return path.join(FRONTEND_DIST_ROOT, FRONTEND_MANIFEST_FILE);
}

export function getFrontendAssetsEnabled() {
    return getConfigValue('performance.frontendBuild.enabled', false, 'boolean');
}

export function getFrontendImmutableMaxAge() {
    const value = getConfigValue('performance.frontendBuild.immutableMaxAge', 31536000, 'number');
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 31536000;
}

export function clearFrontendManifestCache() {
    manifestCache = null;
}

export function loadFrontendManifest() {
    if (manifestCache !== null) {
        return manifestCache;
    }

    const manifestPath = getFrontendManifestPath();
    if (!fs.existsSync(manifestPath)) {
        manifestCache = null;
        return null;
    }

    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifestCache = manifest && typeof manifest === 'object' ? manifest : null;
    } catch (error) {
        console.warn('Failed to read frontend asset manifest.', error);
        manifestCache = null;
    }

    return manifestCache;
}

export function resolveFrontendAssetPath(publicPath) {
    const manifest = loadFrontendManifest();
    const assets = manifest?.assets;

    if (!assets || typeof assets !== 'object') {
        return null;
    }

    const normalizedPath = String(publicPath).replace(/^\/+/, '');
    const entry = assets[normalizedPath];

    if (!entry || typeof entry.output !== 'string') {
        return null;
    }

    return `${FRONTEND_ASSET_PREFIX}${entry.output}`;
}

export function rewriteFrontendHtml(html, { enabled = getFrontendAssetsEnabled() } = {}) {
    if (!enabled || typeof html !== 'string') {
        return html;
    }

    let rewritten = html;
    const replacements = new Map([
        ['style.css', resolveFrontendAssetPath('style.css')],
        ['css/mobile-styles.css', resolveFrontendAssetPath('css/mobile-styles.css')],
        ['css/sillybunny-theme.css', resolveFrontendAssetPath('css/sillybunny-theme.css')],
        ['css/sillybunny-tabs.css', resolveFrontendAssetPath('css/sillybunny-tabs.css')],
        ['css/sillybunny-mobile-shell.css', resolveFrontendAssetPath('css/sillybunny-mobile-shell.css')],
        ['webfonts/AdwaitaSans/AdwaitaSans-Regular-Latin.woff2', resolveFrontendAssetPath('webfonts/AdwaitaSans/AdwaitaSans-Regular-Latin.woff2')],
        ['webfonts/AdwaitaSans/stylesheet.css', resolveFrontendAssetPath('webfonts/AdwaitaSans/stylesheet.css')],
        ['webfonts/NotoSans/stylesheet.css', resolveFrontendAssetPath('webfonts/NotoSans/stylesheet.css')],
        ['webfonts/AdwaitaMono/stylesheet.css', resolveFrontendAssetPath('webfonts/AdwaitaMono/stylesheet.css')],
        ['webfonts/NotoSansMono/stylesheet.css', resolveFrontendAssetPath('webfonts/NotoSansMono/stylesheet.css')],
    ]);

    for (const [source, target] of replacements) {
        if (!target) {
            continue;
        }

        const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        rewritten = rewritten.replace(new RegExp(`(["'])${escaped}(?:\\?v=[^"']*)?\\1`, 'g'), `$1${target}$1`);
    }

    return rewritten;
}

export function applyFrontendAssetHeaders(res, filePath) {
    const relativePath = path.relative(FRONTEND_DIST_ROOT, filePath).split(path.sep).join('/');

    if (HASHED_FRONTEND_ASSET_RE.test(relativePath)) {
        res.setHeader('Cache-Control', `public, max-age=${getFrontendImmutableMaxAge()}, immutable`);
        return;
    }

    res.setHeader('Cache-Control', 'no-cache');
}
