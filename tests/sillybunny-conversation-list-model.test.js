import { describe, expect, test } from '@jest/globals';

const {
    SECTION_CONVERSATIONS,
    SECTION_FAVORITES,
    adjacentSectionKey,
    buildListSections,
    describeConversationRow,
    describeFolderChange,
    describeHeaderSubtitle,
    describeSectionMove,
    folderIdOfSection,
    folderSectionKey,
    getEntrySectionKey,
    getReadToggle,
    getSectionKeys,
    getUnreadMarkerFor,
    planFolderChange,
    planSectionMove,
    resolveConversationName,
} = await import('../public/scripts/sillybunny-conversation/conversation-list-model.js');

const entry = (id, overrides = {}) => ({ id, name: id, favorite: false, folderId: '', muted: false, unread: 0, lastMessageRole: 'character', active: false, ...overrides });
const folder = (id, name = id, overrides = {}) => ({ id, name, color: '', expanded: true, ...overrides });
const ids = section => section.entries.map(row => row.id);
const byKey = (result, key) => result.sections.find(section => section.key === key);

describe('the sections of the list with no folder', () => {
    test('are Favorites and Conversations: a favourite goes to Favorites and the rest to Conversations, each in the order the data module gave', () => {
        const rows = [entry('a'), entry('b', { favorite: true }), entry('c'), entry('d', { favorite: true })];

        const result = buildListSections(rows);

        expect(result.sections.map(section => section.key)).toEqual(['favorites', 'conversations']);
        expect(ids(byKey(result, 'favorites'))).toEqual(['b', 'd']);
        expect(ids(byKey(result, 'conversations'))).toEqual(['a', 'c']);
        expect(result.searching).toBe(false);
    });

    test('Favorites is empty and not visible when nothing is a favourite, and Conversations is the whole list', () => {
        const result = buildListSections([entry('a'), entry('b')]);

        expect(byKey(result, 'favorites')).toMatchObject({ entries: [], visible: false, kind: 'favorites', collapsible: true });
        expect(ids(byKey(result, 'conversations'))).toEqual(['a', 'b']);
        expect(byKey(result, 'conversations')).toMatchObject({ visible: true, collapsible: false, expanded: true });
    });

    test('a query of spaces does not filter', () => {
        const result = buildListSections([entry('a', { favorite: true }), entry('b')], { query: '   ' });

        expect(result.searching).toBe(false);
        expect(ids(byKey(result, 'favorites'))).toEqual(['a']);
    });
});

describe('the sections of the list with folders', () => {
    const folders = [folder('f1', 'Work'), folder('f2', 'Friends', { expanded: false })];

    test('are Favorites, the folders in their stored order, and Conversations', () => {
        const result = buildListSections([entry('a')], { folders });

        expect(result.sections.map(section => section.key)).toEqual(['favorites', 'folder:f1', 'folder:f2', 'conversations']);
        expect(result.sections.map(section => section.kind)).toEqual(['favorites', 'folder', 'folder', 'conversations']);
        expect(byKey(result, 'folder:f2').folder).toEqual(folders[1]);
    });

    test('a row is in its folder, a row without one is in Conversations, and a favourite is only in Favorites whatever its folder', () => {
        const rows = [entry('a', { folderId: 'f1' }), entry('b'), entry('c', { favorite: true, folderId: 'f1' }), entry('d', { folderId: 'f2' }), entry('e', { folderId: 'f1' })];

        const result = buildListSections(rows, { folders });

        expect(ids(byKey(result, 'folder:f1'))).toEqual(['a', 'e']);
        expect(ids(byKey(result, 'folder:f2'))).toEqual(['d']);
        expect(ids(byKey(result, 'favorites'))).toEqual(['c']);
        expect(ids(byKey(result, 'conversations'))).toEqual(['b']);
    });

    test('a row that names a folder that is not in the list is in Conversations', () => {
        const result = buildListSections([entry('a', { folderId: 'gone' })], { folders });

        expect(ids(byKey(result, 'conversations'))).toEqual(['a']);
    });

    test('a folder shows while it is empty, and is open or closed as it is stored', () => {
        const result = buildListSections([], { folders });

        expect(byKey(result, 'folder:f1')).toMatchObject({ visible: true, expanded: true, collapsible: true, entries: [] });
        expect(byKey(result, 'folder:f2')).toMatchObject({ visible: true, expanded: false, collapsible: true });
    });

    test('Favorites is open or closed as it is stored', () => {
        expect(byKey(buildListSections([entry('a', { favorite: true })], { favoritesExpanded: false }), 'favorites')).toMatchObject({ expanded: false, visible: true });
        expect(byKey(buildListSections([entry('a', { favorite: true })]), 'favorites').expanded).toBe(true);
    });

    test('a section in openKeys shows open without being stored open, and Conversations needs no key', () => {
        const result = buildListSections([], { folders, favoritesExpanded: false, openKeys: ['folder:f2', 'favorites'] });

        expect(byKey(result, 'folder:f2').expanded).toBe(true);
        expect(byKey(result, 'favorites').expanded).toBe(true);
        expect(folders[1].expanded).toBe(false);
    });

    test('counts the unread of the rows a section holds, and leaves out muted conversations and the rows of other sections', () => {
        const rows = [entry('a', { folderId: 'f1', unread: 2 }), entry('b', { folderId: 'f1', unread: 5, muted: true }), entry('c', { folderId: 'f1', unread: 1, favorite: true }), entry('d', { unread: 4 })];

        const result = buildListSections(rows, { folders });

        expect(byKey(result, 'folder:f1').unread).toBe(2);
        expect(byKey(result, 'favorites').unread).toBe(1);
        expect(byKey(result, 'conversations').unread).toBe(4);
    });
});

