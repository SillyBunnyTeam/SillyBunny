import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isAbortLikeError } from '../public/scripts/util/abort-error.js';
import { escapeRegex } from '../public/scripts/util/escape-regex.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readRepoFile(relativePath) {
    return readFileSync(path.join(repoRoot, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('shared browser helper consolidation', () => {
    test('identifies abort-like failures without classifying unrelated errors', () => {
        expect(isAbortLikeError(new Error('request failed'), { aborted: true })).toBe(true);
        expect(isAbortLikeError({ name: 'AbortError' })).toBe(true);
        expect(isAbortLikeError(new Error('request cancelled by user'))).toBe(true);
        expect(isAbortLikeError('operation aborted')).toBe(true);
        expect(isAbortLikeError(new Error('network timeout'), { aborted: false })).toBe(false);
        expect(isAbortLikeError(null)).toBe(false);
    });

    test('all abort consumers import the shared utility', () => {
        const consumers = [
            ['public/scripts/extensions/in-chat-agents/pathfinder/llm-sidecar.js', 'from \'../../../util/abort-error.js\';'],
            ['public/scripts/extensions/in-chat-agents/pathfinder/prompts/pipeline-runner.js', 'from \'../../../../util/abort-error.js\';'],
            ['public/scripts/extensions/in-chat-agents/pathfinder/sidecar-retrieval.js', 'from \'../../../util/abort-error.js\';'],
            ['public/scripts/sillybunny-conversation/generation.js', 'from \'../util/abort-error.js\';'],
            ['public/scripts/sillybunny-custom-css-ai.js', 'from \'./util/abort-error.js\';'],
        ];

        for (const [relativePath, importSource] of consumers) {
            const source = readRepoFile(relativePath);
            expect(source).toContain('import { isAbortLikeError }');
            expect(source).toContain(importSource);
            expect(source).not.toContain('function isAbortLikeError(');
        }

        expect(readRepoFile('public/scripts/sillybunny-custom-css-ai.js')).toContain('export { isAbortLikeError };');
    });

    test('named regex consumers import the shared escape helper', () => {
        const chatLabelSource = readRepoFile('public/scripts/chat-label.js');
        const summarizeSource = readRepoFile('public/scripts/extensions/in-chat-agents/pathfinder/tools/summarize.js');
        const partnersSource = readRepoFile('public/scripts/sillybunny-conversation/partners-utils.js');
        const tabsSource = readRepoFile('public/scripts/sillybunny-tabs.js');
        const trackerSource = readRepoFile('public/scripts/extensions/in-chat-agents/tracker-state.js');

        expect(chatLabelSource).toContain('import { escapeRegex } from \'./util/escape-regex.js\';');
        expect(summarizeSource).toContain('import { escapeRegex } from \'../../../../util/escape-regex.js\';');
        expect(partnersSource).toContain('import { escapeRegex } from \'../util/escape-regex.js\';');
        expect(tabsSource).toContain('import { escapeRegex } from \'./util/escape-regex.js\';');
        expect(trackerSource).toContain('import { escapeRegex } from \'../../util/escape-regex.js\';');

        expect(chatLabelSource).not.toContain('function escapeRegExp(');
        expect(summarizeSource).not.toContain('function escapeRegExp(');
        expect(tabsSource).not.toContain('function escapeRegExp(');
        expect(trackerSource).not.toContain('function escapeRegex(');
        expect(partnersSource).toContain('return escapeRegex(String(value || \'\'));\n');
        expect(escapeRegex('a+b?')).toBe('a\\+b\\?');
    });
});
