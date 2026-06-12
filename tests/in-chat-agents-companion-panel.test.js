/* global globalThis */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';

describe('companion tracker panel', () => {
    let chat;
    let eventSource;
    let agents;
    let companionResultsByMessage;
    let globallyEnabled;

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
                displayMode: agent?.companion?.displayMode ?? 'card',
            })),
            isAgentEnabledForCurrentScope: jest.fn(agent => Boolean(agent?.enabled)),
            isCompanionAgent: jest.fn(agent => agent?.execution === 'companion' || agent?.category === 'companion'),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js', () => ({
            COMPANION_RESULTS_UPDATED_EVENT: 'companion_results_updated',
            getCompanionResults: jest.fn(message => companionResultsByMessage.get(message) ?? {}),
            runCompanionAgentOnMessage: jest.fn(async () => ({})),
            runCompanionsOnMessage: jest.fn(async () => ({})),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-ui.js', () => ({
            cleanCompanionAgentName: jest.fn(name => String(name ?? '').trim() || 'Companion'),
            formatCompanionContent: jest.fn((agentId, result) => `<formatted>${result.content}</formatted>`),
            insertChoiceIntoMessageInput: jest.fn(() => true),
        }));

        return await import('../public/scripts/extensions/in-chat-agents/companion/companion-panel.js');
    }

    beforeEach(() => {
        chat = [];
        eventSource = createEventSource();
        agents = [];
        companionResultsByMessage = new Map();
        globallyEnabled = true;
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
        expect(html).toContain('data-action="panel-jump"');
        expect(html).toContain('data-action="panel-regenerate-all"');
        expect(html).toContain('data-message-index="0"');
        expect(html).toContain('No state yet');
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
        expect(handleElement.toggle).toHaveBeenCalled();
        const registered = eventSource.on.mock.calls.map(([eventName]) => eventName);
        expect(registered).toEqual(expect.arrayContaining([
            'companion_results_updated',
            'chat_changed',
            'message_deleted',
            'message_swiped',
        ]));
    });
});
