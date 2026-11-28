/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { loadTtsModule } from './util/tts-module-harness.js';

let activeHarness = null;

async function drainMacrotasks(rounds = 4) {
    for (let i = 0; i < rounds; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

async function setupQuotedTts(ttsOverrides = {}) {
    const generateTts = jest.fn(async () => 'data:audio/wav;base64,');
    class CaptureTtsProvider {
        constructor() {
            this.settings = {};
            this.settingsHtml = '';
            this.separator = ' ... ';
        }
        async loadSettings(settings) { this.settings = settings || {}; }
        async checkReady() {}
        async fetchTtsVoiceObjects() {
            return [{ name: 'Voice One', voice_id: 'voice-1', lang: 'en-US' }];
        }
        async getVoice(voiceName) {
            return { name: voiceName, voice_id: 'voice-1' };
        }
        async generateTts(text, voiceId, voiceMapKey, signal) {
            return generateTts(text, voiceId, voiceMapKey, signal);
        }
    }

    const harness = await loadTtsModule({
        ttsSettings: {
            enabled: true,
            currentProvider: 'Capture',
            auto_generation: true,
            narrate_quoted_only: true,
            narrate_dialogues_only: false,
            pass_asterisks: false,
            skip_tags: false,
            Capture: {
                voiceMap: {
                    '[Default Voice]': 'Voice One',
                    Mona: 'Voice One',
                },
            },
            ...ttsOverrides,
        },
    });
    harness.ttsModule.registerTtsProvider('Capture', CaptureTtsProvider);
    await harness.ttsModule.init();
    await drainMacrotasks();
    activeHarness = harness;
    return { harness, generateTts };
}

afterEach(() => {
    activeHarness?.cleanup();
    activeHarness = null;
});

describe('TTS quoted-only filtering', () => {
    test('filters asterisks and semantic blocks before extracting quoted dialogue', async () => {
        const { harness, generateTts } = await setupQuotedTts({
            narrate_dialogues_only: true,
            narrate_quoted_only: true,
            skip_tags: true,
            pass_asterisks: false,
        });

        await harness.ttsModule.narrateTtsMessage(
            {
                name: 'Mona',
                mes: '*"Action quote."* <think>"Hidden thought."</think> <font color="#c8a86e">"Spoken line."</font>',
            },
            { manual: true },
        );
        await drainMacrotasks();

        expect(generateTts).toHaveBeenCalledTimes(1);
        expect(generateTts.mock.calls[0][0]).toBe('"Spoken line."');
    });

    test('excludes quoted text inside asterisk actions when both filters are enabled', async () => {
        const { harness, generateTts } = await setupQuotedTts({
            narrate_dialogues_only: true,
            narrate_quoted_only: true,
            pass_asterisks: false,
        });

        await harness.ttsModule.narrateTtsMessage(
            { name: 'Mona', mes: '*"Do not narrate me."*' },
            { manual: true },
        );
        await drainMacrotasks();

        expect(generateTts).not.toHaveBeenCalled();
    });

    test('does not treat quoted font attributes as dialogue', async () => {
        const { harness, generateTts } = await setupQuotedTts({
            narrate_quoted_only: true,
            skip_tags: false,
        });

        await harness.ttsModule.narrateTtsMessage(
            {
                name: 'Mona',
                mes: '<font color="#c8a86e">"More water. That fire\'s dying. Move, girl, move."</font>',
            },
            { manual: true },
        );
        await drainMacrotasks();

        expect(generateTts).toHaveBeenCalledTimes(1);
        expect(generateTts.mock.calls[0][0]).toBe('"More water. That fire\'s dying. Move, girl, move."');
    });

    test('drops quoted semantic blocks while preserving dialogue inside formatting wrappers', async () => {
        const { harness, generateTts } = await setupQuotedTts({
            narrate_quoted_only: true,
            skip_tags: true,
        });

        await harness.ttsModule.narrateTtsMessage(
            {
                name: 'Mona',
                mes: '<think>"Keep this hidden."</think><font color="#c8a86e">"Speak this aloud."</font>',
            },
            { manual: true },
        );
        await drainMacrotasks();

        expect(generateTts).toHaveBeenCalledTimes(1);
        expect(generateTts.mock.calls[0][0]).toBe('"Speak this aloud."');
    });
});
