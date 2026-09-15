import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from '@jest/globals';
import {
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

describe('reloadCurrentChatUnsafe static invariants', () => {
    test('preserves in-memory chat and enforces cooperative abort and flush barriers', async () => {
        const scriptSource = await fs.readFile(
            fileURLToPath(new URL('../public/script.js', import.meta.url)),
            'utf8',
        );

        const reloadBodyStart = scriptSource.indexOf('export async function reloadCurrentChatUnsafe()');
        expect(reloadBodyStart).toBeGreaterThan(0);

        const reloadBodyEnd = scriptSource.indexOf('export async function sendTextareaMessage()', reloadBodyStart);
        expect(reloadBodyEnd).toBeGreaterThan(reloadBodyStart);

        const reloadBody = scriptSource.slice(reloadBodyStart, reloadBodyEnd);

        // Invariant 1: clearChat must NOT be called with clearData: true (Issue #368 wipe prevention)
        expect(reloadBody).toContain('await clearChat({ clearData: false });');
        expect(reloadBody).not.toContain('clearChat({ clearData: true })');

        // Invariant 2: Active generation triggers cooperative stopGeneration
        expect(reloadBody).toContain('shouldAbortReloadForActiveGeneration');
        expect(reloadBody).toContain('stopGeneration();');

        // Invariant 3: Pre-read flush barrier must be awaited before getChat
        expect(reloadBody).toContain('await flushPendingChatSavesForNavigation()');
        expect(reloadBody.indexOf('flushPendingChatSavesForNavigation'))
            .toBeLessThan(reloadBody.indexOf('getChat()'));

        // Invariant 4: Target identity check prevents cross-chat splice collisions
        expect(reloadBody).toContain('shouldDiscardReloadTarget');
        expect(reloadBody).toContain('const targetChatId = getCurrentChatId();');

        // Invariant 5: reloadCurrentChat is guarded by reloadChatMutex
        expect(scriptSource).toContain('export const reloadChatMutex = new SimpleMutex(reloadCurrentChatUnsafe);');
        expect(scriptSource).toContain('export const reloadCurrentChat = reloadChatMutex.update.bind(reloadChatMutex);');
    });
});
