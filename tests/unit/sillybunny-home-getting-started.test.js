/* eslint-disable playwright/no-standalone-expect -- Jest contracts for pure functions. */
import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
const { createGettingStartedState, formatProgress, getGettingStartedSteps } = await import('../../public/scripts/sillybunny-home/getting-started.js');

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
});
