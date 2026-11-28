/** @jest-environment jsdom */
/* global globalThis */
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importGroupChatsModule } from './util/group-chats-module-harness.js';
import { importScriptModule } from './util/script-harness.js';

const pub = rel => fileURLToPath(new URL(`../public/${rel}`, import.meta.url));

afterEach(() => {
    delete globalThis.toastr;
    jest.restoreAllMocks();
});

async function runGuidedCorrection({ groupId = null }) {
    jest.resetModules();
    document.body.innerHTML = '<textarea id="send_textarea"></textarea>';
    const textarea = document.getElementById('send_textarea');
    textarea.value = 'make the reply calmer';

    globalThis.toastr = {
        warning: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
    };

    const targetMessage = {
        name: 'Seraphina',
        is_user: false,
        is_system: false,
        original_avatar: 'seraphina.png',
        mes: 'Original reply',
        extra: {},
    };

    const context = {
        groupId,
        characters: [
            { name: 'Other', avatar: 'other.png' },
            { name: 'Seraphina', avatar: 'seraphina.png' },
        ],
        chat: [targetMessage],
        chatMetadata: { script_injects: {} },
        executeSlashCommandsWithOptions: jest.fn(async command => {
            if (String(command).startsWith('/inject ')) {
                context.chatMetadata.script_injects['gg-correction'] = { value: command };
            } else if (String(command).startsWith('/flushinject ')) {
                delete context.chatMetadata.script_injects['gg-correction'];
            }
        }),
        redisplayChat: jest.fn(async () => {}),
        saveChat: jest.fn(async () => {}),
        updateMessageBlock: jest.fn(),
        deleteMessage: jest.fn(async idx => { context.chat.splice(idx, 1); }),
    };

    let textareaValueDuringGenerate = null;
    const Generate = jest.fn(async (_type, _options) => {
        textareaValueDuringGenerate = textarea.value;
        context.chat.push({
            name: 'Seraphina',
            is_user: false,
            is_system: false,
            mes: 'Corrected reply',
            extra: {},
        });
    });

    await importGroupChatsModule({
        script: {
            Generate,
            eventSource: { emit: jest.fn(async () => {}) },
            event_types: { MESSAGE_EDITED: 'message_edited', MESSAGE_UPDATED: 'message_updated' },
            is_send_press: false,
        },
        toastr: globalThis.toastr,
    });
    await jest.unstable_mockModule(pub('scripts/extensions/guided-generations/scripts/shared.js'), () => ({
        applyPromptTemplate: (template, input) => `${template} ${input}`.trim(),
        debugLog: jest.fn(),
        extensionName: 'guided-generations',
        extension_settings: { 'guided-generations': { promptGuidedCorrection: 'Correct:' } },
        getContext: () => context,
        guidedCorrectionInjectId: 'gg-correction',
        getLastAiMessage: () => ({ index: 0, message: targetMessage }),
    }));

    const { guidedCorrection } = await import(pub('scripts/extensions/guided-generations/scripts/guidedCorrection.js'));
    await guidedCorrection();

    return {
        Generate,
        textarea,
        textareaValueDuringGenerate,
        context,
        targetMessage,
    };
}

