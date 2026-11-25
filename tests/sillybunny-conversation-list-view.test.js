/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Playwright does not recognize Jest test callbacks. */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    renderConversationParticipantStack: jest.fn((container, participants) => {
        container.textContent = participants.map(participant => participant.name).join('+');
    }),
}));

/** The shared motion of the folder lists, recorded: `ends` holds the `onEnd` of each close, which a test runs when the motion is over. */
const motion = { calls: [], ends: [] };
const animateFolderBody = jest.fn((body, expanding, { onEnd = null } = {}) => {
    motion.calls.push({ body, expanding, rows: body.childElementCount });
    if (!expanding && onEnd) {
        motion.ends.push(onEnd);
    }
    return {};
});
await jest.unstable_mockModule('../public/scripts/sillybunny-editor/folder-body-motion.js', () => ({ animateFolderBody }));

const view = await import('../public/scripts/sillybunny-conversation/conversation-list-view.js');

const entry = (id, overrides = {}) => ({
    id,
    name: `Name ${id}`,
    favorite: false,
    muted: false,
    unread: 0,
    badge: '',
    preview: `Preview ${id}`,
    lastMessageRole: 'character',
    active: false,
    folderId: '',
    avatar: `${id}.png`,
    characterIndex: '0',
    groupId: '',
    participants: [{ avatar: `${id}.png`, name: `Name ${id}` }],
    status: 'online',
    ...overrides,
});

let list;

const rowIds = section => [...list.querySelectorAll(`[data-section="${section}"] .sb-conversation-list-row`)].map(row => row.dataset.conversationId);
const folder = (id, name = id, overrides = {}) => ({ id, name, color: '', expanded: true, ...overrides });
const layoutOf = (folders = [], favoritesExpanded = true) => ({ folders, favoritesExpanded });
const render = (entries, layout = layoutOf()) => view.renderConversationListView(list, entries, layout);
const sectionKeys = () => [...list.querySelectorAll('.sb-conversation-list-section')].map(section => section.dataset.section);
const heading = key => list.querySelector(`[data-section="${key}"] .sb-conversation-list-heading-button`);

beforeEach(() => {
    document.body.replaceChildren();
    list = document.createElement('div');
    document.body.append(list);
    view.setConversationListQuery('');
    view.clearTemporaryOpen();
    motion.calls.length = 0;
    motion.ends.length = 0;
    animateFolderBody.mockClear();
});

describe('drawing the sections', () => {
    test('puts each row in its section in the given order and hides Favorites while it is empty', () => {
        render([entry('a'), entry('b', { favorite: true }), entry('c')]);

        expect(rowIds('favorites')).toEqual(['b']);
        expect(rowIds('conversations')).toEqual(['a', 'c']);
        expect(list.querySelector('[data-section="favorites"]').dataset.empty).toBe('false');

        render([entry('a'), entry('c')]);
        expect(list.querySelector('[data-section="favorites"]').dataset.empty).toBe('true');
        expect(list.dataset.hasFavorites).toBe('false');
    });

    test('names the sections Favorites and Conversations, and the rows by their conversation id', () => {
        render([entry('a')]);

        expect([...list.querySelectorAll('.sb-conversation-list-heading-label')].map(label => label.textContent)).toEqual(['Favorites', 'Conversations']);
        expect(list.querySelector('.sb-conversation-list-row').dataset.sbListKey).toBe('a');
    });

    test('shows no mark for a group, only the name, the preview and the unread badge', () => {
        render([entry('a', { groupId: 'g1', unread: 3, badge: '3', preview: 'Hello there' })]);

        const button = list.querySelector('.sb-conversation-list-item');
        expect(button.querySelector('.sb-conversation-list-item-kind')).toBeNull();
        expect(button.querySelector('.sb-conversation-list-item-name').textContent).toBe('Name a');
        expect(button.querySelector('.sb-conversation-list-item-preview').textContent).toBe('Hello there');
        expect(button.querySelector('.sb-conversation-list-item-unread').textContent).toBe('3');
        expect(button.querySelector('.sb-conversation-list-item-unread').hidden).toBe(false);
        expect(button.getAttribute('aria-label')).toBe('Name a, 3 Unread');
    });

    test('a row with nothing to report has no label of its own, so its preview is read with its name', () => {
        render([entry('a')]);

        const button = list.querySelector('.sb-conversation-list-item');
        expect(button.hasAttribute('aria-label')).toBe(false);
        expect(button.querySelector('.sb-conversation-list-item-unread').hidden).toBe(true);
        expect(button.querySelector('.sb-conversation-list-item-muted').hidden).toBe(true);
    });

    test('marks a muted row with a bell and the word in its label', () => {
        render([entry('a', { muted: true })]);

        const button = list.querySelector('.sb-conversation-list-item');
        expect(button.querySelector('.sb-conversation-list-item-muted').hidden).toBe(false);
        expect(button.getAttribute('aria-label')).toBe('Name a, Muted');
    });

    test('marks the open conversation with aria-current on its button and a class on its row', () => {
        render([entry('a'), entry('b', { active: true })]);

        expect(list.querySelector('[data-conversation-id="b"] .sb-conversation-list-item').getAttribute('aria-current')).toBe('true');
        expect(list.querySelector('[data-conversation-id="a"] .sb-conversation-list-item').getAttribute('aria-current')).toBe('false');
        expect(list.querySelector('[data-conversation-id="b"]').classList.contains('is-selected')).toBe(true);
    });
});

