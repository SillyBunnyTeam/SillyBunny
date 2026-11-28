/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions and static HTML contracts. */
import { beforeEach, describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { importPowerUserModule } from './util/power-user-harness.js';
import { THEME_TEXT_REVISION } from '../public/scripts/sillybunny-theme-revisions.js';
import { ANDROID_STREAMING_SETTINGS_INITIALIZED_KEY } from '../public/scripts/mobile-streaming.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');

document.body.innerHTML = `
    <div id="form_create"></div>
    <button id="sb_character_editor_quick_edit" type="button"></button>
    <input id="spoiler_free_mode" type="checkbox" />
`;

const { powerUser, mocks, runReady } = await importPowerUserModule();
const initialDefaults = structuredClone(powerUser.power_user);
await runReady();

const emptyData = { themes: [], context: [], instruct: [], sysprompt: [], reasoning: [] };
// Pre-seed migration markers so loadPowerUserSettings tests isolate quick-edit/spoiler-free saves.
const migratedBaseline = () => ({
    ...structuredClone(initialDefaults),
    sb_theme_text_revision: THEME_TEXT_REVISION,
    [ANDROID_STREAMING_SETTINGS_INITIALIZED_KEY]: true,
});

describe('character editor quick edit', () => {
    beforeEach(() => {
        Object.assign(powerUser.power_user, structuredClone(initialDefaults));
        document.getElementById('form_create').className = '';
        $('#sb_character_editor_quick_edit').removeAttr('aria-pressed');
        $('#spoiler_free_mode').prop('checked', false);
        mocks.script.saveSettingsDebounced.mockClear();
    });

    test('applying the stored preference syncs the sheet class and the toolbar button without saving', async () => {
        await powerUser.loadPowerUserSettings(
            { power_user: { ...migratedBaseline(), characterEditorQuickEdit: true, spoiler_free_mode: false } },
            emptyData,
        );

        expect(document.getElementById('form_create').classList.contains('sb-editor-sheet--quick-edit')).toBe(true);
        expect($('#sb_character_editor_quick_edit').attr('aria-pressed')).toBe('true');
        expect(mocks.script.saveSettingsDebounced).not.toHaveBeenCalled();
    });

    test('quick edit does not touch the Spoiler Free Mode checkbox or class', () => {
        powerUser.power_user.spoiler_free_mode = false;
        powerUser.setCharacterEditorQuickEdit(true);

        expect($('#spoiler_free_mode').prop('checked')).toBe(false);
        expect(document.getElementById('form_create').classList.contains('sb-editor-sheet--spoiler-free')).toBe(false);
        expect(powerUser.power_user.spoiler_free_mode).toBe(false);
    });

    test('setting quick edit normalizes the value, updates the sheet, and persists once', () => {
        powerUser.power_user.characterEditorQuickEdit = true;
        document.getElementById('form_create').classList.add('sb-editor-sheet--quick-edit');

        powerUser.setCharacterEditorQuickEdit(0);

        expect(powerUser.power_user.characterEditorQuickEdit).toBe(false);
        expect(document.getElementById('form_create').classList.contains('sb-editor-sheet--quick-edit')).toBe(false);
        expect($('#sb_character_editor_quick_edit').attr('aria-pressed')).toBe('false');
        expect(mocks.script.saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    test('defaults to false and does not migrate spoiler_free_mode into quick edit', async () => {
        expect(initialDefaults.characterEditorQuickEdit).toBe(false);

        await powerUser.loadPowerUserSettings(
            { power_user: { spoiler_free_mode: true } },
            emptyData,
        );

        expect(powerUser.power_user.spoiler_free_mode).toBe(true);
        expect(powerUser.power_user.characterEditorQuickEdit).toBe(false);
        expect(document.getElementById('form_create').classList.contains('sb-editor-sheet--quick-edit')).toBe(false);
        expect(document.getElementById('form_create').classList.contains('sb-editor-sheet--spoiler-free')).toBe(true);
    });

    test('retires the spoiler-free sub-tab plumbing', () => {
        expect(powerUser.switchSpoilerMode).toBeUndefined();
        expect(powerUser.peekSpoilerMode).toBeUndefined();
        expect(indexHtml).not.toContain('id="spoiler_free_desc_button"');
        expect(indexHtml).not.toContain('id="sb_character_editor_subtabs"');
        expect(indexHtml).toContain('id="sb_character_editor_quick_edit"');
    });
});

describe('character editor spoiler free mode', () => {
    beforeEach(() => {
        Object.assign(powerUser.power_user, structuredClone(initialDefaults));
        document.getElementById('form_create').className = '';
        $('#sb_character_editor_quick_edit').removeAttr('aria-pressed');
        $('#spoiler_free_mode').prop('checked', false);
        mocks.script.saveSettingsDebounced.mockClear();
    });

    test('is its own stored setting on the upstream key', () => {
        expect(initialDefaults.spoiler_free_mode).toBe(false);
    });

    test('applying the stored setting syncs the sheet class and the checkbox without saving', async () => {
        await powerUser.loadPowerUserSettings(
            { power_user: { ...migratedBaseline(), spoiler_free_mode: true } },
            emptyData,
        );

        expect(document.getElementById('form_create').classList.contains('sb-editor-sheet--spoiler-free')).toBe(true);
        expect($('#spoiler_free_mode').prop('checked')).toBe(true);
        expect(mocks.script.saveSettingsDebounced).not.toHaveBeenCalled();
    });

    test('setting it writes spoiler_free_mode, persists once and leaves quick edit alone', () => {
        powerUser.power_user.characterEditorQuickEdit = true;

        powerUser.setCharacterEditorSpoilerFree(1);

        expect(powerUser.power_user.spoiler_free_mode).toBe(true);
        expect(powerUser.power_user.characterEditorQuickEdit).toBe(true);
        expect(document.getElementById('form_create').classList.contains('sb-editor-sheet--spoiler-free')).toBe(true);
        expect(document.getElementById('form_create').classList.contains('sb-editor-sheet--quick-edit')).toBe(false);
        expect($('#sb_character_editor_quick_edit').attr('aria-pressed')).toBeUndefined();
        expect(mocks.script.saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    test('the Customize checkbox drives spoiler free mode and not quick edit', () => {
        $('#spoiler_free_mode').prop('checked', true).trigger('input');

        expect(powerUser.power_user.spoiler_free_mode).toBe(true);
        expect(powerUser.power_user.characterEditorQuickEdit).toBe(false);
        expect(document.getElementById('form_create').classList.contains('sb-editor-sheet--spoiler-free')).toBe(true);
        expect(document.getElementById('form_create').classList.contains('sb-editor-sheet--quick-edit')).toBe(false);
        expect(mocks.script.saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    test('the sheet offers one reveal row that is not a Quick Edit section', () => {
        expect(indexHtml).toContain('id="sb_character_spoiler_reveal"');
        expect(indexHtml).toContain('data-sb-section="spoiler-reveal"');
    });
});
