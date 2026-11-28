/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions and static HTML contracts. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { THEME_RESET_DEFAULTS } from '../public/scripts/sillybunny-theme-css.js';
import { importPowerUserModule } from './util/power-user-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexSource = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');

document.body.innerHTML = `
    <select id="themes"></select>
    <textarea id="customCSS"></textarea>
    <div id="custom_css_save_state" role="button" tabindex="0">
        <span class="custom_css_save_state_label"></span>
    </div>
    <button id="custom_css_ai_wand" type="button"></button>
    <button id="ui-preset-save-button" type="button"></button>
    <button id="ui-preset-update-button" type="button"></button>
    <button id="ui-preset-delete-button" type="button"></button>
    <button id="ui_preset_export_button" type="button"></button>
    <input id="ui_preset_import_file" type="file" />
    <button class="sb-theme-preset-reset" type="button"></button>
`;

const { powerUser, mocks, runReady } = await importPowerUserModule();
const initialDefaults = structuredClone(powerUser.power_user);
await runReady();

function makeTheme(name, extra = {}) {
    return {
        name,
        main_text_color: 'rgba(220, 220, 220, 1)',
        italics_text_color: 'rgba(180, 180, 180, 1)',
        underline_text_color: 'rgba(129, 208, 255, 1)',
        quote_text_color: 'rgba(129, 208, 255, 1)',
        blur_tint_color: 'rgba(20, 20, 20, 0.9)',
        chat_tint_color: 'rgba(20, 20, 20, 0.9)',
        user_mes_blur_tint_color: 'rgba(30, 30, 30, 0.9)',
        bot_mes_blur_tint_color: 'rgba(25, 25, 25, 0.9)',
        shadow_color: 'rgba(0, 0, 0, 0.8)',
        border_color: 'rgba(0, 0, 0, 1)',
        custom_css: '',
        ...extra,
    };
}

async function loadThemesIntoPowerUser({ themes, activeTheme, customCss = '' }) {
    $('#themes').empty();
    await powerUser.loadPowerUserSettings(
        {
            power_user: {
                ...structuredClone(initialDefaults),
                theme: activeTheme,
                custom_css: customCss,
            },
        },
        {
            themes: themes.map(theme => ({ ...theme })),
            context: [],
            instruct: [],
            sysprompt: [],
            reasoning: [],
        },
    );
    $('#customCSS').val(customCss);
    // Ensure custom_css state matches the test fixture after load.
    powerUser.power_user.custom_css = customCss;
    $('#customCSS').trigger('input');
}

