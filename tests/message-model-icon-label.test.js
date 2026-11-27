/** @jest-environment jsdom */
/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { importScriptModule } from './util/script-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(path.join(repoRoot, 'public/index.html'), 'utf8').replace(/\r\n/g, '\n');

const TOGGLES = [
    ['messageModelNameEnabled', 'timestamp_model_name'],
    ['messageReasoningEffortEnabled', 'timestamp_reasoning_effort'],
];

const MODEL_LABEL_DOM = `
    <div id="options_button"></div>
    <div id="options"></div>
    <div id="export_button"></div>
    <div id="export_format_popup"></div>
    <div id="online_status_indicator"></div>
    <div id="online_status_text"></div>
    <select id="main_api"><option value="openai" selected>openai</option></select>
    <div id="chat"></div>
    <div id="message_template" hidden>
        <div class="mes">
            <div class="mes_block">
                <div class="ch_name">
                    <span class="name_text"></span>
                    <span class="timestamp">12:00</span>
                </div>
                <div class="mes_text"></div>
                <div class="swipe_left"></div>
                <div class="swipe_right"></div>
                <div class="swipes-counter"></div>
            </div>
        </div>
    </div>
    <textarea id="send_textarea"></textarea>
    <div id="send_but"></div>
    <div id="mes_stop"></div>
`;

let loaded = null;
const OriginalImage = globalThis.Image;
const originalSVGInject = globalThis.SVGInject;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
    globalThis.Image = OriginalImage;
    globalThis.SVGInject = originalSVGInject;
});

async function setupModelLabelRuntime({ extraMocks = {}, runReady = false } = {}) {
    loaded = await importScriptModule({
        dom: MODEL_LABEL_DOM,
        fetch: jest.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
        })),
        mocks: {
            'scripts/openai.js': (base) => ({
                ...base,
                chat_completion_sources: {
                    ...base.chat_completion_sources,
                    LINKAPI: 'linkapi',
                    OPENROUTER: 'openrouter',
                },
                ...(extraMocks['scripts/openai.js'] ?? {}),
            }),
        },
    });
    if (runReady) {
        await loaded.runReady();
        loaded.$('#main_api').val('openai').trigger('change');
    }
    loaded.script.characters.push({ name: 'Bunny', avatar: 'bunny.png', chat: 'bunny-chat', data: { extensions: {} } });
    loaded.script.setCharacterId(0);
    loaded.script.setCharacterName('Bunny');
    loaded.script.setOnlineStatus('connected');
    return loaded;
}

