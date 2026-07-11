import { expect, test } from '@jest/globals';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const gpt56Models = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
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

function readSource(relativePath) {
    return fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

function getSelectOptionIds(source, selectId) {
    const select = source.match(new RegExp(`<select id="${selectId}"[^>]*>([\\s\\S]*?)</select>`));
    return [...select[1].matchAll(/<option[^>]*value="([^"]+)"/g)].map((match) => match[1]);
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
    const modelList = source.match(/async function loadOpenAiModels\(\) \{([\s\S]*?)\n}\n/)[1];
    const imageModels = [...modelList.matchAll(/\{ value: '([^']+)'/g)].map((match) => match[1]);

    expect(imageModels).toEqual(expect.not.arrayContaining(['dall-e-2', 'dall-e-3']));
});

test('GPT-5.6 supports reasoning effort and one-million-token context', () => {
    const constants = readSource('../src/constants.js');
    const openAiScript = readSource('../public/scripts/openai.js');

    for (const model of gpt56Models) {
        expect(constants).toContain(`'${model}'`);
    }
    expect(openAiScript).toContain('value.startsWith(\'gpt-5.4\') || value.startsWith(\'gpt-5.6\')');
});
