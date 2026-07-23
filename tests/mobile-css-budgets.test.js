import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readPublicFile(...segments) {
    return readFileSync(path.join(repoRoot, 'public', ...segments), 'utf8');
}

function countImportant(cssSource) {
    return (cssSource.match(/!important/g) ?? []).length;
}

function getMediaQueryPxValues(cssSource) {
    const pxValues = new Set();

    for (const mediaMatch of cssSource.matchAll(/@media[^{]*/g)) {
        for (const pxMatch of mediaMatch[0].matchAll(/([0-9]+(?:\.[0-9]+)?)px/g)) {
            pxValues.add(pxMatch[1]);
        }
    }

    return pxValues;
}

// Ratchet budgets: ceilings match the measured state of staging when this
// test landed. Lower them as cleanup PRs land; never raise them without a
// review note explaining the regression.
//
// sillybunny-mobile-shell.css raised 664 -> 665: one display:none !important
// added to unconditionally hide the unused STscript play/pause/stop controls
// (.stscript_btn) in the mobile composer, overriding the display:flex !important
// that mobile-styles.css added in #533.
// sillybunny-mobile-shell.css raised 665 -> 677: phone-only edge-to-edge
// composer and safe-area overrides need to beat upstream mobile padding and
// border rules without affecting desktop.
// sillybunny-mobile-shell.css raised 677 -> 685: the unified composer surface
// and input state styling need to override upstream mobile composer rules.
// sillybunny-paper-theme.css starts at 55: the phone-only paper texture and
// chrome adjustment sheet is budgeted from introduction.
// sillybunny-theme.css raised 158 -> 161: the mobile character list needs to
// override upstream !important avatar alignment rules for missing avatars.
const FORK_SHEET_IMPORTANT_BUDGETS = Object.freeze({
    'sillybunny-mobile-shell.css': 685,
    'sillybunny-paper-theme.css': 55,
    'sillybunny-tabs.css': 386,
    'sillybunny-chat-styles.css': 225,
    'sillybunny-theme.css': 161,
});

const FORK_DISTINCT_BREAKPOINT_BUDGET = 18;

const forkSheetSources = Object.fromEntries(
    Object.keys(FORK_SHEET_IMPORTANT_BUDGETS).map(sheetName => [sheetName, readPublicFile('css', sheetName)]),
);

describe('mobile css ratchet budgets', () => {
    describe.each(Object.entries(FORK_SHEET_IMPORTANT_BUDGETS))('%s', (sheetName, importantBudget) => {
        test(`uses at most ${importantBudget} !important declarations`, () => {
            const importantCount = countImportant(forkSheetSources[sheetName]);

            expect(importantCount).toBeLessThanOrEqual(importantBudget);
        });
    });

    test(`fork sheets declare at most ${FORK_DISTINCT_BREAKPOINT_BUDGET} distinct media-query px values`, () => {
        const pxValues = new Set();

        for (const cssSource of Object.values(forkSheetSources)) {
            for (const pxValue of getMediaQueryPxValues(cssSource)) {
                pxValues.add(pxValue);
            }
        }

        const sortedPxValues = [...pxValues].sort((left, right) => Number(left) - Number(right));

        expect(sortedPxValues.length).toBeLessThanOrEqual(FORK_DISTINCT_BREAKPOINT_BUDGET);
    });
});

describe('paper texture regression guards', () => {
    const paperThemeCss = forkSheetSources['sillybunny-paper-theme.css'];

    test('keeps the base ambient body pseudo-element available', () => {
        expect(paperThemeCss).not.toMatch(/body::before\s*\{/);
        expect(paperThemeCss).toMatch(/body::after\s*\{/);
    });

    test('gates both page and message paper overlays behind texture opacity', () => {
        const bodyAfterRule = paperThemeCss.match(/body::after\s*\{[\s\S]*?\}/)?.[0] ?? '';
        const messageAfterRule = paperThemeCss.match(/\.mes::after\s*\{[\s\S]*?\}/)?.[0] ?? '';

        expect(bodyAfterRule).toContain('--sb-paper-texture-opacity');
        expect(messageAfterRule).toContain('--sb-paper-texture-opacity');
    });

    test('derives thought box colors from active SmartTheme tokens', () => {
        const thoughtBoxTokenBlock = paperThemeCss.match(/--thought-box-bg:[\s\S]*?--thought-box-accent:[^;]+;/)?.[0] ?? '';

        expect(thoughtBoxTokenBlock).toContain('--SmartThemeBlurTintColor');
        expect(thoughtBoxTokenBlock).toContain('--SmartThemeBodyColor');
        expect(thoughtBoxTokenBlock).toContain('--SmartThemeQuoteColor');
    });
});

describe('index.html mobile stylesheet gates', () => {
    const indexHtml = readPublicFile('index.html');
    const stylesheetTags = [...indexHtml.matchAll(/<link\s[^>]*rel="stylesheet"[^>]*>/g)].map(match => match[0]);

    function findStylesheetTag(href) {
        return stylesheetTags.find(tag => tag.includes(`href="${href}?`) || tag.includes(`href="${href}"`));
    }

    test('mobile sheets keep their (max-width: 768px) media gates', () => {
        for (const href of ['css/mobile-styles.css', 'css/sillybunny-paper-theme.css', 'css/sillybunny-mobile-shell.css']) {
            const tag = findStylesheetTag(href);

            expect(tag).toBeDefined();
            expect(tag).toContain('media="(max-width: 768px)"');
        }
    });

    test('fork sheets load after upstream styles and before user.css', () => {
        const loadOrder = [
            'style.css',
            'css/mobile-styles.css',
            'css/sillybunny-theme.css',
            'css/sillybunny-paper-theme.css',
            'css/sillybunny-tabs.css',
            'css/sillybunny-mobile-shell.css',
            'css/user.css',
        ].map(href => {
            const tag = findStylesheetTag(href);

            expect(tag).toBeDefined();

            return indexHtml.indexOf(tag);
        });

        expect(loadOrder).toEqual([...loadOrder].sort((left, right) => left - right));
    });
});
