/** @jest-environment jsdom */
/* global globalThis */
import { fileURLToPath } from 'node:url';
import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { importScriptModule } from './util/script-harness.js';

const pub = rel => fileURLToPath(new URL(`../public/${rel}`, import.meta.url));

/**
 * Shared peer mocks allowing real `public/scripts/utils.js` and `public/scripts/slash-commands.js`
 * to link against real `public/script.js` inside jsdom.
 */
function createSlashCommandMocks(commands) {
    return {
        'scripts/variables.js': {
            registerVariableCommands: jest.fn(),
            resolveVariable: jest.fn(),
        },
        'scripts/action-loader-slashcommands.js': {
            registerActionLoaderSlashCommands: jest.fn(),
        },
        'scripts/sillybunny-version-map.js': {
            mapSillyBunnyVersionToStEquivalent: value => value,
        },
        'scripts/sillybunny-editor/adapters/utility-dialogs.js': {
            iconPickerOptions: () => ({}),
        },
        'scripts/autocomplete/AutoComplete.js': {
            AutoComplete: class {},
            AUTOCOMPLETE_STATE: {},
        },
        'scripts/slash-commands/SlashCommandParser.js': {
            SlashCommandParser: class SlashCommandParser {
                static commands = {};
                static addCommand = jest.fn();
                static addCommandObject = jest.fn(cmd => {
                    commands.set(cmd.name, cmd);
                    SlashCommandParser.commands[cmd.name] = cmd;
                });
                getHelpString() { return ''; }
            },
        },
        'scripts/slash-commands/SlashCommand.js': {
            SlashCommand: { fromProps: props => props },
        },
        'scripts/slash-commands/SlashCommandArgument.js': {
            ARGUMENT_TYPE: { STRING: 'string', BOOLEAN: 'boolean', NUMBER: 'number', LIST: 'list', DICTIONARY: 'dictionary', CLOSURE: 'closure', SUBCOMMAND: 'subcommand', RANGE: 'range' },
            SlashCommandArgument: class SlashCommandArgument {
                constructor(...args) { this.args = args; }
                static fromProps(props) { return props; }
            },
            SlashCommandNamedArgument: class SlashCommandNamedArgument {
                constructor(...args) { this.args = args; }
                static fromProps(props) { return props; }
            },
        },
        'scripts/slash-commands/SlashCommandEnumValue.js': {
            SlashCommandEnumValue: class SlashCommandEnumValue {
                constructor(...args) { this.args = args; }
            },
            enumTypes: { enum: 'enum', name: 'name', command: 'command', getBasedOnIndex: () => 'enum' },
        },
        'scripts/slash-commands/SlashCommandCommonEnumsProvider.js': {
            commonEnumProviders: new Proxy({}, { get: () => () => () => [] }),
            commonEnumMatchProviders: new Proxy({}, { get: () => () => [] }),
            enumIcons: new Proxy({}, { get: () => '' }),
        },
        'scripts/slash-commands/SlashCommandReturnHelper.js': {
            slashCommandReturnHelper: {
                enumList: () => [],
                doReturn: jest.fn(async v => v),
            },
        },
        'scripts/slash-commands/SlashCommandClosure.js': { SlashCommandClosure: class {} },
        'scripts/slash-commands/SlashCommandClosureResult.js': { SlashCommandClosureResult: class {} },
        'scripts/slash-commands/SlashCommandAbortController.js': { SlashCommandAbortController: class {} },
        'scripts/slash-commands/SlashCommandNamedArgumentAssignment.js': { SlashCommandNamedArgumentAssignment: class {} },
        'scripts/slash-commands/SlashCommandBreakController.js': { SlashCommandBreakController: class {} },
        'scripts/slash-commands/SlashCommandExecutionError.js': { SlashCommandExecutionError: class extends Error {} },
        'scripts/slash-commands/SlashCommandDebugController.js': { SlashCommandDebugController: class {} },
        'scripts/slash-commands/SlashCommandScope.js': { SlashCommandScope: class {} },
        'scripts/slash-commands/SlashCommandParserError.js': { SlashCommandParserError: class extends Error {} },
    };
}

