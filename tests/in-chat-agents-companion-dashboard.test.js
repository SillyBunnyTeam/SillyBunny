/* global globalThis */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';

describe('companion dashboard', () => {
    let chat;
    let eventSource;
    let agents;
    let companionResultsByMessage;
    let popupInstances;

    class PopupMock {
        constructor(content, type, header, options) {
            this.content = content;
            this.type = type;
            this.options = options;
            this.showPromise = new Promise(resolve => {
                this.resolveShow = resolve;
            });
            popupInstances.push(this);
        }

        show() {
            return this.showPromise;
        }

        async completeAffirmative() {
            this.resolveShow(1);
        }
    }

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
            listenerCount(event) {
                return (handlers.get(event) ?? []).length;
            },
        };
    }

    async function importDashboard() {
        jest.resetModules();

        await jest.unstable_mockModule('../public/script.js', () => ({
            chat,
            substituteParams: jest.fn((value, options = {}) => String(value ?? '')
                .replaceAll('{{user}}', 'Traveler')
                .replaceAll('{{char}}', options.name2Override || 'Assistant')
                .replaceAll('{{original}}', options.original ?? '')),
        }));

        await jest.unstable_mockModule('../public/scripts/events.js', () => ({
            eventSource,
            event_types: {},
        }));

        await jest.unstable_mockModule('../public/scripts/popup.js', () => ({
            Popup: PopupMock,
            POPUP_TYPE: { TEXT: 1 },
            POPUP_RESULT: { AFFIRMATIVE: 1 },
        }));

        await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
            escapeHtml: jest.fn(value => String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({
            areAgentsGloballyEnabled: jest.fn(() => true),
            getAgentById: jest.fn(id => agents.find(agent => agent.id === id)),
            getCompanionConfig: jest.fn(agent => ({
                trigger: agent?.companion?.trigger === 'manual' ? 'manual' : 'auto',
                displayMode: agent?.companion?.displayMode === 'hidden' ? 'hidden' : 'card',
                format: agent?.companion?.format ?? 'markdown',
                batch: Boolean(agent?.companion?.batch),
                feedback: {
                    enabled: Boolean(agent?.companion?.feedback?.enabled),
                    depth: Number(agent?.companion?.feedback?.depth) || 1,
                },
            })),
            isAgentEnabledForCurrentScope: jest.fn(agent => Boolean(agent?.enabled)),
            isCompanionAgent: jest.fn(agent => agent?.execution === 'companion' || agent?.category === 'companion'),
            isToolAgent: jest.fn(agent => agent?.category === 'tool'),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js', () => ({
            COMPANION_RESULTS_UPDATED_EVENT: 'companion_results_updated',
            getCompanionResults: jest.fn(message => companionResultsByMessage.get(message) ?? {}),
            getLatestValidCompanionMessageIndex: jest.fn(() => chat.length - 1),
            runCompanionAgentOnMessage: jest.fn(async () => ({})),
            runCompanionsOnMessage: jest.fn(async () => ({})),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-panel.js', () => ({
            openCompanionPanel: jest.fn(),
        }));

        return await import('../public/scripts/extensions/in-chat-agents/companion/companion-dashboard.js');
    }

    beforeEach(() => {
        chat = [];
        eventSource = createEventSource();
        agents = [];
        companionResultsByMessage = new Map();
        popupInstances = [];
        globalThis.toastr = {
            info: jest.fn(),
            success: jest.fn(),
            warning: jest.fn(),
            error: jest.fn(),
        };
        globalThis.document = {
            querySelector: jest.fn(() => null),
        };
        globalThis.$ = jest.fn(() => ({ length: 0, on: jest.fn(), append: jest.fn(), html: jest.fn() }));
    });

    test('partitions companion and convertible agents into their dashboard sections', async () => {
        agents = [
            { id: 'companion-1', name: 'Scene Notes', execution: 'companion', enabled: true, companion: { trigger: 'manual', format: 'text', batch: true } },
            { id: 'inline-1', name: 'Status Tracker', category: 'tracker', phase: 'pre', enabled: true },
            { id: 'tool-1', name: 'Tool Agent', category: 'tool', enabled: true },
        ];
        const dashboard = await importDashboard();
        dashboard.configureCompanionDashboard({
            getVisibleAgents: () => agents,
            getLastAssistantMessageIndex: () => -1,
        });

        const html = dashboard.buildDashboardHtml();

        const companionsSection = html.split('data-section="companions"')[1].split('data-section="convertible"')[0];
        const convertibleSection = html.split('data-section="convertible"')[1].split('data-section="notes"')[0];

        expect(companionsSection).toContain('Scene Notes');
        expect(companionsSection).toContain('data-action="to-inline"');
        expect(companionsSection).toContain('manual');
        expect(companionsSection).toContain('batch');
        expect(companionsSection).not.toContain('Status Tracker');

        expect(convertibleSection).toContain('Status Tracker');
        expect(convertibleSection).toContain('data-action="to-companion"');
        expect(convertibleSection).not.toContain('Tool Agent');
        expect(html).not.toContain('Tool Agent');
    });

    test('shows the disabled notice and empty states when nothing is configured', async () => {
        const dashboard = await importDashboard();
        const store = await import('../public/scripts/extensions/in-chat-agents/agent-store.js');
        store.areAgentsGloballyEnabled.mockReturnValue(false);
        dashboard.configureCompanionDashboard({
            getVisibleAgents: () => [],
            getLastAssistantMessageIndex: () => -1,
        });

        const html = dashboard.buildDashboardHtml();

        expect(html).toContain('globally disabled');
        expect(html).toContain('No companion agents yet');
        expect(html).toContain('No companion notes in this chat yet');
    });

    test('collects recent done notes newest-first with truncated snippets', async () => {
        const dashboard = await importDashboard();
        agents = [{ id: 'message-inbox', name: 'Message Inbox', sourceTemplateId: 'tpl-message-inbox-companion' }];
        const oldMessage = { is_user: false, is_system: false, mes: 'old' };
        const userMessage = { is_user: true, mes: 'question' };
        const newMessage = { is_user: false, is_system: false, mes: 'new' };
        chat.push(oldMessage, userMessage, newMessage);

        companionResultsByMessage.set(oldMessage, {
            'agent-a': { status: 'done', agentName: 'Notes', content: 'x'.repeat(300) },
            'agent-b': { status: 'pending', agentName: 'Pending', content: 'still running' },
        });
        companionResultsByMessage.set(newMessage, {
            'agent-a': { status: 'done', agentName: 'Notes', content: 'fresh  note\nwith   spacing' },
            'message-inbox': { status: 'done', agentName: 'Message Inbox', content: 'phone-none' },
        });

        const entries = dashboard.collectRecentNoteEntries();

        expect(entries).toHaveLength(2);
        expect(entries[0]).toEqual(expect.objectContaining({
            messageIndex: 2,
            agentId: 'agent-a',
            agentName: 'Notes',
            snippet: 'fresh note with spacing',
        }));
        expect(entries[1].messageIndex).toBe(0);
        expect(entries[1].snippet.endsWith('…')).toBe(true);
        expect(entries[1].snippet.length).toBeLessThanOrEqual(121);
        expect(entries.some(entry => entry.agentName === 'Pending')).toBe(false);
        expect(entries.some(entry => entry.agentName === 'Message Inbox')).toBe(false);
    });

    test('resolves macros in recent note snippets with the source message context', async () => {
        const dashboard = await importDashboard();
        const message = { name: 'Mona', is_user: false, is_system: false, mes: 'the stars are bright' };
        chat.push(message);

        companionResultsByMessage.set(message, {
            'agent-a': { status: 'done', agentName: 'Notes', content: '{{user}} saw {{char}} write: {{original}}' },
        });

        const entries = dashboard.collectRecentNoteEntries();

        expect(entries).toHaveLength(1);
        expect(entries[0].snippet).toBe('Traveler saw Mona write: the stars are bright');
    });

    test('appends the wand menu item once and wires its click handler', async () => {
        const dashboard = await importDashboard();
        const appended = [];
        const menuItem = { on: jest.fn(() => menuItem) };
        let wandItemInstalled = false;
        globalThis.$ = jest.fn(arg => {
            if (arg === '#ica_companions_wand_item') {
                return { length: wandItemInstalled ? 1 : 0 };
            }
            if (typeof arg === 'string' && arg.trim().startsWith('<')) {
                return menuItem;
            }
            if (arg === '#extensionsMenu') {
                return {
                    append: jest.fn(element => {
                        appended.push(element);
                        wandItemInstalled = true;
                    }),
                };
            }
            return { length: 0, on: jest.fn(), append: jest.fn() };
        });

        dashboard.initCompanionWandMenuItem();
        dashboard.initCompanionWandMenuItem();

        expect(appended).toHaveLength(1);
        expect(menuItem.on).toHaveBeenCalledWith('click', expect.any(Function));
    });

    test('registers the results listener while open and removes it after close', async () => {
        const dashboard = await importDashboard();
        dashboard.configureCompanionDashboard({
            getVisibleAgents: () => [],
            getLastAssistantMessageIndex: () => -1,
        });
        const rootElement = { closest: jest.fn(() => null) };
        const root = {
            0: rootElement,
            length: 1,
            html: jest.fn(() => root),
            on: jest.fn(() => root),
        };
        globalThis.$ = jest.fn(arg => {
            if (typeof arg === 'string' && arg.trim().startsWith('<')) {
                return root;
            }
            return { length: 0, on: jest.fn(), append: jest.fn() };
        });

        const openPromise = dashboard.openCompanionDashboard();

        expect(eventSource.on).toHaveBeenCalledWith('companion_results_updated', expect.any(Function));
        expect(eventSource.listenerCount('companion_results_updated')).toBe(1);
        expect(popupInstances).toHaveLength(1);
        expect(popupInstances[0].options).toEqual(expect.objectContaining({ wide: true, large: true, allowVerticalScrolling: true }));

        await popupInstances[0].completeAffirmative();
        await openPromise;

        expect(eventSource.removeListener).toHaveBeenCalledWith('companion_results_updated', expect.any(Function));
        expect(eventSource.listenerCount('companion_results_updated')).toBe(0);
    });
});
