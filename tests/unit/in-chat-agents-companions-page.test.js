/* eslint-disable playwright/no-standalone-expect -- Jest DOM-free page model and lifecycle contracts. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const loadPage = () => import('../../public/scripts/extensions/in-chat-agents/ui/companions-page-controller.js');
const mounted = new Set();

function snapshot(overrides = {}) {
    return { agents: [], chat: [], enabled: true, conversationMode: false, ...overrides };
}

function companion(id, overrides = {}) {
    return { id, name: id, execution: 'companion', enabled: true, ...overrides };
}

function message(results = {}, overrides = {}) {
    return { is_user: false, is_system: false, name: 'Mona', mes: 'Original reply', results, ...overrides };
}

function selectorsFor(state, overrides = {}) {
    return {
        getResults: jest.fn(message => message.results ?? {}),
        getCompanionConfig: jest.fn(agent => ({
            trigger: 'auto', displayMode: 'card', format: 'markdown', batch: false,
            feedback: { enabled: false, depth: 1 }, ...agent.companion,
        })),
        isCompanionAgent: jest.fn(agent => agent.execution === 'companion' || agent.category === 'companion'),
        isToolAgent: jest.fn(agent => agent.category === 'tool'),
        isAgentEnabledForCurrentScope: jest.fn(agent => Boolean(agent.enabled)),
        getAgentById: jest.fn(id => state.agents.find(agent => agent.id === id)),
        resolveContent: jest.fn((content, message) => content
            .replaceAll('{{user}}', 'Traveler')
            .replaceAll('{{char}}', message.name)
            .replaceAll('{{original}}', message.mes)),
        ...overrides,
    };
}

function sectionRows(model, id) {
    return model.sections.find(section => section.id === id).rows;
}

async function build(state, overrides = {}) {
    const module = await loadPage();
    const selectors = selectorsFor(state, overrides);
    return { model: module.buildCompanionsPageModel(state, selectors), selectors };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

async function mount(state = snapshot(), overrides = {}) {
    const module = await loadPage();
    const listeners = new Set();
    const unsubscribe = jest.fn(handler => listeners.delete(handler));
    const services = {
        readSnapshot: jest.fn(() => state),
        selectors: selectorsFor(state),
        subscribeResults: jest.fn(handler => {
            listeners.add(handler);
            return () => unsubscribe(handler);
        }),
        getLatestMessageIndex: jest.fn(() => state.chat.length - 1),
        runAll: jest.fn(async () => ({ companion: { status: 'done' } })),
        openEditor: jest.fn(),
        openPanel: jest.fn(),
        jumpToMessage: jest.fn(),
        notify: jest.fn(),
        ...overrides,
    };
    const onChange = jest.fn();
    const controller = module.createCompanionsPageController({ services, onChange });
    mounted.add(controller);
    return {
        controller, services, onChange, listeners, unsubscribe,
        emit: () => [...listeners].forEach(handler => handler()),
    };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
    for (const controller of mounted) controller.destroy();
    mounted.clear();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

describe('A4 Companions overview data parity', () => {
    test('exports DOM-free model and mounted controller seams', async () => {
        const module = await loadPage();
        expect(typeof module.buildCompanionsPageModel).toBe('function');
        expect(typeof module.createCompanionsPageController).toBe('function');
    });

    test('has only Companions then Recent Notes, preserving visible companion order including off agents', async () => {
        const { model } = await build(snapshot({ agents: [
            companion('z-last-alphabetically', { enabled: false }),
            { id: 'inline', category: 'tracker', execution: 'inline' },
            companion('tool', { category: 'tool' }),
            companion('a-first-alphabetically'),
        ] }));
        expect(model.status).toBe('ready');
        expect(model.sections.map(section => section.id)).toEqual(['companions', 'notes']);
        expect(sectionRows(model, 'companions').map(row => row.id)).toEqual(['z-last-alphabetically', 'a-first-alphabetically']);
        expect(sectionRows(model, 'companions')[0].enabled).toBe(false);
        expect(model.actions).toEqual(['run-all', 'open-panel']);
        expect(model.notice).toBeNull();
        expect(model.runAllDisabled).toBe(false);
    });

    test('retains trigger/display/format/batch/feedback metadata for the shared summary row', async () => {
        const { model } = await build(snapshot({ agents: [companion('notes', { companion: {
            trigger: 'manual', displayMode: 'panel', format: 'text', batch: true,
            feedback: { enabled: true, depth: 3 },
        } })] }));
        expect(sectionRows(model, 'companions')[0].config).toMatchObject({
            trigger: 'manual', displayMode: 'panel', format: 'text', batch: true,
            feedback: { enabled: true, depth: 3 },
        });
    });

    test('empty/off state keeps both empty groups and panel action, disabling Run All only', async () => {
        const { model } = await build(snapshot({ enabled: false }));
        expect(model.sections.map(section => [section.id, section.rows])).toEqual([['companions', []], ['notes', []]]);
        expect(model.notice).toBe('globally-disabled');
        expect(model.runAllDisabled).toBe(true);
        expect(model.actions).toEqual(['run-all', 'open-panel']);
    });

    test('Conversation Mode yields a neutral unavailable model without evaluating results or companion selectors', async () => {
        const { model, selectors } = await build(snapshot({
            conversationMode: true, agents: [companion('hidden')], chat: [message()],
        }));
        expect(model).toMatchObject({ status: 'conversation-mode', sections: [], actions: [], runAllDisabled: true });
        expect(selectors.getResults).not.toHaveBeenCalled();
        expect(selectors.getCompanionConfig).not.toHaveBeenCalled();
    });

    test('notes are newest-message first, preserve per-message insertion order, and include valid user results', async () => {
        const { model } = await build(snapshot({ chat: [
            message({ old: { status: 'done', content: 'old' } }),
            message({ user: { status: 'done', content: 'user note' } }, { is_user: true }),
            message({ system: { status: 'done', content: 'must not appear' } }, { is_system: true }),
            message({
                second: { status: 'done', content: 'fresh  note\nwith   spacing' },
                first: { status: 'done', content: 'same message second result' },
                pending: { status: 'pending', content: 'pending' },
                error: { status: 'error', content: 'failed' },
                suppressed: { status: 'done', content: 'phone-none' },
                invalid: null,
            }),
        ] }));
        expect(sectionRows(model, 'notes').map(row => [row.messageIndex, row.agentId])).toEqual([
            [3, 'second'], [3, 'first'], [1, 'user'], [0, 'old'],
        ]);
        expect(sectionRows(model, 'notes')[0].snippet).toBe('fresh note with spacing');
        expect(new Set(sectionRows(model, 'notes').map(row => row.key)).size).toBe(4);
    });

    test('caps recent notes at exactly twenty across messages, not twenty per agent', async () => {
        const chat = Array.from({ length: 24 }, (_, index) => message({
            notes: { status: 'done', content: `note ${index}` },
        }));
        const { model } = await build(snapshot({ chat }));
        expect(sectionRows(model, 'notes')).toHaveLength(20);
        expect(sectionRows(model, 'notes').map(row => row.messageIndex)).toEqual(Array.from({ length: 20 }, (_, index) => 23 - index));
    });

    test.each([120, 121, 300])('preserves the existing 120-code-unit truncation boundary for length %s', async length => {
        const content = 'x'.repeat(length);
        const { model } = await build(snapshot({ chat: [message({ notes: { status: 'done', content } })] }));
        const snippet = sectionRows(model, 'notes')[0].snippet;
        expect(snippet).toBe(length > 120 ? `${'x'.repeat(120)}…` : content);
        expect(snippet.length).toBe(length > 120 ? 121 : 120);
    });

    test('keeps UTF-16 slicing parity rather than silently switching to code-point truncation', async () => {
        const content = '🐇'.repeat(61);
        const { model } = await build(snapshot({ chat: [message({ notes: { status: 'done', content } })] }));
        expect(sectionRows(model, 'notes')[0].snippet).toBe(`${content.slice(0, 120)}…`);
    });

    test('resolves macros with the source message before whitespace collapse and truncation', async () => {
        const source = message({ notes: { status: 'done', content: '{{user}}  saw {{char}} write:\n{{original}}' } });
        const { model, selectors } = await build(snapshot({ chat: [source] }));
        expect(selectors.resolveContent).toHaveBeenCalledWith(source.results.notes.content, source);
        expect(sectionRows(model, 'notes')[0].snippet).toBe('Traveler saw Mona write: Original reply');
    });

    test('names prefer trimmed result name then saved agent then Companion, retaining empty completed notes', async () => {
        const { model } = await build(snapshot({
            agents: [companion('saved', { name: 'Saved Name' })],
            chat: [message({
                historical: { status: 'done', agentName: '  Historical Name  ', content: 'note' },
                saved: { status: 'done', agentName: '  ', content: 'note' },
                deleted: { status: 'done', content: '' },
            })],
        }));
        expect(sectionRows(model, 'notes').map(row => [row.agentName, row.snippet])).toEqual([
            ['Historical Name', 'note'], ['Saved Name', 'note'], ['Companion', ''],
        ]);
    });

    test('latest nonsuppressed valid result supplies token estimates even when not done', async () => {
        const { model } = await build(snapshot({
            agents: [companion('notes')],
            chat: [
                message({ notes: { status: 'done', tokenUsage: { inputTokens: 9, outputTokens: 8 } } }),
                message({ notes: { status: 'pending', tokenUsage: { inputTokens: '1234.4', outputTokens: 55.7 } } }, { is_user: true }),
                message({ notes: { status: 'done', content: 'tracker-none', tokenUsage: { inputTokens: 99 } } }),
                message({ notes: { status: 'done', tokenUsage: { inputTokens: 999 } } }, { is_system: true }),
            ],
        }));
        expect(sectionRows(model, 'companions')[0].tokenUsage).toEqual({ inputTokens: 1234, outputTokens: 56 });
    });

    test.each([0, -1, Infinity, 'not-a-number', undefined])('invalid/nonpositive token estimate %s is zero, never NaN', async value => {
        const { model } = await build(snapshot({
            agents: [companion('notes')],
            chat: [message({ notes: { status: 'done', tokenUsage: { inputTokens: value, outputTokens: value } } })],
        }));
        expect(sectionRows(model, 'companions')[0].tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });

    test('a latest result with no tokens does not borrow token estimates from an older result', async () => {
        const { model } = await build(snapshot({ agents: [companion('notes')], chat: [
            message({ notes: { status: 'done', tokenUsage: { inputTokens: 100, outputTokens: 200 } } }),
            message({ notes: { status: 'pending' } }),
        ] }));
        expect(sectionRows(model, 'companions')[0].tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });

    test('building models does not mutate agents, results or messages', async () => {
        const state = snapshot({ agents: [companion('notes')], chat: [message({ notes: { status: 'done', content: 'note' } })] });
        const before = structuredClone(state);
        const { model } = await build(state);
        sectionRows(model, 'companions')[0].config.feedback.depth = 99;
        expect(state).toEqual(before);
    });
});

describe('A4 Companions overview actions and mounted lifecycle', () => {
    test('subscribes once and coalesces result bursts at the existing 100ms boundary', async () => {
        const { services, listeners, emit, onChange } = await mount();
        const count = onChange.mock.calls.length;
        expect(services.subscribeResults).toHaveBeenCalledTimes(1);
        expect(listeners.size).toBe(1);
        emit();
        emit();
        emit();
        jest.advanceTimersByTime(99);
        expect(onChange).toHaveBeenCalledTimes(count);
        jest.advanceTimersByTime(1);
        expect(onChange).toHaveBeenCalledTimes(count + 1);
    });

    test('destroy removes the exact listener and cancels a pending refresh; remount gets just one listener', async () => {
        const first = await mount();
        const handler = first.services.subscribeResults.mock.calls[0][0];
        first.emit();
        first.controller.destroy();
        first.controller.destroy();
        const count = first.onChange.mock.calls.length;
        jest.advanceTimersByTime(100);
        expect(first.unsubscribe).toHaveBeenCalledTimes(1);
        expect(first.unsubscribe).toHaveBeenCalledWith(handler);
        expect(first.listeners.size).toBe(0);
        expect(first.onChange).toHaveBeenCalledTimes(count);
        const second = await mount();
        expect(second.listeners.size).toBe(1);
        second.controller.destroy();
        expect(second.listeners.size).toBe(0);
    });

    test('Conversation Mode has no subscription or executable companion actions', async () => {
        const { controller, services } = await mount(snapshot({ conversationMode: true, agents: [companion('notes')] }));
        await controller.runAll();
        await controller.openPanel();
        await controller.edit('notes');
        await controller.jump(0);
        expect(controller.getState().status).toBe('conversation-mode');
        expect(services.subscribeResults).not.toHaveBeenCalled();
        for (const name of ['runAll', 'getLatestMessageIndex', 'openPanel', 'openEditor', 'jumpToMessage']) {
            expect(services[name]).not.toHaveBeenCalled();
        }
    });

    test('mode transitions cancel queued work, unsubscribe and resume with exactly one listener', async () => {
        const state = snapshot();
        const { controller, listeners, emit, onChange, services } = await mount(state);
        emit();
        state.conversationMode = true;
        controller.refresh();
        const count = onChange.mock.calls.length;
        expect(listeners.size).toBe(0);
        jest.advanceTimersByTime(100);
        expect(onChange).toHaveBeenCalledTimes(count);
        expect(controller.getState().status).toBe('conversation-mode');
        state.conversationMode = false;
        controller.refresh();
        controller.refresh();
        expect(controller.getState().status).toBe('ready');
        expect(listeners.size).toBe(1);
        expect(services.subscribeResults).toHaveBeenCalledTimes(2);
    });

    test('Run All targets the latest valid companion message, which may be a user message', async () => {
        const { controller, services } = await mount(snapshot({ chat: [message(), message({}, { is_user: true })] }));
        await controller.runAll();
        expect(services.getLatestMessageIndex).toHaveBeenCalledTimes(1);
        expect(services.runAll).toHaveBeenCalledWith(1);
    });

    test('Run All warns with no target and never invokes the runner', async () => {
        const { controller, services } = await mount();
        await controller.runAll();
        expect(services.runAll).not.toHaveBeenCalled();
        expect(services.notify).toHaveBeenCalledWith('no-message');
    });

    test('global off prevents Run All while preserving Open Panel', async () => {
        const { controller, services } = await mount(snapshot({ enabled: false, chat: [message()] }));
        await controller.runAll();
        await controller.openPanel();
        expect(services.runAll).not.toHaveBeenCalled();
        expect(services.openPanel).toHaveBeenCalledTimes(1);
    });

    test('Run All disables while pending, ignores duplicate activation and reports no results', async () => {
        const pending = deferred();
        const { controller, services } = await mount(snapshot({ chat: [message()] }), { runAll: jest.fn(() => pending.promise) });
        const first = controller.runAll();
        expect(controller.getState().runAllDisabled).toBe(true);
        expect(await controller.runAll()).toBe(false);
        expect(services.runAll).toHaveBeenCalledTimes(1);
        pending.resolve({});
        await first;
        expect(controller.getState().runAllDisabled).toBe(false);
        expect(services.notify).toHaveBeenCalledWith('no-companions-ran');
    });

    test('Run All clears busy state on rejection without claiming success', async () => {
        const error = new Error('runner failed');
        const { controller, services } = await mount(snapshot({ chat: [message()] }), {
            runAll: jest.fn(async () => { throw error; }),
        });
        await expect(controller.runAll()).rejects.toThrow(error);
        expect(controller.getState().runAllDisabled).toBe(false);
        expect(services.notify).not.toHaveBeenCalled();
    });

    test('summary edit, panel and note jump delegate existing navigation services without running agents', async () => {
        const { controller, services } = await mount(snapshot({ agents: [companion('notes')] }));
        await controller.edit('notes');
        await controller.openPanel();
        await controller.jump(12);
        expect(services.openEditor).toHaveBeenCalledWith('notes');
        expect(services.openPanel).toHaveBeenCalledTimes(1);
        expect(services.jumpToMessage).toHaveBeenCalledWith(12);
        expect(services.runAll).not.toHaveBeenCalled();
    });

    test('destroyed controllers neither rerender when a run settles nor invoke late navigation actions', async () => {
        const pending = deferred();
        const { controller, services, onChange } = await mount(snapshot({ chat: [message()], agents: [companion('notes')] }), {
            runAll: jest.fn(() => pending.promise),
        });
        const running = controller.runAll();
        controller.destroy();
        const count = onChange.mock.calls.length;
        pending.resolve({});
        await running;
        await controller.edit('notes');
        await controller.openPanel();
        await controller.jump(0);
        controller.refresh();
        expect(onChange).toHaveBeenCalledTimes(count);
        expect(services.notify).not.toHaveBeenCalled();
        for (const name of ['openEditor', 'openPanel', 'jumpToMessage']) expect(services[name]).not.toHaveBeenCalled();
    });
});
