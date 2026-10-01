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
// sillybunny-theme.css raised 161 -> 165: the sheet was already at 163. The
// libadwaita range slider adds four track declarations that must beat the
// style.css .neo-range-slider !important rules; two redundant reduced-motion
// overrides already covered by the universal selector were removed.
// sillybunny-tabs.css raised 386 -> 389: the favourites bar fix re-shows the
// bar on the character tabs with display:flex !important and
// visibility:visible !important to beat the JS inline hide, and pins
// #HotSwapWrapper padding:0 !important against the base flex-container rules.
// sillybunny-tabs.css raised 389 -> 390: one grouped placeholder color for the
// three search fields must beat style.css's !important SmartThemeEmColor rule.
// sillybunny-tabs.css raised 390 -> 398: v1.9.0 libadwaita shell overhaul adds
// shell navigation, desktop/mobile header surfaces, drawers, and mobile nav.
// sillybunny-tabs.css lowered 398 -> 394: the #top-bar glow/no-blur overrides
// moved to the source rule in sillybunny-theme.css.
// sillybunny-theme.css raised 165 -> 245: v1.9.0 overlay surfaces (options and
// extensions menus, toasts, composer, send button, placeholders) must beat
// upstream !important and inline rules. Flags on menus, popups, select2,
// ctx-menus, and tooltips were removed after computed-style probes showed no diff.
// sillybunny-paper-theme.css lowered 55 -> 51: hard-coded colour overrides removed.
// sillybunny-theme.css raised 245 -> 248: the phone composer goes full-bleed against the
// !important frame rule, and the send button beats style.css's 0.7 composer-button dimming.
// sillybunny-tabs.css raised 394 -> 398: the joined desktop bottom-bar stack must square the
// composer's top corners against the !important #send_form frame radius in sillybunny-theme.css.
// sillybunny-mobile-shell.css raised 684 -> 685: the circular send/stop button beats the
// !important 10px/9px radius in upstream mobile-styles.css.
// sillybunny-mobile-shell.css raised 685 -> 688: the libadwaita composer entry's rest border
// and focus border-color/box-shadow must beat upstream mobile-styles.css !important rules.
const FORK_SHEET_IMPORTANT_BUDGETS = Object.freeze({
    'sillybunny-mobile-shell.css': 688,
    'sillybunny-paper-theme.css': 51,
    'sillybunny-tabs.css': 398,
    'sillybunny-chat-styles.css': 225,
    'sillybunny-theme.css': 248,
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

    test('leaves reasoning boxes on the shared desktop treatment', () => {
        expect(paperThemeCss).not.toContain('--thought-box-');
        expect(paperThemeCss).not.toMatch(/\.mes_reasoning_header\s*\{/);
        expect(paperThemeCss).not.toMatch(/\.mes_reasoning\s*\{/);
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
