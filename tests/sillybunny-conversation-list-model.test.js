import { describe, expect, test } from '@jest/globals';

const {
    SECTION_CONVERSATIONS,
    SECTION_FAVORITES,
    buildListSections,
    describeConversationRow,
    describeHeaderSubtitle,
    getReadToggle,
    getSectionForMove,
    getUnreadMarkerFor,
    isFavoriteSection,
    resolveConversationName,
} = await import('../public/scripts/sillybunny-conversation/conversation-list-model.js');

const entry = (id, overrides = {}) => ({ id, name: id, favorite: false, muted: false, unread: 0, lastMessageRole: 'character', active: false, ...overrides });

describe('the sections of the list', () => {
    test('a favourite goes to Favorites and the rest to Conversations, each in the order the data module gave', () => {
        const rows = [entry('a'), entry('b', { favorite: true }), entry('c'), entry('d', { favorite: true })];

        const sections = buildListSections(rows);

        expect(sections.favorites.map(row => row.id)).toEqual(['b', 'd']);
        expect(sections.conversations.map(row => row.id)).toEqual(['a', 'c']);
        expect(sections.searching).toBe(false);
    });

    test('Favorites is empty when nothing is a favourite, and Conversations is the whole list', () => {
        const sections = buildListSections([entry('a'), entry('b')]);

        expect(sections.favorites).toEqual([]);
        expect(sections.conversations).toHaveLength(2);
    });

    test('a search that filters shows the matches in one list, favourites included, and turns the drag off', () => {
        const rows = [entry('Seraphina'), entry('Reisen', { favorite: true }), entry('Tewi', { favorite: true }), entry('Seraphina and Tewi')];

        const sections = buildListSections(rows, { query: 'TEWI' });

        expect(sections.searching).toBe(true);
        expect(sections.favorites).toEqual([]);
        expect(sections.conversations.map(row => row.id)).toEqual(['Tewi', 'Seraphina and Tewi']);
    });

    test('a query of spaces does not filter', () => {
        const rows = [entry('a', { favorite: true }), entry('b')];

        const sections = buildListSections(rows, { query: '   ' });

        expect(sections.searching).toBe(false);
        expect(sections.favorites).toHaveLength(1);
    });

    test('a query that matches nothing leaves both sections empty and still counts as a search', () => {
        const sections = buildListSections([entry('a')], { query: 'zzz' });

        expect(sections).toEqual({ searching: true, favorites: [], conversations: [] });
    });
});

describe('a move between sections', () => {
    test('up and to the first place go to Favorites, down and to the last place go to Conversations', () => {
        expect(getSectionForMove(-1)).toBe(SECTION_FAVORITES);
        expect(getSectionForMove(-Infinity)).toBe(SECTION_FAVORITES);
        expect(getSectionForMove(1)).toBe(SECTION_CONVERSATIONS);
        expect(getSectionForMove(Infinity)).toBe(SECTION_CONVERSATIONS);
    });

    test('only the Favorites section means a favourite', () => {
        expect(isFavoriteSection(SECTION_FAVORITES)).toBe(true);
        expect(isFavoriteSection(SECTION_CONVERSATIONS)).toBe(false);
    });
});

describe('the name of a row for assistive technology', () => {
    test('says the name alone for a row with nothing to report', () => {
        expect(describeConversationRow(entry('Reisen'))).toBe('Reisen');
    });

    test('adds the unread count and the muted state', () => {
        expect(describeConversationRow(entry('Reisen', { unread: 3, muted: true }))).toBe('Reisen, 3 Unread, Muted');
        expect(describeConversationRow(entry('Reisen', { muted: true }))).toBe('Reisen, Muted');
    });
});

describe('Mark as Read or Unread', () => {
    test('a row with unread messages offers Mark as Read', () => {
        expect(getReadToggle(entry('a', { unread: 2 }))).toBe('read');
    });

    test('a row that is read and ends with a message from a character offers Mark as Unread', () => {
        expect(getReadToggle(entry('a', { lastMessageRole: 'character' }))).toBe('unread');
        expect(getReadToggle(entry('a', { lastMessageRole: 'member' }))).toBe('unread');
    });

    test('a read row that ends with the user, a system line or nothing offers neither, because there is no message to mark', () => {
        expect(getReadToggle(entry('a', { lastMessageRole: 'user' }))).toBeNull();
        expect(getReadToggle(entry('a', { lastMessageRole: 'system' }))).toBeNull();
        expect(getReadToggle(entry('a', { lastMessageRole: '' }))).toBeNull();
    });

    test('the conversation that is open is read as it is shown, so it offers no Mark as Unread', () => {
        expect(getReadToggle(entry('a', { active: true }))).toBeNull();
        expect(getReadToggle(entry('a', { active: true, unread: 1 }))).toBe('read');
    });
});

