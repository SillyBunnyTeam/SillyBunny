/** @jest-environment jsdom */
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { importScriptModule } from './util/script-harness.js';

const pub = rel => fileURLToPath(new URL(`../public/${rel}`, import.meta.url));

function createWorldInfoPeerMocks() {
    return {
        'scripts/sillybunny-editor/banner.js': {
            createBanner: jest.fn(() => ({
                element: document.createElement('div'),
                setTitle: jest.fn(),
                show: jest.fn(),
                hide: jest.fn(),
            })),
        },
        'scripts/sillybunny-world-info-editor.js': {
            initWorldInfoEditor: jest.fn(),
            openWorldInfoEntryEditor: jest.fn(),
            closeWorldInfoEntryEditor: jest.fn(),
            refreshWorldInfoEditorList: jest.fn(),
            isWorldInfoEditorOpen: jest.fn(() => false),
            syncWorldInfoEntryEditorSelection: jest.fn(),
        },
        'scripts/slash-commands/SlashCommandParser.js': {
            SlashCommandParser: {
                addCommandObject: jest.fn(),
                addCommand: jest.fn(),
                commands: {},
            },
        },
        'scripts/slash-commands/SlashCommand.js': { SlashCommand: { fromProps: p => p } },
        'scripts/slash-commands/SlashCommandArgument.js': {
            ARGUMENT_TYPE: { STRING: 'string', BOOLEAN: 'boolean', NUMBER: 'number', LIST: 'list', DICTIONARY: 'dictionary', CLOSURE: 'closure', SUBCOMMAND: 'subcommand', RANGE: 'range' },
            SlashCommandArgument: class { static fromProps(p) { return p; } },
            SlashCommandNamedArgument: class { static fromProps(p) { return p; } },
        },
        'scripts/slash-commands/SlashCommandEnumValue.js': {
            SlashCommandEnumValue: class {},
            enumTypes: { enum: 'enum', name: 'name', command: 'command' },
        },
        'scripts/slash-commands/SlashCommandCommonEnumsProvider.js': {
            commonEnumProviders: new Proxy({}, { get: () => () => () => [] }),
            enumIcons: new Proxy({}, { get: (_t, prop) => (prop === 'getDataTypeIcon' ? () => '' : '') }),
        },
        'scripts/slash-commands/SlashCommandClosure.js': { SlashCommandClosure: class {} },
        'scripts/sillybunny-version-map.js': { mapSillyBunnyVersionToStEquivalent: value => value },
        'scripts/sillybunny-editor/adapters/utility-dialogs.js': { iconPickerOptions: () => ({}) },
    };
}

