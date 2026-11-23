import { describe, expect, test } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';

import { colourOf, declarationsOf, declaredValue, displayed, paint, parseStylesheet, toHex } from './helpers/css-colour.js';
import { APP_SHEETS, STATUS_KINDS, layersOf, pairsOf, rootScopeOf, toneOf } from './helpers/toast-theme-colours.js';

const themesDirectory = new URL('../default/content/themes/', import.meta.url);
const themeFiles = readdirSync(themesDirectory).filter(file => file.endsWith('.json')).sort();
const themes = themeFiles.map(file => JSON.parse(readFileSync(new URL(file, themesDirectory), 'utf8')));
const themeNamed = (name) => themes.find(theme => theme.name === name);

/**
 * The cases that fail on the stylesheets as they are, by pair, with the cause. The suite stays green and still lists
 * them. A case that stops failing makes the test of its theme fail until the theme is taken out of its entry, and a new
 * failure makes it fail until it is fixed or added here. The failure message of a theme's test gives the ratio and the
 * colours of each case that is not listed.
 *
 * The toast is drawn in the colours of the in-app notification (T1 of the decision log, DESIGN.md Toasts, Surface), on the
 * same layer, in the same ink, with the same links and the same fill under a button, so it fails where the notification
 * does and for the same cause. Every case left here is a colour that is GNOME Shell's (the fill of a button is the ink at
 * 10%) or the theme's own (a link is its accent), and a fix needs a value that is neither, which is a deviation of DESIGN.md
 * for the maintainers to decide.
 */
