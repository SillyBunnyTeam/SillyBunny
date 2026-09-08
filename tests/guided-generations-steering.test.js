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
            chatId: 'test-chat',
            chat: [{ name: 'Bot', mes: 'Previous reply', swipes: ['Previous reply'], swipe_id: 0 }],
            chatMetadata: { script_injects: {} },
            executeSlashCommandsWithOptions: jest.fn(async (command) => {
                const injectMatch = String(command).match(/\/inject id=([^\s|]+)/);
                if (injectMatch) {
                    context.chatMetadata.script_injects[injectMatch[1]] = { value: command };
                }

                const flushMatch = String(command).match(/\/flushinject ([^\s|]+)/);
                if (flushMatch) {
                    delete context.chatMetadata.script_injects[flushMatch[1]];
                }
            }),
            groupId: null,
            groups: [],
            characters: [],
            callGenericPopup: jest.fn(async () => 0),
            POPUP_TYPE: { TEXT: 1 },
            messageFormatting: jest.fn(value => value),
            swipe: {
                right: jest.fn(async () => eventSource.emit(eventTypes.GENERATION_ENDED)),
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
            createElement: jest.fn(tagName => ({
                tagName,
                children: [],
                dataset: {},
                style: {},
                append(...children) { this.children.push(...children); },
            })),
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
            getCurrentProfileId: jest.fn(async () => ''),
            getPresetsForApiType: jest.fn(async () => []),
            getProfileApiType: jest.fn(async () => ''),
            getProfileById: jest.fn(() => null),
            getProfileList: jest.fn(async () => []),
            handleSwitching: jest.fn(async () => ({ switch: jest.fn(), restore: jest.fn() })),
            resolveStoredProfile: jest.fn(() => null),
        }));
    });

    test('guided response injects guidance only for the awaited generation', async () => {
        const { guidedResponse } = await import('../public/scripts/extensions/guided-generations/scripts/guidedResponse.js');

        await guidedResponse();

        expect(context.executeSlashCommandsWithOptions).toHaveBeenCalledTimes(2);
        const command = context.executeSlashCommandsWithOptions.mock.calls[0][0];
        expect(command).toContain('/inject id=gg-guided-response position=chat ephemeral=true scan=true depth=2 role=assistant GUIDE: aim for a colder, suspicious reply|');
        expect(command).toContain('/trigger await=true|');
        expect(context.executeSlashCommandsWithOptions).toHaveBeenLastCalledWith('/flushinject gg-guided-response');
        expect(context.chatMetadata.script_injects['gg-guided-response']).toBeUndefined();
        expect(textarea.value).toBe('aim for a colder, suspicious reply');
        expect(textarea.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'input' }));
    });

    test('guided swipe keeps guidance injected until the swipe generation starts', async () => {
        const { guidedSwipe } = await import('../public/scripts/extensions/guided-generations/scripts/guidedSwipe.js');

        await guidedSwipe();

        expect(context.executeSlashCommandsWithOptions).toHaveBeenCalledWith('/inject id=gg-guided-swipe position=chat ephemeral=true scan=true depth=3 role=assistant SWIPE GUIDE: aim for a colder, suspicious reply |');
        expect(context.swipe.right).toHaveBeenCalledTimes(1);
        expect(context.executeSlashCommandsWithOptions).toHaveBeenLastCalledWith('/flushinject gg-guided-swipe');
        expect(context.chatMetadata.script_injects['gg-guided-swipe']).toBeUndefined();
        expect(textarea.value).toBe('aim for a colder, suspicious reply');
        expect(textarea.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'input' }));
    });

    test('guided response cancels before injecting or generating when the group picker is dismissed', async () => {
        context.groupId = 'group';
        context.groups = [{ id: 'group', members: ['avatar.png'] }];
        context.characters = [{ name: 'Actual Character Name', avatar: 'avatar.png' }];
        const { guidedResponse } = await import('../public/scripts/extensions/guided-generations/scripts/guidedResponse.js');

        await guidedResponse();

        expect(context.callGenericPopup).toHaveBeenCalledTimes(1);
        expect(context.executeSlashCommandsWithOptions).not.toHaveBeenCalled();
        expect(textarea.value).toBe('aim for a colder, suspicious reply');
    });

    test('guided response targets the selected group position with missing avatars and duplicate numeric names', async () => {
        context.groupId = 'group';
        context.groups = [{ id: 'group', members: ['missing.png', 'first.png', 'second.png'] }];
        context.characters = [
            { name: 'Unused', avatar: 'unused.png' },
            { name: '2B | "Alias"', avatar: 'second.png' },
            { name: '2B | "Alias"', avatar: 'first.png' },
        ];
        context.callGenericPopup.mockResolvedValue(4);
        const { guidedResponse } = await import('../public/scripts/extensions/guided-generations/scripts/guidedResponse.js');

        await guidedResponse();

        const content = context.callGenericPopup.mock.calls[0][0];
        expect(content.textContent).toBe('Select member to respond as');
        expect(content.children[0].children.map(button => ({ text: button.textContent, result: button.dataset.result }))).toEqual([
            { text: '2B | "Alias"', result: '3' },
            { text: '2B | "Alias"', result: '4' },
        ]);
        const command = context.executeSlashCommandsWithOptions.mock.calls[0][0];
        expect(command).toContain('/trigger await=true 2|');
        expect(command).not.toContain('setglobalvar');
        expect(command).not.toContain('2B');
    });

    test('guided response does not fall back to automatic generation for an empty group', async () => {
        context.groupId = 'empty-group';
        context.groups = [{ id: 'empty-group', members: [] }];
        const { guidedResponse } = await import('../public/scripts/extensions/guided-generations/scripts/guidedResponse.js');

        await guidedResponse();

        expect(context.callGenericPopup).not.toHaveBeenCalled();
        expect(context.executeSlashCommandsWithOptions).not.toHaveBeenCalled();
    });

    test('changing chats while choosing a group member preserves the new draft and cancels generation', async () => {
        context.groupId = 'group';
        context.groups = [{ id: 'group', members: ['avatar.png'] }];
        context.characters = [{ name: 'Character', avatar: 'avatar.png' }];
        context.callGenericPopup.mockImplementation(async () => {
            context = { ...context, chatId: 'other-chat' };
            textarea.value = 'New chat draft';
            return 2;
        });
        const { guidedResponse } = await import('../public/scripts/extensions/guided-generations/scripts/guidedResponse.js');

        await guidedResponse();

        expect(context.executeSlashCommandsWithOptions).not.toHaveBeenCalled();
        expect(textarea.value).toBe('New chat draft');
    });

    test('guided swipe waits for core cleanup even after GENERATION_ENDED fires', async () => {
        let finishSwipe;
        const swipeFinished = new Promise(resolve => { finishSwipe = resolve; });
        let started;
        const swipeStarted = new Promise(resolve => { started = resolve; });
        context.swipe.right.mockImplementation(async () => {
            await eventSource.emit(eventTypes.GENERATION_ENDED);
            started();
            await swipeFinished;
        });
        const { guidedSwipe } = await import('../public/scripts/extensions/guided-generations/scripts/guidedSwipe.js');

        const pending = guidedSwipe();
        await swipeStarted;
        expect(context.chatMetadata.script_injects['gg-guided-swipe']).toBeDefined();
        expect(context.executeSlashCommandsWithOptions).toHaveBeenCalledTimes(1);

        finishSwipe();
        await pending;
        expect(context.chatMetadata.script_injects['gg-guided-swipe']).toBeUndefined();
        expect(eventSource.once).not.toHaveBeenCalled();
    });

    test('a rejected swipe clears guidance and restores the input without waiting for an event', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        context.swipe.right.mockRejectedValue(new Error('Swipe failed'));
        const { guidedSwipe } = await import('../public/scripts/extensions/guided-generations/scripts/guidedSwipe.js');

        await guidedSwipe();

        expect(context.chatMetadata.script_injects['gg-guided-swipe']).toBeUndefined();
        expect(textarea.value).toBe('aim for a colder, suspicious reply');
        expect(globalThis.alert).toHaveBeenCalledWith('Guided Swipe Error: Swipe failed');
        errorSpy.mockRestore();
    });

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

        expect(context.executeSlashCommandsWithOptions).toHaveBeenCalledTimes(2);
        const command = context.executeSlashCommandsWithOptions.mock.calls[0][0];
        expect(command).toContain('/inject id=gg-impersonate-voice position=chat ephemeral=true scan=true depth=0 role=system Guided Impersonate: generate only the next text-box message for {{user}}.');
        expect(command).toContain('The guided impersonation prompt is authoritative for grammatical person, narration style, length, and exclusions.');
        expect(command).toContain('If it asks for first, second, or third person, follow that requested perspective exactly.');
        expect(command).not.toContain('write only as {{user}} in first person');
        expect(command).toContain('/impersonate await=true Follow the guided impersonation prompt exactly when generating {{user}}\'s next text-box message.');
        expect(command).toContain('<guided_impersonation_prompt>');
        expect(command).toContain(promptTemplate.replace('{{input}}', 'aim for a colder, suspicious reply'));
        expect(command).toContain('</guided_impersonation_prompt>');
        expect(command).toContain('<helper_prefill_context>');
        expect(command).toContain('SYSTEM:\nStay terse.');
        expect(command).toContain('ASSISTANT:\nI \\| begin');
        expect(command).toContain('</helper_prefill_context>');
        expect(context.executeSlashCommandsWithOptions).toHaveBeenLastCalledWith('/flushinject gg-impersonate-voice');
    });

    test('failed impersonation clears its voice guide', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        context.executeSlashCommandsWithOptions.mockImplementation(async command => {
            if (command.includes('/impersonate await=true')) {
                context.chatMetadata.script_injects['gg-impersonate-voice'] = { value: 'Voice guide' };
                throw new Error('Impersonation failed');
            }
            delete context.chatMetadata.script_injects['gg-impersonate-voice'];
        });
        const { guidedImpersonate } = await import('../public/scripts/extensions/guided-generations/scripts/guidedImpersonate.js');

        await guidedImpersonate();

        expect(context.chatMetadata.script_injects['gg-impersonate-voice']).toBeUndefined();
        expect(context.executeSlashCommandsWithOptions).toHaveBeenLastCalledWith('/flushinject gg-impersonate-voice');
        errorSpy.mockRestore();
    });
});
