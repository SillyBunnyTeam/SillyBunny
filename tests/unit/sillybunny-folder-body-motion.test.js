/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const plays = [];
const play = jest.fn((element, keyframes, options) => { plays.push({ element, keyframes, options }); return {}; });
const prefersReducedMotion = jest.fn(() => false);
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    MOTION_SLOW: 250, play, prefersReducedMotion,
}));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
}));
const { animateFolderBody } = await import('../../public/scripts/sillybunny-editor/folder-row.js');

let body;

/** jsdom has no layout and no Web Animations, so the box and the running animations are set by hand. */
function setBox(height) {
    body.getBoundingClientRect = () => ({ height });
}

beforeEach(() => {
    plays.length = 0;
    play.mockClear();
    prefersReducedMotion.mockReturnValue(false);
    document.body.replaceChildren();
    body = document.createElement('div');
    body.style.paddingBlockStart = '9px';
    body.style.paddingBlockEnd = '9px';
    body.style.opacity = '1';
    document.body.append(body);
    body.getAnimations = () => [];
    setBox(200);
});

describe('animateFolderBody', () => {
    test('opening grows the body from nothing, padding and border included, to the height it has settled at', () => {
        animateFolderBody(body, true);
        expect(plays).toHaveLength(1);
        const [from, to] = plays[0].keyframes;
        expect(from).toMatchObject({ height: '0px', paddingBlockStart: '0px', paddingBlockEnd: '0px', borderBlockStartWidth: '0px', borderBlockEndWidth: '0px', opacity: 0 });
        expect(to).toEqual({ height: '200px', opacity: 1 });
        expect(plays[0].options).toMatchObject({ fill: 'none', inert: false });
        expect(plays[0].options.styles).toMatchObject({ 'box-sizing': 'border-box', overflow: 'hidden' });
        // No duration or easing of its own: the shared defaults of `play` are the ones the member rows use.
        expect(plays[0].options).not.toHaveProperty('duration');
        expect(plays[0].options).not.toHaveProperty('easing');
    });

    test('closing shrinks it to nothing, holds the end, blocks input and reports the end', () => {
        const onEnd = jest.fn();
        animateFolderBody(body, false, { onEnd });
        const [from, to] = plays[0].keyframes;
        expect(from).toEqual({ height: '200px', opacity: 1 });
        expect(to).toMatchObject({ height: '0px', paddingBlockStart: '0px', paddingBlockEnd: '0px', opacity: 0 });
        expect(plays[0].options).toMatchObject({ fill: 'forwards', inert: true, onEnd });
    });

    test('a motion that is running is cancelled and the new one starts from the height and opacity on screen', () => {
        const cancel = jest.fn();
        body.getAnimations = () => [{ cancel }];
        setBox(80);
        body.style.opacity = '0.4';
        // The settled height is measured after the cancel, so the cancel has to put the box back.
        cancel.mockImplementation(() => setBox(200));
        animateFolderBody(body, false);
        expect(cancel).toHaveBeenCalledTimes(1);
        const [from, to] = plays[0].keyframes;
        expect(from).toMatchObject({ height: '80px', opacity: 0.4, paddingBlockStart: '9px', paddingBlockEnd: '9px' });
        expect(to.height).toBe('0px');

        plays.length = 0;
        setBox(80);
        animateFolderBody(body, true);
        expect(plays[0].keyframes[0]).toMatchObject({ height: '80px', opacity: 0.4 });
        expect(plays[0].keyframes[1]).toEqual({ height: '200px', opacity: 1 });
    });

    test('reduced motion plays nothing and reports the end at once', () => {
        prefersReducedMotion.mockReturnValue(true);
        const onEnd = jest.fn();
        expect(animateFolderBody(body, false, { onEnd })).toBeNull();
        expect(play).not.toHaveBeenCalled();
        expect(onEnd).toHaveBeenCalledTimes(1);
    });
});
