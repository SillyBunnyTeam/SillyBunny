import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'in-chat-agents', 'index.js'), 'utf8');
const publicIndexSource = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const companionUiSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'in-chat-agents', 'companion', 'companion-ui.js'), 'utf8');
const extensionStyleSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'in-chat-agents', 'style.css'), 'utf8');
const editorTemplateSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'in-chat-agents', 'editor.html'), 'utf8');

function getFunctionSource(name) {
    const marker = `function ${name}(`;
    const start = indexSource.indexOf(marker);

    expect(start).toBeGreaterThanOrEqual(0);

    const bodyStart = indexSource.indexOf(') {', start) + 2;
    let depth = 0;

    for (let index = bodyStart; index < indexSource.length; index++) {
        const char = indexSource[index];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return indexSource.slice(start, index + 1);
            }
        }
    }

    throw new Error(`Unable to find function source for ${name}`);
}

describe('in-chat agents generation UI wiring', () => {
    test('uses the shared send-button lifecycle for agent activity', () => {
        const updateSource = getFunctionSource('updateAgentGenerationSendControls');

        expect(indexSource).toContain('activateSendButtons');
        expect(indexSource).toContain('deactivateSendButtons');
        expect(updateSource).toContain('deactivateSendButtons({ markBodyGenerating: false });');
        expect(updateSource).toContain('if (!is_send_press && !is_group_generating)');
        expect(updateSource).toContain('activateSendButtons();');
    });

    test('subscribes agent state changes and routes send-bar stop clicks to agent cancel', () => {
        expect(indexSource).toContain('onAgentGenerationStateChanged(refreshGenerationUi);');
        expect(indexSource).toContain('$(document).on(\'click\', \'#mes_stop\'');
        expect(indexSource).toContain('cancelAgentGeneration();');
    });

    test('refreshes generation UI from core events without forwarding payloads', () => {
        expect(indexSource).toContain('event_types.GENERATION_STARTED');
        expect(indexSource).toContain('event_types.GENERATION_ENDED');
        expect(indexSource).toContain('event_types.GENERATION_STOPPED');
        expect(indexSource).toContain('eventSource.on(eventName, () => refreshGenerationUi());');
        expect(indexSource).not.toContain('eventSource.on(eventName, refreshGenerationUi);');
    });

    test('wires companion message cards and actions into chat rendering', () => {
        expect(publicIndexSource).toContain('mes_run_companions');
        expect(companionUiSource).toContain('renderCompanionResultsForMessage');
        expect(companionUiSource).toContain('ica--companion-ledger');
        expect(companionUiSource).toContain('data-action="regenerate"');
        expect(companionUiSource).toContain('updateCompanionResult(message, agentId');
        expect(extensionStyleSource).toContain('.ica--companion-card');
        expect(extensionStyleSource).toContain('.mes_run_companions--running');
    });

    test('wires companion AI Maker in the editor', () => {
        expect(editorTemplateSource).toContain('ica--editor-companion-maker');
        expect(editorTemplateSource).toContain('AI Maker');
        expect(indexSource).toContain('generateCompanionKitWithAI');
        expect(indexSource).toContain('Applied generated companion. Review and save when ready.');
    });

    test('keeps companion settings labels clear and aligned', () => {
        expect(editorTemplateSource).toContain('ica--companion-core-grid');
        expect(extensionStyleSource).toContain('.ica--companion-core-grid');
        expect(extensionStyleSource).toContain('grid-template-columns: repeat(4, minmax(0, 1fr));');
        expect(editorTemplateSource).toContain('Run selected companions in one request');
        expect(editorTemplateSource).toContain('Batch With Enabled Companions');
        expect(editorTemplateSource).toContain('Turn it on to fetch currently enabled compatible companions');
        expect(editorTemplateSource).not.toContain('Batch with compatible companions');
    });

    test('labels companion agent cards as side execution', () => {
        const labelSource = getFunctionSource('getAgentCardPhaseLabel');

        expect(labelSource).toContain('isCompanionAgent(agent)');
        expect(labelSource).toContain("return 'side';");
        expect(indexSource).toContain('getAgentCardPhaseLabel(agent)');
    });
});
