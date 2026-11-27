import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { event_types } from '../public/scripts/events.js';
import { importWorldInfoModule } from './util/world-info-module-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Deferred until script.js behavioural harness lands; verifies script.js delegates to authors-note accessors.
const scriptSource = fs.readFileSync(path.join(repoRoot, 'public', 'script.js'), 'utf8');

async function loadAuthorsNoteApp(chatMetadata = {}, noteSettings = {}, extraOptions = {}) {
    return importWorldInfoModule({
        useRealAuthorsNote: true,
        chat_metadata: chatMetadata,
        extension_settings: { note: { allowWIScan: true, ...noteSettings } },
        ...extraOptions,
    });
}

describe('author\'s note chat metadata', () => {
    test('loading a chat no longer stamps note defaults into chat_metadata', async () => {
        const chatMetadata = {};
        const { authorsNote, mocks } = await loadAuthorsNoteApp(chatMetadata, {
            default: 'settings note',
            defaultInterval: 3,
            defaultPosition: 2,
            defaultDepth: 7,
            defaultRole: 1,
        });

        authorsNote.initAuthorsNote();
        await mocks.eventSource.emit(event_types.CHAT_CHANGED);

        expect(chatMetadata).toEqual({});
    });

    test('resolves every value from settings when the chat has no note', async () => {
        const chatMetadata = {};
        const { authorsNote } = await loadAuthorsNoteApp(chatMetadata, {
            default: 'settings note',
            defaultInterval: 3,
            defaultPosition: 2,
            defaultDepth: 7,
            defaultRole: 1,
        });

        expect(authorsNote.getAuthorsNotePrompt()).toBe('settings note');
        expect(authorsNote.getAuthorsNoteInterval()).toBe(3);
        expect(authorsNote.getAuthorsNotePosition()).toBe(2);
        expect(authorsNote.getAuthorsNoteDepth()).toBe(7);
        expect(authorsNote.getAuthorsNoteRole()).toBe(1);

        // Reading is not a reason to write: a chat that never used a note stays clean, and a clean
        // chat is one the server can skip rewriting.
        expect(chatMetadata).toEqual({});
    });

    test('falls back to the built-in defaults when settings are empty', async () => {
        const { authorsNote } = await loadAuthorsNoteApp({}, {});

        expect(authorsNote.getAuthorsNotePrompt()).toBe('');
        expect(authorsNote.getAuthorsNoteInterval()).toBe(1);
        expect(authorsNote.getAuthorsNotePosition()).toBe(1);
        expect(authorsNote.getAuthorsNoteDepth()).toBe(4);
        expect(authorsNote.getAuthorsNoteRole()).toBe(0);
    });

    test('prefers a note the user actually set on the chat', async () => {
        const { authorsNote } = await loadAuthorsNoteApp(
            { note_prompt: 'chat note', note_interval: 5, note_position: 0, note_depth: 9, note_role: 2 },
            { default: 'settings note', defaultInterval: 3, defaultPosition: 2, defaultDepth: 7, defaultRole: 1 },
        );

        expect(authorsNote.getAuthorsNotePrompt()).toBe('chat note');
        expect(authorsNote.getAuthorsNoteInterval()).toBe(5);
        expect(authorsNote.getAuthorsNotePosition()).toBe(0);
        expect(authorsNote.getAuthorsNoteDepth()).toBe(9);
        expect(authorsNote.getAuthorsNoteRole()).toBe(2);
    });

    test('keeps a zeroed note setting instead of falling through to the default', async () => {
        const { authorsNote } = await loadAuthorsNoteApp(
            { note_prompt: '', note_interval: 0, note_position: 0, note_depth: 0, note_role: 0 },
            { default: 'settings note', defaultInterval: 3, defaultPosition: 2, defaultDepth: 7, defaultRole: 1 },
        );

        expect(authorsNote.getAuthorsNotePrompt()).toBe('');
        expect(authorsNote.getAuthorsNoteInterval()).toBe(0);
        expect(authorsNote.getAuthorsNotePosition()).toBe(0);
        expect(authorsNote.getAuthorsNoteDepth()).toBe(0);
        expect(authorsNote.getAuthorsNoteRole()).toBe(0);
    });

    test('World Info prompt assembly reads through the accessors instead of raw metadata', async () => {
        const chatMetadata = {};
        const { worldInfo, authorsNote, mocks, $ } = await loadAuthorsNoteApp(chatMetadata, {
            default: 'Settings author note.',
            defaultInterval: 1,
            defaultPosition: 2,
            defaultDepth: 7,
            defaultRole: 1,
            allowWIScan: true,
        }, {
            books: {
                'Aster Book': {
                    entries: {
                        1: { uid: 1, key: ['tea'], keysecondary: [], position: 2, order: 100, content: 'Before AN.' },
                        2: { uid: 2, key: ['tea'], keysecondary: [], position: 3, order: 90, content: 'After AN.' },
                    },
                },
            },
            chat: [{ is_user: true, mes: 'Drink tea.' }],
        });

        $('#extension_floating_prompt').val('Settings author note.');
        authorsNote.setFloatingPrompt();
        mocks.setExtensionPrompt.mockClear();

        await worldInfo.checkWorldInfo(['Roleplay User: Drink tea.'], 4000, false);

        expect(mocks.setExtensionPrompt).toHaveBeenCalledWith(
            authorsNote.NOTE_MODULE_NAME,
            'Before AN.\nSettings author note.\nAfter AN.',
            2,
            7,
            true,
            1,
        );
        expect(Object.keys(chatMetadata).filter(key => key.startsWith('note_'))).toEqual([]);

        // Keep script.js guard until script.js behavioural harness replaces it.
        expect(scriptSource).toContain('setExtensionPrompt(NOTE_MODULE_NAME, ANWithDesc, getAuthorsNotePosition(), getAuthorsNoteDepth(), extension_settings.note.allowWIScan, getAuthorsNoteRole());');
        expect(scriptSource).not.toContain('chat_metadata[metadata_keys.');
    });
});
