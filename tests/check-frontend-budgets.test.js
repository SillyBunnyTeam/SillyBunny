import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    collectFrontendAssetSnapshot,
    countForkCssHazards,
    evaluateFrontendBudgets,
    FRONTEND_BUDGETS,
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
            widthMediaStylesheets: Array.from({ length: 4 }, (_, i) => ({ href: `m${i}.css`, size: 10 })),
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

    test('current repository passes every frontend budget without errors', () => {
        const snapshot = collectFrontendAssetSnapshot(repoRoot);
        const failures = evaluateFrontendBudgets(snapshot, FRONTEND_BUDGETS);
        expect(failures).toEqual([]);
        expect(snapshot.importedStylesheets.length).toBeLessThanOrEqual(FRONTEND_BUDGETS.importedStylesheetCount);
        expect(snapshot.forkCssHazards.willChange).toBeLessThanOrEqual(FRONTEND_BUDGETS.forkWillChangeCount);
        expect(snapshot.forkCssHazards.backdropFilter).toBeLessThanOrEqual(FRONTEND_BUDGETS.forkBackdropFilterCount);
    });
});
