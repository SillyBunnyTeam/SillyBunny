/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom uses synchronous DOM assertions. */
import { describe, test, expect, jest } from '@jest/globals';
import createDOMPurify from 'dompurify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { importOpenAiModule } from '../util/openai-harness.js';

const pub = relative => fileURLToPath(new URL(`../../public/${relative}`, import.meta.url));
const jquerySource = readFileSync(pub('lib/jquery-3.5.1.min.js'), 'utf8');
(0, eval)(jquerySource);

// Wrap real jQuery so `.select2({ templateResult })` captures the real private template callbacks from each module.
const realJQuery = window.jQuery;
const registeredTemplates = new Map();
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
    if (options && typeof options.templateResult === 'function' && this.__selector) {
        registeredTemplates.set(this.__selector, options.templateResult);
    }
    return this;
};
realJQuery.fn.sortable = function () { return this; };
window.$ = wrappedJQuery;
window.jQuery = wrappedJQuery;
globalThis.$ = wrappedJQuery;
globalThis.jQuery = wrappedJQuery;

const domPurify = createDOMPurify(window);

// Mock peers of real utils.js, textgen-models.js, and horde.js so real escapeHtml, plainText, and templates run.
await jest.unstable_mockModule(pub('scripts/extensions.js'), () => ({
    getContext: jest.fn(() => ({})),
}));
await jest.unstable_mockModule(pub('scripts/tags.js'), () => ({
    getTagsList: jest.fn(() => []),
}));
await jest.unstable_mockModule(pub('scripts/world-info.js'), () => ({
    importWorldInfo: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/textgen-settings.js'), () => ({
    textgenerationwebui_settings: {},
    textgen_types: {},
}));
await jest.unstable_mockModule(pub('scripts/sillybunny-editor/adapters/utility-dialogs.js'), () => ({
    iconPickerOptions: jest.fn(() => ({})),
    tabbyDownloaderOptions: jest.fn(() => ({})),
}));
await jest.unstable_mockModule(pub('scripts/instruct-mode.js'), () => ({
    autoSelectInstructPreset: jest.fn(),
}));
await jest.unstable_mockModule(pub('scripts/kai-settings.js'), () => ({
    kai_settings: {},
}));

let hordeFetchModels = [];
globalThis.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => hordeFetchModels,
}));

const { openai } = await importOpenAiModule({
    mockTextgenModels: false,
    mockUtils: false,
    mockModelDetails: false,
    domPurify,
    powerUser: { collapseNewlines: jest.fn() },
    script: {
        amount_gen: 200,
        animation_duration: 200,
        max_context: 4096,
        processDroppedFiles: jest.fn(),
        setGenerationParamsFromPreset: jest.fn(),
        setGenerationProgress: jest.fn(),
        user_avatar: '',
    },
});
// Provide collapseNewlines on power-user mock for utils.js.
const textgenModels = await import('../../public/scripts/textgen-models.js');
const horde = await import('../../public/scripts/horde.js');

// Initialize provider modules so every real Select2 templateResult callback is registered.
openai.initOpenAI();
textgenModels.initTextGenModels();
horde.initHorde();
await new Promise(resolve => setTimeout(resolve, 0));

const IMG = '<img src=x onerror=alert(1)>';
const SVG = '"><svg onload=alert(1)>';
const PAYLOADS = [IMG, SVG];

