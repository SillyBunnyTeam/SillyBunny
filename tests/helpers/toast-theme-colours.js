/**
 * The surfaces and inks of the two message forms (the toast and the in-app notification) in a bundled theme, computed
 * from `public/style.css`, `public/css/sillybunny-theme.css` and the theme file. Each part is read from the rule that
 * paints it, so a selector that the stylesheet renames makes the lookup throw with that selector, and the rule has to be
 * named again here.
 *
 * A theme has one tone, light or dark, which the app sets from the blur tint of the theme (`applyLandingContrastPalette`
 * in `power-user.js`). A theme is therefore resolved in its own tone only.
 */

import { readFileSync } from 'node:fs';

import { colourOf, contrastRatio, createScope, declaredValue, displayed, luminance, paint, parseStylesheet, rootCustomProperties, toHex } from './css-colour.js';

const readSheet = (path) => parseStylesheet(readFileSync(new URL(path, import.meta.url), 'utf8'));

/** Both stylesheets that declare the colours of the forms, in the order that `index.html` loads them. */
export const APP_SHEETS = [readSheet('../../public/style.css'), readSheet('../../public/css/sillybunny-theme.css')];

/** The theme file keys that `applyThemeColor` in `power-user.js` writes to the root element as custom properties. */
const THEME_COLOUR_PROPERTIES = Object.freeze({
    '--SmartThemeBodyColor': 'main_text_color',
    '--SmartThemeEmColor': 'italics_text_color',
    '--SmartThemeUnderlineColor': 'underline_text_color',
    '--SmartThemeQuoteColor': 'quote_text_color',
    '--SmartThemeBlurTintColor': 'blur_tint_color',
    '--SmartThemeChatTintColor': 'chat_tint_color',
    '--SmartThemeUserMesBlurTintColor': 'user_mes_blur_tint_color',
    '--SmartThemeBotMesBlurTintColor': 'bot_mes_blur_tint_color',
    '--SmartThemeShadowColor': 'shadow_color',
    '--SmartThemeBorderColor': 'border_color',
});

/** The surface tone turns light above this relative luminance of the blur tint (`applyLandingContrastPalette`). */
const LIGHT_SURFACE_LUMINANCE = 0.36;

/** WCAG 2.2 success criterion 1.4.3, for text. */
export const TEXT_CONTRAST = 4.5;
/** WCAG 2.2 success criterion 1.4.11, for the glyph that carries a status and for a control's icon. */
export const GRAPHIC_CONTRAST = 3;

export const STATUS_KINDS = Object.freeze(['error', 'warning', 'success']);

const TOAST = '#sb-toast-overlay > .sb-form-toast';
const NOTIFICATION = 'body #toast-container[class] > .sb-form-notification';
const EITHER_FORM = ':is(#toast-container > .sb-form-notification, #sb-toast-overlay > .sb-form-toast)';
const CLOSE_BUTTON = `${EITHER_FORM} > .toast-close-button`;
const BUTTONS = ':is(button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], .menu_button)';

const declared = (selector, property) => declaredValue(APP_SHEETS, { selector, property });

/** @returns {'light' | 'dark'} */
export function toneOf(theme) {
    const blur = colourOf(theme.blur_tint_color, createScope(new Map()));
    return luminance(blur.rgb) > LIGHT_SURFACE_LUMINANCE ? 'light' : 'dark';
}

/** The custom properties that the root element computes for a theme, in the theme's own tone. */
export function rootScopeOf(theme) {
    const inline = Object.fromEntries(Object.entries(THEME_COLOUR_PROPERTIES).map(([property, key]) => [property, theme[key]]));
    const sheets = [...APP_SHEETS, parseStylesheet(theme.custom_css ?? '')];
    const specified = rootCustomProperties(sheets, { attributes: { 'data-sb-surface-tone': toneOf(theme) }, inline });
    return createScope(specified);
}

