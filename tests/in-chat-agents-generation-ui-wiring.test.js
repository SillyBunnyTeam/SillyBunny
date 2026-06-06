import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'in-chat-agents', 'index.js'), 'utf8');

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
        expect(updateSource).toContain('deactivateSendButtons();');
        expect(updateSource).toContain('if (!is_send_press && !is_group_generating)');
        expect(updateSource).toContain('activateSendButtons();');
    });

    test('subscribes agent state changes and routes send-bar stop clicks to agent cancel', () => {
        expect(indexSource).toContain('onAgentGenerationStateChanged(refreshGenerationUi);');
        expect(indexSource).toContain("$(document).on('click', '#mes_stop'");
        expect(indexSource).toContain('cancelAgentGeneration();');
    });
});
