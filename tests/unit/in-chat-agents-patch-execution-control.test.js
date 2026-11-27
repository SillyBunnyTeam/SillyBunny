/**
 * @jest-environment jsdom
 */
import { afterEach, describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => `${text}${part}${values[index] ?? ''}`, ''),
    translate: text => text,
}));

const { createAgentSettingsControls } = await import('../../public/scripts/extensions/in-chat-agents/settings-controls.js');
const { mountAgentSettings } = await import('../../public/scripts/extensions/in-chat-agents/ui/settings-page.js');

const mounted = [];

function mountSettings(settings = {}) {
    document.body.innerHTML = '';
    const { store, fields } = createAgentSettingsControls();
    document.body.append(store);
    const host = document.createElement('div');
    document.body.append(host);
    const services = {
        fields,
        controls: new Map(fields.map(field => [field.id, document.getElementById(field.id)])),
        controlStore: store,
        readSettings: () => settings,
        applySetting: jest.fn(),
        resetBundledAgents: jest.fn(),
    };
    const page = mountAgentSettings({ host, services, onClose: jest.fn() });
    mounted.push(page);
    return { page, services, control: id => document.getElementById(`ica--${id}`) };
}

const rowOf = (page, key) => page.root.querySelector(`[data-sb-editor-field="${key}"]`);

afterEach(() => {
    for (const page of mounted.splice(0)) page.destroy();
    document.body.innerHTML = '';
});

describe('Patch Agents Execution control', () => {
    test('sits right after Append Agents Execution in Running Agents, with the same two choices', () => {
        const { page } = mountSettings();
        const append = rowOf(page, 'appendAgentsExecutionMode');
        const patch = rowOf(page, 'patchAgentsExecutionMode');

        expect(patch).not.toBeNull();
        expect(append.nextElementSibling).toBe(patch);
        const group = patch.closest('[data-sb-editor-field="running-agents"]');
        expect(group).not.toBeNull();
        expect(append.closest('[data-sb-editor-field="running-agents"]')).toBe(group);
        expect(patch.textContent).toContain('Patch Agents Execution');
        const choices = row => [...row.querySelectorAll('input[type="radio"]')].map(input => input.closest('label')?.textContent.trim());
        expect(choices(patch)).toEqual(choices(append));
        expect(choices(patch)).toEqual(['Parallel', 'Sequential']);
    });

    test('shows Sequential for a user whose saved settings have no key, and leaves Append Agents Execution on its own default', () => {
        const { page } = mountSettings({ appendAgentsExecutionMode: 'parallel' });

        expect(rowOf(page, 'patchAgentsExecutionMode').querySelector('input:checked').closest('label').textContent.trim()).toBe('Sequential');
        expect(rowOf(page, 'appendAgentsExecutionMode').querySelector('input:checked').closest('label').textContent.trim()).toBe('Parallel');
    });

    test('shows Parallel only for a saved value of parallel', () => {
        const { page } = mountSettings({ patchAgentsExecutionMode: 'parallel', appendAgentsExecutionMode: 'sequential' });

        expect(rowOf(page, 'patchAgentsExecutionMode').querySelector('input:checked').closest('label').textContent.trim()).toBe('Parallel');
        expect(rowOf(page, 'appendAgentsExecutionMode').querySelector('input:checked').closest('label').textContent.trim()).toBe('Sequential');
    });

    test('choosing Parallel changes its own hidden control and no other', () => {
        const { page, control } = mountSettings();
        const onChange = jest.fn();
        control('patchAgentsExecutionMode').addEventListener('change', event => onChange(event.target.value));
        const appendChange = jest.fn();
        control('appendAgentsExecutionMode').addEventListener('change', appendChange);

        const parallel = [...rowOf(page, 'patchAgentsExecutionMode').querySelectorAll('input[type="radio"]')].find(input => input.closest('label').textContent.trim() === 'Parallel');
        parallel.click();

        expect(onChange).toHaveBeenCalledWith('parallel');
        expect(appendChange).not.toHaveBeenCalled();
    });

    test('its description is placeholder copy that the placeholder rule can find', () => {
        const { page } = mountSettings();
        const subtitle = rowOf(page, 'patchAgentsExecutionMode').querySelector('.ds-row-subtitle');

        expect(subtitle.textContent).toBe('TODO(copy)');
        expect(subtitle.dataset.sbCopyPlaceholder).toBe('true');
    });
});
