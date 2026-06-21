import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const openAiSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'openai.js'), 'utf8').replace(/\r\n/g, '\n');

describe('OpenAI impersonate defaults', () => {
    test('falls back to first-person impersonation prompts when user fields are empty', () => {
        expect(openAiSource).toContain("const default_assistant_impersonation = '{{user}}:';");
        expect(openAiSource).toContain('assistant_impersonation: default_assistant_impersonation,');
        expect(openAiSource).toContain('function getEffectiveImpersonationPrompt()');
        expect(openAiSource).toContain("String(oai_settings.impersonation_prompt ?? '').trim() || default_impersonation_prompt");
        expect(openAiSource).toContain('const impersonationPrompt = getEffectiveImpersonationPrompt();');
        expect(openAiSource).toContain('function getEffectiveAssistantImpersonationPrefill(settings)');
        expect(openAiSource).toContain("String(settings?.assistant_impersonation ?? '').trim() || default_assistant_impersonation");
        expect(openAiSource).toContain('? getEffectiveAssistantImpersonationPrefill(settings)');
    });

    test('does not add the impersonate control prompt when prompt manager disables it', () => {
        expect(openAiSource).toContain("if (type === 'impersonate' && !promptManager.isPromptDisabledForActiveCharacter('impersonate')) {");
        expect(openAiSource).toContain('controlPrompts.add(impersonateMessage);');
    });
});
