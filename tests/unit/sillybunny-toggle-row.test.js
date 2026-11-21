/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom uses synchronous DOM assertions. */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { createToggleRow } from '../../public/scripts/sillybunny-editor/toggle-row.js';

const choices = [['openai', 'Chat Completions'], ['textgenerationwebui', 'Text Completions'], ['other', 'Other']];

beforeEach(() => {
    document.body.replaceChildren();
});

function mount(options = {}) {
    const result = createToggleRow({ label: 'Backend Type', field: 'backend', choices, value: 'openai', ...options });
    document.body.append(result.row);
    return result;
}

const radios = row => [...row.querySelectorAll('input[type="radio"]')];

describe('createToggleRow', () => {
    test('uses one native radio group named by the row title, with the initial value checked', () => {
        const { row, group } = mount();
        const inputs = radios(row);
        expect(inputs).toHaveLength(3);
        expect(new Set(inputs.map(input => input.name)).size).toBe(1);
        expect(inputs.map(input => input.checked)).toEqual([true, false, false]);
        expect(group.getAttribute('role')).toBe('radiogroup');
        expect(group.hasAttribute('aria-label')).toBe(false);
        expect(document.getElementById(group.getAttribute('aria-labelledby')).textContent).toBe('Backend Type');
        expect(row.querySelector('.ds-row-label').textContent).toBe('Backend Type');
    });

    test('segments are labels only, with neutral selected styling from the compact variant', () => {
        const { row, group } = mount();
        expect(row.querySelectorAll('.sb-boolean-radio-option i, .sb-boolean-radio-option img, .sb-boolean-radio-option svg')).toHaveLength(0);
        expect([...row.querySelectorAll('.sb-boolean-radio-option > span')].map(span => span.textContent)).toEqual(['Chat Completions', 'Text Completions', 'Other']);
        expect(group.classList.contains('sb-segmented-control--compact')).toBe(true);
    });

    test('notifies once per user change and setValue is silent by default', () => {
        const onChange = jest.fn();
        const result = mount({ onChange });
        const inputs = radios(result.row);
        inputs[1].checked = true;
        inputs[1].dispatchEvent(new Event('change', { bubbles: true }));
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith('textgenerationwebui');
        expect(result.getValue()).toBe('textgenerationwebui');
        result.setValue('other');
        expect(inputs[2].checked).toBe(true);
        expect(onChange).toHaveBeenCalledTimes(1);
        result.setValue('openai', { silent: false });
        expect(onChange).toHaveBeenLastCalledWith('openai');
    });

    test('values keep their original type', () => {
        const onChange = jest.fn();
        const result = createToggleRow({ label: 'Count', field: 'count', choices: [[1, 'One'], [2, 'Two']], value: 1, onChange });
        const inputs = radios(result.row);
        inputs[1].checked = true;
        inputs[1].dispatchEvent(new Event('change'));
        expect(onChange).toHaveBeenCalledWith(2);
        expect(result.getValue()).toBe(2);
    });

    test('a value that matches no choice leaves every segment unchecked', () => {
        const result = mount({ value: 'missing' });
        expect(radios(result.row).every(input => !input.checked)).toBe(true);
        expect(result.getValue()).toBeNull();
    });

    test('fill puts the title above full-width segments', () => {
        const { row, group } = mount({ fill: true });
        expect(row.classList.contains('ds-row--stacked')).toBe(true);
        expect(group.classList.contains('ds-toggle-row__group--fill')).toBe(true);
    });

    test('setDisabled makes every segment insensitive', () => {
        const result = mount();
        result.setDisabled(true);
        expect(radios(result.row).every(input => input.disabled)).toBe(true);
        expect(result.row.getAttribute('aria-disabled')).toBe('true');
        result.setDisabled(false);
        expect(radios(result.row).every(input => !input.disabled)).toBe(true);
    });

    test('rejects fewer than two choices', () => {
        expect(() => createToggleRow({ label: 'Only', field: 'only', choices: [['a', 'A']], value: 'a' })).toThrow(RangeError);
    });
});
