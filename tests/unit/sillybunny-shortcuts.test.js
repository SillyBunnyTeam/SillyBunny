/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for pure functions. */
import { describe, expect, jest, test } from '@jest/globals';
import { SHORTCUTS_COPY } from '../helpers/copy-about.js';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
jest.unstable_mockModule('../../public/scripts/sillybunny-editor/dialog.js', () => ({ openDialog: jest.fn() }));
const createRow = jest.fn(({ label }) => ({ row: Object.assign(document.createElement('div'), { textContent: label }) }));
const createPrefGroup = jest.fn(({ title, subtitle, rows }) => {
    const section = document.createElement('section');
    section.append(...rows.map(entry => entry.row));
    section.dataset.title = title;
    if (subtitle) {
        const note = document.createElement('p');
        note.className = 'ds-pref-group-subtitle';
        note.textContent = subtitle;
        section.prepend(note);
    }
    return { section };
});
jest.unstable_mockModule('../../public/scripts/sillybunny-editor/rows.js', () => ({ createPrefGroup, createRow }));
jest.unstable_mockModule('../../public/scripts/sillybunny-window-styles.js', () => ({ ensureWindowStyles: jest.fn() }));
const { SHORTCUT_SCOPES, fillShortcuts, formatKeyToken, getShortcuts } = await import('../../public/scripts/sillybunny-shortcuts.js');
const { isApplePlatform } = await import('../../public/scripts/sillybunny-platform.js');

const keysOf = scope => getShortcuts().filter(entry => entry.scope === scope).map(entry => entry.keys.join('+'));

describe('Keyboard shortcut registry', () => {
    test('sorts every entry into General, Editors and Lists, List Navigation, Chat or Formatting', () => {
        expect([...SHORTCUT_SCOPES]).toEqual(['general', 'editors', 'lists', 'chat', 'formatting']);
        const strays = getShortcuts().filter(entry => !SHORTCUT_SCOPES.includes(entry.scope));

        expect(strays).toEqual([]);
    });

    test('lists the shell shortcuts of General', () => {
        expect(keysOf('general')).toEqual(['Mod+?', 'F1', 'Mod+O', 'Mod+U', 'Mod+I', 'Mod+P', 'Mod+F', 'Mod+M']);
    });

    test('lists the save and find shortcuts that editors and lists handle', () => {
        expect(keysOf('editors')).toEqual(['Mod+S', 'Mod+F']);
    });

    test('lists the keys that move through a list and that move a row', () => {
        expect(keysOf('lists')).toEqual(['Up', 'Down', 'Home', 'End', 'Page Up', 'Page Down', 'Left', 'Right', 'Alt+Up', 'Alt+Down', 'Alt+Home', 'Alt+End']);
    });

    test('lists the chat hotkeys and the Markdown hotkeys of the hotkey template', () => {
        expect(keysOf('chat')).toEqual([
            'Up', 'Ctrl+Up', 'Left', 'Right', 'Enter', 'Ctrl+Enter', 'Alt+Enter', 'Escape', 'Ctrl+Shift+Up', 'Ctrl+Shift+Down',
        ]);
        expect(keysOf('formatting')).toEqual(['Ctrl+B', 'Ctrl+I', 'Ctrl+U', 'Ctrl+K', 'Ctrl+Shift+~']);
    });

    test('never repeats a key combination inside one scope', () => {
        const repeats = SHORTCUT_SCOPES.flatMap((scope) => {
            const combinations = keysOf(scope);
            return combinations.filter((combination, index) => combinations.indexOf(combination) !== index).map(combination => `${scope}: ${combination}`);
        });

        expect(repeats).toEqual([]);
    });

    test('gives every entry a label', () => {
        const unlabelled = getShortcuts().filter(entry => entry.label.trim() === '').map(entry => entry.keys.join('+'));

        expect(unlabelled).toEqual([]);
    });

    test('has no entry that waits for a handler: F1 and Ctrl+? have theirs', () => {
        expect(getShortcuts().filter(entry => 'planned' in entry)).toEqual([]);
    });
});

