import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    collectFrontendAssetSnapshot,
    countForkCssHazards,
    evaluateFrontendBudgets,
    FRONTEND_BUDGETS,
    isDirectRun,
    stripCssComments,
} from '../scripts/check-frontend-budgets.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('frontend static asset and CSS hazard budgets', () => {
    test('strips CSS block comments before counting imports or compositor hazards', () => {
        const cleaned = stripCssComments('/* will-change: transform; backdrop-filter: blur(8px); */\n.card { will-change: opacity; }');
        expect(cleaned).not.toContain('backdrop-filter');
        expect(cleaned).toContain('will-change: opacity');
    });

    test('counts fork CSS will-change and backdrop-filter declarations accurately', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-css-hazards-'));
        try {
            const cssDir = path.join(tempDir, 'css');
            fs.mkdirSync(cssDir, { recursive: true });
            fs.writeFileSync(path.join(cssDir, 'sillybunny-sample.css'), [
                '/* will-change: transform; backdrop-filter: blur(12px); */',
                '.a { will-change: transform; -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); }',
            ].join('\n'));
            fs.writeFileSync(path.join(cssDir, 'upstream-other.css'), '.b { will-change: transform; backdrop-filter: blur(8px); }\n');

            const hazards = countForkCssHazards(tempDir);
            expect(hazards.willChange).toBe(1);
            expect(hazards.backdropFilter).toBe(2);
            expect(hazards.files).toEqual([{ file: 'sillybunny-sample.css', willChange: 1, backdropFilter: 2 }]);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('reports violations for imported stylesheets, width-media sheets, and CSS compositor hazards', () => {
        const snapshot = {
            errors: [],
            blockingStylesheets: Array.from({ length: 17 }, (_, i) => ({ href: `a${i}.css`, size: 10 })),
            blockingStylesheetBytes: FRONTEND_BUDGETS.blockingStylesheetBytes + 1,
            widthMediaStylesheets: Array.from({ length: FRONTEND_BUDGETS.widthMediaStylesheetCount + 1 }, (_, i) => ({ href: `m${i}.css`, size: 10 })),
            widthMediaStylesheetBytes: FRONTEND_BUDGETS.widthMediaStylesheetBytes + 1,
            importedStylesheets: Array.from({ length: 20 }, (_, i) => ({ href: `i${i}.css`, size: 10 })),
            importedStylesheetBytes: FRONTEND_BUDGETS.importedStylesheetBytes + 1,
            startupScripts: [],
            startupScriptBytes: 0,
            largeExtensionAssets: [{ asset: 'big.js', size: FRONTEND_BUDGETS.extensionLargeAssetBytes + 1 }],
            forkCssHazards: {
                willChange: FRONTEND_BUDGETS.forkWillChangeCount + 1,
                backdropFilter: FRONTEND_BUDGETS.forkBackdropFilterCount + 1,
            },
        };

        const failures = evaluateFrontendBudgets(snapshot, FRONTEND_BUDGETS);
        expect(failures).toEqual(expect.arrayContaining([
            expect.stringContaining('Blocking stylesheet count'),
            expect.stringContaining('Blocking stylesheet bytes'),
            expect.stringContaining('Width-media stylesheet count'),
            expect.stringContaining('Width-media stylesheet bytes'),
            expect.stringContaining('Imported stylesheet count'),
            expect.stringContaining('Imported stylesheet bytes'),
            expect.stringContaining('Fork CSS will-change declarations'),
            expect.stringContaining('Fork CSS backdrop-filter declarations'),
            expect.stringContaining('big.js'),
        ]));
    });

    test('allows four width-media sheets of 108.4 KiB and rejects a fifth sheet or a set over the byte budget', () => {
        const widthMediaSnapshot = (count, bytes) => ({
            errors: [],
            blockingStylesheets: [],
            blockingStylesheetBytes: 0,
            widthMediaStylesheets: Array.from({ length: count }, (_, i) => ({ href: `m${i}.css`, size: bytes / count })),
            widthMediaStylesheetBytes: bytes,
            importedStylesheets: [],
            importedStylesheetBytes: 0,
            startupScripts: [],
            startupScriptBytes: 0,
            largeExtensionAssets: [],
            forkCssHazards: { willChange: 0, backdropFilter: 0, files: [] },
        });

        expect(evaluateFrontendBudgets(widthMediaSnapshot(4, 108.4 * 1024))).toEqual([]);
        expect(evaluateFrontendBudgets(widthMediaSnapshot(5, 108.4 * 1024))).toEqual([
            expect.stringContaining('Width-media stylesheet count 5'),
        ]);
        expect(evaluateFrontendBudgets(widthMediaSnapshot(4, FRONTEND_BUDGETS.widthMediaStylesheetBytes + 1))).toEqual([
            expect.stringContaining('Width-media stylesheet bytes'),
        ]);
    });

    test('current repository passes every frontend budget without errors', () => {
        const snapshot = collectFrontendAssetSnapshot(repoRoot);
        const failures = evaluateFrontendBudgets(snapshot, FRONTEND_BUDGETS);
        expect(failures).toEqual([]);
        expect(snapshot.importedStylesheets.length).toBeLessThanOrEqual(FRONTEND_BUDGETS.importedStylesheetCount);
        expect(snapshot.forkCssHazards.willChange).toBeLessThanOrEqual(FRONTEND_BUDGETS.forkWillChangeCount);
        expect(snapshot.forkCssHazards.backdropFilter).toBeLessThanOrEqual(FRONTEND_BUDGETS.forkBackdropFilterCount);
    });
});

