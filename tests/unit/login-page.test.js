/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions and static markup/CSS contracts. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, jest, test } from '@jest/globals';

const root = fileURLToPath(new URL('../../public/', import.meta.url));
const html = readFileSync(path.join(root, 'login.html'), 'utf8');
const css = readFileSync(path.join(root, 'css', 'login.css'), 'utf8');
const jquerySource = readFileSync(path.join(root, 'lib', 'jquery-3.5.1.min.js'), 'utf8');

function extractBodyHtml(documentHtml) {
    const match = documentHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (!match) throw new Error('Missing body in login.html');
    return match[1].replace(/<script[\s\S]*?<\/script>/gi, '');
}

async function flushMicrotasks() {
    for (let turn = 0; turn < 8; turn += 1) {
        await Promise.resolve();
    }
}

describe('the login page', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        delete globalThis.fetch;
        jest.restoreAllMocks();
        jest.resetModules();
    });

    test('keeps every field, button and handler target that login.js queries', () => {
        for (const id of [
            'userList', 'handleEntryBlock', 'userHandle', 'passwordEntryBlock', 'userPassword', 'recoverPassword',
            'loginButton', 'passwordRecoveryBlock', 'recoveryCode', 'newPassword', 'sendRecovery', 'cancelRecovery',
            'errorMessage', 'normalLoginPrompt', 'discreetLoginPrompt', 'shadow_popup',
        ]) {
            expect(html).toContain(`id="${id}"`);
        }
    });

    test('announces a failure, and renders user cards as keyboard-activatable buttons', async () => {
        expect(html).toContain('<div class="neutral_warning" id="errorMessage" role="alert"></div>');

        jest.resetModules();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        (0, eval)(jquerySource);
        document.body.innerHTML = extractBodyHtml(html);

        const loginRequests = [];
        globalThis.fetch = jest.fn(async (url, options = {}) => {
            if (url === '/csrf-token') {
                return { ok: true, status: 200, json: async () => ({ token: 'csrf-123' }) };
            }
            if (url === '/api/users/list') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ([
                        { handle: 'alice', name: 'Alice', avatar: '/img/alice.png', password: true },
                        { handle: 'bob', name: 'Bob', avatar: '/img/bob.png', password: false },
                    ]),
                };
            }
            if (url === '/api/users/login') {
                loginRequests.push(JSON.parse(options.body));
                return { ok: false, status: 403, json: async () => ({ error: 'Invalid credentials' }) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await jest.unstable_mockModule(fileURLToPath(new URL('../../public/scripts/a11y.js', import.meta.url)), () => ({
            initAccessibility: jest.fn(),
        }));

        await import('../../public/scripts/login.js');
        await flushMicrotasks();

        const cards = [...document.querySelectorAll('#userList .userSelect')];
        expect(cards).toHaveLength(2);
        for (const card of cards) {
            expect(card.getAttribute('role')).toBe('button');
            expect(card.getAttribute('tabindex')).toBe('0');
            expect(card.querySelector('img').getAttribute('alt')).toBe('');
        }

        // Pressing Enter activates the passworded user card and reveals password entry.
        const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        cards[0].dispatchEvent(enterEvent);
        expect(enterEvent.defaultPrevented).toBe(true);
        expect(document.getElementById('passwordEntryBlock').style.display).not.toBe('none');

        // Pressing Space activates the passwordless user card and surfaces login errors in the alert region.
        const spaceEvent = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
        cards[1].dispatchEvent(spaceEvent);
        await flushMicrotasks();

        expect(spaceEvent.defaultPrevented).toBe(true);
        expect(loginRequests).toEqual([{ handle: 'bob', password: '' }]);
        expect(document.getElementById('errorMessage').textContent).toBe('Invalid credentials');
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