describe('keeping the nodes of the rows', () => {
    test('a row that moves to the other section is the same node, and the list does not rebuild the others', () => {
        render([entry('a'), entry('b'), entry('c')]);
        const nodes = Object.fromEntries(['a', 'b', 'c'].map(id => [id, list.querySelector(`[data-conversation-id="${id}"]`)]));

        render([entry('a'), entry('b', { favorite: true }), entry('c')]);

        expect(rowIds('favorites')).toEqual(['b']);
        expect(rowIds('conversations')).toEqual(['a', 'c']);
        for (const id of ['a', 'b', 'c']) {
            expect(list.querySelector(`[data-conversation-id="${id}"]`)).toBe(nodes[id]);
        }
    });

    test('a row that moves to the first place of its section is the same node', () => {
        render([entry('a'), entry('b')]);
        const b = list.querySelector('[data-conversation-id="b"]');

        render([entry('b'), entry('a')]);

        expect(rowIds('conversations')).toEqual(['b', 'a']);
        expect(list.querySelector('[data-conversation-id="b"]')).toBe(b);
    });

    test('keeps focus on a control whose row moved between sections', () => {
        render([entry('a'), entry('b')]);
        const button = list.querySelector('[data-conversation-id="b"] .sb-conversation-list-item');
        button.focus();
        expect(document.activeElement).toBe(button);

        render([entry('a'), entry('b', { favorite: true })]);

        expect(list.querySelector('[data-section="favorites"]').contains(button)).toBe(true);
        expect(document.activeElement).toBe(button);
    });

    test('removes the row of a conversation that is gone, and leaves the others alone', () => {
        render([entry('a'), entry('b')]);
        const a = list.querySelector('[data-conversation-id="a"]');

        render([entry('a')]);

        expect(list.querySelector('[data-conversation-id="b"]')).toBeNull();
        expect(list.querySelector('[data-conversation-id="a"]')).toBe(a);
    });

    test('never clears the list with textContent, so the sections themselves stay', () => {
        render([entry('a')]);
        const sections = [...list.querySelectorAll('.sb-conversation-list-section')];

        render([entry('a'), entry('b')]);

        expect([...list.querySelectorAll('.sb-conversation-list-section')]).toEqual(sections);
    });

    test('draws the participants again only when they change', () => {
        render([entry('a')]);
        const stack = list.querySelector('.sb-conversation-list-item-avatar');
        stack.dataset.probe = 'kept';
        stack.textContent = 'marker';

        render([entry('a', { preview: 'new preview' })]);
        expect(stack.textContent).toBe('marker');

        render([entry('a', { participants: [{ avatar: 'a.png', name: 'Name a' }, { avatar: 'z.png', name: 'Zed' }] })]);
        expect(stack.textContent).toBe('Name a+Zed');
    });
});

