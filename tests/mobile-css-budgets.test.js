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

function countBraceDepthBefore(cssSource, index) {
    let depth = 0;

    for (const char of cssSource.slice(0, index)) {
        if (char === '{') {
            depth += 1;
        } else if (char === '}') {
            depth -= 1;
        }
    }

    return depth;
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
const FORK_SHEET_IMPORTANT_BUDGETS = Object.freeze({
    'sillybunny-mobile-shell.css': 0,
    'sillybunny-tabs.css': 384,
    'sillybunny-chat-styles.css': 225,
    'sillybunny-theme.css': 137,
});

const FORK_SHEET_LAYERS = Object.freeze({
    'sillybunny-theme.css': 'sb-theme',
    'sillybunny-tabs.css': 'sb-tabs',
    'sillybunny-chat-styles.css': 'sb-chat',
    'sillybunny-mobile-shell.css': 'sb-shell',
});

const FORK_LAYER_ORDER = 'sb-theme, sb-tabs, sb-chat, sb-shell';
const FORK_UNLAYERED_GUARD_PINS = Object.freeze({
    'sillybunny-theme.css': [
        '/* Must beat upstream public/style.css:91 :root. */',
        '/* Must beat upstream public/style.css:5996 #CustomCSS-textAreaBlock. */',
    ],
    'sillybunny-tabs.css': [
        '/* Must beat upstream public/style.css:862/864/865/866/867/868/869 #top-bar. */',
        '/* Must beat upstream public/style.css:6051 .drawer. */',
        '/* Must beat upstream public/style.css:6267 .fillRight. */',
    ],
    'sillybunny-chat-styles.css': [
        '/* Must beat upstream public/style.css:1315 .mes. */',
        '/* Must beat upstream public/style.css:1662 .mes_text. */',
        '/* Must beat upstream public/style.css:1378 .swipe_left, .swipe_right. */',
    ],
    'sillybunny-mobile-shell.css': [
        '/* Must beat upstream public/style.css:971 #form_sheld. */',
        '/* Must beat upstream public/css/mobile-styles.css:1096 #send_form. */',
        '/* Must beat the unlayered base/focus #send_form guards while generating. */',
        '/* Must beat upstream public/css/tags.css:162 .rm_tag_controls. */',
    ],
});
const FORK_DISTINCT_BREAKPOINT_BUDGET = 6;

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

    test('fork sheets declare the canonical layer order and wrappers', () => {
        const normalizedThemeSource = forkSheetSources['sillybunny-theme.css'].replace(/\r\n/g, '\n');

        expect(normalizedThemeSource.startsWith(`@layer ${FORK_LAYER_ORDER};\n\n@layer ${FORK_SHEET_LAYERS['sillybunny-theme.css']} {`)).toBe(true);

        for (const [sheetName, layerName] of Object.entries(FORK_SHEET_LAYERS)) {
            expect(forkSheetSources[sheetName]).toContain(`@layer ${layerName} {`);
        }
    });

    test('mobile shell owns mobile top-bar surface overrides', () => {
        expect(forkSheetSources['sillybunny-theme.css']).not.toContain(':root:not([data-sb-theme]) #top-bar,');
        expect(forkSheetSources['sillybunny-theme.css']).not.toContain(":root[data-sb-theme='clean-minimal'] #top-bar::before,");
        expect(forkSheetSources['sillybunny-mobile-shell.css']).toContain(':root:not([data-sb-theme]) #top-bar,');
        expect(forkSheetSources['sillybunny-mobile-shell.css']).toContain(":root[data-sb-theme='clean-minimal'] #top-bar::before");
        expect(forkSheetSources['sillybunny-mobile-shell.css']).toContain('background: var(--sb-topbar-surface-bg);');
        expect(forkSheetSources['sillybunny-mobile-shell.css']).toContain('opacity: var(--sb-shell-surface-opacity);');
    });

    test('mobile shell owns mobile composer and bottom-chat responsive overrides', () => {
        const normalizedThemeSource = forkSheetSources['sillybunny-theme.css'].replace(/\r\n/g, '\n');
        const normalizedTabsSource = forkSheetSources['sillybunny-tabs.css'].replace(/\r\n/g, '\n');
        const normalizedShellSource = forkSheetSources['sillybunny-mobile-shell.css'].replace(/\r\n/g, '\n');

        expect(normalizedThemeSource).not.toContain('/* Override any optional theme-specific sizing. */');
        expect(normalizedThemeSource).not.toContain(":root:not([data-sb-theme]) #send_form,\n    :root[data-sb-theme='clean-minimal'] #send_form");
        expect(normalizedTabsSource).not.toContain('@media screen and (max-width: 1000px) {\n    #sb-bottom-chat-bar');
        expect(normalizedTabsSource).not.toContain('@media screen and (max-width: 420px) {\n    #sb-bottom-chat-bar');

        expect(normalizedTabsSource).toContain('@media screen and (min-width: 769px) and (max-width: 1000px) {\n    #sb-bottom-chat-bar');
        expect(normalizedShellSource).toContain('/* Keep phone-width composer surface overrides in the mobile shell sheet. */');
        expect(normalizedShellSource).toContain('padding-block-end: max(var(--sb-chat-composer-edge-gap), env(safe-area-inset-bottom, 0px));');
        expect(normalizedShellSource).toContain('#sb-bottom-chat-bar:not(.sb-bottom-chat-search-open) .sb-bottom-chat-search-field');
    });

    test('fork sheets keep verified upstream collision guards outside layers', () => {
        for (const [sheetName, pins] of Object.entries(FORK_UNLAYERED_GUARD_PINS)) {
            const cssSource = forkSheetSources[sheetName];
            const guardIndex = cssSource.indexOf('/* Unlayered fork cascade guards');

            expect(guardIndex).toBeGreaterThan(-1);
            expect(countBraceDepthBefore(cssSource, guardIndex)).toBe(0);

            for (const pin of pins) {
                expect(cssSource).toContain(pin);
            }
        }
    });
});

describe('index.html mobile stylesheet gates', () => {
    const indexHtml = readPublicFile('index.html');
    const stylesheetTags = [...indexHtml.matchAll(/<link\s[^>]*rel="stylesheet"[^>]*>/g)].map(match => match[0]);

    function findStylesheetTag(href) {
        return stylesheetTags.find(tag => tag.includes(`href="${href}?`) || tag.includes(`href="${href}"`));
    }

    test('mobile sheets keep their (max-width: 768px) media gates', () => {
        for (const href of ['css/mobile-styles.css', 'css/sillybunny-mobile-shell.css']) {
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
