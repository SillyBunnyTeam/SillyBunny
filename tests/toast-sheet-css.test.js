import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BUTTON_SELECTOR } from '../public/scripts/sillybunny-toast-form.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...segments) => readFileSync(path.join(repoRoot, ...segments), 'utf8');
const themeCss = read('public', 'css', 'sillybunny-theme.css');
const actionsCss = read('public', 'css', 'sillybunny-message-actions.css');

/** The declarations of the first rule whose selector line is exactly `selector`. */
function ruleOf(css, selector) {
    const start = css.indexOf(`\n${selector} {`);
    if (start < 0) throw new Error(`No rule for ${selector}`);
    return css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start)).replace(/\s+/g, ' ').trim();
}

/** The selector of the toast form in `#sb-toast-overlay`, with the part that follows it. */
const TOAST = '#sb-toast-overlay > .sb-form-toast';
const NOTIFICATION = 'body #toast-container[class] > .sb-form-notification';
const BUTTONS = BUTTON_SELECTOR.split(',').map(part => part.trim());

describe('the toast layer', () => {
    test('an in-app notification is a card: the Popover layer and shadow, the Overlay radius, no border, 34em wide, a 4px margin, opaque and important against toastr\'s sheet', () => {
        const rule = ruleOf(themeCss, NOTIFICATION);
        expect(rule).toContain('width: 34em');
        expect(rule).toContain('max-width: calc(100% - 24px)');
        expect(rule).toContain('--sb-n-space: 4px');
        expect(rule).toContain('margin: var(--sb-n-space)');
        expect(rule).toContain('padding: 12px 6px');
        expect(rule).toContain('background-color: var(--sb-layer-popover) !important');
        expect(rule).toContain('border-radius: var(--sb-radius-overlay) !important');
        expect(rule).toContain('box-shadow: var(--sb-shadow-popover) !important');
        expect(rule).toContain('border: none !important');
        expect(rule).toContain('backdrop-filter: none !important');
        expect(rule).toContain('-webkit-backdrop-filter: none !important');
        expect(rule).toContain('animation: none');
        // A card that a click does not act on keeps the default cursor, whatever its toastClass.
        expect(rule).toContain('cursor: default');
        expect(themeCss).not.toContain('body #toast-container[class] > div {');
    });

    test('the icon of a notification is a 48px circle of the ink at 7% with the 16px glyph in the standalone status colour, and info has none', () => {
        const icon = ruleOf(themeCss, `${NOTIFICATION}:is(.toast-error, .toast-warning, .toast-success)::before`);
        expect(icon).toContain('float: inline-start');
        expect(icon).toContain('width: 48px');
        expect(icon).toContain('height: 48px');
        expect(icon).toContain('border-radius: var(--sb-radius-pill)');
        expect(icon).toContain('background: color-mix(in srgb, var(--SmartThemeBodyColor) 7%, transparent)');
        expect(icon).toContain('color: var(--sb-toast-src)');
        expect(icon).toContain('font: 900 16px/1 "Font Awesome 6 Free"');
        expect(ruleOf(themeCss, `${NOTIFICATION}::before`)).toBe('content: none;');
        expect(ruleOf(themeCss, `${NOTIFICATION}:is(.toast-error, .toast-warning, .toast-success)`)).toBe('--sb-n-start: 60px;');
    });

    test('the title is the ink, bold, and 4px from the body; Dismiss floats at the end, centred on the first line', () => {
        expect(ruleOf(themeCss, `${NOTIFICATION} > .toast-title`)).toContain('color: inherit');
        expect(ruleOf(themeCss, `${NOTIFICATION} > .toast-title`)).toContain('font-weight: 700');
        expect(ruleOf(themeCss, `${NOTIFICATION} > .toast-message`)).toContain('font-weight: 400');
        expect(ruleOf(themeCss, `${NOTIFICATION} > .toast-title + .toast-message`)).toBe('margin-top: var(--sb-n-space);');
        const close = ruleOf(themeCss, `${NOTIFICATION} > .toast-close-button`);
        expect(close).toContain('float: inline-end');
        expect(close).toContain('margin-block: calc((var(--sb-n-line) - 34px) / 2) calc((var(--sb-n-line) - 34px) / 2 + var(--sb-n-space) - 0.5px)');
        // 6px at its end, and 6px between it and the text of the first row.
        expect(close).toContain('margin-inline: 6px');
    });

    test('the text column ends 6px inside the card, and only the first row gives way to Dismiss, which is a float in the text\'s own formatting context', () => {
        expect(ruleOf(themeCss, NOTIFICATION)).toContain('--sb-n-end: 6px');
        expect(ruleOf(themeCss, `${NOTIFICATION} > :is(.toast-title, .toast-message)`)).toContain('padding-inline: var(--sb-n-start) var(--sb-n-end)');
        expect(themeCss).not.toContain('--sb-n-end: 46px');
    });

    test('the button row has three buttons to a row of equal widths, 6px apart, with 4px of padding and the Control radius and bold, 6px 12px buttons', () => {
        const row = ruleOf(themeCss, `${NOTIFICATION} .sb-toast-actions`);
        expect(row).toContain('display: flex');
        expect(row).toContain('flex-wrap: wrap');
        expect(row).toContain('gap: 6px');
        expect(row).toContain('padding: var(--sb-n-space)');
        expect(row).toContain('clear: both');
        const button = ruleOf(themeCss, `${NOTIFICATION} .sb-toast-actions > :is(${BUTTONS.join(', ')})`);
        expect(button).toContain('flex: 1 1 calc((100% - 12px) / 3)');
        expect(button).toContain('padding: 6px 12px');
        expect(button).toContain('border-radius: var(--sb-radius-control)');
        expect(button).toContain('background: color-mix(in srgb, currentColor 10%, transparent)');
        expect(button).toContain('font-weight: 700');
        expect(button).not.toMatch(/!important/);
    });

    test('the buttons that the notification row styles are the buttons that the classifier counts, and the script finds the same ones', () => {
        expect(themeCss).toContain(`${NOTIFICATION} .sb-toast-actions > :is(${BUTTONS.join(', ')}):focus-visible`);
        expect(read('public', 'scripts', 'sillybunny-toast-notification.js')).toContain('BUTTON_SELECTOR');
    });

    test('the button of a notification has a 44px target on a coarse pointer, drawn as 32px', () => {
        const coarse = themeCss.slice(themeCss.indexOf(`@media (pointer: coarse) {\n    ${NOTIFICATION} .sb-toast-actions`));
        const block = coarse.slice(coarse.indexOf('{', coarse.indexOf(NOTIFICATION)) + 1, coarse.indexOf('}', coarse.indexOf(NOTIFICATION))).replace(/\s+/g, ' ').trim();
        expect(block).toContain('--sb-n-target-extra: calc((44px - 32px) / 2)');
        expect(block).toContain('margin: calc(var(--sb-n-target-extra) * -1)');
        expect(block).toContain('border: var(--sb-n-target-extra) solid transparent');
        expect(block).toContain('background-clip: padding-box');
    });

    test('a link in a notification takes the normal link colours, and the overlay\'s link colours are for the toast only', () => {
        expect(ruleOf(themeCss, `${NOTIFICATION} .toast-message a[href]`)).toContain('color: var(--sb-accent)');
        expect(ruleOf(themeCss, '#sb-toast-overlay .toast-message a[href]')).toContain('color: color-mix(in srgb, var(--sb-accent) 50%, var(--sb-layer-toast-fg))');
        expect(themeCss).not.toContain(':is(#toast-container, #sb-toast-overlay) .toast-message a[href]');
    });

    test('the focus ring of the toast layer is for the toast layer: a notification keeps the ring of the app', () => {
        expect(themeCss).toMatch(/\nbody #sb-toast-overlay \{\n {4}--sb-focus-ring: currentColor;/);
        expect(themeCss).not.toMatch(/body :is\(#toast-container, #sb-toast-overlay\) \{\n {4}--sb-focus-ring/);
    });

    test('a notification has no action grid and no CSS exit motion, because its layout is a button row and its motion is the script\'s', () => {
        expect(themeCss).not.toContain('.sb-toast--action');
        expect(themeCss).not.toContain('@keyframes sb-toast-exit');
        expect(themeCss).not.toContain('#toast-container > div.sb-toast-leaving');
    });

    test('a toast has libadwaita\'s metrics: 12px margin and 24px at its edge, 6px padding and 12px at the start, 6px between parts', () => {
        const box = ruleOf(themeCss, TOAST);
        expect(box).toContain('display: flex');
        expect(box).toContain('gap: 6px');
        expect(box).toContain('margin: 12px auto');
        expect(box).toContain('padding-block: 6px');
        expect(box).toContain('padding-inline: 12px 6px');
        expect(ruleOf(themeCss, '#sb-toast-overlay:is(.toast-top-left, .toast-top-center, .toast-top-right) > .sb-form-toast')).toBe('margin-top: 24px;');
        expect(ruleOf(themeCss, '#sb-toast-overlay:is(.toast-bottom-left, .toast-bottom-center, .toast-bottom-right) > .sb-form-toast,\ndialog > #sb-toast-overlay[data-sb-toast-in-dialog] > .sb-form-toast'))
            .toBe('margin-top: 12px; margin-bottom: 24px;');
        expect(ruleOf(themeCss, '#sb-toast-overlay > .sb-form-toast > :not(.toast-progress)')).toContain('margin-inline: 6px');
    });

    test('a toast takes the surface of the toast layer: Toast Shadow, no border, the ink of the layer, a pill that a wrapped toast cannot outgrow', () => {
        const box = ruleOf(themeCss, TOAST);
        expect(box).toContain('background-color: var(--sb-layer-toast)');
        expect(box).toContain('color: var(--sb-layer-toast-fg)');
        expect(box).toContain('box-shadow: var(--sb-shadow-toast)');
        expect(box).toContain('border: none');
        expect(box).toContain('background-image: none');
        expect(box).toContain('border-radius: min(var(--sb-radius-pill), calc((12px + var(--sb-toast-part-size)) / 2))');
        expect(box).toContain('--sb-toast-part-size: max(34px, 1lh)');
        expect(box).toContain('backdrop-filter: none');
        expect(box).toContain('-webkit-backdrop-filter: none');
    });

    test('a toast is as wide as its text up to 34em and the window minus 24px, and with a button at least 450px', () => {
        expect(ruleOf(themeCss, TOAST)).toContain('max-width: min(34em, calc(100cqw - 24px))');
        expect(ruleOf(themeCss, TOAST)).toContain('width: fit-content');
        const floorSelector = `${TOAST}:has(:where(.toast-message :is(${BUTTONS.join(', ')})))`;
        expect(ruleOf(themeCss, floorSelector)).toBe('min-width: min(450px, calc(100cqw - 24px));');
    });

    test('the buttons that the toast CSS places and sizes are the buttons that the classifier counts', () => {
        const rowSelector = `${TOAST} > .toast-message:has(:where(${BUTTONS.join(', ')}))`;
        expect(ruleOf(themeCss, rowSelector)).toContain('display: flex');
        const buttonRule = `body ${TOAST.replace(' > ', ' > ')} .toast-message :is(${BUTTONS.join(', ')})`;
        expect(ruleOf(themeCss, buttonRule)).toContain('height: 34px');
    });

    test('the button of a toast has a 44px target on a coarse pointer, drawn as 34px, and its fills in the states keep that clip', () => {
        const buttonSelector = `body ${TOAST} .toast-message :is(${BUTTONS.join(', ')})`;
        const coarse = themeCss.slice(themeCss.indexOf('@media (pointer: coarse) {\n    body #sb-toast-overlay > .sb-form-toast .toast-message'));
        const rule = coarse.slice(coarse.indexOf('{', coarse.indexOf(buttonSelector)) + 1, coarse.indexOf('}', coarse.indexOf(buttonSelector))).replace(/\s+/g, ' ').trim();
        expect(rule).toContain('height: 44px');
        expect(rule).toContain('--sb-toast-target-extra: calc((44px - 34px) / 2)');
        expect(rule).toContain('margin: calc(var(--sb-toast-target-extra) * -1)');
        expect(rule).toContain('border: var(--sb-toast-target-extra) solid transparent');
        expect(rule).toContain('background-clip: padding-box');
        // A `background` shorthand in a state would reset the clip, and the fill would grow to the 44px target.
        expect(ruleOf(themeCss, `${buttonSelector}:active`)).toMatch(/^background-color:/);
        expect(themeCss).toMatch(/:hover \{\s*background-color: color-mix/);
    });

    test('the button of a toast and Dismiss draw the focus ring of the app, which the rules that clear the shadow would remove', () => {
        const ring = themeCss.slice(themeCss.indexOf(`body ${TOAST} .toast-message :is(${BUTTONS.join(', ')}):focus-visible,`));
        expect(ring.slice(0, ring.indexOf('}'))).toContain('body :is(#toast-container > .sb-form-notification, #sb-toast-overlay > .sb-form-toast) > .toast-close-button:focus-visible');
        expect(ring.slice(ring.indexOf('{'), ring.indexOf('}')).replace(/\s+/g, ' ')).toContain('box-shadow: var(--sb-focus-ring-inset)');
    });

    test('the label is bold and may shrink, and the one button sits at the end of it', () => {
        const label = ruleOf(themeCss, `${TOAST} > .toast-message`);
        expect(label).toContain('font-weight: 700');
        expect(label).toContain('min-width: 0');
        expect(label).toContain('flex: 1 1 auto');
    });

    test('the status glyph is the first part of a toast, in the lifted status colour, 16px', () => {
        expect(ruleOf(themeCss, '#sb-toast-overlay > .sb-form-toast:not(.toast-info)::before')).toContain('font: 900 16px/1 "Font Awesome 6 Free"');
        expect(ruleOf(themeCss, ':is(#toast-container > .sb-form-notification, #sb-toast-overlay > .sb-form-toast)[class]')).toContain('background-image: none !important');
    });

    test('the close button of both forms is round and flat, 34px, with a 44px target on a coarse pointer', () => {
        const rule = ruleOf(themeCss, ':is(#toast-container > .sb-form-notification, #sb-toast-overlay > .sb-form-toast) > .toast-close-button');
        expect(rule).toContain('width: 34px');
        expect(rule).toContain('height: 34px');
        expect(rule).toContain('border-radius: var(--sb-radius-pill)');
        expect(rule).toContain('background: transparent');
        expect(rule).toContain('min-height: 0');
        expect(themeCss).toMatch(/@media \(pointer: coarse\) \{\s*:is\(#toast-container > \.sb-form-notification, #sb-toast-overlay > \.sb-form-toast\) > \.toast-close-button::after \{\s*content: '';\s*position: absolute;\s*inset: -5px;/);
    });

    test('the status colour reaches the icon glyph and the title, and nothing else', () => {
        expect(ruleOf(themeCss, ':is(#toast-container > .sb-form-notification, #sb-toast-overlay > .sb-form-toast).toast-error')).toContain('--sb-toast-src: var(--sb-color-danger)');
        expect(ruleOf(themeCss, ':is(#toast-container > .sb-form-notification, #sb-toast-overlay > .sb-form-toast).toast-warning')).toContain('--sb-toast-src: var(--sb-color-warning)');
        expect(ruleOf(themeCss, ':is(#toast-container > .sb-form-notification, #sb-toast-overlay > .sb-form-toast).toast-success')).toContain('--sb-toast-src: var(--sb-color-success)');
        expect(ruleOf(themeCss, '#sb-toast-overlay > .sb-form-toast:not(.toast-info)::before,\n#sb-toast-overlay > .sb-form-toast:not(.toast-info) .toast-title')).toBe('color: var(--sb-toast-status);');
    });

    test('toast timing is declared once, in script.js, at 5 seconds and 300ms', () => {
        const core = read('public', 'script.js');
        const options = core.slice(core.indexOf('toastr.options = {'), core.indexOf('escapeHtml: true'));
        expect(options).toMatch(/timeOut: 5000,/);
        expect(options).toMatch(/extendedTimeOut: 5000,/);
        expect(options).toMatch(/showDuration: 300,/);
        expect(options).toMatch(/hideDuration: 300,/);
    });
});

describe('the rules of the two forms', () => {
    test('are keyed on the marker of the form, which every message has, and not on the toast class, which a caller can replace', () => {
        const rules = [...themeCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
            .map(([, selector]) => selector.replace(/\/\*[\s\S]*?\*\//g, '').trim())
            .filter(selector => /#toast-container|#sb-toast-overlay/.test(selector));
        expect(rules.length).toBeGreaterThan(20);
        const keyedOnToast = rules.filter(selector => /(^|[\s>(,])\.toast(?![-\w])/.test(selector));
        expect(keyedOnToast).toEqual([]);
    });
});

describe('bottom sheets and the safe area', () => {
    test('a dialog sheet keeps clear of the side insets as well as the bottom one', () => {
        const rule = ruleOf(themeCss, '.sb-dialog-host[data-presentation=\'sheet\'][open]');
        expect(rule).toContain('env(safe-area-inset-left, 0px)');
        expect(rule).toContain('env(safe-area-inset-right, 0px)');
    });

    test('the action sheet pads its sides by at least the insets', () => {
        const rule = ruleOf(actionsCss, '.sb-action-sheet');
        expect(rule).toContain('max(6px, env(safe-area-inset-left, 0px))');
        expect(rule).toContain('max(6px, env(safe-area-inset-right, 0px))');
    });

    test('the two clamps that keep a floating layer off the screen edge read the insets', () => {
        expect(themeCss).toContain('--sb-safe-area-left: env(safe-area-inset-left, 0px)');
        expect(themeCss).toContain('--sb-safe-area-right: env(safe-area-inset-right, 0px)');
        expect(read('public', 'scripts', 'sillybunny-message-actions.js')).toContain('safeAreaInset(\'right\')');
        expect(read('public', 'scripts', 'sillybunny-tabs.js')).toContain('--sb-safe-area-right');
    });
});

describe('the toast overlay', () => {
    test('is a strip across the window, flush with the edge a toast sits at, and clips there only', () => {
        const rule = ruleOf(themeCss, '#sb-toast-overlay');
        expect(rule).toContain('position: fixed');
        expect(rule).toContain('inset: auto 0');
        expect(rule).toContain('pointer-events: none');
        expect(rule).toContain('container-type: inline-size');
        expect(ruleOf(themeCss, '#sb-toast-overlay:is(.toast-top-left, .toast-top-center, .toast-top-right)')).toContain('clip-path: inset(0 -100vmax -100vmax)');
        expect(ruleOf(themeCss, '#sb-toast-overlay:is(.toast-bottom-left, .toast-bottom-center, .toast-bottom-right)')).toContain('clip-path: inset(-100vmax -100vmax 0)');
        expect(ruleOf(themeCss, '#sb-toast-overlay > div')).toContain('position: relative');
    });

    test('a bottom overlay sits above the composer and the keyboard by the inset that the script writes, and a top one under the top bar', () => {
        expect(ruleOf(themeCss, '#sb-toast-overlay:is(.toast-bottom-left, .toast-bottom-center, .toast-bottom-right)')).toContain('bottom: var(--sb-toast-bottom-inset, 0px)');
        const top = ruleOf(themeCss, '#sb-toast-overlay:is(.toast-top-left, .toast-top-center, .toast-top-right)');
        expect(top).toContain('top: 0');
        // The bottom of the top bar, which is taller than --topBarBlockSize on a phone.
        expect(top).toContain('margin-top: var(--sb-topbar-layout-offset, var(--topBarBlockSize))');
    });

    test('in a dialog it is at the bottom of the dialog\'s box, as the containing block that a dialog keeps for it', () => {
        const rule = ruleOf(themeCss, 'dialog > #sb-toast-overlay[data-sb-toast-in-dialog]');
        expect(rule).toContain('position: absolute');
        expect(rule).toContain('inset: auto auto var(--sb-toast-frame-bottom, 0px) var(--sb-toast-frame-left, 0px)');
        expect(rule).toContain('width: var(--sb-toast-frame-width, 100%)');
        expect(rule).toContain('clip-path: inset(-100vmax -100vmax 0)');
    });

    test('an in-app notification at the position of the toasts sits beyond them by the offset that the script writes, and above the composer and keyboard by the inset otherwise', () => {
        const top = ruleOf(themeCss, 'body #toast-container[class]:is(.toast-top-left, .toast-top-center, .toast-top-right)');
        expect(top).toContain('margin-top: calc(var(--sb-topbar-layout-offset, var(--topBarBlockSize)) + var(--sb-toast-stack-offset, 0px))');
        expect(top).toContain('top: 0');
        const bottom = ruleOf(themeCss, 'body #toast-container[class]:is(.toast-bottom-left, .toast-bottom-center, .toast-bottom-right)');
        expect(bottom).toContain('margin-bottom: var(--sb-toast-stack-offset, 0px)');
        expect(bottom).toContain('bottom: var(--sb-toast-bottom-inset, 0px)');
        // The newest is first in the document and drawn nearest the bottom edge.
        expect(bottom).toContain('flex-direction: column-reverse');
    });

    test('the notification strip clips at the edge it comes out of and nowhere else, so the shadow and the ring survive', () => {
        expect(ruleOf(themeCss, 'body #toast-container[class]:is(.toast-top-left, .toast-top-center, .toast-top-right)')).toContain('clip-path: inset(0 -100vmax -100vmax)');
        expect(ruleOf(themeCss, 'body #toast-container[class]:is(.toast-bottom-left, .toast-bottom-center, .toast-bottom-right)')).toContain('clip-path: inset(-100vmax -100vmax 0)');
    });

    test('the notification container is a strip across the window, as the overlay is, and takes no pointer events itself', () => {
        const strip = ruleOf(themeCss, 'body #toast-container[class]');
        expect(strip).toContain('left: 0');
        expect(strip).toContain('right: 0');
        expect(strip).toContain('display: flex');
        expect(strip).toContain('flex-direction: column');
        expect(themeCss).toContain('body #toast-container[class]:is(.toast-top-right, .toast-bottom-right) {\n    align-items: flex-end;');
    });

    test('a toast does not fade in: it has no CSS enter animation, and neither has a notification, whose motion is the script\'s', () => {
        expect(ruleOf(themeCss, TOAST)).toContain('animation: none');
        expect(ruleOf(themeCss, NOTIFICATION)).toContain('animation: none');
    });

    test('no toast rule is important on what the measuring rule sets, so the measure of a message cannot be changed', () => {
        const measured = /^\s*(width|min-width|max-width|position|white-space)\s*:[^;]*!important/m;
        const rules = [...themeCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
            .filter(([, selector]) => /#toast-container|#sb-toast-overlay/.test(selector) && !selector.includes('.sb-toast-measure'));
        expect(rules.length).toBeGreaterThan(10);
        for (const [, selector, declarations] of rules) {
            expect({ selector: selector.trim(), important: measured.test(declarations) }).toEqual({ selector: selector.trim(), important: false });
        }
    });
});

describe('the middle that a bottom message is centred on', () => {
    test('a toast and a card at the bottom centre follow the shift that the script writes, and stay 12px inside the window', () => {
        const toast = ruleOf(themeCss, '#sb-toast-overlay.toast-bottom-center:not([data-sb-toast-in-dialog]) > .sb-form-toast');
        expect(toast).toContain('--sb-toast-room: max(0px, calc((100cqw - 24px - 100%) / 2))');
        expect(toast).toContain('translate: clamp(calc(-1 * var(--sb-toast-room)), var(--sb-toast-bar-shift, 0px), var(--sb-toast-room))');
        const card = ruleOf(themeCss, 'body #toast-container[class].toast-bottom-center > .sb-form-notification');
        expect(card).toContain('--sb-toast-room: max(0px, calc((100vw - 24px - 100%) / 2))');
        expect(card).toContain('translate: clamp(calc(-1 * var(--sb-toast-room)), var(--sb-toast-bar-shift, 0px), var(--sb-toast-room))');
    });

    test('the room is the allowance of the width of each form: the toast takes the window minus 24px, and so does the card', () => {
        expect(ruleOf(themeCss, TOAST)).toContain('max-width: min(34em, calc(100cqw - 24px))');
        expect(ruleOf(themeCss, NOTIFICATION)).toContain('max-width: calc(100% - 24px)');
    });

    test('the shift eases unless motion is reduced, and a toast in a dialog is not shifted', () => {
        expect(themeCss).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*body:not\(\.reduced-motion\) :is\(#sb-toast-overlay\.toast-bottom-center > \.sb-form-toast, #toast-container\.toast-bottom-center > \.sb-form-notification\) \{\s*transition: translate var\(--sb-transition-slow\);/);
        expect(themeCss).toContain('#sb-toast-overlay.toast-bottom-center:not([data-sb-toast-in-dialog]) > .sb-form-toast {');
    });
});

