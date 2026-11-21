/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom tests use synchronous DOM assertions. */
import { jest, describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { readFileSync } from 'node:fs';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((out, string, index) => out + string + (index < values.length ? values[index] : ''), ''),
    translate: value => value,
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    animateHeightFrom: jest.fn(),
    animateIn: jest.fn(),
    animateOut: jest.fn((_element, _frames, hide) => hide()),
    play: jest.fn(),
    stopMotion: jest.fn(),
    MOTION_FAST: 200,
    MOTION_SLOW: 250,
    MOTION_POPOVER_CLOSE: 150,
    MOTION_EASE_OUT_CUBIC: 'cubic-bezier(0.33, 1, 0.68, 1)',
    SPRING_SHEET: {},
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    MOBILE_QUERY: '(max-width: 768px)',
    positionPopover: jest.fn(() => '0px 0'),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-sheet.js', () => ({
    blockUpstreamDrawerClose: jest.fn(),
    createSheetController: jest.fn(),
}));

const { splitUserSettingsContent } = await import('../../public/scripts/sillybunny-settings-content.js');
const { normalizeSettingsPresentation } = await import('../../public/scripts/sillybunny-settings-presentation.js');
const { closePicker } = await import('../../public/scripts/sillybunny-editor/picker.js');

const indexHtml = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
const jquerySource = readFileSync(new URL('../../public/lib/jquery-3.5.1.min.js', import.meta.url), 'utf8');

/** The Interface page as the markup writes it, after the section order and the presentation pass. */
function presentInterface() {
    const page = new DOMParser().parseFromString(indexHtml, 'text/html');
    const block = document.adoptNode(page.getElementById('user-settings-block'));
    const content = document.createElement('div');
    content.append(...block.childNodes);
    const { interface: container } = splitUserSettingsContent(content);
    document.body.append(container);
    normalizeSettingsPresentation(container, { name: 'interface' });
    return container;
}

describe('Interface rows that the markup does not write as rows', () => {
    let previousCSS;
    beforeAll(() => {
        previousCSS = globalThis.CSS;
        globalThis.CSS = { ...previousCSS, escape: value => String(value) };
    });
    afterAll(() => {
        globalThis.CSS = previousCSS;
    });
    beforeEach(() => {
        document.body.replaceChildren();
        // The select row binds through the app's jQuery.
        new Function(jquerySource).call(window);
        Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: jest.fn(() => ({ matches: false })) });
    });
    afterEach(() => {
        closePicker({ animate: false });
        delete globalThis.jQuery;
        delete globalThis.$;
        document.body.replaceChildren();
    });

    test.each([
        ['reload_chat', 'Reload Chat'],
        ['debug_menu', 'Debug Menu'],
        ['data_maid_button', 'Clean-Up'],
        ['movingUIreset', 'Reset'],
    ])('the %s button is the trailing control of a row that is titled like it', (id, title) => {
        const button = presentInterface().querySelector(`#${id}`);
        const row = button.closest('.ds-row');
        expect(button.parentElement.matches('.ds-row-suffix')).toBe(true);
        expect(row.parentElement.matches('.ds-pref-group')).toBe(true);
        expect(row.querySelector('.ds-row-label').textContent).toBe(title);
    });

    test('a button row takes its subtitle and its translation key from the tooltip of the button', () => {
        const row = presentInterface().querySelector('#data_maid_button').closest('.ds-row');
        expect(row.querySelector('.ds-row-subtitle').textContent).toBe('Find and delete backups, unused chats, files, images, etc.');
        expect(row.querySelector('.ds-row-subtitle').dataset.i18n).toBe('Find and delete backups, unused chats, files, images, etc.');
    });

    test('the MovingUI Preset picker is a select row that holds its save button, and keeps the id of its block', () => {
        const row = presentInterface().querySelector('#MovingUI-presets-block');
        expect(row.matches('.ds-row.ds-select-row')).toBe(true);
        expect(row.parentElement.matches('.ds-pref-group')).toBe(true);
        expect(row.querySelector('.ds-row-suffix > #movingui-preset-save-button')).not.toBeNull();
        expect(row.querySelector('#movingUIPresets')).not.toBeNull();
    });

    test('the AutoComplete Style select sits in its select row without the wrapper that upstream put around it', () => {
        const row = presentInterface().querySelector('#stscript_autocomplete_style').closest('.ds-row');
        expect(row.matches('.ds-select-row')).toBe(true);
        expect(row.querySelector('.flex-container')).toBeNull();
    });

    test('every group title is a group heading, the AutoComplete drawer title included', () => {
        const titles = [...presentInterface().querySelectorAll('.sb-settings-category-title')];
        expect(titles.map(title => title.tagName)).toEqual(titles.map(() => 'H4'));
        expect(titles.every(title => title.classList.contains('ds-pref-group-heading'))).toBe(true);
        expect(titles.map(title => title.textContent.trim())).toContain('AutoComplete Settings');
    });

    test('a second pass changes nothing', () => {
        const container = presentInterface();
        const before = container.innerHTML;
        normalizeSettingsPresentation(container, { name: 'interface' });
        expect(container.innerHTML).toBe(before);
    });
});
