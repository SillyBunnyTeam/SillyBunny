import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from '@jest/globals';
import { getDebouncedChatSaveAbortReason } from '../public/scripts/chat-save-guard.js';

describe('debounced metadata save', () => {
    test('aborts when a chat load happens between scheduling and firing', async () => {
        const extensionsSource = await fs.readFile(fileURLToPath(new URL('../public/scripts/extensions.js', import.meta.url)), 'utf8');
        const scriptSource = await fs.readFile(fileURLToPath(new URL('../public/script.js', import.meta.url)), 'utf8');
        const debouncedBody = extensionsSource.slice(
            extensionsSource.indexOf('export function saveMetadataDebounced()'),
            extensionsSource.indexOf('}', extensionsSource.indexOf('}, debounce_timeout.relaxed);')),
        );

        // Reopening the same chat leaves group, character and chat id all unchanged while the
        // messages are cleared, so only the generation distinguishes a loaded chat from a loading one.
        expect(scriptSource).toContain('export function getChatGeneration()');
        expect(debouncedBody).toContain('const generation = getChatGeneration();');
        expect(debouncedBody).toContain('if (generation !== getChatGeneration()) {');
        expect(debouncedBody.indexOf('const generation = getChatGeneration();'))
            .toBeLessThan(debouncedBody.indexOf('saveMetadataTimeout = setTimeout'));
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