describe('Pathfinder lifecycle integration', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
    });

    test('keeps native activation before both prompt builders consume retrieval injections', async () => {
        const loreBook = {
            entries: {
                0: {
                    uid: 0,
                    key: ['castle'],
                    keysecondary: [],
                    content: 'Ancient castle lore.',
                    constant: false,
                    selective: false,
                    disable: false,
                    order: 100,
                    position: 0,
                    probability: 100,
                    useProbability: false,
                },
            },
        };

        // 1. Chat-completion flow: real world-info.js loads book & emits WORLD_INFO_ACTIVATED before prepareOpenAIMessages.
        const chatOrder = [];
        const loadedChat = await importScriptModule({
            keepReal: ['scripts/world-info.js', 'scripts/utils.js'],
            fetch: jest.fn(async url => {
                if (url === '/api/worldinfo/get') {
                    chatOrder.push('loadWorldInfo');
                    return { ok: true, json: async () => structuredClone(loreBook) };
                }
                return { ok: true, json: async () => ({}), text: async () => '' };
            }),
            mocks: {
                ...createWorldInfoPeerMocks(),
                'scripts/personas.js': base => ({
                    ...base,
                    getOrCreatePersonaDescriptor: jest.fn(() => ({})),
                }),
                'scripts/openai.js': base => ({
                    ...base,
                    prepareOpenAIMessages: jest.fn(async () => {
                        chatOrder.push('prepareOpenAIMessages');
                        return [[{ role: 'user', content: 'Hi' }], false];
                    }),
                }),
            },
        });
        const worldInfoChat = await import(pub('scripts/world-info.js'));
        worldInfoChat.setWorldInfoSettings(
            { world_info: { globalSelect: ['Lore'] }, world_info_budget: 25, world_info_depth: 4 },
            { world_names: ['Lore'] },
        );
        loadedChat.eventSource.on(loadedChat.script.event_types.WORLD_INFO_ACTIVATED, entries => {
            chatOrder.push(`WORLD_INFO_ACTIVATED:${entries.length}`);
        });
        loadedChat.script.changeMainAPI('openai');
        loadedChat.script.setOnlineStatus('connected');
        loadedChat.script.characters.push({ name: 'Alice', avatar: 'alice.png', description: '', personality: '', scenario: '', first_mes: 'Hi' });
        loadedChat.script.setCharacterId('0');
        loadedChat.script.chat.push({ name: 'User', is_user: true, mes: 'Visit the castle' });

        await loadedChat.script.Generate('normal', { suppressUserMessage: true }, false);
        expect(chatOrder).toEqual(['loadWorldInfo', 'WORLD_INFO_ACTIVATED:1', 'prepareOpenAIMessages']);

        // 2. Text-completion flow: real world-info.js emits WORLD_INFO_ACTIVATED before renderStoryString consumes extension prompts.
        const textOrder = [];
        const loadedText = await importScriptModule({
            keepReal: ['scripts/world-info.js', 'scripts/utils.js'],
            fetch: jest.fn(async url => {
                if (url === '/api/worldinfo/get') {
                    textOrder.push('loadWorldInfo');
                    return { ok: true, json: async () => structuredClone(loreBook) };
                }
                return { ok: true, json: async () => ({}), text: async () => '' };
            }),
            mocks: {
                ...createWorldInfoPeerMocks(),
                'scripts/personas.js': base => ({
                    ...base,
                    getOrCreatePersonaDescriptor: jest.fn(() => ({})),
                }),
                'scripts/power-user.js': base => ({
                    ...base,
                    renderStoryString: jest.fn(() => {
                        textOrder.push('renderStoryString');
                        return '';
                    }),
                }),
            },
        });
        const worldInfoText = await import(pub('scripts/world-info.js'));
        worldInfoText.setWorldInfoSettings(
            { world_info: { globalSelect: ['Lore'] }, world_info_budget: 25, world_info_depth: 4 },
            { world_names: ['Lore'] },
        );
        loadedText.eventSource.on(loadedText.script.event_types.WORLD_INFO_ACTIVATED, entries => {
            textOrder.push(`WORLD_INFO_ACTIVATED:${entries.length}`);
        });
        loadedText.script.changeMainAPI('textgenerationwebui');
        loadedText.script.setOnlineStatus('connected');
        loadedText.script.characters.push({ name: 'Alice', avatar: 'alice.png', description: '', personality: '', scenario: '', first_mes: 'Hi' });
        loadedText.script.setCharacterId('0');
        loadedText.script.chat.push({ name: 'User', is_user: true, mes: 'Visit the castle' });

        await loadedText.script.Generate('normal', { suppressUserMessage: true }, false);
        expect(textOrder).toEqual(['loadWorldInfo', 'WORLD_INFO_ACTIVATED:1', 'renderStoryString']);
    });

    test('keeps the dispatch wrapper after the pre-generation hook, before member generation', async () => {
        const order = [];
        const generateGroupWrapper = jest.fn(async () => {
            order.push('generateGroupWrapper');
        });
        const loaded = await importScriptModule({
            keepReal: ['scripts/world-info.js', 'scripts/utils.js'],
            mocks: {
                ...createWorldInfoPeerMocks(),
                'scripts/personas.js': base => ({
                    ...base,
                    getOrCreatePersonaDescriptor: jest.fn(() => ({})),
                }),
                'scripts/group-chats.js': base => ({
                    ...base,
                    selected_group: 'group-1',
                    is_group_generating: false,
                    generateGroupWrapper,
                }),
            },
        });
        loaded.script.changeMainAPI('openai');
        loaded.script.setOnlineStatus('connected');
        loaded.eventSource.on(loaded.script.event_types.GENERATION_AFTER_COMMANDS, () => {
            order.push('GENERATION_AFTER_COMMANDS');
        });

        await loaded.script.Generate('normal', { suppressUserMessage: true });
        expect(order).toEqual(['GENERATION_AFTER_COMMANDS', 'generateGroupWrapper']);
        expect(generateGroupWrapper).toHaveBeenCalledTimes(1);
    });

    test('does not duplicate auto-summary listeners across init, teardown and re-enable', async () => {
        jest.resetModules();
        await jest.unstable_mockModule(pub('scripts/extensions/in-chat-agents/profile-utils.js'), () => ({ listConnectionProfiles: () => [] }));
        await jest.unstable_mockModule(pub('scripts/extensions/in-chat-agents/pathfinder/pathfinder-tool-bridge.js'), () => ({ getWritableBooks: () => ['Book A'] }));
        const { replaceSettings } = await import(pub('scripts/extensions/in-chat-agents/pathfinder/tree-store.js'));
        const { initAutoSummary, deinitAutoSummary, getAutoSummaryCount, resetAutoSummaryCount, shouldAutoSummarize } = await import(pub('scripts/extensions/in-chat-agents/pathfinder/auto-summary.js'));

        deinitAutoSummary();
        replaceSettings({ autoSummary: true, autoSummaryInterval: 2 });

        const events = new EventEmitter();
        const types = { MESSAGE_RECEIVED: 'received', MESSAGE_SENT: 'sent' };
        initAutoSummary(events, types);
        initAutoSummary(events, types);
        events.emit(types.MESSAGE_SENT);
        expect(getAutoSummaryCount()).toBe(1);
        events.emit(types.MESSAGE_RECEIVED);
        expect(shouldAutoSummarize()).toBe(true);
        resetAutoSummaryCount();
        expect(shouldAutoSummarize()).toBe(false);
        deinitAutoSummary();
        events.emit(types.MESSAGE_RECEIVED);
        expect(getAutoSummaryCount()).toBe(0);
        initAutoSummary(events, types);
        events.emit(types.MESSAGE_RECEIVED);
        expect(getAutoSummaryCount()).toBe(1);
        deinitAutoSummary();
        expect(events.listenerCount(types.MESSAGE_RECEIVED)).toBe(0);
        expect(events.listenerCount(types.MESSAGE_SENT)).toBe(0);
    });
});