const CASES = [
    {
        name: 'Mancer',
        selector: '#mancer_model',
        populate: async model => textgenModels.loadMancerModels([model]),
        model: { id: 'mancer-weaver', name: 'Weaver & Friends', limits: { context: 8000, completion: 2000 }, pricing: { prompt: 0.0001, completion: 0.0002 } },
    },
    {
        name: 'Together',
        selector: '#model_togetherai_select',
        populate: async model => textgenModels.loadTogetherAIModels([model]),
        model: { id: 'meta-llama/Llama-3-8b', context_length: 8192, description: 'A general chat model, 8k "context".' },
    },
    {
        name: 'Infermatic',
        selector: '#model_infermaticai_select',
        populate: async model => textgenModels.loadInfermaticAIModels([model]),
        model: { id: 'infermatic/Model-70B' },
    },
    {
        name: 'DreamGen',
        selector: '#model_dreamgen_select',
        populate: async model => textgenModels.loadDreamGenModels([model]),
        model: { id: 'lucid-v1-medium' },
    },
    {
        name: 'OpenRouter (text completion)',
        selector: '#openrouter_model',
        populate: async model => textgenModels.loadOpenRouterModels([model]),
        title: true,
        model: { id: 'vendor/model-a', name: 'Vendor: Model A', context_length: 128000, pricing: { prompt: 0.000001 } },
    },
    {
        name: 'OpenRouter (text completion, free)',
        selector: '#openrouter_model',
        populate: async model => textgenModels.loadOpenRouterModels([model]),
        title: true,
        model: { id: 'vendor/free', name: 'Free One', context_length: 8192, pricing: { prompt: 0 } },
    },
    {
        name: 'vLLM',
        selector: '#vllm_model',
        populate: async model => textgenModels.loadVllmModels([model]),
        model: { id: 'org/vllm-model' },
    },
    {
        name: 'Aphrodite',
        selector: '#aphrodite_model',
        populate: async model => textgenModels.loadAphroditeModels([model]),
        model: { id: 'org/aphrodite-model' },
    },
    {
        name: 'OpenRouter (chat completion)',
        selector: '#model_openrouter_select',
        populate: async model => { openai.model_list.splice(0, openai.model_list.length, model); },
        title: true,
        model: { id: 'vendor/model-a', name: 'Vendor: Model A', context_length: 128000, pricing: { prompt: 0.000001 } },
    },
    {
        name: 'Electron Hub',
        selector: '#model_electronhub_select',
        populate: async model => { openai.model_list.splice(0, openai.model_list.length, model); },
        title: true,
        model: { id: 'eh/model', name: 'EH Model', tokens: 32000, pricing: { input: 1, output: 2 }, metadata: { vision: true, reasoning: true, function_call: true }, premium_model: true },
    },
    {
        name: 'Chutes',
        selector: '#model_chutes_select',
        populate: async model => { openai.model_list.splice(0, openai.model_list.length, model); },
        title: true,
        model: { id: 'chutes/model', context_length: 65536, pricing: { input: 0.5, output: 1.5 }, input_modalities: ['text', 'image'], supported_features: ['reasoning', 'structured_outputs'] },
    },
    {
        name: 'Chutes (free)',
        selector: '#model_chutes_select',
        populate: async model => { openai.model_list.splice(0, openai.model_list.length, model); },
        title: true,
        model: { id: 'chutes/free', max_model_len: 4096, pricing: { input: 0, output: 0 } },
    },
    {
        name: 'AI/ML API',
        selector: '#model_aimlapi_select',
        populate: async model => { openai.model_list.splice(0, openai.model_list.length, model); },
        title: true,
        model: { id: 'openai/gpt-x', info: { name: 'GPT X' } },
    },
    {
        name: 'Horde',
        selector: '#horde_model',
        populate: async model => {
            hordeFetchModels = [model];
            await horde.getHordeModels(true);
        },
        key: 'name',
        model: {
            name: 'koboldcpp/With Link',
            display_name: 'koboldcpp/With Link',
            url: 'https://horde-docs.invalid/models/with-link?tab=details&lang=en',
            style: 'story',
            tags: ['popular', 'roleplay'],
            description: 'Has a page & a description.',
            eta: 1, performance: 3, queued: 0, count: 1,
        },
    },
    {
        name: 'Horde (no link, no tags)',
        selector: '#horde_model',
        populate: async model => {
            hordeFetchModels = [model];
            await horde.getHordeModels(true);
        },
        key: 'name',
        model: { name: 'No Link', eta: 1, performance: 2, queued: 4, count: 3 },
    },
];

