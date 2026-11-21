/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom uses synchronous DOM assertions. */
import { jest, describe, test, expect, afterEach } from '@jest/globals';
import { readFileSync } from 'node:fs';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((out, string, index) => out + string + (index < values.length ? values[index] : ''), ''),
    translate: value => value,
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    animateHeightFrom: jest.fn(), animateIn: jest.fn(), animateOut: jest.fn(), play: jest.fn(), stopMotion: jest.fn(), MOTION_SLOW: 250,
    MOTION_FAST: 200, MOTION_POPOVER_CLOSE: 150, MOTION_EASE_OUT_CUBIC: 'ease', SPRING_SHEET: {},
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({ MOBILE_QUERY: '(max-width: 768px)', positionPopover: jest.fn(() => '0px 0') }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-sheet.js', () => ({ blockUpstreamDrawerClose: jest.fn(), createSheetController: jest.fn() }));

const { pickerNoneLabel } = await import('../../public/scripts/sillybunny-connections-form.js');

const t = (strings, ...values) => strings.reduce((out, string, index) => out + string + (index < values.length ? values[index] : ''), '');

function select(id, { multiple = false, className = '', options = [] } = {}) {
    const node = document.createElement('select');
    node.id = id;
    node.multiple = multiple;
    node.className = className;
    for (const [value, text] of options) node.append(new Option(text, value));
    document.body.append(node);
    return node;
}

afterEach(() => {
    delete globalThis.jQuery;
    document.body.replaceChildren();
});

describe('pickerNoneLabel', () => {
    test('empty provider, quantization and Horde selects show their select2 placeholders where select2 does not exist', () => {
        expect(pickerNoneLabel(select('nanogpt_allowed_providers', { multiple: true }), t)).toBe('Select providers');
        expect(pickerNoneLabel(select('nanogpt_ignored_providers', { multiple: true }), t)).toBe('Select providers');
        expect(pickerNoneLabel(select('openrouter_providers_chat', { multiple: true, className: 'openrouter_providers' }), t)).toBe('Select providers. No selection = all providers.');
        expect(pickerNoneLabel(select('openrouter_quantizations_text', { multiple: true, className: 'openrouter_quantizations' }), t)).toBe('Select quantizations. No selection = all quantizations.');
        expect(pickerNoneLabel(select('horde_model', { multiple: true }), t)).toBe('Select Horde models');
    });

    test('model selects show Select a model, and the two that select2 labels [Currently loaded] keep that', () => {
        for (const id of ['model_openai_select', 'model_aimlapi_select', 'model_nanogpt_select', 'mancer_model', 'ollama_model', 'generic_model_select', 'openrouter_model']) {
            expect(pickerNoneLabel(select(id), t)).toBe('Select a model');
        }
        expect(pickerNoneLabel(select('tabby_model'), t)).toBe('[Currently loaded]');
        expect(pickerNoneLabel(select('llamacpp_model'), t)).toBe('[Currently loaded]');
    });

    test('a select that never had a placeholder stays empty', () => {
        expect(pickerNoneLabel(select('model_pollinations_select'), t)).toBe('');
        expect(pickerNoneLabel(select('model_moonshot_select'), t)).toBe('');
    });

    test('precedence: the select\'s own placeholder, select2\'s, an empty option, then the list', () => {
        const node = select('nanogpt_allowed_providers', { multiple: true, options: [['', 'Empty option text']] });
        expect(pickerNoneLabel(node, t)).toBe('Empty option text');
        globalThis.jQuery = () => ({ data: () => ({ options: { get: () => ({ text: 'Select2 placeholder' }) } }) });
        expect(pickerNoneLabel(node, t)).toBe('Select2 placeholder');
        node.dataset.placeholder = 'Own placeholder';
        expect(pickerNoneLabel(node, t)).toBe('Own placeholder');
    });

    test('every select2 placeholder in the provider files is what pickerNoneLabel returns for that select', () => {
        const NOT_ADOPTED_BY_CONNECTIONS = new Set(['#completion_prompt_manager_popup_entry_form_injection_trigger']);
        const found = [];
        for (const file of ['openai.js', 'textgen-models.js', 'horde.js']) {
            const source = readFileSync(new URL(`../../public/scripts/${file}`, import.meta.url), 'utf8');
            for (const call of source.matchAll(/(\$\('([^']+)'\)|\$?\b\w+)\.select2\(\{/g)) {
                const receiver = call[2] ?? source.match(new RegExp(`const ${call[1].replace('$', '\\$')} = \\$\\('([^']+)'\\)`))?.[1];
                expect(receiver).toBeTruthy();
                let depth = 1;
                let end = call.index + call[0].length;
                while (depth && end < source.length) depth += { '{': 1, '}': -1 }[source[end++]] ?? 0;
                const placeholder = source.slice(call.index, end).match(/\bplaceholder: t`([^`]+)`/)?.[1];
                if (placeholder && !NOT_ADOPTED_BY_CONNECTIONS.has(receiver)) found.push({ file, receiver, placeholder });
            }
        }
        expect(found.length).toBeGreaterThan(20);
        for (const { receiver, placeholder } of found) {
            for (const part of receiver.split(',').map(selector => selector.trim())) {
                const node = select(part.startsWith('#') ? part.slice(1) : `placeholder_fixture_${part.slice(1)}`, { multiple: true, className: part.startsWith('.') ? part.slice(1) : '' });
                expect([part, pickerNoneLabel(node, t)]).toEqual([part, placeholder]);
                node.remove();
            }
        }
    });

    test('the strings are translated through the form context', () => {
        const translate = (strings) => `[fr] ${strings.join('')}`;
        expect(pickerNoneLabel(select('horde_model', { multiple: true }), translate)).toBe('[fr] Select Horde models');
    });
});
