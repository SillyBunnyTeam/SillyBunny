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
const BUTTONS = BUTTON_SELECTOR.split(',').map(part => part.trim());

describe('the toast layer', () => {
    test('an in-app notification keeps the pill look until its own form is drawn', () => {
        const rule = ruleOf(themeCss, 'body #toast-container[class] > div');
        expect(rule).toContain('border-radius: var(--sb-radius-pill) !important');
        expect(rule).toContain('width: fit-content');
        expect(rule).toContain('max-width: min(450px, calc(100% - 24px))');
        expect(rule).toContain('margin: 12px auto 0');
        expect(themeCss).not.toMatch(/\.toast \{\s*border-radius: var\(--sb-radius-md\)/);
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
        expect(ring.slice(0, ring.indexOf('}'))).toContain('body :is(#toast-container, #sb-toast-overlay) > .toast > .toast-close-button:focus-visible');
        expect(ring.slice(ring.indexOf('{'), ring.indexOf('}')).replace(/\s+/g, ' ')).toContain('box-shadow: var(--sb-focus-ring-inset)');
    });

    test('the label is bold and may shrink, and the one button sits at the end of it', () => {
        const label = ruleOf(themeCss, `${TOAST} > .toast-message`);
        expect(label).toContain('font-weight: 700');
        expect(label).toContain('min-width: 0');
        expect(label).toContain('flex: 1 1 auto');
    });

    test('the status glyph is the first part of a toast, in the lifted status colour, 16px', () => {
        expect(ruleOf(themeCss, '#sb-toast-overlay > .sb-form-toast:not(.toast-info)::before')).toContain('font-size: 16px');
        expect(ruleOf(themeCss, ':is(#toast-container, #sb-toast-overlay) > .toast:not(.toast-info)')).toContain('background-image: none !important');
    });

    test('the close button of both forms is round and flat, 34px, with a 44px target on a coarse pointer', () => {
        const rule = ruleOf(themeCss, ':is(#toast-container, #sb-toast-overlay) > .toast > .toast-close-button');
        expect(rule).toContain('width: 34px');
        expect(rule).toContain('height: 34px');
        expect(rule).toContain('border-radius: var(--sb-radius-pill)');
        expect(rule).toContain('background: transparent');
        expect(rule).toContain('min-height: 0');
        expect(themeCss).toMatch(/@media \(pointer: coarse\) \{\s*:is\(#toast-container, #sb-toast-overlay\) > \.toast > \.toast-close-button::after \{\s*content: '';\s*position: absolute;\s*inset: -5px;/);
    });

    test('the status colour reaches the icon glyph and the title, and nothing else', () => {
        expect(ruleOf(themeCss, ':is(#toast-container, #sb-toast-overlay) > .toast-error')).toContain('--sb-toast-src: var(--sb-color-danger)');
        expect(ruleOf(themeCss, ':is(#toast-container, #sb-toast-overlay) > .toast-warning')).toContain('--sb-toast-src: var(--sb-color-warning)');
        expect(ruleOf(themeCss, ':is(#toast-container, #sb-toast-overlay) > .toast-success')).toContain('--sb-toast-src: var(--sb-color-success)');
        expect(ruleOf(themeCss, ':is(#toast-container, #sb-toast-overlay) > .toast:not(.toast-info)::before,\n:is(#toast-container, #sb-toast-overlay) > .toast:not(.toast-info) .toast-title')).toBe('color: var(--sb-toast-status);');
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
        expect(top).toContain('margin-top: var(--topBarBlockSize)');
    });

    test('in a dialog it is at the bottom of the dialog\'s box, as the containing block that a dialog keeps for it', () => {
        const rule = ruleOf(themeCss, 'dialog > #sb-toast-overlay[data-sb-toast-in-dialog]');
        expect(rule).toContain('position: absolute');
        expect(rule).toContain('inset: auto auto var(--sb-toast-frame-bottom, 0px) var(--sb-toast-frame-left, 0px)');
        expect(rule).toContain('width: var(--sb-toast-frame-width, 100%)');
        expect(rule).toContain('clip-path: inset(-100vmax -100vmax 0)');
    });

    test('an in-app notification at the position of the toasts sits beyond them by the offset that the script writes', () => {
        expect(ruleOf(themeCss, 'body #toast-container:is(.toast-top-left, .toast-top-center, .toast-top-right)')).toBe('margin-top: calc(var(--topBarBlockSize) + var(--sb-toast-stack-offset, 0px));');
        expect(ruleOf(themeCss, 'body #toast-container:is(.toast-bottom-left, .toast-bottom-center, .toast-bottom-right)')).toBe('margin-bottom: var(--sb-toast-stack-offset, 0px);');
    });

    test('a toast does not fade in: it has no CSS enter animation, and the CSS exit animation is the notification\'s only', () => {
        expect(ruleOf(themeCss, TOAST)).toContain('animation: none');
        expect(themeCss).toContain('#toast-container > div.sb-toast-leaving {');
        expect(themeCss).not.toMatch(/:is\(#toast-container, #sb-toast-overlay\) > div\.sb-toast-leaving/);
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
