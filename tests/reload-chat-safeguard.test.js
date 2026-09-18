import { describe, expect, jest, test } from '@jest/globals';
import {
    commitChatStaging,
    fetchChatRaw,
    fetchGroupChatRaw,
    isAbortTimeoutExceeded,
    shouldAbortReloadForActiveGeneration,
    shouldDiscardReloadTarget,
} from '../public/scripts/chat-reload-guard.js';

describe('chat reload guard logic', () => {
    describe('shouldAbortReloadForActiveGeneration', () => {
        test('returns false when no generation or send is active', () => {
            expect(shouldAbortReloadForActiveGeneration({
                isSendPressed: false,
                hasActiveGenerationRun: false,
            })).toBe(false);
        });

        test('returns true when is_send_press is true', () => {
            expect(shouldAbortReloadForActiveGeneration({
                isSendPressed: true,
                hasActiveGenerationRun: false,
            })).toBe(true);
        });

        test('returns true when activeGenerationRun is truthy', () => {
            expect(shouldAbortReloadForActiveGeneration({
                isSendPressed: false,
                hasActiveGenerationRun: true,
            })).toBe(true);
        });

        test('returns true when both are true', () => {
            expect(shouldAbortReloadForActiveGeneration({
                isSendPressed: true,
                hasActiveGenerationRun: true,
            })).toBe(true);
        });
    });

    describe('isAbortTimeoutExceeded', () => {
        test('returns false when elapsed is less than timeout', () => {
            expect(isAbortTimeoutExceeded({ elapsedMs: 1000, timeoutMs: 2500 })).toBe(false);
        });

        test('returns true when elapsed equals timeout', () => {
            expect(isAbortTimeoutExceeded({ elapsedMs: 2500, timeoutMs: 2500 })).toBe(true);
        });

        test('returns true when elapsed exceeds timeout', () => {
            expect(isAbortTimeoutExceeded({ elapsedMs: 3000, timeoutMs: 2500 })).toBe(true);
        });
    });

    describe('shouldDiscardReloadTarget', () => {
        test('returns false when chat target has not changed', () => {
            expect(shouldDiscardReloadTarget({
                initialChatId: 'chat-2026-09-15',
                currentChatId: 'chat-2026-09-15',
            })).toBe(false);
        });

        test('returns true when chat target switched during fetch', () => {
            expect(shouldDiscardReloadTarget({
                initialChatId: 'chat-alpha',
                currentChatId: 'chat-beta',
            })).toBe(true);
        });

        test('returns true when initial chat existed but current became null', () => {
            expect(shouldDiscardReloadTarget({
                initialChatId: 'chat-alpha',
                currentChatId: null,
            })).toBe(true);
        });
    });
});

describe('fetchChatRaw and fetchGroupChatRaw behavioral contracts', () => {
    test('fetchChatRaw decodes messages and separates chat_metadata header without touching external globals', async () => {
        const mockServerPayload = [
            { user_name: 'User', character_name: 'Bot', chat_metadata: { integrity: 'slug-123', tainted: false } },
            { name: 'Bot', is_user: false, mes: 'Hello world' },
            { name: 'User', is_user: true, mes: 'How are you?' },
        ];

        const mockFetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => mockServerPayload,
        });

        const staging = await fetchChatRaw({
            characterName: 'Bot',
            fileName: 'Bot - 2026-09-16.jsonl',
            avatarUrl: 'bot.png',
            fetchImpl: mockFetch,
        });

        expect(mockFetch).toHaveBeenCalledWith(
            '/api/chats/get',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    ch_name: 'Bot',
                    file_name: 'Bot - 2026-09-16.jsonl',
                    avatar_url: 'bot.png',
                    allow_create: false,
                }),
            }),
        );

        expect(staging.metadata).toEqual({ integrity: 'slug-123', tainted: false });
        expect(staging.messages).toHaveLength(2);
        expect(staging.messages[0].mes).toBe('Hello world');
        expect(staging.messages[1].mes).toBe('How are you?');
    });

    test('fetchChatRaw throws cleanly on HTTP failure without mutating state', async () => {
        const mockFetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 500,
        });

        await expect(fetchChatRaw({
            characterName: 'Bot',
            fileName: 'Bot.jsonl',
            fetchImpl: mockFetch,
        })).rejects.toThrow('Chat could not be loaded: HTTP 500');
    });

    test('fetchGroupChatRaw decodes group messages and metadata', async () => {
        const mockServerPayload = [
            { user_name: 'User', chat_metadata: { group_id: 'grp-99', integrity: 'grp-slug' } },
            { name: 'Member1', is_user: false, mes: 'Group turn 1' },
        ];

        const mockFetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => mockServerPayload,
        });

        const staging = await fetchGroupChatRaw({
            chatId: 'grp-99',
            fetchImpl: mockFetch,
        });

        expect(mockFetch).toHaveBeenCalledWith(
            '/api/chats/group/get',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ id: 'grp-99', allow_create: false }),
            }),
        );

        expect(staging.metadata).toEqual({ group_id: 'grp-99', integrity: 'grp-slug' });
        expect(staging.messages).toHaveLength(1);
        expect(staging.messages[0].mes).toBe('Group turn 1');
    });
});

describe('commitChatStaging behavioral contract', () => {
    test('synchronously mutates targetChat array and targetMetadata in place', () => {
        const targetChat = [
            { name: 'Old', is_user: false, mes: 'Old message 1' },
            { name: 'Old', is_user: true, mes: 'Old message 2' },
        ];
        const targetMetadata = { integrity: 'old-slug', oldKey: true };

        const staging = {
            messages: [
                { name: 'New', is_user: false, mes: 'Fresh turn' },
            ],
            metadata: { integrity: 'new-slug', freshKey: 'yes' },
        };

        const success = commitChatStaging({
            staging,
            targetChat,
            targetMetadata,
        });

        expect(success).toBe(true);
        expect(targetChat).toHaveLength(1);
        expect(targetChat[0].mes).toBe('Fresh turn');
        expect(targetMetadata).toEqual({ integrity: 'new-slug', freshKey: 'yes' });
        expect(targetMetadata.oldKey).toBeUndefined();
    });

    test('returns false and refuses mutation if staging is invalid', () => {
        const targetChat = [{ name: 'Keep', mes: 'Keep me' }];
        const targetMetadata = { integrity: 'keep' };

        const success = commitChatStaging({
            staging: null,
            targetChat,
            targetMetadata,
        });

        expect(success).toBe(false);
        expect(targetChat).toHaveLength(1);
        expect(targetChat[0].mes).toBe('Keep me');
        expect(targetMetadata.integrity).toBe('keep');
    });
});
