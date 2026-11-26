import { describe, expect, test } from '@jest/globals';
import { parse } from '@adobe/css-tools';
import { readdirSync, readFileSync } from 'node:fs';

import { colourOf, contrastRatio, displayed, paint } from './helpers/css-colour.js';
import { rootScopeOf, toneOf } from './helpers/toast-theme-colours.js';

// The text of Conversation Mode on every bundled theme, read from the stylesheets and the theme files without a browser:
// the list (names and secondary text, at rest and on the selected row), the header (name and status line) and the details
// window (secondary text and row text). DESIGN.md: row text, subtitles included, keeps 4.5:1, and secondary text takes
// `--sb-input-placeholder`. The numbers match the browser audit of the list in review/phase6/list/theme-audit.json to 0.11.
const themesDirectory = new URL('../default/content/themes/', import.meta.url);
const themeFiles = readdirSync(themesDirectory).filter(file => file.endsWith('.json')).sort();
const themes = themeFiles.map(file => JSON.parse(readFileSync(new URL(file, themesDirectory), 'utf8')));

const TEXT_CONTRAST = 4.5;
/** The floor of a pair that is not text: the ring of a pressed chip is a shape that WCAG 1.4.11 asks 3:1 of. */
const NON_TEXT_CONTRAST = 3;
const FLOOR_OF = Object.freeze({ 'pressed reaction chip ring': NON_TEXT_CONTRAST });

/**
 * The pairs that fail on the theme tokens as they are. The gap is in `--sb-input-placeholder` (the body colour at 78% over
 * the theme's tint), which every list of the app uses or, with `--sb-muted-fg`, a weaker one; no rule of the mode can
 * raise it without a token of its own, which is a change of the shared tokens for the maintainers to decide. The count on
 * Accent is the same kind of gap: `--sb-on-solid-accent` on `--sb-accent` is under 4.5:1 in the light themes that are listed,
 * and it is the pair that the unread counts of the list use too. The test
 * stays green and lists them: a pair that stops failing makes its theme's test fail until the theme is taken out here,
 * and a new failure fails until it is fixed or added.
 */
const BELOW_THE_FLOOR = {
    'list secondary text': [
        'Dracula Light',
        'Dracula',
        'Everforest Dark',
        'Everforest Light',
        'Glacier',
        'Gruvbox Light',
        'Lime',
        'Magenta',
        'Mint',
        'Nord Light',
        'Nord',
        'Rose',
        'Rosé Pine Dawn',
        'Slate',
        'Solarized Dark',
        'Solarized Light',
        'Sonokai Andromeda Light',
        'Sonokai Atlantis Light',
        'Sonokai Atlantis',
        'Sonokai Default Light',
        'Sonokai Espresso Light',
        'Sonokai Maia Light',
        'Tokyo Night Day',
        'Tokyo Night',
    ],
    'list name on the selected row': [
        'Lime',
        'Solarized Dark',
    ],
    // The body colour of Solarized Dark is the one that already falls short on the selected row of the list; a tint of Accent
    // of 8% at rest and 16% pressed (DESIGN.md Chips) takes it to 4.07:1 and 3.64:1.
    'reaction chip text': [
        'Solarized Dark',
    ],
    'pressed reaction chip text': [
        'Solarized Dark',
    ],
    'header status': [
        'Dracula Light',
        'Everforest Light',
        'Gruvbox Light',
        'Nord Light',
        'Rose',
        'Rosé Pine Dawn',
        'Solarized Dark',
        'Solarized Light',
        'Sonokai Andromeda Light',
        'Sonokai Atlantis Light',
        'Sonokai Default Light',
        'Sonokai Espresso Light',
        'Sonokai Maia Light',
        'Tokyo Night Day',
    ],
    'details secondary text on the window layer': [
        'Dracula',
        'Everforest Light',
        'Glacier',
        'Lime',
        'Magenta',
        'Mint',
        'Nord Light',
        'Rose',
        'Rosé Pine Dawn',
        'Slate',
        'Solarized Dark',
        'Solarized Light',
        'Sonokai Andromeda Light',
        'Sonokai Atlantis Light',
        'Sonokai Atlantis',
        'Sonokai Default Light',
        'Sonokai Espresso Light',
        'Sonokai Maia Light',
        'Tokyo Night Day',
    ],
    'unread count on Accent': [
        'Catppuccin Latte',
        'Dracula Light',
        'Everforest Light',
        'Gruvbox Light',
        'Hacker-Terminal-Light',
        'Libadwaita Light',
        'Nord Light',
        'Rosé Pine Dawn',
        'Solarized Light',
        'Sonokai Andromeda Light',
        'Sonokai Atlantis Light',
        'Sonokai Default Light',
        'Sonokai Espresso Light',
        'Sonokai Maia Light',
        'Sonokai Shusia Light',
        'Tokyo Night Day',
        'Verdant Light',
    ],
    'details secondary text on a row': [
        'Cerulean',
        'Dracula Light',
        'Dracula',
        'Everforest Dark',
        'Everforest Light',
        'Glacier',
        'Gruvbox Light',
        'Lime',
        'Magenta',
        'Mint',
        'Nord Light',
        'Nord',
        'Rose',
        'Rosé Pine Dawn',
        'Slate',
        'Solarized Dark',
        'Solarized Light',
        'Sonokai Andromeda Light',
        'Sonokai Atlantis Light',
        'Sonokai Atlantis',
        'Sonokai Default Light',
        'Sonokai Default',
        'Sonokai Espresso Light',
        'Sonokai Maia Light',
        'Tokyo Night Day',
        'Tokyo Night',
    ],
};

