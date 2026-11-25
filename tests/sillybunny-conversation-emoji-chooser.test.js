/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Playwright does not recognize Jest test callbacks. */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const surfaces = [];
const openPopover = jest.fn((options) => {
    options.content.dataset.hosted = 'true';
    document.body.append(options.content);
    let open = true;
    const surface = {
        close: jest.fn(() => {
            if (open) {
                open = false;
                options.content.remove();
                options.onClose?.();
            }
        }),
        get isOpen() {
            return open;
        },
    };
    surfaces.push({ options, surface });
    return surface;
});
const loadStylesheetAsync = jest.fn(async () => undefined);
const pushRecentEmoji = jest.fn();
const readRecentEmoji = jest.fn(() => [{ e: '🙏', n: 'bitte' }]);
const table = {
    locale: 'en',
    groups: ['Smileys'],
    tones: ['a', 'b', 'c', 'd', 'e'],
    rows: [['😀', 'grinning face', 'smile', 0, 1]],
    getIndex: () => [{ name: 'grinning face', nameWords: ['grinning', 'face'], keywordWords: ['smile'], haystack: 'grinning face|smile' }],
};
const load = jest.fn(async () => table);
const whenStyled = jest.fn(async () => true);

await jest.unstable_mockModule('../public/scripts/sillybunny-action-menu.js', () => ({ openPopover }));
await jest.unstable_mockModule('../public/scripts/dynamic-styles.js', () => ({ loadStylesheetAsync }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/emoji/emoji-store.js', () => ({ pushRecentEmoji, readRecentEmoji }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/emoji/emoji-style-ready.js', () => ({ whenStyled }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/emoji/emoji-table.js', () => ({ emojiTables: { load, loadEnglish: load } }));

const { openEmojiChooser } = await import('../public/scripts/sillybunny-conversation/emoji/emoji-chooser.js');

const settle = async () => {
    for (let turn = 0; turn < 8; turn++) {
        await Promise.resolve();
    }
};

let trigger;
beforeEach(() => {
    surfaces.length = 0;
    document.body.replaceChildren();
    trigger = document.createElement('button');
    document.body.append(trigger);
    for (const mock of [openPopover, loadStylesheetAsync, whenStyled, pushRecentEmoji, readRecentEmoji, load]) {
        mock.mockClear();
    }
    load.mockImplementation(async () => table);
    window.matchMedia = jest.fn(() => ({ matches: false }));
});

describe('openEmojiChooser', () => {
    test('refuses a call that has no trigger, no known kind or no callback', () => {
        expect(() => openEmojiChooser({ kind: 'insert', onPick() {} })).toThrow(TypeError);
        expect(() => openEmojiChooser({ trigger, kind: 'other', onPick() {} })).toThrow(TypeError);
        expect(() => openEmojiChooser({ trigger, kind: 'insert' })).toThrow(TypeError);
    });

    test('loads its stylesheet, then opens a popover on the trigger with the chooser as its content, and fills it with the table', async () => {
        const handle = openEmojiChooser({ trigger, kind: 'insert', onPick() {}, bounds: document.body });
        expect(openPopover).not.toHaveBeenCalled();
        await settle();
        expect(loadStylesheetAsync).toHaveBeenCalledWith(expect.stringContaining('sillybunny-emoji-chooser.css?v='), expect.any(Object));
        expect(openPopover).toHaveBeenCalledTimes(1);
        const { options } = surfaces[0];
        expect(options.trigger).toBe(trigger);
        expect(options.title).toBe('Emoji');
        expect(options.bounds).toBe(document.body);
        expect(options.content.classList.contains('sb-emoji-chooser')).toBe(true);
        expect(options.content.dataset.state).toBe('ready');
        expect(options.content.querySelector('.sb-emoji-cell[data-emoji="😀"]')).not.toBeNull();
        expect(options.content.querySelector('[data-section="recent"] .sb-emoji-cell').dataset.emoji).toBe('🙏');
        expect(handle.isOpen).toBe(true);
    });

    test('opens the popover only once the rules of its sheet apply, because the popover measures its content when it opens', async () => {
        let applied;
        whenStyled.mockImplementationOnce(() => new Promise((resolve) => {
            applied = resolve;
        }));
        openEmojiChooser({ trigger, kind: 'insert', onPick() {} });
        await settle();
        expect(loadStylesheetAsync).toHaveBeenCalledTimes(1);
        expect(whenStyled).toHaveBeenCalledWith('sb-emoji-chooser', 'display', 'flex');
        expect(openPopover).not.toHaveBeenCalled();
        applied(true);
        await settle();
        expect(openPopover).toHaveBeenCalledTimes(1);
    });

    test('puts the focus in the search entry with a mouse, and on the chooser itself with touch until the grid is there', async () => {
        openEmojiChooser({ trigger, kind: 'insert', onPick() {} });
        await settle();
        expect(surfaces[0].options.initialFocus()).toBe(surfaces[0].options.content.querySelector('.sb-emoji-search-entry'));

        surfaces[0].surface.close();
        surfaces.length = 0;
        document.body.replaceChildren(trigger);
        window.matchMedia = jest.fn(() => ({ matches: true }));
        openEmojiChooser({ trigger, kind: 'insert', onPick() {} });
        await settle();
        expect(surfaces[0].options.initialFocus()).toBe(surfaces[0].options.content);
    });

    test('a pick records the emoji in the recents, closes the surface and then calls the caller', async () => {
        const onPick = jest.fn();
        const onClose = jest.fn();
        openEmojiChooser({ trigger, kind: 'react', onPick, onClose });
        await settle();
        const { options, surface } = surfaces[0];
        options.content.querySelector('.sb-emoji-grid .sb-emoji-cell[data-emoji="😀"]').click();
        expect(pushRecentEmoji).toHaveBeenCalledWith({ e: '😀', n: 'grinning face' });
        expect(surface.close).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onPick).toHaveBeenCalledWith('😀', { name: 'grinning face', keepOpen: false });
    });

    test('opened again from the same trigger, it closes; called again before it has opened, it never opens', async () => {
        const onClose = jest.fn();
        openEmojiChooser({ trigger, kind: 'insert', onPick() {}, onClose });
        openEmojiChooser({ trigger, kind: 'insert', onPick() {}, onClose });
        await settle();
        expect(openPopover).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);

        openEmojiChooser({ trigger, kind: 'insert', onPick() {}, onClose });
        await settle();
        expect(openPopover).toHaveBeenCalledTimes(1);
        openEmojiChooser({ trigger, kind: 'insert', onPick() {}, onClose });
        expect(surfaces[0].surface.close).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    test('opening it from another trigger closes the first', async () => {
        const other = document.createElement('button');
        document.body.append(other);
        const firstClosed = jest.fn();
        openEmojiChooser({ trigger, kind: 'insert', onPick() {}, onClose: firstClosed });
        await settle();
        openEmojiChooser({ trigger: other, kind: 'insert', onPick() {} });
        await settle();
        expect(firstClosed).toHaveBeenCalledTimes(1);
        expect(openPopover).toHaveBeenCalledTimes(2);
    });

    test('shows an error with a way to try again when the table cannot be loaded, and loads it when asked', async () => {
        load.mockRejectedValueOnce(new Error('offline'));
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        openEmojiChooser({ trigger, kind: 'insert', onPick() {} });
        await settle();
        const { content } = surfaces[0].options;
        expect(content.dataset.state).toBe('error');
        content.querySelector('.sb-emoji-message-retry').click();
        await settle();
        expect(content.dataset.state).toBe('ready');
        expect(load).toHaveBeenCalledTimes(2);
        console.warn.mockRestore();
    });

    test('calls onClose once when the surface is closed from outside', async () => {
        const onClose = jest.fn();
        const handle = openEmojiChooser({ trigger, kind: 'insert', onPick() {}, onClose });
        await settle();
        surfaces[0].options.onClose();
        surfaces[0].options.onClose();
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(handle.isOpen).toBe(false);
    });

    test('opens when its stylesheet fails to load', async () => {
        loadStylesheetAsync.mockRejectedValueOnce(new Error('404'));
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        openEmojiChooser({ trigger, kind: 'insert', onPick() {} });
        await settle();
        expect(openPopover).toHaveBeenCalledTimes(1);
        console.warn.mockRestore();
    });
});
