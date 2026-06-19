/* eslint-disable playwright/no-duplicate-hooks */
import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';

let summarizeChatInterceptChange;
let warnSpy;

beforeAll(async () => {
    jest.resetModules();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
        extension_settings: {},
        renderExtensionTemplateAsync: jest.fn(async () => ''),
        getContext: jest.fn(() => ({})),
    }));

    await jest.unstable_mockModule('../public/lib.js', () => ({
        DiffMatchPatch: class DiffMatchPatch {
            diff_main(beforeText, afterText) {
                return [[0, beforeText], [1, afterText]];
            }

            diff_cleanupSemantic() {}
        },
    }));

    await jest.unstable_mockModule('../public/scripts/popup.js', () => ({
        Popup: class Popup {
            async show() {
                return null;
            }
        },
        POPUP_TYPE: { CONFIRM: 'confirm', TEXT: 'text' },
        POPUP_RESULT: { AFFIRMATIVE: 'affirmative' },
    }));

    await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
        download: jest.fn(),
        escapeHtml: jest.fn(value => String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;')),
        escapeRegex: jest.fn(value => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        getSortableDelay: jest.fn(() => 0),
        uuidv4: jest.fn(() => 'test-uuid'),
    }));

    await jest.unstable_mockModule('../public/script.js', () => ({
        CLIENT_VERSION: 'test',
        activateSendButtons: jest.fn(),
        chat: [],
        deactivateSendButtons: jest.fn(),
        getRequestHeaders: jest.fn(() => ({})),
        generateQuietPrompt: jest.fn(),
        is_send_press: false,
        normalizeContentText: jest.fn(value => String(value ?? '')),
        saveSettingsDebounced: jest.fn(),
        substituteParams: jest.fn(value => String(value ?? '')),
    }));

    await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
        is_group_generating: false,
    }));

    await jest.unstable_mockModule('../public/scripts/events.js', () => ({
        eventSource: { on: jest.fn() },
        event_types: {},
    }));

    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({
        AGENT_CATEGORIES: {},
        AGENT_SUBCATEGORIES: {},
        DEFAULT_AGENT_MAX_TOKENS: 8192,
        MAX_AGENT_MAX_TOKENS: 64000,
        LEGACY_AGENT_MAX_TOKENS: 2048,
        areAgentsGloballyEnabled: jest.fn(() => true),
        getAgents: jest.fn(() => []),
        getEnabledAgents: jest.fn(() => []),
        getAgentById: jest.fn(() => null),
        getAgentRegexScripts: jest.fn(() => []),
        getCompanionConfig: jest.fn(() => ({
            trigger: 'auto',
            displayMode: 'card',
            format: 'markdown',
            contextMessages: 10,
            includeCharacterCard: false,
            includePersona: false,
            includeWorldInfo: false,
            includeHistory: false,
            historyDepth: 3,
            feedback: { enabled: false, depth: 1 },
            batch: false,
            maxTokens: 2048,
        })),
        loadAgents: jest.fn(),
        saveAgent: jest.fn(async () => {}),
        deleteAgent: jest.fn(async () => {}),
        createDefaultAgent: jest.fn(() => ({
            id: 'agent-id',
            name: 'Agent',
            prompt: '',
            injection: {},
            preProcess: {},
            postProcess: {},
            conditions: {},
        })),
        importAgents: jest.fn(() => []),
        exportAllAgents: jest.fn(() => []),
        exportAgent: jest.fn(() => null),
        getGlobalSettings: jest.fn(() => ({})),
        initializeScopedAgentEnableState: jest.fn(() => false),
        isAgentEnabledForCurrentScope: jest.fn(() => false),
        normalizeAgentCategory: jest.fn(value => value),
        getAgentChatScopeLabel: jest.fn(() => 'Individual chat'),
        getPromptTransformMode: jest.fn(() => 'rewrite'),
        isTrackerFixAgent: jest.fn(() => false),
        agentMatchesListTab: jest.fn(() => true),
        applyCompanionContextAccessDefaults: jest.fn(() => false),
        applyCompanionPanelDisplayDefault: jest.fn(() => false),
        applyTrackerCompanionAutoLoopDefaults: jest.fn(() => false),
        convertAgentExecution: jest.fn(() => false),
        resolveCompanionConnectionProfile: jest.fn(value => value ?? ''),
        isCompanionAgent: jest.fn(agent => agent?.execution === 'companion' || agent?.category === 'companion'),
        isToolAgent: jest.fn(agent => agent?.category === 'tool'),
        isPathfinderSubmoduleEnabled: jest.fn(() => false),
        findTemplateForAgentSnapshot: jest.fn(() => null),
        getBundledAgentLatestTemplatePlan: jest.fn(() => ({ updates: [], redundantIds: [] })),
        getRedundantBundledAgentDuplicateIds: jest.fn(() => []),
        reconcileScopedEnabledAgentIdsFromLegacyFlags: jest.fn(() => false),
        resolveConnectionProfile: jest.fn(value => value ?? ''),
        setAgentEnabledForCurrentScope: jest.fn(),
        setGlobalSettings: jest.fn(),
        setPathfinderSubmoduleEnabled: jest.fn(),
        getGroups: jest.fn(() => []),
        getCustomGroups: jest.fn(() => []),
        loadBuiltinGroups: jest.fn(),
        loadCustomGroups: jest.fn(),
        saveGroup: jest.fn(async () => {}),
        deleteGroup: jest.fn(async () => {}),
        createDefaultGroup: jest.fn(() => ({ id: 'group-id', name: 'Group' })),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-runner.js', () => ({
        cancelAgentGeneration: jest.fn(),
        buildPromptDynamicMacros: jest.fn(() => ({})),
        deactivatePathfinderRuntime: jest.fn(),
        initAgentRunner: jest.fn(),
        isAgentGenerationActive: jest.fn(() => false),
        onAgentGenerationStateChanged: jest.fn(),
        getPreGenerationInterceptHistoryForMessage: jest.fn(() => []),
        getPromptTransformHistoryForMessage: jest.fn(() => []),
        refreshRegexSnapshotsForAgent: jest.fn(() => 0),
        runAgentOnMessage: jest.fn(),
        runTrackerFixOnMessage: jest.fn(),
        syncToolAgentRegistrations: jest.fn(),
        undoPromptTransform: jest.fn(async () => false),
        redoPromptTransform: jest.fn(async () => false),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/regex-scripts.js', () => ({
        AGENT_REGEX_PLACEMENT: {
            AI_OUTPUT: 'ai-output',
            USER_INPUT: 'user-input',
            SLASH_COMMAND: 'slash-command',
            WORLD_INFO: 'world-info',
            REASONING: 'reasoning',
        },
        AGENT_REGEX_SUBSTITUTE: {
            RAW: 'raw',
            ESCAPED: 'escaped',
        },
        createDefaultRegexScript: jest.fn(() => ({})),
        normalizeRegexScript: jest.fn(value => value),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder-init.js', () => ({
        initPathfinder: jest.fn(),
        teardownPathfinder: jest.fn(),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder-settings-ui.js', () => ({
        openPathfinderSettings: jest.fn(),
        isPathfinderAgent: jest.fn(() => false),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/tool-definitions.js', () => ({
        getPathfinderToolDefinitions: jest.fn(() => []),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js', () => ({
        collectRecentCompanionResults: jest.fn(() => []),
        initCompanionRunner: jest.fn(),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-ui.js', () => ({
        initCompanionCardUi: jest.fn(),
        updateCompanionButtonVisibility: jest.fn(),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-dashboard.js', () => ({
        configureCompanionDashboard: jest.fn(),
        initCompanionWandMenuItem: jest.fn(),
        openCompanionDashboard: jest.fn(),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-panel.js', () => ({
        configureCompanionPanel: jest.fn(),
        initCompanionPanel: jest.fn(),
        openCompanionPanel: jest.fn(),
        updateCompanionPanelHandleVisibility: jest.fn(),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/llm-utils.js', () => ({
        buildFallbackPromptText: jest.fn(() => ''),
        extractProfileResponseText: jest.fn(() => ''),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/profile-utils.js', () => ({
        buildConnectionProfileNameMap: jest.fn(() => new Map()),
        getConnectionManagerRequestService: jest.fn(() => null),
        populateConnectionProfileSelect: jest.fn(),
    }));

    ({ summarizeChatInterceptChange } = await import('../public/scripts/extensions/in-chat-agents/index.js'));
});

