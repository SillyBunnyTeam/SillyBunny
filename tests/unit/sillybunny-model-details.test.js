/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom uses synchronous DOM assertions. */
import { describe, test, expect } from '@jest/globals';
import { detailsToText, renderDetails, toDetails } from '../../public/scripts/sillybunny-editor/option-details.js';
import {
    describeAimlapiModel,
    describeChutesModel,
    describeElectronHubModel,
    describeHordeModel,
    describeMancerModel,
    describeOpenRouterModel,
    describeTogetherModel,
    plainText,
} from '../../public/scripts/sillybunny-model-details.js';

const HOSTILE = '<img src=x onerror="window.__injected = true">';
const text = result => detailsToText(toDetails(result) ?? []);
const html = result => {
    const host = document.createElement('span');
    host.append(renderDetails(toDetails(result) ?? []));
    return host;
};

describe('model details use the words of the select2 templates', () => {
    test('OpenRouter: context size and price, or Free', () => {
        expect(text(describeOpenRouterModel({ id: 'm', name: 'M', context_length: 128000, pricing: { prompt: 0.000001 } }))).toBe('128000 ctx · 1000k t/$');
        expect(text(describeOpenRouterModel({ id: 'm', context_length: 8192, pricing: { prompt: 0 } }))).toBe('8192 ctx · Free');
        expect(text(describeOpenRouterModel({ id: 'm', pricing: { prompt: 0 } }))).toBe('Free');
    });

    test('Electron Hub: context, price and capability icons in the template order', () => {
        const model = { id: 'e', tokens: 32000, pricing: { input: 1, output: 2 }, metadata: { vision: true, reasoning: true, function_call: true }, premium_model: true };
        const result = describeElectronHubModel(model);
        expect(text(result)).toBe('32000 ctx · $1/$2 in/out Mtoken · This model supports vision This model supports reasoning This model supports function tools This model requires a subscription');
        expect(html(result).querySelectorAll('i[aria-label]')).toHaveLength(4);
        expect(text(describeElectronHubModel({ id: 'e', tokens: 4, pricing: {} }))).toBe('4 ctx · Unknown');
    });

    test('Chutes: Free, unknown context and capability icons from the catalogue fields', () => {
        expect(text(describeChutesModel({ id: 'c', pricing: { input: 0, output: 0 }, input_modalities: ['text', 'image'], supported_features: ['reasoning', 'structured_outputs'] })))
            .toBe('Unknown ctx · Free · This model supports vision This model supports reasoning This model supports function tools');
        expect(text(describeChutesModel({ id: 'c', max_model_len: 4096, pricing: { input: 0.5, output: 1 } }))).toBe('4096 ctx · $0.5/$1 in/out Mtoken');
    });

    test('AI/ML API, Mancer and Together', () => {
        expect(text(describeAimlapiModel({ id: 'openai/gpt-4o' }))).toBe('openai');
        expect(text(describeMancerModel({ id: 'm', limits: { context: 8192, completion: 1024 }, pricing: { prompt: 0.5, completion: 1 } })))
            .toBe('8192 ctx / 1024 res · Credits per request (max): 4608');
        expect(text(describeTogetherModel({ id: 't', context_length: 4096, description: 'A model.' }, 't'))).toBe('4096 tokens · A model.');
        expect(text(describeTogetherModel({ id: 't' }))).toBe('t · ??? tokens');
    });

    test('Together: the id is added when the option text is the display name, and not when it is the id', () => {
        const model = { id: 'meta/llama-3', context_length: 8192 };
        expect(text(describeTogetherModel(model, 'Llama 3'))).toBe('meta/llama-3 · 8192 tokens');
        expect(text(describeTogetherModel(model, ' meta/llama-3 '))).toBe('8192 tokens');
    });

    test('Horde: the display name without its path is added when it differs from the name', () => {
        expect(text(describeHordeModel({ name: 'koboldcpp/Fimbulvetr-11B', display_name: 'Org/Fimbulvetr', style: 'story' }))).toBe('Fimbulvetr · Story');
        expect(text(describeHordeModel({ name: 'Fimbulvetr', display_name: 'Fimbulvetr' }))).toBe('');
        expect(text(describeHordeModel({ name: 'org/Model' }))).toBe('Model');
        expect(text(describeHordeModel({ name: 'Plain', display_name: `<b>Bold</b> ${HOSTILE}` }))).toBe('Bold');
    });

    test('Horde: popular star, capitalised style, tags and description; the queue state stays in the label', () => {
        const result = describeHordeModel({ name: 'h', display_name: 'H', style: 'roleplay', tags: ['popular', '13B'], description: 'Tuned for chat.', eta: 1, performance: 2, queued: 3, count: 4 });
        expect(text(result)).toBe('H · Popular Roleplay · popular, 13B · Tuned for chat.');
        expect(html(result).querySelector('i[title="Popular"]').getAttribute('class')).toBe('fa-fw fa-solid fa-star');
        expect(text(describeHordeModel({ name: 'h' }))).toBe('');
    });

    test('Horde: a link to the model page follows the name, only with a valid URL and a label', () => {
        const model = { name: 'org/Model', display_name: 'Model', url: 'https://huggingface.co/org/Model?x=1', style: 'story' };
        const anchor = html(describeHordeModel(model, 'Details')).querySelector('a');
        expect(anchor.getAttribute('href')).toBe('https://huggingface.co/org/Model?x=1');
        expect(anchor.getAttribute('aria-label')).toBe('Details');
        expect(anchor.getAttribute('title')).toBe('Details');
        expect(anchor.getAttribute('class')).toBe('fa-solid fa-circle-question');
        expect(anchor.getAttribute('target')).toBe('_blank');
        expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
        expect(text(describeHordeModel(model, 'Details'))).toBe('Model · Story');
        expect(html(describeHordeModel({ name: 'M', url: 'https://example.com/' }, 'Details')).querySelectorAll('a')).toHaveLength(1);
        for (const url of [undefined, '', '  ', 'javascript:alert(1)', '/relative', 'http://u:p@example.com/', 'data:text/html,x']) {
            expect(html(describeHordeModel({ ...model, url }, 'Details')).querySelectorAll('a')).toHaveLength(0);
        }
        expect(html(describeHordeModel(model)).querySelectorAll('a')).toHaveLength(0);
    });

    test('no model, no details', () => {
        for (const describe of [describeOpenRouterModel, describeElectronHubModel, describeChutesModel, describeAimlapiModel, describeMancerModel, describeTogetherModel, describeHordeModel]) {
            expect(describe(undefined)).toBeNull();
        }
    });
});