describe('Favorites collapsing', () => {
    test('a collapsed section says so, and its heading carries the unread total of its unmuted rows', () => {
        render([entry('a', { favorite: true, unread: 2 }), entry('b', { favorite: true, unread: 5, muted: true }), entry('c')], layoutOf([], false));

        const button = list.querySelector('.sb-conversation-list-heading-button');
        expect(button.getAttribute('aria-expanded')).toBe('false');
        expect(list.querySelector('[data-section="favorites"]').dataset.collapsed).toBe('true');
        const badge = button.querySelector('.sb-conversation-list-heading-badge');
        expect(badge.hidden).toBe(false);
        expect(badge.firstChild.textContent).toBe('2');
        expect(badge.querySelector('.sr-only').textContent).toBe(' unread');
        expect(rowIds('favorites')).toEqual([]);
    });

    test('a section that is open for now shows its rows although it is stored closed, and the render is told by the view key', () => {
        const before = view.getConversationListViewKey();

        expect(view.setTemporaryOpen('favorites', true)).toBe(true);
        expect(view.setTemporaryOpen('favorites', true)).toBe(false);
        render([entry('a', { favorite: true })], layoutOf([], false));

        expect(rowIds('favorites')).toEqual(['a']);
        expect(view.getConversationListViewKey()).not.toBe(before);
        expect(view.getTemporaryOpenKeys()).toEqual(['favorites']);
        expect(view.clearTemporaryOpen()).toBe(true);
        expect(view.clearTemporaryOpen()).toBe(false);
        render([entry('a', { favorite: true })], layoutOf([], false));
        // The rows leave when the close motion ends.
        motion.ends.at(-1)();
        expect(rowIds('favorites')).toEqual([]);
    });

    test('an open section shows no badge on its heading', () => {
        render([entry('a', { favorite: true, unread: 2 })]);

        expect(list.querySelector('.sb-conversation-list-heading-badge').hidden).toBe(true);
        expect(list.querySelector('.sb-conversation-list-heading-button').getAttribute('aria-expanded')).toBe('true');
    });
});

