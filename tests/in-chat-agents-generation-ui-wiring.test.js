/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importScriptModule } from './util/script-harness.js';
import { buildAgentListModel } from '../public/scripts/extensions/in-chat-agents/ui/agent-list-model.js';
import { getAgentEditorVisibility } from '../public/scripts/extensions/in-chat-agents/ui/agent-editor-model.js';
import { COMPANION_RESULTS_EXTRA_KEY } from '../public/scripts/extensions/in-chat-agents/companion/companion-shared.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = rel => fileURLToPath(new URL(`../public/${rel}`, import.meta.url));
const publicIndexSource = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const extensionStyleSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'in-chat-agents', 'style.css'), 'utf8');
// Deferred to Batch 6 (`tabs-harness.js`) where `sillybunny-tabs.js` mounts panels directly.
const tabsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-tabs.js'), 'utf8');

const LEVEL_UP_TEMPLATE_ID = 'tpl-level-up-companion';
const USER_BASED_STATS_TEMPLATE_ID = 'tpl-user-based-stats-generator';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function makeAgent(overrides = {}) {
    return {
        id: 'agent-1',
        name: 'Test Agent',
        description: 'Description',
        category: 'custom',
        subcategory: '',
        execution: 'inline',
        phase: 'post',
        enabled: true,
        order: 10,
        prompt: 'Do something useful.',
        connectionProfile: '',
        conditions: {
            generationTypes: ['normal', 'swipe', 'regenerate', 'continue'],
            triggerProbability: 100,
            triggerKeywords: [],
            companionOutputTargetAgentIds: [],
        },
        injection: { position: 1, depth: 0, role: 0, order: 100 },
        postProcess: {
            enabled: false,
            type: 'extract',
            promptTransformEnabled: false,
            extractPattern: '',
            extractVariable: '',
            appendText: '',
        },
        regexScripts: [],
        settings: {},
        ...overrides,
    };
}

function makeCompanion(overrides = {}) {
    return makeAgent({
        id: 'comp-1',
        name: 'Companion One',
        category: 'companion',
        execution: 'companion',
        phase: 'post',
        companion: {
            trigger: 'auto',
            displayMode: 'panel',
            format: 'markdown',
            maxTokens: 400,
            contextMessages: 6,
            minContextTokens: 0,
            historyDepth: 3,
            includeInChatHistory: false,
            chatHistoryDepth: 2,
            includeAllChatHistory: false,
            keepInChatHistoryWhenHostHidden: false,
            batch: false,
            batchAgentIds: [],
            sendContextToCompanions: false,
            contextRecipientAgentIds: [],
            dependencies: [],
            waitForDependencies: false,
            feedback: { enabled: false, depth: 2 },
        },
        ...overrides,
    });
}

const activeCleanups = [];

afterEach(() => {
    while (activeCleanups.length) {
        activeCleanups.pop()();
    }
    jest.restoreAllMocks();
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    delete globalThis.SillyBunnyShell;
});

/**
 * Boots the real `public/script.js`, real `in-chat-agents/index.js`, real `agent-store.js`,
 * real `agent-runner.js`, real `ui/agent-list.js`, real `ui/agent-editor.js`,
 * real `ui/agent-editor-dialogs.js`, real `ui/agent-editor-controller.js`,
 * real `companion/companion-ui.js`, and real `settings-controls.js` in jsdom.
 */
