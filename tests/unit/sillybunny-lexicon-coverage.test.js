/* eslint-disable playwright/no-standalone-expect -- Jest contracts for a data file. */
import { readFileSync } from 'node:fs';

import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
const { getHelpSections } = await import('../../public/scripts/sillybunny-help/topics.js');
const { getHomeAssistants } = await import('../../public/scripts/sillybunny-home/assistant-registry.js');

const LEXICON_URL = new URL('../../default/content/SillyBunny Lexicon.json', import.meta.url);
const raw = readFileSync(LEXICON_URL, 'utf8');
const entries = Object.values(JSON.parse(raw).entries);

/** The inventory ids of the lexicon: A0 is the overview, and the last one is A79. */
const INVENTORY_SIZE = 80;
/** `world_info_position` before and after the character definitions, the only places that Conversation reads. */
const ALLOWED_POSITIONS = [0, 1];
const REMOVED_NAMES = ['Pura', 'Bunny Guide', 'Nahida', 'Launchpad', 'Platberlitz'];
/**
 * Words that appear in almost every question about the app. A key that is one of them, or its plural, would put its
 * entry into most prompts.
 */
const COMMON_WORD_KEYS = [
    'home', 'help', 'chat', 'model', 'preset', 'conversation', 'dm', 'assistant', 'reisen', 'tewi', 'character',
    'persona', 'prompt', 'api', 'token', 'search', 'mode', 'extension', 'theme',
];

const label = entry => entry.comment;

/**
 * An assistant's name may be a key of its own only on an entry that leaves her own card out, because her name is in
 * every prompt of her own chats.
 */
const isOwnAssistantName = (entry, word) => getHomeAssistants().some(assistant => assistant.name.toLowerCase() === word
    && entry.characterFilter?.isExclude === true
    && Boolean(entry.characterFilter.names?.includes(assistant.fileName)));
const topicsOf = entry => entry.extensions?.sb_topic ?? [];
const helpTopicIds = () => getHelpSections().flatMap(section => section.topics.map(topic => topic.id));

describe('the SillyBunny Lexicon', () => {
    test(`has an entry for every inventory id from A0 to A${INVENTORY_SIZE - 1}, once each, numbered by its uid`, () => {
        const inventoryIds = entries.map(entry => /^A(\d+)(?: |$)/.exec(entry.comment)?.[1]);

        expect(entries).toHaveLength(INVENTORY_SIZE);
        expect(inventoryIds.slice().sort((a, b) => a - b)).toEqual(Array.from({ length: INVENTORY_SIZE }, (_, id) => String(id)));
        expect(entries.map(entry => String(entry.uid))).toEqual(inventoryIds);
    });

    test('has an entry for every Help topic', () => {
        const covered = new Set(entries.flatMap(topicsOf));
        const topicIds = helpTopicIds();

        expect(topicIds.length).toBeGreaterThan(0);
        expect(topicIds.filter(id => !covered.has(id))).toEqual([]);
    });

    test('names only Help topics that exist, so a renamed topic is not left behind in an entry', () => {
        const topicIds = new Set(helpTopicIds());

        expect(entries.flatMap(topicsOf).filter(id => !topicIds.has(id))).toEqual([]);
    });

    test.each(REMOVED_NAMES)('does not mention %s, which is no longer part of SillyBunny', (name) => {
        const pattern = new RegExp(`\\b${name}\\b`, 'i');

        expect(entries.filter(entry => pattern.test(JSON.stringify(entry))).map(label)).toEqual([]);
    });

    test('has exactly one constant entry, the overview', () => {
        expect(entries.filter(entry => entry.constant).map(label)).toEqual([entries[0].comment]);
        expect(entries[0].comment).toMatch(/^A0 /);
    });

    test('gives every other entry keys to be triggered by', () => {
        expect(entries.filter(entry => !entry.constant && entry.key.length === 0).map(label)).toEqual([]);
    });

    test('puts every entry before or after the character definitions, the places that Conversation reads', () => {
        expect(entries.filter(entry => !ALLOWED_POSITIONS.includes(entry.position)).map(label)).toEqual([]);
    });

    test.each(['sticky', 'cooldown', 'delay'])('sets %s to 0 on every entry, because Conversation does not keep timed effects between replies', (timer) => {
        expect(entries.filter(entry => (entry[timer] ?? 0) !== 0).map(label)).toEqual([]);
    });

    test('has no macro, because one resolves against the character open in Roleplay when Conversation scans', () => {
        expect(raw).not.toContain('{{');
    });

    test('has no key that is a common word of its own, because that entry would join most prompts', () => {
        const bare = entries.flatMap(entry => entry.key.map(key => [entry, key]))
            .filter(([entry, key]) => {
                const word = key.trim().toLowerCase();
                return !isOwnAssistantName(entry, word) && (COMMON_WORD_KEYS.includes(word) || COMMON_WORD_KEYS.includes(word.replace(/s$/, '')));
            })
            .map(([entry, key]) => [label(entry), key]);

        expect(bare).toEqual([]);
    });

    test('keys the entry about each assistant on her name and leaves her own card out, so the other assistant learns about her and her own chats do not carry it on every reply', () => {
        for (const assistant of getHomeAssistants()) {
            const about = entries.filter(entry => entry.key.includes(assistant.name.toLowerCase()));

            expect([assistant.name, about.map(label)]).toEqual([assistant.name, [expect.stringMatching(new RegExp(`^A\\d+ ${assistant.name} `))]]);
            expect([assistant.name, about[0].characterFilter]).toEqual([assistant.name, { isExclude: true, names: [assistant.fileName], tags: [] }]);
        }
    });
});
