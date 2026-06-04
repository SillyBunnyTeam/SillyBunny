import { describe, expect, test } from '@jest/globals';
import { normalizeCharacterChatName, resolveCharacterChatNameForLoad } from '../public/scripts/character-chat-resolver.js';

describe('normalizeCharacterChatName', () => {
    test('trims names and strips jsonl extensions', () => {
        expect(normalizeCharacterChatName(' Chat One.jsonl ')).toBe('Chat One');
    });
});

describe('resolveCharacterChatNameForLoad', () => {
    test('keeps persisted chat when it exists', () => {
        expect(resolveCharacterChatNameForLoad({
            persistedChat: 'Existing Chat',
            existingChats: [
                { file_name: 'Existing Chat.jsonl' },
                { file_name: 'Older Chat.jsonl' },
            ],
            allowCreate: true,
            newChatName: 'New Chat',
        })).toEqual({ chatName: 'Existing Chat', created: false });
    });

    test('falls back to latest existing chat when persisted chat is stale', () => {
        expect(resolveCharacterChatNameForLoad({
            persistedChat: 'Missing Chat',
            existingChats: [
                { file_name: 'Latest Real Chat.jsonl' },
                { file_name: 'Older Real Chat.jsonl' },
            ],
            allowCreate: true,
            newChatName: 'New Chat',
        })).toEqual({ chatName: 'Latest Real Chat', created: false });
    });

    test('creates a new chat only when no real chat exists', () => {
        expect(resolveCharacterChatNameForLoad({
            persistedChat: 'Missing Chat',
            existingChats: [],
            allowCreate: true,
            newChatName: 'Fresh Chat',
        })).toEqual({ chatName: 'Fresh Chat', created: true });
    });

    test('allows missing persisted chat for intentional new chat creation', () => {
        expect(resolveCharacterChatNameForLoad({
            persistedChat: 'Intentional New Chat',
            existingChats: [],
            allowCreate: true,
            allowMissingPersisted: true,
            newChatName: 'Fallback Chat',
        })).toEqual({ chatName: 'Intentional New Chat', created: true });
    });
});
