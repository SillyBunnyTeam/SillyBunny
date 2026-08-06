import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from '@jest/globals';

import {
    createRing,
    sanitizeUrl,
    serializeArg,
} from '../public/scripts/extensions/sillybunny-debugger/src/capture.js';
import { buildReport } from '../public/scripts/extensions/sillybunny-debugger/src/report.js';

const extensionRoot = new URL('../public/scripts/extensions/sillybunny-debugger/', import.meta.url);

describe('SillyBunny Debugger', () => {
    test('bounds capture without inspecting application objects', () => {
        const ring = createRing(3);
        for (let value = 1; value <= 5; value += 1) ring.push(value);

        let accesses = 0;
        const object = {
            get secret() {
                accesses += 1;
                return 'secret';
            },
        };

        expect(ring.entries()).toEqual([3, 4, 5]);
        expect(serializeArg(object)).toBe('[object]');
        expect(accesses).toBe(0);
    });

    test('redacts failed request credentials, query values, and fragments', () => {
        expect(sanitizeUrl('https://alice:secret@example.com/api/run?token=abc#private'))
            .toBe('https://example.com/api/run?[redacted]');
        expect(sanitizeUrl('/api/run?token=abc#private')).toBe('/api/run?[redacted]');
    });

    test('reports only useful events and remain bounded', () => {
        const entries = [
            { ts: 0, kind: 'log', text: 'ordinary log' },
            ...Array.from({ length: 300 }, (_, index) => ({
                ts: index,
                kind: 'error',
                text: `error ${index} ${'x'.repeat(400)}`,
            })),
        ];
        const report = buildReport({ entries, counters: { total: entries.length } });

        expect(report).not.toContain('ordinary log');
        expect(report).toContain('error 299');
        expect(report.length).toBeLessThanOrEqual(15000);
    });

    test('is a default-off lifecycle extension with the safe Eruda tool profile', async () => {
        const manifest = JSON.parse(await readFile(new URL('manifest.json', extensionRoot), 'utf8'));
        const source = await readFile(new URL('src/ui.js', extensionRoot), 'utf8');

        expect(manifest).toMatchObject({
            bundled_opt_in: true,
            requires: [],
            optional: [],
            hooks: { activate: 'init', enable: 'init', disable: 'deactivate' },
        });
        expect(source).toMatch(/const ERUDA_TOOLS = \['console', 'elements', 'network', 'info'];/);
        expect(source).toMatch(/instance\.get\?\.\('elements'\)\?\.config\?\.set\?\.\('overrideEventTarget', false\);/);
    });

    test('keeps the reviewed Eruda bundle and imports without browser globals', async () => {
        const bundle = await readFile(new URL('lib/eruda.js', extensionRoot));
        const hash = createHash('sha256').update(bundle).digest('hex');

        expect(hash).toBe('499ea431a3ed48a008efc871c8b7a49e61124b85d54fd91c4562f98b581424a3');
        await expect(import('../public/scripts/extensions/sillybunny-debugger/index.js')).resolves.toBeDefined();
    });
});
