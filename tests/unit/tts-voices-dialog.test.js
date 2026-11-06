/** @jest-environment jsdom */
/* global globalThis */

import { jest, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(fileURLToPath(new URL('../../public/scripts/extensions/tts/index.js', import.meta.url)), 'utf8');
const openAlert = jest.fn();

await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/dialog.js', () => ({ openAlert }));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: parts => parts.join('') }));
await jest.unstable_mockModule('../../public/scripts/extensions/tts/index.js', () => ({
    getPreviewString: jest.fn(() => ''),
    saveTtsProviderSettings: jest.fn(),
}));
await jest.unstable_mockModule('../../public/scripts/utils.js', () => ({ getBase64Async: jest.fn() }));
await jest.unstable_mockModule('../../public/script.js', () => ({ getRequestHeaders: jest.fn() }));
const { SpeechT5TtsProvider } = await import('../../public/scripts/extensions/tts/speecht5.js');

function extractFunction(name) {
    const start = source.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    const bodyStart = source.indexOf('{', source.indexOf(')', start));
    let depth = 0;
    for (let index = bodyStart; index < source.length; index++) {
        if (source[index] === '{') depth++;
        if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`Unable to extract ${name}`);
}

test('voice Dialog keeps its title and stops preview audio on close', () => {
    expect(source).toContain('title: t`Available voices`');
    const releaseRowIds = jest.fn();
    const cleanup = vm.runInNewContext(`(${extractFunction('cleanupVoicePreviewContent')})`, { releaseRowIds });
    const content = document.createElement('div');
    const audio = document.createElement('audio');
    const pause = jest.spyOn(audio, 'pause').mockImplementation(() => {});
    const load = jest.spyOn(audio, 'load').mockImplementation(() => {});
    audio.src = 'https://example.test/voice.mp3';
    content.append(audio);

    cleanup(content);

    expect(pause).toHaveBeenCalledTimes(1);
    expect(audio.currentTime).toBe(0);
    expect(audio.getAttribute('src')).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    expect(releaseRowIds).toHaveBeenCalledWith(content);
});

test('SpeechT5 speaker deletion runs only after the destructive Alert response', async () => {
    const handlers = new Map();
    const select = {
        append: jest.fn(),
        on: jest.fn((event, handler) => handlers.set('select-change', handler)),
        val: jest.fn(value => value ?? 'speaker-one'),
    };
    const jquery = jest.fn(selector => ({
        append: jest.fn(),
        on: jest.fn((event, handler) => handlers.set(String(selector), handler)),
        remove: jest.fn(),
        trigger: jest.fn(),
        val: select.val,
    }));
    jquery.mockImplementation(selector => selector === '#speecht5_tts_speaker' ? select : {
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
