/** @jest-environment jsdom */

import { jest, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(fileURLToPath(new URL('../../public/scripts/extensions/tts/index.js', import.meta.url)), 'utf8');

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
