import vm from 'node:vm';
import { describe, expect, jest, test } from '@jest/globals';
import { loadDeclarations } from '../util/load-declarations.js';

function createSlashCommandContext() {
    const events = [];
    const injectsWhenNotified = [];
    const eventHandlers = new Map();
    const chat_metadata = {};
    const context = vm.createContext({
        chat_metadata,
        extension_prompt_types: { BEFORE_PROMPT: 0, IN_PROMPT: 1, IN_CHAT: 2, NONE: -1 },
        extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
        isTrueBoolean: value => String(value).toLowerCase() === 'true',
        SlashCommandClosure: class {},
        closureToFilter: () => () => true,
        setExtensionPrompt: jest.fn(),
        saveMetadataDebounced: jest.fn(),
        event_types: { GENERATION_ENDED: 'generation_ended', GENERATION_STOPPED: 'generation_stopped' },
        eventSource: {
            once: (name, handler) => {
                if (!eventHandlers.has(name)) eventHandlers.set(name, []);
                eventHandlers.get(name).push(handler);
            },
        },
        t: (strings, ...values) => strings.reduce((out, part, index) => out + part + (values[index] ?? ''), ''),
        console: { log: () => {} },
        CustomEvent: class { constructor(type) { this.type = type; } },
        Math,
        String,
        Number,
        document: {
            dispatchEvent: (event) => {
                events.push(event.type);
                injectsWhenNotified.push(Object.keys(chat_metadata.script_injects ?? {}));
            },
        },
    });
    context.globalThis = context;
    loadDeclarations(context, 'scripts/slash-commands.js', [
        'SCRIPT_PROMPT_KEY',
        'SCRIPT_INJECTS_CHANGED_EVENT',
        'notifyScriptInjectsChanged',
        'injectCallback',
        'flushInjectsCallback',
    ]);
    return {
        chat_metadata,
        events,
        injectsWhenNotified,
        eventHandlers,
        inject: vm.runInContext('injectCallback', context),
        flush: vm.runInContext('flushInjectsCallback', context),
    };
}

describe('script injects tell the page when they change', () => {
    test('/inject announces a new inject and the removal of one', () => {
        const { inject, events, chat_metadata } = createSlashCommandContext();

        inject({ id: 'gg-guided-response' }, 'guide text');
        expect(events).toEqual(['sb:guided-generations-guides-changed']);
        expect(Object.keys(chat_metadata.script_injects)).toEqual(['gg-guided-response']);

        inject({ id: 'gg-guided-response' }, '');
        expect(events).toHaveLength(2);
        expect(chat_metadata.script_injects).toEqual({});
    });

    test('/flushinject announces after the injects are gone', () => {
        const { inject, flush, events, injectsWhenNotified } = createSlashCommandContext();
        inject({ id: 'a' }, 'one');
        inject({ id: 'b' }, 'two');
        events.length = 0;
        injectsWhenNotified.length = 0;

        flush({}, 'a');
        expect(events).toHaveLength(1);
        expect(injectsWhenNotified[0]).toEqual(['b']);

        flush({}, '');
        expect(events).toHaveLength(2);
        expect(injectsWhenNotified[1]).toEqual([]);
    });

    test('an ephemeral inject announces its removal after the generation ends, with the inject already gone', () => {
        const { inject, events, injectsWhenNotified, eventHandlers } = createSlashCommandContext();
        inject({ id: 'gg-guided-swipe', ephemeral: 'true' }, 'guide text');
        expect(events).toHaveLength(1);
        expect(injectsWhenNotified[0]).toEqual(['gg-guided-swipe']);

        for (const handler of eventHandlers.get('generation_ended')) handler();
        expect(events).toHaveLength(2);
        expect(injectsWhenNotified[1]).toEqual([]);
    });
});
