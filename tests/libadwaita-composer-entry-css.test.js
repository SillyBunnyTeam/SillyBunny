import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const themeCss = readFileSync(path.join(repoRoot, 'public/css/sillybunny-theme.css'), 'utf8');
const conversationCss = readFileSync(path.join(repoRoot, 'public/css/sillybunny-conversation.css'), 'utf8');
const mobileCss = readFileSync(path.join(repoRoot, 'public/css/sillybunny-mobile-shell.css'), 'utf8');

describe('libadwaita composer entry css', () => {
    test('declares composer input token as body-colour tint', () => {
        expect(themeCss).toMatch(/--sb-composer-input-bg:\s*color-mix\(in srgb,\s*var\(--SmartThemeBodyColor\)\s*10%,\s*transparent\);/);
    });

    test('declares composer focus tokens using accent colour', () => {
        expect(themeCss).toMatch(/--sb-composer-focus-border:\s*var\(--color-primary,\s*var\(--sb-accent\)\);/);
        expect(themeCss).toMatch(/--sb-composer-focus-ring:\s*0 0 0 1px color-mix\(in srgb,\s*var\(--color-primary,\s*var\(--sb-accent\)\)\s*50%,\s*transparent\);/);
    });

    test('uses composer tokens in roleplay send_textarea', () => {
        expect(themeCss).toMatch(/#send_textarea\s*\{[^}]*background:\s*var\(--sb-composer-input-bg\);/);
        expect(themeCss).toMatch(/#send_form:focus-within #send_textarea\s*\{[^}]*border-color:\s*var\(--sb-composer-focus-border\);/);
        expect(themeCss).toMatch(/#send_form:focus-within #send_textarea\s*\{[^}]*box-shadow:\s*var\(--sb-composer-focus-ring\);/);
    });

    test('roleplay send_textarea has transparent border at rest', () => {
        expect(themeCss).toMatch(/#send_textarea\s*\{[^}]*border:\s*1px solid transparent;/);
    });

    test('roleplay send button transitions its hover treatment', () => {
        expect(themeCss).toMatch(/#send_but\s*\{[^}]*transition:\s*background-color var\(--sb-transition-fast\), box-shadow var\(--sb-transition-fast\), transform var\(--sb-transition-fast\)/);
        expect(themeCss).toMatch(/#send_but:hover:not\(:disabled\)\s*\{[^}]*background:/);
    });

    test('Conversation send button uses the same hover transition contract', () => {
        expect(conversationCss).toMatch(/#sheld\[data-sb-conversation-mode='on'\] #sb_conversation_send\.menu_button\s*\{[^}]*transition:\s*background-color var\(--sb-transition-fast\), box-shadow var\(--sb-transition-fast\), transform var\(--sb-transition-fast\)/);
    });

    test('uses composer tokens in Conversation textarea', () => {
        expect(conversationCss).toMatch(/\.sb-conversation-composer textarea\s*\{[^}]*background:\s*var\(--sb-composer-input-bg\);/);
        expect(conversationCss).toMatch(/\.sb-conversation-composer textarea:focus\s*\{[^}]*border-color:\s*var\(--sb-composer-focus-border\);/);
        expect(conversationCss).toMatch(/\.sb-conversation-composer textarea:focus\s*\{[^}]*box-shadow:\s*var\(--sb-composer-focus-ring\);/);
    });

    test('Conversation composer textarea has transparent border at rest', () => {
        expect(conversationCss).toMatch(/\.sb-conversation-composer textarea\s*\{[^}]*border:\s*1px solid transparent;/);
    });

    test('uses composer tokens in mobile send_textarea', () => {
        expect(mobileCss).toMatch(/#send_textarea\s*\{[^}]*background:\s*var\(--sb-composer-input-bg\)\s*!important;/);
        expect(mobileCss).toMatch(/#send_form:focus-within #send_textarea\s*\{[^}]*border-color:\s*var\(--sb-composer-focus-border\)\s*!important;/);
        expect(mobileCss).toMatch(/#send_form:focus-within #send_textarea\s*\{[^}]*box-shadow:\s*var\(--sb-composer-focus-ring\)\s*!important;/);
    });

    test('Conversation message edit textarea uses composer tokens', () => {
        expect(conversationCss).toMatch(/\.sb-conversation-message-edit-textarea\s*\{[^}]*background:\s*var\(--sb-composer-input-bg\);/);
        expect(conversationCss).toMatch(/\.sb-conversation-message-edit-textarea:focus\s*\{[^}]*border-color:\s*var\(--sb-composer-focus-border\);/);
        expect(conversationCss).toMatch(/\.sb-conversation-message-edit-textarea:focus\s*\{[^}]*box-shadow:\s*var\(--sb-composer-focus-ring\);/);
    });
});
