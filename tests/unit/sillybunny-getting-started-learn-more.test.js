/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for data and DOM helpers. */
import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
const { createGettingStartedState, getGettingStartedSteps } = await import('../../public/scripts/sillybunny-home/getting-started.js');
const { createStepRow } = await import('../../public/scripts/sillybunny-home/step-rows.js');
const { findHelpTopic, getHelpSections } = await import('../../public/scripts/sillybunny-help/topics.js');

describe('the Help topic of each Getting Started step', () => {
    test('is the topic that the four featured Help topics name for it', () => {
        expect(Object.fromEntries(getGettingStartedSteps().map(step => [step.id, step.helpTopic]))).toEqual({
            connect: 'connect-to-a-model',
            preset: 'choose-a-preset',
            character: 'add-a-character',
            chat: 'start-a-chat',
        });
    });

    test('exists in the Help model, for every step', () => {
        const sections = getHelpSections();

        for (const step of getGettingStartedSteps()) {
            expect(findHelpTopic(sections, step.helpTopic)?.topic.id).toBe(step.helpTopic);
        }
    });
});

describe('the Learn More button of a step row', () => {
    const [connect, preset] = getGettingStartedSteps();

    function build(step, options = {}) {
        const onLearnMore = jest.fn();
        const built = createStepRow({ step, field: `test-${step.id}`, slot: step.slot, labelId: `test-${step.id}-title`, onShowMe: jest.fn(), onLearnMore, ...options });
        document.body.replaceChildren(built.row);
        return { ...built, onLearnMore };
    }

    test('sits in the text of the row, after its notes, and names the step it belongs to', () => {
        const state = createGettingStartedState(getGettingStartedSteps().map(step => step.id));
        const { row } = build(connect, { state });

        const learnMore = row.querySelector('.ds-row-text button');
        expect(learnMore.textContent).toBe('Learn More');
        expect(learnMore.getAttribute('aria-describedby')).toBe('test-connect-title');
        expect(learnMore.parentElement.lastElementChild).toBe(learnMore);
        expect(learnMore.previousElementSibling.classList.contains('sbHomeStepNotes')).toBe(true);
        expect([...row.querySelectorAll('.ds-row-suffix button')].map(button => button.textContent)).toEqual(['Show Me', 'Skip']);
    });

    test('is in the text of a row that has no state, too', () => {
        const { row } = build(connect);

        expect(row.querySelector('.ds-row-text button').textContent).toBe('Learn More');
        expect([...row.querySelectorAll('.ds-row-suffix button')].map(button => button.textContent)).toEqual(['Show Me']);
    });

    test('hands the Help topic of the step to the caller', () => {
        const state = createGettingStartedState(getGettingStartedSteps().map(step => step.id));
        const { row, onLearnMore } = build(preset, { state });

        [...row.querySelectorAll('button')].find(button => button.textContent === 'Learn More').click();

        expect(onLearnMore).toHaveBeenCalledTimes(1);
        expect(onLearnMore).toHaveBeenCalledWith('choose-a-preset');
    });

    test('stays on a step that is done, whose Skip button is gone', () => {
        const state = createGettingStartedState(getGettingStartedSteps().map(step => step.id));
        const { row, sync } = build(connect, { state });

        state.markDone('connect');
        sync();

        expect(row.querySelector('button[aria-pressed]').hidden).toBe(true);
        expect([...row.querySelectorAll('button')].filter(button => !button.hidden).map(button => button.textContent)).toEqual(['Learn More', 'Show Me']);
    });

    test('is not on a row that is not given a way to open Help', () => {
        const built = createStepRow({ step: connect, field: 'test-connect', slot: connect.slot, labelId: 'test-connect-title', onShowMe: jest.fn() });

        expect([...built.row.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Show Me']);
    });
});