async function bootInChatAgents({
    agents = [],
    templates = [],
    globalSettings = {},
    chat = [],
    selectedGroup = null,
    isGroupGenerating = false,
    onPopupShow = null,
    generateQuietPrompt = null,
    runTrackerCompanionsOnMessage = null,
    runCompanionsOnMessage = null,
    getCompanionResults = null,
    updateCompanionResult = null,
    syncCompanionChatHistoryConfig = null,
    companionSharedKeepReal = false,
    domExtra = '',
    chatDomExtra = '',
} = {}) {
    const popupRecords = [];
    let activePopupHandler = onPopupShow;

    class TestPopup {
        constructor(content, type, inputValue, options = {}) {
            this.rawContent = content;
            this.content = content?.jquery ? content.get(0) : content;
            this.type = type;
            this.inputValue = inputValue;
            this.options = options;
            this.dlg = document.createElement('dialog');
            this.dlg.open = true;
            this.result = null;
        }
        async show() {
            const record = { popup: this, options: this.options };
            popupRecords.push(record);
            if (typeof activePopupHandler === 'function') {
                const outcome = await activePopupHandler(this, this.options);
                this.result = outcome;
                this.dlg.open = false;
                return outcome;
            }
            this.result = 1;
            this.dlg.open = false;
            return 1;
        }
        completeCancelled() {
            this.result = null;
            this.dlg.open = false;
        }
    }

    const renderExtensionTemplateAsync = jest.fn(async (_moduleName, templateName) => {
        if (templateName === 'bulk-edit') return '<div id="ica--bulk-edit-host"></div>';
        return '<div></div>';
    });

    const savedSettingsPayloads = [];
    const savedAgentRequests = [];
    const fetchMock = jest.fn(async (url, init = {}) => {
        const strUrl = String(url);
        if (strUrl === '/api/settings/get') {
            return { ok: true, status: 200, json: async () => ({ inChatAgents: structuredClone(agents) }) };
        }
        if (strUrl.includes('templates/index.json')) {
            return {
                ok: true,
                status: 200,
                json: async () => structuredClone(templates),
            };
        }
        for (const tpl of templates) {
            if (strUrl.endsWith(`${tpl.id}.json`)) {
                return { ok: true, status: 200, json: async () => structuredClone(tpl) };
            }
        }
        if (strUrl.includes('/api/in-chat-agents/save') || strUrl.includes('/api/settings/save')) {
            const parsed = init.body ? JSON.parse(init.body) : {};
            if (strUrl.includes('in-chat-agents')) savedAgentRequests.push(parsed);
            else savedSettingsPayloads.push(parsed);
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        if (strUrl.includes('/api/in-chat-agents/groups')) {
            return { ok: true, status: 200, json: async () => ({ groups: [] }) };
        }
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    });

    const companionRunnerMock = {
        COMPANION_RESULTS_UPDATED_EVENT: 'ica_companion_results_updated',
        collectRecentCompanionResults: jest.fn(() => []),
        getCompanionResults: getCompanionResults ?? jest.fn(() => ({})),
        initCompanionRunner: jest.fn(),
        getLatestValidCompanionMessageIndex: jest.fn(() => {
            for (let i = loaded.script.chat.length - 1; i >= 0; i--) {
                if (loaded.script.chat[i] && !loaded.script.chat[i].is_system) return i;
            }
            return -1;
        }),
        runTrackerCompanionsOnMessage: runTrackerCompanionsOnMessage ?? jest.fn(async () => {}),
        runCompanionsOnMessage: runCompanionsOnMessage ?? jest.fn(async () => {}),
        runCompanionAgentOnMessage: jest.fn(async () => {}),
        updateCompanionResult: updateCompanionResult ?? jest.fn(),
        deleteCompanionResult: jest.fn(),
        syncCompanionChatHistoryConfig: syncCompanionChatHistoryConfig ?? jest.fn(async () => 0),
    };

    const groupState = {
        selected_group: selectedGroup,
        is_group_generating: isGroupGenerating,
    };

    const quietPromptMock = generateQuietPrompt ?? jest.fn(async () => 'quiet output');

    const loaded = await importScriptModule({
        dom: `
            <div id="options_button"></div>
            <div id="options"></div>
            <div id="export_button"></div>
            <div id="export_format_popup"></div>
            <div id="online_status_indicator"></div>
            <div id="online_status_text"></div>
            <select id="main_api"><option value="openai">openai</option></select>
            <div id="chat">${chatDomExtra}</div>
            <div id="message_template" hidden>
                <div class="mes">
                    <div class="mes_block">
                        <div class="ch_name"><span class="name_text"></span></div>
                        <div class="mes_text"></div>
                    </div>
                </div>
            </div>
            <div id="send_form">
                <textarea id="send_textarea"></textarea>
                <div id="send_but"></div>
                <div id="mes_stop" style="display: none;"></div>
            </div>
            <div id="agents-panel-host"></div>
            ${domExtra}
        `,
        fetch: fetchMock,
        keepReal: [
            'scripts/sillybunny-editor/dialog.js',
            'scripts/sillybunny-editor/reorder-menu.js',
            'scripts/extensions/in-chat-agents/regex-scripts.js',
            'scripts/extensions/in-chat-agents/regex-snapshot-store.js',
            'scripts/extensions/in-chat-agents/companion/companion-shared.js',
        ],
        mocks: {
            'scripts/popup.js': {
                POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null },
                POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4 },
                Popup: TestPopup,
                callGenericPopup: jest.fn(async () => 1),
                fixToastrForDialogs: jest.fn(),
            },
            'scripts/extensions.js': base => ({
                ...base,
                renderExtensionTemplateAsync,
            }),
            'scripts/group-chats.js': base => ({
                ...base,
                get selected_group() { return groupState.selected_group; },
                get is_group_generating() { return groupState.is_group_generating; },
            }),
            'scripts/user.js': base => ({
                ...base,
                getCurrentUserHandle: jest.fn(() => 'test-user'),
            }),
            'scripts/tokenizers.js': base => ({
                ...base,
                getTokenizerModel: jest.fn(() => 'openai'),
            }),
            'scripts/sillybunny-delete-confirm.js': base => ({
                ...base,
                confirmDestructiveAction: jest.fn(async () => true),
            }),
            'scripts/extensions/in-chat-agents/pathfinder-init.js': {
                initPathfinder: jest.fn(),
                teardownPathfinder: jest.fn(),
            },
            'scripts/extensions/in-chat-agents/pathfinder-settings-ui.js': {
                openPathfinderSettings: jest.fn(),
                closePathfinderSettings: jest.fn(),
                canClosePathfinderSettings: jest.fn(() => true),
                cancelPathfinderSummary: jest.fn(),
                refreshPathfinderSettings: jest.fn(),
                isPathfinderAgent: jest.fn(agent => agent?.sourceTemplateId === 'tpl-pathfinder'),
            },
            'lib.js': base => ({
                ...base,
                DiffMatchPatch: class { diff_main() { return []; } diff_cleanupSemantic() {} },
            }),
            'scripts/extensions/in-chat-agents/pathfinder/tool-definitions.js': {
                getPathfinderToolDefinitions: jest.fn(() => []),
            },
            'scripts/extensions/in-chat-agents/companion/companion-runner.js': companionRunnerMock,
            'scripts/extensions/in-chat-agents/companion/companion-dashboard.js': {
                configureCompanionDashboard: jest.fn(),
                initCompanionWandMenuItem: jest.fn(),
            },
            'scripts/extensions/in-chat-agents/companion/companion-panel.js': {
                configureCompanionPanel: jest.fn(),
                initCompanionPanel: jest.fn(),
                refreshCompanionPanel: jest.fn(),
                updateCompanionPanelHandleVisibility: jest.fn(),
                isConversationModeActive: jest.fn(() => false),
                captureCompanionPanelOrigin: jest.fn(() => ({})),
                restoreCompanionPanelOrigin: jest.fn(async () => true),
                openCompanionPanel: jest.fn(),
            },
            'scripts/extensions/in-chat-agents/companion/lorebook-sender.js': {
                isLorebookAgent: jest.fn(() => false),
                sendCompanionResultToLorebook: jest.fn(async () => {}),
            },
            'scripts/extensions/in-chat-agents/textarea-fullscreen.js': {
                attachTextareaFullscreen: jest.fn(),
            },
            'scripts/extensions/in-chat-agents/ui/dialog-adapters.js': {
                prepareManualRunTargets: jest.fn(),
                prepareAgentBulkEditPopup: jest.fn(),
            },
        },
    });

    loaded.state.extension_settings.inChatAgents = {
        globalSettings: {
            enabled: true,
            trackerCompanionAutoLoopVersion: 4,
            levelUpStatsContextLinksVersion: 2,
            pathfinderSubmoduleEnabled: false,
            ...globalSettings,
        },
        autoSeededTemplateIds: templates.map(tpl => tpl.id),
    };

    loaded.script.characters.push({ name: 'Assistant', avatar: 'assistant.png', chat: 'chat-1' });
    loaded.script.setCharacterId(0);
    loaded.script.setCharacterName('Assistant');
    await loaded.script.changeMainAPI('openai');
    loaded.script.setOnlineStatus('Connected');
    loaded.script.chat.push(...chat);

    globalThis.SillyBunnyShell = {
        openTab: jest.fn(async () => {}),
    };

    const prepareOpenAIMessages = loaded.mocks['scripts/openai.js'].prepareOpenAIMessages;
    const sendOpenAIRequest = loaded.mocks['scripts/openai.js'].sendOpenAIRequest;
    prepareOpenAIMessages.mockImplementation(async () => [[{ role: 'user', content: 'prompt' }], false]);
    sendOpenAIRequest.mockImplementation(async () => ({
        choices: [{ message: { content: await quietPromptMock() } }],
    }));

    const agentListUi = await import(pub('scripts/extensions/in-chat-agents/ui/agent-list.js'));
    const agentStore = await import(pub('scripts/extensions/in-chat-agents/agent-store.js'));
    const agentRunner = await import(pub('scripts/extensions/in-chat-agents/agent-runner.js'));
    const companionUi = await import(pub('scripts/extensions/in-chat-agents/companion/companion-ui.js'));

    const column = document.getElementById('agents-panel-host');
    const panelController = agentListUi.mountAgentsPanel(column);

    await import(pub('scripts/extensions/in-chat-agents/index.js'));
    // Wait for the extension's top-level async startup sequence to complete.
    for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
        if (document.getElementById('ica--importFile') && column.querySelector('.sb-list-header')) {
            break;
        }
    }
    await new Promise(resolve => setTimeout(resolve, 25));

    activeCleanups.push(() => {
        panelController.destroy();
        loaded.cleanup();
    });

    return {
        ...loaded,
        agentListUi,
        agentStore,
        agentRunner,
        companionUi,
        panelController,
        column,
        groupState,
        popupRecords,
        renderExtensionTemplateAsync,
        companionRunnerMock,
        savedSettingsPayloads,
        savedAgentRequests,
        fetchMock,
        setPopupHandler: fn => { activePopupHandler = fn; },
    };
}

