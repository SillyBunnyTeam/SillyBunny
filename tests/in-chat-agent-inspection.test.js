/** @jest-environment jsdom */
/* global globalThis */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import { EventEmitter } from '../public/lib/eventemitter.js';
import { event_types } from '../public/scripts/events.js';

if (typeof globalThis.structuredClone !== 'function') {
    globalThis.structuredClone = value => v8.deserialize(v8.serialize(value));
}
import {
    RUNTIME_AGENTS_IDENTIFIER,
    collectInChatAgentInspectionRecords,
    getInChatAgentContributionKind,
    instrumentInChatAgentPromptValue,
    resolveInChatAgentTokenUsage,
    trimOldestRetainedContribution,
} from '../public/scripts/in-chat-agent-inspection.js';
import { importOpenAiModule } from './util/openai-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = rel => fileURLToPath(new URL(`../public/${rel}`, import.meta.url));

describe('In-Chat Agent prompt inspection', () => {
    test('collects direct and embedded runtime contributions in assembled order', () => {
        const messages = [
            {
                identifier: 'main',
                role: 'system',
                content: 'Main prompt',
            },
            {
                identifier: 'inchat_agent_style',
                displayName: 'Style Agent',
                role: 'system',
                content: 'Use terse prose.',
            },
            {
                identifier: 'chatHistory-2',
                role: 'assistant',
                content: 'Reply\n\nRetained note',
                agentContributions: [
                    {
                        identifier: 'inchat_agent_companion_history_tracker',
                        name: 'World Tracker',
                        role: 'assistant',
                        content: 'Retained note',
                        kind: 'retained-history',
                    },
                    {
                        identifier: 'inchat_agent_companion_tracker_echo_guard',
                        name: 'Guard',
                        role: 'system',
                        content: 'Do not echo tracker blocks.',
                        kind: 'guard',
                    },
                ],
            },
        ];
        const before = structuredClone(messages);

        expect(collectInChatAgentInspectionRecords(messages)).toEqual([
            {
                identifier: 'inchat_agent_style',
                name: 'Style Agent',
                role: 'system',
                content: 'Use terse prose.',
                kind: 'inline',
            },
            {
                identifier: 'inchat_agent_companion_history_tracker',
                name: 'World Tracker',
                role: 'assistant',
                content: 'Retained note',
                kind: 'retained-history',
            },
            {
                identifier: 'inchat_agent_companion_tracker_echo_guard',
                name: 'Guard',
                role: 'system',
                content: 'Do not echo tracker blocks.',
                kind: 'guard',
            },
        ]);
        expect(messages).toEqual(before);
    });

    test('classifies Companion feedback separately from inline and retained content', () => {
        expect(getInChatAgentContributionKind('inchat_agent_writer')).toBe('inline');
        expect(getInChatAgentContributionKind('inchat_agent_companion_world')).toBe('feedback');
        expect(getInChatAgentContributionKind('inchat_agent_companion_history_world')).toBe('retained-history');
        expect(getInChatAgentContributionKind('inchat_agent_companion_tracker_echo_guard')).toBe('guard');
    });

    test('keeps boundary trim macros outside inspection markers', () => {
        const trimMacros = value => value.replace(/(?:\r?\n)*{{trim}}(?:\r?\n)*/gi, '');
        const source = `Before{{trim}}\n${'{{trim}}Agent body{{trim}}'}\n{{trim}}After`;
        const instrumentedAgent = instrumentInChatAgentPromptValue('{{trim}}Agent body{{trim}}', '<START>', '<END>');
        const instrumented = `Before{{trim}}\n${instrumentedAgent}\n{{trim}}After`;

        expect(instrumentedAgent).toBe('{{trim}}<START>Agent body<END>{{trim}}');
        expect(trimMacros(instrumented).replace('<START>', '').replace('<END>', '')).toBe(trimMacros(source));
    });

    test('drops the oldest retained note from a consolidated assistant message', () => {
        const contributions = [
            { kind: 'retained-history', content: 'Old note' },
            { kind: 'retained-history', content: 'New note' },
        ];

        expect(trimOldestRetainedContribution('Reply\n\nOld note\n\nNew note', contributions)).toEqual({
            content: 'Reply\n\nNew note',
            contributions: [contributions[1]],
            changed: true,
        });
    });

    test('does not remove matching prose from the original assistant reply', () => {
        const contributions = [
            { kind: 'retained-history', content: 'Repeated state' },
            { kind: 'retained-history', content: 'New note' },
        ];

        expect(trimOldestRetainedContribution('Repeated state in prose\n\nRepeated state\n\nNew note', contributions).content)
            .toBe('Repeated state in prose\n\nNew note');
    });

    test('trims normalized CRLF contribution content', () => {
        const contribution = { kind: 'retained-history', content: 'Old\nstate' };

        expect(trimOldestRetainedContribution('Reply\n\nOld\nstate', [contribution])).toEqual({
            content: 'Reply',
            contributions: [],
            changed: true,
        });
    });

    test('falls back to source counts while the runtime snapshot is unavailable', () => {
        expect(resolveInChatAgentTokenUsage(null, {
            main: 100,
            inchat_agent_style: 12,
            inchat_agent_companion_world: 8,
            inchat_agent_invalid: 'unknown',
        })).toBe(20);
    });

    test('treats an empty runtime snapshot as a valid zero-token result', () => {
        const runtimeMessages = { getTokens: () => 0 };

        expect(resolveInChatAgentTokenUsage(runtimeMessages, { inchat_agent_style: 12 })).toBe(0);
    });

    test('uses a complete runtime snapshot instead of source counts', () => {
        const runtimeMessages = { getTokens: () => 27 };

        expect(resolveInChatAgentTokenUsage(runtimeMessages, { inchat_agent_style: 12 })).toBe(27);
    });

    test('keeps the synthetic Agents row out of presets and the outbound root', async () => {
        const settingsSource = readFileSync(path.join(repoRoot, 'default', 'content', 'settings.json'), 'utf8');
        const presetSource = readFileSync(path.join(repoRoot, 'default', 'content', 'presets', 'openai', 'Default.json'), 'utf8');
        expect(RUNTIME_AGENTS_IDENTIFIER).toBe('sillybunnyRuntimeAgents');
        expect(settingsSource).not.toContain(RUNTIME_AGENTS_IDENTIFIER);
        expect(presetSource).not.toContain(RUNTIME_AGENTS_IDENTIFIER);

        if (typeof globalThis.window?.jQuery !== 'function') {
            (0, eval)(readFileSync(pub('lib/jquery-3.5.1.min.js'), 'utf8'));
            globalThis.$ = globalThis.window.jQuery;
            globalThis.jQuery = globalThis.window.jQuery;
            if (globalThis.$.fx) globalThis.$.fx.off = true;
            if (!globalThis.$.fn.sortable) globalThis.$.fn.sortable = jest.fn(function () { return this; });
        }
        document.body.innerHTML = `
            <input id="openai_max_context" type="number" value="4096" />
            <input id="openai_max_tokens" type="number" value="256" />
            <textarea id="main_prompt_quick_edit_textarea"></textarea>
            <textarea id="nsfw_prompt_quick_edit_textarea"></textarea>
            <textarea id="jailbreak_prompt_quick_edit_textarea"></textarea>
            <div id="completion_prompt_manager">
                <ul id="completion_prompt_manager_list"></ul>
            </div>
            <div id="completion_prompt_manager_popup" style="display:none;">
                <div id="completion_prompt_manager_popup_inspect" style="display:none;">
                    <div id="completion_prompt_manager_popup_entry_form_inspect_list"></div>
                </div>
                <div id="completion_prompt_manager_popup_edit" style="display:none;">
                    <input id="completion_prompt_manager_popup_entry_form_name" value="Main Prompt" />
                    <select id="completion_prompt_manager_popup_entry_form_role"><option value="system">system</option></select>
                    <textarea id="completion_prompt_manager_popup_entry_form_prompt"></textarea>
                    <div id="completion_prompt_manager_depth_block"><input id="completion_prompt_manager_popup_entry_form_injection_depth" value="4" /></div>
                    <div id="completion_prompt_manager_order_block"><input id="completion_prompt_manager_popup_entry_form_injection_order" value="100" /></div>
                    <select id="completion_prompt_manager_popup_entry_form_injection_position"><option value="0">0</option></select>
                    <div id="completion_prompt_manager_forbid_overrides_block"><input id="completion_prompt_manager_popup_entry_form_forbid_overrides" type="checkbox" /></div>
                    <select id="completion_prompt_manager_popup_entry_form_injection_trigger"></select>
                    <div id="completion_prompt_manager_popup_entry_source_block"><span id="completion_prompt_manager_popup_entry_source"></span></div>
                    <button id="completion_prompt_manager_popup_entry_form_save" type="button"></button>
                    <button id="completion_prompt_manager_popup_entry_form_reset" type="button"></button>
                    <button id="completion_prompt_manager_popup_entry_form_close" type="button"></button>
                </div>
                <button id="completion_prompt_manager_popup_close_button" type="button"></button>
                <button id="completion_prompt_manager_popup_preview_close_button" type="button"></button>
            </div>
        `;
        jest.resetModules();
        await jest.unstable_mockModule(pub('scripts/prompt-token-counts.js'), () => ({
            createCommentOnlyContentCheck: () => () => false,
            getPromptDisplayTokenCounts: () => ({}),
            getPromptSourceTokenCounts: async () => ({}),
            getRuntimePreparedPromptContent: () => '',
            mergePromptTokenCounts: () => ({}),
        }));
        await jest.unstable_mockModule(pub('scripts/prompt-manager-marker-preview.js'), () => ({
            getRenderedMarkerPrompt: () => '',
        }));
        await jest.unstable_mockModule(pub('scripts/prompt-manager-order.js'), () => ({
            reorderPromptOrder: order => order,
        }));
        await jest.unstable_mockModule(pub('scripts/prompt-variable-cleanup.js'), () => ({
            clearPromptSetVariables: () => {},
        }));
        const loaded = await importOpenAiModule({
            mockPromptManager: false,
            templates: {
                renderTemplateAsync: jest.fn(async name => {
                    if (name === 'promptManagerHeader') {
                        return '<div class="pm-header"></div><ul id="completion_prompt_manager_list"></ul>';
                    }
                    if (name === 'promptManagerListHeader') {
                        return '<li class="pm-list-header"></li>';
                    }
                    return '';
                }),
            },
        });
        const tokenizers = await import(pub('scripts/tokenizers.js'));
        tokenizers.countTokensOpenAIAsync.mockImplementation(async messages => {
            const list = Array.isArray(messages) ? messages : [messages];
            return list.reduce((sum, item) => sum + String(item?.content ?? '').trim().split(/\s+/).filter(Boolean).length, 0);
        });

        const { ChatCompletion, Message, MessageCollection, setupChatCompletionPromptManager, oai_settings } = loaded.openai;
        oai_settings.prompts = [{ identifier: 'main', name: 'Main Prompt', role: 'system', content: 'Main' }];
        oai_settings.prompt_order = [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }];
        setupChatCompletionPromptManager(oai_settings);
        const promptManager = loaded.openai.promptManager;

        const completion = new ChatCompletion();
        const mainMsg = await Message.fromPromptAsync({ identifier: 'main', role: 'system', content: 'Main' });
        const agentMsg = await Message.fromPromptAsync({
            identifier: 'inchat_agent_style',
            name: 'Style Agent',
            role: 'system',
            content: 'Keep dialogue brisk.',
        });
        const outbound = new MessageCollection('outbound');
        outbound.add(mainMsg);
        outbound.add(agentMsg);
        completion.messages = outbound;

        await completion.buildRuntimeAgentMessages();
        const runtimeCollection = completion.getRuntimeAgentMessages();
        expect(runtimeCollection).not.toBeNull();
        expect(runtimeCollection.getCollection()).toHaveLength(1);
        expect(runtimeCollection.getTokens()).toBeGreaterThan(0);
        // Outbound root must never have the detached runtime inspection collection added into it.
        expect(completion.messages.getCollection().includes(runtimeCollection)).toBe(false);

        // Token-count failure resets runtimeAgentMessages to null and logs a warning.
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const createSpy = jest.spyOn(Message, 'createAsync').mockRejectedValueOnce(new Error('boom'));
        await completion.buildRuntimeAgentMessages();
        expect(warnSpy).toHaveBeenCalledWith(
            '[PromptManager] Failed to count detached In-Chat Agent inspection tokens:',
            expect.any(Error),
        );
        expect(completion.getRuntimeAgentMessages()).toBeNull();
        createSpy.mockRestore();
        warnSpy.mockRestore();

        // Rebuild cleanly so PromptManager renders the synthetic read-only Agents row.
        await completion.buildRuntimeAgentMessages();
        promptManager.setChatCompletion(completion);
        await promptManager.render(false);

        const runtimeRow = document.querySelector(`#completion_prompt_manager_list li[data-pm-identifier="${RUNTIME_AGENTS_IDENTIFIER}"]`);
        expect(runtimeRow).not.toBeNull();
        expect(runtimeRow.dataset.pmRuntime).toBe('true');
        expect(runtimeRow.classList.contains('prompt-manager-runtime-row')).toBe(true);
        expect(runtimeRow.classList.contains('completion_prompt_manager_prompt_draggable')).toBe(false);
        expect(runtimeRow.querySelector('a.prompt-manager-inspect-action')?.textContent).toBe('Agents');
        expect(runtimeRow.querySelector('.prompt-manager-toggle-action')).toBeNull();
        expect(runtimeRow.querySelector('.prompt-manager-edit-action')).toBeNull();
        expect(runtimeRow.querySelector('.prompt_manager_prompt_controls')).toBeNull();
        expect(runtimeRow.querySelector('.prompt-manager-control-placeholder')).toBeNull();

        // Clicking inspect keeps the synthetic row open across refreshes and updates its inspect list.
        runtimeRow.querySelector('.prompt-manager-inspect-action').click();
        expect(promptManager.selectedPromptId).toBe(RUNTIME_AGENTS_IDENTIFIER);
        expect(promptManager.activePopupArea).toBe('inspect');
        const inspectList = document.getElementById('completion_prompt_manager_popup_entry_form_inspect_list');
        expect(inspectList.textContent).toContain('Keep dialogue brisk.');

        // Re-rendering does not close the inspect popup for the synthetic runtime identifier.
        await promptManager.render(false);
        expect(promptManager.selectedPromptId).toBe(RUNTIME_AGENTS_IDENTIFIER);
        expect(promptManager.activePopupArea).toBe('inspect');

        // Refreshing completion clears and repopulates the inspect list from the new snapshot.
        const secondCompletion = new ChatCompletion();
        const updatedOutbound = new MessageCollection('outbound');
        updatedOutbound.add(await Message.fromPromptAsync({
            identifier: 'inchat_agent_style',
            name: 'Style Agent',
            role: 'system',
            content: 'Updated runtime note.',
        }));
        secondCompletion.messages = updatedOutbound;
        await secondCompletion.buildRuntimeAgentMessages();
        promptManager.setChatCompletion(secondCompletion);
        expect(inspectList.textContent).toContain('Updated runtime note.');
        expect(inspectList.textContent).not.toContain('Keep dialogue brisk.');
    });

    test('keeps runtime rows outside Bunny Preset Tools sections', async () => {
        jest.resetModules();
        document.body.innerHTML = `
            <div id="completion_prompt_manager">
                <ul id="completion_prompt_manager_list">
                    <li class="completion_prompt_manager_prompt" data-pm-identifier="sec-1">
                        <span class="completion_prompt_manager_prompt_name"><a>=== Section One ===</a></span>
                    </li>
                    <li class="completion_prompt_manager_prompt" data-pm-identifier="prompt-1">
                        <span class="completion_prompt_manager_prompt_name"><a>Prompt One</a></span>
                    </li>
                    <li class="completion_prompt_manager_prompt prompt-manager-runtime-row bpt-section-item"
                        data-pm-identifier="${RUNTIME_AGENTS_IDENTIFIER}"
                        data-pm-runtime="true"
                        data-section-id="sec-1"
                        style="display: none;">
                        <span class="completion_prompt_manager_prompt_name"><a>Agents</a></span>
                    </li>
                </ul>
            </div>
        `;

        const trackedIntervals = [];
        const originalSetInterval = globalThis.setInterval;
        const originalRaf = globalThis.requestAnimationFrame;
        globalThis.setInterval = (...args) => {
            const id = originalSetInterval(...args);
            trackedIntervals.push(id);
            return id;
        };
        globalThis.requestAnimationFrame = callback => {
            callback(0);
            return 0;
        };

        try {
            const events = new EventEmitter();
            await jest.unstable_mockModule(pub('script.js'), () => ({
                chat_metadata: {},
                eventSource: events,
                event_types,
                getCurrentChatId: () => 'chat-1',
                saveSettingsDebounced: jest.fn(),
            }));
            await jest.unstable_mockModule(pub('scripts/extensions.js'), () => ({
                extension_settings: {},
                saveMetadataDebounced: jest.fn(),
            }));
            await jest.unstable_mockModule(pub('scripts/backgrounds.js'), () => ({
                background_settings: {},
            }));
            await jest.unstable_mockModule(pub('scripts/openai.js'), () => ({
                promptManager: {
                    activeCharacter: null,
                    serviceSettings: {
                        prompts: [
                            { identifier: 'sec-1', name: '=== Section One ===' },
                            { identifier: 'prompt-1', name: 'Prompt One' },
                        ],
                    },
                    getPromptOrderForCharacter: () => [
                        { identifier: 'sec-1', enabled: true },
                        { identifier: 'prompt-1', enabled: true },
                    ],
                },
            }));
            await jest.unstable_mockModule(pub('scripts/power-user.js'), () => ({
                power_user: {},
            }));

            await import(pub('scripts/extensions/third-party/BunnyPresetTools/content.js'));

            const promptRow = document.querySelector('li[data-pm-identifier="prompt-1"]');
            const runtimeRow = document.querySelector(`li[data-pm-identifier="${RUNTIME_AGENTS_IDENTIFIER}"]`);
            expect(promptRow.classList.contains('bpt-section-item')).toBe(true);
            expect(runtimeRow.classList.contains('bpt-section-item')).toBe(false);
            expect(runtimeRow.dataset.sectionId).toBeUndefined();
            expect(runtimeRow.style.display).toBe('');
        } finally {
            for (const id of trackedIntervals) clearInterval(id);
            globalThis.setInterval = originalSetInterval;
            globalThis.requestAnimationFrame = originalRaf;
        }
    });
});
