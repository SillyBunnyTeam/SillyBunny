import vm from 'node:vm';
import { describe, expect, jest, test } from '@jest/globals';

import { RUNTIME_AGENTS_IDENTIFIER, collectInChatAgentInspectionRecords } from '../public/scripts/in-chat-agent-inspection.js';
import { loadDeclarations } from './util/load-declarations.js';

function deferred() {
    let resolve;
    const promise = new Promise(res => { resolve = res; });
    return { promise, resolve };
}

const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('Agents row data of the Prompt Manager', () => {
    function loadChatCompletion() {
        const gate = deferred();
        const countAsync = jest.fn(async message => {
            await gate.promise;
            return String(message.content).split(/\s+/).filter(Boolean).length;
        });
        const context = vm.createContext({
            console, Promise, Array, Object, Map, Number, String,
            RUNTIME_AGENTS_IDENTIFIER, collectInChatAgentInspectionRecords,
            tokenHandler: { countAsync },
        });
        loadDeclarations(context, 'scripts/openai.js', ['Message', 'MessageCollection', 'ChatCompletion']);
        return {
            gate,
            countAsync,
            ChatCompletion: vm.runInContext('ChatCompletion', context),
            Message: vm.runInContext('Message', context),
            MessageCollection: vm.runInContext('MessageCollection', context),
        };
    }

    async function createPrompt({ Message, MessageCollection, ChatCompletion }) {
        const completion = new ChatCompletion();
        const style = new Message('system', 'Use terse prose.', 'inchat_agent_style');
        style.displayName = 'Style Agent';
        const reply = new Message('assistant', 'Reply\n\nRetained note', 'chatHistory-2');
        reply.agentContributions = [{
            identifier: 'inchat_agent_companion_history_tracker', name: 'World Tracker', role: 'assistant',
            content: 'Retained note', kind: 'retained-history',
        }];
        completion.add(new MessageCollection('inchat_agent_style', style));
        completion.add(new MessageCollection('chatHistory', reply));
        return completion;
    }

    test('the collection holds every record before any token count has finished', async () => {
        const classes = loadChatCompletion();
        const completion = await createPrompt(classes);

        const counts = completion.buildRuntimeAgentMessages();
        const collection = completion.getRuntimeAgentMessages();

        expect(collection).not.toBeNull();
        expect(collection.getCollection().map(message => ({
            name: message.displayName, role: message.role, content: message.content, kind: message.kind, tokens: message.getTokens(),
        }))).toEqual([
            { name: 'Style Agent', role: 'system', content: 'Use terse prose.', kind: 'inline', tokens: 0 },
            { name: 'World Tracker', role: 'assistant', content: 'Retained note', kind: 'retained-history', tokens: 0 },
        ]);

        classes.gate.resolve();
        await expect(counts).resolves.toBe(collection);
        expect(collection.getCollection().map(message => message.getTokens())).toEqual([3, 2]);
        expect(collection.getTokens()).toBe(5);
    });

    test('a prompt without agent records gives an empty collection', async () => {
        const classes = loadChatCompletion();
        const completion = new classes.ChatCompletion();

        classes.gate.resolve();
        await completion.buildRuntimeAgentMessages();

        expect(completion.getRuntimeAgentMessages().getCollection()).toEqual([]);
    });
});

describe('Agents row data on a send made while the Prompt Manager is closed', () => {
    function loadPrepareOpenAIMessages({ panelShown = false } = {}) {
        const gate = deferred();
        const runtimeMessages = { getCollection: () => [{}] };
        const promptManager = {
            activeCharacter: {},
            activePopupArea: panelShown ? 'inspect' : null,
            serviceSettings: { openai_max_context: 32768, openai_max_tokens: 1024 },
            runtimeAgentMessages: null,
            tokenHandler: { counts: {} },
            setChatCompletion: jest.fn(completion => { promptManager.runtimeAgentMessages = completion.getRuntimeAgentMessages(); }),
            render: jest.fn(),
        };
        const buildRuntimeAgentMessages = jest.fn(function () {
            this.runtimeAgentMessages = runtimeMessages;
            return gate.promise.then(() => runtimeMessages);
        });
        class ChatCompletion {
            setTokenBudget() {}
            buildRuntimeAgentMessages = buildRuntimeAgentMessages;
            getRuntimeAgentMessages() { return this.runtimeAgentMessages; }
            getChat() { return []; }
        }
        const context = vm.createContext({
            console, Promise,
            promptManager, ChatCompletion,
            power_user: {}, oai_settings: { squash_system_messages: false },
            eventSource: { emit: async () => {} }, event_types: { CHAT_COMPLETION_PROMPT_READY: 'prompt_ready' },
            preparePromptsForChatCompletion: async () => [], populateChatCompletion: async () => {},
            shouldCheckPostInterceptChatBudget: () => false,
            TokenBudgetExceededError: class extends Error {}, InvalidCharacterNameError: class extends Error {},
            toastr: { error: jest.fn(), warning: jest.fn() }, t: strings => strings.join(''),
            document: {}, openai_messages_count: 0,
        });
        loadDeclarations(context, 'scripts/openai.js', ['prepareOpenAIMessages']);
        return { context, gate, promptManager, runtimeMessages, buildRuntimeAgentMessages };
    }

    test('the send does not wait for the counts, and the panel is redrawn when they finish', async () => {
        const { context, gate, promptManager, runtimeMessages } = loadPrepareOpenAIMessages();

        await context.prepareOpenAIMessages({ messages: [] }, false);

        expect(promptManager.runtimeAgentMessages).toBe(runtimeMessages);
        expect(promptManager.setChatCompletion).toHaveBeenCalledTimes(1);
        expect(promptManager.render).toHaveBeenCalledTimes(1);

        gate.resolve();
        await flush();

        expect(promptManager.setChatCompletion).toHaveBeenCalledTimes(2);
        expect(promptManager.render).toHaveBeenCalledTimes(2);
        expect(promptManager.runtimeAgentMessages).toBe(runtimeMessages);
    });

    test('a newer prompt that took over the panel is not redrawn by older counts', async () => {
        const { context, gate, promptManager } = loadPrepareOpenAIMessages();

        await context.prepareOpenAIMessages({ messages: [] }, false);
        promptManager.runtimeAgentMessages = { getCollection: () => [{}] };
        gate.resolve();
        await flush();

        expect(promptManager.setChatCompletion).toHaveBeenCalledTimes(1);
        expect(promptManager.render).toHaveBeenCalledTimes(1);
    });

    test('a send without agent records does not redraw the panel a second time', async () => {
        const { context, gate, promptManager, runtimeMessages } = loadPrepareOpenAIMessages();
        runtimeMessages.getCollection = () => [];

        await context.prepareOpenAIMessages({ messages: [] }, false);
        gate.resolve();
        await flush();

        expect(promptManager.render).toHaveBeenCalledTimes(1);
    });

    test('a send while the inspector is open waits for the counts so that the panel shows them at once', async () => {
        const { context, gate, promptManager } = loadPrepareOpenAIMessages({ panelShown: true });

        let settled = false;
        const send = context.prepareOpenAIMessages({ messages: [] }, false).then(() => { settled = true; });
        await flush();
        expect(settled).toBe(false);
        expect(promptManager.setChatCompletion).not.toHaveBeenCalled();

        gate.resolve();
        await send;

        expect(promptManager.setChatCompletion).toHaveBeenCalledTimes(1);
        expect(promptManager.render).toHaveBeenCalledTimes(1);
    });
});
