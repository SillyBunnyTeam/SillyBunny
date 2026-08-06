import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ttsSource = (await fs.readFile(fileURLToPath(new URL('../public/scripts/extensions/tts/index.js', import.meta.url)), 'utf8')).replace(/\r\n/g, '\n');
const stripTtsTaggedBlocksStart = ttsSource.indexOf('function stripTtsTaggedBlocks(');
const stripTtsTaggedBlocksEnd = ttsSource.indexOf('async function processTtsQueue()', stripTtsTaggedBlocksStart);
const stripTtsTaggedBlocks = vm.runInNewContext(`(${ttsSource.slice(stripTtsTaggedBlocksStart, stripTtsTaggedBlocksEnd)})`);
const joinQuotedBlocksStart = ttsSource.indexOf('function joinQuotedBlocks(');
const joinQuotedBlocksEnd = ttsSource.indexOf('async function playFullConversation()', joinQuotedBlocksStart);
const joinQuotedBlocks = vm.runInNewContext(`(${ttsSource.slice(joinQuotedBlocksStart, joinQuotedBlocksEnd)})`);

describe('TTS quoted-only filtering', () => {
    test('filters semantic blocks before extracting quoted dialogue', () => {
        const processTtsQueueBody = ttsSource.slice(
            ttsSource.indexOf('async function processTtsQueue()'),
            ttsSource.indexOf('/**\n * Extract and join quoted blocks'),
        );
        const asteriskFilterIndex = processTtsQueueBody.indexOf('text = filterTtsAsterisks(text, {');
        const quotedOnlyIndex = processTtsQueueBody.indexOf('if (extension_settings.tts.narrate_quoted_only)');
        const taggedBlockFilterIndex = processTtsQueueBody.indexOf('text = stripTtsTaggedBlocks(text, { preserveFormatting: true });', quotedOnlyIndex);
        const markupFilterIndex = processTtsQueueBody.indexOf('text = text.replace(/<.*?>/g, \'\').trim();', quotedOnlyIndex);
        const quoteExtractionIndex = processTtsQueueBody.indexOf('text = joinQuotedBlocks(text, { separator: partJoiner, includeQuotes: true });', quotedOnlyIndex);

        expect(asteriskFilterIndex).toBeGreaterThanOrEqual(0);
        expect(asteriskFilterIndex).toBeLessThan(quotedOnlyIndex);
        expect(quotedOnlyIndex).toBeGreaterThanOrEqual(0);
        expect(taggedBlockFilterIndex).toBeGreaterThan(quotedOnlyIndex);
        expect(markupFilterIndex).toBeGreaterThan(taggedBlockFilterIndex);
        expect(quoteExtractionIndex).toBeGreaterThan(markupFilterIndex);
    });

    test('excludes quoted text inside asterisk actions when both filters are enabled', () => {
        const filterTtsAsterisksStart = ttsSource.indexOf('function filterTtsAsterisks(');
        const filterTtsAsterisksEnd = ttsSource.indexOf('// SillyBunny: discard semantic blocks', filterTtsAsterisksStart);

        expect(filterTtsAsterisksStart).toBeGreaterThanOrEqual(0);
        expect(filterTtsAsterisksEnd).toBeGreaterThan(filterTtsAsterisksStart);

        const filterTtsAsterisks = vm.runInNewContext(`(${ttsSource.slice(filterTtsAsterisksStart, filterTtsAsterisksEnd)})`);
        const filteredText = filterTtsAsterisks('*"Do not narrate me."*', {
            narrateDialoguesOnly: true,
            passAsterisks: false,
        });

        expect(joinQuotedBlocks(filteredText, { includeQuotes: true })).toBe('');
    });

    test('does not treat quoted font attributes as dialogue', () => {
        const taggedDialogue = '<font color="#c8a86e">"More water. That fire\'s dying. Move, girl, move."</font>';
        const textWithoutTagMarkup = taggedDialogue.replace(/<.*?>/g, '').trim();

        expect(joinQuotedBlocks(textWithoutTagMarkup, { includeQuotes: true }))
            .toBe('"More water. That fire\'s dying. Move, girl, move."');
    });

    test('drops quoted semantic blocks while preserving dialogue inside formatting wrappers', () => {
        const taggedDialogue = '<think>"Keep this hidden."</think><font color="#c8a86e">"Speak this aloud."</font>';
        const filteredText = stripTtsTaggedBlocks(taggedDialogue, { preserveFormatting: true });
        const textWithoutTagMarkup = filteredText.replace(/<.*?>/g, '').trim();

        expect(joinQuotedBlocks(textWithoutTagMarkup, { includeQuotes: true }))
            .toBe('"Speak this aloud."');
    });
});
