/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pub = rel => fileURLToPath(new URL(`../../public/${rel}`, import.meta.url));
const readTemplate = name => readFileSync(pub(`scripts/templates/${name}.html`), 'utf8');

const activeCleanups = [];

afterEach(() => {
    while (activeCleanups.length) activeCleanups.pop()();
    document.body.replaceChildren();
    jest.restoreAllMocks();
});

async function flushAsync(ms = 20) {
    await new Promise(resolve => setTimeout(resolve, ms));
    await Promise.resolve();
}

function loadJQuery() {
    let real$ = window.jQuery || globalThis.jQuery;
    if (typeof real$ !== 'function' || !real$.fn) {
        const source = readFileSync(pub('lib/jquery-3.5.1.min.js'), 'utf8');
        (0, eval)(source);
        real$ = window.jQuery || globalThis.jQuery;
    }
    return real$;
}

describe('upstream misc-dialog seam (user.js account actions)', () => {
    test('user.js account dialogs apply accountFormOptions, destructive defaultResult: NEGATIVE, and exact POST payloads', async () => {
        const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };
        const POPUP_TYPE = { TEXT: 1, CONFIRM: 2, INPUT: 3, CROP: 5 };
        const popupCalls = [];
        const fetchCalls = [];
        const readyCallbacks = [];

        const origFetch = globalThis.fetch;
        const mockFetch = jest.fn(async (url, options = {}) => {
            fetchCalls.push({ url, options });
            if (url === '/api/users/me') {
                return {
                    ok: true,
                    json: async () => ({ handle: 'admin', name: 'Admin', admin: true, password: true, avatar: '', created: Date.now() }),
                };
            }
            if (url === '/api/users/get') {
                return {
                    ok: true,
                    json: async () => ([
                        { handle: 'alice', name: 'Alice', admin: false, enabled: true, password: true, avatar: '', created: Date.now() },
                    ]),
                };
            }
            if (url === '/api/settings/get-snapshots') {
                return {
                    ok: true,
                    json: async () => ([{ name: 'snap-1.json', date: Date.now(), size: 128 }]),
                };
            }
            return { ok: true, json: async () => ({}), text: async () => '{}' };
        });
        globalThis.fetch = mockFetch;
        window.fetch = mockFetch;
        activeCleanups.push(() => {
            globalThis.fetch = origFetch;
            window.fetch = origFetch;
        });

        const intervalSpy = jest.spyOn(window, 'setInterval').mockImplementation(() => 1);
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
        activeCleanups.push(() => {
            intervalSpy.mockRestore();
            consoleError.mockRestore();
        });

        const toastr = { info: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() };
        window.toastr = toastr;
        globalThis.toastr = toastr;

        const prevGlobal$ = globalThis.$;
        const prevGlobalJQuery = globalThis.jQuery;
        const real$ = loadJQuery();
        const wrapped$ = new Proxy(real$, {
            apply(target, thisArg, argArray) {
                if (argArray.length === 1 && typeof argArray[0] === 'function') {
                    readyCallbacks.push(argArray[0]);
                    return target(document);
                }
                return Reflect.apply(target, thisArg, argArray);
            },
        });
        window.$ = wrapped$;
        window.jQuery = wrapped$;
        globalThis.$ = wrapped$;
        globalThis.jQuery = wrapped$;
        activeCleanups.push(() => {
            window.$ = prevGlobal$;
            window.jQuery = prevGlobalJQuery;
            globalThis.$ = prevGlobal$;
            globalThis.jQuery = prevGlobalJQuery;
        });

        let nextPopupHandler = null;
        const callGenericPopup = jest.fn(async (content, type, inputValue, options) => {
            popupCalls.push({ content, type, inputValue, options });
            if (nextPopupHandler) {
                const handler = nextPopupHandler;
                nextPopupHandler = null;
                return await handler(content, options);
            }
            return POPUP_RESULT.NEGATIVE;
        });

        jest.resetModules();
        await jest.unstable_mockModule(pub('script.js'), () => ({
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        }));
        await jest.unstable_mockModule(pub('scripts/popup.js'), () => ({
            POPUP_RESULT,
            POPUP_TYPE,
            callGenericPopup,
        }));
        await jest.unstable_mockModule(pub('scripts/secrets.js'), () => ({ canViewSecrets: () => true }));
        await jest.unstable_mockModule(pub('scripts/templates.js'), () => ({
            renderTemplateAsync: jest.fn(async name => readTemplate(name)),
        }));
        await jest.unstable_mockModule(pub('scripts/utils.js'), () => ({
            ensureImageFormatSupported: async f => f,
            getBase64Async: async () => '',
            humanFileSize: n => `${n} B`,
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/adapters/window-content-dialogs.js'), () => ({
            accountProfileOptions: () => ({}),
            adminPanelOptions: () => ({}),
            snapshotsOptions: () => ({}),
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/picker.js'), () => ({
            closePicker: jest.fn(),
            isPickerOpen: () => false,
            openPicker: jest.fn(),
        }));
        await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
            t: (parts, ...values) => parts.reduce((acc, p, i) => acc + p + (values[i] ?? ''), ''),
        }));

        document.body.innerHTML = `
            <button id="account_button" type="button"></button>
            <button id="admin_button" type="button"></button>
            <button id="settings_snapshots_button" type="button"></button>
        `;

        const userModule = await import('../../public/scripts/user.js');
        while (readyCallbacks.length) readyCallbacks.shift()(real$);
        await userModule.setUserControls(true);

        // Open User Profile -> captures template for Change Password, Reset Settings, Reset Everything.
        real$('#account_button').trigger('click');
        await flushAsync();
        const profilePopup = popupCalls.pop();
        expect(profilePopup).toBeDefined();
        const profileTemplate = profilePopup.content;

        // 1. Change Password: uses accountFormOptions + sends { handle, newPassword, oldPassword }.
        fetchCalls.length = 0;
        nextPopupHandler = async (template, options) => {
            expect(options.tier).toBe('dialog');
            expect(options.title).toBe('Change Password');
            template.find('input[name="current"]').val('old-pw').trigger('input');
            template.find('input[name="password"]').val('new-pw').trigger('input');
            template.find('input[name="confirm"]').val('new-pw').trigger('input');
            return POPUP_RESULT.AFFIRMATIVE;
        };
        profileTemplate.find('.userChangePasswordButton').trigger('click');
        await flushAsync();
        expect(fetchCalls).toContainEqual(expect.objectContaining({
            url: '/api/users/change-password',
            options: expect.objectContaining({
                body: JSON.stringify({ handle: 'admin', newPassword: 'new-pw', oldPassword: 'old-pw' }),
            }),
        }));

        // 2. Reset Settings: defaultResult: NEGATIVE + Alert tier via accountFormOptions + sends { handle, password }.
        fetchCalls.length = 0;
        nextPopupHandler = async (template, options) => {
            expect(options.defaultResult).toBe(POPUP_RESULT.NEGATIVE);
            expect(options.tier).toBe('alert');
            template.find('input[name="password"]').val('secret-pw').trigger('input');
            return POPUP_RESULT.AFFIRMATIVE;
        };
        profileTemplate.find('.userResetSettingsButton').trigger('click');
        await flushAsync();
        expect(fetchCalls).toContainEqual(expect.objectContaining({
            url: '/api/users/reset-settings',
            options: expect.objectContaining({
                body: JSON.stringify({ handle: 'admin', password: 'secret-pw' }),
            }),
        }));

        // 3. Reset Everything: defaultResult: NEGATIVE + accountFormOptions + sends { password, code } to reset-step2.
        fetchCalls.length = 0;
        nextPopupHandler = async (template, options) => {
            expect(options.defaultResult).toBe(POPUP_RESULT.NEGATIVE);
            expect(options.tier).toBe('dialog');
            expect(options.title).toBe('Reset Everything');
            template.find('input[name="password"]').val('secret-pw').trigger('input');
            template.find('input[name="code"]').val('123456').trigger('input');
            return POPUP_RESULT.AFFIRMATIVE;
        };
        profileTemplate.find('.userResetAllButton').trigger('click');
        await flushAsync();
        expect(fetchCalls).toContainEqual(expect.objectContaining({
            url: '/api/users/reset-step2',
            options: expect.objectContaining({
                body: JSON.stringify({ password: 'secret-pw', code: '123456' }),
            }),
        }));

        // 4. Delete User (via Admin panel): defaultResult: NEGATIVE + accountFormOptions + sends { handle, purge }.
        real$('#admin_button').trigger('click');
        await flushAsync();
        const adminPopup = popupCalls.pop();
        expect(adminPopup).toBeDefined();
        const adminTemplate = adminPopup.content;

        fetchCalls.length = 0;
        nextPopupHandler = async (template, options) => {
            expect(options.defaultResult).toBe(POPUP_RESULT.NEGATIVE);
            expect(options.tier).toBe('dialog');
            template.find('input[name="deleteUserHandle"]').val('alice').trigger('input');
            template.find('input[name="deleteUserData"]').prop('checked', true).trigger('input');
            return POPUP_RESULT.AFFIRMATIVE;
        };
        adminTemplate.find('.usersList .userDelete').first().trigger('click');
        await flushAsync();
        expect(fetchCalls).toContainEqual(expect.objectContaining({
            url: '/api/users/delete',
            options: expect.objectContaining({
                body: JSON.stringify({ handle: 'alice', purge: true }),
            }),
        }));

        // 5. Restore Snapshot: defaultResult: NEGATIVE.
        real$('#settings_snapshots_button').trigger('click');
        await flushAsync();
        const snapshotsPopup = popupCalls.pop();
        expect(snapshotsPopup).toBeDefined();

        nextPopupHandler = async (_text, options) => {
            expect(options.defaultResult).toBe(POPUP_RESULT.NEGATIVE);
            return POPUP_RESULT.NEGATIVE;
        };
        snapshotsPopup.content.find('.snapshotList .snapshotRestoreButton').first().trigger('click');
        await flushAsync();
    });
});