/** The pairs of a theme: [name, ratio]. The selected row is the one at rest, which stays for as long as its conversation is open; a hover or a press is a passing state. */
function pairsOf(theme) {
    const root = rootScopeOf(theme);
    const token = name => colourOf(`var(${name})`, root);
    const ink = token('--SmartThemeBodyColor');
    const secondary = token('--sb-input-placeholder');
    const sidebar = displayed(token('--sb-sidebar-bg'));
    const selected = paint(token('--sb-flat-selected-bg'), sidebar);
    const view = displayed(token('--sb-layer-view'));
    const windowLayer = displayed(token('--sb-layer-window'));
    const row = paint(token('--sb-card-fill'), windowLayer);
    const accent = displayed(token('--sb-accent'));
    const onAccent = token('--sb-on-solid-accent');
    const ratio = (colour, surface) => contrastRatio(paint(colour, surface), surface);
    const chipTint = percent => paint(colourOf(`color-mix(in srgb, var(--sb-accent) ${percent}%, transparent)`, root), view);
    return [
        ['list name', ratio(ink, sidebar)],
        ['list secondary text', ratio(secondary, sidebar)],
        ['list name on the selected row', ratio(ink, selected)],
        ['header name', ratio(ink, view)],
        ['header status', ratio(secondary, view)],
        ['details row text', ratio(ink, row)],
        ['details secondary text on the window layer', ratio(secondary, windowLayer)],
        ['details secondary text on a row', ratio(secondary, row)],
        // The count on the chat mode button and the counts of the list are the ink of a solid Accent fill on Accent.
        ['unread count on Accent', ratio(onAccent, accent)],
        // A reaction chip sits on the timeline: its ink is the body colour, over a tint of Accent that is 8% at rest and 16% when it is pressed.
        ['reaction chip text', ratio(ink, chipTint(8))],
        ['pressed reaction chip text', ratio(ink, chipTint(16))],
        ['pressed reaction chip ring', contrastRatio(accent, view)],
    ];
}

const failingOf = theme => pairsOf(theme).filter(([name, ratio]) => ratio < (FLOOR_OF[name] ?? TEXT_CONTRAST)).map(([name]) => name);
const knownFor = themeName => Object.entries(BELOW_THE_FLOOR).filter(([, names]) => names.includes(themeName)).map(([pair]) => pair);

describe('the text of Conversation Mode on every bundled theme', () => {
    test('covers every bundled theme, in both tones', () => {
        expect(themes.length).toBeGreaterThan(0);
        expect(themes.map(theme => `${theme.name}.json`)).toEqual(themeFiles);
        expect(new Set(themes.map(toneOf))).toEqual(new Set(['dark', 'light']));
    });

    test('lists a known gap only for a theme that has the bundled file', () => {
        const names = new Set(themes.map(theme => theme.name));
        for (const listed of Object.values(BELOW_THE_FLOOR).flat()) {
            expect(names.has(listed)).toBe(true);
        }
    });

    test.each(themes.map(theme => [theme.name, theme]))('%s keeps the text of the mode at 4.5:1, but for the gaps that are listed', (_name, theme) => {
        const failing = failingOf(theme);
        const known = knownFor(theme.name);

        expect({
            belowAndNotListed: failing.filter(pair => !known.includes(pair)),
            listedAndNowHolding: known.filter(pair => !failing.includes(pair)),
        }).toEqual({ belowAndNotListed: [], listedAndNowHolding: [] });
    });

    test('reads the same pairs for every theme', () => {
        const names = themes.map(theme => pairsOf(theme).map(([name]) => name).join('|'));

        expect(new Set(names).size).toBe(1);
    });

    test('is a measure of the colours that the stylesheets give the secondary text, which is the placeholder token', () => {
        const colourOfRule = (file, selector) => {
            const sheet = parse(readFileSync(new URL(`../public/css/${file}`, import.meta.url), 'utf8'));
            const rule = sheet.stylesheet.rules.find(item => item.type === 'rule' && item.selectors.includes(selector));
            return rule?.declarations.find(declaration => declaration.property === 'color')?.value;
        };

        for (const selector of ['.sb-conversation-header-status', '.sb-conversation-list-item-preview', '.sb-conversation-list-zone-hint']) {
            expect(colourOfRule('sillybunny-conversation.css', selector)).toBe('var(--sb-input-placeholder)');
        }
        for (const selector of ['.sb-details-hero__subtitle', '.sb-details-page .ds-pref-group-subtitle', '.sb-details-count', '.sb-details-note', '.sb-details-page .ds-entity-row__preview']) {
            expect(colourOfRule('sillybunny-conversation-details.css', selector)).toBe('var(--sb-input-placeholder)');
        }
    });

    test('measures a weak secondary colour as weak', () => {
        const weak = { ...themes.find(theme => theme.name === 'Libadwaita Dark'), main_text_color: 'rgba(110, 110, 110, 1)' };

        expect(failingOf(weak)).toContain('list secondary text');
    });
});