// Markup produced by the templates before the fields were escaped, for the models above.
const GOLDEN = {
    'Mancer': '<div class="flex-container flexFlowColumn"> <div><strong>Weaver &amp; Friends</strong> | <span>8000 ctx</span> / <span>2000 res</span> | <small>Credits per request (max): 1</small></div> </div>',
    'Together': '<div class="flex-container flexFlowColumn"> <div><strong>meta-llama/Llama-3-8b</strong> | <span>8192 tokens</span></div> <div><small>A general chat model, 8k "context".</small></div> </div>',
    'Infermatic': '<div class="flex-container flexFlowColumn"> <div><strong>infermatic/Model-70B</strong></div> </div>',
    'DreamGen': '<div class="flex-container flexFlowColumn"> <div><strong>lucid-v1-medium</strong></div> </div>',
    'OpenRouter (text completion)': '<div class="flex-container flexFlowColumn" title="vendor/model-a"> <div><strong>Vendor: Model A</strong> | 128000 ctx | <small>1000k t/$ </small></div> </div>',
    'OpenRouter (text completion, free)': '<div class="flex-container flexFlowColumn" title="vendor/free"> <div><strong>Free One</strong> | 8192 ctx | <small>Free</small></div> </div>',
    'vLLM': '<div class="flex-container flexFlowColumn"> <div><strong>org/vllm-model</strong></div> </div>',
    'Aphrodite': '<div class="flex-container flexFlowColumn"> <div><strong>org/aphrodite-model</strong></div> </div>',
    'OpenRouter (chat completion)': '<div class="flex-container flexFlowColumn" title="vendor/model-a"> <div><strong>Vendor: Model A</strong> | 128000 ctx | <small>1000k t/$ </small></div> </div>',
    'Electron Hub': '<div class="flex-container alignItemsBaseline" title="eh/model"> <strong>EH Model</strong> | 32000 ctx | <small>$1/$2 in/out Mtoken</small> | <i class="fa-solid fa-eye fa-sm" role="img" title="This model supports vision" aria-label="This model supports vision"></i><i class="fa-solid fa-brain fa-sm" role="img" title="This model supports reasoning" aria-label="This model supports reasoning"></i><i class="fa-solid fa-wrench fa-sm" role="img" title="This model supports function tools" aria-label="This model supports function tools"></i><i class="fa-solid fa-crown fa-sm" role="img" title="This model requires a subscription" aria-label="This model requires a subscription"></i> </div>',
    'Chutes': '<div class="flex-container alignItemsBaseline" title="chutes/model"> <strong>chutes/model</strong> | 65536 ctx | <small>$0.5/$1.5 in/out Mtoken</small> | <i class="fa-solid fa-eye fa-sm" role="img" title="This model supports vision" aria-label="This model supports vision"></i><i class="fa-solid fa-brain fa-sm" role="img" title="This model supports reasoning" aria-label="This model supports reasoning"></i><i class="fa-solid fa-wrench fa-sm" role="img" title="This model supports function tools" aria-label="This model supports function tools"></i> </div>',
    'Chutes (free)': '<div class="flex-container alignItemsBaseline" title="chutes/free"> <strong>chutes/free</strong> | 4096 ctx | <small>Free</small> </div>',
    'AI/ML API': '<div class="flex-container flexFlowColumn" title="openai/gpt-x"> <div><strong>GPT X</strong> | openai</div> </div>',
    'Horde': '<div class="flex-container flexFlowColumn"> <div> <span class="fa-fw fa-solid fa-star" title="Popular"></span> <strong>With Link</strong> <a href="https://horde-docs.invalid/models/with-link?tab=details&amp;lang=en" target="_blank" rel="noopener noreferrer" class="model-details-link fa-solid fa-circle-question"> </a> | Story | <span class="tags tags_inline inline-flex margin-r2"><span class="tag tag_name">popular</span><span class="tag tag_name">roleplay</span></span> </div> <div class="horde-model-description">Has a page &amp; a description.</div> <div><small>ETA: 1s, Speed: 3, Queue: 0, Workers: 1</small></div> </div>',
    'Horde (no link, no tags)': '<div class="flex-container flexFlowColumn"> <div> <strong>No Link</strong> </div> <div><small>ETA: 1s, Speed: 2, Queue: 4, Workers: 3</small></div> </div>',
};

const optionFor = (testCase, model) => {
    const value = model[testCase.key ?? 'id'];
    return { id: 'option', text: 'text', element: { value } };
};

async function render(testCase, model) {
    await testCase.populate(model);
    const template = registeredTemplates.get(testCase.selector);
    expect(typeof template).toBe('function');
    const result = template(optionFor(testCase, model));
    const host = document.createElement('div');
    realJQuery(host).append(result);
    return host;
}