function canCreateSymlinks() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-symlink-probe-'));
    try {
        fs.writeFileSync(path.join(directory, 'target'), '');
        fs.symlinkSync(path.join(directory, 'target'), path.join(directory, 'link'));
        return true;
    } catch {
        return false;
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

const describeWithSymlinks = canCreateSymlinks() ? describe : describe.skip;

describe('running the check script directly', () => {
    const scriptSource = path.join(repoRoot, 'scripts', 'check-frontend-budgets.js');
    let tempDir;
    let checkout;

    beforeAll(() => {
        // A copy of the script in a small checkout: the script reads the checkout it sits in, so every start below
        // checks a tree whose result does not depend on the repository.
        tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-budget-run-')));
        checkout = path.join(tempDir, 'checkout');
        fs.mkdirSync(path.join(checkout, 'scripts'), { recursive: true });
        fs.mkdirSync(path.join(checkout, 'public', 'scripts', 'extensions', 'tts', 'lib'), { recursive: true });
        fs.mkdirSync(path.join(checkout, 'public', 'scripts', 'extensions', 'gallery'), { recursive: true });
        fs.mkdirSync(path.join(checkout, 'public', 'scripts', 'extensions', 'sillybunny-debugger', 'lib'), { recursive: true });
        fs.copyFileSync(scriptSource, path.join(checkout, 'scripts', 'check-frontend-budgets.js'));
        fs.writeFileSync(path.join(checkout, 'public', 'index.html'), '<link rel="stylesheet" href="style.css">\n');
        fs.writeFileSync(path.join(checkout, 'public', 'style.css'), 'a { color: red; }\n');
        for (const asset of ['tts/lib/kokoro.web.js', 'gallery/jquery.nanogallery2.min.js', 'sillybunny-debugger/lib/eruda.js']) {
            fs.writeFileSync(path.join(checkout, 'public', 'scripts', 'extensions', asset), '');
        }
    });

    afterAll(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function start(args, cwd = tempDir) {
        return spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
    }

    function summarize(result) {
        return {
            status: result.status,
            stderr: result.stderr,
            printsBlockingLine: result.stdout.includes('Blocking stylesheets: 1, 0.0 KiB'),
            printsHazardLine: result.stdout.includes('Fork CSS hazards: will-change=0, backdrop-filter=0'),
        };
    }

    const BUDGET_LINES_PRINTED = { status: 0, stderr: '', printsBlockingLine: true, printsHazardLine: true };

    test('prints the budget lines when started by its real path', () => {
        expect(summarize(start([path.join(checkout, 'scripts', 'check-frontend-budgets.js')]))).toEqual(BUDGET_LINES_PRINTED);
    });

    test('prints the budget lines when started by a relative path', () => {
        expect(summarize(start([path.join('.', 'scripts', 'check-frontend-budgets.js')], checkout))).toEqual(BUDGET_LINES_PRINTED);
    });

    test('prints the budget lines when started without the file extension', () => {
        expect(summarize(start([path.join('scripts', 'check-frontend-budgets')], checkout))).toEqual(BUDGET_LINES_PRINTED);
    });

    describeWithSymlinks('through a symlink', () => {
        beforeAll(() => {
            fs.symlinkSync(path.join(checkout, 'scripts', 'check-frontend-budgets.js'), path.join(tempDir, 'linked-script.js'));
            fs.symlinkSync(checkout, path.join(tempDir, 'linked-checkout'));
        });

        test('prints the budget lines when the symlink points to the file', () => {
            expect(summarize(start(['linked-script.js']))).toEqual(BUDGET_LINES_PRINTED);
        });

        test('prints the budget lines when the symlink points to the checkout', () => {
            expect(summarize(start([path.join('linked-checkout', 'scripts', 'check-frontend-budgets.js')]))).toEqual(BUDGET_LINES_PRINTED);
        });
    });

    test('does not run the check when another module imports it', () => {
        const result = start([
            '--input-type=module',
            '-e',
            'await import(process.argv[1])',
            pathToFileURL(path.join(checkout, 'scripts', 'check-frontend-budgets.js')).href,
        ]);

        expect(result.stderr).toBe('');
        expect(result.stdout).toBe('');
        expect(result.status).toBe(0);
    });
});

describe('isDirectRun', () => {
    const modulePath = '/repo/scripts/check-frontend-budgets.js';
    const identity = filePath => filePath;

    test('is false without an entry path', () => {
        expect(isDirectRun(undefined, modulePath, { realpath: identity })).toBe(false);
        expect(isDirectRun('', modulePath, { realpath: identity })).toBe(false);
    });

    test('compares the real paths of the entry and the module', () => {
        const realpath = filePath => (filePath === '/link/check.js' ? modulePath : filePath);

        expect(isDirectRun('/link/check.js', modulePath, { platform: 'linux', realpath })).toBe(true);
        expect(isDirectRun('/other/script.js', modulePath, { platform: 'linux', realpath })).toBe(false);
    });

    test('tries the entry path with a .js extension, and treats a path that does not exist as another script', () => {
        const realpath = (filePath) => {
            if (filePath === '/repo/scripts/check-frontend-budgets') {
                throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
            }
            return filePath;
        };

        expect(isDirectRun('/repo/scripts/check-frontend-budgets', modulePath, { platform: 'linux', realpath })).toBe(true);
        expect(isDirectRun('/repo/scripts/missing', modulePath, { platform: 'linux', realpath })).toBe(false);
    });

    test('ignores letter case on Windows only', () => {
        const entry = 'C:\\Repo\\Scripts\\Check-Frontend-Budgets.js';
        const moduleOnDisk = 'c:\\repo\\scripts\\check-frontend-budgets.js';

        expect(isDirectRun(entry, moduleOnDisk, { platform: 'win32', realpath: identity })).toBe(true);
        expect(isDirectRun(entry, moduleOnDisk, { platform: 'linux', realpath: identity })).toBe(false);
    });
});
