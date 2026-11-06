/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
// A menu item that opens a side panel is hidden once its menu closes. The activation history finds the
// control that opened that menu, so focus has somewhere to go when the panel closes.
import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../../public/lib/dialog-polyfill.esm.js', () => ({
    default: { registerDialog: jest.fn(), reposition: jest.fn() },
}));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
    translate: text => text,
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    closeActionMenu: jest.fn(),
    openActionMenu: jest.fn(),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({
    closePicker: jest.fn(),
}));

const { bindActivationHistory, getMenuTriggerFor } = await import('../../public/scripts/sillybunny-editor/side-panel.js');

beforeAll(() => {
    bindActivationHistory();
});

afterEach(() => {
    document.body.innerHTML = '';
});

/** Clicks each element in order and returns the elements by id. */
function mountAndClick(html, ...ids) {
    document.body.innerHTML = html;
    const get = id => document.getElementById(id);
    ids.forEach(id => get(id).click());
    return get;
}

describe('getMenuTriggerFor', () => {
    test.each([
        ['an ARIA menu', '<button id="trigger">Menu</button><div role="menu"><button id="item" role="menuitem">Item</button></div>'],
        ['an action menu', '<button id="trigger">Menu</button><div class="sb-action-menu"><button id="item">Item</button></div>'],
        ['the composer Options menu, which has no role', '<button id="trigger">Menu</button><div id="options"><a id="item">Item</a></div>'],
    ])('returns the control that opened %s', (_name, html) => {
        const get = mountAndClick(html, 'trigger', 'item');

        expect(getMenuTriggerFor(get('item'))).toBe(get('trigger'));
    });

    test('returns null for an opener that is not in a menu', () => {
        const get = mountAndClick('<button id="trigger">Menu</button><button id="item">Plain button</button>', 'trigger', 'item');

        expect(getMenuTriggerFor(get('item'))).toBeNull();
    });

    test('returns null for a menu item that was not the last control activated', () => {
        const get = mountAndClick('<button id="trigger">Menu</button><div role="menu"><button id="item" role="menuitem">Item</button></div><button id="later">Later</button>', 'trigger', 'item', 'later');

        expect(getMenuTriggerFor(get('item'))).toBeNull();
    });

    test('returns null when there is no opener', () => {
        expect(getMenuTriggerFor(null)).toBeNull();
    });

    test('keeps the trigger when the same item is clicked twice', () => {
        const get = mountAndClick('<button id="trigger">Menu</button><div role="menu"><button id="item" role="menuitem">Item</button></div>', 'trigger', 'item', 'item');

        expect(getMenuTriggerFor(get('item'))).toBe(get('trigger'));
    });

    test('ignores a click on a container that is only a programmatic focus target', () => {
        const get = mountAndClick(
            '<button id="trigger">Menu</button><div role="menu"><button id="item" role="menuitem">Item</button></div><div tabindex="-1"><span id="plain">Text</span></div>',
            'trigger', 'item', 'plain',
        );

        expect(getMenuTriggerFor(get('item'))).toBe(get('trigger'));
    });
});