const normalise = host => host.innerHTML.replace(/\s+/g, ' ').trim();

function hostileCopy(value, payload) {
    if (typeof value === 'string' || typeof value === 'number') return payload;
    if (Array.isArray(value)) return value.map(entry => hostileCopy(entry, payload));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, hostileCopy(entry, payload)]));
    return value;
}

const ALLOWED_TAGS = new Set(['DIV', 'STRONG', 'SPAN', 'SMALL', 'I', 'A']);
const ALLOWED_ATTRIBUTES = new Set(['class', 'title', 'href', 'target', 'rel', 'role', 'aria-label']);

function expectInert(host) {
    for (const element of host.querySelectorAll('*')) {
        expect(ALLOWED_TAGS.has(element.tagName)).toBe(true);
        for (const attribute of element.getAttributeNames()) {
            expect(ALLOWED_ATTRIBUTES.has(attribute)).toBe(true);
        }
    }
}

describe('select2 model templates keep their markup for normal models', () => {
    test.each(CASES.map(testCase => [testCase.name, testCase]))('%s', async (name, testCase) => {
        expect(normalise(await render(testCase, testCase.model))).toBe(GOLDEN[name]);
    });
});

describe('select2 model templates render hostile catalogue fields as text', () => {
    const combinations = CASES
        .filter(testCase => testCase.selector !== '#horde_model')
        .flatMap(testCase => PAYLOADS.map(payload => [testCase.name, payload, testCase]));

    test.each(combinations)('%s: %s', async (name, payload, testCase) => {
        const host = await render(testCase, hostileCopy(testCase.model, payload));
        expectInert(host);
        expect(host.textContent).toContain(payload);
        expect(host.firstElementChild.getAttribute('title')).toBe(testCase.title ? payload : null);
    });

    test('a model that is not in the list falls back to the option text', async () => {
        await textgenModels.loadMancerModels([]);
        const template = registeredTemplates.get('#mancer_model');
        expect(template({ id: 'x', text: IMG, element: { value: 'x' } })).toBe(IMG);
    });
});

describe('Horde model template', () => {
    const hordeCase = CASES.find(entry => entry.name === 'Horde');

    test.each(PAYLOADS)('reduces markup in catalogue fields to text and never lets it run: %s', async payload => {
        const host = await render(hordeCase, { ...hostileCopy(hordeCase.model, payload), name: hordeCase.model.name, url: hordeCase.model.url, tags: ['popular', payload] });
        expectInert(host);
        expect(host.querySelectorAll('img, svg')).toHaveLength(0);
    });

    test('escaped markup in a field is shown as text, not parsed a second time', async () => {
        const encoded = '&lt;img src=x onerror=alert(1)&gt;';
        const host = await render(hordeCase, { ...hordeCase.model, display_name: encoded, description: encoded, style: encoded, tags: [encoded] });
        expectInert(host);
        expect(host.querySelector('img')).toBeNull();
        expect(host.querySelector('.horde-model-description').textContent).toBe(IMG);
        expect(host.querySelector('.tag').textContent).toBe(IMG);
        expect(host.querySelector('strong').textContent).toBe(IMG);
    });

    test('an address cannot break out of the link attribute, and only http(s) addresses become links', async () => {
        const breakout = 'https://horde-docs.invalid/a"onmouseover="alert(1)';
        const linked = await render(hordeCase, { ...hordeCase.model, url: breakout });
        expectInert(linked);
        expect(linked.querySelector('a').getAttribute('href')).toBe(breakout);

        for (const url of ['javascript:alert(1)', 'data:text/html,<b>x</b>', '//horde-docs.invalid/x']) {
            expect((await render(hordeCase, { ...hordeCase.model, url })).querySelector('a')).toBeNull();
        }
    });

    test('falls back to the option text when a model is absent from the Horde catalogue', async () => {
        hordeFetchModels = [];
        await horde.getHordeModels(true);
        const template = registeredTemplates.get('#horde_model');
        expect(template({ id: 'missing', text: IMG, element: { value: 'missing' } })).toBe(IMG);
    });
});