afterAll(() => {
    warnSpy?.mockRestore();
});

describe('summarizeChatInterceptChange', () => {
    test('reports a wrapped system message as an added change', () => {
        const before = JSON.stringify([{ role: 'user', content: 'Original prompt' }], null, 2);
        const after = JSON.stringify([
            { role: 'user', content: 'Original prompt' },
            { role: 'system', content: 'Follow the extra instruction.' },
        ], null, 2);

        const result = summarizeChatInterceptChange(before, after);

        expect(result).toEqual({
            ok: true,
            changes: [expect.objectContaining({
                changeKind: 'added',
                role: 'system',
                beforeIndex: null,
                afterIndex: 1,
                afterContent: 'Follow the extra instruction.',
            })],
        });
    });

    test('reports an in-place replacement as a modified change', () => {
        const before = JSON.stringify([
            { role: 'system', content: 'Keep tone warm.' },
            { role: 'user', content: 'Original prompt' },
        ], null, 2);
        const after = JSON.stringify([
            { role: 'system', content: 'Keep tone warm.' },
            { role: 'user', content: 'Rewritten prompt' },
        ], null, 2);

        const result = summarizeChatInterceptChange(before, after);

        expect(result).toEqual({
            ok: true,
            changes: [expect.objectContaining({
                changeKind: 'modified',
                role: 'user',
                beforeIndex: 1,
                afterIndex: 1,
                beforeContent: 'Original prompt',
                afterContent: 'Rewritten prompt',
            })],
        });
    });

    test('reports malformed JSON as a parse error', () => {
        expect(summarizeChatInterceptChange('{not-json', '[]')).toEqual({
            ok: false,
            reason: 'parse-error',
        });
    });
});
