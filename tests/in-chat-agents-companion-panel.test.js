/* global globalThis */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';

describe('companion tracker panel', () => {
    let chat;
    let eventSource;
    let agents;
    let companionResultsByMessage;
    let globallyEnabled;
    let chatTokenEstimate;
    let localStorageValues;
    let hiddenAgentIds;

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
            removeListener: jest.fn(),
        };
    }

    async function importPanel() {
        jest.resetModules();

        await jest.unstable_mockModule('../public/script.js', () => ({
            chat,
        }));

        await jest.unstable_mockModule('../public/scripts/chats.js', () => ({
            hideChatMessageRange: jest.fn(async () => {}),
        }));

        await jest.unstable_mockModule('../public/scripts/popup.js', () => ({
            Popup: class {
                async show() {
                    return 1;
                }
            },
            POPUP_TYPE: { CONFIRM: 1 },
            POPUP_RESULT: { AFFIRMATIVE: 1 },
        }));

        await jest.unstable_mockModule('../public/scripts/events.js', () => ({
            eventSource,
            event_types: {
                CHAT_CHANGED: 'chat_changed',
                MESSAGE_DELETED: 'message_deleted',
                MESSAGE_SWIPED: 'message_swiped',
            },
        }));

        await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
            escapeHtml: jest.fn(value => String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({
            areAgentsGloballyEnabled: jest.fn(() => globallyEnabled),
            getAgents: jest.fn(() => agents),
            getCompanionConfig: jest.fn(agent => ({
                trigger: agent?.companion?.trigger === 'manual' ? 'manual' : 'auto',
                displayMode: agent?.companion?.displayMode ?? 'panel',
            })),
            getHiddenAgentIds: jest.fn(() => new Set(hiddenAgentIds)),
            isAgentEnabledForCurrentScope: jest.fn(agent => Boolean(agent?.enabled)),
            isAgentHidden: jest.fn(agentId => hiddenAgentIds.has(String(agentId ?? '').trim())),
            isCompanionAgent: jest.fn(agent => agent?.execution === 'companion' || agent?.category === 'companion'),
            saveAgent: jest.fn(async () => {}),
            setHiddenAgentIds: jest.fn(ids => {
                hiddenAgentIds = new Set([...ids].map(id => String(id ?? '').trim()).filter(Boolean));
            }),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js', () => ({
            COMPANION_RESULTS_UPDATED_EVENT: 'companion_results_updated',
            getCompanionResults: jest.fn(message => companionResultsByMessage.get(message) ?? {}),
            getLatestValidCompanionMessageIndex: jest.fn(() => chat.length - 1),
            meetsCompanionContextThreshold: jest.fn(agent => !agent?.companion?.minContextTokens || agent.companion.minContextTokens <= chatTokenEstimate),
            runCompanionAgentOnMessage: jest.fn(async () => ({})),
            runCompanionsOnMessage: jest.fn(async () => ({})),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-ui.js', () => ({
            cleanCompanionAgentName: jest.fn(name => String(name ?? '').trim() || 'Companion'),
            editCompanionResult: jest.fn(async () => {}),
            formatCompanionContent: jest.fn((agentId, result) => `<formatted>${result.content}</formatted>`),
            insertChoiceIntoMessageInput: jest.fn(() => true),
            isSilentCompanionAgent: jest.fn(agent => String(agent?.sourceTemplateId ?? agent?.id ?? '') === 'tpl-message-inbox-companion'),
            isSuppressedCompanionResult: jest.fn((agentId, result) => {
                const agent = agents.find(agent => agent.id === agentId);
                return ['PHONE_NONE', 'phone-none'].includes(String(result?.content ?? '').trim())
                    && String(agent?.sourceTemplateId ?? agent?.id ?? '') === 'tpl-message-inbox-companion';
            }),
        }));

        return await import('../public/scripts/extensions/in-chat-agents/companion/companion-panel.js');
    }

    beforeEach(() => {
        chat = [];
        eventSource = createEventSource();
        agents = [];
        companionResultsByMessage = new Map();
        globallyEnabled = true;
        chatTokenEstimate = 0;
        localStorageValues = new Map();
        hiddenAgentIds = new Set();
        globalThis.localStorage = {
            getItem: jest.fn(key => localStorageValues.get(key) ?? null),
            setItem: jest.fn((key, value) => localStorageValues.set(key, String(value))),
        };
        globalThis.toastr = {
            info: jest.fn(),
            success: jest.fn(),
            warning: jest.fn(),
            error: jest.fn(),
        };
        globalThis.document = {
            body: {},
            querySelector: jest.fn(() => null),
        };
        globalThis.$ = jest.fn(() => ({ length: 0, on: jest.fn(), append: jest.fn(), html: jest.fn(), toggle: jest.fn() }));
    });

    test('collects the latest state and a capped history per agent', async () => {
        const tracker = { id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true, companion: { displayMode: 'panel' } };
        agents = [tracker];
        const panel = await importPanel();

        for (let index = 0; index < 8; index++) {
            const message = { is_user: false, is_system: false, mes: `reply ${index}` };
            chat.push(message);
            companionResultsByMessage.set(message, {
                'tracker-1': { status: 'done', content: `state ${index}`, agentName: 'Scene Tracker' },
            });
        }

        const states = panel.collectPanelAgentStates();

        expect(states).toHaveLength(1);
        expect(states[0].latest.messageIndex).toBe(7);
        expect(states[0].latest.result.content).toBe('state 7');
        expect(states[0].history).toHaveLength(5);
        expect(states[0].history[0].messageIndex).toBe(6);
    });

    test('orders panel sections by agents-page order with orphans last', async () => {
        agents = [
            { id: 'last-by-order', name: 'CYOA Choices', execution: 'companion', enabled: true, injection: { order: 900 } },
            { id: 'first-by-order', name: 'Scene Tracker', execution: 'companion', enabled: true, injection: { order: 10 } },
        ];
        const panel = await importPanel();

        const message = { is_user: false, is_system: false, mes: 'reply' };
        chat.push(message);
        companionResultsByMessage.set(message, {
            'orphan-agent': { status: 'done', content: 'orphan', agentName: 'Old Tracker' },
            'last-by-order': { status: 'done', content: 'choices', agentName: 'CYOA Choices' },
            'first-by-order': { status: 'done', content: 'scene', agentName: 'Scene Tracker' },
        });

        const states = panel.collectPanelAgentStates();

        expect(states.map(state => state.agentId)).toEqual(['first-by-order', 'last-by-order', 'orphan-agent']);
    });

    test('clamps the draggable handle position fraction', async () => {
        const panel = await importPanel();

        expect(panel.clampHandleTopFraction(0.5)).toBe(0.5);
        expect(panel.clampHandleTopFraction(-2)).toBe(0.08);
        expect(panel.clampHandleTopFraction(1.4)).toBe(0.92);
        expect(panel.clampHandleTopFraction('nonsense')).toBe(0.5);
    });

    test('snaps the handle dock to the nearest viewport edge', async () => {
        const panel = await importPanel();

        expect(panel.resolveHandleDock(390, 300, 400, 800)).toEqual({ edge: 'right', fraction: 0.375 });
        expect(panel.resolveHandleDock(5, 700, 400, 800)).toEqual({ edge: 'left', fraction: 0.875 });
        expect(panel.resolveHandleDock(200, 10, 400, 800)).toEqual({ edge: 'top', fraction: 0.5 });
        expect(panel.resolveHandleDock(360, 790, 400, 800)).toEqual({ edge: 'bottom', fraction: 0.9 });
        expect(panel.resolveHandleDock(2, 2, 400, 800).fraction).toBe(0.08);
    });

    test('parses stored handle positions including the legacy number form', async () => {
        const panel = await importPanel();

        expect(panel.parseStoredHandlePosition('0.4')).toEqual({ edge: 'right', fraction: 0.4 });
        expect(panel.parseStoredHandlePosition(JSON.stringify({ edge: 'bottom', fraction: 0.25 }))).toEqual({ edge: 'bottom', fraction: 0.25 });
        expect(panel.parseStoredHandlePosition('garbage')).toBeNull();
        expect(panel.parseStoredHandlePosition(JSON.stringify({ edge: 'diagonal', fraction: 0.5 }))).toBeNull();
        expect(panel.parseStoredHandlePosition(null)).toBeNull();
    });

    test('includes enabled companions without stored state and orphaned results', async () => {
        agents = [{ id: 'fresh', name: 'Fresh Companion', execution: 'companion', enabled: true }];
        const panel = await importPanel();

        const message = { is_user: false, is_system: false, mes: 'reply' };
        chat.push(message);
        companionResultsByMessage.set(message, {
            'deleted-agent': { status: 'done', content: 'orphan state', agentName: 'Old Tracker' },
        });

        const states = panel.collectPanelAgentStates();

        const fresh = states.find(state => state.agent?.id === 'fresh');
        expect(fresh).toBeDefined();
        expect(fresh.latest).toBeNull();

        const orphan = states.find(state => state.latest?.result?.content === 'orphan state');
        expect(orphan).toBeDefined();
        expect(orphan.agent).toBeNull();
    });

    test('shows Message Inbox while suppressing empty no-message results', async () => {
        const inbox = {
            id: 'message-inbox',
            name: 'Message Inbox',
            sourceTemplateId: 'tpl-message-inbox-companion',
            execution: 'companion',
            enabled: true,
            companion: { displayMode: 'panel' },
        };
        agents = [inbox];
        const panel = await importPanel();

        const initialHtml = panel.buildPanelHtml();
        expect(initialHtml).toContain('Message Inbox');
        expect(initialHtml).toContain('No state yet');

        const emptyMessage = { is_user: false, is_system: false, mes: 'reply without a text' };
        chat.push(emptyMessage);
        companionResultsByMessage.set(emptyMessage, {
            'message-inbox': { status: 'done', content: 'phone-none', agentName: 'Message Inbox' },
        });

        const waitingStates = panel.collectPanelAgentStates();
        expect(waitingStates).toHaveLength(1);
        expect(waitingStates[0].agent?.id).toBe('message-inbox');
        expect(waitingStates[0].latest).toBeNull();

        const waitingHtml = panel.buildPanelHtml();
        expect(waitingHtml).toContain('Message Inbox');
        expect(waitingHtml).toContain('No state yet');
        expect(waitingHtml).not.toContain('phone-none');

        const textMessage = { is_user: false, is_system: false, mes: 'reply with a text' };
        chat.push(textMessage);
        companionResultsByMessage.set(textMessage, {
            'message-inbox': { status: 'done', content: 'phone-start|Messages|now\nphone-text|Mona|now|Where are you?\nphone-end', agentName: 'Message Inbox' },
        });

        const html = panel.buildPanelHtml();
        expect(html).toContain('Message Inbox');
        expect(html).toContain('<formatted>phone-start|Messages|now');
    });

    test('builds panel sections with state, actions, and empty states', async () => {
        const tracker = { id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true, companion: { displayMode: 'panel' } };
        const fresh = { id: 'fresh', name: 'Fresh Companion', execution: 'companion', enabled: true, companion: { trigger: 'manual' } };
        agents = [tracker, fresh];
        const panel = await importPanel();

        const message = { is_user: false, is_system: false, mes: 'reply' };
        chat.push(message);
        companionResultsByMessage.set(message, {
            'tracker-1': { status: 'done', content: 'Sumeru City Market', agentName: 'Scene Tracker' },
        });

        const html = panel.buildPanelHtml();

        expect(html).toContain('Companions');
        expect(html).toContain('Scene Tracker');
        expect(html).toContain('<formatted>Sumeru City Market</formatted>');
        expect(html).toContain('data-action="panel-regenerate"');
        expect(html).toContain('data-action="panel-fix"');
        expect(html).toContain('data-action="panel-edit-note"');
        expect(html).toContain('data-action="panel-edit"');
        expect(html).toContain('data-action="panel-jump"');
        expect(html).toContain('data-action="panel-lock"');
        expect(html).toContain('data-action="panel-run-latest"');
        expect(html).toContain('data-action="panel-regenerate-all"');
        expect(html).toContain('data-message-index="0"');
        expect(html).toContain('No state yet');

        // SillyBunny: the per-companion Play button must remain visible after a companion has
        // already produced state, otherwise manual companions can only regenerate the first run
        // and never pick up a newer assistant reply from the draggable panel.
        expect(html).toMatch(/<section class="ica--tpanel-agent"[\s\S]*?data-message-index="0"[\s\S]*?data-action="panel-run-latest"[\s\S]*?<\/section>/);
    });

    test('keeps hidden companions unhideable from the collapsed panel row', async () => {
        const tracker = { id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true, companion: { displayMode: 'panel' } };
        agents = [tracker];
        hiddenAgentIds = new Set(['tracker-1']);
        const panel = await importPanel();

        const message = { is_user: false, is_system: false, mes: 'reply' };
        chat.push(message);
        companionResultsByMessage.set(message, {
            'tracker-1': { status: 'done', content: 'Hidden state', agentName: 'Scene Tracker' },
        });

        const html = panel.buildPanelHtml();

        expect(html).toContain('data-agent-id="tracker-1" data-message-index="0" data-hidden="true"');
        expect(html).toContain('data-action="panel-hide"');
        expect(html).toContain('aria-label="Unhide companion"');
        expect(html).toContain('data-action="panel-run-latest"');
    });

    test('renders edit buttons with per-entry message indices on history entries', async () => {
        const tracker = { id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true };
        agents = [tracker];
        const panel = await importPanel();

        for (let index = 0; index < 3; index++) {
            const message = { is_user: false, is_system: false, mes: `reply ${index}` };
            chat.push(message);
            companionResultsByMessage.set(message, {
                'tracker-1': { status: 'done', content: `state ${index}`, agentName: 'Scene Tracker' },
            });
        }

        const html = panel.buildPanelHtml();

        expect(html).toContain('Previous states (2)');
        expect(html).toMatch(/ica--tpanel-history-entry[\s\S]*?data-message-index="1"/);
        expect(html).toMatch(/ica--tpanel-history-entry[\s\S]*?data-message-index="0"/);
        const editNoteMatches = html.match(/data-action="panel-edit-note"/g);
        expect(editNoteMatches).toHaveLength(3);
    });

    test('shows enabled memory shard before threshold and offers shard compaction after a run', async () => {
        agents = [
            { id: 'memory-shard', name: 'Memory Shard', sourceTemplateId: 'tpl-memory-shard-companion', execution: 'companion', enabled: true, companion: { minContextTokens: 30000 } },
        ];
        const panel = await importPanel();

        // Below the threshold with no state: it still appears so users know it is enabled.
        const waitingHtml = panel.buildPanelHtml();
        expect(waitingHtml).toContain('Memory Shard');
        expect(waitingHtml).toContain('No state yet');

        // With a stored shard: section renders with the hide-history compaction button.
        const message0 = { is_user: false, is_system: false, mes: 'old reply' };
        const message1 = { is_user: false, is_system: false, mes: 'new reply' };
        chat.push(message0, message1);
        companionResultsByMessage.set(message1, {
            'memory-shard': { status: 'done', content: '## Timeline', agentName: 'Memory Shard' },
        });

        const html = panel.buildPanelHtml();
        expect(html).toContain('Memory Shard');
        expect(html).toContain('data-action="panel-hide-before"');

        // Non-shard agents never offer compaction.
        agents = [{ id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true }];
        companionResultsByMessage.set(message1, {
            'tracker-1': { status: 'done', content: 'state', agentName: 'Scene Tracker' },
        });
        expect(panel.buildPanelHtml()).not.toContain('data-action="panel-hide-before"');
    });

    test('shows the panel empty state when nothing is enabled or stored', async () => {
        const panel = await importPanel();

        const html = panel.buildPanelHtml();

        expect(html).toContain('No companion agents are enabled');
    });

    test('handle visibility follows global enablement and available state', async () => {
        const panel = await importPanel();
        expect(panel.shouldShowCompanionPanelHandle()).toBe(false);

        agents = [{ id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true }];
        expect(panel.shouldShowCompanionPanelHandle()).toBe(true);

        globallyEnabled = false;
        expect(panel.shouldShowCompanionPanelHandle()).toBe(false);
    });

    test('injects the panel, handle, and wand item once on init', async () => {
        const panel = await importPanel();
        const bodyAppends = [];
        const wandAppends = [];
        const elementStub = () => ({ length: 0, on: jest.fn(), append: jest.fn(), html: jest.fn(), toggle: jest.fn() });
        const panelElement = elementStub();
        const handleElement = elementStub();
        const menuItem = { on: jest.fn(() => menuItem) };
        globalThis.$ = jest.fn(arg => {
            if (arg === globalThis.document.body) {
                return { append: jest.fn(element => bodyAppends.push(element)) };
            }
            if (arg === '#ica--tracker-panel') {
                return panelElement;
            }
            if (arg === '#ica--tracker-panel-handle') {
                return handleElement;
            }
            if (arg === '#ica_tracker_panel_wand_item') {
                return { length: 0 };
            }
            if (arg === '#extensionsMenu') {
                return { append: jest.fn(element => wandAppends.push(element)) };
            }
            if (typeof arg === 'string' && arg.trim().startsWith('<')) {
                return menuItem;
            }
            return elementStub();
        });

        panel.initCompanionPanel();
        panel.initCompanionPanel();

        expect(bodyAppends).toHaveLength(2);
        expect(wandAppends).toHaveLength(1);
        expect(menuItem.on).toHaveBeenCalledWith('click', expect.any(Function));
        expect(panelElement.on).toHaveBeenCalledWith('click', '[data-action]', expect.any(Function));
        expect(panelElement.on).toHaveBeenCalledWith('click', '.ica--tpanel-agent-body .ica--choice-line', expect.any(Function));
        expect(handleElement.toggle).toHaveBeenCalled();
        const registered = eventSource.on.mock.calls.map(([eventName]) => eventName);
        expect(registered).toEqual(expect.arrayContaining([
            'companion_results_updated',
            'chat_changed',
            'message_deleted',
            'message_swiped',
        ]));
    });

    test('keeps the panel open on outside clicks while locked', async () => {
        const panel = await importPanel();
        const elementStub = () => {
            const element = {
                length: 0,
                on: jest.fn(() => element),
                append: jest.fn(() => element),
                html: jest.fn(() => element),
                toggle: jest.fn(() => element),
                attr: jest.fn(() => element),
                addClass: jest.fn(() => element),
                removeClass: jest.fn(() => element),
            };
            return element;
        };
        const panelElement = elementStub();
        const handleElement = elementStub();
        const documentElement = elementStub();
        const menuItem = { on: jest.fn(() => menuItem) };
        globalThis.$ = jest.fn(arg => {
            if (arg === globalThis.document.body) {
                return { append: jest.fn() };
            }
            if (arg === globalThis.document) {
                return documentElement;
            }
            if (arg === '#ica--tracker-panel') {
                return panelElement;
            }
            if (arg === '#ica--tracker-panel-handle') {
                return handleElement;
            }
            if (arg === '#ica_tracker_panel_wand_item') {
                return { length: 1 };
            }
            if (typeof arg === 'string' && arg.trim().startsWith('<')) {
                return menuItem;
            }
            return elementStub();
        });
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1000);

        try {
            panel.initCompanionPanel();
            const outsideClickHandler = documentElement.on.mock.calls.find(([eventName]) => eventName === 'click')[1];

            panel.openCompanionPanel();
            nowSpy.mockReturnValue(2000);
            outsideClickHandler({ target: { closest: jest.fn(() => null) } });

            expect(panelElement.removeClass).toHaveBeenCalledWith('is-open');

            panelElement.removeClass.mockClear();
            panel.openCompanionPanel();
            panel.setCompanionPanelLocked(true);
            nowSpy.mockReturnValue(3000);
            outsideClickHandler({ target: { closest: jest.fn(() => null) } });

            expect(panel.isCompanionPanelLocked()).toBe(true);
            expect(globalThis.localStorage.setItem).toHaveBeenCalledWith('ica--tracker-panel-locked', 'true');
            expect(panel.buildPanelHtml()).toContain('aria-pressed="true"');
            expect(panelElement.removeClass).not.toHaveBeenCalled();

            panel.setCompanionPanelLocked(false);
            expect(globalThis.localStorage.setItem).toHaveBeenCalledWith('ica--tracker-panel-locked', 'false');
        } finally {
            nowSpy.mockRestore();
        }
    });

    test('restores the saved panel lock state', async () => {
        localStorageValues.set('ica--tracker-panel-locked', 'true');
        const panel = await importPanel();

        expect(panel.isCompanionPanelLocked()).toBe(true);
        expect(panel.buildPanelHtml()).toContain('aria-pressed="true"');
    });

    test('runs a stateless companion on the latest assistant reply', async () => {
        agents = [{ id: 'relationship-lens', name: 'Relationship Lens', execution: 'companion', enabled: true, companion: { trigger: 'manual' } }];
        chat.push({ is_user: true, mes: 'hello' }, { is_user: false, is_system: false, mes: 'latest reply' });
        const panel = await importPanel();
        const runner = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        const panelElement = { on: jest.fn(() => panelElement), html: jest.fn(() => panelElement), toggle: jest.fn(() => panelElement), attr: jest.fn(() => panelElement), addClass: jest.fn(() => panelElement) };
        const handleElement = { on: jest.fn(() => handleElement), toggle: jest.fn(() => handleElement) };
        const button = { prop: jest.fn() };
        const section = { attr: jest.fn(name => (name === 'data-agent-id' ? 'relationship-lens' : undefined)) };
        const actionButton = {};
        globalThis.$ = jest.fn(arg => {
            if (arg === globalThis.document.body) {
                return { append: jest.fn() };
            }
            if (arg === '#ica--tracker-panel') {
                return panelElement;
            }
            if (arg === '#ica--tracker-panel-handle') {
                return handleElement;
            }
            if (arg === '#ica_tracker_panel_wand_item') {
                return { length: 1 };
            }
            if (arg === actionButton) {
                return {
                    attr: jest.fn(name => (name === 'data-action' ? 'panel-run-latest' : undefined)),
                    closest: jest.fn(() => section),
                    prop: button.prop,
                };
            }
            return { length: 0, on: jest.fn(), append: jest.fn(), html: jest.fn(), toggle: jest.fn() };
        });

        const html = panel.buildPanelHtml();
        expect(html).toContain('data-action="panel-run-latest"');
        panel.initCompanionPanel();
        const actionHandler = panelElement.on.mock.calls.find(([, selector]) => selector === '[data-action]')[2];
        await actionHandler({ preventDefault: jest.fn(), stopPropagation: jest.fn(), currentTarget: actionButton });

        expect(runner.runCompanionAgentOnMessage).toHaveBeenCalledWith('relationship-lens', 1);
        expect(button.prop).toHaveBeenCalledWith('disabled', true);
        expect(button.prop).toHaveBeenCalledWith('disabled', false);
    });

    test('sends Chat Only textbox input as private side-chat context', async () => {
        agents = [{
            id: 'chat-only',
            name: 'Chat Only',
            sourceTemplateId: 'tpl-chat-only-companion',
            execution: 'companion',
            enabled: true,
            companion: { trigger: 'manual', displayMode: 'panel' },
        }];
        chat.push({ is_user: true, mes: 'hello' }, { is_user: false, is_system: false, mes: 'latest reply' });
        companionResultsByMessage.set(chat[1], {
            'chat-only': { status: 'done', content: 'You: Hey\n\nMona: I can hear you.', agentName: 'Chat Only' },
        });
        const panel = await importPanel();
        const runner = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        const panelElement = { on: jest.fn(() => panelElement), html: jest.fn(() => panelElement), toggle: jest.fn(() => panelElement), attr: jest.fn(() => panelElement), addClass: jest.fn(() => panelElement) };
        const handleElement = { on: jest.fn(() => handleElement), toggle: jest.fn(() => handleElement) };
        const button = { prop: jest.fn() };
        const inputField = { val: jest.fn(value => (value === undefined ? 'Are you actually okay?' : inputField)), prop: jest.fn(() => inputField) };
        const section = {
            attr: jest.fn(name => (name === 'data-agent-id' ? 'chat-only' : '1')),
            find: jest.fn(() => inputField),
        };
        const actionButton = {};
        globalThis.$ = jest.fn(arg => {
            if (arg === globalThis.document.body) {
                return { append: jest.fn() };
            }
            if (arg === '#ica--tracker-panel') {
                return panelElement;
            }
            if (arg === '#ica--tracker-panel-handle') {
                return handleElement;
            }
            if (arg === '#ica_tracker_panel_wand_item') {
                return { length: 1 };
            }
            if (arg === actionButton) {
                return {
                    attr: jest.fn(name => (name === 'data-action' ? 'panel-chat-only-send' : undefined)),
                    closest: jest.fn(() => section),
                    prop: button.prop,
                };
            }
            return { length: 0, on: jest.fn(), append: jest.fn(), html: jest.fn(), toggle: jest.fn() };
        });

        const html = panel.buildPanelHtml();
        expect(html).toContain('data-role="chat-only-input"');
        expect(html).toContain('data-action="panel-chat-only-send"');
        expect(html).toContain('Private side chat');

        panel.initCompanionPanel();
        const actionHandler = panelElement.on.mock.calls.find(([, selector]) => selector === '[data-action]')[2];
        await actionHandler({ preventDefault: jest.fn(), stopPropagation: jest.fn(), currentTarget: actionButton });

        expect(runner.runCompanionAgentOnMessage).toHaveBeenCalledWith('chat-only', 1, expect.objectContaining({
            pendingContent: expect.stringContaining('You: Are you actually okay?'),
            extraContextSections: [expect.objectContaining({
                title: 'Chat Only side chat',
                content: expect.stringContaining('Mona: I can hear you.'),
            })],
        }));
        expect(runner.runCompanionAgentOnMessage.mock.calls[0][2].extraContextSections[0].content).toContain('You: Are you actually okay?');
        expect(inputField.prop).toHaveBeenCalledWith('disabled', true);
        expect(inputField.prop).toHaveBeenCalledWith('disabled', false);
        expect(inputField.val).toHaveBeenCalledWith('');
        expect(button.prop).toHaveBeenCalledWith('disabled', true);
        expect(button.prop).toHaveBeenCalledWith('disabled', false);
    });

    test('saves Plot Compass objective from the panel before rerunning', async () => {
        const plotCompass = {
            id: 'plot-compass',
            name: 'Plot Compass',
            sourceTemplateId: 'tpl-plot-compass-companion',
            execution: 'companion',
            enabled: true,
            settings: { plotCompassObjective: 'Old objective' },
            companion: { trigger: 'auto', displayMode: 'panel' },
        };
        agents = [plotCompass];
        chat.push({ is_user: true, mes: 'hello' }, { is_user: false, is_system: false, mes: 'latest reply' });
        companionResultsByMessage.set(chat[1], {
            'plot-compass': { status: 'done', content: 'Plan', agentName: 'Plot Compass' },
        });
        const panel = await importPanel();
        const store = await import('../public/scripts/extensions/in-chat-agents/agent-store.js');
        const runner = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        const panelElement = { on: jest.fn(() => panelElement), html: jest.fn(() => panelElement), toggle: jest.fn(() => panelElement), attr: jest.fn(() => panelElement), addClass: jest.fn(() => panelElement) };
        const handleElement = { on: jest.fn(() => handleElement), toggle: jest.fn(() => handleElement) };
        const button = { prop: jest.fn() };
        const inputField = { val: jest.fn(value => (value === undefined ? 'Reach the tower' : inputField)), prop: jest.fn(() => inputField) };
        const section = {
            attr: jest.fn(name => (name === 'data-agent-id' ? 'plot-compass' : '1')),
            find: jest.fn(() => inputField),
        };
        const actionButton = {};
        globalThis.$ = jest.fn(arg => {
            if (arg === globalThis.document.body) {
                return { append: jest.fn() };
            }
            if (arg === '#ica--tracker-panel') {
                return panelElement;
            }
            if (arg === '#ica--tracker-panel-handle') {
                return handleElement;
            }
            if (arg === '#ica_tracker_panel_wand_item') {
                return { length: 1 };
            }
            if (arg === actionButton) {
                return {
                    attr: jest.fn(name => (name === 'data-action' ? 'panel-plot-compass-save' : undefined)),
                    closest: jest.fn(() => section),
                    prop: button.prop,
                };
            }
            return { length: 0, on: jest.fn(), append: jest.fn(), html: jest.fn(), toggle: jest.fn() };
        });

        const html = panel.buildPanelHtml();
        expect(html).toContain('data-role="plot-compass-objective"');
        expect(html).toContain('data-action="panel-plot-compass-save"');
        expect(html).toContain('Old objective');

        panel.initCompanionPanel();
        const actionHandler = panelElement.on.mock.calls.find(([, selector]) => selector === '[data-action]')[2];
        await actionHandler({ preventDefault: jest.fn(), stopPropagation: jest.fn(), currentTarget: actionButton });

        expect(plotCompass.settings.plotCompassObjective).toBe('Reach the tower');
        expect(store.saveAgent).toHaveBeenCalledWith(expect.objectContaining({
            id: 'plot-compass',
            settings: expect.objectContaining({ plotCompassObjective: 'Reach the tower' }),
        }));
        expect(runner.runCompanionAgentOnMessage).toHaveBeenCalledWith('plot-compass', 1);
        expect(inputField.prop).toHaveBeenCalledWith('disabled', true);
        expect(inputField.prop).toHaveBeenCalledWith('disabled', false);
        expect(button.prop).toHaveBeenCalledWith('disabled', true);
        expect(button.prop).toHaveBeenCalledWith('disabled', false);
        expect(globalThis.toastr.success).toHaveBeenCalledWith('Plot Objective saved.');
    });

    test('closes after a panel choice inserts into the message box', async () => {
        agents = [{ id: 'choices', name: 'CYOA Choices', execution: 'companion', enabled: true }];
        const panel = await importPanel();
        const companionUi = await import('../public/scripts/extensions/in-chat-agents/companion/companion-ui.js');
        const elementStub = () => {
            const element = {
                length: 0,
                on: jest.fn(() => element),
                append: jest.fn(() => element),
                html: jest.fn(() => element),
                toggle: jest.fn(() => element),
                attr: jest.fn(() => element),
                addClass: jest.fn(() => element),
                removeClass: jest.fn(() => element),
            };
            return element;
        };
        const panelElement = elementStub();
        const handleElement = elementStub();
        const menuItem = { on: jest.fn(() => menuItem) };
        globalThis.$ = jest.fn(arg => {
            if (arg === globalThis.document.body) {
                return { append: jest.fn() };
            }
            if (arg === '#ica--tracker-panel') {
                return panelElement;
            }
            if (arg === '#ica--tracker-panel-handle') {
                return handleElement;
            }
            if (arg === '#ica_tracker_panel_wand_item') {
                return { length: 1 };
            }
            if (typeof arg === 'string' && arg.trim().startsWith('<')) {
                return menuItem;
            }
            return elementStub();
        });

        panel.initCompanionPanel();
        panel.openCompanionPanel();
        const choiceHandler = panelElement.on.mock.calls.find(([, selector]) => selector === '.ica--tpanel-agent-body .ica--choice-line')[2];
        const event = { preventDefault: jest.fn(), stopPropagation: jest.fn() };
        choiceHandler.call({ textContent: 'A) Open the door' }, event);

        expect(event.preventDefault).toHaveBeenCalled();
        expect(event.stopPropagation).toHaveBeenCalled();
        expect(companionUi.insertChoiceIntoMessageInput).toHaveBeenCalledWith('A) Open the door');
        expect(panelElement.removeClass).toHaveBeenCalledWith('is-open');
        expect(panelElement.attr).toHaveBeenCalledWith('aria-hidden', 'true');

        panelElement.removeClass.mockClear();
        panelElement.attr.mockClear();
        companionUi.insertChoiceIntoMessageInput.mockClear();
        panel.openCompanionPanel();
        panel.setCompanionPanelLocked(true);
        const lockedEvent = { preventDefault: jest.fn(), stopPropagation: jest.fn() };
        choiceHandler.call({ textContent: 'B) Stay here' }, lockedEvent);

        expect(lockedEvent.preventDefault).toHaveBeenCalled();
        expect(lockedEvent.stopPropagation).toHaveBeenCalled();
        expect(companionUi.insertChoiceIntoMessageInput).toHaveBeenCalledWith('B) Stay here');
        expect(panelElement.removeClass).not.toHaveBeenCalled();
        expect(panelElement.attr).not.toHaveBeenCalledWith('aria-hidden', 'true');
    });

    test('keeps card and hidden companions out of the tracker panel', async () => {
        agents = [
            { id: 'card-agent', name: 'Card Note', execution: 'companion', enabled: true, companion: { displayMode: 'card' } },
            { id: 'hidden-agent', name: 'Hidden Feedback', execution: 'companion', enabled: true, companion: { displayMode: 'hidden' } },
            { id: 'panel-agent', name: 'Panel Tracker', execution: 'companion', enabled: true, companion: { displayMode: 'panel' } },
        ];
        const panel = await importPanel();

        const message = { is_user: false, is_system: false, mes: 'reply' };
        chat.push(message);
        companionResultsByMessage.set(message, {
            'card-agent': { status: 'done', content: 'inline card content', agentName: 'Card Note' },
            'hidden-agent': { status: 'done', content: 'hidden feedback', agentName: 'Hidden Feedback' },
            'panel-agent': { status: 'done', content: 'panel state', agentName: 'Panel Tracker' },
        });

        const states = panel.collectPanelAgentStates();

        expect(states).toHaveLength(1);
        expect(states[0].agentId).toBe('panel-agent');
        expect(states[0].latest.result.content).toBe('panel state');

        const html = panel.buildPanelHtml();
        expect(html).toContain('Panel Tracker');
        expect(html).not.toContain('Card Note');
        expect(html).not.toContain('Hidden Feedback');
        expect(panel.shouldShowCompanionPanelHandle()).toBe(true);
    });

    test('hides the panel handle when only card/hidden companions are enabled', async () => {
        agents = [
            { id: 'card-only', name: 'Card Only', execution: 'companion', enabled: true, companion: { displayMode: 'card' } },
            { id: 'hidden-only', name: 'Hidden Only', execution: 'companion', enabled: true, companion: { displayMode: 'hidden' } },
        ];
        const panel = await importPanel();

        const message = { is_user: false, is_system: false, mes: 'reply' };
        chat.push(message);
        companionResultsByMessage.set(message, {
            'card-only': { status: 'done', content: 'card', agentName: 'Card Only' },
            'hidden-only': { status: 'done', content: 'hidden', agentName: 'Hidden Only' },
        });

        expect(panel.shouldShowCompanionPanelHandle()).toBe(false);
        expect(panel.collectPanelAgentStates()).toHaveLength(0);
        expect(panel.buildPanelHtml()).toContain('No companion agents are enabled');
    });

    test('excludes orphaned card/hidden results, keeps panel results', async () => {
        agents = [];
        const panel = await importPanel();

        const message = { is_user: false, is_system: false, mes: 'reply' };
        chat.push(message);
        companionResultsByMessage.set(message, {
            'orphan-card': { status: 'done', content: 'card orphan', agentName: 'Old Card', displayMode: 'card' },
            'orphan-panel': { status: 'done', content: 'panel orphan', agentName: 'Old Panel', displayMode: 'panel' },
            'orphan-legacy': { status: 'done', content: 'legacy', agentName: 'Legacy' },
        });

        const states = panel.collectPanelAgentStates();

        expect(states.map(state => state.agentId).sort()).toEqual(['orphan-legacy', 'orphan-panel']);
        expect(states.find(state => state.agentId === 'orphan-card')).toBeUndefined();
    });
});
