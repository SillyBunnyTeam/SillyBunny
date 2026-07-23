import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    RUNTIME_AGENTS_IDENTIFIER,
    collectInChatAgentInspectionRecords,
    getInChatAgentContributionKind,
    instrumentInChatAgentPromptValue,
} from '../public/scripts/in-chat-agent-inspection.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

    test('keeps the synthetic Agents row out of presets and the outbound root', () => {
        const promptManagerSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'PromptManager.js'), 'utf8');
        const openaiSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'openai.js'), 'utf8');
        const settingsSource = readFileSync(path.join(repoRoot, 'default', 'content', 'settings.json'), 'utf8');
        const presetSource = readFileSync(path.join(repoRoot, 'default', 'content', 'presets', 'openai', 'Default.json'), 'utf8');
        const rowStart = promptManagerSource.indexOf('const runtimeAgentTokens');
        const rowEnd = promptManagerSource.indexOf('if (!this.#isRenderCurrent', rowStart);
        const rowSource = promptManagerSource.slice(rowStart, rowEnd);

        expect(RUNTIME_AGENTS_IDENTIFIER).toBe('sillybunnyRuntimeAgents');
        expect(rowSource).toContain('>Agents</a>');
        expect(rowSource).toContain('prompt-manager-inspect-action');
        expect(rowSource).toContain('prompt-manager-runtime-row');
        expect(rowSource).toContain('data-pm-runtime="true"');
        expect(rowSource).not.toContain('prompt_manager_prompt_draggable');
        expect(rowSource).not.toContain('prompt-manager-toggle-action');
        expect(rowSource).not.toContain('prompt-manager-edit-action');
        expect(rowSource).not.toContain('prompt_manager_prompt_controls');
        expect(rowSource).not.toContain('<span class="prompt-manager-control-placeholder" aria-hidden="true"></span>\n                <span class="${prefix}prompt_manager_prompt_name"');
        expect(promptManagerSource).toContain("this.selectedPromptId !== RUNTIME_AGENTS_IDENTIFIER && !this.getPromptById(this.selectedPromptId)");
        expect(promptManagerSource).toContain("this.selectedPromptId === RUNTIME_AGENTS_IDENTIFIER && this.activePopupArea === 'inspect'");
        expect(promptManagerSource).toContain("messageList.innerHTML = '';\n                this.loadMessagesIntoInspectForm(this.runtimeAgentMessages);");
        expect(openaiSource).toContain('this.runtimeAgentMessages = runtimeMessages;');
        expect(openaiSource).toContain("console.warn('[PromptManager] Failed to count detached In-Chat Agent inspection tokens:'");
        expect(openaiSource).not.toContain('this.messages.add(runtimeMessages)');
        expect(settingsSource).not.toContain(RUNTIME_AGENTS_IDENTIFIER);
        expect(presetSource).not.toContain(RUNTIME_AGENTS_IDENTIFIER);
    });

    test('keeps runtime rows outside Bunny Preset Tools sections', () => {
        const presetToolsSource = readFileSync(path.join(
            repoRoot,
            'public',
            'scripts',
            'extensions',
            'third-party',
            'BunnyPresetTools',
            'content.js',
        ), 'utf8');

        expect(presetToolsSource).toContain(".filter(row => row.dataset.pmRuntime !== 'true');");
        expect(presetToolsSource).toContain("querySelectorAll(':scope > li[data-pm-runtime=\"true\"]')");
    });
});
