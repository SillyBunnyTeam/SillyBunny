import { describe, expect, test } from '@jest/globals';

import {
    clearConversationUnreadStore,
    getConversationThreadUnreadCount,
    normalizeConversationUnreadCount,
    sanitizeConversationUnreadStore,
    setConversationThreadUnreadCount,
} from '../public/scripts/sillybunny-conversation/notification-utils.js';

describe('sillybunny conversation notification utils', () => {
    test('normalizes positive unread counts only', () => {
        expect(normalizeConversationUnreadCount('3')).toBe(3);
        expect(normalizeConversationUnreadCount(0)).toBe(0);
        expect(normalizeConversationUnreadCount(-2)).toBe(0);
        expect(normalizeConversationUnreadCount('not-a-count')).toBe(0);
    });

    test('sanitizes stale thread unread counts', () => {
        const store = {
            characters: {
                alice: {
                    branches: {
                        main: { unread: '2' },
                        side: { unread: 4 },
                    },
                },
                stale: {
                    branches: {
                        main: { unread: 5 },
                        invalid: { unread: 'bad' },
                    },
                },
            },
        };

        const result = sanitizeConversationUnreadStore(store, threadKey => threadKey !== 'stale');

        expect(result).toEqual({ changed: true, cleared: 5 });
        expect(store.characters.alice.branches.main.unread).toBe(2);
        expect(store.characters.alice.branches.side.unread).toBe(4);
        expect(store.characters.stale.branches.main.unread).toBe(0);
        expect(store.characters.stale.branches.invalid.unread).toBe(0);
    });

    test('clears unread counts across all branches', () => {
        const store = {
            characters: {
                alice: {
                    branches: {
                        main: { unread: 2 },
                        side: { unread: '3' },
                        invalid: { unread: 'bad' },
                    },
                },
                bob: {
                    branches: {
                        main: { unread: 0 },
                    },
                },
            },
        };

        const result = clearConversationUnreadStore(store);

        expect(result).toEqual({ changed: true, cleared: 5 });
        expect(store.characters.alice.branches.main.unread).toBe(0);
        expect(store.characters.alice.branches.side.unread).toBe(0);
        expect(store.characters.alice.branches.invalid.unread).toBe(0);
        expect(store.characters.bob.branches.main.unread).toBe(0);
    });

    test('reports unchanged stores without unread counts', () => {
        const store = {
            characters: {
                alice: {
                    branches: {
                        main: { unread: 0 },
                    },
                },
            },
        };

        expect(clearConversationUnreadStore(store)).toEqual({ changed: false, cleared: 0 });
        expect(sanitizeConversationUnreadStore(store, () => true)).toEqual({ changed: false, cleared: 0 });
    });

    test('counts all branches and clears only a selected branch when requested', () => {
        const threadStore = {
            activeBranchId: 'branch-a',
            branches: {
                'branch-a': { unread: 2 },
                'branch-b': { unread: 3 },
            },
        };

        expect(getConversationThreadUnreadCount(threadStore)).toBe(5);
        expect(setConversationThreadUnreadCount(threadStore, 0, { branchId: 'branch-a' })).toBe(true);
        expect(threadStore.branches['branch-a'].unread).toBe(0);
        expect(threadStore.branches['branch-b'].unread).toBe(3);
        expect(getConversationThreadUnreadCount(threadStore)).toBe(3);

        setConversationThreadUnreadCount(threadStore, 0);
        expect(getConversationThreadUnreadCount(threadStore)).toBe(0);
    });
});
