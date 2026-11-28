/** @jest-environment jsdom */
import { describe, expect, jest, test } from '@jest/globals';
import { getDebouncedChatSaveAbortReason, getQueuedChatSaveAbortReason } from '../public/scripts/chat-save-guard.js';
import { importExtensionsModule } from './util/extensions-module-harness.js';

describe('debounced metadata save', () => {
    test('aborts when a chat load happens between scheduling and firing', async () => {
        // Reopening the same chat leaves group, character and chat id all unchanged while the
        // messages are cleared, so only getChatGeneration() distinguishes a loaded chat from a loading one.
        let generation = 1;
        const saveChatConditional = jest.fn(async () => true);
        const { extensions } = await importExtensionsModule({
            script: {
                getChatGeneration: () => generation,
                saveChatConditional,
                chat_metadata: { note_prompt: 'hello' },
            },
        });
        extensions.setExtensionContextGetter(() => ({
            saveMetadata: saveChatConditional,
            saveChat: saveChatConditional,
            chatId: 'chat-1',
            characterId: 0,
            groupId: null,
            chatMetadata: { note_prompt: 'hello' },
        }));
        try {
            // 1. When chat generation changes before the relaxed debounce fires, the save is aborted.
            extensions.saveMetadataDebounced();
            generation = 2;
            await new Promise(resolve => setTimeout(resolve, 25));
            expect(saveChatConditional).not.toHaveBeenCalled();

            // 2. When chat generation stays unchanged, the debounced metadata save completes.
            extensions.saveMetadataDebounced();
            await new Promise(resolve => setTimeout(resolve, 25));
            expect(saveChatConditional).toHaveBeenCalledTimes(1);
        } finally {
            extensions.cancelDebouncedMetadataSave();
            extensions.setExtensionContextGetter(null);
        }
    });
});

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

    test('aborts when the active chat generation changes for the same chat file', () => {
        expect(getDebouncedChatSaveAbortReason({
            scheduledGroupId: null,
            currentGroupId: null,
            scheduledCharacterId: 1,
            currentCharacterId: 1,
            scheduledChatId: 'Chat A',
            currentChatId: 'Chat A',
            scheduledGeneration: 1,
            currentGeneration: 2,
        })).toBe('chat generation');
    });
});

describe('getQueuedChatSaveAbortReason', () => {
    test('allows saves when the queued target still matches', () => {
        expect(getQueuedChatSaveAbortReason({
            scheduledGroupId: null,
            currentGroupId: null,
            scheduledCharacterId: 1,
            currentCharacterId: 1,
            scheduledChatId: 'Chat A',
            currentChatId: 'Chat A',
            scheduledGeneration: 3,
            currentGeneration: 3,
        })).toBe('');
    });

    test('aborts when the selected group changes while queued', () => {
        expect(getQueuedChatSaveAbortReason({
            scheduledGroupId: 'group-a',
            currentGroupId: 'group-b',
            scheduledCharacterId: undefined,
            currentCharacterId: undefined,
            scheduledChatId: 'Chat A',
            currentChatId: 'Chat A',
            scheduledGeneration: 1,
            currentGeneration: 1,
        })).toBe('group');
    });

    test('aborts when the selected character changes while queued', () => {
        expect(getQueuedChatSaveAbortReason({
            scheduledGroupId: null,
            currentGroupId: null,
            scheduledCharacterId: 1,
            currentCharacterId: 2,
            scheduledChatId: 'Chat A',
            currentChatId: 'Chat A',
            scheduledGeneration: 1,
            currentGeneration: 1,
        })).toBe('character');
    });

    test('aborts when the active chat file changes while queued', () => {
        expect(getQueuedChatSaveAbortReason({
            scheduledGroupId: null,
            currentGroupId: null,
            scheduledCharacterId: 1,
            currentCharacterId: 1,
            scheduledChatId: 'Chat A',
            currentChatId: 'Chat B',
            scheduledGeneration: 1,
            currentGeneration: 1,
        })).toBe('chat');
    });

    test('aborts when scheduled chat exists but current chat becomes undefined (closed/navigated away)', () => {
        expect(getQueuedChatSaveAbortReason({
            scheduledGroupId: null,
            currentGroupId: null,
            scheduledCharacterId: 1,
            currentCharacterId: 1,
            scheduledChatId: 'Chat A',
            currentChatId: undefined,
            scheduledGeneration: 1,
            currentGeneration: 1,
        })).toBe('chat');
    });

    test('aborts when the active chat generation changes while queued (navigation, swipe, clear)', () => {
        expect(getQueuedChatSaveAbortReason({
            scheduledGroupId: null,
            currentGroupId: null,
            scheduledCharacterId: 1,
            currentCharacterId: 1,
            scheduledChatId: 'Chat A',
            currentChatId: 'Chat A',
            scheduledGeneration: 1,
            currentGeneration: 2,
        })).toBe('chat generation');
    });

    test('does not abort direct saves when scheduled fields are undefined', () => {
        expect(getQueuedChatSaveAbortReason({
            currentGroupId: null,
            currentCharacterId: 1,
            currentChatId: 'Chat A',
            currentGeneration: 2,
        })).toBe('');
    });
});
