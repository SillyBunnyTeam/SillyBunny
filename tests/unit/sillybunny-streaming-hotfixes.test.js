/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect -- Jest/jsdom assertions. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readRepoFile = (...segments) => readFileSync(path.join(repoRoot, ...segments), 'utf8').replace(/\r\n/g, '\n');

afterEach(() => {
    jest.restoreAllMocks();
});

describe('Slice 1C streaming, reasoning and scroll hotfixes', () => {
    test('segmentTextInElement caches one Intl.Segmenter per granularity and uses textContent', async () => {
        let constructed = 0;
        const OriginalSegmenter = globalThis.Intl.Segmenter;
        class CountingSegmenter {
            constructor(_locale, options) {
                constructed += 1;
                this.granularity = options?.granularity ?? 'word';
            }
            segment(text) {
                return text.split(/(\s+)/).filter(Boolean).map(segment => ({ segment }));
            }
        }
        globalThis.Intl.Segmenter = CountingSegmenter;
        try {
            jest.resetModules();
            jest.unstable_mockModule('../../public/lib.js', () => ({ morphdom: jest.fn() }));
            const { segmentTextInElement } = await import('../../public/scripts/util/stream-fadein.js');
            const first = document.createElement('div');
            const second = document.createElement('div');
            segmentTextInElement(first, '<p>Hello world</p>');
            segmentTextInElement(second, '<p>Second tick</p>');

            expect(constructed).toBe(1);
            expect(first.querySelectorAll('.text_segment').length).toBeGreaterThan(1);
            expect(second.textContent).toBe('Second tick');
        } finally {
            globalThis.Intl.Segmenter = OriginalSegmenter;
        }
    });

    test('reasoning.js guards plain-message init, duplicate regexes, and unchanged completed DOM morphs', () => {
        const reasoningJs = readRepoFile('public', 'scripts', 'reasoning.js');

        expect(reasoningJs).toContain('#lastRenderedReasoningText');
        expect(reasoningJs).toContain('#lastRenderedReasoningDom');
        expect(reasoningJs).toContain('#lastRawReasoningInput');
        expect(reasoningJs).toContain('reasoningBodyUnchanged');
        expect(reasoningJs).toContain('!messageElement.classList.contains(\'reasoning\')');
    });

    test('in-chat agents capture stream regex snapshots once per stream and render mounted companion rows only', () => {
        const agentRunnerJs = readRepoFile('public', 'scripts', 'extensions', 'in-chat-agents', 'agent-runner.js');
        const companionUiJs = readRepoFile('public', 'scripts', 'extensions', 'in-chat-agents', 'companion', 'companion-ui.js');

        expect(agentRunnerJs).toContain('lastStreamRegexSnapshotProcessor === liveStreamingProcessor');
        expect(companionUiJs).toContain('document.querySelectorAll(\'#chat > .mes[mesid]\')');
    });
});
