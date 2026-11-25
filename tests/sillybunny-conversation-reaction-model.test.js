import { describe, expect, test } from '@jest/globals';

import {
    DEFAULT_QUICK_REACTIONS,
    MAX_DISTINCT_REACTIONS,
    REACTION_RECENTS_CAP,
    USER_REACTOR,
    addCharacterReaction,
    describeReactionChip,
    getQuickReactions,
    groupReactions,
    pushReactionRecent,
    readReactionRecents,
    readReactions,
    toggleUserReaction,
    writeReactions,
} from '../public/scripts/sillybunny-conversation/reaction-model.js';

const message = conversationReactions => ({ id: 'm1', role: 'character', extra: conversationReactions === undefined ? {} : { conversation_reactions: conversationReactions } });
const entry = (emoji, by = USER_REACTOR, at = 1) => ({ emoji, by, at });

describe('reading the reactions of a message', () => {
    test('answers none for a message with no reactions or no extra', () => {
        expect(readReactions(message())).toEqual([]);
        expect(readReactions({ id: 'x' })).toEqual([]);
        expect(readReactions(null)).toEqual([]);
    });

    test('reads an array of entries as it is', () => {
        const entries = [entry('😂', 'user', 5), entry('😂', 'aster.png', 9)];

        expect(readReactions(message(entries))).toEqual(entries);
    });

    test('reads the old object as reactions of the user, for every key above zero, in the order of the keys', () => {
        expect(readReactions(message({ heart: 1, spark: 0, laugh: 1 }))).toEqual([
            { emoji: '❤️', by: 'user', at: 0 },
            { emoji: '😂', by: 'user', at: 0 },
        ]);
    });

    test('reads an old key that is an emoji itself, and skips one that is neither a known key nor an emoji', () => {
        expect(readReactions(message({ '🔥': 1, thumbsup: 1 }))).toEqual([{ emoji: '🔥', by: 'user', at: 0 }]);
    });

    test('drops entries that are not an emoji, a reactor and a time, and keeps the rest', () => {
        const garbage = [entry('😂'), { emoji: 'laugh', by: 'user', at: 1 }, { emoji: '👍', by: '', at: 1 }, 'x', null, { emoji: '👍', by: 'user', at: 'soon' }];

        expect(readReactions(message(garbage))).toEqual([entry('😂'), { emoji: '👍', by: 'user', at: 0 }]);
    });

    test('keeps one entry of a reactor for an emoji, and one entry of a character', () => {
        const duplicated = [entry('😂'), entry('😂'), entry('❤️', 'aster.png'), entry('👍', 'aster.png')];

        expect(readReactions(message(duplicated))).toEqual([entry('😂'), entry('❤️', 'aster.png')]);
    });

    test('reads at most 64 entries of a file that was edited by hand', () => {
        const many = Array.from({ length: 100 }, (_, index) => entry('😂', `member-${index}.png`));

        expect(readReactions(message(many))).toHaveLength(64);
    });

    test('answers a fresh array each time, so that a caller cannot change the message', () => {
        const entries = [entry('😂')];
        const read = readReactions(message(entries));
        read.push(entry('👍'));

        expect(entries).toHaveLength(1);
    });
});

describe('writing the reactions of a message', () => {
    test('stores the entries as an array in extra, whatever the old value was, and keeps the other keys', () => {
        const target = { id: 'm1', extra: { conversation_pinned: true, conversation_reactions: { heart: 1 } } };
        writeReactions(target, [entry('❤️')]);

        expect(target.extra).toEqual({ conversation_pinned: true, conversation_reactions: [entry('❤️')] });
    });

    test('removes the key when no reaction is left, so that a message carries no empty array', () => {
        const target = { id: 'm1', extra: { conversation_reactions: [entry('❤️')] } };
        writeReactions(target, []);

        expect(target.extra).toEqual({});
    });

    test('makes the extra of a message that has none', () => {
        const target = { id: 'm1' };
        writeReactions(target, [entry('😂')]);

        expect(readReactions(target)).toEqual([entry('😂')]);
    });
});