describe('model details keep hostile catalogue fields as text', () => {
    test('every field of every provider renders without markup, handlers or loaded images', () => {
        const models = [
            describeOpenRouterModel({ id: HOSTILE, name: HOSTILE, context_length: HOSTILE, pricing: { prompt: HOSTILE } }),
            describeElectronHubModel({ id: HOSTILE, tokens: HOSTILE, pricing: { input: HOSTILE, output: HOSTILE }, metadata: { vision: true } }),
            describeChutesModel({ id: HOSTILE, context_length: HOSTILE, pricing: { input: HOSTILE, output: HOSTILE } }),
            describeAimlapiModel({ id: `${HOSTILE}/x` }),
            describeMancerModel({ id: HOSTILE, limits: { context: HOSTILE, completion: HOSTILE }, pricing: {} }),
            describeTogetherModel({ id: HOSTILE, context_length: HOSTILE, description: HOSTILE }),
            describeHordeModel({ name: HOSTILE, style: HOSTILE, tags: [HOSTILE], description: HOSTILE }),
        ];
        for (const result of models) {
            const host = html(result);
            expect(host.querySelectorAll('img, script')).toHaveLength(0);
            expect(host.querySelector('[onerror]')).toBeNull();
        }
        expect(window.__injected).toBeUndefined();
        expect(html(describeOpenRouterModel({ id: 'x', context_length: HOSTILE, pricing: { prompt: 0 } })).textContent).toContain(HOSTILE);
    });

    test('plainText removes markup from catalogue text without running or loading anything', () => {
        expect(plainText(`<b>bold</b> ${HOSTILE} &lt;kept&gt;`)).toBe('bold  <kept>');
        expect(plainText(undefined)).toBe('');
        expect(window.__injected).toBeUndefined();
    });
});
