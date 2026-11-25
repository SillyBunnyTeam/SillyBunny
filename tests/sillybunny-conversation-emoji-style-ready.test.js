/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';

const { STYLE_WAIT_FRAMES, whenStyled } = await import('../public/scripts/sillybunny-conversation/emoji/emoji-style-ready.js');

function fakeFrames() {
    const queue = [];
    window.requestAnimationFrame = callback => queue.push(callback);
    return () => queue.shift()?.();
}

afterEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
});

describe('whenStyled', () => {
    test('resolves at once when the rules already apply, and leaves no probe behind', async () => {
        document.head.innerHTML = '<style>.sb-emoji-chooser { display: flex; }</style>';
        await expect(whenStyled('sb-emoji-chooser', 'display', 'flex')).resolves.toBe(true);
        expect(document.body.children).toHaveLength(0);
    });

    test('waits for the frames in which a browser applies a sheet that has just loaded', async () => {
        const step = fakeFrames();
        const done = jest.fn();
        const waiting = whenStyled('sb-emoji-chooser', 'display', 'flex').then(done);
        step();
        step();
        await Promise.resolve();
        expect(done).not.toHaveBeenCalled();
        document.head.innerHTML = '<style>.sb-emoji-chooser { display: flex; }</style>';
        step();
        await waiting;
        expect(done).toHaveBeenCalledWith(true);
        expect(document.body.children).toHaveLength(0);
    });

    test('gives up after a number of frames, so that a sheet that never applies does not keep the chooser shut', async () => {
        const step = fakeFrames();
        const waiting = whenStyled('sb-emoji-chooser', 'display', 'flex');
        for (let frame = 0; frame <= STYLE_WAIT_FRAMES + 1; frame++) {
            step();
        }
        await expect(waiting).resolves.toBe(false);
        expect(document.body.children).toHaveLength(0);
    });
});
