import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// sillytavern-transformers takes its browser code path when `self` is defined, as it is under Bun.
// Define it before the library loads so that these tests also cover that path under Node.js.
global.self = global;
await import('../src/fetch-patch.js');
const { RawImage } = await import('sillytavern-transformers');
const { getRawImage } = await import('../src/transformers.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A 55-byte ASF header with a zero-size sub-header (GHSA-5v7r-6r5c-r473).
const ASF_HEADER = Buffer.concat([Buffer.from('3026b2758e66cf11a6d9', 'hex'), Buffer.alloc(45)]).toString('base64');

// A 3x2 RGBA PNG: red, green, blue, then white, black and half-transparent blue.
const PNG_3X2 = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAJUlEQVR4AQEaAOX/AP8AAP8A/wD/AAD//wD/////AAAA/wAA/4Ci9wx1JWtabAAAAABJRU5ErkJggg==';
const PNG_3X2_PIXELS = [
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
    255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 255, 128,
];

/**
 * Runs an ES module script in a separate Node.js process and parses the last line it prints as JSON.
 * A hang in file-type blocks the event loop, so only a separate process can be stopped at a deadline.
 * @param {string} script Module source
 * @returns {any} Parsed output
 */
function runModuleScript(script) {
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 30_000,
    });
    if (child.error || child.status !== 0) {
        throw new Error(child.error?.message || child.stderr || `Child exited with code ${child.status}.`);
    }
    return JSON.parse(child.stdout.trim().split('\n').at(-1));
}

describe('getRawImage', () => {
    test('rejects a malformed ASF header at once', () => {
        const transformersUrl = pathToFileURL(path.join(repoRoot, 'src', 'transformers.js')).href;
        const { image, elapsed } = runModuleScript([
            `import { getRawImage } from ${JSON.stringify(transformersUrl)};`,
            'const started = performance.now();',
            `const image = await getRawImage(${JSON.stringify(ASF_HEADER)});`,
            'console.log(JSON.stringify({ image, elapsed: performance.now() - started }));',
        ].join('\n'));

        expect(image).toBeNull();
        expect(elapsed).toBeLessThan(1_000);
    }, 60_000);

    test('decodes a PNG to an RGBA image of the same size', async () => {
        const image = await getRawImage(PNG_3X2);

        expect(image).toBeInstanceOf(RawImage);
        expect([image.width, image.height, image.channels]).toEqual([3, 2, 4]);
        expect(Array.from(image.data)).toEqual(PNG_3X2_PIXELS);
    });
});