describe('the folders', () => {
    const folders = [folder('f1', 'Work', { color: '#abc' }), folder('f2', 'Friends')];

    test('are sections between Favorites and Conversations, in the stored order, each with its heading, its dot and its count', () => {
        render([entry('a', { folderId: 'f1' }), entry('b', { folderId: 'f1' }), entry('c')], layoutOf(folders));

        expect(sectionKeys()).toEqual(['favorites', 'folder:f1', 'folder:f2', 'conversations']);
        expect([...list.querySelectorAll('.sb-conversation-list-heading-label')].map(label => label.textContent)).toEqual(['Favorites', 'Work', 'Friends', 'Conversations']);
        expect(rowIds('folder:f1')).toEqual(['a', 'b']);
        expect(rowIds('folder:f2')).toEqual([]);
        expect(rowIds('conversations')).toEqual(['c']);
        expect(list.querySelector('[data-section="folder:f1"] .sb-conversation-list-heading-count').textContent).toBe('2');
        expect(list.querySelector('[data-section="folder:f2"] .sb-conversation-list-heading-count').textContent).toBe('0');
        expect(list.querySelector('[data-section="folder:f1"] .sb-conversation-list-folder-dot').style.getPropertyValue('--sb-folder-color')).toBe('#abc');
        expect(list.querySelector('[data-section="folder:f2"] .sb-conversation-list-folder-dot').style.getPropertyValue('--sb-folder-color')).toBe('');
    });

    test('have a heading that is a button of the roving list, named by the folder and keyed by its section', () => {
        render([], layoutOf(folders));

        expect(heading('folder:f1').getAttribute('aria-expanded')).toBe('true');
        expect(heading('folder:f1').closest('.sb-conversation-list-heading').dataset.sbListKey).toBe('heading:folder:f1');
        expect(heading('folder:f1').closest('.sb-conversation-list-heading').getAttribute('aria-level')).toBe('2');
        expect(heading('conversations')).toBeNull();
        expect(list.querySelector('[data-section="folder:f1"] .sb-conversation-list-rows').getAttribute('aria-label')).toBe('Work');
    });

    test('show while they are empty, and Favorites and Conversations hide while they are empty and rows are elsewhere', () => {
        render([entry('a', { folderId: 'f1' })], layoutOf(folders));

        expect(list.querySelector('[data-section="folder:f2"]').dataset.empty).toBe('true');
        expect(list.querySelector('[data-section="folder:f2"]').dataset.hideEmpty).toBe('false');
        expect(list.querySelector('[data-section="favorites"]').dataset.hideEmpty).toBe('true');
        expect(list.querySelector('[data-section="conversations"]').dataset.empty).toBe('true');
        expect(list.querySelector('[data-section="conversations"]').dataset.hideEmpty).toBe('true');
    });

    test('Conversations keeps showing when the list has no row at all, for the status page that it holds', () => {
        render([], layoutOf(folders));

        expect(list.querySelector('[data-section="conversations"]').dataset.hideEmpty).toBe('false');
        expect(list.querySelector('.sb-conversation-list-empty').hidden).toBe(false);
    });

    test('name the drop zone of each section in the hint that a drag shows', () => {
        render([], layoutOf(folders));

        const hints = [...list.querySelectorAll('.sb-conversation-list-zone-hint')].map(hint => hint.textContent);
        expect(hints).toEqual(['Drop here to add to Favorites', 'Drop here to add to Work', 'Drop here to add to Friends', 'Drop here to remove from its folder']);
    });

    test('a row that moves from one folder to another, or to Favorites, is the same node, and keeps focus', () => {
        render([entry('a', { folderId: 'f1' }), entry('b')], layoutOf(folders));
        const a = list.querySelector('[data-conversation-id="a"]');
        const button = a.querySelector('.sb-conversation-list-item');
        button.focus();

        render([entry('a', { folderId: 'f2' }), entry('b')], layoutOf(folders));
        expect(rowIds('folder:f2')).toEqual(['a']);
        expect(list.querySelector('[data-conversation-id="a"]')).toBe(a);
        expect(document.activeElement).toBe(button);

        render([entry('a', { folderId: 'f2', favorite: true }), entry('b')], layoutOf(folders));
        expect(rowIds('favorites')).toEqual(['a']);
        expect(rowIds('folder:f2')).toEqual([]);
        expect(list.querySelector('[data-conversation-id="a"]')).toBe(a);
        expect(document.activeElement).toBe(button);
    });

    test('a favourite that keeps its folder goes back to the folder when it is not a favourite any more', () => {
        render([entry('a', { favorite: true, folderId: 'f1' })], layoutOf(folders));
        expect(rowIds('folder:f1')).toEqual([]);

        render([entry('a', { favorite: false, folderId: 'f1' })], layoutOf(folders));

        expect(rowIds('folder:f1')).toEqual(['a']);
        expect(rowIds('favorites')).toEqual([]);
    });

    test('a closed folder has no rows in the document, keeps their nodes, and carries the unread count of the rows it holds', () => {
        const closed = [folder('f1', 'Work', { expanded: false })];
        render([entry('a', { folderId: 'f1', unread: 2 }), entry('b', { folderId: 'f1', unread: 3, muted: true }), entry('c', { folderId: 'f1' })], layoutOf(closed));

        expect(rowIds('folder:f1')).toEqual([]);
        expect(list.querySelector('[data-section="folder:f1"]').dataset.collapsed).toBe('true');
        expect(heading('folder:f1').getAttribute('aria-expanded')).toBe('false');
        const badge = heading('folder:f1').querySelector('.sb-conversation-list-heading-badge');
        expect(badge.hidden).toBe(false);
        expect(badge.firstChild.textContent).toBe('2');
        expect(heading('folder:f1').querySelector('.sb-conversation-list-heading-count').textContent).toBe('3');

        render([entry('a', { folderId: 'f1', unread: 2 }), entry('b', { folderId: 'f1', unread: 3, muted: true }), entry('c', { folderId: 'f1' })], layoutOf([folder('f1', 'Work')]));
        expect(rowIds('folder:f1')).toEqual(['a', 'b', 'c']);
        expect(heading('folder:f1').querySelector('.sb-conversation-list-heading-badge').hidden).toBe(true);
    });

    test('keep the node of a row across the close and the open of their folder', () => {
        const entries = [entry('a', { folderId: 'f1' })];
        render(entries, layoutOf([folder('f1')]));
        const a = list.querySelector('[data-conversation-id="a"]');

        render(entries, layoutOf([folder('f1', 'f1', { expanded: false })]));
        render(entries, layoutOf([folder('f1')]));

        expect(list.querySelector('[data-conversation-id="a"]')).toBe(a);
    });

    test('draw again when a folder is renamed or recoloured, and the section of a deleted folder leaves with it', () => {
        render([entry('a', { folderId: 'f1' })], layoutOf(folders));
        const section = list.querySelector('[data-section="folder:f2"]');

        render([entry('a', { folderId: 'f1' })], layoutOf([folder('f1', 'Renamed', { color: '#fff' })]));

        expect(sectionKeys()).toEqual(['favorites', 'folder:f1', 'conversations']);
        expect(section.isConnected).toBe(false);
        expect(heading('folder:f1').querySelector('.sb-conversation-list-heading-label').textContent).toBe('Renamed');
        expect(list.querySelector('[data-section="folder:f1"] .sb-conversation-list-folder-dot').style.getPropertyValue('--sb-folder-color')).toBe('#fff');
    });

    test('put the rows of a deleted folder in Conversations, as the same nodes', () => {
        render([entry('a', { folderId: 'f1' })], layoutOf(folders));
        const a = list.querySelector('[data-conversation-id="a"]');

        render([entry('a')], layoutOf([folder('f2')]));

        expect(rowIds('conversations')).toEqual(['a']);
        expect(list.querySelector('[data-conversation-id="a"]')).toBe(a);
    });

    test('keep the focus of a heading when the folders change around it', () => {
        render([], layoutOf(folders));
        const button = heading('folder:f2');
        button.focus();

        render([entry('a')], layoutOf([folder('f0'), ...folders]));

        expect(sectionKeys()).toEqual(['favorites', 'folder:f0', 'folder:f1', 'folder:f2', 'conversations']);
        expect(document.activeElement).toBe(button);
    });

    test('a section that is open for now shows its rows although its folder is stored closed', () => {
        view.setTemporaryOpen('folder:f1', true);

        render([entry('a', { folderId: 'f1' })], layoutOf([folder('f1', 'Work', { expanded: false })]));

        expect(rowIds('folder:f1')).toEqual(['a']);
        expect(heading('folder:f1').getAttribute('aria-expanded')).toBe('true');
    });
});

