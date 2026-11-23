import { describe, expect, test } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';

import { declarationsOf, parseStylesheet } from './helpers/css-colour.js';
import { STATUS_KINDS, layersOf, pairsOf, toneOf } from './helpers/toast-theme-colours.js';

const themesDirectory = new URL('../default/content/themes/', import.meta.url);
const themeFiles = readdirSync(themesDirectory).filter(file => file.endsWith('.json')).sort();
const themes = themeFiles.map(file => JSON.parse(readFileSync(new URL(file, themesDirectory), 'utf8')));
const themeNamed = (name) => themes.find(theme => theme.name === name);

/**
 * The cases that fail on the stylesheets as they are, by pair, with the cause. The suite stays green and still lists
 * them. A case that stops failing makes the test of its theme fail until the theme is taken out of its entry, and a new
 * failure makes it fail until it is fixed or added here. The failure message of a theme's test gives the ratio and the
 * colours of each case that is not listed.
 */
const KNOWN_FAILURES = [
    {
        pair: 'toast label',
        reason: [
            'On the dark tone the label is the body colour of the theme (`--sb-layer-toast-fg` is `--SmartThemeBodyColor`) on a layer that',
            'mixes 19% of that colour into the blur tint, so a body colour that is not white leaves less than 4.5:1. DESIGN.md (Toasts,',
            'Surface) asks for white ink in both tones, and only the light tone has it.',
        ].join(' '),
        themes: [
            'Everforest Dark',
            'Glacier',
            'Lime',
            'Magenta',
            'Mint',
            'Nord',
            'Rose',
            'Slate',
            'Solarized Dark',
            'Sonokai Atlantis',
        ],
    },
    {
        pair: 'toast error glyph',
        reason: [
            'The glyph is the status colour lifted to OKLab lightness 0.76 (`--sb-toast-status`). The light-tone toast layer is the body',
            'colour mixed 14% toward white, a mid tone in a theme with a lighter body colour, and the lifted colour stays under 3:1 on it.',
            'Lime is a dark-tone theme whose layer is a mid-tone green.',
        ].join(' '),
        themes: [
            'Catppuccin Latte',
            'Dracula Light',
            'Everforest Light',
            'Gruvbox Light',
            'Hacker-Terminal-Light',
            'Libadwaita Light',
            'Lime',
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
    },
    {
        pair: 'toast warning glyph',
        reason: [
            'The glyph is the status colour lifted to OKLab lightness 0.76 (`--sb-toast-status`). The light-tone toast layer is the body',
            'colour mixed 14% toward white, a mid tone in a theme with a lighter body colour, and the lifted colour stays under 3:1 on it.',
        ].join(' '),
        themes: [
            'Dracula Light',
            'Everforest Light',
            'Gruvbox Light',
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
        ],
    },
    {
        pair: 'toast success glyph',
        reason: [
            'The glyph is the status colour lifted to OKLab lightness 0.76 (`--sb-toast-status`). The light-tone toast layer is the body',
            'colour mixed 14% toward white, a mid tone in a theme with a lighter body colour, and the lifted colour stays under 3:1 on it.',
        ].join(' '),
        themes: [
            'Dracula Light',
            'Everforest Light',
            'Nord Light',
            'Rosé Pine Dawn',
            'Solarized Light',
            'Sonokai Andromeda Light',
            'Sonokai Atlantis Light',
            'Sonokai Default Light',
            'Sonokai Espresso Light',
            'Sonokai Maia Light',
        ],
    },
    {
        pair: 'toast link',
        reason: [
            'A link on the toast layer is `--sb-accent` (the quote colour 62%, the body colour 38%) mixed 50% with the toast ink',
            '(`#sb-toast-overlay .toast-message a[href]`), so it takes the lower lightness of the accent. On the light tone the accent is',
            'dark and the ink is white, which gives a mid tone on a dark layer.',
        ].join(' '),
        themes: [
            'Catppuccin Latte',
            'Cerulean',
            'Dracula Light',
            'Everforest Dark',
            'Everforest Light',
            'Glacier',
            'Gruvbox Light',
            'Hacker-Terminal-Light',
            'Libadwaita Light',
            'Lime',
            'Magenta',
            'Mint',
            'Nord',
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
            'Sonokai Shusia Light',
            'Tokyo Night Day',
            'Verdant Light',
        ],
    },
    {
        pair: 'toast visited link',
        reason: [
            'A visited link on the toast layer is `--sb-accent` mixed 25% with the toast ink; the cause is the same as for the link at rest.',
        ].join(' '),
        themes: [
            'Catppuccin Latte',
            'Dracula Light',
            'Everforest Dark',
            'Everforest Light',
            'Glacier',
            'Gruvbox Light',
            'Lime',
            'Magenta',
            'Mint',
            'Nord',
            'Nord Light',
            'Rose',
            'Rosé Pine Dawn',
            'Solarized Dark',
            'Solarized Light',
            'Sonokai Andromeda Light',
            'Sonokai Atlantis',
            'Sonokai Atlantis Light',
            'Sonokai Default Light',
            'Sonokai Espresso Light',
            'Sonokai Maia Light',
            'Sonokai Shusia Light',
            'Tokyo Night Day',
        ],
    },
    {
        pair: 'toast anchor without href or label',
        reason: [
            '`body #sb-toast-overlay .toast-message :is(a, label)` sets `--toast-link-color`, the body colour mixed 14% toward the quote',
            'colour, whatever the tone. On the light tone the body colour is dark and the toast layer is dark too, so such text is dark',
            'on dark (1.3 to 1.5:1); on the dark tone it falls just under 4.5:1 where the body colour is not bright. No bundled call puts a',
            'label or an anchor without href in a toast, but an extension can.',
        ].join(' '),
        themes: [
            'Catppuccin Latte',
            'Dracula Light',
            'Everforest Dark',
            'Everforest Light',
            'Glacier',
            'Gruvbox Light',
            'Hacker-Terminal-Light',
            'Libadwaita Light',
            'Lime',
            'Magenta',
            'Mint',
            'Nord',
            'Nord Light',
            'Rose',
            'Rosé Pine Dawn',
            'Solarized Dark',
            'Solarized Light',
            'Sonokai Andromeda Light',
            'Sonokai Atlantis',
            'Sonokai Atlantis Light',
            'Sonokai Default Light',
            'Sonokai Espresso Light',
            'Sonokai Maia Light',
            'Sonokai Shusia Light',
            'Tokyo Night Day',
            'Verdant Light',
        ],
    },
    {
        pair: 'toast button text',
        reason: [
            'The text is the toast ink on a fill that adds 10% of that ink to the layer, so its ratio is lower than that of the label: a',
            'theme whose label is under about 5.5:1 on the layer falls under 4.5:1, which includes themes whose label alone passes.',
        ].join(' '),
        themes: [
            'Azure',
            'Cerulean',
            'Dracula',
            'Everforest Dark',
            'Everforest Light',
            'Glacier',
            'Gruvbox Dark',
            'Lime',
            'Magenta',
            'Mint',
            'Nord',
            'Nord Light',
            'Plum',
            'Rose',
            'Rosé Pine Dawn',
            'Slate',
            'Solarized Dark',
            'Solarized Light',
            'Sonokai Andromeda',
            'Sonokai Atlantis',
            'Sonokai Default',
            'Sonokai Default Light',
            'Sonokai Espresso Light',
            'Sonokai Maia Light',
            'Tokyo Night',
        ],
    },
    {
        pair: 'notification link',
        reason: [
            'The link is `--sb-accent`, the quote colour mixed 38% toward the body colour, on the popover layer.',
        ].join(' '),
        themes: [
            'Solarized Dark',
        ],
    },
    {
        pair: 'notification visited link',
        reason: [
            'The visited link is `--sb-accent` mixed 20% toward the body colour, on the popover layer.',
        ].join(' '),
        themes: [
            'Solarized Dark',
        ],
    },
    {
        pair: 'notification button text',
        reason: [
            'The text is the ink on a fill of the ink at 10% over the popover layer. The fill lifts the background of the button above the',
            'layer on the dark tone, which lowers the ratio below that of the body text (4.7 to 5.4:1 in these themes).',
        ].join(' '),
        themes: [
            'Glacier',
            'Lime',
            'Magenta',
            'Mint',
            'Nord',
            'Slate',
            'Solarized Dark',
            'Sonokai Atlantis',
        ],
    },
];

const knownFailureIds = (themeName) => KNOWN_FAILURES.filter(({ themes: names }) => names.includes(themeName)).map(({ pair }) => pair);

const describeCase = ({ id, ratio, minimum, foreground, background }) => `${id}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1, needs ${minimum}:1`;

describe('the toast and the in-app notification on every bundled theme', () => {
    test('covers every bundled theme, each in one tone', () => {
        expect(themes.length).toBeGreaterThan(0);
        expect(themes.map(theme => `${theme.name}.json`)).toEqual(themeFiles);
        expect(new Set(themes.map(toneOf))).toEqual(new Set(['dark', 'light']));
    });

    test('resolves the same pairs for every theme, for both forms and for each status', () => {
        const idsOf = (theme) => pairsOf(theme).map(({ id }) => id);

        expect(new Set(themes.map(theme => idsOf(theme).join('|'))).size).toBe(1);
        expect(idsOf(themes[0])).toEqual(expect.arrayContaining([
            'toast label',
            'notification title',
            'notification body',
            'toast link',
            'notification link',
            'toast button text',
            'notification button text',
            'toast Dismiss glyph',
            'notification Dismiss glyph',
            ...STATUS_KINDS.flatMap(kind => [`toast ${kind} glyph`, `notification ${kind} glyph`]),
        ]));
    });

    test('has no theme whose Custom CSS styles a toast, so the surfaces come from the app stylesheets and the theme colours', () => {
        expect(themes.filter(theme => /toast|sb-form-|sb-toast/i.test(theme.custom_css ?? '')).map(theme => theme.name)).toEqual([]);
    });

    test('reads the layers of the bundled Libadwaita themes as the stylesheet documents them', () => {
        const hex = (colour) => `#${colour.rgb.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
        const dark = layersOf(themeNamed('Libadwaita Dark'));
        const light = layersOf(themeNamed('Libadwaita Light'));

        expect([hex(dark.popover), hex(dark.toast)]).toEqual(['#36363a', '#505053']);
        expect(hex(light.popover)).toBe('#ffffff');
        expect(Math.abs(Math.round(light.toast.rgb[0]) - 0x50)).toBeLessThanOrEqual(1);
    });

    describe('contrast of the text and the glyphs (WCAG 2.2: 4.5:1 for text, 3:1 for a glyph)', () => {
        test.each(themes.map(theme => [`${theme.name} (${toneOf(theme)} tone)`, theme]))('%s', (_label, theme) => {
            const failing = pairsOf(theme).filter(pair => pair.asserted && pair.ratio < pair.minimum);
            const known = knownFailureIds(theme.name);
            const unexpected = failing.filter(({ id }) => !known.includes(id)).map(describeCase);
            const fixed = known.filter(id => !failing.some(pair => pair.id === id));

            expect({ unexpected, fixed }).toEqual({ unexpected: [], fixed: [] });
        });

        test('lists known failures only for pairs and themes that exist, once each', () => {
            const pairIds = new Set(pairsOf(themes[0]).map(({ id }) => id));
            const entries = KNOWN_FAILURES.flatMap(({ pair, themes: names }) => names.map(name => `${pair} | ${name}`));

            expect(KNOWN_FAILURES.filter(({ pair }) => !pairIds.has(pair)).map(({ pair }) => pair)).toEqual([]);
            expect(KNOWN_FAILURES.flatMap(({ themes: names }) => names).filter(name => !themeNamed(name))).toEqual([]);
            expect(new Set(entries).size).toBe(entries.length);
            expect(KNOWN_FAILURES.every(({ reason }) => reason.length > 0)).toBe(true);
        });
    });
});

/** `value` with the alpha of an `rgb()` or `rgba()` colour replaced. */
const withAlpha = (value, alpha) => value.replace(/rgba?\(([^)]*)\)/, (_match, inner) => `rgba(${inner.split(',').slice(0, 3).map(part => part.trim()).join(', ')}, ${alpha})`);

describe('the surfaces of the two forms are opaque whatever the tints of the theme', () => {
    const translucent = (theme, alpha) => ({ ...theme, blur_tint_color: withAlpha(theme.blur_tint_color, alpha), chat_tint_color: withAlpha(theme.chat_tint_color, alpha) });

    test.each([['Libadwaita Dark'], ['Libadwaita Light']])('%s keeps an opaque toast layer and popover layer under a translucent blur tint and chat tint', (name) => {
        for (const alpha of [0.6, 0.3, 0.1]) {
            const variant = translucent(themeNamed(name), alpha);
            const layers = layersOf(variant);

            expect(layers.popoverSource.alpha).toBeLessThan(1);
            // The light-tone toast layer mixes the body colour with white, so only the dark-tone one is made of the tint.
            expect(layers.toastSource.alpha < 1).toBe(toneOf(variant) === 'dark');
            expect(layers.toast.alpha).toBe(1);
            expect(layers.popover.alpha).toBe(1);
        }
    });

    test('keeps both layers opaque for every bundled theme at a blur tint and chat tint of alpha 0.3', () => {
        const translucentLayers = themes.filter((theme) => {
            const { toast, popover } = layersOf(translucent(theme, 0.3));
            return toast.alpha !== 1 || popover.alpha !== 1;
        });

        expect(translucentLayers.map(theme => theme.name)).toEqual([]);
    });

    test('refuses to measure a form whose surface is translucent', () => {
        const withTranslucentLayer = { ...themeNamed('Libadwaita Dark'), custom_css: ':root { --sb-layer-popover: var(--sb-layer-popover-source); }' };

        expect(() => pairsOf(withTranslucentLayer)).toThrow(/popover layer is translucent/);
    });
});

/** Where the colours of the two forms are declared: every rule that names a part of them, and the tokens they paint with. */
const FORM_SHEETS = ['public/style.css', 'public/css/popup.css', 'public/css/sillybunny-theme.css', 'public/css/sillybunny-tabs.css', 'public/css/sillybunny-home.css']
    .map(path => parseStylesheet(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')));
const FORM_SELECTOR = /#sb-toast-overlay|#toast-container|\.sb-form-toast|\.sb-form-notification|\.sb-toast-actions|\.toast-close-button|\.toast-message|\.toast-title/;
const FORM_TOKEN = /^--(sb-layer-(toast|popover)(-source|-fg)?|sb-shadow-(toast|popover)|sb-popover-ring|sb-toast-[\w-]+|toast-[\w-]+)$/;

/** The one hard-coded colour of the forms: DESIGN.md (Toasts, Surface) gives the toast white ink in both tones. */
const ALLOWED_LITERALS = [{ name: '--sb-layer-toast-fg', literal: '#ffffff' }];

const NAMED_COLOURS = new Set(`aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood
cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki
darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise
darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray
green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral
lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey
lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen
mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive
olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple
rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow
springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen`.split(/\s+/));

/**
 * The colours that a value writes out by itself: a hex colour, a colour function with literal arguments, a colour name.
 * A colour taken from another colour (`rgb(from ...)`), `transparent`, `currentColor` and system colours are not
 * hard-coded. `white` and `black` stand for a mix with the theme's colour only inside `color-mix()`, as the Theme Alias
 * Rule allows.
 */
function hardCodedColoursIn(value) {
    const found = [...(value.match(/#[\da-f]{3,8}\b/gi) ?? [])];
    found.push(...[...value.matchAll(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*(?!from\b)[^)]*\)/gi)].map(match => match[0]));
    const words = value.replace(/--[\w-]+|"[^"]*"|'[^']*'|url\([^)]*\)/g, ' ').match(/[a-z]+/gi) ?? [];
    for (const word of words) {
        const name = word.toLowerCase();
        const isMixOperand = (name === 'white' || name === 'black') && value.includes('color-mix(');
        if (NAMED_COLOURS.has(name) && !isMixOperand) found.push(word);
    }
    return found;
}

describe('the rules of the two forms use theme aliases only', () => {
    test('finds hard-coded colours and leaves colours that come from the theme alone', () => {
        expect(hardCodedColoursIn('#fff')).toEqual(['#fff']);
        expect(hardCodedColoursIn('rgba(0, 0, 6, 0.5)')).toEqual(['rgba(0, 0, 6, 0.5)']);
        expect(hardCodedColoursIn('1px solid red')).toEqual(['red']);
        expect(hardCodedColoursIn('white')).toEqual(['white']);
        expect(hardCodedColoursIn('color-mix(in srgb, var(--SmartThemeBodyColor) 86%, white 14%)')).toEqual([]);
        expect(hardCodedColoursIn('rgb(from var(--sb-layer-toast-source) r g b / 1)')).toEqual([]);
        expect(hardCodedColoursIn('oklab(from var(--sb-toast-src) max(l, 0.76) a b)')).toEqual([]);
        expect(hardCodedColoursIn('var(--sb-color-green, var(--color-success))')).toEqual([]);
        expect(hardCodedColoursIn('1px solid CanvasText')).toEqual([]);
        expect(hardCodedColoursIn('color-mix(in srgb, currentColor 10%, transparent)')).toEqual([]);
        expect(hardCodedColoursIn('\'\\f058\'')).toEqual([]);
    });

    test('has no hard-coded colour in a declaration of a rule that names a part of either form, or of the layer tokens they paint with', () => {
        const declarations = declarationsOf(FORM_SHEETS).filter(({ selectors, name }) => FORM_TOKEN.test(name) || selectors.some(selector => FORM_SELECTOR.test(selector)));
        const hardCoded = declarations
            .filter(({ name, value }) => hardCodedColoursIn(value).some(literal => !ALLOWED_LITERALS.some(allowed => allowed.name === name && allowed.literal === literal)))
            .map(({ selectors, name, value }) => `${selectors.join(', ')} { ${name}: ${value} }`);

        expect(declarations.length).toBeGreaterThan(200);
        expect(hardCoded).toEqual([]);
    });

    test('keeps the allowed literal where DESIGN.md asks for it, and nowhere else', () => {
        const uses = declarationsOf(FORM_SHEETS).filter(({ value }) => ALLOWED_LITERALS.some(({ literal }) => value.includes(literal)));

        expect(uses.map(({ name }) => name)).toEqual(['--sb-layer-toast-fg']);
        expect(readFileSync(new URL('../DESIGN.md', import.meta.url), 'utf8')).toMatch(/Toast layer with white ink in both tones/);
    });
});
