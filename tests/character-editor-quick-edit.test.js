import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const powerUserSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'power-user.js'), 'utf8').replace(/\r\n/g, '\n');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');

function getFunctionSource(name) {
    const start = powerUserSource.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThanOrEqual(0);

    const bodyStart = powerUserSource.indexOf('{', powerUserSource.indexOf(')', start));
    let depth = 0;
    for (let index = bodyStart; index < powerUserSource.length; index++) {
        if (powerUserSource[index] === '{') depth++;
        if (powerUserSource[index] === '}' && --depth === 0) {
            return powerUserSource.slice(start, index + 1);
        }
    }
    throw new Error(`Unterminated function ${name}`);
}

function createModeHarness({ quickEdit = false, spoilerFree = false } = {}) {
    const classes = new Set();
    const jqueryState = {};
    const saves = [];
    const context = {
        power_user: { characterEditorQuickEdit: quickEdit, spoiler_free_mode: spoilerFree },
        document: {
            getElementById: (id) => id === 'form_create'
                ? { classList: { toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)) } }
                : null,
        },
        $: (selector) => ({
            prop: (key, value) => { jqueryState[`${selector}:${key}`] = value; },
            attr: (key, value) => { jqueryState[`${selector}:${key}`] = value; },
        }),
        saveSettingsDebounced: () => saves.push(true),
    };

    vm.runInNewContext([
        getFunctionSource('applyCharacterEditorQuickEdit'),
        getFunctionSource('setCharacterEditorQuickEdit'),
        getFunctionSource('applyCharacterEditorSpoilerFree'),
        getFunctionSource('setCharacterEditorSpoilerFree'),
        'globalThis.applyQuick = applyCharacterEditorQuickEdit; globalThis.setQuick = setCharacterEditorQuickEdit;',
        'globalThis.applySpoiler = applyCharacterEditorSpoilerFree; globalThis.setSpoiler = setCharacterEditorSpoilerFree;',
    ].join('\n'), context);

    return { context, classes, jqueryState, saves };
}

describe('character editor quick edit', () => {
    test('applying the stored preference syncs the sheet class and the toolbar button without saving', () => {
        const { context, classes, jqueryState, saves } = createModeHarness({ quickEdit: true });

        context.applyQuick();

        expect(classes.has('sb-editor-sheet--quick-edit')).toBe(true);
        expect(jqueryState['#sb_character_editor_quick_edit:aria-pressed']).toBe('true');
        expect(saves).toHaveLength(0);
    });

    test('quick edit does not touch the Spoiler Free Mode checkbox or class', () => {
        const { context, classes, jqueryState } = createModeHarness({ quickEdit: true, spoilerFree: false });

        context.applyQuick();
        context.setQuick(true);

        expect(jqueryState['#spoiler_free_mode:checked']).toBeUndefined();
        expect(classes.has('sb-editor-sheet--spoiler-free')).toBe(false);
        expect(context.power_user.spoiler_free_mode).toBe(false);
    });

    test('setting quick edit normalizes the value, updates the sheet, and persists once', () => {
        const { context, classes, jqueryState, saves } = createModeHarness({ quickEdit: true });

        context.setQuick(0);

        expect(context.power_user.characterEditorQuickEdit).toBe(false);
        expect(classes.has('sb-editor-sheet--quick-edit')).toBe(false);
        expect(jqueryState['#sb_character_editor_quick_edit:aria-pressed']).toBe('false');
        expect(saves).toHaveLength(1);
    });

    test('does not migrate spoiler_free_mode into quick edit', () => {
        expect(powerUserSource).not.toMatch(/characterEditorQuickEdit = !!savedPowerUserSettings/);
        expect(powerUserSource).not.toContain('savedPowerUserSettings.spoiler_free_mode');
        expect(powerUserSource).toMatch(/^ {4}characterEditorQuickEdit: false,$/m);
    });

    test('retires the spoiler-free sub-tab plumbing', () => {
        expect(powerUserSource).not.toMatch(/function (switchSpoilerMode|peekSpoilerMode|setCharacterSpoilerFreeFieldsHidden)\(/);
        expect(indexHtml).not.toContain('id="spoiler_free_desc_button"');
        expect(indexHtml).not.toContain('id="sb_character_editor_subtabs"');
        expect(indexHtml).toContain('id="sb_character_editor_quick_edit"');
    });
});

describe('character editor spoiler free mode', () => {
    test('is its own stored setting on the upstream key', () => {
        expect(powerUserSource).toMatch(/^ {4}spoiler_free_mode: false,$/m);
    });

    test('applying the stored setting syncs the sheet class and the checkbox without saving', () => {
        const { context, classes, jqueryState, saves } = createModeHarness({ spoilerFree: true });

        context.applySpoiler();

        expect(classes.has('sb-editor-sheet--spoiler-free')).toBe(true);
        expect(jqueryState['#spoiler_free_mode:checked']).toBe(true);
        expect(saves).toHaveLength(0);
    });

    test('setting it writes spoiler_free_mode, persists once and leaves quick edit alone', () => {
        const { context, classes, jqueryState, saves } = createModeHarness({ quickEdit: true });

        context.setSpoiler(1);

        expect(context.power_user.spoiler_free_mode).toBe(true);
        expect(context.power_user.characterEditorQuickEdit).toBe(true);
        expect(classes.has('sb-editor-sheet--spoiler-free')).toBe(true);
        expect(classes.has('sb-editor-sheet--quick-edit')).toBe(false);
        expect(jqueryState['#sb_character_editor_quick_edit:aria-pressed']).toBeUndefined();
        expect(saves).toHaveLength(1);
    });

    test('the Customize checkbox drives spoiler free mode and not quick edit', () => {
        expect(powerUserSource).toMatch(/\$\('#spoiler_free_mode'\)\.on\('input', function \(\) \{\s*setCharacterEditorSpoilerFree\(/);
        expect(powerUserSource).toMatch(/\n {4}applyCharacterEditorSpoilerFree\(\);/);
    });

    test('the sheet offers one reveal row that is not a Quick Edit section', () => {
        expect(indexHtml).toContain('id="sb_character_spoiler_reveal"');
        expect(indexHtml).toContain('data-sb-section="spoiler-reveal"');
    });
});