describe('a search', () => {
    const folders = [folder('f1', 'Work', { expanded: false }), folder('f2', 'Friends')];
    const entries = () => [
        entry('a', { name: 'Seraphina', folderId: 'f1' }),
        entry('b', { name: 'Reisen', favorite: true, folderId: 'f1' }),
        entry('c', { name: 'Tewi' }),
        entry('d', { name: 'Tewi Two', folderId: 'f1' }),
    ];

    test('groups the matches under their sections, opens the folder that has one, hides the sections that have none and leaves the other rows out of the document without destroying them', () => {
        render(entries(), layoutOf(folders));
        const reisen = list.querySelector('[data-conversation-id="b"]');

        view.setConversationListQuery('tewi');
        render(entries(), layoutOf(folders));

        expect(list.dataset.searching).toBe('true');
        expect(rowIds('favorites')).toEqual([]);
        expect(rowIds('folder:f1')).toEqual(['d']);
        expect(rowIds('conversations')).toEqual(['c']);
        expect(heading('folder:f1').getAttribute('aria-expanded')).toBe('true');
        expect(heading('folder:f1').dataset.collapsible).toBe('false');
        expect(heading('folder:f1').querySelector('.sb-conversation-list-heading-count').textContent).toBe('1');
        expect(list.querySelector('[data-section="folder:f2"]').dataset.hideEmpty).toBe('true');
        expect(list.querySelector('[data-section="favorites"]').dataset.hideEmpty).toBe('true');
        expect(list.querySelector('[data-conversation-id="a"]')).toBeNull();

        view.setConversationListQuery('');
        render(entries(), layoutOf(folders));
        expect(rowIds('favorites')).toEqual(['b']);
        expect(list.querySelector('[data-conversation-id="b"]')).toBe(reisen);
        expect(rowIds('folder:f1')).toEqual([]);
        expect(rowIds('conversations')).toEqual(['c']);
        expect(heading('folder:f1').dataset.collapsible).toBe('true');
    });

    test('puts a favourite that matches in Favorites and not in its folder', () => {
        view.setConversationListQuery('rei');
        render(entries(), layoutOf(folders));

        expect(rowIds('favorites')).toEqual(['b']);
        expect(rowIds('folder:f1')).toEqual([]);
        expect(heading('favorites').getAttribute('aria-expanded')).toBe('true');
    });

    test('shows no unread badge on a heading while it filters, because every section it shows is open', () => {
        view.setConversationListQuery('sera');
        render([entry('a', { name: 'Seraphina', folderId: 'f1', unread: 4 })], layoutOf(folders));

        expect(heading('folder:f1').querySelector('.sb-conversation-list-heading-badge').hidden).toBe(true);
    });

    test('says so when nothing matches, shows no empty folder, and invites a first conversation when there are none', () => {
        render([entry('a', { name: 'Seraphina' })], layoutOf(folders));
        view.setConversationListQuery('zzz');
        render([entry('a', { name: 'Seraphina' })], layoutOf(folders));
        expect(list.querySelector('.sb-conversation-list-empty').hidden).toBe(false);
        expect(list.querySelector('.sb-conversation-list-empty .sb-status-page__title').textContent).toBe('No Conversations Found');
        expect(list.querySelector('[data-section="conversations"]').dataset.hideEmpty).toBe('false');
        for (const key of ['favorites', 'folder:f1', 'folder:f2']) {
            expect(list.querySelector(`[data-section="${key}"]`).dataset.hideEmpty).toBe('true');
        }

        view.setConversationListQuery('');
        render([], layoutOf(folders));
        expect(list.querySelector('.sb-conversation-list-empty .sb-status-page__title').textContent).toBe('Use + to Start a Conversation');

        render([entry('a')], layoutOf(folders));
        expect(list.querySelector('.sb-conversation-list-empty').hidden).toBe(true);
    });
});

