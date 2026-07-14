import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ttsSource = await fs.readFile(fileURLToPath(new URL('../public/scripts/extensions/tts/index.js', import.meta.url)), 'utf8');
const joinQuotedBlocksStart = ttsSource.indexOf('function joinQuotedBlocks(');
const joinQuotedBlocksEnd = ttsSource.indexOf('\n\nasync function playFullConversation()', joinQuotedBlocksStart);
const joinQuotedBlocks = vm.runInNewContext(`(${ttsSource.slice(joinQuotedBlocksStart, joinQuotedBlocksEnd)})`);

describe('TTS quoted-only filtering', () => {
    test('extracts quoted dialogue before removing tagged blocks', () => {
        const processTtsQueueBody = ttsSource.slice(
            ttsSource.indexOf('async function processTtsQueue()'),
            ttsSource.indexOf('/**\n * Extract and join quoted blocks'),
        );
        const quotedOnlyIndex = processTtsQueueBody.indexOf('if (extension_settings.tts.narrate_quoted_only)');
        const skipTagsIndex = processTtsQueueBody.indexOf('if (extension_settings.tts.skip_tags)');

        expect(quotedOnlyIndex).toBeGreaterThanOrEqual(0);
        expect(skipTagsIndex).toBeGreaterThanOrEqual(0);
        expect(quotedOnlyIndex).toBeLessThan(skipTagsIndex);
        expect(processTtsQueueBody.slice(quotedOnlyIndex, skipTagsIndex))
            .toContain('text = text.replace(/<.*?>/g, \'\').trim();\n        text = joinQuotedBlocks(text, { separator: partJoiner, includeQuotes: true });');
    });

    test('does not treat quoted font attributes as dialogue', () => {
        const taggedDialogue = '<font color="#c8a86e">"More water. That fire\'s dying. Move, girl, move."</font>';
        const textWithoutTagMarkup = taggedDialogue.replace(/<.*?>/g, '').trim();

        expect(joinQuotedBlocks(textWithoutTagMarkup, { includeQuotes: true }))
            .toBe('"More water. That fire\'s dying. Move, girl, move."');
    });
});