describe('a search', () => {
    const folders = [folder('f1', 'Work', { expanded: false }), folder('f2', 'Friends'), folder('f3', 'Empty')];
    const rows = [
        entry('Seraphina', { folderId: 'f1' }),
        entry('Reisen', { favorite: true, folderId: 'f1' }),
        entry('Tewi', { favorite: true }),
        entry('Seraphina and Tewi', { folderId: 'f2' }),
        entry('Tewi Two'),
    ];

    test('groups the matches under their sections, a favourite in Favorites and not in its folder, and turns the drag off', () => {
        const result = buildListSections(rows, { query: 'TEWI', folders });

        expect(result.searching).toBe(true);
        expect(ids(byKey(result, 'favorites'))).toEqual(['Tewi']);
        expect(ids(byKey(result, 'folder:f2'))).toEqual(['Seraphina and Tewi']);
        expect(ids(byKey(result, 'conversations'))).toEqual(['Tewi Two']);
        expect(ids(byKey(result, 'folder:f1'))).toEqual([]);
    });

    test('shows only the sections that hold a match, open and with a heading that does not toggle, whatever is stored', () => {
        const result = buildListSections(rows, { query: 'sera', folders, favoritesExpanded: false });

        expect(result.sections.filter(section => section.visible).map(section => section.key)).toEqual(['folder:f1', 'folder:f2']);
        for (const section of result.sections) {
            expect(section.collapsible).toBe(false);
            expect(section.expanded).toBe(true);
        }
    });

    test('counts the unread of the matches only', () => {
        const result = buildListSections([entry('Work chat', { folderId: 'f1', unread: 3 }), entry('Other', { folderId: 'f1', unread: 9 })], { query: 'work', folders });

        expect(byKey(result, 'folder:f1').unread).toBe(3);
    });

    test('a query that matches nothing leaves every section not visible and still counts as a search', () => {
        const result = buildListSections([entry('a')], { query: 'zzz', folders });

        expect(result.searching).toBe(true);
        expect(result.sections.every(section => !section.visible && section.entries.length === 0)).toBe(true);
    });
});

describe('the keys of the sections', () => {
    test('of Favorites and Conversations are the strings that the page writes in data-section', () => {
        expect([SECTION_FAVORITES, SECTION_CONVERSATIONS]).toEqual(['favorites', 'conversations']);
    });

    test('are Favorites, the folders and Conversations in order, and a folder key gives its id back', () => {
        expect(getSectionKeys([folder('f1'), folder('f2')])).toEqual(['favorites', 'folder:f1', 'folder:f2', 'conversations']);
        expect(getSectionKeys([])).toEqual(['favorites', 'conversations']);
        expect(folderIdOfSection(folderSectionKey('f1'))).toBe('f1');
        expect(folderIdOfSection('favorites')).toBe('');
        expect(folderIdOfSection('conversations')).toBe('');
        expect(folderIdOfSection(undefined)).toBe('');
    });

    test('the section of a row is Favorites for a favourite whatever its folder, else its folder, else Conversations', () => {
        expect(getEntrySectionKey(entry('a', { favorite: true, folderId: 'f1' }))).toBe('favorites');
        expect(getEntrySectionKey(entry('a', { folderId: 'f1' }))).toBe('folder:f1');
        expect(getEntrySectionKey(entry('a'))).toBe('conversations');
    });
});

describe('a move between sections', () => {
    test('to Favorites sets the flag and keeps the folder, so that unfavouriting puts the row back', () => {
        expect(planSectionMove(entry('a', { folderId: 'f1' }), 'favorites')).toEqual({ favorite: true, folderId: 'f1' });
        expect(planSectionMove(entry('a'), 'favorites')).toEqual({ favorite: true, folderId: '' });
    });

    test('to a folder clears the flag and sets the folder, from Favorites, Conversations or another folder', () => {
        expect(planSectionMove(entry('a', { favorite: true, folderId: 'f9' }), 'folder:f1')).toEqual({ favorite: false, folderId: 'f1' });
        expect(planSectionMove(entry('a'), 'folder:f1')).toEqual({ favorite: false, folderId: 'f1' });
        expect(planSectionMove(entry('a', { folderId: 'f2' }), 'folder:f1')).toEqual({ favorite: false, folderId: 'f1' });
    });

    test('to Conversations clears the flag and the folder', () => {
        expect(planSectionMove(entry('a', { favorite: true, folderId: 'f1' }), 'conversations')).toEqual({ favorite: false, folderId: '' });
        expect(planSectionMove(entry('a', { folderId: 'f1' }), 'conversations')).toEqual({ favorite: false, folderId: '' });
    });

    test('changes nothing for a row that is there already, or for a key that is no section', () => {
        expect(planSectionMove(entry('a', { favorite: true }), 'favorites')).toBeNull();
        expect(planSectionMove(entry('a', { folderId: 'f1' }), 'folder:f1')).toBeNull();
        expect(planSectionMove(entry('a'), 'conversations')).toBeNull();
        expect(planSectionMove(entry('a'), 'nonsense')).toBeNull();
        expect(planSectionMove(entry('a'), 'folder:')).toBeNull();
    });
});

