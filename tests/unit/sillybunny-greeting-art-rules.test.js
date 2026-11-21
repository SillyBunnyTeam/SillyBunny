/* eslint-disable playwright/no-standalone-expect -- Jest contracts for pure functions. */
import { describe, expect, test } from '@jest/globals';
import { ASSISTANTS } from '../../public/scripts/sillybunny-home/assistant-registry.js';
import {
    GREETING_ART_HEIGHT_SHARE,
    GREETING_ART_MIN_FILL,
    findGreetingArt,
    pickPixelStep,
    sourceFor,
} from '../../public/scripts/sillybunny-home/greeting-art-rules.js';

const REISEN = 'default_AssistantReisen.png';
const TEWI = 'default_AssistantTewi.png';
const GREETING = Object.freeze({ is_user: false, is_system: false, mes: 'Hello.' });

/** What the chat holds when message 0 is the greeting of Reisen, with the parts a test changes overridden. */
const greetingOf = (overrides = {}) => ({ avatar: REISEN, messageId: 0, message: GREETING, ...overrides });

describe('the greeting picture of the assistant registry', () => {
    const withArt = ASSISTANTS.filter(assistant => assistant.greetingArt);

    test('belongs to Reisen and Tewi and to no other assistant', () => {
        expect(withArt.map(assistant => assistant.id)).toEqual(['reisen', 'tewi']);
    });

    test.each(withArt)('of $id is two bundled files of this origin with a size', ({ id, greetingArt }) => {
        expect(greetingArt.src).toBe(`/img/sillybunny/greeting-${id}.webp`);
        expect(greetingArt.src2x).toBe(`/img/sillybunny/greeting-${id}@2x.webp`);
        expect(Number.isInteger(greetingArt.width) && greetingArt.width > 0).toBe(true);
        expect(Number.isInteger(greetingArt.height) && greetingArt.height > 0).toBe(true);
    });
});

describe('the message that gets a greeting picture', () => {
    test('is message 0 of the bundled card, from the character, at its first swipe', () => {
        expect(findGreetingArt(greetingOf())).toMatchObject({ assistantId: 'reisen', src: '/img/sillybunny/greeting-reisen.webp' });
        expect(findGreetingArt(greetingOf({ avatar: TEWI }))).toMatchObject({ assistantId: 'tewi', src: '/img/sillybunny/greeting-tewi.webp' });
    });

    test('carries the display name of the assistant from the registry and both files', () => {
        expect(findGreetingArt(greetingOf())).toMatchObject({ name: 'Reisen', src2x: '/img/sillybunny/greeting-reisen@2x.webp' });
        expect(findGreetingArt(greetingOf({ avatar: TEWI }))).toMatchObject({ name: 'Tewi', src2x: '/img/sillybunny/greeting-tewi@2x.webp' });
    });

    test('takes a swipe_id of 0 and one that is not set as the first swipe', () => {
        expect(findGreetingArt(greetingOf({ message: { ...GREETING, swipe_id: 0 } }))).not.toBeNull();
        expect(findGreetingArt(greetingOf({ message: { ...GREETING, swipe_id: undefined } }))).not.toBeNull();
    });

    test('is not a message of the user', () => {
        expect(findGreetingArt(greetingOf({ message: { ...GREETING, is_user: true } }))).toBeNull();
    });

    test('is not a system message, which is what hiding a message makes of it', () => {
        expect(findGreetingArt(greetingOf({ message: { ...GREETING, is_system: true } }))).toBeNull();
    });

    test('is not any message after the first', () => {
        expect(findGreetingArt(greetingOf({ messageId: 1 }))).toBeNull();
        expect(findGreetingArt(greetingOf({ messageId: 2 }))).toBeNull();
    });

    test('is not a swipe after the first', () => {
        expect(findGreetingArt(greetingOf({ message: { ...GREETING, swipe_id: 1 } }))).toBeNull();
        expect(findGreetingArt(greetingOf({ message: { ...GREETING, swipe_id: 2 } }))).toBeNull();
    });

    test('is not there when the chat has no first message', () => {
        expect(findGreetingArt(greetingOf({ message: undefined }))).toBeNull();
        expect(findGreetingArt(greetingOf({ message: null }))).toBeNull();
    });

    test('is not of another character, however the card is named', () => {
        expect(findGreetingArt(greetingOf({ avatar: 'default_Seraphina.png' }))).toBeNull();
        expect(findGreetingArt(greetingOf({ avatar: 'default_SillyBunnyGuide.png' }))).toBeNull();
        expect(findGreetingArt(greetingOf({ avatar: 'Assistant Reisen.png' }))).toBeNull();
        expect(findGreetingArt(greetingOf({ avatar: undefined }))).toBeNull();
    });

    test('is not in a group chat, where nothing tells a greeting from a reply', () => {
        expect(findGreetingArt(greetingOf({ inGroup: true }))).toBeNull();
    });

    test('is not in a Conversation thread', () => {
        expect(findGreetingArt(greetingOf({ inConversation: true }))).toBeNull();
    });

    test('is found in the assistants that it is given, by their avatar file', () => {
        const art = { src: '/x.png', src2x: '/x@2x.png', width: 1, height: 1 };
        const assistants = [{ id: 'other', name: 'Other', defaultAvatar: 'other.png', greetingArt: art }];

        expect(findGreetingArt(greetingOf({ avatar: 'other.png' }), assistants)).toMatchObject({ assistantId: 'other', name: 'Other', src: '/x.png' });
        expect(findGreetingArt(greetingOf(), assistants)).toBeNull();
    });
});

