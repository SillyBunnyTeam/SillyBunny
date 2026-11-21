/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for the signal that a dialog's pages are moving. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { PAGING_CLASS, afterPageMotion, isPageMotionRunning } from '../../public/scripts/sillybunny-editor/page-motion.js';

const flush = async () => {
    for (let round = 0; round < 4; round++) {
        await Promise.resolve();
    }
};

/** A dialog surface with a node deep inside one of its pages. */
function mountDialog({ moving = false } = {}) {
    const surface = document.createElement('section');
    surface.className = 'sb-dialog';
    surface.classList.toggle(PAGING_CLASS, moving);
    const page = document.createElement('section');
    page.className = 'sb-dialog__page';
    const node = document.createElement('div');
    page.append(node);
    surface.append(page);
    document.body.append(surface);
    return { surface, node };
}

afterEach(() => {
    document.body.replaceChildren();
});

describe('isPageMotionRunning', () => {
    test('is true for a node inside a dialog surface that holds the paging class, however deep', () => {
        const { node } = mountDialog({ moving: true });

        expect(isPageMotionRunning(node)).toBe(true);
    });

    test('is false while no page slide or height motion runs', () => {
        const { node } = mountDialog();

        expect(isPageMotionRunning(node)).toBe(false);
    });

    test('is false for a node that is in no dialog, such as the hero of Home', () => {
        const hero = document.createElement('span');
        document.body.append(hero);
        document.body.classList.add(PAGING_CLASS);

        expect(isPageMotionRunning(hero)).toBe(false);
    });

    test('is false for a node that is not in the document', () => {
        expect(isPageMotionRunning(document.createElement('div'))).toBe(false);
    });
});

describe('afterPageMotion', () => {
    test('calls back once, after the motion has ended, and not before', async () => {
        const { surface, node } = mountDialog({ moving: true });
        const callback = jest.fn();

        afterPageMotion(node, callback);
        await flush();
        expect(callback).not.toHaveBeenCalled();

        surface.classList.remove(PAGING_CLASS);
        await flush();
        expect(callback).toHaveBeenCalledTimes(1);

        surface.classList.add(PAGING_CLASS);
        surface.classList.remove(PAGING_CLASS);
        await flush();
        expect(callback).toHaveBeenCalledTimes(1);
    });

    test('keeps waiting when other classes change while the motion goes on', async () => {
        const { surface, node } = mountDialog({ moving: true });
        const callback = jest.fn();
        afterPageMotion(node, callback);

        surface.classList.add('sb-dialog--wide');
        await flush();

        expect(callback).not.toHaveBeenCalled();
    });

    test('calls back in a microtask when no motion runs, so the caller can treat both cases alike', async () => {
        const { node } = mountDialog();
        const callback = jest.fn();

        afterPageMotion(node, callback);
        expect(callback).not.toHaveBeenCalled();
        await flush();

        expect(callback).toHaveBeenCalledTimes(1);
    });

    test('does not call back after it was cancelled', async () => {
        const { surface, node } = mountDialog({ moving: true });
        const callback = jest.fn();

        const cancel = afterPageMotion(node, callback);
        cancel();
        surface.classList.remove(PAGING_CLASS);
        await flush();

        expect(callback).not.toHaveBeenCalled();
    });

    test('does not call back when it was cancelled before the microtask of an idle surface', async () => {
        const { node } = mountDialog();
        const callback = jest.fn();

        afterPageMotion(node, callback)();
        await flush();

        expect(callback).not.toHaveBeenCalled();
    });
});
