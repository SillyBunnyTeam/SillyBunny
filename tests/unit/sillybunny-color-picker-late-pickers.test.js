/** @jest-environment jsdom */
import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({ animateIn: jest.fn(), MOTION_FAST: 120 }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-sheet.js', () => ({ blockUpstreamDrawerClose: jest.fn() }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/breakpoints.js', () => ({ MENU_SHEET_QUERY: '(max-width: 768px)' }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/overlay-host.js', () => ({
    hostOverlayLayer: menu => document.body.append(menu),
    linkChildLayer: () => () => {},
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/dialog.js', () => ({ openDialog: jest.fn() }));

let initializeColorPickers;
const originalGetClientRects = Element.prototype.getClientRects;

beforeAll(async () => {
    // The real vendor element, because the enhancement depends on what its connectedCallback does.
    (0, eval)(readFileSync(path.join(publicRoot, 'lib', 'toolcool-color-picker.js'), 'utf8'));
    window.matchMedia = () => ({ matches: false });
    Element.prototype.getClientRects = () => [{ width: 52, height: 40 }];
    ({ initializeColorPickers } = await import('../../public/scripts/sillybunny-color-picker.js'));
    await initializeColorPickers();
});

afterAll(() => {
    Element.prototype.getClientRects = originalGetClientRects;
});

beforeEach(() => {
    document.body.innerHTML = '<div id="host"></div><div id="chat"></div>';
});

const state = picker => {
    const button = picker.shadowRoot.querySelector('.button');
    return {
        styled: Boolean(picker.shadowRoot.querySelector('[data-sb-color-picker-style]')),
        label: button.getAttribute('aria-label'),
        haspopup: button.getAttribute('aria-haspopup'),
    };
};

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function openMenu(picker) {
    picker.shadowRoot.querySelector('.button').dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
}

describe('colour pickers added after startup', () => {
    test('are styled and labelled when they are added, before any pointer event', async () => {
        const host = document.getElementById('host');
        host.insertAdjacentHTML('beforeend', '<div class="ds-row"><span class="ds-row-label">Late colour</span><toolcool-color-picker id="late"></toolcool-color-picker></div>');
        await settle();

        expect(state(document.getElementById('late'))).toEqual({ styled: true, label: 'Late colour', haspopup: 'dialog' });
    });

    test('are enhanced whichever way they enter the document', async () => {
        const host = document.getElementById('host');
        const appended = document.createElement('toolcool-color-picker');
        host.append(appended);
        host.innerHTML += '<toolcool-color-picker color="#ff0000"></toolcool-color-picker>';
        const template = document.createElement('template');
        template.innerHTML = '<div><toolcool-color-picker color="#00ff00"></toolcool-color-picker></div>';
        host.append(template.content);
        await settle();

        const pickers = [...host.querySelectorAll('toolcool-color-picker')];
        expect(pickers).toHaveLength(3);
        expect(pickers.map(state).every(entry => entry.styled && entry.haspopup === 'dialog')).toBe(true);
    });

    test('are enhanced again when the vendor rebuilds the button because the picker was moved', async () => {
        const host = document.getElementById('host');
        host.innerHTML = '<toolcool-color-picker id="moved"></toolcool-color-picker><div id="target"></div>';
        await settle();
        const picker = document.getElementById('moved');
        expect(state(picker).styled).toBe(true);

        document.getElementById('target').append(picker);
        await settle();

        expect(state(picker)).toEqual({ styled: true, label: 'Select Color', haspopup: 'dialog' });
    });

    test('inside the chat are left alone', async () => {
        document.getElementById('chat').innerHTML = '<toolcool-color-picker id="in-chat"></toolcool-color-picker>';
        await settle();

        const picker = document.getElementById('in-chat');
        expect(picker.shadowRoot.querySelector('[data-sb-color-picker-style]')).toBeNull();
        expect(picker.shadowRoot.querySelector('.button').getAttribute('aria-haspopup')).toBeNull();
    });
});

describe('the menu of a colour picker that leaves the document', () => {
    test('closes when the picker is removed', async () => {
        document.getElementById('host').innerHTML = '<toolcool-color-picker id="removed"></toolcool-color-picker>';
        await settle();
        const picker = document.getElementById('removed');
        openMenu(picker);
        expect(document.getElementById('sb-color-picker-menu')).not.toBeNull();

        picker.remove();
        await settle();

        expect(document.getElementById('sb-color-picker-menu')).toBeNull();
    });

    test('closes when an ancestor of the picker is removed', async () => {
        document.getElementById('host').innerHTML = '<section id="panel"><div><toolcool-color-picker id="nested"></toolcool-color-picker></div></section>';
        await settle();
        openMenu(document.getElementById('nested'));
        expect(document.getElementById('sb-color-picker-menu')).not.toBeNull();

        document.getElementById('panel').remove();
        await settle();

        expect(document.getElementById('sb-color-picker-menu')).toBeNull();
    });

    test('stays open while the picker is still in the document', async () => {
        document.getElementById('host').innerHTML = '<toolcool-color-picker id="kept"></toolcool-color-picker>';
        await settle();
        openMenu(document.getElementById('kept'));

        document.getElementById('host').append(document.createElement('div'));
        await settle();

        expect(document.getElementById('sb-color-picker-menu')).not.toBeNull();
    });
});