describe('in-chat agents generation UI wiring', () => {
    test('uses the shared send-button lifecycle for agent activity and routes stop clicks to agent cancel', async () => {
        const reqStarted = deferred();
        const reqRelease = deferred();
        const trackerAgent = makeAgent({
            id: 'tracker-inline',
            name: 'Inline Tracker',
            category: 'tracker',
            phase: 'post',
            connectionProfile: 'prof-1',
            postProcess: { enabled: true, type: 'extract', extractPattern: '<t>(.*?)</t>', extractVariable: 'hp', promptTransformEnabled: false },
        });
        const env = await bootInChatAgents({
            agents: [trackerAgent],
            chat: [{ name: 'Assistant', is_user: false, is_system: false, mes: 'Hello <t>10</t>', extra: {} }],
        });
        env.state.extension_settings.connectionManager = {
            profiles: [{ id: 'prof-1', name: 'Helper Profile', api: 'openai', model: 'gpt-4o' }],
        };
        const sendRequest = jest.fn(async () => {
            reqStarted.resolve();
            return { content: await reqRelease.promise };
        });
        const baseGetContext = env.mocks['scripts/extensions.js'].getContext;
        const originalImpl = baseGetContext.getMockImplementation();
        baseGetContext.mockImplementation(() => ({
            ...originalImpl(),
            ConnectionManagerRequestService: { sendRequest },
        }));

        // Clicking #mes_stop when no agent is active is a no-op.
        const initialCancelRev = env.agentRunner.getAgentGenerationCancelRevision();
        document.getElementById('mes_stop').click();
        expect(env.agentRunner.getAgentGenerationCancelRevision()).toBe(initialCancelRev);

        // Start a real agent generation via a connection profile so only index.js's send-button lifecycle runs.
        const runPromise = env.agentRunner.runAgentOnTarget('tracker-inline', { kind: 'message', messageIndex: 0 });
        await reqStarted.promise;

        // Shared send-button lifecycle locks send controls without setting body.dataset.generating.
        expect(env.agentRunner.isAgentGenerationActive()).toBe(true);
        expect(document.getElementById('send_form').classList.contains('sb-generating-controls')).toBe(true);
        expect(document.getElementById('mes_stop').style.display).toBe('flex');
        expect(document.body.dataset.generating).toBeUndefined();

        // Clicking #mes_stop cancels active agent generation and restores send controls when idle.
        document.getElementById('mes_stop').click();
        expect(env.agentRunner.getAgentGenerationCancelRevision()).toBeGreaterThan(initialCancelRev);
        reqRelease.resolve('<t>12</t>');
        await runPromise;

        expect(env.agentRunner.isAgentGenerationActive()).toBe(false);
        expect(document.getElementById('send_form').classList.contains('sb-generating-controls')).toBe(false);
        expect(document.getElementById('mes_stop').style.display).toBe('none');

        // When core generation (is_send_press) or group generation is active, ending agent activity does not unlock send controls.
        const run2Started = deferred();
        const run2Release = deferred();
        sendRequest.mockImplementationOnce(async () => {
            run2Started.resolve();
            return { content: await run2Release.promise };
        });
        const run2 = env.agentRunner.runAgentOnTarget('tracker-inline', { kind: 'message', messageIndex: 0 });
        await run2Started.promise;
        env.script.setSendButtonState(true);
        run2Release.resolve('<t>14</t>');
        await run2;
        expect(document.getElementById('send_form').classList.contains('sb-generating-controls')).toBe(true);
    });

    test('refreshes generation UI from core events without forwarding payloads and ignores dry-run starts', async () => {
        const env = await bootInChatAgents();

        // Start with stop controls showing so a refresh (when no agent/core generation is active) restores send controls.
        const sendForm = document.getElementById('send_form');
        const mesStop = document.getElementById('mes_stop');
        const setLocked = () => {
            sendForm.classList.add('sb-generating-controls');
            mesStop.style.display = 'flex';
        };
        setLocked();

        // Dry-run GENERATION_STARTED must leave the generation UI untouched.
        await env.eventSource.emit('generation_started', 'normal', {}, true);
        expect(sendForm.classList.contains('sb-generating-controls')).toBe(true);

        // Non-dry-run GENERATION_STARTED with truthy payloads must NOT forward payload as active=true;
        // instead it refreshes using isAgentGenerationActive() (false) and restores send controls.
        await env.eventSource.emit('generation_started', 'normal', { payload: true }, false);
        expect(sendForm.classList.contains('sb-generating-controls')).toBe(false);
        expect(mesStop.style.display).toBe('none');

        // GENERATION_ENDED and GENERATION_STOPPED also refresh without forwarding payloads.
        setLocked();
        await env.eventSource.emit('generation_ended', 42);
        expect(sendForm.classList.contains('sb-generating-controls')).toBe(false);

        setLocked();
        await env.eventSource.emit('generation_stopped', { reason: 'user' });
        expect(sendForm.classList.contains('sb-generating-controls')).toBe(false);
    });

    test('wires companion message cards and actions into chat rendering without wiring an inline editor hook', async () => {
        // Genuine HTML & CSS contracts for companion button and card classes.
        expect(publicIndexSource).toContain('mes_run_companions');
        expect(extensionStyleSource).toContain('.ica--companion-card');
        expect(extensionStyleSource).toContain('.mes_run_companions--running');

        const companionAgent = makeCompanion({
            id: 'comp-inline',
            name: 'Inline Card Companion',
            companion: { ...makeCompanion().companion, displayMode: 'card' },
        });
        const updateCompanionResult = jest.fn();
        const env = await bootInChatAgents({
            agents: [companionAgent],
            chat: [{
                name: 'Assistant',
                is_user: false,
                is_system: false,
                mes: 'Story beat',
                extra: {},
            }],
            getCompanionResults: jest.fn(() => ({
                'comp-inline': {
                    agentId: 'comp-inline',
                    agentName: 'Inline Card Companion',
                    status: 'done',
                    content: 'Original note',
                    displayMode: 'card',
                },
            })),
            updateCompanionResult,
            chatDomExtra: `
                <div class="mes" mesid="0" is_user="false" is_system="false">
                    <div class="mes_block"><div class="mes_text">Story beat</div></div>
                </div>
            `,
        });

        // Inline Companion cards deliberately have no editor configuration hook on companion-ui.
        expect(env.companionUi.configureCompanionCardUi).toBeUndefined();

        env.companionUi.renderCompanionResultsForMessage(0);
        const ledger = document.querySelector('.mes[mesid="0"] .ica--companion-ledger');
        expect(ledger).not.toBeNull();
        expect(ledger.querySelector('[data-action="regenerate"]')).not.toBeNull();

        // Editing the rendered inline card opens the edit popup and routes through updateCompanionResult.
        env.setPopupHandler(async popup => {
            const textarea = popup.content.querySelector('textarea');
            expect(textarea).not.toBeNull();
            textarea.value = 'Edited note';
            return 1;
        });
        const editBtn = ledger.querySelector('[data-action="edit"]');
        expect(editBtn).not.toBeNull();
        editBtn.click();
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(updateCompanionResult).toHaveBeenCalledWith(
            env.script.chat[0],
            'comp-inline',
            expect.objectContaining({ status: 'done', content: 'Edited note' }),
        );
    });

    test('wires companion AI Maker in the editor while preserving companion chat history settings', async () => {
        const companionAgent = makeCompanion({
            id: 'comp-maker',
            name: 'My Companion',
            description: 'Existing description',
            companion: {
                ...makeCompanion().companion,
                includeInChatHistory: true,
                chatHistoryDepth: 5,
                includeAllChatHistory: false,
                keepInChatHistoryWhenHostHidden: true,
            },
        });

        const env = await bootInChatAgents({
            agents: [companionAgent],
            generateQuietPrompt: async () => JSON.stringify({
                name: 'AI Companion',
                description: 'AI description',
                prompt: 'Track every clue.',
                companion: {
                    includeInChatHistory: false,
                    chatHistoryDepth: 1,
                    includeAllChatHistory: true,
                    keepInChatHistoryWhenHostHidden: false,
                },
            }),
        });

        // Open the companion in the real detail editor via the mounted list panel.
        await env.panelController.openAgent('agent:comp-maker');
        const makerBtn = env.column.querySelector('button[aria-label="AI Maker…"]');
        expect(makerBtn).not.toBeNull();

        const titles = [];
        env.setPopupHandler(async (popup, options) => {
            titles.push(options.title);
            const goal = popup.content?.querySelector?.('#ica--companion-maker-goal');
            if (goal) goal.value = 'Track every clue in the scene';
            return 1;
        });

        makerBtn.click();
        for (let i = 0; i < 20; i++) {
            await new Promise(resolve => setTimeout(resolve, 10));
            if (titles.length >= 2) break;
        }
        expect(titles).toEqual(['AI Maker', 'Generate Companion']);

        // Save the editor and confirm AI prompt applied while companion chat history settings stayed preserved.
        const saveBtn = env.column.querySelector('.sb-persona-entry-save');
        saveBtn.click();
        await new Promise(resolve => setTimeout(resolve, 25));

        const saved = env.agentStore.getAgentById('comp-maker');
        expect(saved.prompt).toBe('Track every clue.');
        expect(saved.companion.includeInChatHistory).toBe(true);
        expect(saved.companion.chatHistoryDepth).toBe(5);
        expect(saved.companion.includeAllChatHistory).toBe(false);
        expect(saved.companion.keepInChatHistoryWhenHostHidden).toBe(true);
    });

    test('passes custom tracker regeneration instructions into the LLM prompt and renders live HTML preview', async () => {
        // Genuine CSS contract for tracker preview frame.
        expect(extensionStyleSource).toContain('.ica--tracker-preview-frame');

        const trackerAgent = makeAgent({
            id: 'tracker-builder-test',
            name: 'Custom Tracker',
            category: 'tracker',
            phase: 'pre',
        });

        const capturedPrompts = [];
        const env = await bootInChatAgents({
            agents: [trackerAgent],
            generateQuietPrompt: async () => JSON.stringify({
                name: 'Custom Tracker',
                description: 'Tracks stats',
                phase: 'pre',
                prompt: 'Emit [STATUS|HP: 10]',
                postProcess: {
                    enabled: true,
                    type: 'extract',
                    extractPattern: '\\[STATUS\\|([^\\]]+)\\]',
                    extractVariable: 'status_tracker',
                },
                regexScripts: [{
                    scriptName: 'Status Card',
                    findRegex: '/\\[STATUS\\|([^\\]]+)\\]/g',
                    replaceString: '<div class="rendered-status">$1</div>',
                    placement: [2],
                    markdownOnly: true,
                    promptOnly: false,
                    runOnEdit: true,
                    disabled: false,
                }],
            }),
        });

        env.mocks['scripts/openai.js'].prepareOpenAIMessages.mockImplementation(async data => {
            capturedPrompts.push(String(data.quietPrompt ?? ''));
            return [[{ role: 'user', content: String(data.quietPrompt ?? '') }], false];
        });

        await env.panelController.openAgent('agent:tracker-builder-test');

        // Fill tracker format field in the real editor.
        const formatInput = env.column.querySelector('[data-sb-editor-field="trackerBuilder.format"] textarea, textarea[name="trackerBuilder.format"]')
            ?? [...env.column.querySelectorAll('textarea')].find(el => el.getAttribute('aria-label')?.toLowerCase().includes('format') || el.closest('[data-sb-editor-field]')?.dataset.sbEditorField === 'trackerBuilder.format');
        expect(formatInput).toBeDefined();
        formatInput.value = '[STATUS|HP: 10]';
        formatInput.dispatchEvent(new Event('input', { bubbles: true }));

        let regeneratedHtml = '';
        let sawRegenerateButton = false;
        env.setPopupHandler(async (popup, options) => {
            // Preview frame must render the regex-beautified HTML from AI_OUTPUT placement.
            const frame = popup.content.querySelector('.ica--tracker-preview-frame');
            expect(frame).not.toBeNull();
            expect(frame.innerHTML).toContain('rendered-status');

            const extraInput = popup.content.querySelector('#ica--tracker-builder-extra-instructions');
            expect(extraInput).not.toBeNull();
            extraInput.value = 'Use warmer amber tones';

            const regenButton = options.customButtons?.find(btn => btn.text === 'Regenerate');
            expect(regenButton).toBeDefined();
            sawRegenerateButton = true;
            await regenButton.action({ currentTarget: { disabled: false } });
            regeneratedHtml = popup.content.querySelector('#ica--tracker-builder-extra-instructions')?.value ?? '';
            return 1;
        });

        const generateKitBtn = [...env.column.querySelectorAll('button')].find(btn => btn.textContent.includes('Generate Kit'));
        expect(generateKitBtn).toBeDefined();
        generateKitBtn.click();

        for (let i = 0; i < 30; i++) {
            await new Promise(resolve => setTimeout(resolve, 10));
            if (capturedPrompts.length >= 2) break;
        }

        expect(sawRegenerateButton).toBe(true);
        expect(regeneratedHtml).toBe('Use warmer amber tones');
        expect(capturedPrompts).toHaveLength(2);
        expect(capturedPrompts[0]).toContain('Extra custom instructions for this generation:\n(none)');
        expect(capturedPrompts[1]).toContain('Extra custom instructions for this generation:\nUse warmer amber tones');
    });

    test('renders clear companion coordination & chat-history labels, populates companion selects by id or sourceTemplateId, and persists edits with chat-history sync', async () => {
        const compA = makeCompanion({
            id: 'comp-a',
            name: 'Alpha Companion',
            companion: {
                ...makeCompanion().companion,
                batch: true,
                batchAgentIds: ['tpl-beta'],
                sendContextToCompanions: false,
                contextRecipientAgentIds: ['comp-gamma'],
                dependencies: ['tpl-beta'],
                waitForDependencies: false,
                includeInChatHistory: false,
                chatHistoryDepth: 3,
                includeAllChatHistory: false,
                keepInChatHistoryWhenHostHidden: false,
            },
        });
        const compBeta = makeCompanion({
            id: 'comp-beta-saved',
            sourceTemplateId: 'tpl-beta',
            name: 'Beta Companion',
            connectionProfile: 'different-profile',
            enabled: true,
        });
        const compGamma = makeCompanion({
            id: 'comp-gamma',
            name: 'Gamma Companion',
            enabled: true,
        });
        const compDisabled = makeCompanion({
            id: 'comp-disabled',
            name: 'Disabled Companion',
            enabled: false,
        });

        const syncCompanionChatHistoryConfig = jest.fn(async () => 2);
        const env = await bootInChatAgents({
            agents: [compA, compBeta, compGamma, compDisabled],
            syncCompanionChatHistoryConfig,
        });

        await env.panelController.openAgent('agent:comp-a');

        const body = env.column.querySelector('.sb-persona-entry-body');
        expect(body).not.toBeNull();
        const text = env.column.textContent;
        expect(text).toContain('Companion · Coordination');
        expect(text).toContain('Companion · Chat History');
        expect(text).toContain('Send Context');
        expect(text).toContain('Recipients');
        expect(text).toContain('Re-Run After');
        expect(text).toContain('Wait');
        expect(text).toContain('Keep in Chat History');
        expect(text).toContain('Notes to Keep');
        expect(text).toContain('Keep All');
        expect(text).toContain('Keep When Hidden');
        expect(text).not.toContain('Cannot be turned on with');
        expect(text).not.toContain('Batch with compatible companions');

        // Batch selector lists ALL enabled side companions regardless of profile compatibility, excludes disabled ones,
        // and marks saved sourceTemplateId references selected.
        const fieldSelect = field => env.column.querySelector(`[data-sb-editor-field="${field}"] select`);
        const batchSelect = fieldSelect('companion.batchAgentIds');
        const recipientSelect = fieldSelect('companion.contextRecipientAgentIds');
        const depSelect = fieldSelect('companion.dependencies');
        expect(batchSelect).not.toBeNull();
        expect(recipientSelect).not.toBeNull();
        expect(depSelect).not.toBeNull();

        const batchLabels = [...batchSelect.options].map(opt => opt.textContent);
        expect(batchLabels.some(label => label.startsWith('Beta Companion'))).toBe(true);
        expect(batchLabels.some(label => label.startsWith('Gamma Companion'))).toBe(true);
        expect(batchLabels.some(label => label.startsWith('Disabled Companion'))).toBe(false);
        expect([...batchSelect.selectedOptions].map(opt => opt.textContent)).toEqual(['Beta Companion (Order 100)']);
        expect([...recipientSelect.selectedOptions].map(opt => opt.textContent)).toEqual(['Gamma Companion (Order 100)']);
        expect([...depSelect.selectedOptions].map(opt => opt.textContent)).toEqual(['Beta Companion (Order 100)']);

        // Toggle coordination & chat history switches and adjust depth.
        const toggleField = (field, checked) => {
            const input = env.column.querySelector(`[data-sb-editor-field="${field}"] input[type="checkbox"]`);
            expect(input).not.toBeNull();
            input.checked = checked;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        };
        toggleField('companion.sendContextToCompanions', true);
        toggleField('companion.waitForDependencies', true);
        toggleField('companion.includeInChatHistory', true);
        toggleField('companion.keepInChatHistoryWhenHostHidden', true);

        const depthInput = env.column.querySelector('[data-sb-editor-field="companion.chatHistoryDepth"] input');
        expect(depthInput).not.toBeNull();
        depthInput.value = '7';
        depthInput.dispatchEvent(new Event('input', { bubbles: true }));
        depthInput.dispatchEvent(new Event('change', { bubbles: true }));

        // Keeping all chat history disables the numeric depth control via editor visibility model.
        expect(getAgentEditorVisibility({
            ...compA,
            companion: { ...compA.companion, includeInChatHistory: true, includeAllChatHistory: true },
        }).disabled['companion.chatHistoryDepth']).toBe(true);
        expect(getAgentEditorVisibility({
            ...compA,
            companion: { ...compA.companion, includeInChatHistory: true, includeAllChatHistory: false },
        }).disabled['companion.chatHistoryDepth']).toBe(false);

        env.script.cancelDebouncedChatSave();
        const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
        env.column.querySelector('.sb-persona-entry-save').click();
        await new Promise(resolve => setTimeout(resolve, 25));

        const saved = env.agentStore.getAgentById('comp-a');
        expect(saved.companion.sendContextToCompanions).toBe(true);
        expect(saved.companion.waitForDependencies).toBe(true);
        expect(saved.companion.includeInChatHistory).toBe(true);
        expect(saved.companion.chatHistoryDepth).toBe(7);
        expect(saved.companion.keepInChatHistoryWhenHostHidden).toBe(true);
        expect(syncCompanionChatHistoryConfig).toHaveBeenCalledWith(expect.objectContaining({ id: 'comp-a' }));

        // Cancelling the debounced chat save logs only when saveChatDebounced actually scheduled one.
        debugSpy.mockClear();
        env.script.cancelDebouncedChatSave();
        expect(debugSpy).toHaveBeenCalledWith('Debounced chat save cancelled');

        // Editor opened through mountAgentDetail never fell back to legacy renderExtensionTemplateAsync('editor').
        expect(env.renderExtensionTemplateAsync).not.toHaveBeenCalledWith(expect.anything(), 'editor');
    });

    test('projects companion chat history into prompt-only messages including hidden hosts and strips auxiliary echoes', async () => {
        const hiddenHost = {
            name: 'Assistant',
            is_user: false,
            is_system: true,
            mes: 'SECRET HIDDEN BODY',
            extra: {
                secretFlag: true,
                [COMPANION_RESULTS_EXTRA_KEY]: {
                    'comp-hist': {
                        agentId: 'comp-hist',
                        agentName: 'Memory Keeper',
                        status: 'done',
                        content: 'Retained hidden note',
                        includeInChatHistory: true,
                        chatHistoryDepth: 4,
                        includeAllChatHistory: false,
                        keepInChatHistoryWhenHostHidden: true,
                    },
                },
            },
        };
        const visibleAssistant = {
            name: 'Assistant',
            is_user: false,
            is_system: false,
            mes: 'Visible reply [AUX]echo[/AUX]',
            extra: {},
        };

        const env = await bootInChatAgents({
            chat: [hiddenHost, visibleAssistant],
            companionSharedKeepReal: true,
        });

        const preparedChatCalls = [];
        env.mocks['scripts/openai.js'].setOpenAIMessages.mockImplementation(messages => {
            preparedChatCalls.push(structuredClone(messages));
            return [];
        });
        const appendFileContent = env.mocks['scripts/chats.js'].appendFileContent;

        // Regenerate excludes the rewrite target (visibleAssistant), keeping hiddenHost as the consolidated host.
        await env.script.Generate('regenerate', { preserveLastMessage: true });

        expect(preparedChatCalls.length).toBeGreaterThan(0);
        const projected = preparedChatCalls[0];
        const hiddenProjection = projected.find(msg => String(msg.mes ?? '').includes('Retained hidden note'));
        expect(hiddenProjection).toBeDefined();
        expect(hiddenProjection.mes).not.toContain('SECRET HIDDEN BODY');
        expect(hiddenProjection.is_system).toBe(false);
        expect(hiddenProjection.extra).toEqual({});
        expect(appendFileContent).not.toHaveBeenCalledWith(hiddenHost, '');

        // Post-generation agent runner strips auxiliary tracker echoes and saves with { deferBackup: true }.
        const stripAuxiliaryTrackerEchoes = jest.fn(text => text.replace(/\s*\[AUX\][\s\S]*?\[\/AUX\]/g, ''));
        env.agentRunner.registerCompanionRuntime({
            stripAuxiliaryTrackerEchoes,
        });
        await env.eventSource.emit('character_message_rendered', 1, 'normal');
        await new Promise(resolve => setTimeout(resolve, 25));

        expect(stripAuxiliaryTrackerEchoes).toHaveBeenCalled();
        expect(env.script.chat[1].mes).toBe('Visible reply');
    });

    test('mounts shared entity rows with touch-sized grips, groups companions separately, and supports selection mode', async () => {
        // Genuine CSS contract for 44px touch-sized drag grips.
        expect(extensionStyleSource).toMatch(/\.ica-agents-editor \.ica-agent-grip[^{]*\{\s*min-width: 44px;\s*min-height: 44px;/);
        // Deferred to Batch 6 (`tabs-harness.js`).
        expect(tabsSource).toContain('const controller = mountAgentsPanel(column);');
        expect(tabsSource).not.toContain('id: \'in_chat_agents_container\'');

        const preAgent = makeAgent({ id: 'a-pre', name: 'Pre Agent', phase: 'pre' });
        const bothAgent = makeAgent({ id: 'a-both', name: 'Both Agent', phase: 'both' });
        const postAgent = makeAgent({ id: 'a-post', name: 'Post Agent', phase: 'post' });
        const compAgent = makeCompanion({ id: 'a-comp', name: 'Side Companion' });
        const compByCategory = makeAgent({ id: 'a-comp-cat', name: 'Category Companion', category: 'companion', execution: 'inline', phase: 'pre' });

        // Model groups companion execution in its own stage after pre, both, post.
        const model = buildAgentListModel({
            entries: [
                { key: 'agent:a-pre', kind: 'agent', agent: preAgent },
                { key: 'agent:a-both', kind: 'agent', agent: bothAgent },
                { key: 'agent:a-post', kind: 'agent', agent: postAgent },
                { key: 'agent:a-comp', kind: 'agent', agent: compAgent },
                { key: 'agent:a-comp-cat', kind: 'agent', agent: compByCategory },
            ],
            categories: {
                custom: { label: 'Custom' },
                companion: { label: 'Companion' },
            },
            enabledKeys: new Set(['agent:a-pre', 'agent:a-comp']),
        });
        expect(model.sections.map(section => section.key)).toEqual(['pre', 'both', 'post', 'companion']);
        const companionRows = model.sections.find(section => section.key === 'companion').groups.flatMap(g => g.rows);
        expect(companionRows.map(row => row.entry.agent.id)).toEqual(expect.arrayContaining(['a-comp', 'a-comp-cat']));

        const env = await bootInChatAgents({
            agents: [preAgent, postAgent, compAgent],
        });

        // Mounted panel uses shared entity rows and loads the persona-detail stylesheet.
        expect(env.column.querySelectorAll('.ds-entity-row')).toHaveLength(3);
        expect(document.head.querySelector('link[href^="css/sillybunny-persona-detail.css"]')).not.toBeNull();

        // Settings store exposes the hidden import file input.
        expect(document.getElementById('ica--importFile')).not.toBeNull();

        // Toggling a row switch persists scoped enablement.
        const firstSwitch = env.column.querySelector('.ds-entity-row input[role="switch"]');
        expect(firstSwitch).not.toBeNull();
        const initialChecked = firstSwitch.checked;
        firstSwitch.checked = !initialChecked;
        firstSwitch.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(env.agentStore.isAgentEnabledForCurrentScope(env.agentStore.getAgentById('a-pre'))).toBe(!initialChecked);

        // Agents menu opens shared Select mode.
        const moreBtn = env.column.querySelector('button[aria-label="Agents Menu"]');
        moreBtn.click();
        const selectItem = [...document.querySelectorAll('button, [role="menuitem"]')].find(el => el.textContent.trim() === 'Select');
        expect(selectItem).toBeDefined();
        selectItem.click();
        expect(env.column.querySelectorAll('.ds-entity-row input[type="checkbox"]').length).toBeGreaterThan(0);
    });

    test('migrates Level Up and User-based Stats context links once and skips once migrated', async () => {
        const levelUp = makeCompanion({
            id: 'saved-level-up',
            sourceTemplateId: LEVEL_UP_TEMPLATE_ID,
            name: 'Level Up',
        });
        const stats = makeCompanion({
            id: 'saved-stats',
            sourceTemplateId: USER_BASED_STATS_TEMPLATE_ID,
            name: 'User-based Stats',
        });

        const env = await bootInChatAgents({
            agents: [levelUp, stats],
            globalSettings: { levelUpStatsContextLinksVersion: 0 },
        });

        const migratedLevelUp = env.agentStore.getAgentById('saved-level-up');
        const migratedStats = env.agentStore.getAgentById('saved-stats');
        expect(migratedLevelUp.companion.sendContextToCompanions).toBe(true);
        expect(migratedLevelUp.companion.contextRecipientAgentIds).toContain(USER_BASED_STATS_TEMPLATE_ID);
        expect(migratedStats.companion.sendContextToCompanions).toBe(true);
        expect(migratedStats.companion.contextRecipientAgentIds).toContain(LEVEL_UP_TEMPLATE_ID);
        expect(migratedStats.companion.dependencies).toContain(LEVEL_UP_TEMPLATE_ID);
        expect(migratedStats.companion.waitForDependencies).toBe(true);
        expect(env.agentStore.getGlobalSettings().levelUpStatsContextLinksVersion).toBe(2);

        // When version is already 2, unlinked settings are not overwritten on subsequent boot.
        const envAlreadyMigrated = await bootInChatAgents({
            agents: [levelUp, stats],
            globalSettings: { levelUpStatsContextLinksVersion: 2 },
        });
        expect(envAlreadyMigrated.agentStore.getAgentById('saved-stats').companion.dependencies).toEqual([]);
        expect(envAlreadyMigrated.agentStore.getAgentById('saved-stats').companion.waitForDependencies).toBe(false);
    });

    test('targets inline and companion tracker fixes independently across message roles and fix actions', async () => {
        const inlineTracker = makeAgent({
            id: 'trk-inline',
            name: 'Inline Tracker',
            category: 'tracker',
            phase: 'pre',
            postProcess: { enabled: true, type: 'extract', extractPattern: '<t>(.*?)</t>', extractVariable: 'trk', promptTransformEnabled: false },
        });
        const companionTracker = makeCompanion({
            id: 'trk-comp',
            name: 'Companion Tracker',
            category: 'tracker',
        });

        const runTrackerCompanionsOnMessage = jest.fn(async () => {});
        const env = await bootInChatAgents({
            agents: [inlineTracker, companionTracker],
            chat: [
                { name: 'System', is_user: false, is_system: true, mes: 'System note', extra: {} },
                { name: 'Assistant', is_user: false, is_system: false, mes: 'Assistant reply', extra: {} },
                { name: 'User', is_user: true, is_system: false, mes: 'User reply', extra: {} },
            ],
            runTrackerCompanionsOnMessage,
            domExtra: `
                <div class="mes" mesid="0" is_user="false" is_system="true"><button class="mes_fix_trackers"></button></div>
                <div class="mes" mesid="1" is_user="false" is_system="false"><button class="mes_fix_trackers"></button></div>
                <div class="mes" mesid="2" is_user="true" is_system="false"><button class="mes_fix_trackers"></button></div>
            `,
        });

        // System message button stays hidden; assistant & user message buttons reflect inline/companion availability.
        expect(document.querySelector('.mes[mesid="0"] .mes_fix_trackers').style.display).toBe('none');
        expect(document.querySelector('.mes[mesid="1"] .mes_fix_trackers').style.display).not.toBe('none');
        expect(document.querySelector('.mes[mesid="2"] .mes_fix_trackers').style.display).not.toBe('none');

        // Clicking Fix Trackers on a user message warns that no assistant reply is selected, but still runs companions.
        document.querySelector('.mes[mesid="2"] .mes_fix_trackers').click();
        await new Promise(resolve => setTimeout(resolve, 25));
        expect(env.toastr.warning).toHaveBeenCalledWith('No assistant reply selected to fix trackers on');
        expect(runTrackerCompanionsOnMessage).toHaveBeenCalledWith(2, {
            cancelRevision: env.agentRunner.getAgentGenerationCancelRevision(),
        });

        // Running global Fix Trackers from the Agents menu targets assistant message #1 for inline and latest non-system #2 for companions.
        runTrackerCompanionsOnMessage.mockClear();
        const moreBtn = env.column.querySelector('button[aria-label="Agents Menu"]');
        moreBtn.click();
        const fixItem = [...document.querySelectorAll('button, [role="menuitem"]')].find(el => el.textContent.trim() === 'Fix Trackers');
        expect(fixItem).toBeDefined();
        fixItem.click();
        await new Promise(resolve => setTimeout(resolve, 35));
        expect(runTrackerCompanionsOnMessage).toHaveBeenCalledWith(2, {
            cancelRevision: env.agentRunner.getAgentGenerationCancelRevision(),
        });
    });

    test('allows manual multi-target runs with assistant message ranges and keeps template open read-only until valid save', async () => {
        // Genuine CSS contract for message range input container.
        expect(extensionStyleSource).toContain('.ica--run-target-range');

        const manualAgent = makeAgent({
            id: 'manual-runner-agent',
            name: 'Manual Runner Agent',
            category: 'utility',
            phase: 'post',
            enabled: true,
            postProcess: { enabled: true, type: 'append', appendText: '', promptTransformEnabled: false },
        });
        const unusedTemplate = makeAgent({
            id: 'tpl-unused-manual',
            name: 'Unused Manual Template',
            category: 'utility',
            phase: 'post',
            enabled: false,
            postProcess: { enabled: false, type: 'append', appendText: '', promptTransformEnabled: true },
        });
        delete unusedTemplate.sourceTemplateId;

        const env = await bootInChatAgents({
            agents: [manualAgent],
            templates: [unusedTemplate],
            chat: [
                { name: 'Assistant', is_user: false, is_system: false, mes: 'Reply zero', extra: {} },
                { name: 'User', is_user: true, is_system: false, mes: 'User turn', extra: {} },
                { name: 'Assistant', is_user: false, is_system: false, mes: 'Reply two', extra: {} },
                { name: 'System', is_user: false, is_system: true, mes: 'System turn', extra: {} },
                { name: 'Assistant', is_user: false, is_system: false, mes: 'Reply four', extra: {} },
            ],
        });
        document.getElementById('send_textarea').value = 'Draft composer message';

        // Opening an unused template from the template picker stays read-only (does not materialise/save it).
        const addBtn = env.column.querySelector('button[aria-label="Add Agent"]');
        addBtn.click();
        const fromTplBtn = [...document.querySelectorAll('button, [role="menuitem"]')].find(el => el.textContent.includes('New Agent From Template'));
        expect(fromTplBtn).toBeDefined();
        fromTplBtn.click();
        const tplOption = [...document.querySelectorAll('button, [role="option"]')].find(el => el.textContent.includes('Unused Manual Template'));
        expect(tplOption).toBeDefined();
        tplOption.click();
        await new Promise(resolve => setTimeout(resolve, 25));
        expect(env.agentStore.getAgents().find(agent => agent.sourceTemplateId === 'tpl-unused-manual')).toBeUndefined();

        // Attempting to save an invalid (blank-prompt) template validates before materialising.
        const promptInput = env.column.querySelector('[data-sb-editor-field="prompt"] textarea')
            ?? env.column.querySelector('textarea');
        expect(promptInput).not.toBeNull();
        promptInput.value = '';
        promptInput.dispatchEvent(new Event('input', { bubbles: true }));
        env.column.querySelector('.sb-persona-entry-save').click();
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(env.agentStore.getAgents().find(agent => agent.sourceTemplateId === 'tpl-unused-manual')).toBeUndefined();

        // Restoring a valid prompt and saving materialises the template.
        promptInput.value = 'Valid prompt text';
        promptInput.dispatchEvent(new Event('input', { bubbles: true }));
        env.column.querySelector('.sb-persona-entry-save').click();
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(env.agentStore.getAgents().find(agent => agent.sourceTemplateId === 'tpl-unused-manual')).toBeDefined();
        await env.panelController.closeDetail();

        // Trigger Apply To… on the saved agent row and inspect checkbox picker + range input.
        const openRowApplyTarget = () => {
            const row = [...env.column.querySelectorAll('.ds-entity-row')].find(el => el.textContent.includes('Manual Runner Agent'));
            expect(row).toBeDefined();
            const menuBtn = row.querySelector('button[aria-haspopup="menu"], .ica-agent-more, button[title*="More"], button[aria-label*="Actions"]');
            expect(menuBtn).not.toBeNull();
            menuBtn.click();
            const applyItem = [...document.querySelectorAll('button, [role="menuitem"]')].find(el => el.textContent.includes('Apply To'));
            expect(applyItem).toBeDefined();
            applyItem.click();
        };

        let pickerInspect = null;
        env.setPopupHandler(async popup => {
            pickerInspect = {
                checkboxes: [...popup.content.querySelectorAll('input[type="checkbox"][name="ica--run-target"]')].map(el => el.value),
                radios: popup.content.querySelectorAll('input[type="radio"][name="ica--run-target"]').length,
                rangeInput: popup.content.querySelector('#ica--run-target-message-range'),
                text: popup.content.textContent,
            };
            return null; // Cancel
        });
        openRowApplyTarget();
        await new Promise(resolve => setTimeout(resolve, 30));

        expect(pickerInspect).not.toBeNull();
        expect(pickerInspect.radios).toBe(0);
        expect(pickerInspect.checkboxes).toEqual(['message', 'composer']);
        expect(pickerInspect.rangeInput).not.toBeNull();
        expect(pickerInspect.text).toContain('Last assistant reply #4');

        // Now select BOTH message range "0-2, 4" (skips user #1 and system #3) AND composer, and confirm.
        const runTargets = [];
        env.mocks['scripts/openai.js'].prepareOpenAIMessages.mockImplementation(async data => {
            runTargets.push(String(data.quietPrompt ?? ''));
            return [[{ role: 'user', content: String(data.quietPrompt ?? '') }], false];
        });
        env.setPopupHandler(async popup => {
            for (const box of popup.content.querySelectorAll('input[name="ica--run-target"]')) {
                box.checked = true;
            }
            popup.content.querySelector('#ica--run-target-message-range').value = '0-2, 4';
            return 1;
        });
        openRowApplyTarget();
        for (let i = 0; i < 30; i++) {
            await new Promise(resolve => setTimeout(resolve, 10));
            if (runTargets.length >= 4) break;
        }

        // Ran on assistant messages 0, 2, 4 plus composer (4 targets).
        expect(runTargets.length).toBe(4);
    });
});
