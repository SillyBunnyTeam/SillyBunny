import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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

describe('the toast layer', () => {
    test('a toast is a pill, as wide as its text up to 450px, 12px below the bar', () => {
        const rule = ruleOf(themeCss, 'body #toast-container[class] > div');
        expect(rule).toContain('border-radius: var(--sb-radius-pill) !important');
        expect(rule).toContain('width: fit-content');
        expect(rule).toContain('max-width: min(450px, calc(100% - 24px))');
        expect(rule).toContain('margin: 12px auto 0');
        expect(themeCss).not.toMatch(/\.toast \{\s*border-radius: var\(--sb-radius-md\)/);
    });

    test('the status colour reaches the icon glyph and the title, and nothing else', () => {
        expect(ruleOf(themeCss, '#toast-container > .toast-error')).toContain('--sb-toast-src: var(--sb-color-danger)');
        expect(ruleOf(themeCss, '#toast-container > .toast-warning')).toContain('--sb-toast-src: var(--sb-color-warning)');
        expect(ruleOf(themeCss, '#toast-container > .toast-success')).toContain('--sb-toast-src: var(--sb-color-success)');
        expect(ruleOf(themeCss, '#toast-container > .toast:not(.toast-info)::before,\n#toast-container > .toast:not(.toast-info) .toast-title')).toBe('color: var(--sb-toast-status);');
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