describe('a moved row that is out of sight', () => {
    test('is scrolled into view once, as the highlight starts, and not on the draws that follow', () => {
        const scrollIntoView = jest.fn();
        const original = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = scrollIntoView;
        jest.useFakeTimers();
        try {
            render([entry('a'), entry('b')]);
            view.highlightMovedRow(list, 'b');

            render([entry('a'), entry('b', { favorite: true })]);
            render([entry('a'), entry('b', { favorite: true, preview: 'changed' })]);

            expect(scrollIntoView).toHaveBeenCalledTimes(1);
            expect(scrollIntoView.mock.contexts[0]).toBe(list.querySelector('[data-conversation-id="b"]'));
            expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
        } finally {
            jest.advanceTimersByTime(2000);
            jest.useRealTimers();
            Element.prototype.scrollIntoView = original;
        }
    });
});

describe('the highlight of a moved row', () => {
    test('marks the row and takes the mark off again by itself', () => {
        jest.useFakeTimers();
        try {
            render([entry('a'), entry('b')]);

            view.highlightMovedRow(list, 'b');
            expect(list.querySelector('[data-conversation-id="b"]').classList.contains('is-just-moved')).toBe(true);
            expect(view.getConversationListViewKey()).toContain('b');

            jest.advanceTimersByTime(2000);
            expect(list.querySelector('.is-just-moved')).toBeNull();
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('the motion of a section that opens or closes', () => {
    const open = [folder('f1', 'Work')];
    const closed = [folder('f1', 'Work', { expanded: false })];
    const rows = () => [entry('a', { folderId: 'f1' }), entry('b', { folderId: 'f1' })];
    const rowsOf = key => list.querySelector(`[data-section="${key}"] .sb-conversation-list-rows`);

    test('plays none when the list is drawn for the first time, whether a folder is open or closed', () => {
        render(rows(), layoutOf([folder('f1', 'Work'), folder('f2', 'Friends', { expanded: false })]));

        expect(animateFolderBody).not.toHaveBeenCalled();
    });

    test('plays none for a draw that changes no section, such as a new message or a rename', () => {
        render(rows(), layoutOf(open));
        render([entry('c', { folderId: 'f1' }), ...rows()], layoutOf([folder('f1', 'Renamed')]));

        expect(animateFolderBody).not.toHaveBeenCalled();
    });

    test('opening a folder puts its rows in place first and then plays the shared motion on the section\'s rows', () => {
        render(rows(), layoutOf(closed));
        expect(rowIds('folder:f1')).toEqual([]);

        render(rows(), layoutOf(open));

        expect(motion.calls).toEqual([{ body: rowsOf('folder:f1'), expanding: true, rows: 2 }]);
        expect(heading('folder:f1').getAttribute('aria-expanded')).toBe('true');
        expect(list.querySelector('[data-section="folder:f1"]').dataset.closing).toBeUndefined();
    });

    test('closing a folder keeps its rows on screen until the motion ends, tells the style sheet, and then takes them out of the document', () => {
        render(rows(), layoutOf(open));

        render(rows(), layoutOf(closed));

        const section = list.querySelector('[data-section="folder:f1"]');
        expect(motion.calls).toEqual([{ body: rowsOf('folder:f1'), expanding: false, rows: 2 }]);
        expect(rowIds('folder:f1')).toEqual(['a', 'b']);
        expect(section.dataset.collapsed).toBe('true');
        expect(section.dataset.closing).toBe('true');
        expect(heading('folder:f1').getAttribute('aria-expanded')).toBe('false');

        motion.ends[0]();

        expect(rowIds('folder:f1')).toEqual([]);
        expect(section.dataset.closing).toBeUndefined();
    });

    test('a draw while the close runs leaves the rows where they are, and the count and the badge already show the closed state', () => {
        render([entry('a', { folderId: 'f1', unread: 2, badge: '2' }), entry('b', { folderId: 'f1' })], layoutOf(open));
        render([entry('a', { folderId: 'f1', unread: 2, badge: '2' }), entry('b', { folderId: 'f1' })], layoutOf(closed));

        render([entry('a', { folderId: 'f1', unread: 2, badge: '2' }), entry('b', { folderId: 'f1' }), entry('c', { folderId: 'f1' })], layoutOf(closed));

        expect(animateFolderBody).toHaveBeenCalledTimes(1);
        expect(rowIds('folder:f1')).toEqual(['a', 'b']);
        expect(heading('folder:f1').querySelector('.sb-conversation-list-heading-badge').hidden).toBe(false);
        motion.ends[0]();
        expect(rowIds('folder:f1')).toEqual([]);
    });

    test('opening again while it closes continues the motion, and the end of the close that was cut short takes nothing out', () => {
        render(rows(), layoutOf(open));
        render(rows(), layoutOf(closed));

        render(rows(), layoutOf(open));
        expect(motion.calls.map(call => call.expanding)).toEqual([false, true]);
        expect(list.querySelector('[data-section="folder:f1"]').dataset.closing).toBeUndefined();

        motion.ends[0]();

        expect(rowIds('folder:f1')).toEqual(['a', 'b']);
        expect(heading('folder:f1').getAttribute('aria-expanded')).toBe('true');
    });

    test('Favorites opens and closes with the same motion as a folder', () => {
        const favorites = [entry('a', { favorite: true })];
        render(favorites, layoutOf([], true));

        render(favorites, layoutOf([], false));
        expect(motion.calls).toEqual([{ body: rowsOf('favorites'), expanding: false, rows: 1 }]);
        motion.ends[0]();
        expect(rowIds('favorites')).toEqual([]);

        render(favorites, layoutOf([], true));
        expect(motion.calls[1]).toEqual({ body: rowsOf('favorites'), expanding: true, rows: 1 });
    });

    test('a section that is open for a drag opens with the motion and closes with it when the drag ends', () => {
        render(rows(), layoutOf(closed));

        view.setTemporaryOpen('folder:f1', true);
        render(rows(), layoutOf(closed));
        expect(motion.calls.map(call => call.expanding)).toEqual([true]);
        expect(rowIds('folder:f1')).toEqual(['a', 'b']);

        view.clearTemporaryOpen();
        render(rows(), layoutOf(closed));
        expect(motion.calls.map(call => call.expanding)).toEqual([true, false]);
    });

    test('an empty folder has no rows to move, so it plays nothing in either direction', () => {
        render([], layoutOf(open));
        render([], layoutOf(closed));
        render([], layoutOf(open));

        expect(animateFolderBody).not.toHaveBeenCalled();
    });

    test('a search that opens a folder, and the end of the search that closes it, play nothing', () => {
        render(rows(), layoutOf(closed));

        view.setConversationListQuery('name');
        render(rows(), layoutOf(closed));
        expect(rowIds('folder:f1')).toEqual(['a', 'b']);

        view.setConversationListQuery('');
        render(rows(), layoutOf(closed));
        expect(rowIds('folder:f1')).toEqual([]);
        expect(animateFolderBody).not.toHaveBeenCalled();
    });

    test('does not stop the node of a row from being kept across the close and the open', () => {
        render(rows(), layoutOf(open));
        const a = list.querySelector('[data-conversation-id="a"]');

        render(rows(), layoutOf(closed));
        motion.ends[0]();
        render(rows(), layoutOf(open));

        expect(list.querySelector('[data-conversation-id="a"]')).toBe(a);
    });
});
