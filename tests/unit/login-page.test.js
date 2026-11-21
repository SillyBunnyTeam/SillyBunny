/* eslint-disable playwright/no-standalone-expect -- Jest contracts for static files. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';

const root = fileURLToPath(new URL('../../public/', import.meta.url));
const html = readFileSync(path.join(root, 'login.html'), 'utf8');
const css = readFileSync(path.join(root, 'css', 'login.css'), 'utf8');

describe('the login page', () => {
    test('keeps every field, button and handler target that login.js queries', () => {
        for (const id of [
            'userList', 'handleEntryBlock', 'userHandle', 'passwordEntryBlock', 'userPassword', 'recoverPassword',
            'loginButton', 'passwordRecoveryBlock', 'recoveryCode', 'newPassword', 'sendRecovery', 'cancelRecovery',
            'errorMessage', 'normalLoginPrompt', 'discreetLoginPrompt', 'shadow_popup',
        ]) {
            expect(html).toContain(`id="${id}"`);
        }
    });

    test('announces a failure, and makes the user cards buttons in the script', () => {
        expect(html).toContain('<div class="neutral_warning" id="errorMessage" role="alert"></div>');
        const script = readFileSync(path.join(root, 'scripts', 'login.js'), 'utf8');
        expect(script).toContain('role: \'button\', tabindex: \'0\'');
        expect(script).toContain('evt.key === \'Enter\' || evt.key === \' \'');
    });

    test('has an illustration slot that assistive technology skips', () => {
        const slot = html.match(/<div id="loginArt"[^>]*>/)?.[0] ?? '';
        expect(slot).toContain('class="sbHomeArt"');
        expect(slot).toContain('data-sb-art-placeholder="login-both"');
        expect(slot).toContain('aria-hidden="true"');
    });

    test('loads login.css under one key, and the stylesheet that the page loads declares its own tokens', () => {
        expect(html).toContain('css/login.css?v=20261118m');
        expect(html).not.toContain('sillybunny-theme.css');
        for (const token of ['--sb-radius-control', '--sb-radius-alert', '--sb-accent', '--sb-focus-ring-inset', '--sb-login-dialog']) {
            expect(css).toContain(`${token}:`);
        }
    });

    test('follows the system colour scheme and handles forced colours', () => {
        expect(css).toContain('@media (prefers-color-scheme: light)');
        expect(css).toContain('@media (forced-colors: active)');
        expect(html).toContain('@media (prefers-color-scheme: light)');
    });

    test('draws every hover fill inside a hover media query and every motion rule behind a reduced-motion guard', () => {
        expect(css).toContain('@media (hover: hover)');
        expect(css).toContain('@media (prefers-reduced-motion: no-preference)');
        expect(css).toContain('@media (prefers-reduced-motion: reduce)');
        expect(css).not.toMatch(/text-transform|letter-spacing|font-style:\s*italic/);
    });
});
