import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptSource = readFileSync(path.join(repoRoot, 'public', 'script.js'), 'utf8');

function getFunctionSource(name) {
    const markers = [`function ${name}(`, `async function ${name}(`];
    const start = markers
        .map(marker => scriptSource.indexOf(marker))
        .filter(index => index >= 0)
        .sort((left, right) => left - right)[0];

    expect(start).toBeGreaterThanOrEqual(0);

    const bodyStart = scriptSource.indexOf('{', start);
    let depth = 0;

    for (let index = bodyStart; index < scriptSource.length; index++) {
        const char = scriptSource[index];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return scriptSource.slice(start, index + 1);
            }
        }
    }

    throw new Error(`Unable to find function source for ${name}`);
}

describe('tooling UI hydration wiring', () => {
    test('imports tooling UI hydration decisions into the script adapter', () => {
        expect(scriptSource).toContain('TOOLING_UI_HYDRATION_STATUS');
        expect(scriptSource).toContain('buildToolingCaptureFilename');
        expect(scriptSource).toContain('normalizeToolingCaptureRange');
        expect(scriptSource).toContain('resolveLazyToolingLibraryHydration');
        expect(scriptSource).toContain('resolveToolingAssetWait');
    });

    test('routes screenshot range normalization through the lifecycle seam', () => {
        const source = getFunctionSource('normalizeMessageScreenshotRange');

        expect(source).toContain('normalizeToolingCaptureRange({');
        expect(source).toContain('startId');
        expect(source).toContain('endId');
        expect(source).toContain('maxId: chat.length - 1');
        expect(source).not.toContain('Math.min(startId, endId)');
    });

    test('routes screenshot filename creation through the lifecycle seam', () => {
        const source = getFunctionSource('buildMessageScreenshotFilename');

        expect(source).toContain('buildToolingCaptureFilename({');
        expect(source).toContain('baseName');
        expect(source).toContain('startId');
        expect(source).toContain('endId');
        expect(source).not.toContain('replace(/[^a-z0-9]+/g');
    });

    test('routes screenshot asset wait timing through the lifecycle seam', () => {
        const source = getFunctionSource('waitForMessageScreenshotAssets');

        expect(source).toContain('resolveToolingAssetWait({');
        expect(source).toContain('assetCount: assets.length');
        expect(source).toContain('timeoutMs: 2000');
        expect(source).toContain('assetWait.shouldWait');
        expect(source).toContain('delay(assetWait.timeoutMs)');
        expect(source).not.toContain('assets.length === 0');
        expect(source).not.toContain('delay(2000)');
    });

    test('routes lazy screenshot library loading through the lifecycle seam', () => {
        const source = getFunctionSource('getMessageScreenshotLibrary');

        expect(source).toContain('resolveLazyToolingLibraryHydration({');
        expect(source).toContain('isLoaded: typeof window.html2canvas === \'function\'');
        expect(source).toContain('hasPendingLoad: Boolean(messageScreenshotLibraryPromise)');
        expect(source).toContain('hydrationState.status === TOOLING_UI_HYDRATION_STATUS.READY');
        expect(source).toContain('hydrationState.shouldLoad');
        expect(source).toContain('return await messageScreenshotLibraryPromise;');
        expect(source).not.toContain('if (!messageScreenshotLibraryPromise)');
    });

    test('flattens text-clipped gradient backgrounds before html2canvas capture', () => {
        const source = getFunctionSource('normalizeMessageScreenshotStyles');

        expect(source).toContain("backgroundClip.includes('text')");
        expect(source).toContain("computedStyle.backgroundImage !== 'none'");
        expect(source).toContain("'-webkit-text-fill-color', normalizeColorFunctionString(computedStyle.color)");
        expect(source).toContain("'background-image', 'none'");
        expect(source.indexOf('for (const propertyName of computedStyle)')).toBeLessThan(source.indexOf('backgroundClip.includes'));
    });

    test('normalizes every modern color function through the platform color parser', () => {
        expect(scriptSource).toContain('MODERN_COLOR_FUNCTION_TEST = /(?:\\b(?:color|oklch|oklab|lab|lch)\\s*\\()/i');
        const source = getFunctionSource('normalizeColorFunctionString');

        expect(source).toContain('MODERN_COLOR_FUNCTION_TEST.test(value)');
        expect(source).toContain('convertModernColorToken');
    });

    test('patches pseudo-element colors and re-checks the html2canvas clone', () => {
        const renderSource = getFunctionSource('renderMessageScreenshotCanvas');
        const pseudoSource = getFunctionSource('normalizePseudoElementCaptureStyles');

        expect(renderSource).toContain('normalizePseudoElementCaptureStyles(surface)');
        expect(renderSource).toContain('onclone:');
        expect(pseudoSource).toContain("'::before'");
        expect(pseudoSource).toContain("!important");
        expect(pseudoSource).toContain("contentValue === 'none' || contentValue === 'normal'");
    });

    test('filters computed style reads through the legacy color proxy during capture', () => {
        const renderSource = getFunctionSource('renderMessageScreenshotCanvas');
        const proxySource = getFunctionSource('createLegacyColorComputedStyleProxy');

        expect(renderSource).toContain('createLegacyColorComputedStyleProxy(originalGetComputedStyle.call(window');
        expect(renderSource).toContain('window.getComputedStyle = originalGetComputedStyle;');
        expect(proxySource).toContain('normalizeColorFunctionString(value)');
        expect(proxySource).toContain('Reflect.get(target, property, target)');
    });

    test('renders message screenshots inside the chat layout context', () => {
        const source = getFunctionSource('renderMessageScreenshotCanvas');

        expect(source).toContain('document.getElementById(\'chat\')');
        expect(source).toContain('captureParent.appendChild(shell)');
        expect(source).not.toContain('document.body.appendChild(shell)');
    });
});
