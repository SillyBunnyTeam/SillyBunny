import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const promptEditorCss = readFileSync(path.join(repoRoot, 'public/css/sillybunny-prompt-editor.css'), 'utf8');
const textareaRule = promptEditorCss.match(/#sb-settings-page \.sb-prompt-editor \.sb-prompt-textarea\s*\{(?<body>[^}]*)\}/s)?.groups?.body ?? '';

describe('prompt editor text field css', () => {
    test('uses the shared text field surface and readable text treatment', () => {
        expect(textareaRule).toContain('border: 1px solid transparent;');
        expect(textareaRule).toContain('border-radius: var(--sb-radius-button);');
        expect(textareaRule).toContain('background: var(--sb-composer-input-bg);');
        expect(textareaRule).toContain('color: var(--SmartThemeBodyColor);');
    });

    test('uses the shared placeholder contrast token', () => {
        expect(promptEditorCss).toMatch(/#sb-settings-page \.sb-prompt-editor \.sb-prompt-textarea::placeholder\s*\{[^}]*color: var\(--sb-input-placeholder\) !important;[^}]*opacity: 1;/s);
    });
});
