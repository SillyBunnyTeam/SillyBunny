/* global globalThis */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';

function createEventSource() {
    const handlers = new Map();

    return {
        once: jest.fn((event, handler) => {
            const eventHandlers = handlers.get(event) ?? [];
            eventHandlers.push(handler);
            handlers.set(event, eventHandlers);
        }),
        removeListener: jest.fn((event, handler) => {
            const eventHandlers = handlers.get(event) ?? [];
            handlers.set(event, eventHandlers.filter(item => item !== handler));
        }),
        emit: jest.fn(async (event, ...args) => {
            const eventHandlers = [...(handlers.get(event) ?? [])];
            handlers.set(event, []);
            for (const handler of eventHandlers) {
                await handler(...args);
            }
        }),
    };
}

describe('Guided Generations steering commands', () => {
    let textarea;
    let context;
    let eventSource;
    let eventTypes;
    let extensionSettings;

    beforeEach(async () => {
        jest.resetModules();
        jest.useRealTimers();

        class TestTextAreaElement {}
        globalThis.HTMLTextAreaElement = TestTextAreaElement;
        globalThis.Event = class Event {
            constructor(type, options = {}) {
                this.type = type;
                this.options = options;
            }
        };

        textarea = new TestTextAreaElement();
        textarea.value = 'aim for a colder, suspicious reply';
        textarea.dispatchEvent = jest.fn();

        eventTypes = {
            GENERATION_ENDED: 'generation_ended',
            GENERATION_STOPPED: 'generation_stopped',
            MESSAGE_SWIPED: 'message_swiped',
        };
        eventSource = createEventSource();

        context = {
            chat: [{ name: 'Bot', mes: 'Previous reply', swipes: ['Previous reply'], swipe_id: 0 }],
            chatMetadata: { script_injects: {} },
            executeSlashCommandsWithOptions: jest.fn(async (command) => {
                if (command.includes('/inject id=instruct')) {
                    context.chatMetadata.script_injects.instruct = { value: command };
                }

                if (command.includes('/flushinject instruct')) {
                    delete context.chatMetadata.script_injects.instruct;
                }
            }),
            groupId: null,
            groups: [],
            messageFormatting: jest.fn(value => value),
            swipe: {
                right: jest.fn(() => {
                    setTimeout(() => eventSource.emit(eventTypes.GENERATION_ENDED), 0);
                }),
            },
        };
        extensionSettings = {
            'guided-generations': {
                injectionEndRole: 'assistant',
                depthPromptGuidedResponse: 2,
                depthPromptGuidedSwipe: 3,
                promptGuidedResponse: 'GUIDE: {{input}}',
                promptGuidedSwipe: 'SWIPE GUIDE: {{input}}',
            },
        };

        globalThis.document = {
            getElementById: jest.fn(id => id === 'send_textarea' ? textarea : null),
            querySelector: jest.fn(() => null),
        };
        globalThis.alert = jest.fn();

        await jest.unstable_mockModule('../public/script.js', () => ({
            eventSource,
            event_types: eventTypes,
        }));
        await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
            extension_settings: extensionSettings,
            getContext: jest.fn(() => context),
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/guided-generations/scripts/presetUtils.js', () => ({
            getCurrentProfile: jest.fn(async () => ''),
            getPresetsForApiType: jest.fn(async () => []),
            getProfileApiType: jest.fn(async () => ''),
            getProfileList: jest.fn(async () => []),
            handleSwitching: jest.fn(async () => ({ switch: jest.fn(), restore: jest.fn() })),
        }));
    });

    test('guided response injects guidance only for the awaited generation', async () => {
        const { guidedResponse } = await import('../public/scripts/extensions/guided-generations/scripts/guidedResponse.js');

        await guidedResponse();

        expect(context.executeSlashCommandsWithOptions).toHaveBeenCalledTimes(2);
        const command = context.executeSlashCommandsWithOptions.mock.calls[0][0];
        expect(command).toContain('/inject id=instruct position=chat ephemeral=true scan=true depth=2 role=assistant GUIDE: aim for a colder, suspicious reply|');
        expect(command).toContain('/trigger await=true|');
        expect(context.executeSlashCommandsWithOptions).toHaveBeenLastCalledWith('/flushinject instruct');
        expect(context.chatMetadata.script_injects.instruct).toBeUndefined();
        expect(textarea.value).toBe('aim for a colder, suspicious reply');
        expect(textarea.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'input' }));
    });

    test('guided swipe keeps guidance injected until the swipe generation starts', async () => {
        const { guidedSwipe } = await import('../public/scripts/extensions/guided-generations/scripts/guidedSwipe.js');

        await guidedSwipe();

        expect(context.executeSlashCommandsWithOptions).toHaveBeenCalledWith('/inject id=instruct position=chat ephemeral=true scan=true depth=3 role=assistant SWIPE GUIDE: aim for a colder, suspicious reply |');
        expect(context.swipe.right).toHaveBeenCalledTimes(1);
        expect(context.executeSlashCommandsWithOptions).toHaveBeenLastCalledWith('/flushinject instruct');
        expect(context.chatMetadata.script_injects.instruct).toBeUndefined();
        expect(textarea.value).toBe('aim for a colder, suspicious reply');
        expect(textarea.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'input' }));
    });

    /* eslint-disable playwright/no-standalone-expect -- Jest test.each is not recognized by this Playwright rule. */
    test.each([
        ['first', 'FIRST PERSON: {{input}}'],
        ['second', 'SECOND PERSON: {{input}}'],
        ['third', 'THIRD PERSON: {{input}}'],
    ])('guided impersonate lets the prompt control %s-person perspective', async (_, promptTemplate) => {
        extensionSettings['guided-generations'].promptImpersonate1st = promptTemplate;
        extensionSettings['guided-generations'].helperPrefillMessages = `[system]
Stay terse.

[assistant]
I | begin`;

        const { guidedImpersonate } = await import('../public/scripts/extensions/guided-generations/scripts/guidedImpersonate.js');

        await guidedImpersonate();

        expect(context.executeSlashCommandsWithOptions).toHaveBeenCalledTimes(1);
        const command = context.executeSlashCommandsWithOptions.mock.calls[0][0];
        expect(command).toContain('/inject id=gg-impersonate-voice position=chat ephemeral=true scan=true depth=0 role=system Guided Impersonate: generate only the next text-box message for {{user}}.');
        expect(command).toContain('The guided impersonation prompt is authoritative for grammatical person, narration style, length, and exclusions.');
        expect(command).toContain('If it asks for first, second, or third person, follow that requested perspective exactly.');
        expect(command).not.toContain('write only as {{user}} in first person');
        expect(command).toContain('/impersonate await=true format=neutral Follow the guided impersonation prompt exactly when generating {{user}}\'s next text-box message.');
        expect(command).toContain('<guided_impersonation_prompt>');
        expect(command).toContain(promptTemplate.replace('{{input}}', 'aim for a colder, suspicious reply'));
        expect(command).toContain('</guided_impersonation_prompt>');
        expect(command).toContain('<helper_prefill_context>');
        expect(command).toContain('SYSTEM:\nStay terse.');
        expect(command).toContain('ASSISTANT:\nI \\| begin');
        expect(command).toContain('</helper_prefill_context>');
        expect(command).toContain('/flushinject gg-impersonate-voice |');
    });
    /* eslint-enable playwright/no-standalone-expect */
});