describe('message model icon label', () => {
    test('both toggles sit with the model icon toggle in Visual Toggles', () => {
        const themeToggles = indexHtml.indexOf('<div name="themeToggles"');
        expect(themeToggles).toBeGreaterThan(-1);

        for (const [id] of TOGGLES) {
            expect(indexHtml).toContain(`<input id="${id}" type="checkbox" />`);
            expect(indexHtml.indexOf(id)).toBeGreaterThan(themeToggles);
        }

        expect(indexHtml).toMatch(/messageModelIconEnabled[\s\S]{0,500}?messageModelNameEnabled[\s\S]{0,500}?messageReasoningEffortEnabled/);
    });

    test('renders the model/effort label whether or not model icons are enabled and clears labels on repaint', async () => {
        const createdImages = [];
        globalThis.SVGInject = jest.fn(async () => {});
        globalThis.Image = class TrackingImage extends OriginalImage {
            constructor(...args) {
                super(...args);
                createdImages.push(this);
            }
        };

        const runtime = await setupModelLabelRuntime();
        runtime.state.power_user.timestamp_model_icon = false;
        runtime.state.power_user.timestamp_model_name = true;
        runtime.state.power_user.timestamp_reasoning_effort = true;

        const message = {
            name: 'Bunny',
            is_user: false,
            is_system: false,
            mes: 'Hello',
            extra: { api: 'openai', model: 'o3-mini', reasoning_effort: 'high' },
        };
        runtime.script.chat.push(message);
        runtime.script.addOneMessage(message);

        const mesEl = document.querySelector('#chat .mes[mesid="0"]');
        expect(mesEl.querySelector('.timestamp-icon')).toBeNull();
        const label = mesEl.querySelector('.timestamp-model');
        expect(label).not.toBeNull();
        expect(label.textContent).toBe('o3-mini (high)');
        expect(label.previousElementSibling.classList.contains('timestamp')).toBe(true);

        // Turning icons on inserts the icon when loaded and repaint places the label after the icon without duplicating it.
        runtime.state.power_user.timestamp_model_icon = true;
        runtime.script.refreshMessageModelIcons();
        for (const img of createdImages) {
            if (typeof img.onload === 'function') {
                await img.onload();
            }
        }
        expect(mesEl.querySelectorAll('.timestamp-icon')).toHaveLength(1);
        expect(mesEl.querySelectorAll('.timestamp-model')).toHaveLength(1);
        expect(mesEl.querySelector('.timestamp-icon').previousElementSibling.classList.contains('timestamp')).toBe(true);

        // Turning both label toggles off clears the label cleanly during repaint.
        runtime.state.power_user.timestamp_model_name = false;
        runtime.state.power_user.timestamp_reasoning_effort = false;
        runtime.script.refreshMessageModelIcons();
        expect(mesEl.querySelector('.timestamp-model')).toBeNull();
    });

    test('generated replies stamp both model and reasoning_effort on non-streaming, streaming, and swipe paths', async () => {
        let runtimeRef = null;
        const runtime = await setupModelLabelRuntime({
            runReady: true,
            extraMocks: {
                'scripts/openai.js': {
                    getChatCompletionModel: () => 'o3-mini',
                    getCurrentReasoningEffort: () => 'high',
                    sendOpenAIRequest: jest.fn(async () => {
                        if (runtimeRef.state.oai_settings.stream_openai) {
                            return async function* () {
                                yield { text: 'Streamed reply', swipes: [], toolCalls: [], state: {} };
                            };
                        }
                        return { choices: [{ message: { content: 'Whole reply' } }] };
                    }),
                },
            },
        });
        runtimeRef = runtime;

        // 1. Non-streaming reply
        runtime.state.oai_settings.stream_openai = false;
        await runtime.script.Generate('normal');
        expect(runtime.script.chat.at(-1).extra.model).toBe('o3-mini');
        expect(runtime.script.chat.at(-1).extra.reasoning_effort).toBe('high');

        // 2. Streaming reply
        runtime.state.oai_settings.stream_openai = true;
        await runtime.script.Generate('normal');
        expect(runtime.script.chat.at(-1).extra.model).toBe('o3-mini');
        expect(runtime.script.chat.at(-1).extra.reasoning_effort).toBe('high');

        // 3. Swipe regeneration reply
        runtime.state.oai_settings.stream_openai = false;
        const beforeSwipe = runtime.script.chat.at(-1);
        beforeSwipe.swipes = [beforeSwipe.mes];
        beforeSwipe.swipe_id = 0;
        beforeSwipe.swipe_info = [{ extra: { ...beforeSwipe.extra } }];
        await runtime.script.Generate('swipe');
        expect(beforeSwipe.extra.model).toBe('o3-mini');
        expect(beforeSwipe.extra.reasoning_effort).toBe('high');
    });
});

describe('LinkAPI model icons', () => {
    test('uses the relevant SVG for each model and leaves other API icons unchanged', async () => {
        const runtime = await setupModelLabelRuntime();

        for (const [model, icon] of [
            ['gemini-2.5-pro', 'makersuite'],
            ['gemma-3-27b-it', 'makersuite'],
            ['google/gemini-2.5-pro', 'makersuite'],
            ['claude-sonnet-4-5', 'claude'],
            ['[SP]claude-sonnet-4-5', 'claude'],
            ['gpt-5', 'openai'],
            ['unknown-model', 'generic'],
        ]) {
            const image = runtime.script.createModelIcon('linkapi', model);
            expect(image.getAttribute('src')).toBe(`/img/${icon}.svg`);
            expect(image.title).toBe(`linkapi - ${model}`);
        }

        expect(runtime.script.createModelIcon('openrouter', 'google/gemini-2.5-pro').getAttribute('src')).toBe('/img/openrouter.svg');
    });
});
