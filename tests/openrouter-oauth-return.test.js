/* global globalThis */
import { afterAll, describe, expect, jest, test } from '@jest/globals';

const OPENROUTER_KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys';
const VERIFIER_KEY = 'default-user_openrouter_code_verifier';

await jest.unstable_mockModule('../public/lib.js', () => ({
    DOMPurify: {},
    moment: () => ({ format: () => 'test label' }),
    sha256: { array: () => [] },
}));

await jest.unstable_mockModule('../public/script.js', () => ({
    event_types: {},
    eventSource: { emit: jest.fn(async () => {}) },
    getRequestHeaders: () => ({}),
    saveSettings: jest.fn(async () => {}),
    saveSettingsDebounced: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => `${text}${part}${values[index] ?? ''}`, ''),
}));

await jest.unstable_mockModule('../public/scripts/openai.js', () => ({
    chat_completion_sources: {},
}));

await jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    callGenericPopup: jest.fn(),
    Popup: {},
    POPUP_RESULT: {},
    POPUP_TYPE: {},
}));

await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommand.js', () => ({
    SlashCommand: {},
}));

await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandArgument.js', () => ({
    ARGUMENT_TYPE: {},
    SlashCommandArgument: {},
    SlashCommandNamedArgument: {},
}));

await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandCommonEnumsProvider.js', () => ({
    enumIcons: {},
}));

await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandEnumValue.js', () => ({
    enumTypes: {},
    SlashCommandEnumValue: {},
}));

await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandExecutor.js', () => ({
    SlashCommandExecutor: {},
}));

await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandParser.js', () => ({
    SlashCommandParser: {},
}));

await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandScope.js', () => ({
    SlashCommandScope: {},
}));

await jest.unstable_mockModule('../public/scripts/templates.js', () => ({
    renderTemplateAsync: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/textgen-settings.js', () => ({
    textgen_types: {},
}));

await jest.unstable_mockModule('../public/scripts/user.js', () => ({
    getCurrentUserHandle: () => 'default-user',
}));

await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    copyText: jest.fn(),
    isTrueBoolean: jest.fn(),
    uuidv4: jest.fn(),
}));

const { accountStorage } = await import('../public/scripts/util/AccountStorage.js');
const { checkOpenRouterAuth, readSecretState } = await import('../public/scripts/secrets.js');

const nativeFetch = globalThis.fetch;

function jsonResponse(body) {
    return { ok: true, json: async () => body };
}

function installBrowser(url) {
    const location = new URL(url);
    const serverSecrets = {};
    const element = { style: {}, innerHTML: '', appendChild: jest.fn(), setAttribute: jest.fn() };
    const jqueryElement = { attr: jest.fn(() => ''), trigger: jest.fn(() => jqueryElement), val: jest.fn(() => jqueryElement) };
    const browser = {
        location,
        toastr: { error: jest.fn(), success: jest.fn() },
        fetch: jest.fn(async (requestUrl, options) => {
            switch (requestUrl) {
                case '/api/secrets/read':
                    return jsonResponse(serverSecrets);
                case '/api/secrets/write': {
                    const { key, value, label } = JSON.parse(options.body);
                    serverSecrets[key] = [{ id: 'secret-1', value, label, active: true }];
                    return jsonResponse({ id: 'secret-1' });
                }
                case OPENROUTER_KEYS_URL:
                    return jsonResponse({ key: 'sk-or-v1-test' });
                default:
                    throw new Error(`Unexpected request: ${requestUrl}`);
            }
        }),
    };

    globalThis.$ = () => jqueryElement;
    globalThis.document = {
        body: element,
        createElement: () => element,
        getElementById: () => element,
        querySelectorAll: () => [element],
    };
    globalThis.location = location;
    globalThis.window = {
        location,
        history: { pushState: (state, title, nextUrl) => { location.href = nextUrl; } },
    };
    globalThis.toastr = browser.toastr;
    globalThis.fetch = browser.fetch;
    return browser;
}

afterAll(() => {
    delete globalThis.$;
    delete globalThis.document;
    delete globalThis.location;
    delete globalThis.window;
    delete globalThis.toastr;
    globalThis.fetch = nativeFetch;
});

describe('OpenRouter OAuth return', () => {
    test('keeps the code for the check that runs after account storage loads', async () => {
        const browser = installBrowser(`http://localhost/?source=openrouter&query=${encodeURIComponent('code=auth-code')}`);

        await readSecretState();
        accountStorage.init({ __migrated: '2', [VERIFIER_KEY]: 'pkce-verifier' });
        await checkOpenRouterAuth();

        const exchange = browser.fetch.mock.calls.find(([requestUrl]) => requestUrl === OPENROUTER_KEYS_URL);
        expect(exchange).toBeDefined();
        expect(JSON.parse(exchange[1].body)).toEqual({
            code: 'auth-code',
            code_verifier: 'pkce-verifier',
            code_challenge_method: 'S256',
        });
        expect(browser.toastr.error).not.toHaveBeenCalled();
        expect(browser.toastr.success).toHaveBeenCalledWith('OpenRouter token saved');
        expect(browser.location.search).toBe('');
        expect(accountStorage.getItem(VERIFIER_KEY)).toBeNull();
    });
});