const KNOWN_FAILURES = [
    {
        pair: 'toast link',
        reason: [
            'The link is `--sb-accent`, the quote colour mixed 38% toward the body colour, on the popover layer, as in a notification.',
            'The theme\'s own text colours on its own popover layer are borderline (4.44:1), and a link that holds 4.5:1 needs a colour that the',
            'theme does not give it.',
        ].join(' '),
        themes: [
            'Solarized Dark',
        ],
    },
    {
        pair: 'toast visited link',
        reason: [
            'The visited link is `--sb-accent` mixed 20% toward the body colour, on the popover layer, as in a notification; the cause is the',
            'same as for the link at rest (4.41:1).',
        ].join(' '),
        themes: [
            'Solarized Dark',
        ],
    },
    {
        pair: 'toast button text',
        reason: [
            'The text is the ink on a fill of the ink at 10% over the popover layer, as in a notification (GNOME Shell\'s fill). The fill lifts',
            'the background of the button above the layer on the dark tone, which lowers the ratio below that of the label (4.7 to 5.4:1 in these',
            'themes, 4.11 to 4.49:1 on the button). A fill that holds 4.5:1 is not 10% of the ink.',
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
    {
        pair: 'notification link',
        reason: [
            'The link is `--sb-accent`, the quote colour mixed 38% toward the body colour, on the popover layer. The theme\'s own text',
            'colours on its own popover layer are borderline (4.44:1), and a link that holds 4.5:1 needs a colour that the theme does',
            'not give it.',
        ].join(' '),
        themes: [
            'Solarized Dark',
        ],
    },
    {
        pair: 'notification visited link',
        reason: [
            'The visited link is `--sb-accent` mixed 20% toward the body colour, on the popover layer; the cause is the same as for the link at rest (4.41:1).',
        ].join(' '),
        themes: [
            'Solarized Dark',
        ],
    },
    {
        pair: 'notification button text',
        reason: [
            'The text is the ink on a fill of the ink at 10% over the popover layer, which is GNOME Shell\'s fill. The fill lifts the',
            'background of the button above the layer on the dark tone, which lowers the ratio below that of the body text (4.7 to 5.4:1',
            'in these themes, 4.11 to 4.49:1 on the button). A fill that holds 4.5:1 is not 10% of the ink.',
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

    test.each([['Libadwaita Dark'], ['Libadwaita Light']])('%s keeps an opaque toast layer, which the tooltips share, and popover layer under a translucent blur tint and chat tint', (name) => {
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

/**
 * The hard-coded colour of the forms: the ink of the toast layer in the light tone, which the tooltips and the press-and-hold
 * label share (libadwaita's OSD text is white). The toast and the in-app notification are drawn in theme colours alone.
 */
const ALLOWED_LITERALS = [
    { name: '--sb-layer-toast-fg', literal: '#ffffff' },
];

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

describe('the toast is drawn in the colours of the in-app notification, and leaves the layer that the tooltips share as it is', () => {
    const withoutSupports = new Set();
    const pairOf = (theme, id) => pairsOf(theme).find(pair => pair.id === id);
    const SHARED = [
        ['toast label', 'notification body'],
        ['toast link', 'notification link'],
        ['toast visited link', 'notification visited link'],
        ['toast hovered link', 'notification hovered link'],
        ['toast anchor without href or label', 'notification anchor without href or label'],
        ['toast error glyph', 'notification error glyph'],
        ['toast warning glyph', 'notification warning glyph'],
        ['toast success glyph', 'notification success glyph'],
    ];

    test.each(SHARED)('%s is the colour of %s, on the same popover layer, on every theme', (toastId, notificationId) => {
        const differing = themes
            .map(theme => [theme.name, pairOf(theme, toastId), pairOf(theme, notificationId)])
            .filter(([, toast, notification]) => toast.foreground !== notification.foreground || (!notificationId.includes('glyph') && toast.background !== notification.background))
            .map(([name, toast, notification]) => `${name}: ${toast.foreground} on ${toast.background} against ${notification.foreground} on ${notification.background}`);

        expect(differing).toEqual([]);
    });

    test('the toast stands on the popover layer, in the body colour of the theme, which is the ink of the notification', () => {
        for (const theme of themes) {
            const root = rootScopeOf(theme);
            const layers = layersOf(theme);
            const label = pairOf(theme, 'toast label');

            const popover = displayed(layers.popover);

            expect([theme.name, label.background]).toEqual([theme.name, toHex(popover)]);
            // A body colour that is translucent, as Dracula's is, is painted over the layer before it is read.
            expect([theme.name, label.foreground]).toEqual([theme.name, toHex(paint(colourOf('var(--SmartThemeBodyColor)', root), popover))]);
        }
    });

    test('the tooltips and the press-and-hold label still paint with the toast layer and its own ink, which is the body colour on the dark tone and white on the light', () => {
        const messageActions = [parseStylesheet(readFileSync(new URL('../public/css/sillybunny-message-actions.css', import.meta.url), 'utf8'))];

        for (const [sheets, selector] of [[APP_SHEETS, '.tooltip-inner'], [messageActions, '.sb-press-tooltip']]) {
            expect(declaredValue(sheets, { selector, property: 'background', conditions: withoutSupports })).toBe('var(--sb-layer-toast)');
            expect(declaredValue(sheets, { selector, property: 'color', conditions: withoutSupports })).toBe('var(--sb-layer-toast-fg)');
        }
        for (const theme of themes) {
            const root = rootScopeOf(theme);
            const expectedInk = toneOf(theme) === 'dark' ? colourOf('var(--SmartThemeBodyColor)', root) : colourOf('#ffffff', root);

            expect(colourOf('var(--sb-layer-toast-fg)', root)).toEqual(expectedInk);
        }
        expect(toHex(displayed(layersOf(themeNamed('Libadwaita Dark')).toast))).toBe('#505053');
    });

    test('declares none of the tokens of the dark toast: its ink, its capped surface, its lifted links and its status lift', () => {
        const names = new Set(declarationsOf(FORM_SHEETS).map(({ name }) => name));
        const gone = ['--sb-toast-ink', '--sb-toast-surface', '--sb-toast-link', '--sb-toast-link-visited', '--sb-toast-lightness-cap', '--sb-toast-link-floor', '--sb-toast-status'];

        expect(gone.filter(name => names.has(name))).toEqual([]);
        expect(FORM_SHEETS.some(sheet => JSON.stringify(sheet).includes('--sb-toast-status'))).toBe(false);
    });
});

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

    test('keeps the allowed literal for the ink of the tooltips, and nowhere else', () => {
        const uses = declarationsOf(FORM_SHEETS).filter(({ value }) => ALLOWED_LITERALS.some(({ literal }) => value.includes(literal)));

        expect(uses.map(({ name }) => name)).toEqual(['--sb-layer-toast-fg']);
        expect(readFileSync(new URL('../DESIGN.md', import.meta.url), 'utf8')).toMatch(/libadwaita OSD tooltip: shadow ink at 80%, white text/);
    });
});

/** The colour functions that take a relative colour, and the math functions that a channel expression can use. */
const RELATIVE_COLOUR = /\b(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(\s*from\b/gi;
const MATH_FUNCTION = /\b(min|max|calc|clamp)\(/g;
const namesIn = (text, pattern) => new Set([...text.matchAll(pattern)].map(match => match[1].toLowerCase()));

describe('every relative colour of the two forms sits behind a guard that tests the shape it uses', () => {
    const relative = declarationsOf(FORM_SHEETS)
        .filter(({ selectors, name }) => FORM_TOKEN.test(name) || selectors.some(selector => FORM_SELECTOR.test(selector)))
        .filter(({ value }) => new RegExp(RELATIVE_COLOUR.source, 'i').test(value));
    const describeDeclaration = ({ selectors, name }) => `${selectors.join(', ')} { ${name} }`;

    test('finds the colour functions and the math of a declaration and of a guard', () => {
        expect(namesIn('oklab(from var(--a) min(l, 0.5) calc(a * min(1, 0.5 / l)) b)', RELATIVE_COLOUR)).toEqual(new Set(['oklab']));
        expect(namesIn('oklab(from var(--a) min(l, 0.5) calc(a * min(1, 0.5 / l)) b)', MATH_FUNCTION)).toEqual(new Set(['min', 'calc']));
        expect(namesIn('color-mix(in srgb, red 50%, white)', RELATIVE_COLOUR)).toEqual(new Set());
        expect(namesIn('rgb(from var(--a) r g b / 1)', MATH_FUNCTION)).toEqual(new Set());
    });

    test('has relative colours to check: the two opaque layers and the hover colour of a link', () => {
        expect(relative.map(describeDeclaration).sort()).toEqual([
            ':root { --sb-layer-popover }',
            ':root { --sb-layer-toast }',
            'body :is(#toast-container[class] > .sb-form-notification, #sb-toast-overlay > .sb-form-toast) .toast-message a[href]:hover { color }',
        ]);
    });

    test('puts each of them in an @supports whose condition uses the same colour function and the same math functions', () => {
        const unguarded = relative.filter(declaration => {
            const functions = namesIn(declaration.value, RELATIVE_COLOUR);
            const math = namesIn(declaration.value, MATH_FUNCTION);
            return !declaration.path.some((prelude) => {
                if (!prelude.startsWith('@supports')) return false;
                const guardMath = namesIn(prelude, MATH_FUNCTION);
                const guardFunctions = namesIn(prelude, RELATIVE_COLOUR);
                return [...functions].every(name => guardFunctions.has(name)) && [...math].every(name => guardMath.has(name));
            });
        });

        expect(unguarded.map(describeDeclaration)).toEqual([]);
    });

    test('gives every custom property of them a declaration outside any guard, which an engine that cannot read the shape keeps', () => {
        const withoutFallback = relative
            .filter(({ name }) => name.startsWith('--'))
            .filter(({ selectors, name }) => !declarationsOf(FORM_SHEETS).some(other => other.name === name && other.path.length === 0 && other.selectors.some(selector => selectors.includes(selector))));

        expect(withoutFallback.map(describeDeclaration)).toEqual([]);
    });
});
