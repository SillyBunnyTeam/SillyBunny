/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { importOpenAiModule } from './util/openai-harness.js';

const resolvePublic = relativePath => fileURLToPath(new URL(`../public/${relativePath}`, import.meta.url));
const jquerySource = readFileSync(resolvePublic('lib/jquery-3.5.1.min.js'), 'utf8');
(0, eval)(jquerySource);
$.fn.select2 = function () { return this; };
$.fn.sortable = function () { return this; };

// Load real PromptManager alongside real openai.js so both sides of displayName are exercised.
await jest.unstable_mockModule(resolvePublic('scripts/prompt-token-counts.js'), () => ({
    createCommentOnlyContentCheck: () => () => false,
    getPromptDisplayTokenCounts: () => ({}),
    getPromptSourceTokenCounts: () => ({}),
    getRuntimePreparedPromptContent: () => '',
    mergePromptTokenCounts: () => ({}),
}));
await jest.unstable_mockModule(resolvePublic('scripts/prompt-manager-marker-preview.js'), () => ({
    getRenderedMarkerPrompt: () => '',
}));
await jest.unstable_mockModule(resolvePublic('scripts/prompt-manager-order.js'), () => ({
    reorderPromptOrder: order => order,
}));
await jest.unstable_mockModule(resolvePublic('scripts/prompt-variable-cleanup.js'), () => ({
    clearPromptSetVariables: () => {},
}));
await jest.unstable_mockModule(resolvePublic('scripts/prompt-manager-lifecycle/index.js'), () => ({
    resolvePromptManagerRenderState: () => ({ shouldRender: false, shouldWaitForGeneration: false, shouldRunDryGenerate: false }),
    resolvePromptManagerScrollRestore: () => ({ shouldRestore: false, shouldRestoreAfterAnimationFrame: false, scrollPosition: 0 }),
}));

const { openai } = await importOpenAiModule({ mockPromptManager: false });
const { PromptManager } = await import('../public/scripts/PromptManager.js');

describe('prompt display names', () => {
    test('carries trimmed extension prompt names onto Message.displayName without leaking into outbound chat payloads', async () => {
        const extensionMessage = await openai.Message.fromPromptAsync({
            role: 'system',
            content: 'Extension injected guidance',
            identifier: 'ext_internal_id',
            name: '  Memory Summary  ',
            extension: true,
        });

        expect(extensionMessage.displayName).toBe('Memory Summary');
        expect(extensionMessage.name).toBeUndefined();

        const nonExtensionMessage = await openai.Message.fromPromptAsync({
            role: 'system',
            content: 'Regular system prompt',
            identifier: 'main',
            name: 'Main Prompt',
            extension: false,
        });
        expect(nonExtensionMessage.displayName).toBeUndefined();

        const namedChatMessage = await openai.Message.createAsync('user', 'Hello', 'chat_0');
        namedChatMessage.name = 'Alice';

        const collection = new openai.MessageCollection('test');
        collection.add(extensionMessage);
        collection.add(namedChatMessage);

        const collectionPayload = collection.getChat();
        expect(collectionPayload).toEqual([
            { role: 'system', content: 'Extension injected guidance' },
            { role: 'user', content: 'Hello', name: 'Alice' },
        ]);
        expect(collectionPayload[0]).not.toHaveProperty('displayName');

        const completion = new openai.ChatCompletion();
        completion.setTokenBudget(4096, 256);
        completion.add(collection);
        const chatPayload = completion.getChat();
        expect(chatPayload).toEqual([
            { role: 'system', content: 'Extension injected guidance' },
            { role: 'user', content: 'Hello', name: 'Alice' },
        ]);
        expect(chatPayload[0]).not.toHaveProperty('displayName');
    });

    test('renders displayName ahead of identifier in the PromptManager inspector', async () => {
        const extensionMessage = await openai.Message.fromPromptAsync({
            role: 'system',
            content: 'Short body',
            identifier: 'ext_internal_id',
            name: 'Memory Summary',
            extension: true,
        });
        const unnamedMessage = await openai.Message.fromPromptAsync({
            role: 'system',
            content: 'Another body',
            identifier: 'main_prompt',
            extension: false,
        });
        const collection = new openai.MessageCollection('inspect');
        collection.add(extensionMessage);
        collection.add(unnamedMessage);

        const manager = new PromptManager();
        manager.configuration = {
            prefix: 'completion_',
        };
        document.body.innerHTML = '<div id="completion_prompt_manager_popup_entry_form_inspect_list"></div>';
        manager.loadMessagesIntoInspectForm(collection);

        const titles = [...document.querySelectorAll('#completion_prompt_manager_popup_entry_form_inspect_list .inline-drawer-header span')]
            .map(node => node.textContent.trim());
        expect(titles[0]).toContain('Memory Summary');
        expect(titles[0]).not.toContain('ext_internal_id');
        expect(titles[1]).toContain('main_prompt');

        document.body.innerHTML = '';
    });
});