describe('the user toggling a reaction', () => {
    test('adds an entry of the user, with the emoji in its fully qualified form', () => {
        const result = toggleUserReaction([], '❤', 1000);

        expect(result).toEqual({ status: 'added', entries: [{ emoji: '❤️', by: 'user', at: 1000 }] });
    });

    test('removes the entry of the user when the emoji is pressed again, whichever way it is written', () => {
        const result = toggleUserReaction([entry('❤️')], '❤');

        expect(result).toEqual({ status: 'removed', entries: [] });
    });

    test('keeps several distinct emoji of the user', () => {
        const first = toggleUserReaction([], '😂', 1).entries;
        const second = toggleUserReaction(first, '👍', 2).entries;

        expect(second.map(item => item.emoji)).toEqual(['😂', '👍']);
    });

    test('removes only the entry of the user and leaves the character that chose the same emoji', () => {
        const result = toggleUserReaction([entry('😂'), entry('😂', 'aster.png', 2)], '😂');

        expect(result.entries).toEqual([entry('😂', 'aster.png', 2)]);
    });

    test('joins a chip that a character started without taking a place of the 20', () => {
        const full = Array.from({ length: MAX_DISTINCT_REACTIONS }, (_, index) => entry(String.fromCodePoint(0x1F600 + index), 'aster.png'));
        const result = toggleUserReaction(full, String.fromCodePoint(0x1F600));

        expect(result.status).toBe('added');
        expect(result.entries).toHaveLength(MAX_DISTINCT_REACTIONS + 1);
    });

    test('refuses a 21st distinct emoji and leaves the entries as they were', () => {
        const full = Array.from({ length: MAX_DISTINCT_REACTIONS }, (_, index) => entry(String.fromCodePoint(0x1F600 + index)));
        const result = toggleUserReaction(full, '🦊');

        expect(result).toEqual({ status: 'refused', entries: full });
    });

    test('still removes a reaction while the message holds 20', () => {
        const full = Array.from({ length: MAX_DISTINCT_REACTIONS }, (_, index) => entry(String.fromCodePoint(0x1F600 + index)));

        expect(toggleUserReaction(full, String.fromCodePoint(0x1F600)).status).toBe('removed');
    });

    test('refuses text that is not one emoji', () => {
        expect(toggleUserReaction([], 'heart')).toEqual({ status: 'invalid', entries: [] });
        expect(toggleUserReaction([], '😀😀').status).toBe('invalid');
    });

    test('does not change the array that it was given', () => {
        const entries = [entry('😂')];
        toggleUserReaction(entries, '👍');

        expect(entries).toEqual([entry('😂')]);
    });
});

describe('a character reacting', () => {
    test('adds one entry for the character, with the time that it was given', () => {
        const next = addCharacterReaction([], '🎉', 'aster.png', 77);

        expect(next).toEqual([{ emoji: '🎉', by: 'aster.png', at: 77 }]);
    });

    test('does nothing when the character reacted already, so that a forced second reply adds no second reaction', () => {
        const entries = [entry('🎉', 'aster.png')];

        expect(addCharacterReaction(entries, '😂', 'aster.png', 99)).toBe(entries);
    });

    test('lets two characters choose the same emoji', () => {
        const next = addCharacterReaction([entry('🎉', 'aster.png')], '🎉', 'nova.png', 5);

        expect(next.map(item => item.by)).toEqual(['aster.png', 'nova.png']);
    });

    test('drops a reaction that would be the 21st distinct emoji, without a trace', () => {
        const full = Array.from({ length: MAX_DISTINCT_REACTIONS }, (_, index) => entry(String.fromCodePoint(0x1F600 + index)));

        expect(addCharacterReaction(full, '🦊', 'aster.png', 5)).toBe(full);
    });

    test('ignores text that is not one emoji, and the reactor "user"', () => {
        expect(addCharacterReaction([], 'haha', 'aster.png', 1)).toEqual([]);
        expect(addCharacterReaction([], '😂', USER_REACTOR, 1)).toEqual([]);
        expect(addCharacterReaction([], '😂', '', 1)).toEqual([]);
    });
});

