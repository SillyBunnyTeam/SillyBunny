/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions and static HTML/JSON contracts. */
import { afterAll, beforeEach, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CHAT_COMPLETION_SOURCES, OPENAI_REASONING_EFFORT_MODELS } from '../src/constants.js';
import { importOpenAiModule } from './util/openai-harness.js';

const gpt56Models = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
const gpt6Models = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'];
const currentGemmaModels = ['gemma-4-31b-it', 'gemma-4-26b-a4b-it'];
const currentClaudeModels = ['claude-opus-5', 'claude-sonnet-5'];
const currentGoogleStudioModels = ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite-image', 'gemini-nano-banana-2.1'];
const currentVertexModels = ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite-image', 'gemini-nano-banana-2.1'];
const retiredMainModels = [
    'chatgpt-4o-latest',
    'gpt-4.5-preview',
    'gpt-4.5-preview-2025-02-27',
    'o1-preview',
    'o1-preview-2024-09-12',
    'o1-mini',
    'o1-mini-2024-09-12',
    'gpt-4-turbo-preview',
    'gpt-4-0125-preview',
    'gpt-4-1106-preview',
    'gpt-4-0314',
];
const retiredCaptionModels = [
    'chatgpt-4o-latest',
    'gpt-4.5-preview',
    'gpt-4.5-preview-2025-02-27',
    'gpt-4-vision-preview',
];

const retiredClaudeModels = [
    'claude-opus-4-0',
    'claude-opus-4-20250514',
    'claude-sonnet-4-0',
    'claude-sonnet-4-20250514',
    'claude-3-7-sonnet-latest',
    'claude-3-7-sonnet-20250219',
    'claude-3-5-sonnet-latest',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-sonnet-20240620',
    'claude-3-5-haiku-latest',
    'claude-3-5-haiku-20241022',
    'claude-3-opus-20240229',
    'claude-3-haiku-20240307',
];

const retiredGoogleStudioModels = [
    'gemini-3.7-flash',
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite-preview',
    'gemini-3.1-flash-image-preview',
    'gemini-3-pro-preview',
    'gemini-3-pro-image-preview',
    'gemini-2.5-pro-preview-03-25',
    'gemini-2.5-pro-preview-05-06',
    'gemini-2.5-pro-preview-06-05',
    'gemini-2.5-flash-preview-05-20',
    'gemini-2.5-flash-preview-09-2025',
    'gemini-2.5-flash-lite-preview-06-17',
    'gemini-2.5-flash-lite-preview-09-2025',
    'gemini-2.5-flash-image-preview',
    'gemini-2.0-flash',
    'gemini-2.0-flash-001',
    'gemini-2.0-flash-lite',
    'gemini-2.0-flash-lite-001',
    'gemini-2.0-flash-lite-preview',
    'gemini-2.0-flash-lite-preview-02-05',
    'gemini-2.0-pro-exp',
    'gemini-2.0-pro-exp-02-05',
    'gemini-exp-1206',
    'gemini-2.0-flash-exp',
    'gemini-2.0-flash-thinking-exp',
    'gemini-2.0-flash-thinking-exp-01-21',
    'gemini-2.0-flash-thinking-exp-1219',
    'gemini-2.0-flash-exp-image-generation',
    'gemini-2.0-flash-preview-image-generation',
    'gemini-robotics-er-1.5-preview',
    'learnlm-2.0-flash-experimental',
    'gemma-3-27b-it',
    'gemma-3-12b-it',
    'gemma-3-4b-it',
    'gemma-3-1b-it',
];

const retiredVertexModels = [
    'gemini-2.0-flash-exp',
    'gemini-2.0-flash-preview-image-generation',
    'gemini-2.0-flash',
    'gemini-2.0-flash-001',
    'gemini-2.0-flash-lite-001',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
];

