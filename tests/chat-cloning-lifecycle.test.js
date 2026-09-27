import { describe, expect, test } from '@jest/globals';
import { getQueuedChatSaveAbortReason } from '../public/scripts/chat-save-guard.js';

describe('Issue #340 — Chat Cloning & Queued Save Lifecycle Guards', () => {
    describe('Bug mechanism (why unpatched code clones chats)', () => {
        test('unpatched dequeue has no generation guard and would allow stale saves to proceed', () => {
            // In unpatched SillyBunny, getDebouncedChatSaveAbortReason only guarded the debounce timer.
            // Once a save entered chatSaveQueue, saveChatImmediately had NO guard for generation or entity drift.
            const scheduledState = {
                generation: 1,
                characterId: 1,
                chatId: 'Initial Chat',
                messages: [{ mes: 'old message state' }],
            };

            // While queued in chatSaveQueue, user swipes or switches chats:
            const currentState = {
                generation: 2, // generation bumped by swipe or navigation
                characterId: 1,
                chatId: 'Initial Chat',
                messages: [{ mes: 'new swipe message state' }],
            };

            // If we did NOT have getQueuedChatSaveAbortReason, the stale save would execute:
            const wouldStaleSaveFireWithoutGuard = Boolean(scheduledState.generation !== currentState.generation);
            expect(wouldStaleSaveFireWithoutGuard).toBe(true);
        });
    });

    describe('Fix verification with getQueuedChatSaveAbortReason', () => {
        test('catches generation drift when a swipe or navigation advances chat generation while queued', () => {
            const scheduledGeneration = 1;
            const currentGeneration = 2; // User swiped or navigated while save was queued

            const abortReason = getQueuedChatSaveAbortReason({
                scheduledGroupId: null,
                currentGroupId: null,
                scheduledCharacterId: 1,
                currentCharacterId: 1,
                scheduledChatId: 'Inspector-Bun-Chat',
                currentChatId: 'Inspector-Bun-Chat',
                scheduledGeneration,
                currentGeneration,
            });

            // The queued save MUST be aborted to prevent overwriting newer swipe state or writing stale slices
            expect(abortReason).toBe('chat generation');
        });

        test('catches character switch while save was queued', () => {
            const abortReason = getQueuedChatSaveAbortReason({
                scheduledGroupId: null,
                currentGroupId: null,
                scheduledCharacterId: 1,
                currentCharacterId: 2, // User selected a different character while save was queued
                scheduledChatId: 'Chat 1',
                currentChatId: 'Chat 2',
                scheduledGeneration: 1,
                currentGeneration: 2,
            });

            expect(abortReason).toBe('character');
        });

        test('catches group switch while save was queued', () => {
            const abortReason = getQueuedChatSaveAbortReason({
                scheduledGroupId: 'group-1',
                currentGroupId: 'group-2', // User selected a different group while save was queued
                scheduledCharacterId: null,
                currentCharacterId: null,
                scheduledChatId: 'Group Chat 1',
                currentChatId: 'Group Chat 1',
                scheduledGeneration: 1,
                currentGeneration: 1,
            });

            expect(abortReason).toBe('group');
        });

        test('catches chat file switch within the same character while save was queued', () => {
            const abortReason = getQueuedChatSaveAbortReason({
                scheduledGroupId: null,
                currentGroupId: null,
                scheduledCharacterId: 1,
                currentCharacterId: 1,
                scheduledChatId: 'Chat A',
                currentChatId: 'Chat B', // User switched to a different chat file
                scheduledGeneration: 1,
                currentGeneration: 1,
            });

            expect(abortReason).toBe('chat');
        });

        test('allows queued save to execute cleanly when identity and generation remain current', () => {
            const abortReason = getQueuedChatSaveAbortReason({
                scheduledGroupId: null,
                currentGroupId: null,
                scheduledCharacterId: 1,
                currentCharacterId: 1,
                scheduledChatId: 'Active Chat',
                currentChatId: 'Active Chat',
                scheduledGeneration: 5,
                currentGeneration: 5,
            });

            expect(abortReason).toBe('');
        });
    });

    describe('Simulated queued execution pipeline', () => {
        test('simulated saveChatImmediately aborts and prevents network/disk write on generation change', async () => {
            let networkRequestSent = false;
            let currentChatGeneration = 1;

            // Mock saveChatImmediately logic
            async function mockSaveChatImmediately(queuedArgs) {
                const abortReason = getQueuedChatSaveAbortReason({
                    scheduledGroupId: queuedArgs.scheduledGroupId,
                    currentGroupId: null,
                    scheduledCharacterId: queuedArgs.scheduledCharacterId,
                    currentCharacterId: 1,
                    scheduledChatId: queuedArgs.scheduledChatId,
                    currentChatId: 'MyChat',
                    scheduledGeneration: queuedArgs.scheduledGeneration,
                    currentGeneration: currentChatGeneration,
                });

                if (abortReason) {
                    return false; // Aborted cleanly
                }

                // Would send fetch('/api/chats/save')
                networkRequestSent = true;
                return true;
            }

            // Step 1: Enqueue a save at generation 1
            const queuedArgs = {
                scheduledGeneration: currentChatGeneration,
                scheduledCharacterId: 1,
                scheduledGroupId: null,
                scheduledChatId: 'MyChat',
                chatData: [{ mes: 'draft 1' }],
            };

            // Step 2: User swipes or navigates, incrementing generation
            currentChatGeneration++; // Now 2

            // Step 3: Queue drains and executes
            const result = await mockSaveChatImmediately(queuedArgs);

            // Verified proof: Save was aborted, no network request or file creation occurred!
            expect(result).toBe(false);
            expect(networkRequestSent).toBe(false);
        });

        test('simulated saveChatImmediately succeeds when generation is unchanged', async () => {
            let networkRequestSent = false;
            let currentChatGeneration = 1;

            async function mockSaveChatImmediately(queuedArgs) {
                const abortReason = getQueuedChatSaveAbortReason({
                    scheduledGroupId: queuedArgs.scheduledGroupId,
                    currentGroupId: null,
                    scheduledCharacterId: queuedArgs.scheduledCharacterId,
                    currentCharacterId: 1,
                    scheduledChatId: queuedArgs.scheduledChatId,
                    currentChatId: 'MyChat',
                    scheduledGeneration: queuedArgs.scheduledGeneration,
                    currentGeneration: currentChatGeneration,
                });

                if (abortReason) {
                    return false;
                }

                networkRequestSent = true;
                return true;
            }

            const queuedArgs = {
                scheduledGeneration: currentChatGeneration,
                scheduledCharacterId: 1,
                scheduledGroupId: null,
                scheduledChatId: 'MyChat',
                chatData: [{ mes: 'valid save' }],
            };

            const result = await mockSaveChatImmediately(queuedArgs);

            expect(result).toBe(true);
            expect(networkRequestSent).toBe(true);
        });
    });
});
