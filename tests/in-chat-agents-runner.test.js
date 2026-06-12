/* eslint-disable playwright/no-duplicate-hooks */
/* global document, globalThis */
import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

function createEventSource() {
    const handlers = new Map();

    return {
        on: jest.fn((event, handler) => {
            const eventHandlers = handlers.get(event) ?? [];
            eventHandlers.push(handler);
            handlers.set(event, eventHandlers);
        }),
        emit: jest.fn(async (event, ...args) => {
            const eventHandlers = [...(handlers.get(event) ?? [])];
            for (const handler of eventHandlers) {
                await handler(...args);
            }
        }),
        removeListener: jest.fn((event, handler) => {
            const eventHandlers = handlers.get(event) ?? [];
            handlers.set(event, eventHandlers.filter(item => item !== handler));
        }),
    };
}

describe('in-chat agent post-processing runner', () => {
    let chat;
    let chatMetadata;
    let extensionPrompts;
    let enabledAgents;
    let eventSource;
    let eventTypes;
    let saveChatDebounced;
    let saveChat;
    let reloadCurrentChat;
    let updateMessageBlock;
    let generateQuietPrompt;
    let generateRaw;
    let runSidecarRetrieval;
    let streamingProcessor;
    let updateMessageTokenAccounting;
    let updateMessageMetaBadges;
    let connectionManagerRequestService;
    let globalSettings;
    let extensionSettings;
    let executeSlashCommandsWithOptions;
    let currentChatId;
    let mainApi;
    let documentListeners;
    let windowListeners;

    beforeEach(async () => {
        jest.resetModules();
        jest.useRealTimers();

        chat = [];
        chatMetadata = {};
        extensionPrompts = {};
        enabledAgents = [];
        eventSource = createEventSource();
        eventTypes = {
            GENERATION_STARTED: 'generation_started',
            GENERATION_AFTER_COMMANDS: 'generation_after_commands',
            GENERATION_ENDED: 'generation_ended',
            GENERATION_STOPPED: 'generation_stopped',
            STREAM_TOKEN_RECEIVED: 'stream_token_received',
            MESSAGE_RECEIVED: 'message_received',
            MESSAGE_EDITED: 'message_edited',
            CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
            IMPERSONATE_READY: 'impersonate_ready',
            MESSAGE_SWIPED: 'message_swiped',
            GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',
            GENERATION_OUTPUT_BUFFERING_DECISION: 'generation_output_buffering_decision',
            MAIN_GENERATION_OUTPUT_READY: 'main_generation_output_ready',
            CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
            CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
            WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded',
            CHAT_CHANGED: 'chat_changed',
            WORLDINFO_UPDATED: 'worldinfo_updated',
            MESSAGE_UPDATED: 'message_updated',
        };
        saveChatDebounced = jest.fn();
        saveChat = jest.fn();
        reloadCurrentChat = jest.fn();
        updateMessageBlock = jest.fn();
        generateQuietPrompt = jest.fn(async () => 'quiet result');
        generateRaw = jest.fn(async () => 'raw result');
        runSidecarRetrieval = jest.fn();
        streamingProcessor = {
            messageId: -1,
            type: 'normal',
            isFinished: true,
            isStopped: false,
            abortController: { signal: { aborted: false } },
        };
        updateMessageTokenAccounting = jest.fn(async (message) => {
            const tokenCount = String(message?.mes ?? '').split(/\s+/).filter(Boolean).length;
            message.extra ??= {};
            message.extra.token_count = tokenCount;

            if (typeof message?.swipe_id === 'number' && Array.isArray(message?.swipe_info)) {
                const swipeInfo = message.swipe_info[message.swipe_id];
                if (swipeInfo && typeof swipeInfo === 'object') {
                    swipeInfo.extra ??= {};
                    swipeInfo.extra.token_count = tokenCount;
                }
            }

            return { outputTokens: tokenCount, reasoningTokens: 0 };
        });
        updateMessageMetaBadges = jest.fn();
        connectionManagerRequestService = null;
        globalSettings = {
            enabled: true,
            promptTransformShowNotifications: false,
            appendAgentsExecutionMode: 'parallel',
        };
        extensionSettings = {
            'guided-generations': {
                promptImpersonate1st: 'Write in first person: {{input}}',
                profileImpersonate1st: '',
                presetImpersonate1st: '',
            },
        };
        executeSlashCommandsWithOptions = jest.fn();
        currentChatId = 'chat-a';
        mainApi = 'kobold';
        documentListeners = new Map();
        windowListeners = new Map();

        const addListener = (listeners, event, handler) => {
            const eventListeners = listeners.get(event) ?? [];
            eventListeners.push(handler);
            listeners.set(event, eventListeners);
        };

        const removeListener = (listeners, event, handler) => {
            const eventListeners = listeners.get(event) ?? [];
            listeners.set(event, eventListeners.filter(item => item !== handler));
        };

        globalThis.document = {
            body: { dataset: {} },
            querySelector: jest.fn(() => null),
            getElementById: jest.fn(() => null),
            addEventListener: jest.fn((event, handler) => addListener(documentListeners, event, handler)),
            removeEventListener: jest.fn((event, handler) => removeListener(documentListeners, event, handler)),
        };
        globalThis.addEventListener = jest.fn((event, handler) => addListener(windowListeners, event, handler));
        globalThis.removeEventListener = jest.fn((event, handler) => removeListener(windowListeners, event, handler));
        globalThis.HTMLSelectElement = class HTMLSelectElement {};
        globalThis.HTMLTextAreaElement = class HTMLTextAreaElement {};
        globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
        globalThis.toastr = {
            clear: jest.fn(),
            error: jest.fn(),
            info: jest.fn(() => ({ toast: true })),
            success: jest.fn(),
            warning: jest.fn(),
        };
        const createJqueryMock = () => ({
            each: jest.fn(),
            filter: jest.fn(() => createJqueryMock()),
            find: jest.fn(() => createJqueryMock()),
            first: jest.fn(() => createJqueryMock()),
            length: 0,
            text: jest.fn(() => ''),
            trigger: jest.fn(),
            trim: jest.fn(() => ''),
        });
        globalThis.$ = jest.fn(() => createJqueryMock());

        await jest.unstable_mockModule('../public/script.js', () => ({
            chat,
            chat_metadata: chatMetadata,
            ensureSwipes: jest.fn((message) => {
                message.swipes ??= [message.mes];
                message.swipe_id ??= 0;
                message.swipe_info ??= message.swipes.map(() => ({
                    send_date: message.send_date,
                    gen_started: message.gen_started,
                    gen_finished: message.gen_finished,
                    extra: {},
                }));
            }),
            extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
            extension_prompt_types: { IN_PROMPT: 0, IN_CHAT: 1 },
            extension_prompts: extensionPrompts,
            eventSource,
            event_types: eventTypes,
            setExtensionPrompt: jest.fn((key, value) => {
                extensionPrompts[key] = { value };
            }),
            substituteParams: jest.fn(value => String(value ?? '')),
            generateQuietPrompt,
            getCurrentChatId: jest.fn(() => currentChatId),
            normalizeContentText: jest.fn(value => String(value ?? '')),
            main_api: mainApi,
            saveChatDebounced,
            stopGeneration: jest.fn(() => false),
            streamingProcessor,
            syncMesToSwipe: jest.fn((messageIndex = null) => {
                const targetMessage = chat[messageIndex ?? chat.length - 1];
                if (!targetMessage?.swipe_info?.[targetMessage.swipe_id]) {
                    return false;
                }

                targetMessage.swipes[targetMessage.swipe_id] = targetMessage.mes;
                targetMessage.swipe_info[targetMessage.swipe_id].send_date = targetMessage.send_date;
                targetMessage.swipe_info[targetMessage.swipe_id].gen_started = targetMessage.gen_started;
                targetMessage.swipe_info[targetMessage.swipe_id].gen_finished = targetMessage.gen_finished;
                targetMessage.swipe_info[targetMessage.swipe_id].extra = structuredClone(targetMessage.extra);
                return true;
            }),
            updateMessageTokenAccounting,
        }));

        await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
            extension_settings: extensionSettings,
            getContext: jest.fn(() => ({
                saveChat,
                reloadCurrentChat,
                updateMessageBlock,
                updateMessageMetaBadges,
                ConnectionManagerRequestService: connectionManagerRequestService,
                executeSlashCommandsWithOptions,
                generateRaw,
                mainApi,
            })),
        }));

        await jest.unstable_mockModule('../public/scripts/preset-manager.js', () => ({
            getPresetManager: jest.fn(() => ({
                findPreset: jest.fn(() => null),
                getAllPresets: jest.fn(() => []),
                getSelectedPresetName: jest.fn(() => ''),
                selectPreset: jest.fn(),
            })),
        }));

        await jest.unstable_mockModule('../public/scripts/events.js', () => ({
            eventSource,
            event_types: eventTypes,
        }));

        await jest.unstable_mockModule('../public/scripts/reasoning.js', () => ({
            removeReasoningFromString: jest.fn(value => String(value ?? '')),
        }));

        await jest.unstable_mockModule('../public/scripts/world-info.js', () => ({
            getWorldInfoPrompt: jest.fn(async () => ({ worldInfoString: '' })),
        }));

        await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
            power_user: { sysprompt: { enabled: true, content: 'Global system prompt text.' } },
        }));

        await jest.unstable_mockModule('../public/scripts/tool-calling.js', () => ({
            ToolManager: {
                RECURSE_LIMIT: 5,
                canPerformToolCalls: jest.fn(() => false),
                hasToolCalls: jest.fn(() => false),
                isToolCallingSupported: jest.fn(() => false),
                registerFunctionTool: jest.fn(),
                unregisterFunctionTool: jest.fn(),
            },
        }));

        await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
            regexFromString: jest.fn(value => {
                const match = String(value ?? '').match(/^\/([\s\S]*)\/([a-z]*)$/i);
                return match ? new RegExp(match[1], match[2]) : new RegExp(String(value ?? ''));
            }),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({
            DEFAULT_AGENT_MAX_TOKENS: 8192,
            areAgentsGloballyEnabled: jest.fn(() => true),
            getAgentById: jest.fn(id => enabledAgents.find(agent => agent.id === id)),
            getCompanionConfig: jest.fn(agent => ({
                trigger: agent?.companion?.trigger === 'manual' ? 'manual' : 'auto',
                displayMode: ['panel', 'hidden'].includes(agent?.companion?.displayMode) ? agent.companion.displayMode : 'card',
                format: ['markdown', 'html', 'text'].includes(agent?.companion?.format) ? agent.companion.format : 'markdown',
                rawPrompt: Boolean(agent?.companion?.rawPrompt),
                contextMessages: Number(agent?.companion?.contextMessages) || 10,
                includeCharacterCard: Boolean(agent?.companion?.includeCharacterCard),
                includePersona: Boolean(agent?.companion?.includePersona),
                includeWorldInfo: Boolean(agent?.companion?.includeWorldInfo),
                includeAuthorsNote: Boolean(agent?.companion?.includeAuthorsNote),
                includeSystemPrompt: Boolean(agent?.companion?.includeSystemPrompt),
                includeHistory: Boolean(agent?.companion?.includeHistory),
                historyDepth: Number(agent?.companion?.historyDepth) || 3,
                feedback: {
                    enabled: Boolean(agent?.companion?.feedback?.enabled),
                    depth: Number(agent?.companion?.feedback?.depth) || 1,
                },
                batch: Boolean(agent?.companion?.batch),
                maxTokens: Number(agent?.companion?.maxTokens) || 2048,
            })),
            getAgentRegexScripts: jest.fn(agent => Array.isArray(agent?.regexScripts) ? agent.regexScripts : []),
            getEnabledAgents: jest.fn(() => [...enabledAgents]),
            getEnabledToolAgents: jest.fn(() => []),
            getGlobalSettings: jest.fn(() => globalSettings),
            getPromptTransformMode: jest.fn(agent => agent?.postProcess?.promptTransformMode === 'append' ? 'append' : 'rewrite'),
            isTrackerFixAgent: jest.fn(agent => {
                if (agent?.category !== 'tracker') return false;
                if (agent.phase === 'post' || agent.phase === 'both') return true;
                return agent.phase === 'pre' && (
                    (agent.postProcess?.enabled && agent.postProcess.type === 'extract') ||
                    (Array.isArray(agent.regexScripts) && agent.regexScripts.length > 0)
                );
            }),
            isPathfinderSubmoduleEnabled: jest.fn(() => true),
            saveAgent: jest.fn(async () => {}),
            isCompanionAgent: jest.fn(agent => agent?.execution === 'companion' || agent?.category === 'companion'),
            isToolAgent: jest.fn(() => false),
            normalizeCompanionConfig: jest.fn(value => value ?? {}),
            normalizePreProcessMaxTokens: jest.fn(value => Number.isFinite(Number(value)) ? Math.max(16, Math.min(16000, Number(value))) : 8192),
            normalizePromptTransformMaxTokens: jest.fn(value => Number.isFinite(Number(value)) ? Math.max(16, Math.min(16000, Number(value))) : 8192),
            resolveCompanionConnectionProfile: jest.fn(value => value ?? ''),
            resolveConnectionProfile: jest.fn(value => value ?? ''),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/tool-action-registry.js', () => ({
            getToolAction: jest.fn(() => null),
            getToolFormatter: jest.fn(() => null),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/tree-store.js', () => ({
            getSettings: jest.fn(() => ({ pipelinePrompts: {}, pipelines: [] })),
            setSettings: jest.fn(),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/tool-definitions.js', () => ({
            getPathfinderToolDefinitions: jest.fn(() => [
                { name: 'Pathfinder_Search', displayName: 'Search', description: 'Search', parameters: {}, actionKey: 'pathfinder.search' },
                { name: 'Pathfinder_Summarize', displayName: 'Summarize', description: 'Summarize', parameters: {}, actionKey: 'pathfinder.summarize' },
            ]),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/pathfinder-tool-bridge.js', () => ({
            getContextualLorebooks: jest.fn(() => []),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/sidecar-retrieval.js', () => ({
            PATHFINDER_RETRIEVAL_PROMPT_KEYS: ['pathfinder_sidecar_retrieval', 'pathfinder_pipeline_retrieval'],
            runSidecarRetrieval,
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/auto-summary.js', () => ({
            markAutoSummaryComplete: jest.fn(),
            shouldAutoSummarize: jest.fn(() => false),
        }));
    });

    afterEach(() => {
        jest.useRealTimers();
        delete globalThis.document;
        delete globalThis.addEventListener;
        delete globalThis.removeEventListener;
        delete globalThis.HTMLSelectElement;
        delete globalThis.requestAnimationFrame;
        delete globalThis.toastr;
        delete globalThis.$;
    });

    function useAppendPostAgent() {
        enabledAgents = [{
            id: 'agent-post-append',
            name: 'Post Append',
            phase: 'post',
            prompt: '',
            injection: { order: 100 },
            postProcess: {
                enabled: true,
                type: 'append',
                appendText: '\n[post processed]',
                promptTransformEnabled: false,
            },
            conditions: {
                triggerKeywords: [],
                triggerProbability: 100,
                generationTypes: ['normal'],
            },
        }];
    }

    function usePrePromptAgent() {
        enabledAgents = [{
            id: 'agent-pre-prompt',
            name: 'Pre Prompt',
            phase: 'pre',
            prompt: 'Use the current scene style.',
            injection: {
                position: 0,
                depth: 4,
                scan: false,
                role: 0,
            },
            postProcess: {
                enabled: false,
                promptTransformEnabled: false,
            },
            conditions: {
                triggerKeywords: [],
                triggerProbability: 100,
                generationTypes: ['normal'],
            },
        }];
    }

    function createCompanionAgent(overrides = {}) {
        return {
            id: overrides.id ?? 'agent-companion',
            name: overrides.name ?? 'Companion',
            category: overrides.category ?? 'companion',
            execution: 'companion',
            phase: overrides.phase ?? 'post',
            prompt: overrides.prompt ?? 'Write a companion note.',
            injection: {
                position: 0,
                depth: 4,
                scan: false,
                role: 0,
                order: 100,
                ...(overrides.injection ?? {}),
            },
            companion: {
                trigger: 'auto',
                displayMode: 'card',
                format: 'markdown',
                contextMessages: 10,
                feedback: { enabled: false, depth: 1 },
                ...(overrides.companion ?? {}),
            },
            postProcess: {
                enabled: false,
                promptTransformEnabled: false,
                ...(overrides.postProcess ?? {}),
            },
            conditions: {
                triggerKeywords: [],
                triggerProbability: 100,
                generationTypes: ['normal'],
                ...(overrides.conditions ?? {}),
            },
        };
    }

    function createPreInterceptAgent(overrides = {}) {
        return {
            id: overrides.id ?? 'agent-pre-intercept',
            name: overrides.name ?? 'Pre Intercept',
            phase: overrides.phase ?? 'pre',
            prompt: overrides.prompt ?? 'Rewrite the outgoing context.',
            injection: {
                position: 0,
                depth: 4,
                scan: false,
                role: 0,
                order: 100,
                ...(overrides.injection ?? {}),
            },
            preProcess: {
                mode: 'intercept',
                applyMode: 'replace',
                wrapPosition: 'after',
                wrapPrefix: '',
                wrapSuffix: '',
                patchStartTag: '<context_patch>',
                patchEndTag: '</context_patch>',
                maxTokens: 8192,
                ...(overrides.preProcess ?? {}),
            },
            postProcess: {
                enabled: false,
                promptTransformEnabled: false,
                ...(overrides.postProcess ?? {}),
            },
            conditions: {
                triggerKeywords: [],
                triggerProbability: 100,
                generationTypes: ['normal'],
                ...(overrides.conditions ?? {}),
            },
        };
    }

    function useManualTransformAgents() {
        enabledAgents = [
            {
                id: 'agent-manual-a',
                name: 'Manual A',
                phase: 'post',
                prompt: 'Rewrite as A',
                injection: { order: 100 },
                postProcess: {
                    enabled: false,
                    promptTransformEnabled: true,
                    promptTransformMode: 'rewrite',
                    promptTransformMaxTokens: 8192,
                },
                conditions: {
                    triggerKeywords: [],
                    triggerProbability: 100,
                    generationTypes: ['normal'],
                },
            },
            {
                id: 'agent-manual-b',
                name: 'Manual B',
                phase: 'post',
                prompt: 'Rewrite as B',
                injection: { order: 110 },
                postProcess: {
                    enabled: false,
                    promptTransformEnabled: true,
                    promptTransformMode: 'rewrite',
                    promptTransformMaxTokens: 8192,
                },
                conditions: {
                    triggerKeywords: [],
                    triggerProbability: 100,
                    generationTypes: ['normal'],
                },
            },
        ];
    }

    function usePromptTransformPostAgent() {
        enabledAgents = [{
            id: 'agent-post-transform',
            name: 'Post Transform',
            phase: 'post',
            prompt: 'Rewrite the final reply.',
            injection: { order: 100 },
            postProcess: {
                enabled: false,
                promptTransformEnabled: true,
                promptTransformMode: 'rewrite',
                promptTransformMaxTokens: 8192,
                promptTransformShowNotifications: false,
            },
            conditions: {
                triggerKeywords: [],
                triggerProbability: 100,
                generationTypes: ['normal'],
            },
        }];
    }

    function useRegexOnlyAgent() {
        enabledAgents = [{
            id: 'agent-regex-only',
            name: 'Regex Only',
            phase: 'pre',
            prompt: '',
            injection: { order: 100 },
            postProcess: {
                enabled: false,
                promptTransformEnabled: false,
            },
            regexScripts: [{
                id: 'regex-script-1',
                scriptName: 'Status Card',
                findRegex: '/\\[STATUS\\|([^\\]]+)\\]/g',
                replaceString: '<div class="status">$1</div>',
                trimStrings: [],
                placement: [2],
                disabled: false,
                markdownOnly: true,
                promptOnly: false,
                runOnEdit: true,
                substituteRegex: 0,
                minDepth: null,
                maxDepth: null,
            }],
            conditions: {
                triggerKeywords: [],
                triggerProbability: 100,
                generationTypes: ['normal'],
            },
        }];
    }

    function usePreExtractTracker() {
        enabledAgents = [{
            id: 'agent-pre-extract-tracker',
            name: 'Pre Extract Tracker',
            category: 'tracker',
            phase: 'pre',
            prompt: 'Track changed statuses.',
            injection: { order: 100 },
            postProcess: {
                enabled: true,
                type: 'extract',
                extractPattern: '\\[STATUS\\|[^\\]]*\\]',
                extractVariable: 'status_data',
                promptTransformEnabled: false,
            },
            conditions: {
                triggerKeywords: [],
                triggerProbability: 100,
                generationTypes: ['normal'],
            },
        }];
    }

    function expectCompactRegexSnapshot(snapshot, { generationType = 'normal', edited = false } = {}) {
        expect(snapshot).toEqual({
            activeAgentIds: ['agent-regex-only'],
            generationType,
            regexScriptRefs: [{
                agentId: 'agent-regex-only',
                scriptId: 'regex-script-1',
                revision: expect.any(String),
            }],
            edited,
        });
        expect(snapshot.regexScripts).toBeUndefined();
        expect(JSON.stringify(snapshot)).not.toContain(enabledAgents[0].regexScripts[0].findRegex);
        expect(JSON.stringify(snapshot)).not.toContain(enabledAgents[0].regexScripts[0].replaceString);
    }

    function useImpersonateTransformAgent({ runOnImpersonate = false } = {}) {
        enabledAgents = [{
            id: 'agent-impersonate-transform',
            name: 'Impersonate Transform',
            phase: 'post',
            prompt: 'Rewrite impersonate output.',
            injection: { order: 100 },
            postProcess: {
                enabled: true,
                type: 'append',
                appendText: '\n[should not run]',
                promptTransformEnabled: true,
                promptTransformMode: 'rewrite',
                promptTransformMaxTokens: 8192,
                promptTransformShowNotifications: false,
            },
            conditions: {
                triggerKeywords: [],
                triggerProbability: 100,
                generationTypes: ['impersonate'],
                runOnImpersonate,
            },
        }];
    }

    function useSavedProsePolisherWithoutImpersonateFlag() {
        enabledAgents = [{
            id: 'agent-prose-polisher',
            name: 'Prose Polisher',
            sourceTemplateId: 'tpl-prose-polisher',
            phase: 'post',
            prompt: 'Polish the generated impersonation text.',
            injection: { order: 100 },
            postProcess: {
                enabled: false,
                promptTransformEnabled: true,
                promptTransformMode: 'rewrite',
                promptTransformMaxTokens: 8192,
                promptTransformShowNotifications: false,
            },
            conditions: {
                triggerKeywords: [],
                triggerProbability: 100,
                generationTypes: ['normal', 'continue', 'impersonate'],
            },
        }];
    }

    async function waitFor(condition) {
        for (let i = 0; i < 20; i++) {
            if (condition()) {
                return;
            }

            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    function emitDocumentEvent(eventName) {
        for (const handler of documentListeners.get(eventName) ?? []) {
            handler();
        }
    }

    function switchToSwipe(message, swipeId) {
        message.swipe_id = swipeId;
        message.mes = message.swipes[swipeId];
        message.send_date = message.swipe_info[swipeId].send_date;
        message.gen_started = message.swipe_info[swipeId].gen_started;
        message.gen_finished = message.swipe_info[swipeId].gen_finished;
        message.extra = structuredClone(message.swipe_info[swipeId].extra);
    }

    function saveVisibleMessageToSwipe(message) {
        message.swipes[message.swipe_id] = message.mes;
        message.swipe_info[message.swipe_id].send_date = message.send_date;
        message.swipe_info[message.swipe_id].gen_started = message.gen_started;
        message.swipe_info[message.swipe_id].gen_finished = message.gen_finished;
        message.swipe_info[message.swipe_id].extra = structuredClone(message.extra);
    }

    test('does not register duplicate event listeners when initialized twice', async () => {
        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');

        initAgentRunner();
        initAgentRunner();

        const listenerCount = (eventName) => eventSource.on.mock.calls.filter(([event]) => event === eventName).length;

        expect(listenerCount(eventTypes.GENERATION_STARTED)).toBe(1);
        expect(listenerCount(eventTypes.MESSAGE_RECEIVED)).toBe(1);
        expect(listenerCount(eventTypes.GENERATION_ENDED)).toBe(1);
        expect(listenerCount(eventTypes.WORLDINFO_UPDATED)).toBe(1);
        expect(document.addEventListener).toHaveBeenCalledTimes(2);
        expect(globalThis.addEventListener).toHaveBeenCalledTimes(2);
    });

    test('does not mark normal chat generation as active agent generation', async () => {
        const { initAgentRunner, isAgentGenerationActive } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        expect(isAgentGenerationActive()).toBe(false);

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);

        expect(isAgentGenerationActive()).toBe(false);

        await eventSource.emit(eventTypes.GENERATION_ENDED, chat.length);

        expect(isAgentGenerationActive()).toBe(false);
    });

    test('includes pre-generation agent prompts during dry-run prompt previews', async () => {
        usePrePromptAgent();
        extensionPrompts.inchat_agent_stale = { value: 'stale preview prompt' };

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, true);

        expect(extensionPrompts.inchat_agent_stale).toBeUndefined();
        expect(extensionPrompts['inchat_agent_agent-pre-prompt']).toEqual({ value: 'Use the current scene style.' });
    });

    test('delegates companion feedback prompt injection through registered runtime', async () => {
        const companionAgent = createCompanionAgent();
        enabledAgents = [companionAgent];
        const injectCompanionFeedbackPrompts = jest.fn();

        const { initAgentRunner, registerCompanionRuntime } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        registerCompanionRuntime({ injectCompanionFeedbackPrompts });
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);

        expect(injectCompanionFeedbackPrompts).toHaveBeenCalledWith([companionAgent]);
        expect(extensionPrompts[`inchat_agent_${companionAgent.id}`]).toBeUndefined();
    });

    test('runs companion stage after assistant message processing without mutating text', async () => {
        const companionAgent = createCompanionAgent();
        enabledAgents = [companionAgent];
        chat.push(
            { mes: 'Can you continue?', name: 'User', is_user: true, is_system: false, extra: {} },
            { mes: 'Assistant reply', name: 'Assistant', is_user: false, is_system: false, extra: {} },
        );
        const runCompanionStage = jest.fn(async () => []);

        const { initAgentRunner, registerCompanionRuntime } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        registerCompanionRuntime({ runCompanionStage });
        initAgentRunner();

        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 1, 'normal');

        expect(runCompanionStage).toHaveBeenCalledWith(expect.objectContaining({
            messageIndex: 1,
            message: chat[1],
            generationType: 'normal',
            activeAgents: [companionAgent],
        }));
        expect(chat[1].mes).toBe('Assistant reply');
        expect(generateQuietPrompt).not.toHaveBeenCalled();
    });

    test('routes manual companion runs through registered runtime', async () => {
        const companionAgent = createCompanionAgent({ companion: { trigger: 'manual' } });
        enabledAgents = [companionAgent];
        chat.push({ mes: 'Assistant reply', name: 'Assistant', is_user: false, is_system: false, extra: {} });
        const runCompanionAgentOnMessage = jest.fn(async () => ({ status: 'done', content: 'note' }));

        const { registerCompanionRuntime, runAgentOnMessage } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        registerCompanionRuntime({ runCompanionAgentOnMessage });

        const result = await runAgentOnMessage(companionAgent.id, 0);

        expect(runCompanionAgentOnMessage).toHaveBeenCalledWith(companionAgent.id, 0, expect.objectContaining({
            cancelRevision: expect.any(Number),
        }));
        expect(result).toEqual({ status: 'done', content: 'note' });
        expect(generateQuietPrompt).not.toHaveBeenCalled();
    });

    test('scans the latest user message for companion keyword triggers on continue', async () => {
        const companionAgent = createCompanionAgent({
            conditions: { triggerKeywords: ['lore'], generationTypes: ['normal', 'continue'] },
        });
        enabledAgents = [companionAgent];
        chat.push(
            { mes: 'Tell me about the lore here.', name: 'User', is_user: true, is_system: false, extra: {} },
            { mes: 'An answer that never repeats the keyword.', name: 'Assistant', is_user: false, is_system: false, extra: {} },
        );
        const runCompanionStage = jest.fn(async () => []);

        const { initAgentRunner, registerCompanionRuntime } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        registerCompanionRuntime({ runCompanionStage });
        initAgentRunner();

        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 1, 'continue');

        expect(runCompanionStage).toHaveBeenCalledWith(expect.objectContaining({
            messageIndex: 1,
            generationType: 'continue',
            activeAgents: [companionAgent],
        }));
    });

    test('does not activate keyword companions from assistant-only mentions', async () => {
        const companionAgent = createCompanionAgent({
            conditions: { triggerKeywords: ['lore'], generationTypes: ['normal', 'continue'] },
        });
        enabledAgents = [companionAgent];
        chat.push(
            { mes: 'Just keep going.', name: 'User', is_user: true, is_system: false, extra: {} },
            { mes: 'The lore of this place is vast.', name: 'Assistant', is_user: false, is_system: false, extra: {} },
        );
        const runCompanionStage = jest.fn(async () => []);

        const { initAgentRunner, registerCompanionRuntime } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        registerCompanionRuntime({ runCompanionStage });
        initAgentRunner();

        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 1, 'normal');

        const sawCompanion = runCompanionStage.mock.calls
            .some(([stage]) => (stage?.activeAgents ?? []).includes(companionAgent));
        expect(sawCompanion).toBe(false);
    });

    test('supports regex-literal companion trigger keywords', async () => {
        const companionAgent = createCompanionAgent({
            conditions: { triggerKeywords: ['/dragon\\s+lair/i'], generationTypes: ['normal'] },
        });
        enabledAgents = [companionAgent];
        chat.push(
            { mes: 'We approach the Dragon  Lair at dusk.', name: 'User', is_user: true, is_system: false, extra: {} },
            { mes: 'The gates loom.', name: 'Assistant', is_user: false, is_system: false, extra: {} },
        );
        const runCompanionStage = jest.fn(async () => []);

        const { initAgentRunner, registerCompanionRuntime } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        registerCompanionRuntime({ runCompanionStage });
        initAgentRunner();

        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 1, 'normal');

        expect(runCompanionStage).toHaveBeenCalledWith(expect.objectContaining({
            activeAgents: [companionAgent],
        }));
    });

    test('persists companion notes per swipe and restores them on swipe back', async () => {
        const companionAgent = createCompanionAgent();
        enabledAgents = [companionAgent];
        const companionRunner = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');

        const message = {
            mes: 'Assistant reply',
            name: 'Assistant',
            is_user: false,
            is_system: false,
            extra: {},
            swipe_id: 0,
            swipes: ['Assistant reply'],
            swipe_info: [{ extra: {} }],
        };
        chat.push(message);

        companionRunner.setCompanionResult(message, companionAgent, { status: 'done', content: 'note A' });

        expect(message.extra.inChatAgentCompanionResults[companionAgent.id]).toEqual(expect.objectContaining({
            status: 'done',
            content: 'note A',
        }));
        expect(message.swipe_info[0].extra.inChatAgentCompanionResults[companionAgent.id]).toEqual(expect.objectContaining({
            status: 'done',
            content: 'note A',
        }));

        // Swipe to a fresh second swipe: the active extra no longer carries the note.
        message.swipes.push('Second swipe');
        message.swipe_info.push({ extra: {} });
        message.swipe_id = 1;
        message.extra = structuredClone(message.swipe_info[1].extra);
        message.mes = 'Second swipe';

        expect(companionRunner.getCompanionResults(message)).toEqual({});

        // Swipe back restores the stored note.
        message.swipe_id = 0;
        message.extra = structuredClone(message.swipe_info[0].extra);
        message.mes = 'Assistant reply';

        expect(companionRunner.getCompanionResults(message)[companionAgent.id]).toEqual(expect.objectContaining({
            content: 'note A',
        }));

        expect(companionRunner.deleteCompanionResult(message, companionAgent.id)).toBe(true);
        expect(companionRunner.getCompanionResults(message)).toEqual({});
        expect(message.extra.inChatAgentCompanionResults).toBeUndefined();
        expect(message.swipe_info[0].extra.inChatAgentCompanionResults).toBeUndefined();
    });

    test('sends raw-prompt companion prompts verbatim without extra instructions', async () => {
        const rawCompanion = createCompanionAgent({ id: 'raw-companion', companion: { rawPrompt: true } });
        rawCompanion.prompt = 'Track the scene state in the [Scene|...] format.';
        const noteCompanion = createCompanionAgent({ id: 'note-companion' });
        noteCompanion.prompt = 'Write a side note.';
        enabledAgents = [rawCompanion, noteCompanion];
        const companionRunner = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');

        chat.push(
            { mes: 'Hello there.', name: 'User', is_user: true, is_system: false, extra: {} },
            { mes: 'Assistant reply', name: 'Assistant', is_user: false, is_system: false, extra: {} },
        );

        const rawMessages = await companionRunner.buildCompanionPromptMessages(rawCompanion, 1);
        expect(rawMessages[0].role).toBe('system');
        expect(rawMessages[0].content.startsWith('Pause all roleplay and output only the following.')).toBe(true);
        expect(rawMessages[0].content).toContain('Track the scene state in the [Scene|...] format.');
        expect(rawMessages[0].content).not.toContain('Return only markdown');

        const noteMessages = await companionRunner.buildCompanionPromptMessages(noteCompanion, 1);
        expect(noteMessages[0].content.startsWith('Pause all roleplay and output only the following.')).toBe(true);
        expect(noteMessages[0].content).toContain('Write a side note.');
        expect(noteMessages[0].content).toContain('Return only markdown');
        expect(noteMessages[1].content).toContain('[Task]');
        expect(noteMessages[1].content).toContain('do not continue the conversation itself');
    });

    test('includes the system prompt and authors note sections when toggled on', async () => {
        const contextCompanion = createCompanionAgent({
            id: 'context-companion',
            companion: { includeSystemPrompt: true, includeAuthorsNote: true },
        });
        enabledAgents = [contextCompanion];
        chatMetadata.note_prompt = 'Remember: it is raining.';
        const companionRunner = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');

        chat.push(
            { mes: 'Hello there.', name: 'User', is_user: true, is_system: false, extra: {} },
            { mes: 'Assistant reply', name: 'Assistant', is_user: false, is_system: false, extra: {} },
        );

        const messages = await companionRunner.buildCompanionPromptMessages(contextCompanion, 1);

        expect(messages[1].content).toContain('[System Prompt]\nGlobal system prompt text.');
        expect(messages[1].content).toContain('[Author\'s Note]\nRemember: it is raining.');

        const plainCompanion = createCompanionAgent({ id: 'plain-companion' });
        const plainMessages = await companionRunner.buildCompanionPromptMessages(plainCompanion, 1);
        expect(plainMessages[1].content).not.toContain('[System Prompt]');
        expect(plainMessages[1].content).not.toContain('[Author\'s Note]');
    });

    test('excludes the rewritten tail message from feedback on swipes', async () => {
        const feedbackCompanion = createCompanionAgent({
            id: 'feedback-companion',
            companion: { feedback: { enabled: true, depth: 2 } },
        });
        enabledAgents = [feedbackCompanion];
        const companionRunner = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');

        const earlierReply = { mes: 'Reply one', name: 'Assistant', is_user: false, is_system: false, extra: {} };
        const tailReply = { mes: 'Reply two', name: 'Assistant', is_user: false, is_system: false, extra: {} };
        chat.push(earlierReply, { mes: 'Go on.', name: 'User', is_user: true, is_system: false, extra: {} }, tailReply);
        companionRunner.setCompanionResult(earlierReply, feedbackCompanion, { status: 'done', content: 'State one' });
        companionRunner.setCompanionResult(tailReply, feedbackCompanion, { status: 'done', content: 'Stale swipe state' });

        // Assistant tail = swipe/regenerate of that message: its own state must not feed back.
        companionRunner.injectCompanionFeedbackPrompts([feedbackCompanion]);
        const injected = extensionPrompts['inchat_agent_companion_feedback-companion'];
        expect(injected.value).toContain('State one');
        expect(injected.value).not.toContain('Stale swipe state');

        // User tail = normal generation: the latest stored states all feed back.
        chat.push({ mes: 'And then?', name: 'User', is_user: true, is_system: false, extra: {} });
        companionRunner.injectCompanionFeedbackPrompts([feedbackCompanion]);
        expect(extensionPrompts['inchat_agent_companion_feedback-companion'].value).toContain('Stale swipe state');
    });

    test('appends the repair instruction on fix runs', async () => {
        const fixCompanion = createCompanionAgent({ id: 'fix-companion' });
        enabledAgents = [fixCompanion];
        const companionRunner = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');

        chat.push(
            { mes: 'Hello.', name: 'User', is_user: true, is_system: false, extra: {} },
            { mes: 'Assistant reply', name: 'Assistant', is_user: false, is_system: false, extra: {} },
        );

        const repairMessages = await companionRunner.buildCompanionPromptMessages(fixCompanion, 1, 'normal', { repair: true });
        expect(repairMessages[0].content).toContain('Redo the task now');

        const normalMessages = await companionRunner.buildCompanionPromptMessages(fixCompanion, 1);
        expect(normalMessages[0].content).not.toContain('Redo the task now');
    });

    test('feeds a companion its previous states when history is enabled', async () => {
        const historyCompanion = createCompanionAgent({
            id: 'history-companion',
            companion: { includeHistory: true, historyDepth: 2 },
        });
        enabledAgents = [historyCompanion];
        const companionRunner = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');

        chat.push(
            { mes: 'Reply one', name: 'Assistant', is_user: false, is_system: false, extra: {} },
            { mes: 'Keep going.', name: 'User', is_user: true, is_system: false, extra: {} },
            { mes: 'Reply two', name: 'Assistant', is_user: false, is_system: false, extra: {} },
        );
        companionRunner.setCompanionResult(chat[0], historyCompanion, { status: 'done', content: 'State after reply one' });

        const messages = await companionRunner.buildCompanionPromptMessages(historyCompanion, 2);

        expect(messages[1].content).toContain('[Your previous notes]');
        expect(messages[1].content).toContain('State after reply one');

        const noHistoryCompanion = createCompanionAgent({ id: 'no-history-companion', companion: { includeHistory: false } });
        const plainMessages = await companionRunner.buildCompanionPromptMessages(noHistoryCompanion, 2);
        expect(plainMessages[1].content).not.toContain('[Your previous notes]');
    });

    test('runs the companion stage concurrently with post passes when enabled', async () => {
        globalSettings.companionConcurrentWithPostGen = true;
        const companionAgent = createCompanionAgent();
        enabledAgents = [companionAgent];
        chat.push(
            { mes: 'Can you continue?', name: 'User', is_user: true, is_system: false, extra: {} },
            { mes: 'Assistant reply', name: 'Assistant', is_user: false, is_system: false, extra: {} },
        );
        const runCompanionStage = jest.fn(async () => []);

        const { initAgentRunner, registerCompanionRuntime } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        registerCompanionRuntime({ runCompanionStage });
        initAgentRunner();

        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 1, 'normal');

        expect(runCompanionStage).toHaveBeenCalledTimes(1);
        expect(runCompanionStage).toHaveBeenCalledWith(expect.objectContaining({
            messageIndex: 1,
            activeAgents: [companionAgent],
        }));
    });

    test('guards tracker companions against continuing the story even with raw prompts', async () => {
        const rawTracker = createCompanionAgent({ id: 'raw-tracker', category: 'tracker', companion: { rawPrompt: true } });
        rawTracker.prompt = 'Track the scene in the [Scene|...] format.';
        enabledAgents = [rawTracker];
        const companionRunner = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');

        chat.push(
            { mes: 'Hello there.', name: 'User', is_user: true, is_system: false, extra: {} },
            { mes: 'Assistant reply', name: 'Assistant', is_user: false, is_system: false, extra: {} },
        );

        const messages = await companionRunner.buildCompanionPromptMessages(rawTracker, 1);

        expect(messages[0].content.startsWith('Pause all roleplay and output only the following.')).toBe(true);
        expect(messages[0].content).toContain('Track the scene in the [Scene|...] format.');
        expect(messages[0].content).not.toContain('Return only markdown');
    });

    test('stores readable profile labels instead of raw profile ids', async () => {
        const profiledCompanion = createCompanionAgent({ id: 'profiled-companion' });
        profiledCompanion.connectionProfile = '20345602-939a-44c2-8522-525fb7212b0e';
        enabledAgents = [profiledCompanion];
        const companionRunner = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');

        const unresolvedMessage = { mes: 'Reply A', name: 'Assistant', is_user: false, is_system: false, extra: {} };
        chat.push(unresolvedMessage);

        const unresolved = companionRunner.setCompanionResult(unresolvedMessage, profiledCompanion, { status: 'done', content: 'note' });
        expect(unresolved.profileLabel).toBe('');

        connectionManagerRequestService = {
            getProfile: jest.fn(() => ({ name: 'Cheap Notes Model' })),
        };
        const resolvedMessage = { mes: 'Reply B', name: 'Assistant', is_user: false, is_system: false, extra: {} };
        chat.push(resolvedMessage);

        const resolved = companionRunner.setCompanionResult(resolvedMessage, profiledCompanion, { status: 'done', content: 'note' });
        expect(resolved.profileLabel).toBe('Cheap Notes Model');
    });

    test('waits for Pathfinder retrieval before injecting pre-generation prompts', async () => {
        usePrePromptAgent();
        enabledAgents.unshift({
            id: 'agent-pathfinder',
            name: 'Pathfinder',
            category: 'tool',
            sourceTemplateId: 'tpl-pathfinder',
            phase: 'both',
            prompt: '',
            injection: { order: 0 },
            settings: { pipelineEnabled: true, sidecarEnabled: false },
            tools: [],
            conditions: {
                triggerKeywords: [],
                triggerProbability: 100,
                generationTypes: ['normal'],
            },
        });

        let resolveRetrieval;
        const retrievalDone = new Promise(resolve => {
            resolveRetrieval = resolve;
        });
        runSidecarRetrieval.mockImplementation(async () => {
            await retrievalDone;
            extensionPrompts.pathfinder_pipeline_retrieval = { value: 'retrieved lore' };
        });

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        const generationPromise = eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
        await Promise.resolve();

        expect(runSidecarRetrieval).toHaveBeenCalledTimes(1);
        expect(extensionPrompts['inchat_agent_agent-pre-prompt']).toBeUndefined();

        resolveRetrieval();
        await generationPromise;

        expect(extensionPrompts.pathfinder_pipeline_retrieval).toEqual({ value: 'retrieved lore' });
        expect(extensionPrompts['inchat_agent_agent-pre-prompt']).toEqual({ value: 'Use the current scene style.' });
    });

    test('reuses cached Pathfinder retrieval when swiping the same assistant message', async () => {
        usePrePromptAgent();
        enabledAgents.unshift({
            id: 'agent-pathfinder',
            name: 'Pathfinder',
            category: 'tool',
            sourceTemplateId: 'tpl-pathfinder',
            phase: 'both',
            prompt: '',
            injection: { order: 0 },
            settings: { pipelineEnabled: true, sidecarEnabled: false, pipelineId: 'default' },
            tools: [],
            conditions: {
                triggerKeywords: [],
                triggerProbability: 100,
                generationTypes: ['normal'],
            },
        });
        chat.push(
            {
                name: 'User',
                mes: 'Which lore applies here?',
                is_user: true,
                is_system: false,
                send_date: 'user-1',
                extra: {},
            },
            {
                name: 'Assistant',
                mes: 'First swipe',
                is_user: false,
                is_system: false,
                send_date: 'assistant-0',
                gen_started: 'started-0',
                gen_finished: 'finished-0',
                swipe_id: 0,
                swipes: ['First swipe', 'Second swipe'],
                swipe_info: [
                    { send_date: 'assistant-0', gen_started: 'started-0', gen_finished: 'finished-0', extra: {} },
                    { send_date: 'assistant-1', gen_started: 'started-1', gen_finished: 'finished-1', extra: {} },
                ],
                extra: {},
            },
        );
        runSidecarRetrieval.mockImplementation(async (setPrompt, promptTypes, promptRoles) => {
            setPrompt('pathfinder_pipeline_retrieval', 'retrieved lore', promptTypes.IN_PROMPT, 4, false, promptRoles.SYSTEM);
        });

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);

        expect(runSidecarRetrieval).toHaveBeenCalledTimes(1);
        expect(extensionPrompts.pathfinder_pipeline_retrieval).toEqual({ value: 'retrieved lore' });
        expect(chat[1].swipe_info[0].extra.pathfinderRetrievalCache).toHaveLength(1);

        switchToSwipe(chat[1], 1);

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        expect(extensionPrompts.pathfinder_pipeline_retrieval).toBeUndefined();

        await eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);

        expect(runSidecarRetrieval).toHaveBeenCalledTimes(1);
        expect(extensionPrompts.pathfinder_pipeline_retrieval).toEqual({ value: 'retrieved lore' });
        expect(extensionPrompts['inchat_agent_agent-pre-prompt']).toEqual({ value: 'Use the current scene style.' });
    });

    test('shows a processing toast while Pathfinder pipeline retrieval is running', async () => {
        usePrePromptAgent();
        enabledAgents.unshift({
            id: 'agent-pathfinder',
            name: 'Pathfinder',
            category: 'tool',
            sourceTemplateId: 'tpl-pathfinder',
            phase: 'both',
            prompt: '',
            injection: { order: 0 },
            settings: { pipelineEnabled: true, sidecarEnabled: false },
            tools: [],
            conditions: {
                triggerKeywords: [],
                triggerProbability: 100,
                generationTypes: ['normal'],
            },
        });

        let resolveRetrieval;
        const retrievalDone = new Promise(resolve => {
            resolveRetrieval = resolve;
        });
        runSidecarRetrieval.mockImplementation(async () => {
            await retrievalDone;
        });

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        const generationPromise = eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
        await Promise.resolve();

        expect(globalThis.toastr.info).toHaveBeenCalledWith('Pathfinder is processing lore for this reply...', 'Please wait', { timeOut: 0, extendedTimeOut: 0 });
        expect(globalThis.toastr.clear).not.toHaveBeenCalled();

        resolveRetrieval();
        await generationPromise;

        expect(globalThis.toastr.clear).toHaveBeenCalledWith({ toast: true });
    });

    test('runs pre-generation intercept agents on text prompts without injecting their prompt', async () => {
        enabledAgents = [createPreInterceptAgent({
            preProcess: { applyMode: 'replace', maxTokens: 123 },
        })];
        globalSettings.helperPrefillMessages = '[system]\nUse the helper prefill.';

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);

        const eventData = { prompt: 'Original outgoing prompt', dryRun: false };
        await eventSource.emit(eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, eventData);

        expect(extensionPrompts['inchat_agent_agent-pre-intercept']).toBeUndefined();
        expect(generateQuietPrompt).toHaveBeenCalledTimes(1);
        expect(generateQuietPrompt.mock.calls[0][0]).toEqual(expect.objectContaining({
            quietName: 'In-Chat Agent',
            responseLength: 123,
            skipWIAN: true,
            removeReasoning: true,
        }));
        expect(generateQuietPrompt.mock.calls[0][0].quietPrompt).toContain('Outgoing context:');
        expect(generateQuietPrompt.mock.calls[0][0].quietPrompt).toContain('Original outgoing prompt');
        expect(generateQuietPrompt.mock.calls[0][0].quietPrompt).toContain('SYSTEM:\nUse the helper prefill.');
        expect(eventData.prompt).toBe('quiet result');

        chat.push({
            name: 'Assistant',
            mes: 'Final assistant reply',
            is_user: false,
            is_system: false,
            extra: {},
        });
        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');
        await eventSource.emit(eventTypes.GENERATION_ENDED, chat.length);
        await waitFor(() => Array.isArray(chat[0].extra.inChatAgentPreGenerationInterceptHistory));

        expect(chat[0].extra.inChatAgentPreGenerationInterceptHistory).toEqual([expect.objectContaining({
            agentId: 'agent-pre-intercept',
            agentName: 'Pre Intercept',
            applyMode: 'replace',
            contextFormat: 'text',
            beforeText: 'Original outgoing prompt',
            outputText: 'quiet result',
            afterText: 'quiet result',
            changed: true,
            status: 'changed',
        })]);
        expect(chat[0].swipe_info[0].extra.inChatAgentPreGenerationInterceptHistory).toEqual(chat[0].extra.inChatAgentPreGenerationInterceptHistory);
    });

    test('chains multiple pre-generation intercept agents by order', async () => {
        enabledAgents = [
            createPreInterceptAgent({
                id: 'agent-second',
                name: 'Second',
                prompt: 'Second pass.',
                injection: { order: 20 },
            }),
            createPreInterceptAgent({
                id: 'agent-first',
                name: 'First',
                prompt: 'First pass.',
                injection: { order: 10 },
            }),
        ];
        generateQuietPrompt
            .mockResolvedValueOnce('first output')
            .mockResolvedValueOnce('second output');

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        const eventData = { prompt: 'Original prompt', dryRun: false };
        await eventSource.emit(eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, eventData);

        expect(generateQuietPrompt).toHaveBeenCalledTimes(2);
        expect(generateQuietPrompt.mock.calls[0][0].quietPrompt).toContain('First pass.');
        expect(generateQuietPrompt.mock.calls[0][0].quietPrompt).toContain('Original prompt');
        expect(generateQuietPrompt.mock.calls[1][0].quietPrompt).toContain('Second pass.');
        expect(generateQuietPrompt.mock.calls[1][0].quietPrompt).toContain('first output');
        expect(eventData.prompt).toBe('second output');
    });

    test('replaces chat completion prompts when intercept output is a message array', async () => {
        enabledAgents = [createPreInterceptAgent()];
        generateQuietPrompt.mockResolvedValue(JSON.stringify([
            { role: 'system', content: 'rewritten system prompt' },
            { role: 'user', content: 'rewritten user prompt' },
        ]));

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        const originalChat = [{ role: 'user', content: 'original user prompt' }];
        const eventData = { chat: originalChat, dryRun: false };
        await eventSource.emit(eventTypes.CHAT_COMPLETION_PROMPT_READY, eventData);

        expect(generateQuietPrompt).toHaveBeenCalledTimes(1);
        expect(generateQuietPrompt.mock.calls[0][0].quietPrompt).toContain('JSON array of chat-completion messages');
        expect(generateQuietPrompt.mock.calls[0][0].quietPrompt).toContain('original user prompt');
        expect(eventData.chat).toBe(originalChat);
        expect(eventData.chat).toEqual([
            { role: 'system', content: 'rewritten system prompt' },
            { role: 'user', content: 'rewritten user prompt' },
        ]);
        expect(eventData.chatChanged).toBe(true);
    });

    test('leaves chat completion prompts unchanged when intercept output has invalid messages', async () => {
        const invalidReplacementChats = [
            ['a non-object entry', ['bad message']],
            ['an unsupported role', [{ role: 'developer', content: 'bad role' }]],
            ['missing content', [{ role: 'user' }]],
            ['a tool message without an id', [{ role: 'tool', content: 'tool output' }]],
        ];
        enabledAgents = [createPreInterceptAgent()];
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        try {
            const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
            initAgentRunner();

            for (const [caseName, replacementChat] of invalidReplacementChats) {
                const invalidOutputText = JSON.stringify(replacementChat);
                generateQuietPrompt.mockResolvedValueOnce(invalidOutputText);

                await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
                const originalMessage = { role: 'user', content: `original user prompt for ${caseName}` };
                const originalChat = [originalMessage];
                const eventData = { chat: originalChat, dryRun: false };
                await eventSource.emit(eventTypes.CHAT_COMPLETION_PROMPT_READY, eventData);

                expect(eventData.chat).toBe(originalChat);
                expect(eventData.chat).toEqual([originalMessage]);
                expect(eventData.chatChanged).toBeUndefined();
                expect(warnSpy).toHaveBeenCalledWith(
                    expect.stringContaining('Leaving chat context unchanged'),
                    expect.any(Error),
                );

                const messageIndex = chat.length;
                chat.push({
                    name: 'Assistant',
                    mes: `Chat reply for ${caseName}`,
                    is_user: false,
                    is_system: false,
                    extra: {},
                });
                await eventSource.emit(eventTypes.MESSAGE_RECEIVED, messageIndex, 'normal');
                await eventSource.emit(eventTypes.GENERATION_ENDED, chat.length);
                await waitFor(() => Array.isArray(chat[messageIndex].extra.inChatAgentPreGenerationInterceptHistory));

                expect(chat[messageIndex].extra.inChatAgentPreGenerationInterceptHistory).toEqual([expect.objectContaining({
                    status: 'error',
                    changed: false,
                    beforeText: JSON.stringify(originalChat, null, 2),
                    afterText: JSON.stringify(originalChat, null, 2),
                    outputText: invalidOutputText,
                })]);
            }
        } finally {
            warnSpy.mockRestore();
        }
    });

    test('adds patch messages for chat completion intercept agents in patch mode', async () => {
        enabledAgents = [createPreInterceptAgent({
            injection: { role: 1 },
            preProcess: {
                applyMode: 'patch',
                wrapPosition: 'before',
                patchStartTag: '<patch>',
                patchEndTag: '</patch>',
            },
        })];
        generateQuietPrompt.mockResolvedValue('patch note');

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        const originalMessage = { role: 'user', content: 'original user prompt' };
        const eventData = { chat: [originalMessage], dryRun: false };
        await eventSource.emit(eventTypes.CHAT_COMPLETION_PROMPT_READY, eventData);

        expect(eventData.chat).toEqual([
            { role: 'user', content: '<patch>\npatch note\n</patch>' },
            originalMessage,
        ]);
        expect(eventData.chatChanged).toBe(true);

        chat.push({
            name: 'Assistant',
            mes: 'Chat reply',
            is_user: false,
            is_system: false,
            extra: {},
        });
        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');
        await eventSource.emit(eventTypes.GENERATION_ENDED, chat.length);
        await waitFor(() => Array.isArray(chat[0].extra.inChatAgentPreGenerationInterceptHistory));

        expect(chat[0].extra.inChatAgentPreGenerationInterceptHistory).toEqual([expect.objectContaining({
            applyMode: 'patch',
            contextFormat: 'chat',
            outputText: 'patch note',
            role: 'user',
            status: 'changed',
        })]);
        expect(chat[0].extra.inChatAgentPreGenerationInterceptHistory[0].beforeText).toContain('original user prompt');
        expect(JSON.parse(chat[0].extra.inChatAgentPreGenerationInterceptHistory[0].afterText)[0].content).toBe('<patch>\npatch note\n</patch>');
    });

    test('skips pre-generation intercepts during dry runs and outside active generation', async () => {
        enabledAgents = [createPreInterceptAgent()];

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        const inactiveEventData = { prompt: 'inactive prompt', dryRun: false };
        await eventSource.emit(eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, inactiveEventData);

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        const dryRunEventData = { prompt: 'dry run prompt', dryRun: true };
        await eventSource.emit(eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, dryRunEventData);

        expect(generateQuietPrompt).not.toHaveBeenCalled();
        expect(inactiveEventData.prompt).toBe('inactive prompt');
        expect(dryRunEventData.prompt).toBe('dry run prompt');
    });

    test('post-main intercept agents do not rewrite outgoing pre-generation prompts', async () => {
        enabledAgents = [createPreInterceptAgent({
            preProcess: { interceptTiming: 'post-main-generation' },
        })];

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        const eventData = { prompt: 'Original outgoing prompt', dryRun: false };
        await eventSource.emit(eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, eventData);

        expect(generateQuietPrompt).not.toHaveBeenCalled();
        expect(eventData.prompt).toBe('Original outgoing prompt');
    });

    test('marks streaming output for buffering when post-main intercept agents are active', async () => {
        enabledAgents = [createPreInterceptAgent({
            preProcess: { interceptTiming: 'post-main-generation' },
        })];

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        const eventData = { type: 'normal', isStreaming: true, hasPostMainInterceptors: false };
        await eventSource.emit(eventTypes.GENERATION_OUTPUT_BUFFERING_DECISION, eventData);

        expect(eventData.hasPostMainInterceptors).toBe(true);
    });

    test('keeps streaming output unbuffered when no post-main intercept agents are active', async () => {
        enabledAgents = [createPreInterceptAgent()];

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        const eventData = { type: 'normal', isStreaming: true, hasPostMainInterceptors: false };
        await eventSource.emit(eventTypes.GENERATION_OUTPUT_BUFFERING_DECISION, eventData);

        expect(eventData.hasPostMainInterceptors).toBe(false);
    });

    test('runs post-main intercepts before storing the assistant message', async () => {
        enabledAgents = [createPreInterceptAgent({
            preProcess: { interceptTiming: 'post-main-generation', applyMode: 'replace' },
        })];
        generateQuietPrompt.mockResolvedValue('intercepted assistant reply');

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        const outputData = { type: 'normal', text: 'raw assistant reply', isStreaming: false, cancelled: false };
        await eventSource.emit(eventTypes.MAIN_GENERATION_OUTPUT_READY, outputData);

        expect(outputData.cancelled).toBe(false);
        expect(outputData.text).toBe('intercepted assistant reply');
        expect(generateQuietPrompt.mock.calls[0][0].quietPrompt).toContain('Main model output:');
        expect(generateQuietPrompt.mock.calls[0][0].quietPrompt).toContain('raw assistant reply');

        chat.push({
            name: 'Assistant',
            mes: outputData.text,
            is_user: false,
            is_system: false,
            extra: {},
        });
        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');
        await eventSource.emit(eventTypes.GENERATION_ENDED, chat.length);
        await waitFor(() => Array.isArray(chat[0].extra.inChatAgentPreGenerationInterceptHistory));

        expect(chat[0].mes).toBe('intercepted assistant reply');
        expect(chat[0].extra.inChatAgentPreGenerationInterceptHistory).toEqual([expect.objectContaining({
            agentId: 'agent-pre-intercept',
            timing: 'post-main-generation',
            beforeText: 'raw assistant reply',
            outputText: 'intercepted assistant reply',
            afterText: 'intercepted assistant reply',
            changed: true,
            status: 'changed',
        })]);
    });

    test('falls back to raw output when a post-main intercept fails', async () => {
        enabledAgents = [createPreInterceptAgent({
            preProcess: { interceptTiming: 'post-main-generation' },
        })];
        generateQuietPrompt.mockRejectedValue(new Error('post-main failed'));
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        try {
            const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
            initAgentRunner();

            await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
            const outputData = { type: 'normal', text: 'raw assistant reply', isStreaming: false, cancelled: false };
            await eventSource.emit(eventTypes.MAIN_GENERATION_OUTPUT_READY, outputData);

            expect(outputData.cancelled).toBe(false);
            expect(outputData.text).toBe('raw assistant reply');

            chat.push({
                name: 'Assistant',
                mes: outputData.text,
                is_user: false,
                is_system: false,
                extra: {},
            });
            await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');
            await eventSource.emit(eventTypes.GENERATION_ENDED, chat.length);
            await waitFor(() => Array.isArray(chat[0].extra.inChatAgentPreGenerationInterceptHistory));

            expect(chat[0].extra.inChatAgentPreGenerationInterceptHistory).toEqual([expect.objectContaining({
                timing: 'post-main-generation',
                status: 'error',
                changed: false,
                beforeText: 'raw assistant reply',
                afterText: 'raw assistant reply',
                error: 'post-main failed',
            })]);
        } finally {
            warnSpy.mockRestore();
        }
    });

    test('cancels post-main output instead of storing raw text after generation stop', async () => {
        enabledAgents = [createPreInterceptAgent({
            preProcess: { interceptTiming: 'post-main-generation' },
        })];

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await eventSource.emit(eventTypes.GENERATION_STOPPED);
        const outputData = { type: 'normal', text: 'raw assistant reply', isStreaming: false, cancelled: false };
        await eventSource.emit(eventTypes.MAIN_GENERATION_OUTPUT_READY, outputData);

        expect(outputData.cancelled).toBe(true);
        expect(outputData.text).toBe('raw assistant reply');
        expect(generateQuietPrompt).not.toHaveBeenCalled();
    });

    test('exposes pre-generation intercept history for message document UI', async () => {
        const { getPreGenerationInterceptHistoryForMessage } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        const message = {
            name: 'Assistant',
            mes: 'Visible swipe',
            is_user: false,
            is_system: false,
            swipe_id: 1,
            swipes: ['Other swipe', 'Visible swipe'],
            swipe_info: [
                { extra: {} },
                {
                    extra: {
                        inChatAgentPreGenerationInterceptHistory: [{
                            agentId: 'agent-pre-intercept',
                            agentName: 'Pre Intercept',
                            applyMode: 'patch',
                            contextFormat: 'chat',
                            status: 'changed',
                            outputText: 'visible plan',
                        }],
                    },
                },
            ],
            extra: {
                inChatAgentPreGenerationInterceptHistory: [{
                    agentId: 'stale',
                    agentName: 'Stale',
                    outputText: 'hidden plan',
                }],
            },
        };

        expect(getPreGenerationInterceptHistoryForMessage(message)).toEqual([expect.objectContaining({
            agentId: 'agent-pre-intercept',
            outputText: 'visible plan',
        })]);
    });

    test('queues manual agent runs while another manual agent is active in sequential mode', async () => {
        useManualTransformAgents();
        globalSettings.appendAgentsExecutionMode = 'sequential';
        const quietResolvers = [];
        generateQuietPrompt.mockImplementation(async () => await new Promise(resolve => quietResolvers.push(resolve)));
        chat.push({
            name: 'Assistant',
            mes: 'Original reply',
            is_user: false,
            is_system: false,
            extra: {},
        });

        const { isAgentGenerationActive, runAgentOnMessage } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');

        const firstRun = runAgentOnMessage('agent-manual-a', 0);
        await waitFor(() => generateQuietPrompt.mock.calls.length === 1);

        expect(isAgentGenerationActive()).toBe(true);

        const secondRun = runAgentOnMessage('agent-manual-b', 0);
        await waitFor(() => quietResolvers.length === 1);

        expect(generateQuietPrompt).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr.info).toHaveBeenCalledWith('Queued agent run.');

        quietResolvers.shift()('First rewrite');
        const firstResult = await firstRun;

        expect(firstResult.status).toBe('changed');
        expect(chat[0].mes).toBe('First rewrite');

        await waitFor(() => generateQuietPrompt.mock.calls.length === 2);

        expect(generateQuietPrompt).toHaveBeenCalledTimes(2);
        expect(isAgentGenerationActive()).toBe(true);

        quietResolvers.shift()('Second rewrite');
        const secondResult = await secondRun;

        expect(secondResult.status).toBe('changed');
        expect(chat[0].mes).toBe('Second rewrite');
        expect(globalThis.toastr.warning).not.toHaveBeenCalledWith('Cannot run an agent while another is in progress.');
        expect(isAgentGenerationActive()).toBe(false);
    });

    test('starts manual agent runs immediately in parallel mode', async () => {
        useManualTransformAgents();
        globalSettings.appendAgentsExecutionMode = 'parallel';
        const quietResolvers = [];
        generateQuietPrompt.mockImplementation(async () => await new Promise(resolve => quietResolvers.push(resolve)));
        chat.push({
            name: 'Assistant',
            mes: 'Original reply',
            is_user: false,
            is_system: false,
            extra: {},
        });

        const { isAgentGenerationActive, runAgentOnMessage } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');

        const firstRun = runAgentOnMessage('agent-manual-a', 0);
        await waitFor(() => generateQuietPrompt.mock.calls.length === 1);
        const secondRun = runAgentOnMessage('agent-manual-b', 0);
        await waitFor(() => generateQuietPrompt.mock.calls.length === 2);

        expect(quietResolvers).toHaveLength(2);
        expect(globalThis.toastr.info).toHaveBeenCalledWith('Running agent in parallel.');
        expect(globalThis.toastr.info).not.toHaveBeenCalledWith('Queued agent run.');
        expect(isAgentGenerationActive()).toBe(true);

        quietResolvers.shift()('First rewrite');
        const firstResult = await firstRun;
        quietResolvers.shift()('Second rewrite');
        const secondResult = await secondRun;

        expect(firstResult.status).toBe('changed');
        expect(secondResult.status).toBe('changed');
        expect(chat[0].mes).toBe('Second rewrite');
        expect(isAgentGenerationActive()).toBe(false);
    });

    test('defers enabled post-processing agents until the main generation is idle', async () => {
        useAppendPostAgent();

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        document.body.dataset.generating = 'true';
        chat.push({
            name: 'Assistant',
            mes: 'Fresh reply',
            is_user: false,
            is_system: false,
            extra: {},
        });

        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');

        expect(chat[0].mes).toBe('Fresh reply');
        expect(saveChatDebounced).not.toHaveBeenCalled();

        delete document.body.dataset.generating;
        await eventSource.emit(eventTypes.GENERATION_ENDED, chat.length);
        await new Promise(resolve => setTimeout(resolve, 5));

        expect(chat[0].mes).toBe('Fresh reply\n[post processed]');
        expect(saveChatDebounced).toHaveBeenCalledTimes(1);
    });

    test('does not run post-processing agents for greeting messages', async () => {
        useAppendPostAgent();

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        chat.push({
            name: 'Assistant',
            mes: 'Hello there',
            is_user: false,
            is_system: false,
            extra: {},
        });

        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'first_message');
        await eventSource.emit(eventTypes.CHARACTER_MESSAGE_RENDERED, 0, 'first_message');
        await new Promise(resolve => setTimeout(resolve, 75));

        expect(chat[0].mes).toBe('Hello there');
        expect(chat[0].extra.inChatAgentPostRuns).toBeUndefined();
        expect(saveChatDebounced).not.toHaveBeenCalled();
    });

    test('snapshots regex-only agents as soon as the assistant message is received', async () => {
        useRegexOnlyAgent();

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
        document.body.dataset.generating = 'true';
        chat.push({
            name: 'Assistant',
            mes: '[STATUS|ready]',
            is_user: false,
            is_system: false,
            extra: {},
        });

        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');

        expect(chat[0].mes).toBe('[STATUS|ready]');
        expectCompactRegexSnapshot(chat[0].extra.inChatAgents);
        expect(saveChatDebounced).toHaveBeenCalledTimes(1);

        await eventSource.emit(eventTypes.CHARACTER_MESSAGE_RENDERED, 0, 'normal');
        expect(saveChatDebounced).toHaveBeenCalledTimes(1);

        delete document.body.dataset.generating;
        await eventSource.emit(eventTypes.GENERATION_ENDED, chat.length);
        await new Promise(resolve => setTimeout(resolve, 75));

        expectCompactRegexSnapshot(chat[0].extra.inChatAgents);
        expect(saveChatDebounced).toHaveBeenCalledTimes(1);
    });

    test('refreshes existing regex snapshots when an agent regex changes', async () => {
        useRegexOnlyAgent();

        const { initAgentRunner, refreshRegexSnapshotsForAgent } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        const { buildRegexScriptRefsForAgent } = await import('../public/scripts/extensions/in-chat-agents/regex-snapshot-store.js');
        initAgentRunner();
        const oldScript = {
            ...enabledAgents[0].regexScripts[0],
            replaceString: '<div class="status old">$1</div>',
        };
        const oldRevision = buildRegexScriptRefsForAgent('agent-regex-only', [oldScript])[0].revision;

        chat.push({
            name: 'Assistant',
            mes: '[STATUS|ready]',
            is_user: false,
            is_system: false,
            extra: {
                inChatAgents: {
                    activeAgentIds: ['agent-regex-only'],
                    generationType: 'normal',
                    regexScripts: [oldScript],
                    edited: false,
                },
            },
        });
        chat[0].swipes = [chat[0].mes];
        chat[0].swipe_id = 0;
        chat[0].swipe_info = [{ extra: structuredClone(chat[0].extra) }];

        enabledAgents[0].regexScripts[0].replaceString = '<div class="status new">$1</div>';

        expect(refreshRegexSnapshotsForAgent('agent-regex-only')).toBe(1);

        expectCompactRegexSnapshot(chat[0].extra.inChatAgents);
        expectCompactRegexSnapshot(chat[0].swipe_info[0].extra.inChatAgents);
        expect(chat[0].extra.inChatAgents.regexScriptRefs[0].revision).not.toBe(oldRevision);
        expect(saveChatDebounced).toHaveBeenCalledTimes(1);

        await new Promise(resolve => setTimeout(resolve, 5));
        expect(saveChat).not.toHaveBeenCalled();
        expect(reloadCurrentChat).not.toHaveBeenCalled();
        expect(saveChatDebounced).toHaveBeenCalled();
    });

    test('strips snapshots without saving or reloading when an agent becomes a companion', async () => {
        useRegexOnlyAgent();
        enabledAgents[0].execution = 'companion';

        const { initAgentRunner, refreshRegexSnapshotsForAgent } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        for (let index = 0; index < 3; index++) {
            const message = {
                name: 'Assistant',
                mes: `[STATUS|ready-${index}]`,
                is_user: false,
                is_system: false,
                extra: {
                    inChatAgents: {
                        activeAgentIds: ['agent-regex-only'],
                        generationType: 'normal',
                        regexScriptRefs: [{ agentId: 'agent-regex-only', scriptId: 'regex-script-1', revision: 'rev-old' }],
                        edited: false,
                    },
                },
            };
            message.swipes = [message.mes];
            message.swipe_id = 0;
            message.swipe_info = [{ extra: structuredClone(message.extra) }];
            chat.push(message);
        }
        const originalMessages = [...chat];

        expect(refreshRegexSnapshotsForAgent('agent-regex-only')).toBe(3);

        await new Promise(resolve => setTimeout(resolve, 5));

        expect(chat).toHaveLength(3);
        for (let index = 0; index < 3; index++) {
            expect(chat[index]).toBe(originalMessages[index]);
            expect(chat[index].mes).toBe(`[STATUS|ready-${index}]`);
            expect(chat[index].extra.inChatAgents).toBeUndefined();
            expect(chat[index].swipe_info[0].extra.inChatAgents).toBeUndefined();
        }
        expect(saveChat).not.toHaveBeenCalled();
        expect(reloadCurrentChat).not.toHaveBeenCalled();
        expect(saveChatDebounced).toHaveBeenCalled();
    });

    test('updates the rendered message block in place when refreshing snapshots', async () => {
        useRegexOnlyAgent();
        enabledAgents[0].execution = 'companion';
        const messageElement = { id: 'message-0' };
        document.querySelector = jest.fn(selector => selector === '.mes[mesid="0"]' ? messageElement : null);

        const { initAgentRunner, refreshRegexSnapshotsForAgent } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        chat.push({
            name: 'Assistant',
            mes: '[STATUS|ready]',
            is_user: false,
            is_system: false,
            extra: {
                inChatAgents: {
                    activeAgentIds: ['agent-regex-only'],
                    generationType: 'normal',
                    regexScriptRefs: [{ agentId: 'agent-regex-only', scriptId: 'regex-script-1', revision: 'rev-old' }],
                    edited: false,
                },
            },
        });

        expect(refreshRegexSnapshotsForAgent('agent-regex-only')).toBe(1);

        await new Promise(resolve => setTimeout(resolve, 5));

        expect(updateMessageBlock).toHaveBeenCalledWith(0, chat[0]);
        expect(saveChat).not.toHaveBeenCalled();
        expect(reloadCurrentChat).not.toHaveBeenCalled();
    });

    test('keeps the save and reload fallback for off-screen text mutations', async () => {
        useRegexOnlyAgent();

        const { initAgentRunner, undoPromptTransform } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        chat.push({
            name: 'Assistant',
            mes: 'Rewritten text',
            is_user: false,
            is_system: false,
            extra: {
                inChatAgentTransformHistory: [{ beforeText: 'Original text', afterText: 'Rewritten text' }],
            },
        });

        await expect(undoPromptTransform(0)).resolves.toBe(true);
        expect(chat[0].mes).toBe('Original text');

        await new Promise(resolve => setTimeout(resolve, 5));

        expect(saveChat).toHaveBeenCalledTimes(1);
        expect(reloadCurrentChat).toHaveBeenCalledTimes(1);
    });

    test('does not downgrade a pending text-mutation refresh to a bookkeeping-only one', async () => {
        useRegexOnlyAgent();

        const { initAgentRunner, refreshRegexSnapshotsForAgent, undoPromptTransform } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        chat.push({
            name: 'Assistant',
            mes: 'Rewritten text',
            is_user: false,
            is_system: false,
            extra: {
                inChatAgentTransformHistory: [{ beforeText: 'Original text', afterText: 'Rewritten text' }],
                inChatAgents: {
                    activeAgentIds: ['agent-regex-only'],
                    generationType: 'normal',
                    regexScriptRefs: [{ agentId: 'agent-regex-only', scriptId: 'regex-script-1', revision: 'rev-old' }],
                    edited: false,
                },
            },
        });

        await expect(undoPromptTransform(0)).resolves.toBe(true);
        expect(refreshRegexSnapshotsForAgent('agent-regex-only')).toBe(1);

        await new Promise(resolve => setTimeout(resolve, 5));

        expect(saveChat).toHaveBeenCalledTimes(1);
        expect(reloadCurrentChat).toHaveBeenCalledTimes(1);
    });

    test('manual regex-only agent runs snapshot and refresh the target message', async () => {
        useRegexOnlyAgent();

        const { initAgentRunner, runAgentOnMessage } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        chat.push({
            name: 'Assistant',
            mes: '[STATUS|ready]',
            is_user: false,
            is_system: false,
            extra: {},
        });

        const result = await runAgentOnMessage('agent-regex-only', 0);

        expect(result.status).toBe('skipped-empty-prompt');
        expectCompactRegexSnapshot(chat[0].extra.inChatAgents);
        expect(saveChatDebounced).toHaveBeenCalled();

        await new Promise(resolve => setTimeout(resolve, 5));
        expect(saveChat).toHaveBeenCalledTimes(1);
    });

    test('manual tracker fix runs pre-phase extract trackers', async () => {
        usePreExtractTracker();

        const { runTrackerFixOnMessage } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        chat.push({
            name: 'Assistant',
            mes: 'Fresh reply\n[STATUS|Alice|Tired|Moderate]',
            is_user: false,
            is_system: false,
            extra: {},
        });

        await runTrackerFixOnMessage(0);

        expect(chatMetadata.agent_status_data).toBe('[STATUS|Alice|Tired|Moderate]');
        expect(saveChatDebounced).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr.success).toHaveBeenCalledWith('1 post-process run', 'Trackers fixed');
    });

    test('snapshots regex-only agents on streamed tokens before final message events', async () => {
        useRegexOnlyAgent();

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
        chat.push({
            name: 'Assistant',
            mes: '',
            is_user: false,
            is_system: false,
            extra: {},
        });
        Object.assign(streamingProcessor, {
            messageId: 0,
            type: 'normal',
            isFinished: false,
            isStopped: false,
            abortController: { signal: { aborted: false } },
        });

        await eventSource.emit(eventTypes.STREAM_TOKEN_RECEIVED, '[STATUS|ready]');

        expectCompactRegexSnapshot(chat[0].extra.inChatAgents);
        expect(saveChatDebounced).not.toHaveBeenCalled();
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(saveChat).not.toHaveBeenCalled();

        Object.assign(streamingProcessor, {
            messageId: -1,
            isFinished: true,
        });
        await eventSource.emit(eventTypes.GENERATION_STOPPED);
    });

    test('keeps deferred group-style post-processing when another generation starts first', async () => {
        useAppendPostAgent();

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        document.body.dataset.generating = 'true';
        chat.push({
            name: 'Assistant One',
            mes: 'First speaker',
            is_user: false,
            is_system: false,
            extra: {},
        });
        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');

        delete document.body.dataset.generating;
        await eventSource.emit(eventTypes.GENERATION_ENDED, chat.length);

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        document.body.dataset.generating = 'true';
        chat.push({
            name: 'Assistant Two',
            mes: 'Second speaker',
            is_user: false,
            is_system: false,
            extra: {},
        });
        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 1, 'normal');

        delete document.body.dataset.generating;
        await eventSource.emit(eventTypes.GENERATION_ENDED, chat.length);
        await new Promise(resolve => setTimeout(resolve, 5));

        expect(chat[0].mes).toBe('First speaker\n[post processed]');
        expect(chat[1].mes).toBe('Second speaker\n[post processed]');
        expect(saveChatDebounced).toHaveBeenCalledTimes(2);
    });

    test('does not run post-processing for provider-stopped streaming messages', async () => {
        useAppendPostAgent();

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
        document.body.dataset.generating = 'true';
        chat.push({
            name: 'Assistant',
            mes: 'Partial provider error output',
            is_user: false,
            is_system: false,
            extra: {},
        });
        Object.assign(streamingProcessor, {
            messageId: 0,
            type: 'normal',
            isFinished: true,
            isStopped: true,
            abortController: { signal: { aborted: true } },
        });

        await eventSource.emit(eventTypes.GENERATION_STOPPED);
        delete document.body.dataset.generating;
        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');
        Object.assign(streamingProcessor, {
            messageId: -1,
            isStopped: false,
            abortController: { signal: { aborted: false } },
        });
        await eventSource.emit(eventTypes.GENERATION_ENDED, chat.length);
        await new Promise(resolve => setTimeout(resolve, 75));

        expect(chat[0].mes).toBe('Partial provider error output');
        expect(saveChatDebounced).not.toHaveBeenCalled();
    });

    test('handles non-stream mobile order where generation ends before the body flag clears', async () => {
        useAppendPostAgent();

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
        document.body.dataset.generating = 'true';
        chat.push({
            name: 'Assistant',
            mes: 'Exact mobile order',
            is_user: false,
            is_system: false,
            extra: {},
        });

        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');
        await eventSource.emit(eventTypes.CHARACTER_MESSAGE_RENDERED, 0, 'normal');
        await eventSource.emit(eventTypes.GENERATION_ENDED, chat.length);
        await new Promise(resolve => setTimeout(resolve, 75));

        expect(chat[0].mes).toBe('Exact mobile order');
        expect(saveChatDebounced).not.toHaveBeenCalled();

        delete document.body.dataset.generating;
        await new Promise(resolve => setTimeout(resolve, 75));

        expect(chat[0].mes).toBe('Exact mobile order\n[post processed]');
        expect(saveChatDebounced).toHaveBeenCalledTimes(1);
    });

    test('runs prompt-transform post-processing after mobile generation flag clears', async () => {
        usePromptTransformPostAgent();
        generateQuietPrompt.mockResolvedValue('Mobile transform rewrite');

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
        document.body.dataset.generating = 'true';
        chat.push({
            name: 'Assistant',
            mes: 'Needs rewrite',
            is_user: false,
            is_system: false,
            extra: {},
        });

        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');
        await eventSource.emit(eventTypes.CHARACTER_MESSAGE_RENDERED, 0, 'normal');
        await eventSource.emit(eventTypes.GENERATION_ENDED, chat.length);
        await new Promise(resolve => setTimeout(resolve, 75));

        expect(generateQuietPrompt).not.toHaveBeenCalled();

        delete document.body.dataset.generating;
        await waitFor(() => generateQuietPrompt.mock.calls.length === 1);
        await waitFor(() => chat[0].mes === 'Mobile transform rewrite');

        expect(chat[0].mes).toBe('Mobile transform rewrite');
        expect(saveChatDebounced).toHaveBeenCalledTimes(1);
    });

    test('persists prompt-transform history into current swipe metadata', async () => {
        usePromptTransformPostAgent();
        generateQuietPrompt.mockResolvedValue('Swipe-safe rewrite');
        const messageElement = { id: 'message-0' };
        document.querySelector = jest.fn(selector => selector === '.mes[mesid="0"]' ? messageElement : null);

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        chat.push({
            name: 'Assistant',
            mes: 'Needs rewrite',
            is_user: false,
            is_system: false,
            swipe_id: 0,
            swipes: ['Needs rewrite'],
            swipe_info: [{
                extra: {
                    token_count: 999,
                },
            }],
            extra: {
                token_count: 999,
            },
        });

        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');

        expect(chat[0].mes).toBe('Swipe-safe rewrite');
        expect(updateMessageTokenAccounting).toHaveBeenCalledWith(chat[0]);
        expect(chat[0].extra.token_count).toBe(2);
        expect(chat[0].swipe_info[0].extra.token_count).toBe(2);
        expect(updateMessageMetaBadges).toHaveBeenCalledWith(messageElement, chat[0]);
        expect(chat[0].extra.inChatAgentTransformHistory).toHaveLength(1);
        expect(chat[0].swipe_info[0].extra.inChatAgentTransformHistory).toEqual(chat[0].extra.inChatAgentTransformHistory);
        expect(saveChatDebounced).toHaveBeenCalledTimes(1);
    });

    test('shows the resolved profile model in prompt-transform running toasts', async () => {
        usePromptTransformPostAgent();
        enabledAgents[0].connectionProfile = 'profile-cc';
        enabledAgents[0].postProcess.promptTransformShowNotifications = true;
        globalSettings.promptTransformShowNotifications = true;
        connectionManagerRequestService = {
            getProfile: jest.fn(profileId => profileId === 'profile-cc'
                ? { name: 'Geechan CC', model: 'claude-3.5-sonnet' }
                : null),
            sendRequest: jest.fn(async () => ({ content: 'Profile rewrite' })),
        };

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        chat.push({
            name: 'Assistant',
            mes: 'Needs rewrite',
            is_user: false,
            is_system: false,
            extra: {},
        });

        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');

        expect(globalThis.toastr.info).toHaveBeenCalled();
        const [messageHtml, title] = globalThis.toastr.info.mock.calls[0];
        expect(title).toBe('Post Transform');
        expect(messageHtml).toContain('Model: claude-3.5-sonnet (Geechan CC)');
        expect(messageHtml).not.toContain('Model: Geechan CC');
        expect(connectionManagerRequestService.sendRequest).toHaveBeenCalledWith(
            'profile-cc',
            expect.any(Array),
            8192,
            expect.objectContaining({ extractData: true, stream: false }),
        );
    });

    test('appends global helper prefill messages to profile prompt-transform requests', async () => {
        usePromptTransformPostAgent();
        enabledAgents[0].connectionProfile = 'profile-cc';
        globalSettings.helperPrefillMessages = `[system]
Helper rule.

[user]
Helper context.`;
        connectionManagerRequestService = {
            getProfile: jest.fn(() => ({ name: 'Agent profile', model: 'helper-model' })),
            sendRequest: jest.fn(async () => ({ content: 'Profile rewrite' })),
        };

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        chat.push({
            name: 'Assistant',
            mes: 'Needs rewrite',
            is_user: false,
            is_system: false,
            extra: {},
        });

        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');

        const sentMessages = connectionManagerRequestService.sendRequest.mock.calls[0][1];
        expect(sentMessages.slice(-2)).toEqual([
            { role: 'system', content: 'Helper rule.' },
            { role: 'user', content: 'Helper context.' },
        ]);
        expect(chat[0].mes).toBe('Profile rewrite');
    });

    test('preserves configured assistant helper prefill as the final direct chat helper message', async () => {
        usePromptTransformPostAgent();
        mainApi = 'openai';
        globalSettings.helperPrefillMessages = '[assistant]\nBegin here';
        generateRaw.mockResolvedValue('Direct rewrite');

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        chat.push({
            name: 'Assistant',
            mes: 'Needs rewrite',
            is_user: false,
            is_system: false,
            extra: {},
        });

        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');

        const sentPrompt = generateRaw.mock.calls[0][0].prompt;
        expect(sentPrompt.at(-1)).toEqual({ role: 'assistant', content: 'Begin here' });
        expect(sentPrompt).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ content: 'Return only the requested transformed text.' }),
        ]));
        expect(chat[0].mes).toBe('Direct rewrite');
    });

    test('keeps text-completion profile reasoning out of post-transform replacements', async () => {
        usePromptTransformPostAgent();
        enabledAgents[0].connectionProfile = 'profile-textgen-reasoning';
        connectionManagerRequestService = {
            getProfile: jest.fn(() => ({ name: 'Textgen Reasoner', model: 'r1-textgen' })),
            sendRequest: jest.fn(async () => ({
                choices: [{
                    text: 'Visible rewrite',
                    reasoning: 'hidden choice reasoning',
                    thinking: 'hidden choice thinking',
                    message: {
                        content: [
                            { type: 'reasoning', reasoning: 'hidden content reasoning' },
                            { type: 'thinking', thinking: 'hidden content thinking' },
                            { type: 'text', text: 'Visible rewrite' },
                        ],
                        reasoning: 'hidden message reasoning',
                        reasoning_content: 'hidden message reasoning content',
                    },
                }],
            })),
        };

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        chat.push({
            name: 'Assistant',
            mes: 'Needs rewrite',
            is_user: false,
            is_system: false,
            extra: {},
        });

        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');

        expect(chat[0].mes).toBe('Visible rewrite');
        expect(chat[0].mes).not.toContain('hidden');
        expect(chat[0].extra.inChatAgentPromptRuns[0]).toEqual(expect.objectContaining({
            nextMessageText: 'Visible rewrite',
            runner: 'profile',
            profileId: 'profile-textgen-reasoning',
        }));
        expect(chat[0].extra.inChatAgentTransformHistory[0]).toEqual(expect.objectContaining({
            afterText: 'Visible rewrite',
        }));
    });

    test('keeps prompt-transform storage separate for each swipe', async () => {
        usePromptTransformPostAgent();
        generateQuietPrompt
            .mockResolvedValueOnce('First swipe rewrite')
            .mockResolvedValueOnce('Second swipe rewrite');

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        chat.push({
            name: 'Assistant',
            mes: 'First swipe original',
            is_user: false,
            is_system: false,
            send_date: '2026-04-26T00:00:00.000Z',
            gen_started: '2026-04-26T00:00:00.000Z',
            gen_finished: '2026-04-26T00:00:01.000Z',
            swipe_id: 0,
            swipes: ['First swipe original', 'Second swipe original'],
            swipe_info: [
                {
                    send_date: '2026-04-26T00:00:00.000Z',
                    gen_started: '2026-04-26T00:00:00.000Z',
                    gen_finished: '2026-04-26T00:00:01.000Z',
                    extra: {},
                },
                {
                    send_date: '2026-04-26T00:00:10.000Z',
                    gen_started: '2026-04-26T00:00:10.000Z',
                    gen_finished: '2026-04-26T00:00:11.000Z',
                    extra: {},
                },
            ],
            extra: {},
        });

        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');

        expect(chat[0].mes).toBe('First swipe rewrite');
        expect(chat[0].swipe_info[0].extra.inChatAgentTransformHistory[0].afterText).toBe('First swipe rewrite');
        expect(chat[0].swipe_info[1].extra.inChatAgentTransformHistory).toBeUndefined();

        saveVisibleMessageToSwipe(chat[0]);
        switchToSwipe(chat[0], 1);
        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');

        expect(chat[0].mes).toBe('Second swipe rewrite');
        expect(chat[0].swipe_info[0].extra.inChatAgentTransformHistory[0].afterText).toBe('First swipe rewrite');
        expect(chat[0].swipe_info[1].extra.inChatAgentTransformHistory[0].afterText).toBe('Second swipe rewrite');
        expect(chat[0].swipe_info[0].extra.inChatAgentPromptRuns[0].nextMessageText).toBe('First swipe rewrite');
        expect(chat[0].swipe_info[1].extra.inChatAgentPromptRuns[0].nextMessageText).toBe('Second swipe rewrite');
        expect(chat[0].swipe_info[0].extra.inChatAgentPromptRuns[0].outputText).toBeUndefined();

        saveVisibleMessageToSwipe(chat[0]);
        switchToSwipe(chat[0], 0);

        expect(chat[0].mes).toBe('First swipe rewrite');
        expect(chat[0].extra.inChatAgentTransformHistory[0].afterText).toBe('First swipe rewrite');
        expect(generateQuietPrompt).toHaveBeenCalledTimes(2);
        expect(saveChatDebounced).toHaveBeenCalledTimes(2);
    });

    test('scopes inherited transform history to the active swipe text', async () => {
        usePromptTransformPostAgent();
        generateQuietPrompt.mockResolvedValueOnce('Second swipe rewrite');

        const { initAgentRunner, getPromptTransformHistoryForMessage } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        chat.push({
            name: 'Assistant',
            mes: 'Second swipe original',
            is_user: false,
            is_system: false,
            send_date: '2026-04-26T00:00:10.000Z',
            gen_started: '2026-04-26T00:00:10.000Z',
            gen_finished: '2026-04-26T00:00:11.000Z',
            swipe_id: 1,
            swipes: ['First swipe rewrite', 'Second swipe original'],
            swipe_info: [
                {
                    send_date: '2026-04-26T00:00:00.000Z',
                    gen_started: '2026-04-26T00:00:00.000Z',
                    gen_finished: '2026-04-26T00:00:01.000Z',
                    extra: {
                        inChatAgentTransformHistory: [{
                            agentId: 'agent-post-transform',
                            agentName: 'Post Transform',
                            mode: 'rewrite',
                            beforeText: 'First swipe original',
                            afterText: 'First swipe rewrite',
                            timestamp: '2026-04-26T00:00:02.000Z',
                        }],
                    },
                },
                {
                    send_date: '2026-04-26T00:00:10.000Z',
                    gen_started: '2026-04-26T00:00:10.000Z',
                    gen_finished: '2026-04-26T00:00:11.000Z',
                    extra: {
                        inChatAgentTransformHistory: [{
                            agentId: 'agent-post-transform',
                            agentName: 'Post Transform',
                            mode: 'rewrite',
                            beforeText: 'First swipe original',
                            afterText: 'First swipe rewrite',
                            timestamp: '2026-04-26T00:00:02.000Z',
                        }],
                    },
                },
            ],
            extra: {
                inChatAgentTransformHistory: [{
                    agentId: 'agent-post-transform',
                    agentName: 'Post Transform',
                    mode: 'rewrite',
                    beforeText: 'First swipe original',
                    afterText: 'First swipe rewrite',
                    timestamp: '2026-04-26T00:00:02.000Z',
                }],
            },
        });

        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');

        expect(chat[0].mes).toBe('Second swipe rewrite');
        expect(chat[0].extra.inChatAgentTransformHistory).toEqual([expect.objectContaining({
            beforeText: 'Second swipe original',
            afterText: 'Second swipe rewrite',
        })]);
        expect(chat[0].swipe_info[1].extra.inChatAgentTransformHistory).toEqual(chat[0].extra.inChatAgentTransformHistory);
        expect(getPromptTransformHistoryForMessage(chat[0])).toEqual(chat[0].extra.inChatAgentTransformHistory);

        saveVisibleMessageToSwipe(chat[0]);
        switchToSwipe(chat[0], 0);

        expect(getPromptTransformHistoryForMessage(chat[0])).toEqual([expect.objectContaining({
            beforeText: 'First swipe original',
            afterText: 'First swipe rewrite',
        })]);
    });

    test('keeps in-chat regex metadata in active swipe storage for chat reloads', async () => {
        useRegexOnlyAgent();

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        chat.push({
            name: 'Assistant',
            mes: '[STATUS|ready]',
            is_user: false,
            is_system: false,
            extra: {},
        });

        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');

        expect(chat[0].swipe_info[0].extra.inChatAgents.regexScriptRefs).toHaveLength(1);
        expectCompactRegexSnapshot(chat[0].swipe_info[0].extra.inChatAgents);

        chat[0].extra = {};
        switchToSwipe(chat[0], 0);

        expectCompactRegexSnapshot(chat[0].extra.inChatAgents);
        await eventSource.emit(eventTypes.CHARACTER_MESSAGE_RENDERED, 0, 'normal');
        expectCompactRegexSnapshot(chat[0].extra.inChatAgents);
    });

    test('ignores impersonate post-processing without clearing existing regex metadata', async () => {
        useImpersonateTransformAgent();
        generateQuietPrompt.mockResolvedValue('Should not apply');

        const existingSnapshot = {
            activeAgentIds: ['agent-regex-only'],
            generationType: 'normal',
            regexScripts: [{ id: 'regex-script-1', findRegex: '/ready/g', replaceString: 'done' }],
            edited: false,
        };

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        const textarea = {
            value: 'Draft impersonation',
            dispatchEvent: jest.fn(),
        };
        document.querySelector = jest.fn(selector => selector === '#send_textarea' ? textarea : null);

        chat.push({
            name: 'Assistant',
            mes: '[STATUS|ready]',
            is_user: false,
            is_system: false,
            swipe_id: 0,
            swipes: ['[STATUS|ready]'],
            swipe_info: [{
                send_date: '2026-04-26T00:00:00.000Z',
                gen_started: '2026-04-26T00:00:00.000Z',
                gen_finished: '2026-04-26T00:00:01.000Z',
                extra: { inChatAgents: structuredClone(existingSnapshot) },
            }],
            extra: { inChatAgents: structuredClone(existingSnapshot) },
        });

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'impersonate', {}, false);
        await eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'impersonate', {}, false);
        await eventSource.emit(eventTypes.IMPERSONATE_READY, 'Draft impersonation');
        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'impersonate');
        await eventSource.emit(eventTypes.CHARACTER_MESSAGE_RENDERED, 0, 'impersonate');
        await eventSource.emit(eventTypes.GENERATION_ENDED, chat.length);
        await new Promise(resolve => setTimeout(resolve, 75));

        expect(chat[0].mes).toBe('[STATUS|ready]');
        expect(textarea.value).toBe('Draft impersonation');
        expect(textarea.dispatchEvent).not.toHaveBeenCalled();
        expect(chat[0].extra.inChatAgents).toEqual(existingSnapshot);
        expect(chat[0].swipe_info[0].extra.inChatAgents).toEqual(existingSnapshot);
        expect(generateQuietPrompt).not.toHaveBeenCalled();
        expect(saveChatDebounced).not.toHaveBeenCalled();
    });

    test('rewrites generated impersonation text when prompt transform opts in', async () => {
        useImpersonateTransformAgent({ runOnImpersonate: true });
        generateQuietPrompt.mockResolvedValue('<assistant_response>Polished impersonation</assistant_response>');

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        const textarea = {
            value: 'Draft impersonation',
            dispatchEvent: jest.fn(),
        };
        document.querySelector = jest.fn(selector => selector === '#send_textarea' ? textarea : null);

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'impersonate', {}, false);
        await eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'impersonate', {}, false);
        await eventSource.emit(eventTypes.IMPERSONATE_READY, 'Draft impersonation');

        expect(generateQuietPrompt).toHaveBeenCalledTimes(1);
        expect(generateQuietPrompt.mock.calls[0][0].quietPrompt).toContain('generated impersonation text');
        expect(textarea.value).toBe('Polished impersonation');
        expect(textarea.dispatchEvent).toHaveBeenCalledTimes(1);
        expect(textarea.dispatchEvent.mock.calls[0][0].type).toBe('input');
        expect(saveChatDebounced).not.toHaveBeenCalled();
    });

    test('uses direct user-final chat helper for no-profile impersonation prompt transforms', async () => {
        useImpersonateTransformAgent({ runOnImpersonate: true });
        mainApi = 'openai';
        generateRaw.mockResolvedValue('<assistant_response>Polished impersonation</assistant_response>');

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        const textarea = {
            value: 'Draft impersonation',
            dispatchEvent: jest.fn(),
        };
        document.querySelector = jest.fn(selector => selector === '#send_textarea' ? textarea : null);
        connectionManagerRequestService = null;

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'impersonate', {}, false);
        await eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'impersonate', {}, false);
        await eventSource.emit(eventTypes.IMPERSONATE_READY, 'Draft impersonation');

        expect(generateQuietPrompt).not.toHaveBeenCalled();
        expect(generateRaw).toHaveBeenCalledTimes(1);
        expect(generateRaw).toHaveBeenCalledWith(expect.objectContaining({
            api: 'openai',
            instructOverride: true,
            responseLength: 8192,
            trimNames: false,
            cacheScope: 'auxiliary',
        }));

        const sentPrompt = generateRaw.mock.calls[0][0].prompt;
        expect(sentPrompt).toEqual([
            expect.objectContaining({ role: 'system' }),
            expect.objectContaining({ role: 'user' }),
        ]);
        expect(sentPrompt.at(-1).role).toBe('user');
        expect(sentPrompt[0].content).toContain('generated impersonation text');
        expect(sentPrompt[1].content).toContain('Draft impersonation');
        expect(textarea.value).toBe('Polished impersonation');
        expect(textarea.dispatchEvent).toHaveBeenCalledTimes(1);
        expect(saveChatDebounced).not.toHaveBeenCalled();
    });

    test('runs saved bundled Prose Polisher for guided impersonate output', async () => {
        useSavedProsePolisherWithoutImpersonateFlag();
        generateQuietPrompt.mockResolvedValue('<assistant_response>Polished guided impersonation</assistant_response>');

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        const { guidedImpersonate } = await import('../public/scripts/extensions/guided-generations/scripts/guidedImpersonate.js');
        initAgentRunner();

        const textarea = new globalThis.HTMLTextAreaElement();
        textarea.value = 'Please write this in first person.';
        textarea.dispatchEvent = jest.fn();
        document.getElementById = jest.fn(id => id === 'send_textarea' ? textarea : null);
        document.querySelector = jest.fn(selector => selector === '#send_textarea' ? textarea : null);
        executeSlashCommandsWithOptions.mockImplementation(async (script) => {
            expect(script).toContain('/impersonate await=true');
            textarea.value = 'Draft guided impersonation';
            await eventSource.emit(eventTypes.IMPERSONATE_READY, 'Draft guided impersonation');
        });

        await guidedImpersonate();

        expect(generateQuietPrompt).toHaveBeenCalledTimes(1);
        expect(generateQuietPrompt.mock.calls[0][0].quietPrompt).toContain('generated impersonation text');
        expect(textarea.value).toBe('Polished guided impersonation');
        expect(textarea.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'input' }));
        expect(saveChatDebounced).not.toHaveBeenCalled();
    });

    test('applies mobile deferred post-processing once after the body generating flag clears', async () => {
        useAppendPostAgent();

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
        document.body.dataset.generating = 'true';
        await eventSource.emit(eventTypes.GENERATION_ENDED, chat.length);

        chat.push({
            name: 'Assistant',
            mes: 'Mobile reply',
            is_user: false,
            is_system: false,
            extra: {},
        });

        await eventSource.emit(eventTypes.CHARACTER_MESSAGE_RENDERED, 0, 'normal');
        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');
        await new Promise(resolve => setTimeout(resolve, 5));

        expect(chat[0].mes).toBe('Mobile reply');
        expect(saveChatDebounced).not.toHaveBeenCalled();

        delete document.body.dataset.generating;
        await new Promise(resolve => setTimeout(resolve, 75));

        expect(chat[0].mes).toBe('Mobile reply\n[post processed]');
        expect(saveChatDebounced).toHaveBeenCalledTimes(1);

        await eventSource.emit(eventTypes.CHARACTER_MESSAGE_RENDERED, 0, 'normal');
        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');
        await new Promise(resolve => setTimeout(resolve, 75));

        expect(chat[0].mes).toBe('Mobile reply\n[post processed]');
        expect(saveChatDebounced).toHaveBeenCalledTimes(1);
    });

    test('does not rerun mobile post-processing after render replaces a processed message object', async () => {
        useAppendPostAgent();

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
        document.body.dataset.generating = 'true';
        await eventSource.emit(eventTypes.GENERATION_ENDED, chat.length);
        chat.push({
            name: 'Assistant',
            mes: 'Mobile processed once',
            is_user: false,
            is_system: false,
            send_date: '2026-04-26T00:00:00.000Z',
            gen_started: '2026-04-26T00:00:01.000Z',
            gen_finished: '2026-04-26T00:00:02.000Z',
            swipe_id: 0,
            swipes: ['Mobile processed once'],
            swipe_info: [{ extra: {} }],
            extra: {},
        });

        await eventSource.emit(eventTypes.CHARACTER_MESSAGE_RENDERED, 0, 'normal');
        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');
        await new Promise(resolve => setTimeout(resolve, 5));

        expect(chat[0].mes).toBe('Mobile processed once');
        expect(saveChatDebounced).not.toHaveBeenCalled();

        delete document.body.dataset.generating;
        await new Promise(resolve => setTimeout(resolve, 75));

        expect(chat[0].mes).toBe('Mobile processed once\n[post processed]');
        expect(saveChatDebounced).toHaveBeenCalledTimes(1);

        chat[0] = {
            name: 'Assistant',
            mes: 'Mobile processed once\n[post processed]',
            is_user: false,
            is_system: false,
            swipe_id: 0,
            swipes: ['Mobile processed once\n[post processed]'],
            swipe_info: [{ extra: {} }],
            extra: {},
        };

        await eventSource.emit(eventTypes.CHARACTER_MESSAGE_RENDERED, 0, 'normal');
        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');

        expect(chat[0].mes).toBe('Mobile processed once\n[post processed]');
        expect(saveChatDebounced).toHaveBeenCalledTimes(1);
    });

    test('polls the final assistant message after generation end when mobile render events are missed', async () => {
        useAppendPostAgent();

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
        document.body.dataset.generating = 'true';
        await eventSource.emit(eventTypes.GENERATION_ENDED, chat.length);
        await new Promise(resolve => setTimeout(resolve, 75));

        expect(saveChatDebounced).not.toHaveBeenCalled();

        chat.push({
            name: 'Assistant',
            mes: 'Late mobile reply',
            is_user: false,
            is_system: false,
            extra: {},
        });
        delete document.body.dataset.generating;
        await new Promise(resolve => setTimeout(resolve, 75));

        expect(chat[0].mes).toBe('Late mobile reply\n[post processed]');
        expect(saveChatDebounced).toHaveBeenCalledTimes(1);

        await eventSource.emit(eventTypes.CHARACTER_MESSAGE_RENDERED, 0, 'normal');
        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');
        await new Promise(resolve => setTimeout(resolve, 75));

        expect(chat[0].mes).toBe('Late mobile reply\n[post processed]');
        expect(saveChatDebounced).toHaveBeenCalledTimes(1);
    });

    test('does not flush stale mobile post-processing after switching chats', async () => {
        useAppendPostAgent();

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        currentChatId = 'chat-a';
        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
        document.body.dataset.generating = 'true';
        await eventSource.emit(eventTypes.GENERATION_ENDED, chat.length);

        currentChatId = 'chat-b';
        chat.splice(0, chat.length, {
            name: 'Assistant',
            mes: 'Existing greeting',
            is_user: false,
            is_system: false,
            extra: {},
        });
        delete document.body.dataset.generating;
        await eventSource.emit(eventTypes.CHAT_CHANGED, currentChatId);
        await new Promise(resolve => setTimeout(resolve, 75));

        expect(chat[0].mes).toBe('Existing greeting');
        expect(saveChatDebounced).not.toHaveBeenCalled();
    });

    test('polls missed mobile render events using the generation-start snapshot', async () => {
        useAppendPostAgent();

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        document.body.dataset.generating = 'true';
        await eventSource.emit(eventTypes.GENERATION_ENDED, chat.length);
        await new Promise(resolve => setTimeout(resolve, 75));

        chat.push({
            name: 'Assistant',
            mes: 'Late reply without after commands',
            is_user: false,
            is_system: false,
            extra: {},
        });
        delete document.body.dataset.generating;
        await new Promise(resolve => setTimeout(resolve, 75));

        expect(chat[0].mes).toBe('Late reply without after commands\n[post processed]');
        expect(saveChatDebounced).toHaveBeenCalledTimes(1);
    });

    test('recovers post-processing for regenerated assistant replacements', async () => {
        useAppendPostAgent();

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        chat.push(
            {
                name: 'User',
                mes: 'Try again',
                is_user: true,
                is_system: false,
                extra: {},
            },
            {
                name: 'Assistant',
                mes: 'Old reply',
                is_user: false,
                is_system: false,
                gen_finished: '2026-04-26T00:00:00.000Z',
                extra: {},
            },
        );

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'regenerate', {}, false);
        chat.pop();
        await eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'regenerate', {}, false);
        chat.push({
            name: 'Assistant',
            mes: 'Regenerated reply',
            is_user: false,
            is_system: false,
            gen_finished: '2026-04-26T00:00:05.000Z',
            extra: {},
        });

        await eventSource.emit(eventTypes.GENERATION_ENDED, chat.length);
        await new Promise(resolve => setTimeout(resolve, 5));

        expect(chat[1].mes).toBe('Regenerated reply\n[post processed]');
        expect(saveChatDebounced).toHaveBeenCalledTimes(1);
    });

    test('recovers mobile post-processing when generation ended event is missed', async () => {
        jest.useFakeTimers();
        useAppendPostAgent();

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
        document.body.dataset.generating = 'true';
        chat.push({
            name: 'Assistant',
            mes: 'Missed end mobile reply',
            is_user: false,
            is_system: false,
            extra: {},
        });

        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');
        delete document.body.dataset.generating;
        await jest.advanceTimersByTimeAsync(250);
        await jest.runOnlyPendingTimersAsync();

        expect(chat[0].mes).toBe('Missed end mobile reply\n[post processed]');
        expect(saveChatDebounced).toHaveBeenCalledTimes(1);
        jest.useRealTimers();
    });

    test('recovers mobile post-processing when generation flag stays stuck after final message', async () => {
        jest.useFakeTimers();
        useAppendPostAgent();

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
        document.body.dataset.generating = 'true';
        chat.push({
            name: 'Assistant',
            mes: 'Stuck flag mobile reply',
            is_user: false,
            is_system: false,
            gen_finished: '2026-04-26T00:00:00.000Z',
            extra: {},
        });

        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');
        await jest.advanceTimersByTimeAsync(250);
        await jest.runOnlyPendingTimersAsync();

        expect(document.body.dataset.generating).toBe('true');
        expect(chat[0].mes).toBe('Stuck flag mobile reply\n[post processed]');
        expect(saveChatDebounced).toHaveBeenCalledTimes(1);
        jest.useRealTimers();
    });

    test('keeps deferred mobile post-processing when render replaces the message object', async () => {
        useAppendPostAgent();

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
        document.body.dataset.generating = 'true';
        chat.push({
            name: 'Assistant',
            mes: 'Replaced mobile reply',
            is_user: false,
            is_system: false,
            gen_finished: '2026-04-26T00:00:00.000Z',
            extra: {},
        });

        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 0, 'normal');
        chat[0] = {
            name: 'Assistant',
            mes: 'Replaced mobile reply',
            is_user: false,
            is_system: false,
            gen_finished: '2026-04-26T00:00:00.000Z',
            extra: {},
        };

        delete document.body.dataset.generating;
        await eventSource.emit(eventTypes.GENERATION_ENDED, chat.length);
        await new Promise(resolve => setTimeout(resolve, 75));

        expect(chat[0].mes).toBe('Replaced mobile reply\n[post processed]');
        expect(saveChatDebounced).toHaveBeenCalledTimes(1);
    });

    test('recovers missed mobile post-processing after the fallback window expires', async () => {
        jest.useFakeTimers();
        useAppendPostAgent();

        const { initAgentRunner } = await import('../public/scripts/extensions/in-chat-agents/agent-runner.js');
        initAgentRunner();

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
        document.body.dataset.generating = 'true';
        await eventSource.emit(eventTypes.GENERATION_ENDED, chat.length);
        await jest.advanceTimersByTimeAsync(31000);

        expect(saveChatDebounced).not.toHaveBeenCalled();

        chat.push({
            name: 'Assistant',
            mes: 'Very late iOS reply',
            is_user: false,
            is_system: false,
            extra: {},
        });
        delete document.body.dataset.generating;
        emitDocumentEvent('visibilitychange');
        await jest.runOnlyPendingTimersAsync();
        await jest.runOnlyPendingTimersAsync();

        expect(chat[0].mes).toBe('Very late iOS reply\n[post processed]');
        expect(saveChatDebounced).toHaveBeenCalledTimes(1);

        emitDocumentEvent('visibilitychange');
        await jest.runOnlyPendingTimersAsync();
        await jest.runOnlyPendingTimersAsync();

        expect(chat[0].mes).toBe('Very late iOS reply\n[post processed]');
        expect(saveChatDebounced).toHaveBeenCalledTimes(1);
        jest.useRealTimers();
    });
});
