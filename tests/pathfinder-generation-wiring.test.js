/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import { importScriptModule } from './util/script-harness.js';

const pub = rel => fileURLToPath(new URL(`../public/${rel}`, import.meta.url));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

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

/**
 * Mounts the real `public/script.js` + real `public/scripts/world-info.js` + real
 * `public/scripts/extensions/in-chat-agents/agent-runner.js` pipeline in jsdom so
 * Pathfinder generation wiring runs through the actual host implementation.
 */
async function createHost({
    selectedGroup = null,
    generateGroupWrapper = null,
    toolManager = {},
    worldInfoFetch = null,
    streamOpenAI = false,
} = {}) {
    let chatId = 'chat-a';
    const loreBook = {
        entries: {
            1: {
                uid: 1,
                key: ['town'],
                keysecondary: [],
                content: 'Native town lore.',
                constant: true,
                selective: false,
                disable: false,
                order: 100,
                position: 0,
                probability: 100,
                useProbability: false,
            },
        },
    };

    const prepareOpenAIMessages = jest.fn(async data => [
        [{ role: 'system', content: data.extensionPrompts?.pathfinder_pipeline_retrieval?.value ?? '' }],
        false,
    ]);
    const sendOpenAIRequest = jest.fn(async () => ({
        choices: [{ message: { content: 'reply' } }],
    }));

    const pathfinderAgent = {
        id: 'pf-1',
        name: 'Pathfinder',
        sourceTemplateId: 'tpl-pathfinder',
        category: 'tool',
        enabled: true,
        conditions: {
            generationTypes: ['normal', 'swipe', 'regenerate', 'continue'],
            triggerProbability: 100,
            triggerKeywords: [],
        },
        settings: {
            sidecarEnabled: true,
            pipelineEnabled: true,
            enabledLorebooks: ['Lore'],
            selectedLorebook: 'Lore',
            includeContextualLorebooks: false,
        },
    };

    const retrievalResult = {
        success: true,
        promptKey: 'pathfinder_pipeline_retrieval',
        mode: 'pipeline',
        books: ['Lore'],
        selectedEntries: [
            { bookName: 'Lore', uid: 1, name: 'Town', content: 'Town lore.' },
            { bookName: 'Lore', uid: 2, name: 'Forest', content: 'Forest lore.' },
        ],
    };

    let realInjectPathfinderRetrieval = null;
    const runSidecarRetrieval = jest.fn(async (writePrompt, promptTypes, promptRoles) => {
        realInjectPathfinderRetrieval(retrievalResult, writePrompt, promptTypes, promptRoles);
        return retrievalResult;
    });

    const isHordeGenerationNotAllowed = jest.fn(() => false);
    const executeSlashCommandsOnChatInput = jest.fn(async () => ({ isAborted: false }));

    const fetchMock = jest.fn(async (url, init) => {
        if (url === '/api/worldinfo/get') {
            if (worldInfoFetch) {
                return await worldInfoFetch(url, init, loreBook);
            }
            return { ok: true, json: async () => structuredClone(loreBook) };
        }
        if (url === '/api/chats/group/get') {
            return { ok: true, json: async () => [] };
        }
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    });

    const loaded = await importScriptModule({
        keepReal: [
            'scripts/world-info.js',
            'scripts/utils.js',
            'scripts/group-chats.js',
            'scripts/extensions/in-chat-agents/regex-scripts.js',
            'scripts/extensions/in-chat-agents/regex-snapshot-store.js',
            'scripts/extensions/in-chat-agents/companion/companion-shared.js',
        ],
        fetch: fetchMock,
        dom: `
            <div id="options_button"></div><div id="options"></div>
            <div id="export_button"></div><div id="export_format_popup"></div>
            <div id="online_status_indicator"></div><div id="online_status_text"></div>
            <select id="main_api"><option value="openai">openai</option></select>
            <div id="chat"></div>
            <div id="message_template" hidden><div class="mes"><div class="mes_block"><div class="ch_name"><span class="name_text"></span></div><div class="mes_text"></div></div></div></div>
            <div id="send_form"><textarea id="send_textarea"></textarea><div id="send_but"></div><div id="mes_stop" style="display:none"></div></div>
        `,
        mocks: {
            ...createWorldInfoPeerMocks(),
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
            'scripts/personas.js': base => ({
                ...base,
                getOrCreatePersonaDescriptor: jest.fn(() => ({})),
            }),
            'scripts/horde.js': base => ({
                ...base,
                isHordeGenerationNotAllowed,
            }),
            'scripts/slash-commands.js': base => ({
                ...base,
                executeSlashCommandsOnChatInput,
            }),
            'scripts/openai.js': base => ({
                ...base,
                oai_settings: { ...base.oai_settings, stream_openai: streamOpenAI },
                prepareOpenAIMessages,
                sendOpenAIRequest,
            }),
            'scripts/tool-calling.js': base => ({
                ToolManager: {
                    ...base.ToolManager,
                    registerFunctionTool: jest.fn(),
                    unregisterFunctionTool: jest.fn(),
                    ...toolManager,
                },
            }),
            'scripts/extensions/in-chat-agents/agent-store.js': {
                areAgentsGloballyEnabled: () => true,
                getAgentById: id => (id === pathfinderAgent.id ? pathfinderAgent : null),
                getAgents: () => [pathfinderAgent],
                getAgentRegexScripts: () => [],
                getEnabledAgents: () => [pathfinderAgent],
                getEnabledToolAgents: () => [pathfinderAgent],
                getGlobalSettings: () => ({ enabled: true, pathfinderEnabled: true }),
                getPromptTransformMode: () => 'off',
                isAgentRuntimeAllowed: () => true,
                isCompanionAgent: () => false,
                isTrackerFixAgent: () => false,
                isPathfinderSubmoduleEnabled: () => true,
                saveAgent: jest.fn(async a => a),
                isToolAgent: a => a?.category === 'tool',
                normalizePreProcessMaxTokens: v => v,
                normalizePromptTransformMaxTokens: v => v,
                resolveCompanionConnectionProfile: () => null,
                resolveConnectionProfile: () => null,
            },
            'scripts/extensions/in-chat-agents/profile-utils.js': {
                listConnectionProfiles: () => [],
                getConnectionProfileDisplayName: () => '',
                getConnectionProfileModelName: () => '',
            },
            'scripts/extensions/in-chat-agents/pathfinder/llm-sidecar.js': {
                sidecarGenerate: jest.fn(),
                sidecarGenerateWithProfile: jest.fn(),
            },
            'scripts/extensions/in-chat-agents/pathfinder/summary-memory-store.js': {
                getSummaryMemoryState: () => ({}),
                onSummaryMemoryChanged: () => () => {},
                saveSummaryMemoryContent: jest.fn(),
                isSummaryMemoryEntry: () => false,
                markSummaryMemoryInjected: jest.fn(),
                detachSummaryMemoryBook: jest.fn(),
                renameSummaryMemoryBook: jest.fn(),
                syncSummaryMemoryForBook: jest.fn(),
                setSummaryMemoryCreated: jest.fn(),
            },
        },
    });

    // Import real injectPathfinderRetrieval first, then wrap only runSidecarRetrieval on sidecar-retrieval.js.
    const realSidecar = await import(pub('scripts/extensions/in-chat-agents/pathfinder/sidecar-retrieval.js'));
    realInjectPathfinderRetrieval = realSidecar.injectPathfinderRetrieval;
    await jest.unstable_mockModule(pub('scripts/extensions/in-chat-agents/pathfinder/sidecar-retrieval.js'), () => ({
        ...realSidecar,
        runSidecarRetrieval,
    }));

    const worldInfo = await import(pub('scripts/world-info.js'));
    worldInfo.setWorldInfoSettings(
        { world_info: { globalSelect: ['Lore'] }, world_info_budget: 25, world_info_depth: 4 },
        { world_names: ['Lore'] },
    );

    const { script, eventSource } = loaded;
    script.changeMainAPI('openai');
    script.setOnlineStatus('connected');
    script.characters.push({
        name: 'Assistant',
        avatar: 'assistant.png',
        chat: chatId,
        description: '',
        personality: '',
        scenario: '',
        first_mes: 'Hi',
        data: { extensions: {} },
    });
    script.setCharacterId('0');
    script.chat.push({ name: 'User', is_user: true, mes: 'Enter the town' });

    const groupChats = await import(pub('scripts/group-chats.js'));
    if (selectedGroup) {
        groupChats.groups.push({
            id: selectedGroup,
            name: 'Tavern',
            members: ['assistant.png'],
            disabled_members: [],
            activation_strategy: 0,
            allow_self_responses: true,
            auto_mode_delay: 5,
            chat_id: 'group-chat-1',
        });
        await groupChats.openGroupById(selectedGroup, { switchMenu: false });
    }

    const runner = await import(pub('scripts/extensions/in-chat-agents/agent-runner.js'));
    runner.initAgentRunner();

    const emitted = jest.spyOn(eventSource, 'emit');

    return {
        script,
        worldInfo,
        groupChats,
        runner,
        events: eventSource,
        emitted,
        mocks: {
            prepareOpenAIMessages,
            sendOpenAIRequest,
            isHordeGenerationNotAllowed,
            executeSlashCommandsOnChatInput,
            runSidecarRetrieval,
            fetch: fetchMock,
        },
        setChatId(next) {
            chatId = next;
            script.characters[0].chat = next;
        },
        generate(type = 'normal', options = {}, dryRun = false) {
            return script.Generate(type, { suppressUserMessage: true, ...options }, dryRun);
        },
    };
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe('Pathfinder integration with the real host generation flow', () => {
    test('tags the actual native scan and removes only its activated entries before prompt assembly', async () => {
        const host = await createHost();
        await host.generate();

        const native = host.emitted.mock.calls.find(([event]) => event === host.script.event_types.WORLD_INFO_ACTIVATED);
        expect(native).toBeDefined();
        expect(native[2]).toEqual({ chatId: 'chat-a', runId: 1, cancelRevision: 0 });
        expect(host.emitted.mock.calls.filter(([event]) => event === host.script.event_types.GENERATION_HIDE_MESSAGES)).toHaveLength(1);
        expect(host.mocks.prepareOpenAIMessages.mock.calls[0][0].worldInfoBefore).toContain('Native town lore.');
        const prompt = host.mocks.sendOpenAIRequest.mock.calls[0][1][0].content;
        expect(prompt).not.toContain('Town lore.');
        expect(prompt).toContain('Forest lore.');
        expect(host.emitted.mock.calls.filter(([event]) => event === host.script.event_types.GENERATION_ENDED)).toHaveLength(1);
    });

    test.each([
        ['commands', host => {
            document.getElementById('send_textarea').value = '/abort';
            host.mocks.executeSlashCommandsOnChatInput.mockResolvedValue({ isAborted: true });
        }],
        ['blocked provider', host => host.mocks.isHordeGenerationNotAllowed.mockReturnValue(true)],
        ['no connection', host => { host.script.setOnlineStatus('no_connection'); }],
    ])('emits one terminal event for %s, including before the Stop button becomes visible', async (_name, setup) => {
        const host = await createHost();
        setup(host);
        await host.generate('normal', { suppressUserMessage: false });
        expect(host.emitted.mock.calls.filter(([event]) => event === host.script.event_types.GENERATION_ENDED)).toHaveLength(1);
        expect(host.script.is_send_press).toBe(false);
        expect(host.mocks.sendOpenAIRequest).not.toHaveBeenCalled();
    });

    test('cleans up a prompt preparation exception that occurs before the API error handler', async () => {
        const host = await createHost();
        host.mocks.prepareOpenAIMessages.mockRejectedValueOnce(new Error('scan failed'));
        await expect(host.generate()).rejects.toThrow('scan failed');
        expect(host.emitted.mock.calls.filter(([event]) => event === host.script.event_types.GENERATION_ENDED)).toHaveLength(1);
        expect(document.getElementById('mes_stop').style.display).toBe('none');
    });

    test('creates the abort controller before start listeners and honours Stop while the busy UI is still unset', async () => {
        const host = await createHost();
        const started = deferred();
        const release = deferred();
        host.events.on(host.script.event_types.GENERATION_STARTED, async () => {
            started.resolve();
            await release.promise;
        });
        const pending = host.generate('normal', { suppressUserMessage: false });
        await started.promise;
        expect(host.script.is_send_press).toBe(false);
        expect(host.script.stopGeneration()).toBe(true);
        release.resolve();
        await pending;
        expect(host.mocks.executeSlashCommandsOnChatInput).not.toHaveBeenCalled();
        expect(host.emitted.mock.calls.filter(([event]) => event === host.script.event_types.GENERATION_ENDED)).toHaveLength(0);
    });

    test('uses the current cancellation revision when explicit Stop follows agent cancellation', async () => {
        const host = await createHost();
        const started = deferred();
        const release = deferred();
        const stopped = jest.fn();
        host.events.on(host.script.event_types.GENERATION_STOPPED, stopped);
        host.events.on(host.script.event_types.GENERATION_AFTER_COMMANDS, async () => {
            started.resolve();
            await release.promise;
        });
        const pending = host.generate();
        await started.promise;
        host.runner.cancelAgentGeneration();
        host.script.stopGeneration();
        expect(stopped).toHaveBeenCalledWith({ chatId: 'chat-a', runId: 1, cancelRevision: 1 });
        release.resolve();
        await pending;
    });

    test.each(['Stop', 'chat change', 'new generation'])('does not continue past pending retrieval after %s', async reason => {
        const host = await createHost();
        const started = deferred();
        const release = deferred();
        let pauseFirst = true;
        host.events.on(host.script.event_types.GENERATION_AFTER_COMMANDS, async () => {
            if (!pauseFirst) return;
            pauseFirst = false;
            started.resolve();
            await release.promise;
        });
        const pending = host.generate();
        await started.promise;
        let replacementPending = null;
        if (reason === 'Stop') {
            host.script.stopGeneration();
        } else if (reason === 'chat change') {
            host.setChatId('chat-b');
            host.script.incrementChatGeneration();
            await host.events.emit(host.script.event_types.CHAT_CHANGED);
        } else {
            // Pause the replacement run in sendOpenAIRequest so we can assert the first run never sends.
            const nextReq = deferred();
            host.mocks.sendOpenAIRequest.mockImplementationOnce(() => nextReq.promise);
            replacementPending = host.generate();
            await Promise.resolve();
            nextReq.resolve({ choices: [{ message: { content: 'second' } }] });
        }
        host.script.setExtensionPrompt('sentinel', 'new chat', 0, 0);
        release.resolve();
        await pending;
        if (replacementPending) await replacementPending;
        expect(host.script.extension_prompts.sentinel?.value).toBe('new chat');
        expect(host.mocks.sendOpenAIRequest).toHaveBeenCalledTimes(reason === 'new generation' ? 1 : 0);
    });

    test('rejects a late native activation from a replaced run and leaves the new prompt untouched', async () => {
        const started = deferred();
        const release = deferred();
        let wiCallCount = 0;
        const host = await createHost({
            worldInfoFetch: async (_url, _init, loreBook) => {
                wiCallCount++;
                if (wiCallCount === 1) {
                    started.resolve();
                    await release.promise;
                }
                return { ok: true, json: async () => structuredClone(loreBook) };
            },
        });
        const first = host.generate();
        await started.promise;

        // Replace the active generation run while the first native WI fetch is suspended.
        const secondReq = deferred();
        host.mocks.sendOpenAIRequest.mockImplementationOnce(() => secondReq.promise);
        const second = host.generate();
        await Promise.resolve();
        host.script.setExtensionPrompt('sentinel', 'new run', 0, 0);

        release.resolve();
        await first;
        expect(host.script.extension_prompts.sentinel?.value).toBe('new run');

        secondReq.resolve({ choices: [{ message: { content: 'second reply' } }] });
        await second;
        expect(host.mocks.sendOpenAIRequest).toHaveBeenCalledTimes(1);
    });

    test('awaits a group child without its outer wrapper ending or cancelling that child', async () => {
        const childStarted = deferred();
        const releaseChild = deferred();
        const host = await createHost({ selectedGroup: 'group-1' });
        host.mocks.sendOpenAIRequest.mockImplementationOnce(async () => {
            childStarted.resolve();
            await releaseChild.promise;
            return { choices: [{ message: { content: 'group reply' } }] };
        });

        const pending = host.generate();
        await childStarted.promise;
        expect(host.emitted.mock.calls.filter(([event]) => event === host.script.event_types.GENERATION_ENDED)).toHaveLength(0);
        expect(host.groupChats.is_group_generating).toBe(true);
        releaseChild.resolve();
        await pending;
        expect(host.script.chat.at(-1)?.mes).toBe('group reply');
        expect(host.emitted.mock.calls.filter(([event]) => event === host.script.event_types.GENERATION_ENDED)).toHaveLength(1);
    });

    test('does not tag a dry preview or let it end the active generation', async () => {
        const host = await createHost();
        const inFlight = deferred();
        const started = deferred();
        host.mocks.sendOpenAIRequest.mockImplementationOnce(() => {
            started.resolve();
            return inFlight.promise;
        });
        const main = host.generate();
        await started.promise;
        expect(host.script.is_send_press).toBe(true);
        const beforeEvents = host.emitted.mock.calls.length;

        await host.generate('normal', {}, true);

        expect(host.script.is_send_press).toBe(true);
        const dryEvents = host.emitted.mock.calls.slice(beforeEvents).map(([event]) => event);
        expect(dryEvents).not.toContain(host.script.event_types.WORLD_INFO_ACTIVATED);
        expect(dryEvents).not.toContain(host.script.event_types.GENERATION_HIDE_MESSAGES);
        expect(dryEvents).not.toContain(host.script.event_types.GENERATION_ENDED);
        expect(host.mocks.sendOpenAIRequest).toHaveBeenCalledTimes(1);

        inFlight.resolve({ choices: [{ message: { content: 'main reply' } }] });
        await main;
    });

    test('keeps nested quiet scans untagged and preserves the main controller and terminal lifecycle', async () => {
        const host = await createHost();
        const started = deferred();
        const release = deferred();
        host.events.on(host.script.event_types.GENERATION_AFTER_COMMANDS, async type => {
            if (type !== 'quiet') {
                started.resolve();
                await release.promise;
            }
        });
        const pending = host.generate();
        await started.promise;

        await host.script.generateQuietPrompt({ quietPrompt: 'helper', skipWIAN: true });
        const nativeEvents = host.emitted.mock.calls.filter(([event]) => event === host.script.event_types.WORLD_INFO_ACTIVATED);
        expect(nativeEvents.length).toBeGreaterThanOrEqual(1);
        expect(nativeEvents[0]).toHaveLength(2);
        expect(host.emitted.mock.calls.filter(([event]) => event === host.script.event_types.GENERATION_ENDED)).toHaveLength(0);

        release.resolve();
        await pending;
        expect(host.emitted.mock.calls.filter(([event]) => event === host.script.event_types.GENERATION_ENDED)).toHaveLength(1);
    });

    test.each([
        ['failure', request => request.mockRejectedValueOnce(new Error('quiet failed'))],
        ['empty response', request => request.mockResolvedValueOnce(null)],
    ])('does not stop the main generation on a nested quiet %s', async (_name, setup) => {
        const host = await createHost();
        const started = deferred();
        const release = deferred();
        host.events.on(host.script.event_types.GENERATION_AFTER_COMMANDS, async type => {
            if (type !== 'quiet') {
                started.resolve();
                await release.promise;
            }
        });
        const main = host.generate();
        await started.promise;
        setup(host.mocks.sendOpenAIRequest);
        await host.script.generateQuietPrompt({ quietPrompt: 'helper' }).catch(() => undefined);
        expect(host.script.is_send_press).toBe(false);
        expect(host.emitted.mock.calls.filter(([event]) => event === host.script.event_types.GENERATION_ENDED || event === host.script.event_types.GENERATION_STOPPED)).toHaveLength(0);
        release.resolve();
        await main;
    });

    test('does not let a late quiet failure stop a newer main request', async () => {
        const host = await createHost();
        const oldStarted = deferred();
        const oldRelease = deferred();
        let pauseOld = true;
        host.events.on(host.script.event_types.GENERATION_AFTER_COMMANDS, async type => {
            if (type !== 'quiet' && pauseOld) {
                pauseOld = false;
                oldStarted.resolve();
                await oldRelease.promise;
            }
        });
        const old = host.generate();
        await oldStarted.promise;

        const quietStarted = deferred();
        const quietResponse = deferred();
        const nextStarted = deferred();
        const nextResponse = deferred();
        host.mocks.sendOpenAIRequest
            .mockImplementationOnce(() => { quietStarted.resolve(); return quietResponse.promise; })
            .mockImplementationOnce(() => { nextStarted.resolve(); return nextResponse.promise; });

        const quiet = host.script.generateQuietPrompt({ quietPrompt: 'helper' }).catch(error => error);
        await quietStarted.promise;

        const next = host.generate();
        await nextStarted.promise;

        quietResponse.reject(new Error('quiet failed'));
        await expect(quiet).resolves.toMatchObject({ message: 'quiet failed' });
        oldRelease.resolve();
        await old;

        expect(host.script.is_send_press).toBe(true);
        expect(host.emitted.mock.calls.filter(([event]) => event === host.script.event_types.GENERATION_ENDED || event === host.script.event_types.GENERATION_STOPPED)).toHaveLength(0);

        nextResponse.resolve({ choices: [{ message: { content: 'new reply' } }] });
        await next;
    });

    test('preserves a recursive tool pass result without duplicate terminal events', async () => {
        const invokeFunctionTools = jest.fn(async data => ({
            invocations: data?.tool ? [{}] : [],
            stealthCalls: [],
        }));
        const host = await createHost({
            toolManager: {
                isToolCallingSupported: () => true,
                canPerformToolCalls: () => true,
                hasToolCalls: data => Boolean(data?.tool),
                invokeFunctionTools,
                saveFunctionToolInvocations: jest.fn(async () => {}),
            },
        });
        host.mocks.sendOpenAIRequest
            .mockResolvedValueOnce({ choices: [{ message: { content: 'tool plan' } }], tool: true })
            .mockResolvedValueOnce({ choices: [{ message: { content: 'final reply' } }] });

        const result = await host.generate();
        expect(String(result)).toBe('final reply');
        expect(host.mocks.sendOpenAIRequest).toHaveBeenCalledTimes(2);
        expect(invokeFunctionTools.mock.calls[0][1]).toEqual(expect.objectContaining({
            isCurrent: expect.any(Function),
            signal: expect.any(AbortSignal),
        }));
        expect(invokeFunctionTools.mock.calls[0][1].isCurrent()).toBe(false);
        expect(host.mocks.sendOpenAIRequest.mock.calls[1][2]).toBe(host.mocks.sendOpenAIRequest.mock.calls[0][2]);
        expect(host.emitted.mock.calls.filter(([event]) => event === host.script.event_types.GENERATION_ENDED)).toHaveLength(1);
    });

    test('preserves a recursive streaming tool result while the successor owns completion', async () => {
        const invokeFunctionTools = jest.fn(async () => ({ invocations: [{}], stealthCalls: [] }));
        const host = await createHost({
            streamOpenAI: true,
            toolManager: {
                isToolCallingSupported: () => true,
                canPerformToolCalls: () => true,
                hasToolCalls: data => Array.isArray(data) && data.length > 0,
                invokeFunctionTools,
                saveFunctionToolInvocations: jest.fn(async () => {}),
            },
        });
        host.mocks.sendOpenAIRequest
            .mockResolvedValueOnce(async function* () {
                yield { text: 'tool plan', swipes: [], toolCalls: [{ id: 'tc1' }], state: {} };
            })
            .mockResolvedValueOnce(async function* () {
                yield { text: 'final stream', swipes: [], toolCalls: [], state: {} };
            });

        const result = await host.generate();
        expect(String(result)).toBe('final stream');
        expect(result.fromStream).toBe(true);
        expect(host.mocks.sendOpenAIRequest).toHaveBeenCalledTimes(2);
        expect(invokeFunctionTools.mock.calls[0][1]).toEqual(expect.objectContaining({
            isCurrent: expect.any(Function),
            signal: expect.any(AbortSignal),
        }));
        expect(invokeFunctionTools.mock.calls[0][1].isCurrent()).toBe(false);
        expect(host.emitted.mock.calls.filter(([event]) => event === host.script.event_types.GENERATION_ENDED)).toHaveLength(1);
    });
});
