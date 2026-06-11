import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import {
    FRONTEND_ASSET_PREFIX,
    HASHED_FRONTEND_ASSET_RE,
    clearFrontendManifestCache,
    getFrontendManifestPath,
    rewriteFrontendHtml,
} from '../src/frontend-assets.js';

describe('frontend asset manifest rewriting', () => {
    const manifestPath = getFrontendManifestPath();
    const manifestDirectory = path.dirname(manifestPath);
    let previousManifest = null;

    beforeEach(() => {
        previousManifest = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : null;
        fs.mkdirSync(manifestDirectory, { recursive: true });
        fs.writeFileSync(manifestPath, JSON.stringify({
            assets: {
                'style.css': { output: 'style-abc123.css' },
                'css/sillybunny-mobile-shell.css': { output: 'css/sillybunny-mobile-shell-def456.css' },
                'webfonts/Figtree/Figtree-Regular.woff2': { output: 'webfonts/Figtree/Figtree-Regular-789abc.woff2' },
                'script.js': { output: 'script-deadbeef.js' },
                'scripts/performance-loader.js': { output: 'scripts/performance-loader-deadbeef.js' },
                'scripts/sillybunny-tabs.js': { output: 'scripts/sillybunny-tabs-deadbeef.js' },
            },
        }), 'utf8');
        clearFrontendManifestCache();
    });

    afterEach(() => {
        if (previousManifest === null) {
            fs.rmSync(manifestPath, { force: true });
        } else {
            fs.writeFileSync(manifestPath, previousManifest, 'utf8');
        }
        clearFrontendManifestCache();
    });

    test('leaves HTML unchanged when the frontend build is disabled', () => {
        const html = '<link href="style.css"><script type="module" src="script.js"></script>';
        expect(rewriteFrontendHtml(html, { enabled: false })).toBe(html);
    });

    test('rewrites built styles and fonts without moving boot modules', () => {
        const html = [
            '<link href="style.css?v=old">',
            '<link href="css/sillybunny-mobile-shell.css?v=old">',
            '<link href="webfonts/Figtree/Figtree-Regular.woff2?v=old">',
            '<script type="module" src="scripts/performance-loader.js"></script>',
            '<script type="module" src="script.js?v=old"></script>',
            '<script type="module" src="scripts/sillybunny-tabs.js?v=old"></script>',
        ].join('');

        const rewritten = rewriteFrontendHtml(html, { enabled: true });

        expect(rewritten).toContain('href="/frontend-assets/style-abc123.css"');
        expect(rewritten).toContain('href="/frontend-assets/css/sillybunny-mobile-shell-def456.css"');
        expect(rewritten).toContain('href="/frontend-assets/webfonts/Figtree/Figtree-Regular-789abc.woff2"');
        expect(rewritten).toContain('src="scripts/performance-loader.js"');
        expect(rewritten).toContain('src="script.js?v=old"');
        expect(rewritten).toContain('src="scripts/sillybunny-tabs.js?v=old"');
        expect(rewritten).not.toContain('/frontend-assets/script-deadbeef.js');
        expect(rewritten).not.toContain('/frontend-assets/scripts/performance-loader-deadbeef.js');
        expect(rewritten).not.toContain('/frontend-assets/scripts/sillybunny-tabs-deadbeef.js');
    });

    test('keeps the immutable asset prefix stable for production serving', () => {
        expect(FRONTEND_ASSET_PREFIX).toBe('/frontend-assets/');
    });

    // The 'loads the main app module through a versioned URL' test was removed:
    // it pinned the regression that double-evaluated script.js (module identity
    // splits when the tag URL carries ?v= but bare '../script.js' imports do not).
    // tests/script-module-identity.test.js owns the corrected invariant.
    test('only treats fingerprinted frontend asset names as immutable', () => {
        expect(HASHED_FRONTEND_ASSET_RE.test('script-0123456789ab.js')).toBe(true);
        expect(HASHED_FRONTEND_ASSET_RE.test('scripts/extensions-abcdef123456.js')).toBe(true);
        expect(HASHED_FRONTEND_ASSET_RE.test('script.js')).toBe(false);
        expect(HASHED_FRONTEND_ASSET_RE.test('scripts/extensions.js')).toBe(false);
    });
});
