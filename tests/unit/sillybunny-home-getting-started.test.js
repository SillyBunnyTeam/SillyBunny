/* eslint-disable playwright/no-standalone-expect -- Jest contracts for pure functions. */
import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
const { createGettingStartedState, formatProgress, getGettingStartedSteps, getIntroArtName, getIntroLineSlot, getSharedGettingStartedState } = await import('../../public/scripts/sillybunny-home/getting-started.js');

describe('Getting Started steps', () => {
    test('lists the four steps in order with their titles', () => {
        expect(getGettingStartedSteps().map(step => step.title)).toEqual([
            'Connect a Model',
            'Set Up a Preset',
            'Get a Character Card',
            'Start Chatting',
        ]);
    });

    test('marks only the preset step as optional', () => {
        expect(getGettingStartedSteps().filter(step => step.optional).map(step => step.id)).toEqual(['preset']);
    });

    test('gives each step a body copy slot and a Show Me target', () => {
        const steps = getGettingStartedSteps();

        expect(steps.map(step => step.slot)).toEqual(['GS-1-BODY', 'GS-2-BODY', 'GS-3-BODY', 'GS-4-BODY']);
        expect(steps.map(step => step.target)).toEqual(['connections', 'presets', 'characters', 'mode-menu']);
    });
});

describe('Getting Started progress text', () => {
    test('is one string with its numbers filled in', () => {
        expect(formatProgress(0, 4)).toBe('0 of 4');
        expect(formatProgress(3, 4)).toBe('3 of 4');
    });
});

describe('Getting Started state', () => {
    const ids = ['connect', 'preset', 'character', 'chat'];

    test('starts with every step open', () => {
        const state = createGettingStartedState(ids);

        expect(state.getTotal()).toBe(4);
        expect(state.getResolvedCount()).toBe(0);
        expect(ids.some(id => state.isSkipped(id) || state.isDone(id))).toBe(false);
    });

    test('counts a skipped step as resolved and counts it back out when it is restored', () => {
        const state = createGettingStartedState(ids);

        state.setSkipped('preset', true);
        expect(state.isSkipped('preset')).toBe(true);
        expect(state.getResolvedCount()).toBe(1);

        state.setSkipped('preset', false);
        expect(state.isSkipped('preset')).toBe(false);
        expect(state.getResolvedCount()).toBe(0);
    });

    test('tells subscribers when a step changes, and only then', () => {
        const state = createGettingStartedState(ids);
        const listener = jest.fn();
        const unsubscribe = state.subscribe(listener);

        state.setSkipped('connect', true);
        state.setSkipped('connect', true);
        expect(listener).toHaveBeenCalledTimes(1);

        unsubscribe();
        state.setSkipped('connect', false);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    test('does not share state between two instances', () => {
        const first = createGettingStartedState(ids);
        const second = createGettingStartedState(ids);

        first.setSkipped('chat', true);

        expect(second.isSkipped('chat')).toBe(false);
    });

    test('fails loudly on a step that does not exist', () => {
        const state = createGettingStartedState(ids);

        expect(() => state.setSkipped('nope', true)).toThrow(/unknown/i);
        expect(() => state.isSkipped('nope')).toThrow(/unknown/i);
    });

    test('starts shown, and hides itself once every step is skipped', () => {
        const state = createGettingStartedState(ids);
        expect(state.isHidden()).toBe(false);

        ids.slice(0, 3).forEach(id => state.setSkipped(id, true));
        expect(state.isHidden()).toBe(false);

        state.setSkipped(ids[3], true);
        expect(state.isHidden()).toBe(true);
    });

    test('Show Getting Started brings it back even while every step is skipped', () => {
        const state = createGettingStartedState(ids);
        ids.forEach(id => state.setSkipped(id, true));

        state.setHidden(false);

        expect(state.isHidden()).toBe(false);
        expect(state.getResolvedCount()).toBe(4);
    });

    test('can be hidden by hand, and tells subscribers about each change of the flag only', () => {
        const state = createGettingStartedState(ids);
        const listener = jest.fn();
        state.subscribe(listener);

        state.setHidden(true);
        state.setHidden(true);
        expect(state.isHidden()).toBe(true);
        expect(listener).toHaveBeenCalledTimes(1);

        state.setHidden(false);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    test('one shared state serves every render of Home', () => {
        expect(getSharedGettingStartedState()).toBe(getSharedGettingStartedState());
        expect(getSharedGettingStartedState().getTotal()).toBe(4);
    });
});

describe('the intro art of the Getting Started window', () => {
    const ids = getGettingStartedSteps().map(step => step.id);

    test.each([
        [0, 4, 'gs-reisen'],
        [1, 4, 'gs-reisen'],
        [3, 4, 'gs-reisen'],
        [4, 4, 'gs-reisen-done'],
    ])('%i of %i steps resolved shows %s', (resolved, total, expected) => {
        expect(getIntroArtName(resolved, total)).toBe(expected);
    });

    test('follows the state: done once the last step is skipped, and back when one is un-skipped', () => {
        const state = createGettingStartedState(ids);
        const art = () => getIntroArtName(state.getResolvedCount(), state.getTotal());

        ids.forEach(id => state.setSkipped(id, true));
        expect(art()).toBe('gs-reisen-done');

        state.setSkipped('preset', false);
        expect(art()).toBe('gs-reisen');
    });

    test('a state with no steps is not done', () => {
        expect(getIntroArtName(0, 0)).toBe('gs-reisen');
    });
});

describe('the intro line of the Getting Started window', () => {
    const ids = getGettingStartedSteps().map(step => step.id);

    test.each([
        [0, 4, 'GS-INTRO'],
        [3, 4, 'GS-INTRO'],
        [4, 4, 'GS-INTRO-DONE'],
        [0, 0, 'GS-INTRO'],
    ])('%i of %i steps resolved says %s', (resolved, total, expected) => {
        expect(getIntroLineSlot(resolved, total)).toBe(expected);
    });

    test('changes with the art, and back, as the state does', () => {
        const state = createGettingStartedState(ids);
        const pose = () => [getIntroArtName(state.getResolvedCount(), state.getTotal()), getIntroLineSlot(state.getResolvedCount(), state.getTotal())];

        ids.forEach(id => state.setSkipped(id, true));
        expect(pose()).toEqual(['gs-reisen-done', 'GS-INTRO-DONE']);

        state.setSkipped('chat', false);
        expect(pose()).toEqual(['gs-reisen', 'GS-INTRO']);
    });
});
