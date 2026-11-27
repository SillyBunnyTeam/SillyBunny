/** @jest-environment jsdom */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const {
    BLANK_FLAG_KEY,
    EMOJI_FONT_ATTRIBUTE,
    applyEmojiFont,
    drawsInk,
    isBlankFontBrowser,
} = await import('../public/scripts/sillybunny-conversation/emoji/emoji-font.js');

const SAFARI_17_0 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const SAFARI_17_1_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1';
const SAFARI_17_1_2 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1.2 Safari/605.1.15';
const CHROME_ON_IOS_17_1 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/119.0.6045.169 Mobile/15E148 Safari/604.1';
const IPAD_17_0 = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const SAFARI_17_2 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15';
const SAFARI_16_4_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1';
const SAFARI_26 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0';

describe('isBlankFontBrowser', () => {
    test.each([
        ['Safari 17.0', SAFARI_17_0],
        ['Safari 17.1 on an iPhone', SAFARI_17_1_IOS],
        ['Safari 17.1.2', SAFARI_17_1_2],
        ['Chrome on iOS 17.1, which is WebKit', CHROME_ON_IOS_17_1],
        ['an iPad on iPadOS 17.0', IPAD_17_0],
    ])('is true for %s', (_name, userAgent) => {
        expect(isBlankFontBrowser(userAgent)).toBe(true);
    });

    test.each([
        ['Safari 17.2', SAFARI_17_2],
        ['Safari 16.4 on an iPhone', SAFARI_16_4_IOS],
        ['Safari 26', SAFARI_26],
        ['Chrome', CHROME],
        ['Firefox', FIREFOX],
        ['an empty user agent', ''],
    ])('is false for %s', (_name, userAgent) => {
        expect(isBlankFontBrowser(userAgent)).toBe(false);
    });
});

describe('drawsInk', () => {
    test('is true when the face leaves a mark and false when the canvas stays empty', () => {
        expect(drawsInk(() => 4300)).toBe(true);
        expect(drawsInk(() => 0)).toBe(false);
    });

    test('takes a canvas that cannot be read as a face that works', () => {
        expect(drawsInk(() => {
            throw new Error('blocked');
        })).toBe(true);
    });
});

function makeFonts() {
    const target = new EventTarget();
    return Object.assign(target, { load: jest.fn(async () => []) });
}

describe('applyEmojiFont', () => {
    let root;
    let storage;

    beforeEach(() => {
        root = document.createElement('html');
        const data = new Map();
        storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) };
    });

    const finishLoad = (fonts, family = 'SB Emoji') => {
        const event = new Event('loadingdone');
        event.fontfaces = [{ family, status: 'loaded' }];
        fonts.dispatchEvent(event);
    };

    test('leaves the font on by default, and turns it off for the preference', () => {
        applyEmojiFont({ useDeviceEmoji: false, root, userAgent: CHROME, storage, fonts: makeFonts(), canvasInk: () => 1 });
        expect(root.hasAttribute(EMOJI_FONT_ATTRIBUTE)).toBe(false);
        applyEmojiFont({ useDeviceEmoji: true, root, userAgent: CHROME, storage, fonts: makeFonts(), canvasInk: () => 1 });
        expect(root.getAttribute(EMOJI_FONT_ATTRIBUTE)).toBe('device');
        applyEmojiFont({ useDeviceEmoji: false, root, userAgent: CHROME, storage, fonts: makeFonts(), canvasInk: () => 1 });
        expect(root.hasAttribute(EMOJI_FONT_ATTRIBUTE)).toBe(false);
    });

    test('skips the font from the first frame on Safari 17.0 and 17.1, so there is no blank flash', () => {
        applyEmojiFont({ useDeviceEmoji: false, root, userAgent: SAFARI_17_1_IOS, storage, fonts: makeFonts(), canvasInk: () => 1 });
        expect(root.getAttribute(EMOJI_FONT_ATTRIBUTE)).toBe('device');
    });

    test('checks the face once it has loaded, and falls back to the device emoji when it draws nothing', () => {
        const fonts = makeFonts();
        applyEmojiFont({ useDeviceEmoji: false, root, userAgent: CHROME, storage, fonts, canvasInk: () => 0 });
        expect(root.hasAttribute(EMOJI_FONT_ATTRIBUTE)).toBe(false);
        finishLoad(fonts);
        expect(root.getAttribute(EMOJI_FONT_ATTRIBUTE)).toBe('device');
        expect(storage.getItem(BLANK_FLAG_KEY)).toBe(CHROME);
    });

    test('keeps the font when the face draws, and checks only once', () => {
        const fonts = makeFonts();
        const canvasInk = jest.fn(() => 5000);
        applyEmojiFont({ useDeviceEmoji: false, root, userAgent: CHROME, storage, fonts, canvasInk });
        finishLoad(fonts);
        finishLoad(fonts);
        expect(root.hasAttribute(EMOJI_FONT_ATTRIBUTE)).toBe(false);
        expect(canvasInk).toHaveBeenCalledTimes(1);
        expect(storage.getItem(BLANK_FLAG_KEY)).toBeNull();
    });

    test('ignores the loading of any other face, and never starts a load itself', () => {
        const fonts = makeFonts();
        const canvasInk = jest.fn(() => 0);
        applyEmojiFont({ useDeviceEmoji: false, root, userAgent: CHROME, storage, fonts, canvasInk });
        finishLoad(fonts, 'Adwaita Sans');
        expect(canvasInk).not.toHaveBeenCalled();
        expect(fonts.load).not.toHaveBeenCalled();
    });

    test('remembers a blank face by the user agent, so the next page skips the font from the first frame', () => {
        storage.setItem(BLANK_FLAG_KEY, CHROME);
        applyEmojiFont({ useDeviceEmoji: false, root, userAgent: CHROME, storage, fonts: makeFonts(), canvasInk: () => 1 });
        expect(root.getAttribute(EMOJI_FONT_ATTRIBUTE)).toBe('device');

        const other = document.createElement('html');
        applyEmojiFont({ useDeviceEmoji: false, root: other, userAgent: FIREFOX, storage, fonts: makeFonts(), canvasInk: () => 1 });
        expect(other.hasAttribute(EMOJI_FONT_ATTRIBUTE)).toBe(false);
    });

    test('stops watching when the user turns the font off', () => {
        const fonts = makeFonts();
        const canvasInk = jest.fn(() => 0);
        applyEmojiFont({ useDeviceEmoji: false, root, userAgent: CHROME, storage, fonts, canvasInk });
        applyEmojiFont({ useDeviceEmoji: true, root, userAgent: CHROME, storage, fonts, canvasInk });
        finishLoad(fonts);
        expect(canvasInk).not.toHaveBeenCalled();
    });

    test('works with no storage and no font set', () => {
        expect(() => applyEmojiFont({ useDeviceEmoji: false, root, userAgent: CHROME, storage: null, fonts: null, canvasInk: () => 1 })).not.toThrow();
        expect(root.hasAttribute(EMOJI_FONT_ATTRIBUTE)).toBe(false);
    });
});
