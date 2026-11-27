/** @jest-environment jsdom */
/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pub = relative => fileURLToPath(new URL(`../../public/${relative}`, import.meta.url));
const cachedJQuerySource = readFileSync(pub('lib/jquery-3.5.1.min.js'), 'utf8');
const OriginalFetch = globalThis.fetch;

afterEach(() => {
    document.body.innerHTML = '';
    globalThis.fetch = OriginalFetch;
    jest.restoreAllMocks();
});

function ensureJQuery() {
    if (!window.jQuery) {
        (0, eval)(cachedJQuerySource);
    }
    globalThis.$ = window.jQuery;
    globalThis.jQuery = window.jQuery;
    return window.jQuery;
}

function makeResponse(body, { status = 200, statusText = '', headers = {} } = {}) {
    const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const textBody = typeof body === 'string' ? body : JSON.stringify(body);
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText,
        headers: { get: key => headerMap.get(String(key).toLowerCase()) ?? null },
        text: async () => textBody,
        json: async () => JSON.parse(textBody),
        blob: async () => new Blob([textBody], { type: headerMap.get('content-type') || 'application/json' }),
    };
}

describe('upstream character import callers (utils.js and extensions/assets)', () => {
    test('utils.importFromExternalUrl delegates character imports to processDroppedFiles with preserveFileName and propagates aborts', async () => {
        jest.resetModules();
        const processDroppedFiles = jest.fn(async () => {});
        const toastr = { info: jest.fn(), warning: jest.fn(), error: jest.fn() };
        globalThis.toastr = toastr;

        globalThis.fetch = jest.fn(async () => makeResponse('{}', {
            headers: {
                'X-Custom-Content-Type': 'character',
                'Content-Type': 'application/json',
                'Content-Disposition': 'attachment; filename="card.json"',
            },
        }));

        await jest.unstable_mockModule(pub('lib.js'), () => ({
            moment: jest.fn(),
            DOMPurify: { sanitize: v => String(v ?? '') },
            Readability: class {},
            isProbablyReaderable: () => false,
            lodash: { debounce: fn => fn, throttle: fn => fn },
        }));
        await jest.unstable_mockModule(pub('script.js'), () => ({
            animation_duration: 0,
            characters: [],
            getRequestHeaders: () => ({}),
            processDroppedFiles,
            this_chid: 0,
            user_avatar: '',
        }));
        await jest.unstable_mockModule(pub('scripts/extensions.js'), () => ({ getContext: jest.fn(() => ({})) }));
        await jest.unstable_mockModule(pub('scripts/RossAscends-mods.js'), () => ({ isMobile: () => false }));
        await jest.unstable_mockModule(pub('scripts/power-user.js'), () => ({ collapseNewlines: v => v, power_user: {} }));
        await jest.unstable_mockModule(pub('scripts/constants.js'), () => ({ debounce_timeout: { short: 1 } }));
        await jest.unstable_mockModule(pub('scripts/popup.js'), () => ({ Popup: class {}, POPUP_RESULT: {}, POPUP_TYPE: {} }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-delete-confirm.js'), () => ({ confirmVerb: () => ({}) }));
        await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandClosure.js'), () => ({ SlashCommandClosure: class {} }));
        await jest.unstable_mockModule(pub('scripts/tags.js'), () => ({ getTagsList: () => [] }));
        await jest.unstable_mockModule(pub('scripts/group-chats.js'), () => ({ groups: [], selected_group: null }));
        await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
            getCurrentLocale: () => 'en',
            t: (s, ...v) => s.reduce((o, p, i) => o + p + (v[i] ?? ''), ''),
        }));
        await jest.unstable_mockModule(pub('scripts/world-info.js'), () => ({ importWorldInfo: jest.fn() }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-version-map.js'), () => ({ mapSillyBunnyVersionToStEquivalent: v => v }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/adapters/utility-dialogs.js'), () => ({ iconPickerOptions: () => ({}) }));

        const { importFromExternalUrl } = await import('../../public/scripts/utils.js');

        await importFromExternalUrl('https://example.invalid/card', { preserveFileName: 'current.png' });
        expect(processDroppedFiles).toHaveBeenCalledTimes(1);
        const [files, extraData] = processDroppedFiles.mock.calls[0];
        expect(files).toHaveLength(1);
        expect(files[0].name).toBe('card.json');
        expect(extraData.get(files[0])).toBe('current.png');

        processDroppedFiles.mockRejectedValueOnce(new Error('Cannot import character while generating'));
        await expect(importFromExternalUrl('https://example.invalid/card', { preserveFileName: 'current.png' }))
            .rejects.toThrow('Cannot import character while generating');
    });

    test('extensions/assets installAsset passes file and fileNameMap to processDroppedFiles and reports failure when generation aborts it', async () => {
        jest.resetModules();
        const $ = ensureJQuery();
        document.body.innerHTML = '<div id="assets_container"></div>';
        globalThis.toastr = { info: jest.fn(), warning: jest.fn(), error: jest.fn() };

        const listeners = new Map();
        const eventSource = {
            on: (event, fn) => listeners.set(event, fn),
            emit: async (event, ...args) => listeners.get(event)?.(...args),
        };
        const processDroppedFiles = jest.fn(async () => {});
        const callGenericPopup = jest.fn();

        globalThis.fetch = jest.fn(async (url) => {
            if (url === '/api/assets/download') {
                return makeResponse('{}', { headers: { 'Content-Type': 'application/json' } });
            }
            return makeResponse([
                { type: 'character', id: 'card.json', name: 'Card', url: 'https://example.invalid/card', highlight: false },
            ]);
        });

        await jest.unstable_mockModule(pub('lib.js'), () => ({ DOMPurify: { sanitize: v => String(v ?? '') } }));
        await jest.unstable_mockModule(pub('script.js'), () => ({
            getRequestHeaders: () => ({}),
            processDroppedFiles,
            eventSource,
            event_types: { OPEN_CHARACTER_LIBRARY: 'open_character_library' },
        }));
        await jest.unstable_mockModule(pub('scripts/extensions.js'), () => ({
            deleteExtension: jest.fn(),
            EMPTY_AUTHOR: '',
            extensionNames: [],
            getAuthorFromUrl: jest.fn(),
            getContext: jest.fn(() => ({ characters: [] })),
            installExtension: jest.fn(),
            renderExtensionTemplateAsync: jest.fn(async (_module, name) => {
                if (name === 'window') return '<div><input id="assets-json-url-field" /><button id="assets-characters-button"></button><button id="assets-connect-button"></button><div id="assets_filters"></div></div>';
                if (name === 'market') return '<div><div class="contestWinnersList"></div><div class="featuredCharactersList"></div></div>';
                return '<div><button class="characterAssetDownloadButton"></button><span class="characterAssetCheckMark"></span></div>';
            }),
            isOfficialExtension: jest.fn(() => false),
        }));
        await jest.unstable_mockModule(pub('scripts/popup.js'), () => ({
            POPUP_TYPE: { TEXT: 1 },
            Popup: { show: { confirm: jest.fn(async () => 1) } },
            callGenericPopup,
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-delete-confirm.js'), () => ({ confirmVerb: () => ({}) }));
        await jest.unstable_mockModule(pub('scripts/util/AccountStorage.js'), () => ({ accountStorage: { getItem: () => null, setItem: jest.fn() } }));
        await jest.unstable_mockModule(pub('scripts/utils.js'), () => ({
            escapeHtml: v => String(v ?? ''),
            flashHighlight: jest.fn(),
            getStringHash: v => String(v ?? ''),
            isValidUrl: value => String(value).startsWith('https://'),
        }));
        await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
            t: (s, ...v) => s.reduce((o, p, i) => o + p + (v[i] ?? ''), ''),
            translate: v => v,
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/status-page.js'), () => ({ setIconBusy: jest.fn() }));
        await jest.unstable_mockModule(pub('scripts/slash-commands/SlashCommandParser.js'), () => ({
            SlashCommandParser: { commands: { go: { callback: jest.fn() } } },
        }));

        const assetsMod = await import('../../public/scripts/extensions/assets/index.js');
        await assetsMod.init();
        await eventSource.emit('open_character_library', true);
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(callGenericPopup).toHaveBeenCalledTimes(1);

        const marketTemplate = callGenericPopup.mock.calls[0][0];
        const downloadButton = marketTemplate.find('.characterAssetDownloadButton');
        const checkMark = marketTemplate.find('.characterAssetCheckMark');
        const clickHandler = $._data(downloadButton[0], 'events').click[0].handler;

        // First: generation-active rejection causes installAsset to return false, keeping download visible.
        processDroppedFiles.mockRejectedValueOnce(new Error('Cannot import character while generating'));
        await clickHandler.call(downloadButton[0]);
        expect(processDroppedFiles).toHaveBeenCalledTimes(1);
        const [failedFiles, failedMap] = processDroppedFiles.mock.calls[0];
        expect(failedFiles[0].name).toBe('card.json');
        expect(failedMap.get(failedFiles[0])).toBe('card.json');
        expect(downloadButton.css('display')).not.toBe('none');
        expect(checkMark.css('display')).toBe('none');

        // Second: successful import switches the button to the installed checkmark.
        await clickHandler.call(downloadButton[0]);
        expect(processDroppedFiles).toHaveBeenCalledTimes(2);
        expect(downloadButton.css('display')).toBe('none');
        expect(checkMark.css('display')).not.toBe('none');
    });
});
