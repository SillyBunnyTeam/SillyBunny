/* global globalThis */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import fs from 'node:fs';

const templateDir = new URL('../public/scripts/extensions/in-chat-agents/templates/', import.meta.url);

function readTemplate(filename) {
    return JSON.parse(fs.readFileSync(new URL(filename, templateDir), 'utf8'));
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
        removeListener: jest.fn(),
    };
}

describe('companion card ui', () => {
    let chat;
    let eventSource;
    let eventTypes;
    let agents;
    let sanitize;
    let encodeStyleTags;
    let decodeStyleTags;

    async function importCompanionUi() {
        jest.resetModules();

        sanitize = jest.fn(html => String(html));
        encodeStyleTags = jest.fn(text => String(text).replaceAll(/<style>(.+?)<\/style>/gims, (_, match) => {
            return `<custom-style>${encodeURIComponent(match)}</custom-style>`;
        }));
        decodeStyleTags = jest.fn((text, { prefix } = {}) => String(text).replaceAll(/<custom-style>(.+?)<\/custom-style>/gms, (_, match) => {
            return `<style data-prefix="${prefix}">${decodeURIComponent(match)}</style>`;
        }));

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

        await jest.unstable_mockModule('../public/scripts/chats.js', () => ({
            encodeStyleTags,
            decodeStyleTags,
        }));

        await jest.unstable_mockModule('../public/script.js', () => ({
            chat,
            saveChatDebounced: jest.fn(),
            substituteParams: jest.fn((value, options = {}) => String(value ?? '')
                .replaceAll('{{user}}', 'Traveler')
                .replaceAll('{{char}}', options.name2Override || 'Assistant')
                .replaceAll('{{original}}', options.original ?? '')),
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
            saveAgent: jest.fn(async () => {}),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js', () => ({
            COMPANION_RESULTS_UPDATED_EVENT: 'companion_results_updated',
            deleteCompanionResult: jest.fn(),
            getCompanionResults: jest.fn(message => message?.extra?.inChatAgentCompanionResults ?? {}),
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

    // DESIGN.md limits inline companion cards to regenerate, edit, copy, delete, and manual-run.
    // Hiding an agent lives in the companion panel; agent settings live behind Workspace.
    test('keeps inline card actions within the documented vocabulary', () => {
        const source = fs.readFileSync(new URL('../public/scripts/extensions/in-chat-agents/companion/companion-ui.js', import.meta.url), 'utf8');

        expect(source).not.toContain('data-action="hide"');
        expect(source).not.toContain('data-action="settings"');
        expect(source).not.toContain('configureCompanionCardUi');
    });

    test('beautifies Chat Only transcript speaker turns before markdown conversion', async () => {
        const chatOnlyTemplate = readTemplate('chat-only-companion.json');
        agents.push({
            id: 'chat-only',
            name: 'Chat Only',
            sourceTemplateId: 'tpl-chat-only-companion',
            execution: 'companion',
            regexScripts: chatOnlyTemplate.regexScripts,
        });
        const { formatCompanionContent } = await importCompanionUi();

        const html = formatCompanionContent('chat-only', {
            content: [
                'You: What are you going to do to him?',
                'Kaveh: I\'m going to give him a piece of my mind!',
                'Or... actually, I might just grab his hand and physically move it away.',
                'Alhaitham: Options are varied. I could file a formal complaint.',
            ].join('\n'),
            format: 'markdown',
        }, { name: 'Assistant' });

        expect(html).toContain('ica--chatonly-turn');
        expect(html).toContain('ica--chatonly-speaker');
        expect(html).toContain('ica--chatonly-message');
        expect(html).toContain('white-space:pre-wrap');
        expect(html).toContain('Kaveh');
        expect(html).toContain('Or... actually, I might just grab his hand');
        expect(html).toContain('Alhaitham');
        expect(html).not.toContain('Kaveh: I\'m going');
        expect(html).not.toContain('Alhaitham: Options are varied');
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

    test('resolves companion output macros with the source message context', async () => {
        const { formatCompanionContent } = await importCompanionUi();

        const html = formatCompanionContent('companion-tracker', {
            content: '{{user}} noticed {{char}} said {{original}}',
            format: 'markdown',
        }, { name: 'Aria', mes: 'the door is open' });

        expect(html).toBe('<md>Traveler noticed Aria said the door is open</md>');
    });

    test('resolves escaped companion output macro delimiters before rendering', async () => {
        const { formatCompanionContent } = await importCompanionUi();

        const html = formatCompanionContent('companion-tracker', {
            content: 'Objective: \\{\\{user\\}\\} ends up with &#123;&#123;char&#125;&#125;',
            format: 'markdown',
        }, { name: 'Aria', mes: 'the door is open' });

        expect(html).toBe('<md>Objective: Traveler ends up with Aria</md>');
    });

    test('keeps the active character macro when the source message is from the user', async () => {
        const { formatCompanionContent } = await importCompanionUi();

        const html = formatCompanionContent('companion-tracker', {
            content: '{{user}} asked {{char}} about {{original}}',
            format: 'markdown',
        }, { name: 'Traveler', is_user: true, mes: 'the hidden door' });

        expect(html).toBe('<md>Traveler asked Assistant about the hidden door</md>');
    });

    test('preserves style tags emitted by regex scripts in card bodies', async () => {
        agents[0].regexScripts = [{
            id: 'styled-card',
            scriptName: 'Styled Card',
            findRegex: '/\\[STYLE\\]/g',
            replaceString: '<style>.terminal { color: red; }</style><div class="terminal">stats</div>',
            placement: [2],
            disabled: false,
            markdownOnly: true,
            promptOnly: false,
            substituteRegex: 0,
        }];
        const { formatCompanionContent } = await importCompanionUi();

        const html = formatCompanionContent('companion-tracker', {
            content: '[STYLE]',
            format: 'html',
        }, { name: 'Aria' });

        expect(html).toContain('<style data-prefix=".ica--companion-body ">');
        expect(html).toContain('.terminal { color: red; }');
        expect(html).toContain('<div class="terminal">stats</div>');
        expect(sanitize).toHaveBeenCalledWith(expect.stringContaining('<custom-style>'), expect.anything());
        expect(encodeStyleTags).toHaveBeenCalled();
        expect(decodeStyleTags).toHaveBeenCalledWith(expect.stringContaining('<custom-style>'), { prefix: '.ica--companion-body ' });
    });

    test('scopes panel bodies with the tracker panel CSS prefix', async () => {
        agents[0].regexScripts = [{
            id: 'styled-card',
            scriptName: 'Styled Card',
            findRegex: '/\\[STYLE\\]/g',
            replaceString: '<style>.terminal { color: red; }</style><div class="terminal">stats</div>',
            placement: [2],
            disabled: false,
            markdownOnly: true,
            promptOnly: false,
            substituteRegex: 0,
        }];
        const { formatCompanionContent } = await importCompanionUi();

        const html = formatCompanionContent('companion-tracker', {
            content: '[STYLE]',
            format: 'html',
        }, { name: 'Aria' }, '.ica--tpanel-agent-body ');

        expect(html).toContain('<style data-prefix=".ica--tpanel-agent-body ">');
        expect(decodeStyleTags).toHaveBeenCalledWith(expect.stringContaining('<custom-style>'), { prefix: '.ica--tpanel-agent-body ' });
    });

    test('normalizes markerless Chatroom pipe streams before rendering', async () => {
        const chatroomTemplate = readTemplate('chatroom-companion.json');
        agents.push({
            id: 'chatroom',
            name: 'Chatroom',
            sourceTemplateId: 'tpl-chatroom-companion',
            execution: 'companion',
            regexScripts: chatroomTemplate.regexScripts,
        });
        const { formatCompanionContent } = await importCompanionUi();

        const html = formatCompanionContent('chatroom', {
            content: 'mixed|mixed @Rover_Stan/user/18/omg she\'s so precious/so sweet @Rinascita_Historian/user/42/The contrast is wild/analytical @CatEarEnthusiast/user/92/Kris is a real one/hype',
            format: 'html',
        }, { name: 'Assistant' });

        expect(html).toContain('Chatroom');
        expect(html).toContain('STYLE: mixed');
        expect(html).toContain('Rover_Stan');
        expect(html).toContain('omg she\'s so precious');
        expect(html).toContain('Rinascita_Historian');
        expect(html).toContain('The contrast is wild');
        expect(html).toContain('CatEarEnthusiast');
        expect(html).toContain('Kris is a real one');
        expect(html).not.toContain('mixed|mixed @Rover_Stan/user/18/');
    });

    test('cleans shifted Chatroom labels out of visible posts', async () => {
        const chatroomTemplate = readTemplate('chatroom-companion.json');
        agents.push({
            id: 'chatroom',
            name: 'Chatroom',
            sourceTemplateId: 'tpl-chatroom-companion',
            execution: 'companion',
            regexScripts: chatroomTemplate.regexScripts,
        });
        const { formatCompanionContent } = await importCompanionUi();

        const html = formatCompanionContent('chatroom', {
            content: [
                'chatroom-style|reddit',
                'chatroom|Laurus_Fan_99|meta|18|top comment|181|He\'s so pure!',
                'chatroom|Gale_Watcher|meta|42|reply|42|She looks exhausted.',
                'chatroom-end',
            ].join('\n'),
            format: 'html',
        }, { name: 'Assistant' });

        expect(html).toContain('Laurus_Fan_99');
        expect(html).toContain('Gale_Watcher');
        expect(html).toContain('top comment');
        expect(html).toContain('reply');
        expect(html).toContain('He\'s so pure!');
        expect(html).toContain('She looks exhausted.');
        expect(html).not.toContain('top comment|181|He\'s so pure!');
        expect(html).not.toContain('reply|42|She looks exhausted.');
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

    test('suppresses no-message Message Inbox results', async () => {
        agents.push({
            id: 'message-inbox',
            name: 'Message Inbox',
            sourceTemplateId: 'tpl-message-inbox-companion',
            execution: 'companion',
        });
        const { formatCompanionContent, isHiddenCompanionResult, isSuppressedCompanionResult } = await importCompanionUi();
        const emptyResult = { content: ' phone-none ', format: 'html', displayMode: 'panel' };

        expect(isSuppressedCompanionResult('message-inbox', emptyResult)).toBe(true);
        expect(isHiddenCompanionResult('message-inbox', emptyResult)).toBe(true);
        expect(formatCompanionContent('message-inbox', emptyResult)).toBe('');
        expect(isSuppressedCompanionResult('companion-tracker', emptyResult)).toBe(false);
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

    test('sends Chat Only card input as private side-chat context', async () => {
        agents.push({
            id: 'chat-only',
            name: 'Chat Only',
            sourceTemplateId: 'tpl-chat-only-companion',
            execution: 'companion',
        });
        chat.push({
            name: 'Assistant',
            mes: 'reply',
            is_user: false,
            is_system: false,
            extra: {
                inChatAgentCompanionResults: {
                    'chat-only': { content: 'You: Hey\n\nMona: I can hear you.', agentName: 'Chat Only' },
                },
            },
        });
        const { initCompanionCardUi } = await importCompanionUi();
        const runner = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        const actionButton = {};
        const docElement = { on: jest.fn(() => docElement) };
        const mesElement = { attr: jest.fn(name => (name === 'mesid' ? '0' : '')) };
        const inputField = { val: jest.fn(value => (value === undefined ? 'Are you actually okay?' : inputField)), prop: jest.fn(() => inputField) };
        const cardElement = { attr: jest.fn(name => (name === 'data-agent-id' ? 'chat-only' : '')), find: jest.fn(() => inputField) };
        const buttonElement = {
            attr: jest.fn(name => (name === 'data-action' ? 'chat-only-send' : '')),
            closest: jest.fn(selector => (selector === '.mes' ? mesElement : cardElement)),
            prop: jest.fn(() => buttonElement),
        };
        globalThis.$ = jest.fn(arg => (arg === globalThis.document ? docElement : arg === actionButton ? buttonElement : {
            length: 0,
            each: jest.fn(),
            on: jest.fn(),
            toggle: jest.fn(),
        }));

        initCompanionCardUi();
        const actionHandler = docElement.on.mock.calls.find(([, selector]) => selector === '.ica--companion-action, .ica--companion-control-action')[2];
        await actionHandler({ preventDefault: jest.fn(), stopPropagation: jest.fn(), currentTarget: actionButton });

        expect(runner.runCompanionAgentOnMessage).toHaveBeenCalledWith('chat-only', 0, expect.objectContaining({
            pendingContent: expect.stringContaining('You: Are you actually okay?'),
            extraContextSections: [expect.objectContaining({
                title: 'Chat Only side chat',
                content: expect.stringContaining('Mona: I can hear you.'),
            })],
        }));
        expect(runner.runCompanionAgentOnMessage.mock.calls[0][2].extraContextSections[0].content).toContain('You: Are you actually okay?');
        expect(inputField.val).toHaveBeenCalledWith('');
        expect(inputField.prop).toHaveBeenCalledWith('disabled', true);
        expect(inputField.prop).toHaveBeenCalledWith('disabled', false);
        expect(buttonElement.prop).toHaveBeenCalledWith('disabled', true);
        expect(buttonElement.prop).toHaveBeenCalledWith('disabled', false);
    });

    test('saves Plot Compass card objective before rerunning', async () => {
        const plotCompass = {
            id: 'plot-compass',
            name: 'Plot Compass',
            sourceTemplateId: 'tpl-plot-compass-companion',
            execution: 'companion',
            settings: { plotCompassObjective: 'Old objective' },
        };
        agents.push(plotCompass);
        chat.push({
            name: 'Assistant',
            mes: 'reply',
            is_user: false,
            is_system: false,
            extra: {
                inChatAgentCompanionResults: {
                    'plot-compass': { content: 'Plan', agentName: 'Plot Compass' },
                },
            },
        });
        const { initCompanionCardUi } = await importCompanionUi();
        const store = await import('../public/scripts/extensions/in-chat-agents/agent-store.js');
        const runner = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        const actionButton = {};
        const docElement = { on: jest.fn(() => docElement) };
        const mesElement = { attr: jest.fn(name => (name === 'mesid' ? '0' : '')) };
        const inputField = { val: jest.fn(value => (value === undefined ? 'Reach the tower' : inputField)), prop: jest.fn(() => inputField) };
        const cardElement = { attr: jest.fn(name => (name === 'data-agent-id' ? 'plot-compass' : '')), find: jest.fn(() => inputField) };
        const buttonElement = {
            attr: jest.fn(name => (name === 'data-action' ? 'plot-compass-save' : '')),
            closest: jest.fn(selector => (selector === '.mes' ? mesElement : cardElement)),
            prop: jest.fn(() => buttonElement),
        };
        globalThis.$ = jest.fn(arg => (arg === globalThis.document ? docElement : arg === actionButton ? buttonElement : {
            length: 0,
            each: jest.fn(),
            on: jest.fn(),
            toggle: jest.fn(),
        }));

        initCompanionCardUi();
        const actionHandler = docElement.on.mock.calls.find(([, selector]) => selector === '.ica--companion-action, .ica--companion-control-action')[2];
        await actionHandler({ preventDefault: jest.fn(), stopPropagation: jest.fn(), currentTarget: actionButton });

        expect(plotCompass.settings.plotCompassObjective).toBe('Reach the tower');
        expect(store.saveAgent).toHaveBeenCalledWith(expect.objectContaining({
            id: 'plot-compass',
            settings: expect.objectContaining({ plotCompassObjective: 'Reach the tower' }),
        }));
        expect(runner.runCompanionAgentOnMessage).toHaveBeenCalledWith('plot-compass', 0);
        expect(globalThis.toastr.success).toHaveBeenCalledWith('Plot Objective saved.');
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