describe('Guided Correction generation wiring', () => {
    test('retains correction targets without changing ordinary regeneration', async () => {
        const prepareOpenAIMessages = jest.fn(async () => [[{ role: 'user', content: 'Hi' }], 10]);
        const sendOpenAIRequest = jest.fn(async () => ({
            choices: [{ message: { content: 'Rewritten reply' } }],
        }));
        const loaded = await importScriptModule({
            keepReal: ['scripts/group-chats.js'],
            dom: `
                <div id="options_button"></div><div id="options"></div>
                <div id="export_button"></div><div id="export_format_popup"></div>
                <div id="online_status_indicator"></div><div id="online_status_text"></div>
                <select id="main_api"><option value="openai">openai</option></select>
                <div id="chat">
                    <div class="mes" mesid="0" is_system="false"></div>
                    <div class="mes" mesid="1" is_system="false"></div>
                </div>
                <div id="message_template" hidden><div class="mes"><div class="mes_block"><div class="ch_name"><span class="name_text"></span></div><div class="mes_text"></div></div></div></div>
                <textarea id="send_textarea"></textarea>
                <div id="send_but"></div><div id="mes_stop"></div>
            `,
            mocks: {
                'scripts/openai.js': base => ({
                    ...base,
                    openai_messages_count: 1,
                    prepareOpenAIMessages,
                    sendOpenAIRequest,
                }),
                'scripts/sillybunny-action-menu.js': { openActionMenu: jest.fn() },
                'scripts/sillybunny-editor/object-navigation.js': { objectNavigation: { navigate: jest.fn(async () => ({ ok: true })) } },
                'scripts/csrf-token-refresh.js': { fetchWithCsrfRetry: jest.fn(async (url, initOrFn) => globalThis.fetch(url, typeof initOrFn === 'function' ? await initOrFn() : initOrFn)) },
                'scripts/sillybunny-editor/list-pagination.js': { createListPagination: jest.fn() },
                'scripts/sillybunny-editor/list-search.js': { createListSearch: jest.fn() },
                'scripts/sillybunny-group-editor.js': {
                    beginGroupEditorLoad: jest.fn(),
                    openGroupEditorSession: jest.fn(),
                    openGroupEditorCreateSession: jest.fn(),
                    captureGroupEditorSave: jest.fn(),
                    readGroupEditorBaseline: jest.fn(),
                    isGroupEditorOwner: jest.fn(() => false),
                    notifyGroupEditorChanged: jest.fn(),
                    rebaseGroupEditor: jest.fn(),
                    initGroupEditor: jest.fn(),
                    discardGroupEditorForEntity: jest.fn(),
                    attachGroupTagFilterMenus: jest.fn(),
                    prepareGroupEditorReveal: jest.fn(async () => true),
                    setGroupEditorFolderValue: jest.fn(),
                },
            },
        });
        const { script } = loaded;
        script.changeMainAPI('openai');
        script.setOnlineStatus('connected');
        script.characters.push({ name: 'Seraphina', avatar: 'seraphina.png', description: '', personality: '', scenario: '', first_mes: 'Hi' });
        script.setCharacterId('0');
        script.chat.push(
            { name: 'User', is_user: true, mes: 'Hello' },
            { name: 'Seraphina', is_user: false, mes: 'Original reply', extra: {} },
        );

        expect(script.getNextMessageId('regenerate', true)).toBe(1);
        expect(script.getNextMessageId('regenerate', false)).toBe(2);

        let chatLengthAtAfterCommands = null;
        let lastInContextMesId = null;
        loaded.eventSource.on(script.event_types.GENERATION_AFTER_COMMANDS, () => {
            chatLengthAtAfterCommands = script.chat.length;
        });
        sendOpenAIRequest.mockImplementationOnce(async () => {
            lastInContextMesId = document.querySelector('#chat .mes.lastInContext')?.getAttribute('mesid') ?? null;
            return { choices: [{ message: { content: 'Corrected reply' } }] };
        });

        await script.Generate('regenerate', { preserveLastMessage: true });
        expect(chatLengthAtAfterCommands).toBe(2);
        expect(lastInContextMesId).toBe('1');
        expect(loaded.mocks['scripts/itemized-prompts.js'].itemizedPrompts.at(-1)?.mesId).toBe(1);

        // Ordinary regeneration pops the last message before generation and shifts the in-context marker.
        script.chat.length = 0;
        script.chat.push(
            { name: 'User', is_user: true, mes: 'Hello' },
            { name: 'Seraphina', is_user: false, mes: 'Original reply', extra: {} },
        );
        document.getElementById('chat').innerHTML = `
            <div class="mes" mesid="0" is_system="false"></div>
            <div class="mes" mesid="1" is_system="false"></div>
        `;
        loaded.mocks['scripts/itemized-prompts.js'].itemizedPrompts.length = 0;
        sendOpenAIRequest.mockImplementationOnce(async () => {
            lastInContextMesId = document.querySelector('#chat .mes.lastInContext')?.getAttribute('mesid') ?? null;
            return { choices: [{ message: { content: 'Fresh reply' } }] };
        });

        await script.Generate('regenerate', { preserveLastMessage: false });
        expect(chatLengthAtAfterCommands).toBe(1);
        expect(lastInContextMesId).toBe('0');
        expect(loaded.mocks['scripts/itemized-prompts.js'].itemizedPrompts.at(-1)?.mesId).toBe(1);
    });

    test('uses retained regeneration and only clears input before generation for group corrections', async () => {
        const solo = await runGuidedCorrection({ groupId: null });
        expect(solo.Generate).toHaveBeenCalledWith('regenerate', { preserveLastMessage: true });
        expect(solo.textareaValueDuringGenerate).toBe('make the reply calmer');
        expect(solo.textarea.value).toBe('make the reply calmer');
        expect(solo.targetMessage.mes).toBe('Corrected reply');

        const group = await runGuidedCorrection({ groupId: 'group-1' });
        expect(group.Generate).toHaveBeenCalledWith('regenerate', { preserveLastMessage: true, force_chid: 1 });
        expect(group.textareaValueDuringGenerate).toBe('');
        expect(group.textarea.value).toBe('make the reply calmer');
        expect(group.targetMessage.mes).toBe('Corrected reply');
    });

    test('carries the companion rewrite target through group generation and strips it for continue turns', async () => {
        const companionTarget = { messageIndex: 2, note: 'tighten tone' };
        let autoContinueCount = 0;
        const harness = await importGroupChatsModule({
            characters: [{ name: 'Alice', avatar: 'alice.png' }],
            chat: [{ name: 'Alice', is_user: false, mes: 'Hello', original_avatar: 'alice.png' }],
            fetch: jest.fn(async () => ({ ok: true, json: async () => [] })),
            script: {
                Generate: jest.fn(async () => ({ messageChunk: 'partial chunk' })),
                shouldAutoContinue: jest.fn(() => {
                    autoContinueCount += 1;
                    return autoContinueCount === 1;
                }),
            },
        });
        harness.groupChats.groups.push({
            id: 'group-1',
            name: 'Tavern',
            members: ['alice.png'],
            disabled_members: [],
            activation_strategy: 0,
            allow_self_responses: true,
            auto_mode_delay: 5,
            chat_id: 'group-chat-1',
        });
        await harness.groupChats.openGroupById('group-1', { switchMenu: false });

        await harness.groupChats.generateGroupWrapper(false, 'regenerate', {
            force_chid: 0,
            preserveLastMessage: true,
            companionHistoryTarget: companionTarget,
        });
        expect(harness.mocks.script.Generate).toHaveBeenCalledTimes(2);
        expect(harness.mocks.script.Generate).toHaveBeenNthCalledWith(
            1,
            'normal',
            expect.objectContaining({
                preserveLastMessage: true,
                companionHistoryTarget: companionTarget,
            }),
        );
        expect(harness.mocks.script.Generate).toHaveBeenNthCalledWith(
            2,
            'continue',
            expect.objectContaining({
                companionHistoryTarget: undefined,
            }),
        );
    });
});
