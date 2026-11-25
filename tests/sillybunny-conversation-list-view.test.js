/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Playwright does not recognize Jest test callbacks. */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({
    renderConversationParticipantStack: jest.fn((container, participants) => {
        container.textContent = participants.map(participant => participant.name).join('+');
    }),
}));

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
    avatar: `${id}.png`,
    characterIndex: '0',
    groupId: '',
    participants: [{ avatar: `${id}.png`, name: `Name ${id}` }],
    status: 'online',
    ...overrides,
});

let list;

const rowIds = section => [...list.querySelectorAll(`[data-section="${section}"] .sb-conversation-list-row`)].map(row => row.dataset.conversationId);
const render = entries => view.renderConversationListView(list, entries);

beforeEach(() => {
    document.body.replaceChildren();
    list = document.createElement('div');
    document.body.append(list);
    view.setConversationListQuery('');
    view.setFavoritesCollapsed(false);
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
        view.setFavoritesCollapsed(true);

        render([entry('a', { favorite: true, unread: 2 }), entry('b', { favorite: true, unread: 5, muted: true }), entry('c')]);

        const button = list.querySelector('.sb-conversation-list-heading-button');
        expect(button.getAttribute('aria-expanded')).toBe('false');
        expect(list.querySelector('[data-section="favorites"]').dataset.collapsed).toBe('true');
        const badge = button.querySelector('.sb-conversation-list-heading-badge');
        expect(badge.hidden).toBe(false);
        expect(badge.textContent).toBe('2');
    });

    test('an open section shows no badge on its heading', () => {
        render([entry('a', { favorite: true, unread: 2 })]);

        expect(list.querySelector('.sb-conversation-list-heading-badge').hidden).toBe(true);
        expect(list.querySelector('.sb-conversation-list-heading-button').getAttribute('aria-expanded')).toBe('true');
    });
});

describe('a search', () => {
    test('shows the matches in one list and leaves the other rows out of the document without destroying them', () => {
        render([entry('a', { name: 'Seraphina' }), entry('b', { name: 'Reisen', favorite: true }), entry('c', { name: 'Tewi' })]);
        const reisen = list.querySelector('[data-conversation-id="b"]');

        view.setConversationListQuery('rei');
        render([entry('a', { name: 'Seraphina' }), entry('b', { name: 'Reisen', favorite: true }), entry('c', { name: 'Tewi' })]);

        expect(list.dataset.searching).toBe('true');
        expect(rowIds('favorites')).toEqual([]);
        expect(rowIds('conversations')).toEqual(['b']);
        expect(list.querySelector('[data-conversation-id="a"]')).toBeNull();

        view.setConversationListQuery('');
        render([entry('a', { name: 'Seraphina' }), entry('b', { name: 'Reisen', favorite: true }), entry('c', { name: 'Tewi' })]);
        expect(rowIds('favorites')).toEqual(['b']);
        expect(list.querySelector('[data-conversation-id="b"]')).toBe(reisen);
        expect(rowIds('conversations')).toEqual(['a', 'c']);
    });

    test('says so when nothing matches, and invites a first conversation when there are none', () => {
        render([entry('a', { name: 'Seraphina' })]);
        view.setConversationListQuery('zzz');
        render([entry('a', { name: 'Seraphina' })]);
        expect(list.querySelector('.sb-conversation-list-empty').hidden).toBe(false);
        expect(list.querySelector('.sb-conversation-list-empty .sb-status-page__title').textContent).toBe('No Conversations Found');

        view.setConversationListQuery('');
        render([]);
        expect(list.querySelector('.sb-conversation-list-empty .sb-status-page__title').textContent).toBe('Use + to Start a Conversation');

        render([entry('a')]);
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
