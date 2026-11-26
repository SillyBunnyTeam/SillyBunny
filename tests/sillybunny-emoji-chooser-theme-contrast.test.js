import { describe, expect, test } from '@jest/globals';
import { parse } from '@adobe/css-tools';
import { readdirSync, readFileSync } from 'node:fs';

import { colourOf, contrastRatio, displayed, paint } from './helpers/css-colour.js';
import { rootScopeOf, toneOf } from './helpers/toast-theme-colours.js';

// The emoji chooser on every bundled theme, read from the stylesheet and the theme files without a browser, as
// sillybunny-conversation-theme-contrast.test.js reads the list. The chooser sits on two layers: the popover of a desktop
// (`--sb-layer-popover`) and the bottom sheet of a phone (`--sb-layer-drawer`). Text keeps 4.5:1; an icon and a ring keep 3:1
// (WCAG 1.4.11). The emoji themselves are colour glyphs and have no ratio.
const themesDirectory = new URL('../default/content/themes/', import.meta.url);
const themeFiles = readdirSync(themesDirectory).filter(file => file.endsWith('.json')).sort();
const themes = themeFiles.map(file => JSON.parse(readFileSync(new URL(file, themesDirectory), 'utf8')));

const TEXT_CONTRAST = 4.5;
const NON_TEXT_CONTRAST = 3;

/**
 * The placeholder of the search entry is `--sb-input-placeholder`, which every search field of the app uses and which is
 * under 4.5:1 on its tint in these themes: the same gap that sillybunny-conversation-theme-contrast.test.js lists for the
 * secondary text of the list. No rule of the chooser can raise it without a token of its own, which is for the
 * maintainers to decide. The test stays green and lists them: a theme that stops failing makes its test fail until it is
 * taken out here, and a new failure fails until it is fixed or added.
 */
const PLACEHOLDER_BELOW_THE_FLOOR = [
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
];

const BELOW_THE_FLOOR = {
    'search placeholder on the popover': PLACEHOLDER_BELOW_THE_FLOOR,
    'search placeholder on the sheet': PLACEHOLDER_BELOW_THE_FLOOR,
};

const LAYERS = [['popover', '--sb-layer-popover'], ['sheet', '--sb-layer-drawer']];

/** The pairs of a theme: [name, ratio, floor]. */
function pairsOf(theme) {
    const root = rootScopeOf(theme);
    const token = name => colourOf(`var(${name})`, root);
    const ink = token('--SmartThemeBodyColor');
    const secondary = token('--sb-input-placeholder');
    const accent = token('--sb-accent');
    const ratio = (colour, surface) => contrastRatio(paint(colour, surface), surface);
    const pairs = [];
    for (const [layerName, layerToken] of LAYERS) {
        const layer = displayed(token(layerToken));
        const entry = paint(token('--sb-input-bg'), layer);
        const current = paint(token('--sb-flat-selected-bg'), layer);
        pairs.push(
            [`heading and message on the ${layerName}`, ratio(ink, layer), TEXT_CONTRAST],
            [`search text on the ${layerName}`, ratio(ink, entry), TEXT_CONTRAST],
            [`search placeholder on the ${layerName}`, ratio(secondary, entry), TEXT_CONTRAST],
            [`section button on the ${layerName}`, ratio(secondary, layer), NON_TEXT_CONTRAST],
            [`current section button on the ${layerName}`, ratio(ink, current), NON_TEXT_CONTRAST],
            [`picked ring on the ${layerName}`, ratio(accent, layer), NON_TEXT_CONTRAST],
        );
    }
    return pairs;
}

const failingOf = theme => pairsOf(theme).filter(([, value, floor]) => value < floor).map(([name]) => name);
const knownFor = themeName => Object.entries(BELOW_THE_FLOOR).filter(([, names]) => names.includes(themeName)).map(([pair]) => pair);

const chooserCss = parse(readFileSync(new URL('../public/css/sillybunny-emoji-chooser.css', import.meta.url), 'utf8'));
const colourOfRule = (selector, property = 'color') => {
    const rules = chooserCss.stylesheet.rules.filter(item => item.type === 'rule' && item.selectors.includes(selector));
    return rules.flatMap(rule => rule.declarations).filter(declaration => declaration.property === property).at(-1)?.value;
};

describe('the emoji chooser on every bundled theme', () => {
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

    test.each(themes.map(theme => [theme.name, theme]))('%s keeps the text at 4.5:1 and the icons and rings at 3:1, but for the gap that is listed', (_name, theme) => {
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

    test('is a measure of the colours that the stylesheet gives each part', () => {
        expect(colourOfRule('.sb-emoji-heading')).toBe('var(--SmartThemeBodyColor)');
        expect(colourOfRule('.sb-emoji-message,\n.sb-emoji-empty') ?? colourOfRule('.sb-emoji-message')).toBe('var(--SmartThemeBodyColor)');
        expect(colourOfRule('.sb-emoji-search-entry')).toBe('var(--SmartThemeBodyColor)');
        expect(colourOfRule('.sb-emoji-category')).toBe('var(--sb-input-placeholder)');
        expect(colourOfRule('.sb-emoji-category[aria-current=\'true\']')).toBe('var(--SmartThemeBodyColor)');
        expect(colourOfRule('.sb-emoji-chooser', '--sb-emoji-picked-ring')).toBe('inset 0 0 0 1px var(--sb-accent)');
        // The entry has the tint that the pair is measured on.
        expect(colourOfRule('.sb-emoji-search-entry', 'background')).toBe('var(--sb-input-bg)');
    });

    test('measures a weak body colour as weak', () => {
        const weak = { ...themes.find(theme => theme.name === 'Libadwaita Dark'), main_text_color: 'rgba(110, 110, 110, 1)' };

        expect(failingOf(weak)).toContain('heading and message on the popover');
    });
});