describe('Keyboard shortcut registry and the upstream handlers', () => {
    // These are the chat and Markdown hotkeys that the upstream handlers answer, in the order of upstream's own list.
    test('lists the chat hotkeys that the upstream handlers answer', () => {
        expect(keysOf('chat')).toEqual(['Up', 'Ctrl+Up', 'Left', 'Right', 'Enter', 'Ctrl+Enter', 'Alt+Enter', 'Escape', 'Ctrl+Shift+Up', 'Ctrl+Shift+Down']);
    });

    test('lists the Markdown hotkeys that the upstream handlers answer', () => {
        expect(keysOf('formatting')).toEqual(['Ctrl+B', 'Ctrl+I', 'Ctrl+U', 'Ctrl+K', 'Ctrl+Shift+~']);
    });
});

describe('Keyboard Shortcuts window', () => {
    const fill = (apple = false) => {
        const body = document.createElement('div');
        fillShortcuts(body, getShortcuts(), apple);
        return body;
    };
    const rowLabels = body => [...body.querySelectorAll('section > div')].map(row => row.textContent);

    test('lists every shortcut, the two that open the windows included', () => {
        const labels = rowLabels(fill());

        expect(labels).toEqual(expect.arrayContaining(['Keyboard Shortcuts', 'Help', 'Home', 'Save', 'Edit Last Message', 'Bold']));
        expect(labels).toHaveLength(getShortcuts().length);
    });

    test('explains the Formatting group with a note, and no other group', () => {
        const notes = [...fill().querySelectorAll('section')].map(section => [section.dataset.title, section.querySelector('.ds-pref-group-subtitle')]);

        expect(notes.filter(([, note]) => note).map(([title]) => title)).toEqual(['Formatting']);
        const [, note] = notes.find(([title]) => title === 'Formatting');
        expect(note.textContent).toBe(SHORTCUTS_COPY.formattingNote);
    });

    test('titles one group per scope', () => {
        const titles = [...fill().querySelectorAll('section')].map(section => section.dataset.title);

        expect(titles).toEqual(['General', 'Editors and Lists', 'List Navigation', 'Chat', 'Formatting']);
    });
});

describe('Keyboard Shortcuts search', () => {
    const fill = (apple = false) => {
        const body = document.createElement('div');
        const list = fillShortcuts(body, getShortcuts(), apple);
        return { body, list };
    };
    const shownLabels = body => [...body.querySelectorAll('section > div')].filter(row => !row.hidden).map(row => row.textContent);
    const shownTitles = body => [...body.querySelectorAll('section')].filter(section => !section.hidden).map(section => section.dataset.title);

    test('shows the rows whose label has the query, whatever its letter case, and the groups that still have a row', () => {
        const { body, list } = fill();

        expect(list.filter('  SWIPE ')).toBe(2);

        expect(shownLabels(body)).toEqual(['Swipe Left', 'Swipe Right']);
        expect(shownTitles(body)).toEqual(['Chat']);
    });

    test('matches the keys as they are written for the platform', () => {
        const { body, list } = fill(true);

        expect(list.filter('⌘+O')).toBe(1);
        expect(shownLabels(body)).toEqual(['Home']);
    });

    test('shows everything again for an empty query, and reports no row for a query that nothing matches', () => {
        const { body, list } = fill();

        expect(list.filter('zzzz')).toBe(0);
        expect(shownTitles(body)).toEqual([]);
        expect(list.filter('')).toBe(getShortcuts().length);
        expect(shownLabels(body)).toHaveLength(getShortcuts().length);
        expect(shownTitles(body)).toHaveLength(5);
    });
});

describe('Shortcut key labels', () => {
    test('shows the platform modifier as Ctrl, or as the command symbol on Apple platforms', () => {
        expect(formatKeyToken('Mod', { apple: false })).toBe('Ctrl');
        expect(formatKeyToken('Mod', { apple: true })).toBe('⌘');
    });

    test('leaves every other key as it is', () => {
        expect(formatKeyToken('Ctrl', { apple: true })).toBe('Ctrl');
        expect(formatKeyToken('Shift', { apple: false })).toBe('Shift');
        expect(formatKeyToken('O', { apple: true })).toBe('O');
    });

    test.each([
        ['MacIntel', true],
        ['MacARM', true],
        ['Win32', false],
        ['Linux x86_64', false],
        [undefined, false],
    ])('treats the platform %s as Apple: %s', (platform, expected) => {
        expect(isApplePlatform({ platform })).toBe(expected);
    });
});
