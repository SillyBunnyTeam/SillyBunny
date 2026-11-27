import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const store = {};
const persist = jest.fn();
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getConversationStore: () => store,
    persistConversationStore: persist,
}));

const { RECENT_LIMIT, pushRecent, readRecents } = await import('../public/scripts/sillybunny-conversation/emoji/emoji-recents.js');
const emojiStore = await import('../public/scripts/sillybunny-conversation/emoji/emoji-store.js');

beforeEach(() => {
    for (const key of Object.keys(store)) {
        delete store[key];
    }
    persist.mockClear();
});

describe('readRecents', () => {
    test('keeps valid entries with and without a name, newest first as stored', () => {
        expect(readRecents([{ e: '😂', n: 'face with tears of joy' }, { e: '👍' }])).toEqual([{ e: '😂', n: 'face with tears of joy' }, { e: '👍' }]);
    });

    test('drops what is not one emoji, repeats and a list that is not a list', () => {
        expect(readRecents([{ e: 'heart' }, { e: '😀😀' }, null, 'x', { e: '😀' }, { e: '😀' }, { n: 'no emoji' }])).toEqual([{ e: '😀' }]);
        expect(readRecents(undefined)).toEqual([]);
        expect(readRecents({ e: '😀' })).toEqual([]);
    });

    test('treats an emoji with and without its selector as one, and keeps the qualified form', () => {
        expect(readRecents([{ e: '❤' }, { e: '❤️' }])).toEqual([{ e: '❤️' }]);
    });

    test('drops a name that is not a short text, and cuts the list at the limit', () => {
        expect(readRecents([{ e: '😀', n: 5 }])).toEqual([{ e: '😀' }]);
        expect(readRecents([{ e: '😀', n: 'x'.repeat(200) }])).toEqual([{ e: '😀' }]);
        const many = ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '🥲', '😋', '😛', '😜', '😝', '🤑'];
        expect(readRecents(many.map(e => ({ e }))).length).toBe(RECENT_LIMIT);
    });
});

describe('pushRecent', () => {
    test('puts the new entry first and does not change the list it was given', () => {
        const before = [{ e: '👍' }];
        expect(pushRecent(before, { e: '😂', n: 'laugh' })).toEqual([{ e: '😂', n: 'laugh' }, { e: '👍' }]);
        expect(before).toEqual([{ e: '👍' }]);
    });

    test('moves an emoji that is there already to the front, by its key and with its newest name', () => {
        expect(pushRecent([{ e: '😂' }, { e: '❤️' }], { e: '❤', n: 'red heart' })).toEqual([{ e: '❤️', n: 'red heart' }, { e: '😂' }]);
    });

    test('keeps a skin tone and the plain emoji apart', () => {
        expect(pushRecent([{ e: '👍' }], { e: '👍🏽' }).map(item => item.e)).toEqual(['👍🏽', '👍']);
    });

    test('cuts at the limit, dropping the oldest', () => {
        let list = [];
        for (const e of ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '🥲', '😋', '😛', '😜', '😝', '🤑']) {
            list = pushRecent(list, { e });
        }
        expect(list.length).toBe(RECENT_LIMIT);
        expect(list[0].e).toBe('🤑');
        expect(list.some(item => item.e === '😀')).toBe(false);
    });

    test('refuses an entry that is not one emoji', () => {
        expect(pushRecent([{ e: '👍' }], { e: 'thumbs' })).toEqual([{ e: '👍' }]);
    });
});

describe('the lists in the mode object', () => {
    test('the chooser list and the reaction list are two lists, and a push saves the settings once', () => {
        emojiStore.pushRecentEmoji({ e: '😂', n: 'face with tears of joy' });
        emojiStore.pushRecentReaction({ e: '❤️' });
        expect(emojiStore.readRecentEmoji()).toEqual([{ e: '😂', n: 'face with tears of joy' }]);
        expect(emojiStore.readRecentReactions()).toEqual([{ e: '❤️' }]);
        expect(store.recentEmoji).toEqual([{ e: '😂', n: 'face with tears of joy' }]);
        expect(store.recentReactions).toEqual([{ e: '❤️' }]);
        expect(persist).toHaveBeenCalledTimes(2);
    });

    test('reads a list that a hand edit damaged as empty and rewrites it on the next push', () => {
        store.recentEmoji = 'not a list';
        expect(emojiStore.readRecentEmoji()).toEqual([]);
        emojiStore.pushRecentEmoji({ e: '👍' });
        expect(store.recentEmoji).toEqual([{ e: '👍' }]);
    });

    test('a push of something that is not an emoji saves nothing', () => {
        emojiStore.pushRecentEmoji({ e: 'nope' });
        expect(persist).not.toHaveBeenCalled();
    });
});