describe('the size and the file of a pixel-art picture', () => {
    const pick = (input) => pickPixelStep({ artWidth: 768, artHeight: 512, dpr: 1, ...input });

    test('use up to 70% of the visible chat, and a stepped picture must fill 75% of its room', () => {
        expect(GREETING_ART_HEIGHT_SHARE).toBe(0.7);
        expect(GREETING_ART_MIN_FILL).toBe(0.75);
    });

    describe('where a whole step fills enough of the room', () => {
        test('draws the 1x file at step 1 in a column of 1000 pixels at one device pixel per CSS pixel', () => {
            expect(pick({ maxCssWidth: 1000, maxCssHeight: 700 })).toEqual({ mode: 'pixel', step: 1, source: '1x', cssWidth: 768, cssHeight: 512 });
        });

        test('takes the largest whole step that fits, and halves its CSS size on a doubled display', () => {
            expect(pick({ maxCssWidth: 1600, maxCssHeight: 1100 })).toEqual({ mode: 'pixel', step: 2, source: '1x', cssWidth: 1536, cssHeight: 1024 });
            expect(pick({ dpr: 2, maxCssWidth: 1000, maxCssHeight: 700 })).toEqual({ mode: 'pixel', step: 2, source: '1x', cssWidth: 768, cssHeight: 512 });
        });

        test('is held to the height when the height is the tighter side', () => {
            const scale = pick({ maxCssWidth: 2000, maxCssHeight: 530 });

            expect(scale).toMatchObject({ mode: 'pixel', step: 1, source: '1x', cssWidth: 768, cssHeight: 512 });
            expect(scale.cssHeight).toBeLessThanOrEqual(530);
        });

        test('lands on whole device pixels at a fractional ratio', () => {
            const scale = pick({ dpr: 1.25, maxCssWidth: 800, maxCssHeight: 800 });

            expect(scale).toMatchObject({ mode: 'pixel', step: 1 });
            expect(scale.cssWidth * 1.25).toBeCloseTo(768, 9);
            expect(scale.cssHeight * 1.25).toBeCloseTo(512, 9);
        });

        test('takes a column that is exactly a step wide at a ratio whose division does not come out whole', () => {
            // 768 / 1.15 CSS pixels hold one step, and the division gives a little under 1.
            expect(pick({ dpr: 1.15, maxCssWidth: 768 / 1.15, maxCssHeight: 1000 })).toMatchObject({ mode: 'pixel', step: 1, source: '1x' });
        });
    });

    describe('where it does not', () => {
        test('fills a column of 690 pixels smoothly from the 2x file at one device pixel per CSS pixel', () => {
            const scale = pick({ maxCssWidth: 690, maxCssHeight: 461 });

            expect(scale).toMatchObject({ mode: 'smooth', step: null, source: '2x', cssWidth: 690 });
            expect(scale.cssHeight).toBeCloseTo(460, 9);
        });

        test('fills a column of 690 pixels smoothly from the 2x file on a doubled display, where step 1 would be 384 pixels', () => {
            const scale = pick({ dpr: 2, maxCssWidth: 690, maxCssHeight: 461 });

            expect(scale).toMatchObject({ mode: 'smooth', step: null, source: '2x', cssWidth: 690 });
            expect(scale.cssHeight).toBeCloseTo(460, 9);
        });

        test('keeps the aspect of the picture, and fills the room on its tighter side', () => {
            const wide = pick({ maxCssWidth: 600, maxCssHeight: 2000 });
            const short = pick({ maxCssWidth: 2000, maxCssHeight: 400 });

            expect(wide).toMatchObject({ mode: 'smooth', cssWidth: 600, cssHeight: 400 });
            expect(short).toMatchObject({ mode: 'smooth', cssWidth: 600, cssHeight: 400 });
        });

        test('scales down smoothly where one device pixel per art pixel does not fit', () => {
            expect(pick({ maxCssWidth: 300, maxCssHeight: 2000 })).toMatchObject({ mode: 'smooth', source: '2x', cssWidth: 300, cssHeight: 200 });
            expect(pick({ dpr: 3, maxCssWidth: 250, maxCssHeight: 2000 })).toMatchObject({ mode: 'smooth', source: '2x', cssWidth: 250 });
        });
    });

    describe('at the threshold', () => {
        test('a stepped picture of exactly 75% of the room is drawn at its step, and anything less is not', () => {
            expect(pick({ maxCssWidth: 1024, maxCssHeight: 2000 })).toMatchObject({ mode: 'pixel', step: 1 });
            expect(pick({ maxCssWidth: 1025, maxCssHeight: 2000 })).toMatchObject({ mode: 'smooth', source: '2x' });
            expect(pick({ maxCssWidth: 2048, maxCssHeight: 3000 })).toMatchObject({ mode: 'pixel', step: 2 });
            expect(pick({ maxCssWidth: 2049, maxCssHeight: 3000 })).toMatchObject({ mode: 'smooth', source: '2x' });
        });

        test('counts the room as the fitted picture and not as the column, so a short chat does not count against the step', () => {
            // The column is 1400 pixels, but the chat only lets a picture 795 wide fit, and step 1 is 768 of those.
            expect(pick({ maxCssWidth: 1400, maxCssHeight: 530 })).toMatchObject({ mode: 'pixel', step: 1 });
        });
    });

    describe('on a phone of 390 pixels at three device pixels per CSS pixel', () => {
        test('draws step 1 at 256 CSS pixels in a column of 280, which it fills', () => {
            const scale = pick({ dpr: 3, maxCssWidth: 280, maxCssHeight: 480 });

            expect(scale).toMatchObject({ mode: 'pixel', step: 1, source: '1x' });
            expect(scale.cssWidth).toBeCloseTo(256, 9);
        });

        test('fills a column of 350 smoothly, because 256 of it is under 75%', () => {
            expect(pick({ dpr: 3, maxCssWidth: 350, maxCssHeight: 480 })).toMatchObject({ mode: 'smooth', source: '2x', cssWidth: 350 });
        });
    });

    describe('in Visual Novel mode, where the chat is a few hundred pixels tall', () => {
        test.each([1, 2, 3])('fills the small room smoothly from the 2x file at %i device pixels per CSS pixel', (dpr) => {
            const scale = pick({ dpr, maxCssWidth: 690, maxCssHeight: 173 * GREETING_ART_HEIGHT_SHARE });

            expect(scale).toMatchObject({ mode: 'smooth', source: '2x' });
            expect(scale.cssHeight).toBeCloseTo(121.1, 9);
            expect(scale.cssWidth).toBeCloseTo(181.65, 9);
        });
    });

    test('gives no size to a room that has none yet', () => {
        expect(pick({ maxCssWidth: 0, maxCssHeight: 400 })).toBeNull();
        expect(pick({ maxCssWidth: 400, maxCssHeight: 0 })).toBeNull();
        expect(pick({ maxCssWidth: Number.NaN, maxCssHeight: 400 })).toBeNull();
        expect(pick({ maxCssWidth: -5, maxCssHeight: 400 })).toBeNull();
    });

    test('refuses a picture or a pixel ratio that has no size', () => {
        expect(() => pick({ artWidth: 0, maxCssWidth: 400, maxCssHeight: 400 })).toThrow(RangeError);
        expect(() => pick({ artHeight: -1, maxCssWidth: 400, maxCssHeight: 400 })).toThrow(RangeError);
        expect(() => pick({ dpr: 0, maxCssWidth: 400, maxCssHeight: 400 })).toThrow(/dpr/);
        expect(() => pick({ dpr: Number.NaN, maxCssWidth: 400, maxCssHeight: 400 })).toThrow(RangeError);
    });

    test('names the file that a scale needs', () => {
        const art = { src: '/a.png', src2x: '/a@2x.png' };

        expect(sourceFor(art, { source: '1x' })).toBe('/a.png');
        expect(sourceFor(art, { source: '2x' })).toBe('/a@2x.png');
    });
});
