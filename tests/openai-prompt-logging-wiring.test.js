import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const openAiSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'openai.js'), 'utf8');

describe('OpenAI prompt logging wiring', () => {
    test('passes the existing prompt-log preference to backend request metadata', () => {
        expect(openAiSource).toContain('\'log_prompts\': Boolean(power_user.console_log_prompts),');
    });
});