function readSource(relativePath) {
    return fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

function getSelectOptionIds(source, selectId) {
    const select = source.match(new RegExp(`<select id="${selectId}"[^>]*>([\\s\\S]*?)</select>`));
    return [...select[1].matchAll(/<option[^>]*value="([^"]+)"/g)].map((match) => match[1]);
}

function getDataTypeOptionIds(source, dataType) {
    return [...source.matchAll(new RegExp(`<option[^>]*data-type="${dataType}"[^>]*value="([^"]+)"`, 'g'))].map(m => m[1]);
}

const jquerySource = readSource('../public/lib/jquery-3.5.1.min.js');
(0, eval)(jquerySource);
$.fn.select2 = function () { return this; };
$.fn.sortable = function () { return this; };

document.body.innerHTML = `
    <input id="openai_max_context" type="range" max="4095" value="4095" />
    <input id="openai_max_context_counter" type="number" max="4095" value="4095" />
    <div id="oai_max_context_unlocked_block"><input id="oai_max_context_unlocked" type="checkbox" /></div>
    <select id="model_openai_select"></select>
    <select id="model_claude_select"></select>
    <select id="model_google_select"></select>
    <select id="model_vertexai_select"></select>
    <select id="model_moonshot_select"></select>
    <select id="model_zai_select"></select>
    <select id="model_minimax_select"></select>
    <select id="model_openrouter_select"></select>
`;

const { openai } = await importOpenAiModule({ mockToolCalling: false });
const { ToolManager } = await import('../public/scripts/tool-calling.js');
const initialDefaults = structuredClone(openai.oai_settings);
openai.initOpenAI();

async function resolveMaxContextFor(source, selectId, model, { unlocked = false, modelList = [] } = {}) {
    openai.oai_settings.chat_completion_source = source;
    openai.oai_settings.max_context_unlocked = unlocked;
    openai.model_list.splice(0, openai.model_list.length, ...modelList);
    $('#oai_max_context_unlocked').prop('checked', unlocked);
    const select = document.getElementById(selectId);
    select.replaceChildren(new Option(model, model));
    select.value = model;
    $(select).trigger('change');
    await Promise.resolve();
    return Number($('#openai_max_context').attr('max'));
}

beforeEach(() => {
    Object.assign(openai.oai_settings, structuredClone(initialDefaults));
    openai.model_list.length = 0;
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(async () => {
    document.body.innerHTML = '';
    await Promise.resolve();
});

test('OpenAI pickers include GPT-5.6 and GPT-6 and omit retired native OpenAI models', () => {
    const mainPicker = getSelectOptionIds(readSource('../public/index.html'), 'model_openai_select');
    const captionPicker = getSelectOptionIds(readSource('../public/scripts/extensions/caption/settings.html'), 'caption_multimodal_model');

    expect(mainPicker).toEqual(expect.arrayContaining([...gpt56Models, ...gpt6Models]));
    expect(captionPicker).toEqual(expect.arrayContaining([...gpt56Models, ...gpt6Models]));
    expect(mainPicker).toEqual(expect.not.arrayContaining(retiredMainModels));
    expect(captionPicker).toEqual(expect.not.arrayContaining(retiredCaptionModels));
    expect(readSource('../public/index.html')).toContain('<option value="gpt-5.3-chat-latest">gpt-5.3-chat-latest (deprecated)</option>');
});

for (const model of ['gpt-6-astra', 'gpt-6-astra-2026-09-14']) {
    test(`${model} enables images without advertising unsupported tool calls`, () => {
        for (const source of [CHAT_COMPLETION_SOURCES.OPENAI, CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES, CHAT_COMPLETION_SOURCES.AZURE_OPENAI]) {
            Object.assign(openai.oai_settings, {
                chat_completion_source: source,
                openai_model: model,
                azure_openai_model: model,
                media_inlining: true,
                function_calling: true,
                custom_prompt_post_processing: openai.custom_prompt_post_processing_types.NONE,
            });

            expect(openai.isImageInliningSupported()).toBe(true);
            expect(ToolManager.isToolCallingSupported()).toBe(false);

            openai.oai_settings.openai_model = 'gpt-5.6-sol';
            openai.oai_settings.azure_openai_model = 'gpt-5.6-sol';
            expect(ToolManager.isToolCallingSupported()).toBe(source !== CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES);
        }
    });
}

test('GPT-6 models support inline images without duplicate anomalies', () => {
    for (const model of gpt6Models) {
        Object.assign(openai.oai_settings, {
            chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI,
            openai_model: model,
            media_inlining: true,
        });
        expect(openai.isImageInliningSupported()).toBe(true);
    }
});

test('GPT-5.6 and GPT-6 support distinct max reasoning effort and unlocked 2M context', async () => {
    const models = [...gpt56Models, ...gpt6Models];
    for (const model of models) {
        expect(OPENAI_REASONING_EFFORT_MODELS).toContain(model);
        // Direct OpenAI models stay unlocked to 2M in SillyBunny.
        expect(await resolveMaxContextFor(CHAT_COMPLETION_SOURCES.OPENAI, 'model_openai_select', model)).toBe(2000000);
        for (const source of [CHAT_COMPLETION_SOURCES.OPENAI, CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES, CHAT_COMPLETION_SOURCES.CUSTOM]) {
            const { generate_data } = await openai.createGenerationParameters(
                { ...openai.oai_settings, chat_completion_source: source, reasoning_effort: 'max' },
                model,
                'normal',
                [],
            );
            expect(generate_data.reasoning_effort).toBe('max');
        }
    }
});

test('keeps direct OpenAI models unlocked while OpenRouter respects model limits until unlocked', async () => {
    for (const model of ['gpt-6-astra-2026-09-14', 'gpt-6-sol', 'gpt-5.4', 'gpt-4o']) {
        expect(await resolveMaxContextFor(CHAT_COMPLETION_SOURCES.OPENAI, 'model_openai_select', model, { unlocked: false })).toBe(2000000);
    }
    const openRouterModels = [{ id: 'openai/gpt-6-sol', context_length: 1050000 }];
    expect(await resolveMaxContextFor(CHAT_COMPLETION_SOURCES.OPENROUTER, 'model_openrouter_select', 'openai/gpt-6-sol', { unlocked: false, modelList: openRouterModels })).toBe(1050000);
    expect(await resolveMaxContextFor(CHAT_COMPLETION_SOURCES.OPENROUTER, 'model_openrouter_select', 'openai/gpt-6-sol', { unlocked: true, modelList: openRouterModels })).toBe(2000000);
});

test('Claude pickers include current Claude 5 models and omit all retired Claude IDs', async () => {
    const mainSource = readSource('../public/index.html');
    const captionSource = readSource('../public/scripts/extensions/caption/settings.html');
    const mainPicker = getSelectOptionIds(mainSource, 'model_claude_select');
    const captionPicker = getDataTypeOptionIds(captionSource, 'anthropic');

    expect(mainPicker).toEqual(expect.arrayContaining(currentClaudeModels));
    expect(mainPicker).toContain('claude-fable-5-1');
    expect(mainPicker).toContain('claude-opus-5-5');
    expect(captionPicker).toEqual(expect.arrayContaining(currentClaudeModels));
    expect(captionPicker).toContain('claude-fable-5-1');
    expect(captionPicker).toContain('claude-opus-5-5');
    expect(mainPicker).toEqual(expect.not.arrayContaining(retiredClaudeModels));
    expect(captionPicker).toEqual(expect.not.arrayContaining(retiredClaudeModels));

    expect(initialDefaults.claude_model).toBe('claude-opus-5');
    expect(await resolveMaxContextFor(CHAT_COMPLETION_SOURCES.CLAUDE, 'model_claude_select', 'claude-opus-5')).toBe(2000000);
    Object.assign(openai.oai_settings, { chat_completion_source: CHAT_COMPLETION_SOURCES.CLAUDE, claude_model: 'claude-opus-5', media_inlining: true });
    expect(openai.isImageInliningSupported()).toBe(true);
});

test('Other provider pickers omit confirmed-retired model IDs', () => {
    const mainHtml = readSource('../public/index.html');

    expect(mainHtml).toEqual(expect.not.stringContaining('value="jamba-1.7-mini"'));
    expect(mainHtml).toEqual(expect.not.stringContaining('value="jamba-1.7-large"'));
    expect(mainHtml).toEqual(expect.not.stringContaining('value="deepseek-r1-distill-llama-70b"'));
    expect(mainHtml).toEqual(expect.not.stringContaining('value="gemma2-9b-it"'));
    expect(mainHtml).toEqual(expect.not.stringContaining('value="meta-llama/llama-4-maverick-17b-128e-instruct"'));
    expect(mainHtml).toEqual(expect.not.stringContaining('value="llama-guard-3-8b"'));
    expect(mainHtml).toEqual(expect.not.stringContaining('value="llama3-70b-8192"'));
    expect(mainHtml).toEqual(expect.not.stringContaining('value="llama3-8b-8192"'));
    expect(mainHtml).toEqual(expect.not.stringContaining('value="mistral-saba-24b"'));
    expect(mainHtml).toEqual(expect.not.stringContaining('value="MiniMax-M1"'));
    expect(mainHtml).toEqual(expect.not.stringContaining('value="deepseek-v4"'));
    expect(mainHtml).toEqual(expect.not.stringContaining('value="deepseek-coder"'));
    expect(mainHtml).toEqual(expect.not.stringContaining('value="sonar-reasoning"'));
    expect(mainHtml).toEqual(expect.not.stringContaining('value="r1-1776"'));
    expect(mainHtml).toEqual(expect.not.stringContaining('value="c4ai-aya-23-8b"'));
    expect(mainHtml).toEqual(expect.not.stringContaining('value="c4ai-aya-23"'));
    expect(mainHtml).toEqual(expect.not.stringContaining('value="c4ai-aya-expanse-8b"'));
    expect(mainHtml).toEqual(expect.not.stringContaining('value="c4ai-aya-vision-8b"'));
    expect(mainHtml).toEqual(expect.not.stringContaining('value="command-light"'));
    expect(mainHtml).toEqual(expect.not.stringContaining('value="command-r"'));
    expect(mainHtml).toEqual(expect.not.stringContaining('value="command-r-plus"'));
    expect(mainHtml).toEqual(expect.not.stringContaining('value="kimi-k2-0711-preview"'));
    expect(mainHtml).toEqual(expect.not.stringContaining('value="moonshot-v1-auto"'));
    expect(mainHtml).toEqual(expect.not.stringContaining('value="kimi-latest"'));
    expect(mainHtml).toEqual(expect.not.stringContaining('value="kimi-thinking-preview"'));
});

test('Moonshot picker includes Kimi K3 and supports selecting it', async () => {
    const mainSource = readSource('../public/index.html');
    const moonshotPicker = getSelectOptionIds(mainSource, 'model_moonshot_select');

    expect(moonshotPicker).toContain('kimi-k3');
    expect(await resolveMaxContextFor(CHAT_COMPLETION_SOURCES.MOONSHOT, 'model_moonshot_select', 'kimi-k3', { modelList: [{ id: 'kimi-k3' }] })).toBe(2000000);
    expect(openai.oai_settings.moonshot_model).toBe('kimi-k3');
});

test('Google AI Studio pickers include current models and omit all retired Gemini/Gemma models', () => {
    const mainSource = readSource('../public/index.html');
    const captionSource = readSource('../public/scripts/extensions/caption/settings.html');

    const mainAiStudio = getSelectOptionIds(mainSource, 'model_google_select');
    const captionAiStudio = getDataTypeOptionIds(captionSource, 'google');

    expect(mainAiStudio).toEqual(expect.not.arrayContaining(retiredGoogleStudioModels));
    expect(captionAiStudio).toEqual(expect.not.arrayContaining(retiredGoogleStudioModels));
    expect(mainAiStudio).toEqual(expect.arrayContaining(currentGoogleStudioModels));
    expect(captionAiStudio).toEqual(expect.arrayContaining(currentGoogleStudioModels));
    expect(mainAiStudio).toEqual(expect.arrayContaining(currentGemmaModels));
    expect(captionAiStudio).toEqual(expect.arrayContaining(currentGemmaModels));
});

test('Vertex AI pickers include current models and omit retired Gemini 2.0 and 2.5 entries', () => {
    const mainSource = readSource('../public/index.html');
    const captionSource = readSource('../public/scripts/extensions/caption/settings.html');

    const mainVertex = getSelectOptionIds(mainSource, 'model_vertexai_select');
    const captionVertex = getDataTypeOptionIds(captionSource, 'vertexai');

    expect(mainVertex).toEqual(expect.not.arrayContaining(retiredVertexModels));
    expect(captionVertex).toEqual(expect.not.arrayContaining(retiredVertexModels));
    expect(mainVertex).toEqual(expect.arrayContaining(currentVertexModels));
    expect(captionVertex).toEqual(expect.arrayContaining(currentVertexModels));
});

test('saved AI Studio models follow the IDs that AI Studio routes to newer models', () => {
    openai.loadOpenAISettings({ openai_settings: [], openai_setting_names: [] }, {
        google_model: 'gemini-3.7-flash',
        vertexai_model: 'gemini-3.7-flash',
    });
    expect(openai.oai_settings.google_model).toBe('gemini-3.8-flash');
    expect(openai.oai_settings.vertexai_model).toBe('gemini-3.7-flash');

    openai.loadOpenAISettings({ openai_settings: [], openai_setting_names: [] }, {
        google_model: 'gemini-3.5-flash',
        vertexai_model: 'gemini-3.5-flash',
    });
    expect(openai.oai_settings.google_model).toBe('gemini-3.6-flash');
    expect(openai.oai_settings.vertexai_model).toBe('gemini-3.5-flash');
});

for (const model of ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.1-flash-lite-image', 'gemini-nano-banana-2.1']) {
    test(`selects Google model ${model} with unlocked context`, async () => {
        expect(await resolveMaxContextFor(CHAT_COMPLETION_SOURCES.MAKERSUITE, 'model_google_select', model)).toBe(2000000);
        expect(openai.oai_settings.google_model).toBe(model);
    });
}

test('Gemini 4 and Nano Banana accept inline media', () => {
    for (const model of ['gemini-4-argon', 'gemini-nano-banana-2.1']) {
        Object.assign(openai.oai_settings, {
            chat_completion_source: CHAT_COMPLETION_SOURCES.MAKERSUITE,
            google_model: model,
            media_inlining: true,
        });
        expect(openai.isImageInliningSupported()).toBe(true);
        expect(openai.isVideoInliningSupported()).toBe(true);
    }
    Object.assign(openai.oai_settings, {
        chat_completion_source: CHAT_COMPLETION_SOURCES.MAKERSUITE,
        google_model: 'gemini-4-argon',
        media_inlining: true,
    });
    expect(openai.isAudioInliningSupported()).toBe(true);
});

test('new provider models are the defaults where requested', () => {
    const defaultPreset = JSON.parse(readSource('../default/content/presets/openai/Default.json'));

    expect(initialDefaults.openai_model).toBe('gpt-6-sol');
    expect(initialDefaults.google_model).toBe('gemini-3.8-flash');
    expect(initialDefaults.vertexai_model).toBe('gemini-3.8-flash');
    expect(initialDefaults.minimax_model).toBe('MiniMax-M3');
    expect(initialDefaults.zai_model).toBe('glm-5.3');
    expect(defaultPreset).toMatchObject({
        google_model: 'gemini-3.8-flash',
        vertexai_model: 'gemini-3.8-flash',
        minimax_model: 'MiniMax-M3',
    });
});

test('Z.AI includes GLM-5.3-Flash with multimodal support', async () => {
    const mainSource = readSource('../public/index.html');
    const captionSource = readSource('../public/scripts/extensions/caption/settings.html');

    expect(getSelectOptionIds(mainSource, 'model_zai_select')).toContain('glm-5.3-flash');
    expect(getDataTypeOptionIds(captionSource, 'zai')).toContain('glm-5.3-flash');
    expect(await resolveMaxContextFor(CHAT_COMPLETION_SOURCES.ZAI, 'model_zai_select', 'glm-5.3-flash')).toBe(2000000);
    Object.assign(openai.oai_settings, {
        chat_completion_source: CHAT_COMPLETION_SOURCES.ZAI,
        zai_model: 'glm-5.3-flash',
        media_inlining: true,
    });
    expect(openai.isImageInliningSupported()).toBe(true);
    expect(openai.isVideoInliningSupported()).toBe(true);
});

test('MiniMax includes M3 with multimodal support', async () => {
    const mainSource = readSource('../public/index.html');

    expect(getSelectOptionIds(mainSource, 'model_minimax_select')).toContain('MiniMax-M3');
    expect(await resolveMaxContextFor(CHAT_COMPLETION_SOURCES.MINIMAX, 'model_minimax_select', 'MiniMax-M3')).toBe(1000000);
    Object.assign(openai.oai_settings, {
        chat_completion_source: CHAT_COMPLETION_SOURCES.MINIMAX,
        minimax_model: 'MiniMax-M3',
        media_inlining: true,
    });
    expect(openai.isImageInliningSupported()).toBe(true);
    openai.oai_settings.minimax_model = 'MiniMax-Text-01';
    expect(openai.isImageInliningSupported()).toBe(false);
});

test('Caption picker omits retired Cohere and Groq vision models', () => {
    const captionSource = readSource('../public/scripts/extensions/caption/settings.html');

    expect(captionSource).toEqual(expect.not.stringContaining('value="c4ai-aya-vision-8b"'));
    expect(captionSource).toEqual(expect.not.stringContaining('value="meta-llama/llama-4-maverick-17b-128e-instruct"'));
});
