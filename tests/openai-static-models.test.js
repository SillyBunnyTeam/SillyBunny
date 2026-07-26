import { expect, test } from '@jest/globals';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const gpt56Models = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
const currentGemmaModels = ['gemma-4-31b-it', 'gemma-4-26b-a4b-it'];
const currentClaudeModels = ['claude-opus-5', 'claude-sonnet-5'];
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
    'gpt-4-0314',
];
const retiredCaptionModels = [
    'chatgpt-4o-latest',
    'gpt-4.5-preview',
    'gpt-4.5-preview-2025-02-27',
    'gpt-4-vision-preview',
];

// Claude retired IDs removed from both pickers
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

// IDs removed from Google AI Studio (main google select / data-type="google" caption options).
// Note: some of these (e.g. gemini-3.1-flash-lite-preview, gemini-3-pro-preview) are legitimately
// retained in the Vertex sections, so tests must scope checks to the AI Studio selects only.
const retiredGoogleStudioModels = [
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

// IDs removed from Vertex AI selects (the Gemini 2.0 batch; 3.x previews are Vertex-only retained)
const retiredVertexModels = [
    'gemini-2.0-flash-exp',
    'gemini-2.0-flash-preview-image-generation',
    'gemini-2.0-flash',
    'gemini-2.0-flash-001',
    'gemini-2.0-flash-lite-001',
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

test('OpenAI pickers include GPT-5.6 and omit retired native OpenAI models', () => {
    const mainPicker = getSelectOptionIds(readSource('../public/index.html'), 'model_openai_select');
    const captionPicker = getSelectOptionIds(readSource('../public/scripts/extensions/caption/settings.html'), 'caption_multimodal_model');

    expect(mainPicker).toEqual(expect.arrayContaining(gpt56Models));
    expect(captionPicker).toEqual(expect.arrayContaining(gpt56Models));
    expect(mainPicker).toEqual(expect.not.arrayContaining(retiredMainModels));
    expect(captionPicker).toEqual(expect.not.arrayContaining(retiredCaptionModels));
});

test('OpenAI image picker omits retired DALL-E models', () => {
    const source = readSource('../public/scripts/extensions/stable-diffusion/index.js');
    const modelList = source.match(/async function loadOpenAiModels\(\) \{([\s\S]*?)\r?\n}\r?\n/)[1];
    const imageModels = [...modelList.matchAll(/\{ value: '([^']+)'/g)].map((match) => match[1]);

    expect(imageModels).toEqual(expect.not.arrayContaining(['dall-e-2', 'dall-e-3']));
});

test('GPT-5.6 supports distinct max reasoning effort and one-million-token context', () => {
    const constants = readSource('../src/constants.js');
    const openAiScript = readSource('../public/scripts/openai.js');

    for (const model of gpt56Models) {
        expect(constants).toContain(`'${model}'`);
    }
    expect(openAiScript).toContain('value.startsWith(\'gpt-5.4\') || value.startsWith(\'gpt-5.6\')');
    expect(openAiScript).toMatch(/case reasoning_effort_types\.max:[\s\S]*?\^gpt-5\\\.6[\s\S]*?return reasoning_effort_types\.max/);
});

test('Claude pickers include current Claude 5 models and omit all retired Claude IDs', () => {
    const mainSource = readSource('../public/index.html');
    const captionSource = readSource('../public/scripts/extensions/caption/settings.html');
    const openAiScript = readSource('../public/scripts/openai.js');
    const mainPicker = getSelectOptionIds(mainSource, 'model_claude_select');
    const captionPicker = getDataTypeOptionIds(captionSource, 'anthropic');
    const claudeContextConfig = openAiScript.match(/if \(oai_settings\.chat_completion_source == chat_completion_sources\.CLAUDE\) \{\s+if \(maxContextUnlocked\) \{([\s\S]*?)oai_settings\.openai_max_context/)[1];
    const visionModels = openAiScript.match(/const visionSupportedModels = \[([\s\S]*?)\];/)[1];

    expect(mainPicker).toEqual(expect.arrayContaining(currentClaudeModels));
    expect(captionPicker).toEqual(expect.arrayContaining(currentClaudeModels));
    expect(mainPicker).toEqual(expect.not.arrayContaining(retiredClaudeModels));
    expect(captionPicker).toEqual(expect.not.arrayContaining(retiredClaudeModels));
    expect(openAiScript).toContain('claude_model: \'claude-opus-5\'');
    expect(claudeContextConfig).toContain('opus-5');
    expect(claudeContextConfig).toContain('attr(\'max\', max_1mil)');
    expect(visionModels).toContain('\'claude-opus-5\'');
});

test('Other provider pickers omit confirmed-retired model IDs', () => {
    const mainSource = readSource('../public/index.html');
    const mainHtml = mainSource; // full source for providers not in model_openai_select

    // AI21, Groq, MiniMax, DeepSeek, Perplexity, Cohere, Moonshot are separate selects;
    // check raw source since select IDs vary.
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

test('Google AI Studio pickers omit all retired Gemini/Gemma models', () => {
    const mainSource = readSource('../public/index.html');
    const captionSource = readSource('../public/scripts/extensions/caption/settings.html');

    // Scope to only the AI Studio selects — Vertex legitimately retains some preview IDs.
    const mainAiStudio = getSelectOptionIds(mainSource, 'model_google_select');
    const captionAiStudio = getDataTypeOptionIds(captionSource, 'google');

    expect(mainAiStudio).toEqual(expect.not.arrayContaining(retiredGoogleStudioModels));
    expect(captionAiStudio).toEqual(expect.not.arrayContaining(retiredGoogleStudioModels));
    expect(mainAiStudio).toEqual(expect.arrayContaining(currentGemmaModels));
    expect(captionAiStudio).toEqual(expect.arrayContaining(currentGemmaModels));
});

test('Vertex AI pickers omit retired Gemini 2.0 entries', () => {
    const mainSource = readSource('../public/index.html');
    const captionSource = readSource('../public/scripts/extensions/caption/settings.html');

    const mainVertex = getSelectOptionIds(mainSource, 'model_vertexai_select');
    const captionVertex = getDataTypeOptionIds(captionSource, 'vertexai');

    expect(mainVertex).toEqual(expect.not.arrayContaining(retiredVertexModels));
    expect(captionVertex).toEqual(expect.not.arrayContaining(retiredVertexModels));
});

test('Caption picker omits retired Cohere and Groq vision models', () => {
    const captionSource = readSource('../public/scripts/extensions/caption/settings.html');

    expect(captionSource).toEqual(expect.not.stringContaining('value="c4ai-aya-vision-8b"'));
    expect(captionSource).toEqual(expect.not.stringContaining('value="meta-llama/llama-4-maverick-17b-128e-instruct"'));
});

test('Stable Diffusion image catalog preserves models outside the declared retirements', () => {
    const source = readSource('../public/scripts/extensions/stable-diffusion/index.js');
    const googleEndpoint = readSource('../src/endpoints/google.js');

    const novelSection = source.match(/async function loadNovelModels\(\)([\s\S]*?)\r?\n}\r?\n/)[1];
    expect(novelSection).toContain('nai-diffusion-2');
    expect(novelSection).toContain('nai-diffusion-4-5-full');
    expect(novelSection).toContain('nai-diffusion-4-5-curated');
    expect(novelSection).toContain('nai-diffusion-3');
    expect(novelSection).toContain('nai-diffusion-furry-3');

    const bflSection = source.match(/async function loadBflModels\(\)([\s\S]*?)\r?\n}\r?\n/)[1];
    expect(bflSection).toContain('{ value: \'flux-pro\', text: \'flux-pro\' }');
    expect(bflSection).toContain('flux-pro-1.1');
    expect(bflSection).toContain('flux-pro-1.1-ultra');
    expect(bflSection).toContain('flux-dev');

    const googleSection = source.match(/async function loadGoogleModels\(\)([\s\S]*?)\r?\n}\r?\n/)[1];
    const retainedGoogleModels = [
        'imagen-4.0-generate-preview-06-06',
        'imagen-4.0-fast-generate-preview-06-06',
        'imagen-4.0-ultra-generate-preview-06-06',
        'imagen-3.0-generate-002',
        'imagen-3.0-generate-001',
        'imagen-3.0-fast-generate-001',
        'imagen-3.0-capability-001',
        'imagegeneration@006',
        'imagegeneration@005',
        'imagegeneration@002',
        'veo-3.0-generate-001',
        'veo-3.0-fast-generate-001',
        'veo-2.0-generate-001',
        'veo-2.0-generate-exp',
        'veo-2.0-generate-preview',
    ];

    for (const model of retainedGoogleModels) {
        expect(googleSection).toContain(model);
    }

    expect(googleEndpoint).toContain('const model = request.body.model || \'imagen-3.0-generate-002\';');
});