async function flushMicrotasks() {
    for (let i = 0; i < 6; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

describe('theme custom CSS import, actions, and guards', () => {
    let originalFetch;
    let savedThemePayloads;
    let deletedThemeNames;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        savedThemePayloads = [];
        deletedThemeNames = [];
        globalThis.fetch = jest.fn(async (url, init = {}) => {
            if (url === '/api/themes/save') {
                savedThemePayloads.push(JSON.parse(init.body));
                return { ok: true, json: async () => ({}) };
            }
            if (url === '/api/themes/delete') {
                deletedThemeNames.push(JSON.parse(init.body).name);
                return { ok: true, json: async () => ({}) };
            }
            return { ok: true, json: async () => ({}) };
        });
        mocks.popup.callGenericPopup.mockReset().mockResolvedValue(mocks.popup.POPUP_RESULT.AFFIRMATIVE);
        mocks.openAlert.mockReset().mockResolvedValue('cancel');
        mocks.utils.download.mockReset();
        mocks.utils.getFileText.mockReset();
        mocks.customCssAi.generateCustomCssWithAI.mockReset();
        mocks.script.saveSettingsDebounced.mockReset();
        global.toastr.info.mockReset();
        global.toastr.success.mockReset();
        global.toastr.warning.mockReset();
        global.toastr.error.mockReset();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test('theme selection applies the theme custom CSS payload and updates the style tag', async () => {
        await loadThemesIntoPowerUser({
            themes: [
                makeTheme('Theme A', { custom_css: '.a { color: red; }' }),
                makeTheme('Theme B', { custom_css: '.b { color: blue; }' }),
            ],
            activeTheme: 'Theme A',
            customCss: '.a { color: red; }',
        });

        await powerUser.switchUiTheme('Theme B');

        expect(powerUser.power_user.theme).toBe('Theme B');
        expect(powerUser.power_user.custom_css).toBe('.b { color: blue; }');
        expect($('#customCSS').val()).toBe('.b { color: blue; }');
        expect(document.getElementById('custom-style')?.innerHTML).toContain('.b { color: blue; }');
    });

    test('import selects and applies the saved theme and takes Custom CSS only from the imported file', async () => {
        await loadThemesIntoPowerUser({
            themes: [makeTheme('Theme A', { custom_css: '.existing { opacity: 1; }' })],
            activeTheme: 'Theme A',
            customCss: '.existing { opacity: 1; }',
        });

        // Imported theme without custom_css must NOT inherit the active live custom_css.
        mocks.utils.getFileText.mockResolvedValueOnce(JSON.stringify({
            name: 'Imported Clean',
            main_text_color: 'rgba(200, 210, 220, 1)',
        }));

        const input = document.getElementById('ui_preset_import_file');
        Object.defineProperty(input, 'files', { value: [{ name: 'Imported Clean.json' }], configurable: true });
        $('#ui_preset_import_file').trigger('change');
        await flushMicrotasks();

        expect(savedThemePayloads).toHaveLength(1);
        expect(savedThemePayloads[0].name).toBe('Imported Clean');
        expect(savedThemePayloads[0]).not.toHaveProperty('custom_css');
        expect(powerUser.power_user.theme).toBe('Imported Clean');
        expect(mocks.script.saveSettingsDebounced).toHaveBeenCalled();

        // Imported theme WITH custom_css applies its own CSS and updates the active theme.
        mocks.utils.getFileText.mockResolvedValueOnce(JSON.stringify({
            name: 'Imported Styled',
            custom_css: '.imported-file { color: teal; }',
        }));
        Object.defineProperty(input, 'files', { value: [{ name: 'Imported Styled.json' }], configurable: true });
        $('#ui_preset_import_file').trigger('change');
        await flushMicrotasks();

        expect(savedThemePayloads).toHaveLength(2);
        expect(savedThemePayloads[1].custom_css).toBe('.imported-file { color: teal; }');
        expect(powerUser.power_user.theme).toBe('Imported Styled');
        expect(powerUser.power_user.custom_css).toBe('.imported-file { color: teal; }');

        // Snapshot still carries live Custom CSS.
        powerUser.power_user.custom_css = '.snap { color: green; }';
        expect(powerUser.getThemeObject('Snap').custom_css).toBe('.snap { color: green; }');
    });

    test('saving merges the current snapshot over the stored theme while export downloads without saving', async () => {
        await loadThemesIntoPowerUser({
            themes: [makeTheme('Stored Theme', { custom_css: '.stored {}', extra_field: 'preserve-me' })],
            activeTheme: 'Stored Theme',
            customCss: '.updated {}',
        });

        // Export downloads snapshot without posting to /api/themes/save.
        $('#ui_preset_export_button').trigger('click');
        await flushMicrotasks();
        expect(mocks.utils.download).toHaveBeenCalledTimes(1);
        expect(savedThemePayloads).toHaveLength(0);

        // Update theme merges snapshot over stored theme, keeping extra stored keys.
        $('#ui-preset-update-button').trigger('click');
        await flushMicrotasks();
        expect(savedThemePayloads).toHaveLength(1);
        expect(savedThemePayloads[0].extra_field).toBe('preserve-me');
        expect(savedThemePayloads[0].custom_css).toBe('.updated {}');
    });

    test('Reset asks first, changes nothing on cancel, and writes shipped defaults plus empty Custom CSS on reset', async () => {
        await loadThemesIntoPowerUser({
            themes: [makeTheme('Custom Look', { custom_css: '.custom {}' })],
            activeTheme: 'Custom Look',
            customCss: '.custom {}',
        });

        // Cancel leaves theme and Custom CSS untouched.
        mocks.openAlert.mockResolvedValueOnce('cancel');
        $('.sb-theme-preset-reset').trigger('click');
        await flushMicrotasks();
        expect(mocks.openAlert).toHaveBeenCalledTimes(1);
        expect(powerUser.power_user.theme).toBe('Custom Look');
        expect(powerUser.power_user.custom_css).toBe('.custom {}');

        // Confirm writes THEME_RESET_DEFAULTS and clears Custom CSS.
        mocks.openAlert.mockResolvedValueOnce('reset');
        $('.sb-theme-preset-reset').trigger('click');
        await flushMicrotasks();
        expect(powerUser.power_user.theme).toBe(THEME_RESET_DEFAULTS.theme);
        expect(powerUser.power_user.custom_css).toBe('');
        expect(powerUser.power_user.blur_strength).toBe(THEME_RESET_DEFAULTS.blur_strength);
    });

    test('theme dropdown, /theme command, and import guard unsaved Custom CSS with Save as default and Discard last', async () => {
        await loadThemesIntoPowerUser({
            themes: [
                makeTheme('Theme A', { custom_css: '.a {}', extra_key: 'keep' }),
                makeTheme('Theme B', { custom_css: '.b {}' }),
            ],
            activeTheme: 'Theme A',
            customCss: '.unsaved-work { color: gold; }',
        });

        // Cancelling the dropdown switch reverts #themes to the current theme and keeps unsaved CSS.
        mocks.popup.callGenericPopup.mockResolvedValueOnce(mocks.popup.POPUP_RESULT.CANCELLED);
        $('#themes').val('Theme B').trigger('change');
        await flushMicrotasks();
        expect(powerUser.power_user.theme).toBe('Theme A');
        expect($('#themes').val()).toBe('Theme A');
        expect(powerUser.power_user.custom_css).toBe('.unsaved-work { color: gold; }');

        // Verify popup options: Save is defaultResult, Discard is CUSTOM1 with red_button and appendAtEnd.
        const popupOpts = mocks.popup.callGenericPopup.mock.calls[0][3];
        expect(popupOpts.defaultResult).toBe(mocks.popup.POPUP_RESULT.AFFIRMATIVE);
        expect(popupOpts.customButtons).toEqual(expect.arrayContaining([
            expect.objectContaining({
                result: mocks.popup.POPUP_RESULT.CUSTOM1,
                classes: ['red_button'],
                appendAtEnd: true,
            }),
        ]));

        // Choosing Save via /theme saves ONLY Custom CSS onto Theme A (preserving its stored keys) and switches to Theme B.
        mocks.popup.callGenericPopup.mockResolvedValueOnce(mocks.popup.POPUP_RESULT.AFFIRMATIVE);
        const themeCmd = mocks.registeredCommands.get('theme');
        expect(themeCmd).toBeDefined();
        await themeCmd.callback({}, 'Theme B');
        expect(savedThemePayloads).toHaveLength(1);
        expect(savedThemePayloads[0]).toMatchObject({
            name: 'Theme A',
            extra_key: 'keep',
            custom_css: '.unsaved-work { color: gold; }',
        });
        expect(powerUser.power_user.theme).toBe('Theme B');
        expect(powerUser.power_user.custom_css).toBe('.b {}');

        // Import also asks before saving when unsaved Custom CSS would be replaced, and skips save on cancel.
        powerUser.power_user.custom_css = '.new-unsaved {}';
        mocks.popup.callGenericPopup.mockResolvedValueOnce(mocks.popup.POPUP_RESULT.CANCELLED);
        mocks.utils.getFileText.mockResolvedValueOnce(JSON.stringify({ name: 'Theme C', custom_css: '.c {}' }));
        const input = document.getElementById('ui_preset_import_file');
        Object.defineProperty(input, 'files', { value: [{ name: 'Theme C.json' }], configurable: true });
        savedThemePayloads = [];
        $('#ui_preset_import_file').trigger('change');
        await flushMicrotasks();
        expect(savedThemePayloads).toHaveLength(0);
        expect(powerUser.power_user.theme).toBe('Theme B');
    });

    test('deleting a theme keeps Custom CSS that no remaining theme stores', async () => {
        await loadThemesIntoPowerUser({
            themes: [
                makeTheme('Theme A', { custom_css: '.a {}' }),
                makeTheme('Theme B', { custom_css: '.b {}' }),
            ],
            activeTheme: 'Theme A',
            customCss: '.unstored-css { margin: 4px; }',
        });

        // Confirm delete popup.
        mocks.popup.callGenericPopup.mockResolvedValueOnce(mocks.popup.POPUP_RESULT.AFFIRMATIVE);
        $('#ui-preset-delete-button').trigger('click');
        await flushMicrotasks();

        expect(deletedThemeNames).toEqual(['Theme A']);
        expect(powerUser.power_user.theme).toBe('Theme B');
        // Unstored CSS survives deletion of Theme A instead of being overwritten by Theme B's CSS.
        expect(powerUser.power_user.custom_css).toBe('.unstored-css { margin: 4px; }');
    });

    test('Custom CSS save state tracks edits and saves only Custom CSS on click or keyboard activation', async () => {
        // Static HTML contract for the keyboard-reachable save state control.
        const toolbarStart = indexSource.indexOf('<div id="CustomCSS-block"');
        const toolbarSource = indexSource.slice(toolbarStart, indexSource.indexOf('id="CustomCSS-textAreaBlock"', toolbarStart));
        expect(toolbarStart).toBeGreaterThan(-1);
        expect(toolbarSource).toContain('<div id="custom_css_save_state" class="menu_button menu_button_icon margin0" role="button" tabindex="0" title="lorum ipsum" aria-label="lorum ipsum">');
        expect(toolbarSource).toContain('<span class="custom_css_save_state_label"></span>');

        await loadThemesIntoPowerUser({
            themes: [makeTheme('Theme A', { custom_css: '.clean {}', stored_marker: 'intact' })],
            activeTheme: 'Theme A',
            customCss: '.clean {}',
        });

        const indicator = $('#custom_css_save_state');
        expect(indicator.attr('aria-disabled')).toBe('true');

        // Editing Custom CSS marks the save state dirty.
        $('#customCSS').val('.dirty {}').trigger('input');
        expect(indicator.attr('aria-disabled')).toBe('false');
        expect(indicator.hasClass('custom_css_save_state_dirty')).toBe(true);

        // Pressing Enter activates the save control and saves ONLY custom_css into Theme A.
        indicator.trigger($.Event('keydown', { key: 'Enter' }));
        await flushMicrotasks();

        expect(savedThemePayloads).toHaveLength(1);
        expect(savedThemePayloads[0]).toMatchObject({
            name: 'Theme A',
            stored_marker: 'intact',
            custom_css: '.dirty {}',
        });
        expect(indicator.attr('aria-disabled')).toBe('true');
    });

    test('Custom CSS AI wand detects edits made during generation and asks with Append default and Replace last', async () => {
        await loadThemesIntoPowerUser({
            themes: [makeTheme('Theme A', { custom_css: '.initial {}' })],
            activeTheme: 'Theme A',
            customCss: '.initial {}',
        });

        // First popup (AI prompt form): populate instruction and choose Replace mode.
        mocks.popup.callGenericPopup.mockImplementationOnce(async content => {
            content.find('#custom_css_ai_instruction').val('Make buttons rounded');
            content.find('input[name="custom_css_ai_apply_mode"][value="replace"]').prop('checked', true);
            return mocks.popup.POPUP_RESULT.AFFIRMATIVE;
        });

        // While AI generation is running, user edits Custom CSS live.
        mocks.customCssAi.generateCustomCssWithAI.mockImplementationOnce(async ({ currentCss }) => {
            expect(currentCss).toBe('.initial {}');
            powerUser.power_user.custom_css = '.user-mid-flight-edit {}';
            return '.ai-generated {}';
        });

        // Second popup (conflict guard): default Append (AFFIRMATIVE) appends AI CSS after the user's live edit.
        mocks.popup.callGenericPopup.mockResolvedValueOnce(mocks.popup.POPUP_RESULT.AFFIRMATIVE);

        $('#custom_css_ai_wand').trigger('click');
        await flushMicrotasks();

        const conflictOpts = mocks.popup.callGenericPopup.mock.calls[1][3];
        expect(conflictOpts.defaultResult).toBe(mocks.popup.POPUP_RESULT.AFFIRMATIVE);
        expect(conflictOpts.customButtons).toEqual(expect.arrayContaining([
            expect.objectContaining({
                result: mocks.popup.POPUP_RESULT.CUSTOM1,
                classes: ['red_button'],
                appendAtEnd: true,
            }),
        ]));
        expect(powerUser.power_user.custom_css).toContain('.user-mid-flight-edit {}');
        expect(powerUser.power_user.custom_css).toContain('.ai-generated {}');
    });
});
