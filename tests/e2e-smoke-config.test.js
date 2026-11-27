import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';

import { SMOKE_SPECS } from './e2e-smoke-specs.js';
import smokeConfig from './playwright.smoke.config.js';
import webkitConfig, { DIALOG_SPECS } from './playwright.webkit.config.js';
import firefoxConfig, { FIREFOX_SPECS, NOT_RUNNABLE_IN_FIREFOX } from './playwright.firefox.config.js';
import { parsePrimeCliArgs, resolvePrimeBrowser } from './e2e-servers-prime.js';

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const testsPackage = JSON.parse(fs.readFileSync(path.join(testsDirectory, 'package.json'), 'utf8'));

describe('e2e smoke and cross-browser Playwright configs', () => {
    test.each([
        ['SMOKE_SPECS', SMOKE_SPECS],
        ['DIALOG_SPECS (WebKit)', DIALOG_SPECS],
        ['FIREFOX_SPECS', FIREFOX_SPECS],
    ])('%s lists unique existing e2e specs outside audit/ and foundation/', (_label, specs) => {
        expect(specs.length).toBeGreaterThan(0);
        expect(new Set(specs).size).toBe(specs.length);

        for (const spec of specs) {
            expect(spec).not.toMatch(/^(?:audit|foundation)\//);
            const specPath = path.join(testsDirectory, `${spec}.e2e.js`);
            expect({ spec, exists: fs.existsSync(specPath) }).toEqual({ spec, exists: true });
        }
    });

    test('smoke config uses Chromium, matches SMOKE_SPECS, and exposes the npm script', () => {
        expect(testsPackage.scripts['test:e2e:smoke']).toBe('playwright test --config playwright.smoke.config.js');
        expect(smokeConfig.testMatch).toEqual(SMOKE_SPECS.map(name => `**/${name}.e2e.js`));
        expect(smokeConfig.projects).toEqual([{ name: 'chromium', use: { browserName: 'chromium' } }]);
    });

    test('WebKit and Firefox configs block service workers and keep browser projects explicit', () => {
        expect(testsPackage.scripts['test:e2e:webkit']).toBe('playwright test --config playwright.webkit.config.js');
        expect(testsPackage.scripts['test:e2e:firefox']).toBe('playwright test --config playwright.firefox.config.js');

        expect(webkitConfig.projects).toEqual([{ name: 'webkit', use: { browserName: 'webkit', serviceWorkers: 'block' } }]);
        expect(firefoxConfig.projects).toEqual([{ name: 'firefox', use: { browserName: 'firefox', serviceWorkers: 'block' } }]);
        expect(webkitConfig.timeout).toBe(60_000);
        expect(firefoxConfig.timeout).toBe(60_000);
        expect([firefoxConfig.globalSetup].flat()).toContain('./helpers/restart-cache-clear-seed.js');
    });

    test('Firefox exclusions each document a reason and a RegExp pattern', () => {
        expect(NOT_RUNNABLE_IN_FIREFOX.length).toBeGreaterThan(0);
        for (const entry of NOT_RUNNABLE_IN_FIREFOX) {
            expect(typeof entry.reason).toBe('string');
            expect(entry.reason.trim().length).toBeGreaterThan(0);
            expect(entry.pattern).toBeInstanceOf(RegExp);
        }
    });

    test('server priming CLI supports chromium, webkit, and firefox and rejects unknown inputs', () => {
        for (const browser of ['chromium', 'webkit', 'firefox']) {
            expect(typeof resolvePrimeBrowser(browser).launch).toBe('function');
            const parsed = parsePrimeCliArgs([`--browser=${browser}`], { SILLYBUNNY_TEST_BASE_URL: 'http://127.0.0.1:4555' });
            expect(parsed.browserName).toBe(browser);
            expect(parsed.url).toBe('http://127.0.0.1:4555');
            expect(path.basename(parsed.dataRoot)).toBe('data');
        }

        expect(() => resolvePrimeBrowser('safari')).toThrow('Unsupported prime browser');
        expect(() => parsePrimeCliArgs(['--unknown=1'])).toThrow('Unknown argument');
    });
});
