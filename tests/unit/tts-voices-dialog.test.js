/** @jest-environment jsdom */
/* global globalThis */

import { afterEach, expect, jest, test } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import { loadTtsModule } from '../util/tts-module-harness.js';

const pub = rel => fileURLToPath(new URL(`../../public/${rel}`, import.meta.url));

let activeHarness = null;

afterEach(() => {
    activeHarness?.cleanup();
    activeHarness = null;
    jest.restoreAllMocks();
});

test('voice Dialog keeps its title and stops preview audio on close', async () => {
    class PreviewVoiceProvider {
        constructor() {
            this.settings = {};
            this.settingsHtml = '';
        }
        async loadSettings(settings) { this.settings = settings || {}; }
        async checkReady() {}
        async fetchTtsVoiceObjects() {
            return [{
                name: 'Lyra',
                voice_id: 'voice-lyra',
                lang: 'en-US',
                preview_url: 'https://example.test/voice.mp3',
            }];
        }
        async getVoice(name) { return { name, voice_id: 'voice-lyra' }; }
    }

    const openAlert = jest.fn();
    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/dialog.js'), () => ({ openAlert }));
    activeHarness = await loadTtsModule({
        skipProviders: ['speecht5.js'],
        ttsSettings: {
            enabled: true,
            currentProvider: 'PreviewVoice',
            PreviewVoice: { voiceMap: {} },
        },
    });
    activeHarness.ttsModule.registerTtsProvider('PreviewVoice', PreviewVoiceProvider);
    await activeHarness.ttsModule.init();
    await new Promise(resolve => setTimeout(resolve, 0));

    window.$('#tts_voices').trigger('click');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(activeHarness.callGenericPopup).toHaveBeenCalledTimes(1);
    const [content, , , popupOptions] = activeHarness.callGenericPopup.mock.calls[0];
    expect(popupOptions).toEqual(expect.objectContaining({
        tier: 'dialog',
        title: 'Available Voices',
        onClose: expect.any(Function),
    }));

    const audio = content.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio.src).toBe('https://example.test/voice.mp3');
    const pause = jest.spyOn(audio, 'pause').mockImplementation(() => {});
    const load = jest.spyOn(audio, 'load').mockImplementation(() => {});
    audio.currentTime = 4;

    popupOptions.onClose();

    expect(pause).toHaveBeenCalledTimes(1);
    expect(audio.currentTime).toBe(0);
    expect(audio.getAttribute('src')).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    expect(activeHarness.releaseRowIds).toHaveBeenCalledWith(content);
});

test('SpeechT5 speaker deletion runs only after the destructive Alert response', async () => {
    jest.resetModules();
    const openAlert = jest.fn();

    await jest.unstable_mockModule(pub('scripts/sillybunny-editor/dialog.js'), () => ({ openAlert }));
    await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({ t: parts => parts.join('') }));
    await jest.unstable_mockModule(pub('scripts/extensions/tts/index.js'), () => ({
        getPreviewString: jest.fn(() => ''),
        saveTtsProviderSettings: jest.fn(),
    }));
    await jest.unstable_mockModule(pub('scripts/utils.js'), () => ({ getBase64Async: jest.fn() }));
    await jest.unstable_mockModule(pub('script.js'), () => ({ getRequestHeaders: jest.fn() }));

    const { SpeechT5TtsProvider } = await import(pub('scripts/extensions/tts/speecht5.js'));
    const handlers = new Map();
    const select = {
        append: jest.fn(),
        on: jest.fn((event, handler) => handlers.set('select-change', handler)),
        val: jest.fn(value => value ?? 'speaker-one'),
    };
    const jquery = jest.fn(selector => selector === '#speecht5_tts_speaker' ? select : {
        append: jest.fn(),
        on: jest.fn((event, handler) => handlers.set(String(selector), handler)),
        remove: jest.fn(),
        trigger: jest.fn(),
        val: select.val,
    });
    globalThis.$ = jquery;
    globalThis.toastr = { error: jest.fn() };
    const provider = new SpeechT5TtsProvider();
    await provider.loadSettings({
        speakers: [{ voice_id: 'speaker-one', name: 'Speaker One' }, { voice_id: 'speaker-two', name: 'Speaker Two' }],
        speaker: 'speaker-one',
        voiceMap: {},
    });
    const deleteSpeaker = handlers.get('#speecht5_tts_delete_speaker_button');

    openAlert.mockResolvedValueOnce('cancel');
    await deleteSpeaker();
    expect(openAlert).toHaveBeenLastCalledWith(expect.objectContaining({
        heading: 'Are you sure you want to delete this speaker?',
        responses: [
            { id: 'cancel', label: 'Cancel' },
            { id: 'delete', label: 'Delete', appearance: 'destructive' },
        ],
    }));
    expect(provider.settings.speakers).toHaveLength(2);

    openAlert.mockResolvedValueOnce('delete');
    await deleteSpeaker();
    expect(provider.settings.speakers.map(speaker => speaker.voice_id)).toEqual(['speaker-two']);
});
