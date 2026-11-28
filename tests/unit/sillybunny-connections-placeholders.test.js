/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom uses synchronous DOM assertions. */
import { jest, describe, test, expect, afterEach } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { importOpenAiModule } from '../util/openai-harness.js';

const pub = relative => fileURLToPath(new URL(`../../public/${relative}`, import.meta.url));
const jquerySource = readFileSync(pub('lib/jquery-3.5.1.min.js'), 'utf8');
(0, eval)(jquerySource);

// Wrap real jQuery so `.select2(opts)` captures the exact selector and options registered by each provider module.
const realJQuery = window.jQuery;
const registeredSelect2Calls = [];
function wrappedJQuery(selector, ...rest) {
    const result = realJQuery(selector, ...rest);
    if (typeof selector === 'string') {
        result.__selector = selector;
    }
    return result;
}
Object.assign(wrappedJQuery, realJQuery);
wrappedJQuery.fn = realJQuery.fn;
realJQuery.fn.select2 = function (options) {
    if (options && typeof options === 'object' && this.__selector) {
        registeredSelect2Calls.push({ selector: this.__selector, options });
    }
    return this;
};
realJQuery.fn.sortable = function () { return this; };
window.$ = wrappedJQuery;
window.jQuery = wrappedJQuery;
globalThis.$ = wrappedJQuery;
globalThis.jQuery = wrappedJQuery;

// Mock peer modules of textgen-models.js, horde.js, and sillybunny-connections-form.js before importing them.
await jest.unstable_mockModule(pub('scripts/sillybunny-motion.js'), () => ({
    animateHeightFrom: jest.fn(), animateIn: jest.fn(), animateOut: jest.fn(), play: jest.fn(), stopMotion: jest.fn(), MOTION_SLOW: 250,
    MOTION_FAST: 200, MOTION_POPOVER_CLOSE: 150, MOTION_EASE_OUT_CUBIC: 'ease', SPRING_SHEET: {},
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-action-menu.js'), () => ({ MOBILE_QUERY: '(max-width: 768px)', positionPopover: jest.fn(() => '0px 0') }));
await jest.unstable_mockModule(pub('scripts/sillybunny-sheet.js'), () => ({ blockUpstreamDrawerClose: jest.fn(), createSheetController: jest.fn() }));
await jest.unstable_mockModule(pub('scripts/textgen-settings.js'), () => ({
    textgenerationwebui_settings: {},
    textgen_types: {},
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-editor/adapters/utility-dialogs.js'), () => ({
    tabbyDownloaderOptions: jest.fn(() => ({})),
}));
await jest.unstable_mockModule(pub('scripts/instruct-mode.js'), () => ({
    autoSelectInstructPreset: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/kai-settings.js'), () => ({
    kai_settings: {},
}));

const { openai } = await importOpenAiModule({
    mockTextgenModels: false,
    mockModelDetails: false,
    script: {
        amount_gen: 200,
        max_context: 4096,
        setGenerationParamsFromPreset: jest.fn(),
        setGenerationProgress: jest.fn(),
    },
});
const textgenModels = await import('../../public/scripts/textgen-models.js');
const horde = await import('../../public/scripts/horde.js');
const { pickerNoneLabel } = await import('../../public/scripts/sillybunny-connections-form.js');

// Execute provider initializers to capture every live `.select2({ placeholder })` call from openai.js, textgen-models.js, and horde.js.
openai.initOpenAI();
textgenModels.initTextGenModels();
horde.initHorde();
await new Promise(resolve => setTimeout(resolve, 0));

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

afterEach(async () => {
    globalThis.jQuery = wrappedJQuery;
    document.body.replaceChildren();
    await Promise.resolve();
});

describe('pickerNoneLabel', () => {
    test('empty provider, quantization and Horde selects show their select2 placeholders where select2 does not exist', () => {
        delete globalThis.jQuery;
        expect(pickerNoneLabel(select('nanogpt_allowed_providers', { multiple: true }), t)).toBe('Select providers');
        expect(pickerNoneLabel(select('nanogpt_ignored_providers', { multiple: true }), t)).toBe('Select providers');
        expect(pickerNoneLabel(select('openrouter_providers_chat', { multiple: true, className: 'openrouter_providers' }), t)).toBe('Select providers. No selection = all providers.');
        expect(pickerNoneLabel(select('openrouter_quantizations_text', { multiple: true, className: 'openrouter_quantizations' }), t)).toBe('Select quantizations. No selection = all quantizations.');
        expect(pickerNoneLabel(select('horde_model', { multiple: true }), t)).toBe('Select Horde models');
    });

    test('model selects show Select a model, and the two that select2 labels [Currently loaded] keep that', () => {
        delete globalThis.jQuery;
        for (const id of ['model_openai_select', 'model_aimlapi_select', 'model_nanogpt_select', 'mancer_model', 'ollama_model', 'generic_model_select', 'openrouter_model']) {
            expect(pickerNoneLabel(select(id), t)).toBe('Select a model');
        }
        expect(pickerNoneLabel(select('tabby_model'), t)).toBe('[Currently loaded]');
        expect(pickerNoneLabel(select('llamacpp_model'), t)).toBe('[Currently loaded]');
    });

    test('a select that never had a placeholder stays empty', () => {
        delete globalThis.jQuery;
        expect(pickerNoneLabel(select('model_pollinations_select'), t)).toBe('');
        expect(pickerNoneLabel(select('model_moonshot_select'), t)).toBe('');
    });

    test('precedence: the select\'s own placeholder, select2\'s, an empty option, then the list', () => {
        delete globalThis.jQuery;
        const node = select('nanogpt_allowed_providers', { multiple: true, options: [['', 'Empty option text']] });
        expect(pickerNoneLabel(node, t)).toBe('Empty option text');
        globalThis.jQuery = () => ({ data: () => ({ options: { get: () => ({ text: 'Select2 placeholder' }) } }) });
        expect(pickerNoneLabel(node, t)).toBe('Select2 placeholder');
        node.dataset.placeholder = 'Own placeholder';
        expect(pickerNoneLabel(node, t)).toBe('Own placeholder');
    });

    test('every select2 placeholder registered by the real provider modules matches pickerNoneLabel', () => {
        delete globalThis.jQuery;
        const NOT_ADOPTED_BY_CONNECTIONS = new Set(['#completion_prompt_manager_popup_entry_form_injection_trigger']);
        const found = registeredSelect2Calls
            .filter(({ selector, options }) => typeof options.placeholder === 'string' && !NOT_ADOPTED_BY_CONNECTIONS.has(selector))
            .map(({ selector, options }) => ({ receiver: selector, placeholder: options.placeholder }));

        expect(found.length).toBeGreaterThan(20);
        for (const { receiver, placeholder } of found) {
            for (const part of receiver.split(',').map(selector => selector.trim())) {
                const node = select(
                    part.startsWith('#') ? part.slice(1) : `placeholder_fixture_${part.slice(1)}`,
                    { multiple: true, className: part.startsWith('.') ? part.slice(1) : '' },
                );
                expect([part, pickerNoneLabel(node, t)]).toEqual([part, placeholder]);
                node.remove();
            }
        }
    });

    test('the strings are translated through the form context', () => {
        delete globalThis.jQuery;
        const translate = (strings) => `[fr] ${strings.join('')}`;
        expect(pickerNoneLabel(select('horde_model', { multiple: true }), translate)).toBe('[fr] Select Horde models');
    });
});