/** The colours of the two layers as the stylesheet derives them, with the sources they are made from. */
export function layersOf(theme) {
    const root = rootScopeOf(theme);
    const layer = (name) => colourOf(`var(${name})`, root);
    return {
        toast: layer('--sb-layer-toast'),
        toastSource: layer('--sb-layer-toast-source'),
        toastSurface: colourOf('var(--sb-toast-surface)', elementScope(root, 'info', 'toast')),
        popover: layer('--sb-layer-popover'),
        popoverSource: layer('--sb-layer-popover-source'),
    };
}

/** The custom properties that the toast overlay declares for the toast form, in the order that they refer to each other. */
const OVERLAY_PROPERTIES = ['--sb-toast-ink', '--sb-toast-lightness-cap', '--sb-toast-link-floor', '--sb-toast-surface', '--sb-toast-link', '--sb-toast-link-visited'];

/** An element of a form: the status colours its kind sets, and for a toast the overlay's properties, on top of what the root element computes. */
function elementScope(root, kind, form) {
    const specified = new Map();
    if (form === 'toast') {
        for (const property of OVERLAY_PROPERTIES) {
            specified.set(property, declared('#sb-toast-overlay', property));
        }
    }
    if (kind !== 'info') {
        specified.set('--sb-toast-src', declared(`${EITHER_FORM}.toast-${kind}`, '--sb-toast-src'));
        specified.set('--sb-toast-status', declared(`${EITHER_FORM}:not(.toast-info)`, '--sb-toast-status'));
    }
    return createScope(specified, root);
}

/** A surface paints no colour of its own under it, so it has to be opaque: the Opaque Shell Rule. */
function opaqueSurface(value, scope, label) {
    const colour = colourOf(value, scope);
    if (colour.alpha !== 1) {
        throw new Error(`The ${label} is translucent (alpha ${colour.alpha}), which breaks the Opaque Shell Rule`);
    }
    return displayed(colour);
}

/** The colour that a rule gives a property, where `inherit` takes the parent's. */
function colourOfRule(selector, property, scope, { inherited, currentColour = inherited } = {}) {
    const value = declared(selector, property);
    return value === 'inherit' ? inherited : colourOf(value, scope, { currentColour });
}

/**
 * Every pair of a colour on a surface that a form draws, with its contrast ratio and the lowest that it may have. The
 * hovered and pressed fills of a button are listed too, but are not `asserted`: they are transient states of the same
 * text, and the design fixes the fill at rest.
 * @param {object} theme A bundled theme file.
 * @returns {{ id: string, form: 'toast' | 'notification', minimum: number, asserted: boolean, ratio: number, foreground: string, background: string }[]}
 */