/**
 * Loads the real `/impersonate` command from `public/scripts/slash-commands.js`
 * wired to the real `public/script.js` live `is_send_press` binding and `Generate` pipeline.
 */
async function loadRealImpersonateHarness({ extensionSettings, context, restore }) {
    const commands = new Map();
    const sendOpenAIRequest = jest.fn(async () => ({
        choices: [{ message: { content: 'Generated reply' } }],
    }));

    const loaded = await importScriptModule({
        keepReal: ['scripts/utils.js', 'scripts/slash-commands.js'],
        fetch: jest.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({}),
            text: async () => '',
        })),
        mocks: {
            ...createSlashCommandMocks(commands),
            'scripts/extensions.js': {
                extension_settings: extensionSettings,
                getContext: jest.fn(() => context),
            },
            'scripts/openai.js': base => ({
                ...base,
                sendOpenAIRequest,
                prepareOpenAIMessages: jest.fn(async () => [[{ role: 'user', content: 'Guide' }], 10]),
            }),
            'scripts/extensions/guided-generations/scripts/presetUtils.js': {
                getCurrentProfile: jest.fn(async () => ''),
                getCurrentProfileId: jest.fn(async () => ''),
                getPresetsForApiType: jest.fn(async () => []),
                getProfileApiType: jest.fn(async () => ''),
                getProfileById: jest.fn(() => null),
                getProfileList: jest.fn(async () => []),
                handleSwitching: jest.fn(async () => ({ switch: jest.fn(), restore })),
                resolveStoredProfile: jest.fn(() => null),
            },
        },
    });

    loaded.script.changeMainAPI('openai');
    loaded.script.setOnlineStatus('connected');
    loaded.script.characters.push({ name: 'Bot', avatar: 'bot.png', description: '', personality: '', scenario: '', first_mes: 'Hi' });
    loaded.script.setCharacterId('0');
    loaded.script.chat.push({ name: 'Bot', is_user: false, mes: 'Previous reply' });
    loaded.script.setSendButtonState(true);

    const { initDefaultSlashCommands } = await import(pub('scripts/slash-commands.js'));
    initDefaultSlashCommands();
    const impersonateCommand = commands.get('impersonate');
    expect(impersonateCommand).toBeDefined();

    return {
        script: loaded.script,
        toastr: loaded.toastr,
        sendOpenAIRequest,
        command: impersonateCommand.callback,
    };
}

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
        emitAndWait: jest.fn(async () => {}),
    };
}

