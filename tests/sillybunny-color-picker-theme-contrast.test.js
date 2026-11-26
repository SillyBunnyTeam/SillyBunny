import { describe, expect, test } from '@jest/globals';
import { parse } from '@adobe/css-tools';
import { readdirSync, readFileSync } from 'node:fs';

import { colourOf, contrastRatio, displayed, paint } from './helpers/css-colour.js';
import { rootScopeOf, toneOf } from './helpers/toast-theme-colours.js';

// The colour picker's menu on every bundled theme, read from the stylesheet and the theme files without a browser, as
// sillybunny-emoji-chooser-theme-contrast.test.js reads the chooser. The menu sits on two layers: the popover of a desktop
// (`--sb-layer-popover`) and the dialog of a phone (`--sb-layer-dialog`). Text keeps 4.5:1; the thumb of a slider and a
// focus ring keep 3:1 (WCAG 1.4.11). Each colour is the one that the stylesheet gives the part, so a rule that changes
// changes the measure.
//
// Not measured here: the border and the fill of a field, which are 1.09:1 and 1.01:1 against the layer at the lowest, in
// every theme. They are the look that every field of the app has (`--sb-input-border`, `--sb-input-bg`), and a field of
// the picker is no different; a change belongs to the shared input, which is for the maintainers to decide.
const themesDirectory = new URL('../default/content/themes/', import.meta.url);
const themeFiles = readdirSync(themesDirectory).filter(file => file.endsWith('.json')).sort();
const themes = themeFiles.map(file => JSON.parse(readFileSync(new URL(file, themesDirectory), 'utf8')));

const TEXT_CONTRAST = 4.5;
const NON_TEXT_CONTRAST = 3;

/**
 * The focus ring is `--sb-focus-ring`, which every control of the app uses, and it is 2.93:1 on the layers of this theme.
 * No rule of the picker can raise it without a token of its own. The test stays green and lists it: a theme that stops
 * failing makes its test fail until it is taken out here, and a new failure fails until it is fixed or added.
 */
const BELOW_THE_FLOOR = {
    'focus ring on the popover': ['Solarized Dark'],
    'focus ring on the dialog': ['Solarized Dark'],
};

const LAYERS = [['popover', '--sb-layer-popover'], ['dialog', '--sb-layer-dialog']];

const pickerCss = parse(readFileSync(new URL('../public/css/sillybunny-color-picker.css', import.meta.url), 'utf8'));
const valueOfRule = (selector, property) => {
    const rules = pickerCss.stylesheet.rules.filter(item => item.type === 'rule' && item.selectors.includes(selector));
    return rules.flatMap(rule => rule.declarations).filter(declaration => declaration.property === property).at(-1)?.value;
};

const LABEL_SELECTOR = '.sb-color-picker-bar > span';
const FIELD_LABEL_SELECTOR = '.sb-color-picker-field > span';
const FIELD_SELECTOR = '.sb-color-picker-field input';
const THUMB_SELECTOR = '.sb-color-picker-menu input[type=\'range\']::-webkit-slider-thumb';

/** The pairs of a theme: [name, ratio, floor]. */
function pairsOf(theme) {
    const root = rootScopeOf(theme);
    const colour = value => colourOf(value, root);
    const token = name => colour(`var(${name})`);
    const ratio = (ink, surface) => contrastRatio(paint(ink, surface), surface);
    const pairs = [];
    for (const [layerName, layerToken] of LAYERS) {
        const layer = displayed(token(layerToken));
        const field = paint(colour(valueOfRule(FIELD_SELECTOR, 'background')), layer);
        pairs.push(
            [`title, value and close on the ${layerName}`, ratio(token('--SmartThemeBodyColor'), layer), TEXT_CONTRAST],
            [`slider label on the ${layerName}`, ratio(colour(valueOfRule(LABEL_SELECTOR, 'color')), layer), TEXT_CONTRAST],
            [`field label on the ${layerName}`, ratio(colour(valueOfRule(FIELD_LABEL_SELECTOR, 'color')), layer), TEXT_CONTRAST],
            [`text in a field on the ${layerName}`, ratio(colour(valueOfRule(FIELD_SELECTOR, 'color')), field), TEXT_CONTRAST],
            [`thumb of a slider on the ${layerName}`, ratio(colour(valueOfRule(THUMB_SELECTOR, 'background')), layer), NON_TEXT_CONTRAST],
            [`focus ring on the ${layerName}`, ratio(token('--sb-focus-ring'), layer), NON_TEXT_CONTRAST],
        );
    }
    return pairs;
}

const failingOf = theme => pairsOf(theme).filter(([, value, floor]) => value < floor).map(([name]) => name);
const knownFor = themeName => Object.entries(BELOW_THE_FLOOR).filter(([, names]) => names.includes(themeName)).map(([pair]) => pair);

describe('the colour picker on every bundled theme', () => {
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

    test.each(themes.map(theme => [theme.name, theme]))('%s keeps the text at 4.5:1 and the thumb and the ring at 3:1, but for the gap that is listed', (_name, theme) => {
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
        expect(valueOfRule(FIELD_SELECTOR, 'background')).toBe('var(--sb-input-bg)');
        expect(valueOfRule(FIELD_SELECTOR, 'color')).toBe('var(--SmartThemeBodyColor)');
        expect(valueOfRule(THUMB_SELECTOR, 'background')).toBe('var(--color-primary, var(--sb-accent))');
        // The menu itself and its title take the body colour that the pair of the title is measured with.
        expect(valueOfRule('.sb-color-picker-menu', 'color')).toBe('var(--SmartThemeBodyColor)');
        expect(valueOfRule('.sb-color-picker-menu', 'background')).toBe('var(--sb-layer-popover)');
    });

    test('measures a weak label colour as weak', () => {
        const weak = { ...themes.find(theme => theme.name === 'Libadwaita Dark'), main_text_color: 'rgba(110, 110, 110, 1)' };

        expect(failingOf(weak)).toContain('title, value and close on the popover');
    });
});
