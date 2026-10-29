/* eslint-disable playwright/no-standalone-expect -- Jest source contract for retired browser assets. */
import { expect, test } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../../public/scripts/extensions/in-chat-agents/', import.meta.url);

test('generic modal is retired while public routing and shared helper assets remain', () => {
    const source = readFileSync(new URL('index.js', root), 'utf8');
    const css = readFileSync(new URL('style.css', root), 'utf8');
    const settingsPage = readFileSync(new URL('ui/settings-page.js', root), 'utf8');
    expect(existsSync(new URL('editor.html', root))).toBe(false);
    expect(source).not.toMatch(/openLegacyEditor|openRegexScriptEditor|ica--editor-fullscreen/);
    expect(source).not.toMatch(/renderExtensionTemplateAsync\(MODULE_NAME, 'editor'\)/);
    expect(source).toContain('ui.openAgentDetail(');
    expect(source).toContain('openPathfinderEditor(saved)');
    expect(source).toContain('newCompanion: autoOpenCompanionMaker => openEditor(');
    expect(settingsPage).toContain('attachTextareaFullscreen(input)');
    expect(source).toContain('openOverview:');
    expect(css).not.toContain('ica--editor-fullscreen');
    expect(css).toContain('.ica--editor-row');
    expect(css).toContain('.ica--textarea-fullscreen-wrapper');
});
