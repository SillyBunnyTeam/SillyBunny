/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
// bindHeaderLayout moves a long title to a second header row only for the selection count, because
// that is the one title that must stay readable.
import { afterEach, describe, expect, jest, test } from '@jest/globals';

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

const { bindHeaderLayout } = await import('../../public/scripts/sillybunny-editor/dialog.js');

const settle = async () => { for (let index = 0; index < 5; index++) await Promise.resolve(); };

/**
 * Builds a header with fixed measurements. With a 412 px header the row has 400 px to share. The side
 * columns are 40 px and 100 px, so a title up to 200 px stays centred, up to 260 px fits when it is
 * allowed to leave the centre, and anything wider needs a row of its own.
 */
function buildHeader({ selection, titleWidth }) {
    const header = document.createElement('div');
    header.className = selection ? 'sb-dialog__header is-selection-mode' : 'sb-dialog__header';
    header.innerHTML = `
        <div class="sb-dialog__header-start"></div>
        <div class="sb-dialog__titles"><h2 class="sb-dialog__title">Title</h2></div>
        <div class="sb-dialog__header-end"></div>`;
    document.body.append(header);
    const measure = (node, property, value) => Object.defineProperty(node, property, { configurable: true, get: () => value() });
    const state = { titleWidth };
    measure(header, 'clientWidth', () => 412);
    measure(header.querySelector('.sb-dialog__header-start'), 'offsetWidth', () => 40);
    measure(header.querySelector('.sb-dialog__header-end'), 'offsetWidth', () => 100);
    measure(header.querySelector('.sb-dialog__title'), 'scrollWidth', () => state.titleWidth);
    return { header, state, unbind: bindHeaderLayout(header) };
}

const resync = async header => {
    header.append(document.createElement('span'));
    await settle();
};

afterEach(() => {
    document.body.innerHTML = '';
});

describe('bindHeaderLayout stacking', () => {
    test('stacks the selection count title when it cannot share the row', () => {
        const { header, unbind } = buildHeader({ selection: true, titleWidth: 300 });

        expect(header.hasAttribute('data-header-stacked')).toBe(true);
        expect(header.hasAttribute('data-header-centering-loose')).toBe(true);
        unbind();
    });

    test('never stacks a title outside selection mode, however wide it is', () => {
        const { header, unbind } = buildHeader({ selection: false, titleWidth: 300 });

        expect(header.hasAttribute('data-header-stacked')).toBe(false);
        expect(header.hasAttribute('data-header-centering-loose')).toBe(false);
        unbind();
    });

    test('lets a selection title that fits off-centre leave the centre without stacking', () => {
        const { header, unbind } = buildHeader({ selection: true, titleWidth: 230 });

        expect(header.hasAttribute('data-header-stacked')).toBe(false);
        expect(header.hasAttribute('data-header-centering-loose')).toBe(true);
        unbind();
    });

    test('keeps a selection title that fits the centre fully centred', () => {
        const { header, unbind } = buildHeader({ selection: true, titleWidth: 150 });

        expect(header.hasAttribute('data-header-stacked')).toBe(false);
        expect(header.hasAttribute('data-header-centering-loose')).toBe(false);
        unbind();
    });

    test('moves a title that the centred column clips by one pixel to the loose layout and keeps it there', async () => {
        const { header, state, unbind } = buildHeader({ selection: false, titleWidth: 201 });
        // Centred, the title box is 200px wide. Loose, the box is as wide as the title text.
        const title = header.querySelector('.sb-dialog__title');
        Object.defineProperty(title, 'clientWidth', {
            configurable: true,
            get: () => (header.hasAttribute('data-header-centering-loose') ? state.titleWidth : 200),
        });
        await resync(header);

        expect(header.hasAttribute('data-header-centering-loose')).toBe(true);
        await resync(header);
        expect(header.hasAttribute('data-header-centering-loose')).toBe(true);
        unbind();
    });

    test('keeps a clipped title that sits exactly on the centred capacity loose, without toggling', async () => {
        const { header, state, unbind } = buildHeader({ selection: false, titleWidth: 200 });
        // The centred box is one pixel short of the text, so it clips, while the text width equals the capacity.
        const title = header.querySelector('.sb-dialog__title');
        Object.defineProperty(title, 'clientWidth', {
            configurable: true,
            get: () => (header.hasAttribute('data-header-centering-loose') ? state.titleWidth : 199),
        });
        const changes = [];
        new MutationObserver(records => changes.push(...records)).observe(header, { attributes: true, attributeFilter: ['data-header-centering-loose'] });
        await resync(header);
        for (let pass = 0; pass < 5; pass++) await resync(header);

        expect(header.hasAttribute('data-header-centering-loose')).toBe(true);
        expect(changes).toHaveLength(1);
        unbind();
    });

    test('returns a loose title to the centre once it is a pixel inside the centred capacity', async () => {
        const { header, state, unbind } = buildHeader({ selection: false, titleWidth: 201 });
        const title = header.querySelector('.sb-dialog__title');
        Object.defineProperty(title, 'clientWidth', { configurable: true, get: () => 200 });
        await resync(header);
        expect(header.hasAttribute('data-header-centering-loose')).toBe(true);

        state.titleWidth = 200;
        await resync(header);
        expect(header.hasAttribute('data-header-centering-loose')).toBe(true);

        state.titleWidth = 198;
        await resync(header);
        expect(header.hasAttribute('data-header-centering-loose')).toBe(false);
        unbind();
    });

    test('clears the stack when the title gets shorter', async () => {
        const { header, state, unbind } = buildHeader({ selection: true, titleWidth: 300 });
        expect(header.hasAttribute('data-header-stacked')).toBe(true);

        state.titleWidth = 120;
        await resync(header);

        expect(header.hasAttribute('data-header-stacked')).toBe(false);
        unbind();
    });

    test('clears the stack when selection mode ends', async () => {
        const { header, unbind } = buildHeader({ selection: true, titleWidth: 300 });
        expect(header.hasAttribute('data-header-stacked')).toBe(true);

        header.classList.remove('is-selection-mode');
        await resync(header);

        expect(header.hasAttribute('data-header-stacked')).toBe(false);
        expect(header.hasAttribute('data-header-centering-loose')).toBe(false);
        unbind();
    });
});
