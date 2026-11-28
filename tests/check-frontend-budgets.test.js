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

/** The three extension assets that the check always measures. A tree without them reports them as missing. */
const LARGE_EXTENSION_FILES = Object.freeze({
    'public/scripts/extensions/tts/lib/kokoro.web.js': '',
    'public/scripts/extensions/gallery/jquery.nanogallery2.min.js': '',
    'public/scripts/extensions/sillybunny-debugger/lib/eruda.js': '',
});

function writeTree(root, files) {
    for (const [relativePath, content] of Object.entries(files)) {
        const filePath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
    }
}

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

    test('every budget failure names the measured value, the budget and the rule for changing a budget', () => {
        const KiB = 1024;
        const sheets = count => Array.from({ length: count }, (_, i) => ({ href: `s${i}.css`, size: 1 }));
        const snapshot = {
            errors: ['Referenced asset is missing: gone.css'],
            blockingStylesheets: sheets(17),
            blockingStylesheetBytes: 2048 * KiB,
            widthMediaStylesheets: sheets(5),
            widthMediaStylesheetBytes: 130 * KiB,
            importedStylesheets: sheets(20),
            importedStylesheetBytes: 170 * KiB,
            startupScripts: sheets(27),
            startupScriptBytes: 4000 * KiB,
            largeExtensionAssets: [{ asset: 'big.js', size: 3000 * KiB }],
            forkCssHazards: {
                willChange: 4,
                backdropFilter: 39,
                files: [
                    { file: 'sillybunny-a.css', willChange: 1, backdropFilter: 2 },
                    { file: 'sillybunny-b.css', willChange: 3, backdropFilter: 37 },
                    { file: 'sillybunny-c.css', willChange: 0, backdropFilter: 0 },
                ],
            },
        };

        const failures = evaluateFrontendBudgets(snapshot, FRONTEND_BUDGETS);
        const budgetFailures = failures.filter(failure => !failure.startsWith('Referenced asset'));

        expect(failures).toContain('Referenced asset is missing: gone.css');
        expect(budgetFailures).toHaveLength(11);
        for (const failure of budgetFailures) {
            expect(failure).toContain('edit FRONTEND_BUDGETS in scripts/check-frontend-budgets.js');
            expect(failure).toContain('never raise one without a review note explaining the regression');
        }
        expect(budgetFailures).toEqual(expect.arrayContaining([
            expect.stringContaining(`Blocking stylesheet count 17 exceeds budget ${FRONTEND_BUDGETS.blockingStylesheetCount}.`),
            expect.stringContaining('Blocking stylesheet bytes 2048.0 KiB exceed budget 1024.0 KiB.'),
            expect.stringContaining(`Width-media stylesheet count 5 exceeds budget ${FRONTEND_BUDGETS.widthMediaStylesheetCount}.`),
            expect.stringContaining('Width-media stylesheet bytes 130.0 KiB exceed budget 125.0 KiB.'),
            expect.stringContaining(`Imported stylesheet count 20 exceeds budget ${FRONTEND_BUDGETS.importedStylesheetCount}.`),
            expect.stringContaining('Imported stylesheet bytes 170.0 KiB exceed budget 160.0 KiB.'),
            expect.stringContaining(`Startup script count 27 exceeds budget ${FRONTEND_BUDGETS.startupScriptCount}.`),
            expect.stringContaining('Startup script bytes 4000.0 KiB exceed budget 3600.0 KiB.'),
            expect.stringContaining('big.js is 3000.0 KiB, above budget 2250.0 KiB.'),
        ]));
    });

    test('the hazard failures list the files that carry the declaration, and the backdrop-filter one explains how declarations are counted', () => {
        const snapshot = {
            errors: [],
            blockingStylesheets: [],
            blockingStylesheetBytes: 0,
            widthMediaStylesheets: [],
            widthMediaStylesheetBytes: 0,
            importedStylesheets: [],
            importedStylesheetBytes: 0,
            startupScripts: [],
            startupScriptBytes: 0,
            largeExtensionAssets: [],
            forkCssHazards: {
                willChange: FRONTEND_BUDGETS.forkWillChangeCount + 1,
                backdropFilter: FRONTEND_BUDGETS.forkBackdropFilterCount + 1,
                files: [
                    { file: 'sillybunny-a.css', willChange: 1, backdropFilter: 0 },
                    { file: 'sillybunny-b.css', willChange: 0, backdropFilter: 39 },
                ],
            },
        };

        const [willChangeFailure, backdropFailure] = evaluateFrontendBudgets(snapshot, FRONTEND_BUDGETS);

        expect(willChangeFailure).toContain(`Fork CSS will-change declarations ${FRONTEND_BUDGETS.forkWillChangeCount + 1} exceed budget ${FRONTEND_BUDGETS.forkWillChangeCount};`);
        expect(willChangeFailure).toContain('Found in: sillybunny-a.css (1).');
        expect(willChangeFailure).not.toContain('sillybunny-b.css');
        expect(backdropFailure).toContain(`Fork CSS backdrop-filter declarations ${FRONTEND_BUDGETS.forkBackdropFilterCount + 1} exceed budget ${FRONTEND_BUDGETS.forkBackdropFilterCount}`);
        expect(backdropFailure).toContain('-webkit- companion counts as two');
        expect(backdropFailure).toContain('a `none` reset counts like any other declaration');
        expect(willChangeFailure).toContain('every declaration counts, including `auto`');
        expect(backdropFailure).toContain('Found in: sillybunny-b.css (39).');
        expect(backdropFailure).not.toContain('sillybunny-a.css');
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
        writeTree(checkout, {
            'public/index.html': '<link rel="stylesheet" href="style.css">\n',
            'public/style.css': 'a { color: red; }\n',
            ...LARGE_EXTENSION_FILES,
        });
        fs.mkdirSync(path.join(checkout, 'scripts'), { recursive: true });
        fs.copyFileSync(scriptSource, path.join(checkout, 'scripts', 'check-frontend-budgets.js'));
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

    describe('the exit code', () => {
        /** A checkout with a copy of the script, an index.html and the extension assets. */
        function createCheckout(name, indexHtml, files = {}) {
            const root = path.join(tempDir, name);
            writeTree(root, { 'public/index.html': indexHtml, ...LARGE_EXTENSION_FILES, ...files });
            fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
            fs.copyFileSync(scriptSource, path.join(root, 'scripts', 'check-frontend-budgets.js'));
            return root;
        }

        test('is 1 and names the budget when a budget is exceeded, and the budget lines are still printed', () => {
            const links = Array.from({ length: 17 }, (_, index) => `<link rel="stylesheet" href="css/s${index}.css">`).join('\n');
            const files = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`public/css/s${index}.css`, '']));
            const root = createCheckout('over-budget', links, files);

            const result = start([path.join('scripts', 'check-frontend-budgets.js')], root);

            expect(result.status).toBe(1);
            expect(result.stdout).toContain('Blocking stylesheets: 17, 0.0 KiB');
            expect(result.stderr).toContain('Blocking stylesheet count 17 exceeds budget 16.');
        });

        test('is 1 and names the asset when index.html references a file that does not exist', () => {
            const root = createCheckout('missing-asset', '<link rel="stylesheet" href="css/gone.css">\n');

            const result = start([path.join('scripts', 'check-frontend-budgets.js')], root);

            expect(result.status).toBe(1);
            expect(result.stderr).toContain('Referenced asset is missing: css/gone.css');
        });
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

describe('the asset snapshot of a fixture tree', () => {
    const tempRoots = [];

    const FIXTURE_FILES = {
        'public/index.html': [
            '<!doctype html><html><head>',
            '<link rel="stylesheet" href="style.css?v=1">',
            '<link rel="stylesheet" href="/css/screen-only.css" media="screen">',
            '<link rel="stylesheet" href="css/narrow.css" media="(max-width: 768px)">',
            '<link rel="stylesheet" href="css/wide.css" media="(min-width: 1200px) and (orientation: landscape)">',
            '<link rel="stylesheet" href="css/print.css" media="print">',
            '<link rel="stylesheet" href="css/user.css">',
            '<link rel="icon" href="favicon.ico">',
            '<script src="scripts/boot.js"></script>',
            '<script type="module" src="/scripts/main.js?v=2"></script>',
            '<script>inline();</script>',
            '</head><body></body></html>',
        ].join('\n'),
        'public/style.css': [
            '@charset "utf-8";',
            '@import url("css/relative.css");',
            '@import url(\'/lib/root-relative.css?v=3\');',
            '@import \'css/with-media.css\' screen and (min-width: 600px);',
            '@import url(css/unquoted.css) layer(base);',
            '@IMPORT "css/uppercase.css";',
            '@import url("css/relative.css?v=9");',
            '/* @import url("css/commented-out.css"); */',
            '@import url("https://example.test/remote.css");',
            '@import url("//cdn.example.test/protocol-relative.css");',
            '@import "css/cycle-a.css";',
            'body { background: url("img/a.png"); }',
            '',
        ].join('\n'),
        'public/css/relative.css': '@import "nested.css";\n.relative { color: red; }\n',
        'public/css/nested.css': '@import "../lib/shared.css";\n.nested { color: red; }\n',
        'public/lib/shared.css': '.shared { color: red; }\n',
        'public/lib/root-relative.css': 'a { }\r\nb { }\r\n',
        'public/css/with-media.css': '.with-media { color: red; }\n',
        'public/css/unquoted.css': '.unquoted { color: red; }\n',
        'public/css/uppercase.css': '.uppercase { color: red; }\n',
        'public/css/cycle-a.css': '@import "cycle-b.css";\n',
        'public/css/cycle-b.css': '@import "cycle-a.css";\n',
        'public/css/screen-only.css': '.screen-only { color: red; }\n',
        'public/css/narrow.css': '.narrow { color: red; }\n',
        'public/css/wide.css': '.wide { color: red; }\n',
        'public/scripts/boot.js': 'export {};\n',
        'public/scripts/main.js': 'export {};\r\nexport {};\r\n',
        'public/css/sillybunny-one.css': [
            '/* will-change: transform; backdrop-filter: blur(1px); */',
            '.a { will-change: transform; }',
            '.b { -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); }',
            '.c { backdrop-filter: blur(2px); }',
            '',
        ].join('\n'),
        'public/css/sillybunny-two.css': '.d { will-change : opacity; }\n',
        'public/css/sillybunny-three.css': '.e { color: red; }\n',
        'public/css/not-fork.css': '.f { will-change: transform; backdrop-filter: blur(8px); }\n',
        ...LARGE_EXTENSION_FILES,
        'public/scripts/extensions/tts/lib/kokoro.web.js': 'x'.repeat(10),
    };

    afterAll(() => {
        for (const root of tempRoots) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    function createTree(overrides = {}) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-budget-tree-'));
        tempRoots.push(root);
        writeTree(root, { ...FIXTURE_FILES, ...overrides });
        return root;
    }

    const textSize = content => Buffer.byteLength(content.replace(/\r\n/g, '\n'), 'utf8');

    test('lists blocking and width-media stylesheets and startup scripts as index.html declares them', () => {
        const snapshot = collectFrontendAssetSnapshot(createTree());

        expect(snapshot.errors).toEqual([]);
        expect(snapshot.blockingStylesheets).toEqual([
            { href: 'style.css?v=1', size: textSize(FIXTURE_FILES['public/style.css']) },
            { href: '/css/screen-only.css', size: textSize(FIXTURE_FILES['public/css/screen-only.css']) },
            { href: 'css/user.css', size: 0 },
        ]);
        expect(snapshot.widthMediaStylesheets).toEqual([
            { href: 'css/narrow.css', size: textSize(FIXTURE_FILES['public/css/narrow.css']) },
            { href: 'css/wide.css', size: textSize(FIXTURE_FILES['public/css/wide.css']) },
        ]);
        expect(snapshot.widthMediaStylesheetBytes).toBe(textSize(FIXTURE_FILES['public/css/narrow.css']) + textSize(FIXTURE_FILES['public/css/wide.css']));
        expect(snapshot.startupScripts).toEqual([
            { src: 'scripts/boot.js', size: textSize(FIXTURE_FILES['public/scripts/boot.js']) },
            { src: '/scripts/main.js?v=2', size: textSize(FIXTURE_FILES['public/scripts/main.js']) },
        ]);
    });

    test('follows every kind of @import, once per file, in the order the sheets load them', () => {
        const snapshot = collectFrontendAssetSnapshot(createTree());

        expect(snapshot.errors).toEqual([]);
        expect(snapshot.importedStylesheets.map(asset => asset.href)).toEqual([
            'css/relative.css',
            'css/nested.css',
            'lib/shared.css',
            'lib/root-relative.css',
            'css/with-media.css',
            'css/unquoted.css',
            'css/uppercase.css',
            'css/cycle-a.css',
            'css/cycle-b.css',
        ]);
        expect(snapshot.importedStylesheetBytes).toBe(snapshot.importedStylesheets.reduce((total, asset) => total + asset.size, 0));
    });

    test('measures a root-relative import with LF line endings, and does not count a CRLF file larger', () => {
        const snapshot = collectFrontendAssetSnapshot(createTree());

        expect(snapshot.importedStylesheets.find(asset => asset.href === 'lib/root-relative.css').size).toBe(textSize('a { }\nb { }\n'));
        expect(snapshot.startupScripts.find(asset => asset.src === '/scripts/main.js?v=2').size).toBe(textSize('export {};\nexport {};\n'));
    });

    test('counts will-change and backdrop-filter declarations of fork sheets only, with a -webkit- companion as a second declaration', () => {
        const { forkCssHazards } = collectFrontendAssetSnapshot(createTree());

        expect(forkCssHazards).toEqual({
            willChange: 2,
            backdropFilter: 3,
            files: [
                { file: 'sillybunny-one.css', willChange: 1, backdropFilter: 3 },
                { file: 'sillybunny-two.css', willChange: 1, backdropFilter: 0 },
            ],
        });
    });

    test('measures the large extension assets', () => {
        const { largeExtensionAssets } = collectFrontendAssetSnapshot(createTree());

        expect(largeExtensionAssets).toEqual([
            { asset: 'scripts/extensions/tts/lib/kokoro.web.js', size: 10 },
            { asset: 'scripts/extensions/gallery/jquery.nanogallery2.min.js', size: 0 },
            { asset: 'scripts/extensions/sillybunny-debugger/lib/eruda.js', size: 0 },
        ]);
    });

    describe('budgets set to the measured values', () => {
        const budgetsAt = snapshot => ({
            blockingStylesheetCount: snapshot.blockingStylesheets.length,
            blockingStylesheetBytes: snapshot.blockingStylesheetBytes,
            widthMediaStylesheetCount: snapshot.widthMediaStylesheets.length,
            widthMediaStylesheetBytes: snapshot.widthMediaStylesheetBytes,
            importedStylesheetCount: snapshot.importedStylesheets.length,
            importedStylesheetBytes: snapshot.importedStylesheetBytes,
            startupScriptCount: snapshot.startupScripts.length,
            startupScriptBytes: snapshot.startupScriptBytes,
            extensionLargeAssetBytes: 10,
            forkWillChangeCount: snapshot.forkCssHazards.willChange,
            forkBackdropFilterCount: snapshot.forkCssHazards.backdropFilter,
        });

        test('pass', () => {
            const snapshot = collectFrontendAssetSnapshot(createTree());

            expect(evaluateFrontendBudgets(snapshot, budgetsAt(snapshot))).toEqual([]);
        });

        test.each([
            ['blockingStylesheetCount', 'Blocking stylesheet count 3 exceeds budget 2.'],
            ['blockingStylesheetBytes', 'Blocking stylesheet bytes'],
            ['widthMediaStylesheetCount', 'Width-media stylesheet count 2 exceeds budget 1.'],
            ['widthMediaStylesheetBytes', 'Width-media stylesheet bytes'],
            ['importedStylesheetCount', 'Imported stylesheet count 9 exceeds budget 8.'],
            ['importedStylesheetBytes', 'Imported stylesheet bytes'],
            ['startupScriptCount', 'Startup script count 2 exceeds budget 1.'],
            ['startupScriptBytes', 'Startup script bytes'],
            ['extensionLargeAssetBytes', 'scripts/extensions/tts/lib/kokoro.web.js is'],
            ['forkWillChangeCount', 'Fork CSS will-change declarations 2 exceed budget 1;'],
            ['forkBackdropFilterCount', 'Fork CSS backdrop-filter declarations 3 exceed budget 2'],
        ])('fail on %s only when the measured value is one over', (budgetName, expectedMessage) => {
            const snapshot = collectFrontendAssetSnapshot(createTree());
            const budgets = budgetsAt(snapshot);

            const failures = evaluateFrontendBudgets(snapshot, { ...budgets, [budgetName]: budgets[budgetName] - 1 });

            expect(failures).toEqual([expect.stringContaining(expectedMessage)]);
        });
    });

    describe('references that cannot be measured', () => {
        test('are reported as errors, and an error is a failure', () => {
            const root = createTree({ 'public/css/relative.css': '@import "gone.css";\n' });
            fs.rmSync(path.join(root, 'public', 'css', 'screen-only.css'));
            fs.rmSync(path.join(root, 'public', 'scripts', 'boot.js'));

            const snapshot = collectFrontendAssetSnapshot(root);

            expect(snapshot.errors).toEqual([
                'Referenced asset is missing: /css/screen-only.css',
                'Referenced asset is missing: css/gone.css',
                'Referenced asset is missing: scripts/boot.js',
            ]);
            expect(evaluateFrontendBudgets(snapshot, FRONTEND_BUDGETS)).toEqual(expect.arrayContaining(snapshot.errors));
        });

        test('include an import that leaves the public directory, which is not read', () => {
            const root = createTree({
                'public/style.css': '@import "../outside.css";\n@import url("/../outside.css");\n',
                'outside.css': '.outside { will-change: transform; }\n@import "secret.css";\n',
                'secret.css': '.secret { color: red; }\n',
            });

            const snapshot = collectFrontendAssetSnapshot(root);

            expect(snapshot.errors).toEqual(['Asset path escapes public directory: ../outside.css']);
            expect(snapshot.importedStylesheets).toEqual([{ href: '../outside.css', size: 0 }]);
        });
    });
});
