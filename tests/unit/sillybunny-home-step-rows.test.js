/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for DOM helpers. */
import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
const { createGettingStartedState, getGettingStartedSteps } = await import('../../public/scripts/sillybunny-home/getting-started.js');
const { createStepRow } = await import('../../public/scripts/sillybunny-home/step-rows.js');

const [connect, preset] = getGettingStartedSteps();

function build(step, options = {}) {
    const onShowMe = jest.fn();
    const built = createStepRow({ step, field: `test-${step.id}`, slot: step.slot, labelId: `test-${step.id}-title`, onShowMe, ...options });
    document.body.replaceChildren(built.row);
    return { ...built, onShowMe };
}

const buttonsOf = row => [...row.querySelectorAll('button')].map(button => button.textContent);

describe('the shared step row', () => {
    test('shows the step title, a marked placeholder for its text, and Show Me, which names the step it belongs to', () => {
        const { row } = build(connect);

        expect(row.querySelector('.ds-row-label').textContent).toBe('Connect a Model');
        expect(row.querySelector('.ds-row-label').id).toBe('test-connect-title');
        const subtitle = row.querySelector('.ds-row-subtitle');
        expect([subtitle.textContent, subtitle.dataset.sbCopyPlaceholder, subtitle.dataset.sbCopySlot]).toEqual(['TODO(copy)', 'true', 'GS-1-BODY']);
        expect(buttonsOf(row)).toEqual(['Show Me']);
        expect(row.querySelector('button').getAttribute('aria-describedby')).toBe('test-connect-title');
    });

    test('Show Me hands the step target to the caller', () => {
        const { row, onShowMe } = build(preset);

        row.querySelector('button').click();

        expect(onShowMe).toHaveBeenCalledTimes(1);
        expect(onShowMe).toHaveBeenCalledWith('presets');
    });

    test('without a state it offers neither Skip nor the Optional and Skipped labels', () => {
        const { row } = build(preset);

        expect(buttonsOf(row)).toEqual(['Show Me']);
        expect(row.querySelectorAll('.sbHomeTag')).toHaveLength(0);
        expect(row.dataset.sbStepState).toBeUndefined();
    });

    test('with a state it adds Skip, marks an optional step, and follows the state', () => {
        const state = createGettingStartedState(getGettingStartedSteps().map(step => step.id));
        const { row, sync } = build(preset, { state });
        state.subscribe(sync);
        const skip = [...row.querySelectorAll('button')].find(button => button.textContent === 'Skip');
        const tags = () => [...row.querySelectorAll('.sbHomeTag')].filter(tag => !tag.hidden).map(tag => tag.textContent);

        expect(tags()).toEqual(['Optional']);
        expect(skip.getAttribute('aria-pressed')).toBe('false');
        expect(row.dataset.sbStepState).toBe('open');

        skip.click();

        expect(state.isSkipped('preset')).toBe(true);
        expect(skip.getAttribute('aria-pressed')).toBe('true');
        expect(tags()).toEqual(['Optional', 'Skipped']);
        expect(row.dataset.sbStepState).toBe('skipped');

        skip.click();

        expect(state.isSkipped('preset')).toBe(false);
        expect(tags()).toEqual(['Optional']);
    });

    test('keeps the notes on a line of their own under the text, never inside the title', () => {
        const state = createGettingStartedState(getGettingStartedSteps().map(step => step.id));
        const { row } = build(preset, { state });
        const notes = row.querySelector('.ds-row-text > .sbHomeStepNotes');

        expect(notes).not.toBeNull();
        expect(row.querySelector('.ds-row-label .sbHomeTag')).toBeNull();
    });

    test('an optional step always has its note line, and Skipped joins Optional on it', () => {
        const state = createGettingStartedState(getGettingStartedSteps().map(step => step.id));
        const { row, sync } = build(preset, { state });
        state.subscribe(sync);
        const notes = row.querySelector('.sbHomeStepNotes');

        expect(notes.hidden).toBe(false);
        expect([...notes.querySelectorAll('.sbHomeTag')].map(tag => tag.hidden)).toEqual([false, true]);

        state.setSkipped('preset', true);

        expect(notes.hidden).toBe(false);
        expect([...notes.querySelectorAll('.sbHomeTag')].map(tag => tag.hidden)).toEqual([false, false]);
    });

    test('any other step has no note line at rest and gets one only while it is skipped', () => {
        const state = createGettingStartedState(getGettingStartedSteps().map(step => step.id));
        const { row, sync } = build(connect, { state });
        state.subscribe(sync);
        const notes = row.querySelector('.sbHomeStepNotes');

        expect(notes.hidden).toBe(true);

        state.setSkipped('connect', true);
        expect(notes.hidden).toBe(false);
        expect(notes.textContent).toBe('Skipped');

        state.setSkipped('connect', false);
        expect(notes.hidden).toBe(true);
    });

    test('a step that is not optional carries no Optional label', () => {
        const state = createGettingStartedState(getGettingStartedSteps().map(step => step.id));
        const { row } = build(connect, { state });

        expect([...row.querySelectorAll('.sbHomeTag')].map(tag => tag.textContent)).toEqual(['Skipped']);
        expect(row.querySelector('.sbHomeTag').hidden).toBe(true);
    });
});
