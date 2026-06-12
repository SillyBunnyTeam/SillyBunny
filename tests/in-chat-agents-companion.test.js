/* global globalThis */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';

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

describe('companion card ui', () => {
    let chat;
    let eventSource;
    let eventTypes;
    let agents;
    let sanitize;

    async function importCompanionUi() {
        jest.resetModules();

        sanitize = jest.fn(html => String(html));

        await jest.unstable_mockModule('../public/lib.js', () => ({
            DOMPurify: { sanitize },
            showdown: {
                Converter: class {
                    makeHtml(text) {
                        return `<md>${text}</md>`;
                    }
                },
            },
        }));

        await jest.unstable_mockModule('../public/script.js', () => ({
            chat,
            saveChatDebounced: jest.fn(),
            substituteParams: jest.fn(value => String(value ?? '')),
            substituteParamsExtended: jest.fn(value => String(value ?? '')),
        }));

        await jest.unstable_mockModule('../public/scripts/events.js', () => ({
            eventSource,
            event_types: eventTypes,
        }));

        await jest.unstable_mockModule('../public/scripts/popup.js', () => ({
            Popup: class {},
            POPUP_TYPE: { CONFIRM: 1 },
            POPUP_RESULT: { AFFIRMATIVE: 1 },
        }));

        await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
            escapeHtml: jest.fn(value => String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')),
            regexFromString: jest.fn(value => {
                const match = String(value ?? '').match(/^\/([\s\S]*)\/([a-z]*)$/i);
                return match ? new RegExp(match[1], match[2]) : new RegExp(String(value ?? ''));
            }),
            uuidv4: jest.fn(() => 'test-uuid'),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({
            areAgentsGloballyEnabled: jest.fn(() => true),
            getAgentById: jest.fn(id => agents.find(agent => agent.id === id)),
            getAgentRegexScripts: jest.fn(agent => Array.isArray(agent?.regexScripts) ? agent.regexScripts : []),
            getCompanionConfig: jest.fn(() => ({ displayMode: 'card' })),
            getEnabledAgents: jest.fn(() => [...agents]),
            isCompanionAgent: jest.fn(agent => agent?.execution === 'companion' || agent?.category === 'companion'),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js', () => ({
            COMPANION_RESULTS_UPDATED_EVENT: 'companion_results_updated',
            deleteCompanionResult: jest.fn(),
            getCompanionResults: jest.fn(() => ({})),
            runCompanionAgentOnMessage: jest.fn(async () => ({})),
            runCompanionsOnMessage: jest.fn(async () => ({})),
            updateCompanionResult: jest.fn(),
        }));

        return await import('../public/scripts/extensions/in-chat-agents/companion/companion-ui.js');
    }

    beforeEach(() => {
        chat = [];
        eventSource = createEventSource();
        eventTypes = {
            CHAT_CHANGED: 'chat_changed',
            CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
            USER_MESSAGE_RENDERED: 'user_message_rendered',
            MESSAGE_UPDATED: 'message_updated',
            MESSAGE_EDITED: 'message_edited',
            MESSAGE_SWIPED: 'message_swiped',
            MESSAGE_DELETED: 'message_deleted',
            MORE_MESSAGES_LOADED: 'more_messages_loaded',
        };
        agents = [{
            id: 'companion-tracker',
            name: 'Status Companion',
            execution: 'companion',
            regexScripts: [{
                id: 'beautifier',
                scriptName: 'Status Card',
                findRegex: '/\\[STATUS\\|([^\\]]+)\\]/g',
                replaceString: '<div class="status">$1</div>',
                placement: [2],
                disabled: false,
                markdownOnly: true,
                promptOnly: false,
                substituteRegex: 0,
            }],
        }];
        globalThis.toastr = {
            info: jest.fn(),
            success: jest.fn(),
            warning: jest.fn(),
            error: jest.fn(),
        };
        globalThis.document = {
            addEventListener: jest.fn(),
            querySelector: jest.fn(() => null),
        };
        const jqueryObject = {};
        Object.assign(jqueryObject, {
            on: jest.fn(() => jqueryObject),
            each: jest.fn(),
            find: jest.fn(() => jqueryObject),
            first: jest.fn(() => jqueryObject),
            toggle: jest.fn(),
            remove: jest.fn(),
            html: jest.fn(() => jqueryObject),
            after: jest.fn(),
            append: jest.fn(),
            closest: jest.fn(() => jqueryObject),
            attr: jest.fn(() => ''),
            length: 0,
        });
        globalThis.$ = jest.fn(() => jqueryObject);
    });

    test('applies the agent regex to markdown cards before conversion', async () => {
        const { formatCompanionContent } = await importCompanionUi();

        const html = formatCompanionContent('companion-tracker', {
            content: 'Note start [STATUS|calm] end',
            format: 'markdown',
        }, { name: 'Aria' });

        expect(html).toBe('<md>Note start <div class="status">calm</div> end</md>');
        expect(sanitize).toHaveBeenCalled();
    });

    test('escapes regex output in text-format cards', async () => {
        const { formatCompanionContent } = await importCompanionUi();

        const html = formatCompanionContent('companion-tracker', {
            content: '[STATUS|calm]',
            format: 'text',
        }, { name: 'Aria' });

        expect(html).toContain('ica--companion-text');
        expect(html).toContain('&lt;div class=&quot;status&quot;&gt;calm&lt;/div&gt;');
        expect(html).not.toContain('<div class="status">');
    });

    test('sanitizes html-format cards after the regex pass', async () => {
        const { formatCompanionContent } = await importCompanionUi();

        const html = formatCompanionContent('companion-tracker', {
            content: '[STATUS|calm]',
            format: 'html',
        }, { name: 'Aria' });

        expect(html).toBe('<div class="status">calm</div>');
        expect(sanitize).toHaveBeenCalledWith('<div class="status">calm</div>', expect.anything());
    });

    test('renders content unchanged when the agent no longer exists', async () => {
        const { formatCompanionContent } = await importCompanionUi();

        const html = formatCompanionContent('deleted-agent', {
            content: '[STATUS|calm]',
            format: 'markdown',
        }, { name: 'Aria' });

        expect(html).toBe('<md>[STATUS|calm]</md>');
    });

    test('keeps panel and hidden results out of the chat ledger', async () => {
        const { isHiddenCompanionResult } = await importCompanionUi();

        expect(isHiddenCompanionResult('companion-tracker', { displayMode: 'panel' })).toBe(true);
        expect(isHiddenCompanionResult('companion-tracker', { displayMode: 'hidden' })).toBe(true);
        expect(isHiddenCompanionResult('companion-tracker', { displayMode: 'card' })).toBe(false);

        const store = await import('../public/scripts/extensions/in-chat-agents/agent-store.js');
        store.getCompanionConfig.mockReturnValue({ displayMode: 'panel' });
        expect(isHiddenCompanionResult('companion-tracker', {})).toBe(true);
    });

    test('cleans uuid suffixes from companion agent display names', async () => {
        const { cleanCompanionAgentName } = await importCompanionUi();

        expect(cleanCompanionAgentName('Scene Tracker 20345602-939a-44c2-8522-525fb7212b0e')).toBe('Scene Tracker');
        expect(cleanCompanionAgentName('Scene Tracker')).toBe('Scene Tracker');
        expect(cleanCompanionAgentName('')).toBe('Companion');
    });

    test('extracts clickable choice text without list enumeration', async () => {
        const { extractChoiceText } = await importCompanionUi();

        expect(extractChoiceText('1. Ask Alhaitham about the doorframe')).toBe('Ask Alhaitham about the doorframe');
        expect(extractChoiceText('- Leave the market quietly')).toBe('Leave the market quietly');
        expect(extractChoiceText('• Side with Kaveh')).toBe('Side with Kaveh');
        expect(extractChoiceText('B) Inspect   the\nwoodwork')).toBe('Inspect the woodwork');
        expect(extractChoiceText('Plain choice with no marker')).toBe('Plain choice with no marker');
        expect(extractChoiceText('   ')).toBe('');
    });

    test('registers re-render listeners for lazy loads, edits, and deletions', async () => {
        const { initCompanionCardUi } = await importCompanionUi();

        initCompanionCardUi();

        const registered = eventSource.on.mock.calls.map(([eventName]) => eventName);
        expect(registered).toEqual(expect.arrayContaining([
            'more_messages_loaded',
            'message_edited',
            'message_deleted',
            'companion_results_updated',
        ]));
    });

    test('re-renders every remaining message when one is deleted', async () => {
        const { initCompanionCardUi } = await importCompanionUi();
        chat.push(
            { name: 'Assistant', mes: 'first', is_user: false, is_system: false },
            { name: 'Assistant', mes: 'second', is_user: false, is_system: false },
        );

        initCompanionCardUi();
        globalThis.$.mockClear();

        await eventSource.emit('message_deleted', 5);

        const selectors = globalThis.$.mock.calls.map(([selector]) => selector);
        expect(selectors).toEqual(expect.arrayContaining(['.mes[mesid="0"]', '.mes[mesid="1"]']));
        expect(selectors).not.toContain('.mes[mesid="5"]');
    });
});