export function pairsOf(theme) {
    const root = rootScopeOf(theme);
    const pairs = [];
    const add = (form, part, minimum, colour, background, asserted = true) => {
        const foreground = paint(colour, background);
        pairs.push({
            id: `${form} ${part}`,
            form,
            minimum,
            asserted,
            ratio: contrastRatio(foreground, background),
            foreground: toHex(foreground),
            background: toHex(background),
        });
    };
    /** A control's fill over the surface under it, and the ink of its text over that fill. */
    const addControl = (form, part, fills, ink, surface) => {
        for (const [state, fill] of fills) {
            add(form, `${part}${state}`, TEXT_CONTRAST, ink, paint(fill, surface), state === '');
        }
    };
    const addDismiss = (form, ink, surface, scope) => {
        const states = [['', null], [' (hover)', declared(`body ${CLOSE_BUTTON}:hover`, 'background')], [' (pressed)', declared(`body ${CLOSE_BUTTON}:active`, 'background')]];
        for (const [state, value] of states) {
            const fill = value === null ? { rgb: [0, 0, 0], alpha: 0 } : colourOf(value, scope, { currentColour: ink });
            add(form, `Dismiss glyph${state}`, GRAPHIC_CONTRAST, ink, paint(fill, surface), state === '');
        }
    };

    // The toast: one pill on the toast layer.
    {
        const scope = elementScope(root, 'info', 'toast');
        const surface = opaqueSurface(declared(TOAST, 'background-color'), scope, 'toast layer');
        const ink = colourOfRule(TOAST, 'color', scope);
        add('toast', 'label', TEXT_CONTRAST, ink, surface);
        for (const kind of STATUS_KINDS) {
            const glyph = colourOfRule(`${TOAST}:not(.toast-info)::before`, 'color', elementScope(root, kind, 'toast'));
            add('toast', `${kind} glyph`, GRAPHIC_CONTRAST, glyph, surface);
        }
        const links = '#sb-toast-overlay .toast-message a[href]';
        add('toast', 'link', TEXT_CONTRAST, colourOfRule(links, 'color', scope), surface);
        add('toast', 'visited link', TEXT_CONTRAST, colourOfRule(`${links}:visited`, 'color', scope), surface);
        add('toast', 'anchor without href or label', TEXT_CONTRAST, colourOfRule('body #sb-toast-overlay .toast-message :is(label, a:not([href]))', 'color', scope, { inherited: ink }), surface);
        const button = `body ${TOAST} .toast-message ${BUTTONS}`;
        const buttonInk = colourOfRule(button, 'color', scope, { inherited: ink });
        const fillOf = (selector, property) => colourOf(declared(selector, property), scope, { currentColour: buttonInk });
        addControl('toast', 'button text', [
            ['', fillOf(button, 'background')],
            [' (hover)', fillOf(`${button}:hover`, 'background-color')],
            [' (pressed)', fillOf(`${button}:active`, 'background-color')],
        ], buttonInk, surface);
        addDismiss('toast', colourOfRule(CLOSE_BUTTON, 'color', scope, { inherited: ink }), surface, scope);
    }

    // The in-app notification: one card on the popover layer.
    {
        const scope = elementScope(root, 'info', 'notification');
        const surface = opaqueSurface(declared(NOTIFICATION, 'background-color'), scope, 'popover layer');
        const ink = colourOfRule(NOTIFICATION, 'color', scope);
        add('notification', 'title', TEXT_CONTRAST, colourOfRule(`${NOTIFICATION} > .toast-title`, 'color', scope, { inherited: ink }), surface);
        add('notification', 'body', TEXT_CONTRAST, ink, surface);
        const icon = `${NOTIFICATION}:is(.toast-error, .toast-warning, .toast-success)::before`;
        const circle = paint(colourOf(declared(icon, 'background'), scope), surface);
        for (const kind of STATUS_KINDS) {
            add('notification', `${kind} glyph`, GRAPHIC_CONTRAST, colourOfRule(icon, 'color', elementScope(root, kind, 'notification')), circle);
        }
        const links = `${NOTIFICATION} .toast-message a[href]`;
        add('notification', 'link', TEXT_CONTRAST, colourOfRule(links, 'color', scope), surface);
        add('notification', 'visited link', TEXT_CONTRAST, colourOfRule(`${links}:visited`, 'color', scope), surface);
        add('notification', 'hovered link', TEXT_CONTRAST, colourOfRule(`${links}:hover`, 'color', scope), surface);
        const button = `${NOTIFICATION} .sb-toast-actions > ${BUTTONS}`;
        const buttonInk = colourOfRule(button, 'color', scope, { inherited: ink });
        const fillOf = (selector, property) => colourOf(declared(selector, property), scope, { currentColour: buttonInk });
        addControl('notification', 'button text', [
            ['', fillOf(button, 'background')],
            [' (hover)', fillOf(`${button}:hover`, 'background-color')],
            [' (pressed)', fillOf(`${button}:active`, 'background-color')],
        ], buttonInk, surface);
        addDismiss('notification', colourOfRule(CLOSE_BUTTON, 'color', scope, { inherited: ink }), surface, scope);
    }
    return pairs;
}
