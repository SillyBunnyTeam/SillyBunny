/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom uses synchronous DOM assertions. */
import { describe, test, expect } from '@jest/globals';
import createDOMPurify from 'dompurify';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * The select2 model templates are private functions of browser modules that cannot be imported under Jest, so
 * each one is cut out of its source file and evaluated here with the module-level names it reads supplied by
 * the test (jQuery, the model list, escapeHtml, plainText). The model catalogue is untrusted: every field has
 * to come out as text.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceRoot = process.env.SB_TEMPLATE_SOURCE_ROOT || repoRoot;
const read = relative => readFileSync(path.join(sourceRoot, relative), 'utf8').replace(/\r\n/g, '\n');

function extractFunction(source, name) {
    const start = source.search(new RegExp(`^(?:export )?function ${name}\\(`, 'm'));
    if (start < 0) throw new Error(`function ${name} not found`);
    const end = source.indexOf('\n}\n', start);
    return source.slice(start, end + 3).replace(/^export /, '');
}

// eslint-disable-next-line no-new-func
new Function(readFileSync(path.join(repoRoot, 'public/lib/jquery-3.5.1.min.js'), 'utf8')).call(window);
const $ = window.jQuery;
const DOMPurify = createDOMPurify(window);

const escapeHtml = new Function(`${extractFunction(read('public/scripts/utils.js'), 'escapeHtml')}\nreturn escapeHtml;`)();
const plainTextSource = (() => {
    try {
        return extractFunction(read('public/scripts/sillybunny-model-details.js'), 'plainText');
    } catch {
        return '';
    }
})();
const plainText = plainTextSource ? new Function('DOMParser', `${plainTextSource}\nreturn plainText;`)(window.DOMParser) : undefined;

const lists = {
    mancerModels: [],
    togetherModels: [],
    infermaticAIModels: [],
    dreamGenModels: [],
    vllmModels: [],
    aphroditeModels: [],
    openRouterModels: [],
    model_list: [],
    models: [],
};

function loadTemplate(file, name, helpers = []) {
    const source = read(file);
    const code = [...helpers, name].map(entry => extractFunction(source, entry)).join('\n');
    const scope = { $, DOMPurify, escapeHtml, plainText, document, ...lists };
    return new Function(...Object.keys(scope), `${code}\nreturn ${name};`)(...Object.values(scope));
}

const IMG = '<img src=x onerror=alert(1)>';
const SVG = '"><svg onload=alert(1)>';
const PAYLOADS = [IMG, SVG];

