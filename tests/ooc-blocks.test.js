import { describe, test, expect } from '@jest/globals';

import {
    extractOocBlocksForDisplay,
    hasPromptPayload,
    hasTextOrArrayPayload,
    normalizeContextRetentionDepth,
    renderOocBlock,
    restoreOocBlocksForDisplay,
    shouldRetainContextAtDepth,
    stripHtmlTagsFromContext,
    stripOocBlocksFromContext,
} from '../public/scripts/ooc-blocks.js';

describe('OOC block handling', () => {
    test('strips OOC when prompt-context retention is disabled', () => {
        expect(stripOocBlocksFromContext('Visible ((do not prompt this)) text')).toBe('Visible text');
    });

    test('removes nested OOC blocks as one prompt-context unit', () => {
        expect(stripOocBlocksFromContext('Visible ((outer ((inner)) done)) text')).toBe('Visible text');
    });

    test('keeps unclosed OOC text intact instead of swallowing the rest of the prompt', () => {
        expect(stripOocBlocksFromContext('Visible ((unfinished note')).toBe('Visible ((unfinished note');
    });

    test('can preserve OOC blocks for recent context messages', () => {
        expect(stripOocBlocksFromContext('Visible ((keep this)) text', true)).toBe('Visible ((keep this)) text');
    });

    test('strips or preserves HTML tags for prompt context', () => {
        expect(stripHtmlTagsFromContext('Visible <strong>tagged</strong> text')).toBe('Visible tagged text');
        expect(stripHtmlTagsFromContext('Visible <strong>tagged</strong> text', true)).toBe('Visible <strong>tagged</strong> text');
    });

    test('extracts and restores OOC display blocks in source order', () => {
        const blocks = [];
        const extracted = extractOocBlocksForDisplay('A ((first)) B ((second)) C', blocks);
        const restored = restoreOocBlocksForDisplay(extracted, blocks);

        expect(blocks).toEqual(['first', 'second']);
        expect(restored).toContain('A <details class="ooc_block">');
        expect(restored).toContain('<div class="ooc_content">first</div>');
        expect(restored).toContain(' B <details class="ooc_block">');
        expect(restored).toContain('<div class="ooc_content">second</div>');
        expect(restored).toContain(' C');
    });

    test('escapes OOC display content before final sanitization', () => {
        const rendered = renderOocBlock('<img src=x onerror=alert(1)> & "quote"');

        expect(rendered).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(rendered).toContain('&amp;');
        expect(rendered).toContain('&quot;quote&quot;');
        expect(rendered).not.toContain('<img src=x');
    });

    test('renders empty OOC content with a stable placeholder label', () => {
        expect(renderOocBlock('   ')).toContain('<div class="ooc_content">(empty)</div>');
    });

    test('keeps media-only and tool-only prompt messages after OOC text stripping', () => {
        expect(hasTextOrArrayPayload('', [[{ url: 'image.png' }]])).toBe(true);
        expect(hasTextOrArrayPayload('', [[], [{ id: 'tool-call' }]])).toBe(true);
        expect(hasTextOrArrayPayload(stripOocBlocksFromContext('((note only))'), [])).toBe(false);
        expect(hasTextOrArrayPayload('', [[], undefined])).toBe(false);
    });

    test('keeps reasoning-only prompt messages only for continuation', () => {
        const message = { mes: '', extra: { reasoning: 'partial reasoning' } };

        expect(hasPromptPayload(message)).toBe(false);
        expect(hasPromptPayload(message, true)).toBe(true);
        expect(hasPromptPayload({ mes: '', extra: { reasoning: '   ' } }, true)).toBe(false);
    });

    test('keeps non-text prompt payloads without continuation reasoning', () => {
        expect(hasPromptPayload({ mes: '', extra: { media: [{ url: 'image.png' }] } })).toBe(true);
        expect(hasPromptPayload({ mes: '', extra: { files: [{ name: 'file.txt' }] } })).toBe(true);
        expect(hasPromptPayload({ mes: '', extra: { tool_invocations: [{ id: 'tool-call' }] } })).toBe(true);
        expect(hasPromptPayload({ mes: '' })).toBe(false);
    });

    test('normalizes context retention depth with -1 as preserve-all default', () => {
        expect(normalizeContextRetentionDepth(undefined)).toBe(-1);
        expect(normalizeContextRetentionDepth('')).toBe(-1);
        expect(normalizeContextRetentionDepth(-5)).toBe(-1);
        expect(normalizeContextRetentionDepth(2.9)).toBe(2);
    });

    test('retains context content according to -1, active-turn, and max-depth settings', () => {
        expect(shouldRetainContextAtDepth(50, -1)).toBe(true);
        expect(shouldRetainContextAtDepth(0, 0)).toBe(true);
        expect(shouldRetainContextAtDepth(1, 0)).toBe(false);
        expect(shouldRetainContextAtDepth(0, 2)).toBe(true);
        expect(shouldRetainContextAtDepth(1, 2)).toBe(true);
        expect(shouldRetainContextAtDepth(2, 2)).toBe(true);
        expect(shouldRetainContextAtDepth(3, 2)).toBe(false);
    });

    test('keeps OOC and HTML for the active turn when context depth is zero', () => {
        expect(stripOocBlocksFromContext('Visible ((active turn note)) text', shouldRetainContextAtDepth(0, 0)))
            .toBe('Visible ((active turn note)) text');
        expect(stripOocBlocksFromContext('Visible ((older note)) text', shouldRetainContextAtDepth(1, 0)))
            .toBe('Visible text');
        expect(stripHtmlTagsFromContext('Visible <em>active turn tag</em> text', shouldRetainContextAtDepth(0, 0)))
            .toBe('Visible <em>active turn tag</em> text');
        expect(stripHtmlTagsFromContext('Visible <em>older tag</em> text', shouldRetainContextAtDepth(1, 0)))
            .toBe('Visible older tag text');
    });
});