describe('Guided Generations steering commands', () => {
    let textarea;
    let context;
    let eventSource;
    let eventTypes;
    let extensionSettings;

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    beforeEach(async () => {
        jest.useRealTimers();

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
            note: { allowWIScan: false },
            'guided-generations': {
                injectionEndRole: 'assistant',
                depthPromptGuidedResponse: 2,
                depthPromptGuidedSwipe: 3,
                promptGuidedResponse: 'GUIDE: {{input}}',
                promptGuidedSwipe: 'SWIPE GUIDE: {{input}}',
            },
        };

        const loaded = await importScriptModule({
            eventSource,
            keepReal: ['scripts/utils.js', 'scripts/slash-commands.js'],
            mocks: {
                ...createSlashCommandMocks(new Map()),
                'scripts/extensions.js': {
                    extension_settings: extensionSettings,
                    getContext: jest.fn(() => context),
                },
                'scripts/extensions/guided-generations/scripts/presetUtils.js': {
                    getCurrentProfile: jest.fn(async () => ''),
                    getCurrentProfileId: jest.fn(async () => ''),
                    getPresetsForApiType: jest.fn(async () => []),
                    getProfileApiType: jest.fn(async () => ''),
                    getProfileById: jest.fn(() => null),
                    getProfileList: jest.fn(async () => []),
                    handleSwitching: jest.fn(async () => ({ switch: jest.fn(), restore: jest.fn() })),
                    resolveStoredProfile: jest.fn(() => null),
                },
            },
        });
        eventTypes = loaded.script.event_types;

        textarea = document.getElementById('send_textarea');
        textarea.value = 'aim for a colder, suspicious reply';
        jest.spyOn(textarea, 'dispatchEvent');
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

    test.each([
        ['missing chat context', () => { context.chat = undefined; }, 'Guided Swipe error: Could not get required context properties: chat'],
        ['empty chat', () => { context.chat = []; }, 'Guided Swipe error: Cannot access chat context'],
        ['missing swipe API', () => { context.swipe.right = undefined; }, 'Guided Swipe error: SillyTavern swipe generation API is not available'],
    ])('reports %s through a toast', async (_caseName, prepare, message) => {
        prepare();
        const { generateNewSwipe } = await import('../public/scripts/extensions/guided-generations/scripts/guidedSwipe.js');

        await generateNewSwipe();

        expect(globalThis.toastr.error).toHaveBeenCalledWith(message);
    });

    test('reports a missing swipe textarea through a toast', async () => {
        textarea.remove();
        const { guidedSwipe } = await import('../public/scripts/extensions/guided-generations/scripts/guidedSwipe.js');

        await guidedSwipe();

        expect(globalThis.toastr.error).toHaveBeenCalledWith('Guided Swipe error: Textarea not found');
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
        expect(content.firstChild.textContent).toBe('Select Member to Respond As');
        expect(Array.from(content.querySelectorAll('button')).map(button => ({ text: button.textContent, result: button.dataset.result }))).toEqual([
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
        expect(globalThis.toastr.error).toHaveBeenCalledWith('Guided Swipe error: Swipe failed');
        context.swipe.right.mockResolvedValue(undefined);
        await guidedSwipe();
        expect(context.swipe.right).toHaveBeenCalledTimes(2);
        errorSpy.mockRestore();
    });

    test.each([false, true])('overlapping swipe cannot replace or flush a pending guide (plain=%s)', async plain => {
        if (plain) textarea.value = '';
        let finish;
        const pendingSwipe = new Promise(resolve => { finish = resolve; });
        context.swipe.right.mockImplementationOnce(() => pendingSwipe);
        const { guidedSwipe } = await import('../public/scripts/extensions/guided-generations/scripts/guidedSwipe.js');
        const first = guidedSwipe();
        await Promise.resolve();
        await Promise.resolve();
        textarea.value = 'Second guide';
        await guidedSwipe();
        expect(context.swipe.right).toHaveBeenCalledTimes(1);
        expect(context.executeSlashCommandsWithOptions).toHaveBeenCalledTimes(plain ? 0 : 1);
        expect(context.chatMetadata.script_injects['gg-guided-swipe']?.value ?? '').not.toContain('Second guide');
        finish();
        await first;
        await guidedSwipe();
        expect(context.swipe.right).toHaveBeenCalledTimes(2);
    });

    test('swipe rejects overlap while injection itself is pending', async () => {
        let finish;
        const injecting = new Promise(resolve => { finish = resolve; });
        const execute = context.executeSlashCommandsWithOptions.getMockImplementation();
        context.executeSlashCommandsWithOptions.mockImplementationOnce(async command => {
            await injecting;
            await execute(command);
        });
        const { guidedSwipe } = await import('../public/scripts/extensions/guided-generations/scripts/guidedSwipe.js');
        const first = guidedSwipe();
        await guidedSwipe();
        expect(context.executeSlashCommandsWithOptions).toHaveBeenCalledTimes(1);
        expect(context.swipe.right).not.toHaveBeenCalled();
        finish();
        await first;
    });

    test.each(['missing input', 'injection', 'verification', 'cleanup', 'input event'])('swipe can retry after %s failure', async failure => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { guidedSwipe } = await import('../public/scripts/extensions/guided-generations/scripts/guidedSwipe.js');
        jest.useFakeTimers();
        if (failure === 'missing input') jest.spyOn(document, 'getElementById').mockReturnValueOnce(null);
        if (failure === 'injection') context.executeSlashCommandsWithOptions.mockRejectedValueOnce(new Error('Injection failed'));
        if (failure === 'verification') context.executeSlashCommandsWithOptions.mockResolvedValueOnce(undefined);
        if (failure === 'cleanup') {
            const execute = context.executeSlashCommandsWithOptions.getMockImplementation();
            context.executeSlashCommandsWithOptions.mockImplementationOnce(execute).mockRejectedValueOnce(new Error('Cleanup failed'));
        }
        if (failure === 'input event') textarea.dispatchEvent.mockImplementationOnce(() => { throw new Error('Input failed'); });
        const first = guidedSwipe().catch(() => {});
        await jest.advanceTimersByTimeAsync(800);
        await first;
        const expectedToasts = {
            injection: ['Guided Swipe error: Injection failed'],
            verification: ['Guided Swipe error: Could not verify instruction injection. Aborting swipe generation.'],
        }[failure] ?? [];
        expect(globalThis.toastr.error.mock.calls.map(([message]) => message)).toEqual(expect.arrayContaining(expectedToasts));
        context.swipe.right.mockClear();
        await guidedSwipe();
        expect(context.swipe.right).toHaveBeenCalledTimes(1);
        expect(context.chatMetadata.script_injects['gg-guided-swipe']).toBeUndefined();
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

    test('real core busy timeout settles guided impersonation, restores and permits a retry', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const restore = jest.fn();
        const { script, sendOpenAIRequest, command } = await loadRealImpersonateHarness({ extensionSettings, context, restore });
        textarea = document.getElementById('send_textarea');
        textarea.value = 'aim for a colder, suspicious reply';

        const execute = context.executeSlashCommandsWithOptions.getMockImplementation();
        context.executeSlashCommandsWithOptions.mockImplementation(async scriptText => {
            await execute(scriptText);
            if (scriptText.includes('/impersonate await=true')) await command({ await: 'true' }, 'Guide');
        });
        const { guidedImpersonate } = await import(pub('scripts/extensions/guided-generations/scripts/guidedImpersonate.js'));
        jest.useFakeTimers();

        let settled = false;
        const pending = guidedImpersonate().then(() => { settled = true; });
        await jest.advanceTimersByTimeAsync(10100);
        expect(settled).toBe(true);
        await pending;
        expect(sendOpenAIRequest).not.toHaveBeenCalled();
        expect(textarea.value).toBe('aim for a colder, suspicious reply');
        expect(context.chatMetadata.script_injects['gg-impersonate-voice']).toBeUndefined();
        expect(restore).toHaveBeenCalledTimes(1);

        script.setSendButtonState(false);
        const retry = guidedImpersonate();
        await jest.advanceTimersByTimeAsync(200);
        await retry;
        expect(sendOpenAIRequest).toHaveBeenCalledTimes(1);
        expect(textarea.value).toBe('Generated reply');
        expect(restore).toHaveBeenCalledTimes(2);
    });

    test('non-awaited core impersonation returns immediately and handles busy timeout and generation rejection', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const { script, toastr, sendOpenAIRequest, command } = await loadRealImpersonateHarness({
            extensionSettings,
            context,
            restore: jest.fn(),
        });
        jest.useFakeTimers();

        await expect(command({}, 'Guide')).resolves.toBe('');
        await jest.advanceTimersByTimeAsync(10100);
        expect(toastr.warning).toHaveBeenCalledTimes(1);
        expect(sendOpenAIRequest).not.toHaveBeenCalled();

        script.setSendButtonState(false);
        sendOpenAIRequest.mockRejectedValueOnce(new Error('Generation failed'));
        await expect(command({}, 'Guide')).resolves.toBe('');
        await jest.advanceTimersByTimeAsync(200);
        expect(sendOpenAIRequest).toHaveBeenCalledTimes(1);
    });
});