describe('the read marker that makes the last message unread', () => {
    const message = (id, role = 'character') => ({ id, role, mes: id });

    test('is the id of the message before the last one', () => {
        expect(getUnreadMarkerFor([message('m1', 'user'), message('m2'), message('m3')])).toEqual({ readThrough: 'm2' });
    });

    test('is empty when the last message is the first, so that the chat reads as unread from its start', () => {
        expect(getUnreadMarkerFor([message('m1')])).toEqual({ readThrough: '' });
    });

    test('skips a reply that the server wrote and no page has split yet, as Mark as Read does', () => {
        const pending = { id: 'p1', role: 'character', mes: 'raw', extra: { server_generation: { pending: true } } };

        expect(getUnreadMarkerFor([message('m1'), message('m2'), pending])).toEqual({ readThrough: 'm1' });
    });

    test('gives nothing when the last message is the user\'s or a system line, or the chat is empty', () => {
        expect(getUnreadMarkerFor([message('m1'), message('m2', 'user')])).toBeNull();
        expect(getUnreadMarkerFor([message('m1'), { id: 'm2', role: 'system', mes: 'x' }])).toBeNull();
        expect(getUnreadMarkerFor([])).toBeNull();
    });
});

describe('the name of a conversation, which the list and the header both show', () => {
    test('a conversation that has a name shows it, whatever its members are called', () => {
        expect(resolveConversationName({ name: 'Weekend plans', isGroup: true, memberNames: ['Tewi', 'Reisen'], characterName: 'Tewi' })).toBe('Weekend plans');
    });

    test('a group without a name shows its members\' names, in the order of the group', () => {
        expect(resolveConversationName({ name: '', isGroup: true, memberNames: ['Tewi', 'Reisen', 'Seraphina'], characterName: 'Tewi' })).toBe('Tewi, Reisen, Seraphina');
    });

    test('a direct conversation without a name shows the character, not the name of its active chat', () => {
        expect(resolveConversationName({ name: '', isGroup: false, memberNames: ['Tewi'], characterName: 'Tewi' })).toBe('Tewi');
    });

    test('a group that lists no member falls back to its character, and a card with no name to "Character"', () => {
        expect(resolveConversationName({ name: '', isGroup: true, memberNames: [], characterName: 'Tewi' })).toBe('Tewi');
        expect(resolveConversationName({ name: '', isGroup: false, memberNames: [], characterName: '' })).toBe('Character');
    });
});

describe('the line under the name in the header', () => {
    const online = { label: 'Online', activity: '', delayed: false };

    test('a group shows its description, and nothing when it has none', () => {
        expect(describeHeaderSubtitle({ isGroup: true, description: 'Planning the trip', status: online })).toBe('Planning the trip');
        expect(describeHeaderSubtitle({ isGroup: true, description: '  ', status: online })).toBe('');
    });

    test('a direct conversation shows the status of the character, with what the character is doing', () => {
        expect(describeHeaderSubtitle({ isGroup: false, status: online })).toBe('Online');
        expect(describeHeaderSubtitle({ isGroup: false, status: { label: 'Idle', activity: 'free time', delayed: false } })).toBe('Idle · free time');
    });

    test('a status that delays replies says so after the activity', () => {
        expect(describeHeaderSubtitle({ isGroup: false, status: { label: 'Do Not Disturb', activity: 'in a meeting', delayed: true } })).toBe('Do Not Disturb · in a meeting · replies may be delayed');
    });

    test('someone who is writing replaces the line, for one, two and more people', () => {
        expect(describeHeaderSubtitle({ isGroup: false, typingNames: ['Tewi'], status: online })).toBe('Tewi Is Writing…');
        expect(describeHeaderSubtitle({ isGroup: true, typingNames: ['Tewi', 'Reisen'], description: 'Trip', status: online })).toBe('Tewi, Reisen Are Writing…');
        expect(describeHeaderSubtitle({ isGroup: true, typingNames: ['A', 'B', 'C'], description: 'Trip', status: online })).toBe('Several People Are Typing…');
    });

    test('a conversation with no status to show has no line', () => {
        expect(describeHeaderSubtitle({ isGroup: false, status: null })).toBe('');
    });
});
