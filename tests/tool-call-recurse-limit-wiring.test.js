import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const openAiSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'openai.js'), 'utf8');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');

function getFunctionSource(name) {
    const marker = `function ${name}(`;
    const start = openAiSource.indexOf(marker);

    expect(start).toBeGreaterThanOrEqual(0);

    const bodyStart = openAiSource.indexOf(') {', start) + 2;
    let depth = 0;

    for (let index = bodyStart; index < openAiSource.length; index++) {
        const char = openAiSource[index];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return openAiSource.slice(start, index + 1);
            }
        }
    }

    throw new Error(`Unable to find function source for ${name}`);
}

describe('tool call recurse limit wiring', () => {
    test('defaults the slider and number counter to the real runtime cap', () => {
        expect(indexHtml).toContain('id="tool_call_recurse_limit"');
        expect(indexHtml).toContain('id="tool_call_recurse_limit" name="tool_call_recurse_limit" min="1" max="50" step="1" value="5"');
        expect(indexHtml).toContain('id="tool_call_recurse_limit_counter" value="5"');
    });

    test('maps the control through OpenAI preset settings', () => {
        expect(openAiSource).toContain("tool_call_recurse_limit: ['#tool_call_recurse_limit', 'tool_call_recurse_limit', false, false]");
        expect(openAiSource).toContain('tool_call_recurse_limit: TOOL_CALL_RECURSE_LIMIT_DEFAULT');
    });

    test('loads and changes the setting through ToolManager.RECURSE_LIMIT', () => {
        const loadSource = getFunctionSource('loadOpenAISettings');
        const initSource = getFunctionSource('initOpenAI');
        const applySource = getFunctionSource('applyToolCallRecurseLimit');

        expect(applySource).toContain('ToolManager.RECURSE_LIMIT = recurseLimit;');
        expect(loadSource).toContain('applyToolCallRecurseLimit(oai_settings.tool_call_recurse_limit);');
        expect(initSource).toContain("$('#tool_call_recurse_limit').on('input'");
        expect(initSource).toContain('applyToolCallRecurseLimit($(this).val());');
    });
});
