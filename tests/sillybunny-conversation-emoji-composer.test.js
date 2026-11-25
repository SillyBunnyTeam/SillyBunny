/** @jest-environment jsdom */
import { describe, expect, jest, test } from '@jest/globals';

const { insertEmojiAtCaret } = await import('../public/scripts/sillybunny-conversation/emoji/emoji-insert.js');
const { hasNativeEmojiPicker, isEmojiShortcut } = await import('../public/scripts/sillybunny-conversation/emoji/emoji-shortcut.js');

function makeEntry(value, start = value.length, end = start) {
    const entry = document.createElement('textarea');
    document.body.append(entry);
    entry.value = value;
    entry.setSelectionRange(start, end);
    return entry;
}

describe('insertEmojiAtCaret', () => {
    test('puts the emoji at the caret and leaves the caret after it', () => {
        const entry = makeEntry('hello world', 5);
        insertEmojiAtCaret(entry, '😀', { start: 5, end: 5 });
        expect(entry.value).toBe('hello😀 world');
        expect(entry.selectionStart).toBe('hello😀'.length);
        expect(entry.selectionEnd).toBe(entry.selectionStart);
    });

    test('replaces the selection that was there when the chooser opened, not the one that the entry has now', () => {
        const entry = makeEntry('hello world', 0, 5);
        entry.setSelectionRange(11, 11);
        insertEmojiAtCaret(entry, '👋', { start: 0, end: 5 });
        expect(entry.value).toBe('👋 world');
    });

    test('clamps a range that no longer fits a text that has become shorter', () => {
        const entry = makeEntry('hi');
        insertEmojiAtCaret(entry, '😀', { start: 40, end: 50 });
        expect(entry.value).toBe('hi😀');
    });

    test('tells the entry that it changed, so that it grows and the draft is kept, and takes the focus back', () => {
        const entry = makeEntry('a');
        const listener = jest.fn();
        entry.addEventListener('input', listener);
        insertEmojiAtCaret(entry, '😀', { start: 1, end: 1 });
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0].bubbles).toBe(true);
        expect(document.activeElement).toBe(entry);
    });

    test('answers where the caret is after the emoji, so that a second pick goes after the first', () => {
        const entry = makeEntry('ab');
        const caret = insertEmojiAtCaret(entry, '😀', { start: 1, end: 1 });
        expect(caret).toBe('a😀'.length);
        insertEmojiAtCaret(entry, '👍', { start: caret, end: caret });
        expect(entry.value).toBe('a😀👍b');
    });

    test('leaves the focus where it is when asked to, because moving it out of an open chooser closes the chooser', () => {
        const entry = makeEntry('ab');
        const other = document.createElement('button');
        document.body.append(other);
        other.focus();
        insertEmojiAtCaret(entry, '😀', { start: 1, end: 1 }, { focus: false });
        expect(document.activeElement).toBe(other);
        expect(entry.value).toBe('a😀b');
    });

    test('works on an empty entry, and inserts a sequence whole', () => {
        const entry = makeEntry('');
        insertEmojiAtCaret(entry, '👨‍👩‍👧', { start: 0, end: 0 });
        expect(entry.value).toBe('👨‍👩‍👧');
    });
});

const keyEvent = (init = {}) => new KeyboardEvent('keydown', { key: '.', code: 'Period', ctrlKey: true, bubbles: true, cancelable: true, ...init });

describe('isEmojiShortcut', () => {
    test('is Ctrl and the period key, by its key or by its place on the keyboard', () => {
        expect(isEmojiShortcut(keyEvent())).toBe(true);
        expect(isEmojiShortcut(keyEvent({ key: 'ю', code: 'Period' }))).toBe(true);
        expect(isEmojiShortcut(keyEvent({ key: '.', code: '' }))).toBe(true);
    });

    test.each([
        ['without Ctrl', { ctrlKey: false }],
        ['with Alt', { altKey: true }],
        ['with Shift', { shiftKey: true }],
        ['with Meta', { metaKey: true }],
        ['another key', { key: ',', code: 'Comma' }],
    ])('is not it %s', (_name, init) => {
        expect(isEmojiShortcut(keyEvent(init))).toBe(false);
    });

    test('is not it while a composition is going on, or when the key repeats', () => {
        expect(isEmojiShortcut(keyEvent({ isComposing: true }))).toBe(false);
        expect(isEmojiShortcut(keyEvent({ repeat: true }))).toBe(false);
    });
});

describe('hasNativeEmojiPicker', () => {
    const FIREFOX_LINUX = major => `Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:${major}.0) Gecko/20100101 Firefox/${major}.0`;

    test('is true for Firefox 150 and later on Linux, which opens the GTK picker with the same key', () => {
        expect(hasNativeEmojiPicker(FIREFOX_LINUX(150))).toBe(true);
        expect(hasNativeEmojiPicker(FIREFOX_LINUX(157))).toBe(true);
        expect(hasNativeEmojiPicker('Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0')).toBe(true);
    });

    test.each([
        ['Firefox 149 on Linux', FIREFOX_LINUX(149)],
        ['Firefox on Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:157.0) Gecko/20100101 Firefox/157.0'],
        ['Firefox on macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:157.0) Gecko/20100101 Firefox/157.0'],
        ['Firefox on Android', 'Mozilla/5.0 (Android 15; Mobile; rv:157.0) Gecko/157.0 Firefox/157.0'],
        ['Chrome on Linux', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'],
        ['an empty user agent', ''],
    ])('is false for %s', (_name, userAgent) => {
        expect(hasNativeEmojiPicker(userAgent)).toBe(false);
    });
});
