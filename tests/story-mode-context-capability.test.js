/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importStoryModeRuntime } from './util/story-mode-harness.js';

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
    jest.restoreAllMocks();
});

function buildContextExtraMocks() {
    const emptyFn = () => {};
    return {
        'scripts/loader.js': { hideLoader: emptyFn, showLoader: emptyFn },
        'scripts/macros.js': base => ({
            ...base,
            MacrosParser: { registerMacro: jest.fn(), unregisterMacro: jest.fn() },
        }),
        'scripts/scrapers.js': base => ({
            ...base,
            ScraperManager: { registerDataBankScraper: jest.fn() },
        }),
        'scripts/slash-commands.js': base => ({
            ...base,
            executeSlashCommands: jest.fn(),
            registerSlashCommand: jest.fn(),
        }),
        'scripts/variables.js': {
            addGlobalVariable: jest.fn(), addLocalVariable: jest.fn(),
            decrementGlobalVariable: jest.fn(), decrementLocalVariable: jest.fn(),
            deleteGlobalVariable: jest.fn(), deleteLocalVariable: jest.fn(),
            existsGlobalVariable: jest.fn(), existsLocalVariable: jest.fn(),
            getGlobalVariable: jest.fn(), getLocalVariable: jest.fn(),
            incrementGlobalVariable: jest.fn(), incrementLocalVariable: jest.fn(),
            setGlobalVariable: jest.fn(), setLocalVariable: jest.fn(),
        },
        'scripts/world-info.js': base => ({
            ...base,
            charUpdateAddAuxWorld: jest.fn(), convertCharacterBook: jest.fn(),
            createNewWorldInfo: jest.fn(), createWorldInfoEntry: jest.fn(),
            getWorldInfoPrompt: jest.fn(), loadWorldInfo: jest.fn(),
            reloadEditor: jest.fn(), saveWorldInfo: jest.fn(),
            syncWIOriginalDataEntry: jest.fn(), updateWorldInfoList: jest.fn(),
            world_info: {}, world_names: [],
        }),
        'scripts/custom-request.js': { ChatCompletionService: class {}, TextCompletionService: class {} },
        'scripts/extensions/shared.js': { ConnectionManagerRequestService: class {} },
        'scripts/reasoning.js': base => ({
            ...base,
            parseReasoningFromString: jest.fn(),
            getReasoningTemplateByName: jest.fn(),
        }),
        'scripts/extensions.js': base => ({
            ...base,
            getExtensionManifest: jest.fn(),
            ModuleWorkerWrapper: class {},
            openThirdPartyExtensionMenu: jest.fn(),
            renderExtensionTemplate: jest.fn(),
            renderExtensionTemplateAsync: jest.fn(),
            setExtensionContextGetter: jest.fn(),
            UNSET_VALUE: Symbol('unset'),
            writeExtensionField: jest.fn(),
            writeExtensionFieldBulk: jest.fn(),
        }),
        'scripts/group-chats.js': base => ({
            ...base,
            getSelectedGroupSpeakerAvatar: jest.fn(),
            groupTurnRoutingApi: {},
            openGroupChat: jest.fn(),
            setSelectedGroupSpeakerAvatar: jest.fn(),
            unshallowGroupMembers: jest.fn(),
        }),
        'scripts/i18n.js': base => ({
            ...base,
            addLocaleData: jest.fn(),
        }),
        'scripts/RossAscends-mods.js': base => ({
            ...base,
            shouldSendOnEnter: jest.fn(() => false),
        }),
        'scripts/tool-calling.js': base => ({
            ToolManager: {
                ...base.ToolManager,
                registerFunctionTool: jest.fn(),
                unregisterFunctionTool: jest.fn(),
                isToolCallingSupported: jest.fn(() => false),
                canPerformToolCalls: jest.fn(() => false),
            },
        }),
    };
}

describe('st-context request controls capability and OpenAI local prompt budget', () => {
    test('advertises generationSupportsRequestControls on the real extension context object', async () => {
        loaded = await importStoryModeRuntime({
            keepReal: ['scripts/openai.js', 'scripts/st-context.js'],
            extraMocks: buildContextExtraMocks(),
        });

        const { getContext } = await import('../public/scripts/st-context.js');
        expect(getContext().generationSupportsRequestControls).toBe(true);
    });

    test('prepareOpenAIMessages reserves a local prompt budget without mutating the OpenAI preset', async () => {
        loaded = await importStoryModeRuntime({
            keepReal: ['scripts/openai.js', 'scripts/st-context.js'],
            extraMocks: buildContextExtraMocks(),
            promptManagerMocks: {
                registerPromptManagerMigration: jest.fn(),
                chatCompletionDefaultPrompts: { prompts: [] },
                INJECTION_POSITION: { RELATIVE: 0, ABSOLUTE: 1 },
                Prompt: class Prompt { constructor(data = {}) { Object.assign(this, data); } },
                PromptManager: class PromptManager {
                    serviceSettings = { openai_max_context: 32768, openai_max_tokens: 8192 };
                    tokenHandler = { counts: false };
                    messages = { collection: [] };
                    init(_cfg, settings) {
                        if (settings) this.serviceSettings = settings;
                    }
                    setup() {}
                    setChatCompletion = jest.fn();
                    preparePrompt = jest.fn(async () => ({ collection: [] }));
                    log() {}
                    render = jest.fn();
                    getPromptCollection = jest.fn(() => ({ collection: [] }));
                    getPromptOrderForCharacter = jest.fn(() => []);
                    getPromptById = jest.fn(() => null);
                    isPromptDisabledForActiveCharacter = jest.fn(() => false);
                },
                promptManagerDefaultPromptOrders: [],
            },
        });

        const openai = await import('../public/scripts/openai.js');
        openai.oai_settings.openai_max_context = 32768;
        openai.oai_settings.openai_max_tokens = 8192;
        openai.setupChatCompletionPromptManager(openai.oai_settings);
        const setTokenBudgetSpy = jest.spyOn(openai.ChatCompletion.prototype, 'setTokenBudget');

        await openai.prepareOpenAIMessages({ messages: [], responseLength: 1024 }, false);

        expect(setTokenBudgetSpy).toHaveBeenCalledWith(32768, 1024);
        expect(openai.promptManager.serviceSettings.openai_max_tokens).toBe(8192);
    });
});
