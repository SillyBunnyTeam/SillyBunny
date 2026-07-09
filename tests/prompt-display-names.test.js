import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const openAiSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'openai.js'), 'utf8');
const promptManagerSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'PromptManager.js'), 'utf8');

function getMethodSource(source, name) {
    const markers = [`\n    ${name}(`, `\n    async ${name}(`, `\n    static ${name}(`, `\n    static async ${name}(`];
    const start = markers.reduce((match, marker) => {
        const index = source.indexOf(marker);
        return match === -1 || (index !== -1 && index < match) ? index : match;
    }, -1);

    expect(start).toBeGreaterThanOrEqual(0);

    const bodyStart = source.indexOf('{', start);
    let depth = 0;

    for (let index = bodyStart; index < source.length; index++) {
        const char = source[index];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return source.slice(start, index + 1);
            }
        }
    }

    throw new Error(`Unable to find method source for ${name}`);
}

describe('prompt display names', () => {
    test('carries extension prompt names into prepared prompts', () => {
        expect(openAiSource).toContain('const promptName = typeof prompt.name === \'string\' ? prompt.name.trim() : \'\';');
        expect(openAiSource).toContain('...(promptName && { name: promptName }),');
    });

    test('uses prompt names as inspector-only display names', () => {
        const fromPromptSource = getMethodSource(openAiSource, 'fromPromptAsync');
        const getChatSource = getMethodSource(openAiSource, 'getChat');

        expect(fromPromptSource).toContain('if (prompt.extension && promptName)');
        expect(fromPromptSource).toContain('message.displayName = promptName;');
        expect(promptManagerSource).toContain('message.displayName || message.identifier || truncatedTitle');
        expect(getChatSource).toContain('...(message.name && { name: message.name }),');
        expect(getChatSource).not.toContain('displayName');
    });
});
