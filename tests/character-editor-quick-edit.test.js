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

function createQuickEditHarness(initialValue) {
    const classes = new Set();
    const jqueryState = {};
    const saves = [];
    const context = {
        power_user: { characterEditorQuickEdit: initialValue },
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
        'globalThis.apply = applyCharacterEditorQuickEdit; globalThis.set = setCharacterEditorQuickEdit;',
    ].join('\n'), context);

    return { context, classes, jqueryState, saves };
}

describe('character editor quick edit', () => {
    test('applying the stored preference syncs the sheet class and both controls without saving', () => {
        const { context, classes, jqueryState, saves } = createQuickEditHarness(true);

        context.apply();

        expect(classes.has('sb-editor-sheet--quick-edit')).toBe(true);
        expect(jqueryState['#spoiler_free_mode:checked']).toBe(true);
        expect(jqueryState['#sb_character_editor_quick_edit:aria-pressed']).toBe('true');
        expect(saves).toHaveLength(0);
    });

    test('setting quick edit normalizes the value, updates the sheet, and persists once', () => {
        const { context, classes, jqueryState, saves } = createQuickEditHarness(true);

        context.set(0);

        expect(context.power_user.characterEditorQuickEdit).toBe(false);
        expect(classes.has('sb-editor-sheet--quick-edit')).toBe(false);
        expect(jqueryState['#sb_character_editor_quick_edit:aria-pressed']).toBe('false');
        expect(saves).toHaveLength(1);
    });

    test('migrates spoiler_free_mode only when the new key was never saved', () => {
        expect(powerUserSource).toContain(
            "if (!Object.hasOwn(savedPowerUserSettings, 'characterEditorQuickEdit')) {\n"
            + '        power_user.characterEditorQuickEdit = !!savedPowerUserSettings.spoiler_free_mode;\n'
            + '    }',
        );
        expect(powerUserSource).toMatch(/^ {4}characterEditorQuickEdit: false,$/m);
    });

    test('retires the spoiler-free sub-tab plumbing', () => {
        expect(powerUserSource).not.toMatch(/function (switchSpoilerMode|peekSpoilerMode|setCharacterSpoilerFreeFieldsHidden)\(/);
        expect(indexHtml).not.toContain('id="spoiler_free_desc_button"');
        expect(indexHtml).not.toContain('id="sb_character_editor_subtabs"');
        expect(indexHtml).toContain('id="sb_character_editor_quick_edit"');
    });
});
