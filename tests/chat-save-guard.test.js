import { describe, expect, test } from '@jest/globals';
import { getDebouncedChatSaveAbortReason } from '../public/scripts/chat-save-guard.js';

describe('getDebouncedChatSaveAbortReason', () => {
    test('allows saves when the scheduled target still matches', () => {
        expect(getDebouncedChatSaveAbortReason({
            scheduledGroupId: null,
            currentGroupId: null,
            scheduledCharacterId: 1,
            currentCharacterId: 1,
            scheduledChatId: 'Chat A',
            currentChatId: 'Chat A',
        })).toBe('');
    });

    test('aborts when the selected group changes', () => {
        expect(getDebouncedChatSaveAbortReason({
            scheduledGroupId: 'group-a',
            currentGroupId: 'group-b',
            scheduledCharacterId: undefined,
            currentCharacterId: undefined,
            scheduledChatId: 'Chat A',
            currentChatId: 'Chat A',
        })).toBe('group');
    });

    test('aborts when the selected character changes', () => {
        expect(getDebouncedChatSaveAbortReason({
            scheduledGroupId: null,
            currentGroupId: null,
            scheduledCharacterId: 1,
            currentCharacterId: 2,
            scheduledChatId: 'Chat A',
            currentChatId: 'Chat A',
        })).toBe('character');
    });

    test('aborts when the active chat file changes for the same character', () => {
        expect(getDebouncedChatSaveAbortReason({
            scheduledGroupId: null,
            currentGroupId: null,
            scheduledCharacterId: 1,
            currentCharacterId: 1,
            scheduledChatId: 'Chat A',
            currentChatId: 'Chat B',
        })).toBe('chat');
    });
});