const CASES = [
    {
        name: 'Mancer',
        file: 'public/scripts/textgen-models.js',
        template: 'getMancerModelTemplate',
        list: 'mancerModels',
        model: { id: 'mancer-weaver', name: 'Weaver & Friends', limits: { context: 8000, completion: 2000 }, pricing: { prompt: 0.0001, completion: 0.0002 } },
    },
    {
        name: 'Together',
        file: 'public/scripts/textgen-models.js',
        template: 'getTogetherModelTemplate',
        list: 'togetherModels',
        model: { id: 'meta-llama/Llama-3-8b', context_length: 8192, description: 'A general chat model, 8k "context".' },
    },
    {
        name: 'Infermatic',
        file: 'public/scripts/textgen-models.js',
        template: 'getInfermaticAIModelTemplate',
        list: 'infermaticAIModels',
        model: { id: 'infermatic/Model-70B' },
    },
    {
        name: 'DreamGen',
        file: 'public/scripts/textgen-models.js',
        template: 'getDreamGenModelTemplate',
        list: 'dreamGenModels',
        model: { id: 'lucid-v1-medium' },
    },
    {
        name: 'OpenRouter (text completion)',
        file: 'public/scripts/textgen-models.js',
        template: 'getOpenRouterModelTemplate',
        list: 'openRouterModels',
        title: true,
        model: { id: 'vendor/model-a', name: 'Vendor: Model A', context_length: 128000, pricing: { prompt: 0.000001 } },
    },
    {
        name: 'OpenRouter (text completion, free)',
        file: 'public/scripts/textgen-models.js',
        template: 'getOpenRouterModelTemplate',
        list: 'openRouterModels',
        title: true,
        model: { id: 'vendor/free', name: 'Free One', context_length: 8192, pricing: { prompt: 0 } },
    },
    {
        name: 'vLLM',
        file: 'public/scripts/textgen-models.js',
        template: 'getVllmModelTemplate',
        list: 'vllmModels',
        model: { id: 'org/vllm-model' },
    },
    {
        name: 'Aphrodite',
        file: 'public/scripts/textgen-models.js',
        template: 'getAphroditeModelTemplate',
        list: 'aphroditeModels',
        model: { id: 'org/aphrodite-model' },
    },
    {
        name: 'OpenRouter (chat completion)',
        file: 'public/scripts/openai.js',
        template: 'getOpenRouterModelTemplate',
        list: 'model_list',
        title: true,
        model: { id: 'vendor/model-a', name: 'Vendor: Model A', context_length: 128000, pricing: { prompt: 0.000001 } },
    },
    {
        name: 'Electron Hub',
        file: 'public/scripts/openai.js',
        template: 'getElectronHubModelTemplate',
        list: 'model_list',
        title: true,
        model: { id: 'eh/model', name: 'EH Model', tokens: 32000, pricing: { input: 1, output: 2 }, metadata: { vision: true, reasoning: true, function_call: true }, premium_model: true },
    },
    {
        name: 'Chutes',
        file: 'public/scripts/openai.js',
        template: 'getChutesModelTemplate',
        list: 'model_list',
        title: true,
        model: { id: 'chutes/model', context_length: 65536, pricing: { input: 0.5, output: 1.5 }, input_modalities: ['text', 'image'], supported_features: ['reasoning', 'structured_outputs'] },
    },
    {
        name: 'Chutes (free)',
        file: 'public/scripts/openai.js',
        template: 'getChutesModelTemplate',
        list: 'model_list',
        title: true,
        model: { id: 'chutes/free', max_model_len: 4096, pricing: { input: 0, output: 0 } },
    },
    {
        name: 'AI/ML API',
        file: 'public/scripts/openai.js',
        template: 'getAimlapiModelTemplate',
        list: 'model_list',
        title: true,
        model: { id: 'openai/gpt-x', info: { name: 'GPT X' } },
    },
    {
        name: 'Horde',
        file: 'public/scripts/horde.js',
        template: 'getHordeModelTemplate',
        helpers: ['hordeModelQueueStateString'],
        list: 'models',
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
        file: 'public/scripts/horde.js',
        template: 'getHordeModelTemplate',
        helpers: ['hordeModelQueueStateString'],
        list: 'models',
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

function render(testCase, model) {
    const list = lists[testCase.list];
    list.length = 0;
    list.push(model);
    const template = loadTemplate(testCase.file, testCase.template, testCase.helpers);
    const result = template(optionFor(testCase, model));
    const host = document.createElement('div');
    $(host).append(result);
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
    test.each(CASES.map(testCase => [testCase.name, testCase]))('%s', (name, testCase) => {
        expect(normalise(render(testCase, testCase.model))).toBe(GOLDEN[name]);
    });
});

describe('select2 model templates render hostile catalogue fields as text', () => {
    const combinations = CASES
        .filter(testCase => !testCase.template.includes('Horde'))
        .flatMap(testCase => PAYLOADS.map(payload => [testCase.name, payload, testCase]));

    test.each(combinations)('%s: %s', (name, payload, testCase) => {
        const host = render(testCase, hostileCopy(testCase.model, payload));
        expectInert(host);
        expect(host.textContent).toContain(payload);
        expect(host.firstElementChild.getAttribute('title')).toBe(testCase.title ? payload : null);
    });

    test('a model that is not in the list falls back to the option text', () => {
        lists.mancerModels.length = 0;
        const template = loadTemplate('public/scripts/textgen-models.js', 'getMancerModelTemplate');
        expect(template({ id: 'x', text: IMG, element: { value: 'x' } })).toBe(IMG);
    });
});

describe('Horde model template', () => {
    const horde = CASES.find(entry => entry.name === 'Horde');

    test.each(PAYLOADS)('reduces markup in catalogue fields to text and never lets it run: %s', payload => {
        const host = render(horde, { ...hostileCopy(horde.model, payload), name: horde.model.name, url: horde.model.url, tags: ['popular', payload] });
        expectInert(host);
        expect(host.querySelectorAll('img, svg')).toHaveLength(0);
    });

    test('escaped markup in a field is shown as text, not parsed a second time', () => {
        const encoded = '&lt;img src=x onerror=alert(1)&gt;';
        const host = render(horde, { ...horde.model, display_name: encoded, description: encoded, style: encoded, tags: [encoded] });
        expectInert(host);
        expect(host.querySelector('img')).toBeNull();
        expect(host.querySelector('.horde-model-description').textContent).toBe(IMG);
        expect(host.querySelector('.tag').textContent).toBe(IMG);
        expect(host.querySelector('strong').textContent).toBe(IMG);
    });

    test('an address cannot break out of the link attribute, and only http(s) addresses become links', () => {
        const breakout = 'https://horde-docs.invalid/a"onmouseover="alert(1)';
        const linked = render(horde, { ...horde.model, url: breakout });
        expectInert(linked);
        expect(linked.querySelector('a').getAttribute('href')).toBe(breakout);

        for (const url of ['javascript:alert(1)', 'data:text/html,<b>x</b>', '//horde-docs.invalid/x']) {
            expect(render(horde, { ...horde.model, url }).querySelector('a')).toBeNull();
        }
    });

    test('worker figures typed as numbers are escaped when they arrive as strings', () => {
        const host = render(horde, { ...horde.model, eta: IMG, performance: SVG, queued: IMG, count: SVG });
        expectInert(host);
        expect(host.querySelector('small').textContent).toBe(`ETA: ${IMG}s, Speed: ${SVG}, Queue: ${IMG}, Workers: ${SVG}`);
    });
});
