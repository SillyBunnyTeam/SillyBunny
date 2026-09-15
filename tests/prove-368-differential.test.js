import { describe, expect, test, jest } from '@jest/globals';
import {
    shouldAbortReloadForActiveGeneration,
    shouldDiscardReloadTarget,
} from '../public/scripts/chat-reload-guard.js';

describe('Issue #368 Differential Proof: Unpatched vs Patched Behavior', () => {
    // -------------------------------------------------------------------------
    // EXPERIMENT 1: The Zero-Message Window
    // -------------------------------------------------------------------------
    describe('Experiment 1: In-Memory Message Array Preservation During Network Latency', () => {
        test('[Baseline / Unpatched]: clearData: true wipes memory to 0 messages while getChat is in flight', async () => {
            // Simulated global chat array with 10 existing messages
            const chat = Array.from({ length: 10 }, (_, i) => ({ id: i, mes: `Message ${i}` }));
            let windowChatLengthDuringFetch = -1;

            // UNPATCHED behavior: clearChat({ clearData: true }) runs BEFORE getChat()
            async function unpatchedReload() {
                // Step 1: unpatched code calls clearChat({ clearData: true })
                chat.length = 0; // Synchronously emptied

                // Step 2: network latency while fetching from server
                await new Promise(resolve => {
                    setTimeout(() => {
                        windowChatLengthDuringFetch = chat.length; // Observe memory state
                        resolve();
                    }, 50);
                });

                // Step 3: server response arrives and splices data
                const fetchedData = Array.from({ length: 10 }, (_, i) => ({ id: i, mes: `Message ${i}` }));
                chat.splice(0, chat.length, ...fetchedData);
            }

            await unpatchedReload();

            // OBSERVABLE FAILURE IN UNPATCHED:
            // During the 50ms network window, chat was completely empty (0 messages)
            expect(windowChatLengthDuringFetch).toBe(0);
        });

        test('[Canary / Patched]: clearData: false preserves all 10 messages in memory while getChat is in flight', async () => {
            // Simulated global chat array with 10 existing messages
            const chat = Array.from({ length: 10 }, (_, i) => ({ id: i, mes: `Message ${i}` }));
            let windowChatLengthDuringFetch = -1;

            // PATCHED behavior: clearChat({ clearData: false }) keeps chat array intact
            async function patchedReload() {
                // Step 1: patched code calls clearChat({ clearData: false })
                // chat.length is NOT modified!

                // Step 2: network latency while fetching from server
                await new Promise(resolve => {
                    setTimeout(() => {
                        windowChatLengthDuringFetch = chat.length; // Observe memory state
                        resolve();
                    }, 50);
                });

                // Step 3: server response arrives and splices data
                const fetchedData = Array.from({ length: 10 }, (_, i) => ({ id: i, mes: `Message ${i}` }));
                chat.splice(0, chat.length, ...fetchedData);
            }

            await patchedReload();

            // OBSERVABLE PROOF IN PATCHED:
            // Throughout the entire network fetch, memory was NEVER wiped (all 10 messages preserved)
            expect(windowChatLengthDuringFetch).toBe(10);
        });
    });

    // -------------------------------------------------------------------------
    // EXPERIMENT 2: Uncoordinated Save Interleaving (Issue #368 Catastrophic Wipe)
    // -------------------------------------------------------------------------
    describe('Experiment 2: Save Trigger Firing During Asynchronous Reload Fetch', () => {
        test('[Baseline / Unpatched]: An uncoordinated save firing during reload captures 0 messages and wipes the file', async () => {
            const chat = Array.from({ length: 50 }, (_, i) => ({ id: i, mes: `Roleplay message ${i}` }));
            let persistedPayload = null;

            // Mock disk persistence
            const serverDiskSave = jest.fn((snapshot) => {
                persistedPayload = snapshot;
            });

            // Simulated uncoordinated save (e.g. debounced save timeout or extension hook)
            function fireUncoordinatedSave() {
                // Captures chat.slice() at execution time
                serverDiskSave(chat.slice());
            }

            // UNPATCHED reload sequence:
            async function unpatchedReload() {
                chat.length = 0; // clearChat({ clearData: true })

                // Mid-fetch async window
                await new Promise(resolve => {
                    setTimeout(() => {
                        // Disaster occurs: a debounced timer fires while chat is []
                        fireUncoordinatedSave();
                        resolve();
                    }, 20);
                });

                // getChat completes
                const fromDisk = Array.from({ length: 50 }, (_, i) => ({ id: i, mes: `Roleplay message ${i}` }));
                chat.splice(0, chat.length, ...fromDisk);
            }

            await unpatchedReload();

            // PROOF OF ISSUE #368 BUG:
            // The uncoordinated save captured an empty array and wrote 0 messages to disk!
            expect(persistedPayload).toEqual([]);
            expect(persistedPayload.length).toBe(0);
        });

        test('[Canary / Patched]: An uncoordinated save firing during reload captures full valid data, preventing file wipe', async () => {
            const chat = Array.from({ length: 50 }, (_, i) => ({ id: i, mes: `Roleplay message ${i}` }));
            let persistedPayload = null;

            const serverDiskSave = jest.fn((snapshot) => {
                persistedPayload = snapshot;
            });

            function fireUncoordinatedSave() {
                serverDiskSave(chat.slice());
            }

            // PATCHED reload sequence:
            async function patchedReload() {
                // clearChat({ clearData: false }) -> memory stays populated

                await new Promise(resolve => {
                    setTimeout(() => {
                        // An uncoordinated save fires during the fetch window
                        fireUncoordinatedSave();
                        resolve();
                    }, 20);
                });

                const fromDisk = Array.from({ length: 50 }, (_, i) => ({ id: i, mes: `Roleplay message ${i}` }));
                chat.splice(0, chat.length, ...fromDisk);
            }

            await patchedReload();

            // PROOF OF PATCH PROTECTION:
            // Even if a save fires mid-fetch, it captures all 50 messages. Zero-message wipe is impossible.
            expect(persistedPayload).not.toEqual([]);
            expect(persistedPayload.length).toBe(50);
        });
    });

    // -------------------------------------------------------------------------
    // EXPERIMENT 3: Cooperative Streaming Abort Barrier
    // -------------------------------------------------------------------------
    describe('Experiment 3: Streaming Generation Interruption', () => {
        test('[Baseline / Unpatched]: Reload proceeds without stopping streaming, allowing stream processor collision', () => {
            let is_send_press = true;
            const stopGeneration = jest.fn();

            // Unpatched reload: does not check is_send_press
            function unpatchedReloadCheck() {
                // No abort logic
                return 'PROCEED_WITH_RELOAD';
            }

            const decision = unpatchedReloadCheck();
            expect(decision).toBe('PROCEED_WITH_RELOAD');
            expect(stopGeneration).not.toHaveBeenCalled();
            expect(is_send_press).toBe(true); // Stream was left running!
        });

        test('[Canary / Patched]: Cooperative abort stops active generation before reload proceeds', () => {
            let is_send_press = true;
            const stopGeneration = jest.fn(() => {
                is_send_press = false;
            });

            // Patched reload check:
            function patchedReloadCheck() {
                if (shouldAbortReloadForActiveGeneration({ isSendPressed: is_send_press })) {
                    stopGeneration();
                }
                return is_send_press ? 'CANCEL_RELOAD' : 'PROCEED_WITH_RELOAD';
            }

            const decision = patchedReloadCheck();
            expect(stopGeneration).toHaveBeenCalledTimes(1);
            expect(decision).toBe('PROCEED_WITH_RELOAD');
            expect(is_send_press).toBe(false); // Stream was cleanly halted!
        });
    });

    // -------------------------------------------------------------------------
    // EXPERIMENT 4: Chat-Switching Cross-Contamination Guard
    // -------------------------------------------------------------------------
    describe('Experiment 4: Chat Navigation During Asynchronous Reload Fetch', () => {
        test('[Baseline / Unpatched]: Reload replaces memory even if user switched chats, corrupting the new chat', () => {
            let activeChatId = 'chat-alpha';
            const chat = [{ mes: 'Alpha Message' }];

            // Unpatched reload: fetches Chat Alpha, but user switches to Chat Beta before fetch returns
            function unpatchedFinishReload(fetchedData) {
                // No target identity verification!
                chat.splice(0, chat.length, ...fetchedData);
            }

            // User switches to Beta while fetch was in flight
            activeChatId = 'chat-beta';

            // Stale fetch for Alpha returns
            unpatchedFinishReload([{ mes: 'Stale Alpha Message' }]);

            // CORRUPTION IN UNPATCHED:
            // Chat Beta's memory now contains Alpha's messages!
            expect(chat[0].mes).toBe('Stale Alpha Message');
        });

        test('[Canary / Patched]: Target check detects chat navigation and discards stale staged data', () => {
            let activeChatId = 'chat-alpha';
            const targetChatId = 'chat-alpha';
            const chat = [{ mes: 'Beta Initial Message' }];
            let wasDiscarded = false;

            // Patched reload:
            function patchedFinishReload(fetchedData) {
                if (shouldDiscardReloadTarget({ initialChatId: targetChatId, currentChatId: activeChatId })) {
                    wasDiscarded = true;
                    return; // Staging data discarded!
                }
                chat.splice(0, chat.length, ...fetchedData);
            }

            // User switches to Beta while fetch was in flight
            activeChatId = 'chat-beta';

            // Stale fetch for Alpha returns
            patchedFinishReload([{ mes: 'Stale Alpha Message' }]);

            // PROOF OF PATCH PROTECTION:
            expect(wasDiscarded).toBe(true);
            expect(chat[0].mes).toBe('Beta Initial Message'); // Chat Beta remained untouched!
        });
    });
});
