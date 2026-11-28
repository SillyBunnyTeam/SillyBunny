/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importScriptModule } from '../util/script-harness.js';

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
    delete document.documentElement.dataset.sbSettingsOpen;
    jest.restoreAllMocks();
});

async function setupCharacterNavRuntime({ same = false, flushImpl = null, isGroupGenerating = false } = {}) {
    const order = [];
    const fetchMock = jest.fn(async (url) => {
        if (url === '/api/chats/save') {
            order.push('flush');
            if (flushImpl) return flushImpl();
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        if (url === '/api/chats/get') {
            order.push('fetch');
            return { ok: true, status: 200, json: async () => [{ chat_metadata: {} }, { name: 'Character', mes: 'hello', extra: {} }] };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    });

    loaded = await importScriptModule({
        dom: `
            <div id="row" tabindex="0"></div>
            <div id="options_button"></div>
            <div id="options"></div>
            <div id="export_button"></div>
            <div id="export_format_popup"></div>
            <div id="online_status_indicator"></div>
            <div id="online_status_text"></div>
            <select id="main_api"><option value="openai" selected>openai</option></select>
            <div id="chat"></div>
            <div id="message_template" hidden><div class="mes"><div class="mes_block"><div class="mes_text"></div></div></div></div>
            <textarea id="send_textarea"></textarea>
            <input id="search" />
            <div id="send_but"></div>
            <div id="mes_stop"></div>
        `,
        fetch: fetchMock,
        mocks: {
            'scripts/group-chats.js': {
                selected_group: isGroupGenerating ? 'group-a' : null,
                is_group_generating: isGroupGenerating,
            },
            'scripts/utils.js': {
                delay: jest.fn(async () => {}),
            },
        },
    });

    loaded.script.characters.push(
        { name: 'Alpha', avatar: 'a.png', chat: 'chat-a', data: { extensions: {} } },
        { name: 'Beta', avatar: 'b.png', chat: 'chat-b', data: { extensions: {} } },
    );
    loaded.script.setCharacterId(same ? 1 : 0);
    loaded.script.setCharacterName(same ? 'Beta' : 'Alpha');
    loaded.script.chat.push({ name: 'Alpha', mes: 'existing', extra: {} });

    return { ...loaded, order, fetchMock };
}

describe('character chat navigation acceptance boundary', () => {
    test('character accepts once, after flush and before any selection mutation or fetch', async () => {
        let finishFlush;
        const flushPromise = new Promise(resolve => {
            finishFlush = () => resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
        });
        const runtime = await setupCharacterNavRuntime({ flushImpl: () => flushPromise });
        runtime.script.saveChatDebounced();

        const accepted = jest.fn(() => {
            runtime.order.push(`accepted:chid=${runtime.script.this_chid}`);
        });
        const pending = runtime.script.selectCharacterById(1, { switchMenu: false, onAccepted: accepted });
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(accepted).not.toHaveBeenCalled();
        expect(runtime.script.this_chid).toBe('0');
        expect(runtime.order).toEqual(['flush']);

        finishFlush();
        expect(await pending).toBe(true);
        expect(accepted).toHaveBeenCalledTimes(1);
        expect(runtime.order).toEqual(['flush', 'accepted:chid=0', 'fetch']);
        expect(runtime.script.this_chid).toBe('1');
    });

    test('character current-chat acceptance also flushes, while default callers skip the flush', async () => {
        const runtime = await setupCharacterNavRuntime({ same: true });
        runtime.script.saveChatDebounced();

        const accepted = jest.fn(() => runtime.order.push('accepted'));
        expect(await runtime.script.selectCharacterById(1, { switchMenu: false, onAccepted: accepted })).toBe(true);
        expect(accepted).toHaveBeenCalledTimes(1);
        expect(runtime.order).toEqual(['flush', 'accepted']);

        runtime.order.length = 0;
        runtime.script.saveChatDebounced();
        expect(await runtime.script.selectCharacterById(1, { switchMenu: false })).toBe(true);
        expect(runtime.order).toEqual([]);
    });

    test('character never accepts a missing, group-generating, or failed-flush selection', async () => {
        const runtime = await setupCharacterNavRuntime({
            flushImpl: async () => ({ ok: false, status: 500, statusText: 'Failed', json: async () => ({}) }),
        });
        const accepted = jest.fn();

        expect(await runtime.script.selectCharacterById(99, { onAccepted: accepted })).toBe(false);

        runtime.script.saveChatDebounced();
        expect(await runtime.script.selectCharacterById(1, { onAccepted: accepted })).toBe(false);
        expect(accepted).not.toHaveBeenCalled();
        runtime.cleanup();
        loaded = null;

        const generatingRuntime = await setupCharacterNavRuntime({ isGroupGenerating: true });
        expect(await generatingRuntime.script.selectCharacterById(1, { onAccepted: accepted })).toBe(false);
        expect(accepted).not.toHaveBeenCalled();
    });
});

describe('deferred chat autofocus', () => {
    test.each([
        [true, false],
        [false, false],
        [false, true],
    ])('shell open=%s and existing text focus=%s preserve the correct focus owner', async (shellOpen, textFocused) => {
        let finishDelay;
        loaded = await importScriptModule({
            dom: `
                <div id="row" tabindex="0"></div>
                <div id="options_button"></div>
                <div id="options"></div>
                <div id="export_button"></div>
                <div id="export_format_popup"></div>
                <div id="online_status_indicator"></div>
                <div id="online_status_text"></div>
                <select id="main_api"><option value="openai" selected>openai</option></select>
                <div id="chat"></div>
                <div id="message_template" hidden><div class="mes"><div class="mes_block"><div class="mes_text"></div></div></div></div>
                <textarea id="send_textarea"></textarea>
                <input id="search" />
                <div id="send_but"></div>
                <div id="mes_stop"></div>
            `,
            fetch: jest.fn(async (url) => {
                if (url === '/api/chats/get') {
                    return { ok: true, status: 200, json: async () => [{ chat_metadata: {} }, { name: 'Character', mes: 'hello', extra: {} }] };
                }
                return { ok: true, status: 200, json: async () => ({}) };
            }),
            mocks: {
                'scripts/utils.js': {
                    delay: jest.fn(() => new Promise(resolve => { finishDelay = resolve; })),
                },
            },
        });

        loaded.script.characters.push({ name: 'Character', avatar: 'char.png', chat: 'chat', data: { extensions: {} } });
        loaded.script.setCharacterId(0);
        loaded.script.setCharacterName('Character');

        const row = document.getElementById('row');
        const input = document.getElementById('search');
        input.getClientRects = () => [{}];

        expect(await loaded.script.getChat()).toBe(true);
        document.documentElement.dataset.sbSettingsOpen = String(shellOpen);
        const focusOwner = textFocused ? input : row;
        focusOwner.focus();

        finishDelay();
        await Promise.resolve();
        await Promise.resolve();

        expect(document.activeElement).toBe(shellOpen || textFocused ? focusOwner : document.getElementById('send_textarea'));
    });
});