describe('Alt with an arrow key', () => {
    const keys = ['favorites', 'folder:f1', 'folder:f2', 'conversations'];

    test('goes to the section above or below, and Home and End to the first and the last', () => {
        expect(adjacentSectionKey(keys, 'folder:f1', -1)).toBe('favorites');
        expect(adjacentSectionKey(keys, 'folder:f1', 1)).toBe('folder:f2');
        expect(adjacentSectionKey(keys, 'folder:f2', 1)).toBe('conversations');
        expect(adjacentSectionKey(keys, 'conversations', -1)).toBe('folder:f2');
        expect(adjacentSectionKey(keys, 'folder:f2', -Infinity)).toBe('favorites');
        expect(adjacentSectionKey(keys, 'folder:f1', Infinity)).toBe('conversations');
    });

    test('from Favorites goes down to the first folder, and from Conversations goes up to the last folder', () => {
        expect(adjacentSectionKey(keys, 'favorites', 1)).toBe('folder:f1');
        expect(adjacentSectionKey(keys, 'favorites', Infinity)).toBe('conversations');
        expect(adjacentSectionKey(keys, 'conversations', -Infinity)).toBe('favorites');
    });

    test('declines at the ends: up from Favorites, down from Conversations, and Home or End from the section they name', () => {
        expect(adjacentSectionKey(keys, 'favorites', -1)).toBeNull();
        expect(adjacentSectionKey(keys, 'favorites', -Infinity)).toBeNull();
        expect(adjacentSectionKey(keys, 'conversations', 1)).toBeNull();
        expect(adjacentSectionKey(keys, 'conversations', Infinity)).toBeNull();
    });

    test('with no folder, up and down are Favorites and Conversations as they always were', () => {
        const plain = getSectionKeys([]);

        expect(adjacentSectionKey(plain, 'conversations', -1)).toBe('favorites');
        expect(adjacentSectionKey(plain, 'favorites', 1)).toBe('conversations');
    });

    test('declines for a section that is not in the list', () => {
        expect(adjacentSectionKey(keys, 'folder:gone', 1)).toBeNull();
    });
});

describe('the words that announce a move', () => {
    const folders = [folder('f1', 'Work')];

    test('into Favorites, out of Favorites, into a folder and into Conversations', () => {
        expect(describeSectionMove(entry('Tewi'), { favorite: true, folderId: '' }, folders)).toBe('Tewi added to Favorites');
        expect(describeSectionMove(entry('Tewi', { favorite: true }), { favorite: false, folderId: '' }, folders)).toBe('Tewi removed from Favorites');
        expect(describeSectionMove(entry('Tewi'), { favorite: false, folderId: 'f1' }, folders)).toBe('Tewi moved to Work');
        expect(describeSectionMove(entry('Tewi', { favorite: true }), { favorite: false, folderId: 'f1' }, folders)).toBe('Tewi moved to Work');
        expect(describeSectionMove(entry('Tewi', { folderId: 'f1' }), { favorite: false, folderId: '' }, folders)).toBe('Tewi moved to Conversations');
    });
});

describe('a change of the folder alone', () => {
    const folders = [folder('f1', 'Work')];

    test('changes only the folder, and nothing when the row has it already', () => {
        expect(planFolderChange(entry('a'), 'f1')).toEqual({ folderId: 'f1' });
        expect(planFolderChange(entry('a', { folderId: 'f1' }), '')).toEqual({ folderId: '' });
        expect(planFolderChange(entry('a', { folderId: 'f1' }), 'f1')).toBeNull();
    });

    test('says that a favourite stays in Favorites, so that the user knows why the row did not move', () => {
        expect(describeFolderChange(entry('Tewi', { favorite: true }), 'f1', folders)).toBe('Tewi moved to Work, and stays in Favorites');
        expect(describeFolderChange(entry('Tewi', { favorite: true }), '', folders)).toBe('Tewi moved out of its folder, and stays in Favorites');
        expect(describeFolderChange(entry('Tewi'), 'f1', folders)).toBe('Tewi moved to Work');
        expect(describeFolderChange(entry('Tewi', { folderId: 'f1' }), '', folders)).toBe('Tewi moved to Conversations');
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