describe('the chips of a message', () => {
    test('are one per emoji, counted, with who reacted and whether the user did', () => {
        const chips = groupReactions([entry('😂', 'user', 3), entry('👍', 'aster.png', 4), entry('😂', 'aster.png', 5)]);

        expect(chips).toEqual([
            { key: '😂', emoji: '😂', count: 2, mine: true, reactors: [{ by: 'user', at: 3 }, { by: 'aster.png', at: 5 }], at: 3 },
            { key: '👍', emoji: '👍', count: 1, mine: false, reactors: [{ by: 'aster.png', at: 4 }], at: 4 },
        ]);
    });

    test('are ordered by the earliest reaction, and by position when the times are equal', () => {
        const chips = groupReactions([entry('👍', 'aster.png', 9), entry('😂', 'user', 2), entry('✨', 'user', 2)]);

        expect(chips.map(chip => chip.emoji)).toEqual(['😂', '✨', '👍']);
    });

    test('count a bare and a qualified heart as one chip', () => {
        const chips = groupReactions([entry('❤', 'user', 1), entry('❤️', 'aster.png', 2)]);

        expect(chips).toHaveLength(1);
        expect(chips[0].count).toBe(2);
    });

    test('are none for no reactions', () => {
        expect(groupReactions([])).toEqual([]);
    });
});

describe('the accessible name of a chip', () => {
    const chip = count => ({ key: '❤️', emoji: '❤️', count, mine: false, reactors: [], at: 0 });

    test('has the name of the emoji and the count, in the singular for one', () => {
        expect(describeReactionChip(chip(1), 'red heart')).toBe('red heart, 1 reaction');
        expect(describeReactionChip(chip(3), 'red heart')).toBe('red heart, 3 reactions');
    });

    test('names the emoji itself when no name is known', () => {
        expect(describeReactionChip(chip(2), '')).toBe('❤️, 2 reactions');
    });
});

describe('the quick row and its recents', () => {
    test('is the default six for a user with no recents, the old three first', () => {
        const row = getQuickReactions([]);

        expect(row.map(item => item.e)).toEqual(['❤️', '😂', '✨', '👍', '😮', '😢']);
        expect(DEFAULT_QUICK_REACTIONS).toHaveLength(6);
    });

    test('puts the recents first and tops up from the defaults without a repeat', () => {
        const row = getQuickReactions([{ e: '🎉', n: 'party popper' }, { e: '😂', n: 'face with tears of joy' }]);

        expect(row.map(item => item.e)).toEqual(['🎉', '😂', '❤️', '✨', '👍', '😮']);
    });

    test('holds the newest six of seven recents', () => {
        const recents = ['🔥', '🙏', '🥳', '😎', '🤔', '🤯', '👀'].map(e => ({ e, n: e }));

        expect(getQuickReactions(recents).map(item => item.e)).toEqual(['🔥', '🙏', '🥳', '😎', '🤔', '🤯']);
    });

    test('takes the number of emoji that the surface can hold', () => {
        expect(getQuickReactions([], 2).map(item => item.e)).toEqual(['❤️', '😂']);
    });

    test('puts a reaction first, drops its earlier place and keeps its name', () => {
        const list = pushReactionRecent([{ e: '😂', n: 'laughing' }, { e: '🎉', n: 'party popper' }], { e: '🎉', n: 'party popper' });

        expect(list).toEqual([{ e: '🎉', n: 'party popper' }, { e: '😂', n: 'laughing' }]);
    });

    test('counts a bare and a qualified heart as the same recent', () => {
        const list = pushReactionRecent([{ e: '❤️', n: 'red heart' }], { e: '❤', n: 'heart' });

        expect(list).toHaveLength(1);
        expect(list[0].e).toBe('❤️');
    });

    test('keeps at most 24', () => {
        let list = [];
        for (let index = 0; index < 40; index++) {
            list = pushReactionRecent(list, { e: String.fromCodePoint(0x1F600 + index), n: `face ${index}` });
        }

        expect(list).toHaveLength(REACTION_RECENTS_CAP);
        expect(list[0].n).toBe('face 39');
    });

    test('ignores an entry that is not one emoji', () => {
        const list = [{ e: '😂', n: 'laughing' }];

        expect(pushReactionRecent(list, { e: 'x', n: 'x' })).toBe(list);
    });

    test('reads the recents that the settings hold, and drops what is not an entry', () => {
        const raw = [{ e: '😂', n: 'laughing' }, { e: 'x', n: 'x' }, null, 'y', { e: '👍' }];

        expect(readReactionRecents(raw)).toEqual([{ e: '😂', n: 'laughing' }, { e: '👍', n: '' }]);
        expect(readReactionRecents(undefined)).toEqual([]);
    });
});
