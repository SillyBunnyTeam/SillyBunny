import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const notesSource = fs.readFileSync(path.join(repoRoot, 'public', 'scripts', 'authors-note.js'), 'utf8');
const scriptSource = fs.readFileSync(path.join(repoRoot, 'public', 'script.js'), 'utf8');
const worldInfoSource = fs.readFileSync(path.join(repoRoot, 'public', 'scripts', 'world-info.js'), 'utf8');

function getFunctionSource(source, name) {
    const match = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
    expect(match).not.toBeNull();
    return match[0];
}

/**
 * Rebuilds the Author's Note accessors from the shipped function bodies. The module imports
 * script.js and cannot be loaded under Jest, so the sources are evaluated with the globals they
 * close over.
 * @param {object} chat_metadata Chat metadata to resolve against.
 * @param {object} noteSettings The `extension_settings.note` object.
 * @returns {Record<string, Function>} The accessors.
 */
function loadAccessors(chat_metadata, noteSettings) {
    const body = [
        'const getDefaultRole = () => extension_prompt_roles.SYSTEM;',
        getFunctionSource(notesSource, 'getAuthorsNotePrompt'),
        getFunctionSource(notesSource, 'getAuthorsNoteInterval'),
        getFunctionSource(notesSource, 'getAuthorsNotePosition'),
        getFunctionSource(notesSource, 'getAuthorsNoteDepth'),
        getFunctionSource(notesSource, 'getAuthorsNoteRole'),
        'return { getAuthorsNotePrompt, getAuthorsNoteInterval, getAuthorsNotePosition, getAuthorsNoteDepth, getAuthorsNoteRole };',
    ].join('\n\n');

    const factory = new Function(
        'chat_metadata',
        'extension_settings',
        'metadata_keys',
        'DEFAULT_DEPTH',
        'DEFAULT_POSITION',
        'DEFAULT_INTERVAL',
        'extension_prompt_roles',
        body,
    );

    return factory(
        chat_metadata,
        { note: noteSettings },
        { prompt: 'note_prompt', interval: 'note_interval', depth: 'note_depth', position: 'note_position', role: 'note_role' },
        4,
        1,
        1,
        { SYSTEM: 0 },
    );
}

describe('author\'s note chat metadata', () => {
    test('loading a chat no longer stamps note defaults into chat_metadata', () => {
        const loadSettings = getFunctionSource(notesSource, 'loadSettings');

        for (const key of ['prompt', 'interval', 'position', 'depth', 'role']) {
            expect(loadSettings).not.toContain(`chat_metadata[metadata_keys.${key}] =`);
        }
    });

    test('resolves every value from settings when the chat has no note', () => {
        const chatMetadata = {};
        const accessors = loadAccessors(chatMetadata, {
            default: 'settings note',
            defaultInterval: 3,
            defaultPosition: 2,
            defaultDepth: 7,
            defaultRole: 1,
        });

        expect(accessors.getAuthorsNotePrompt()).toBe('settings note');
        expect(accessors.getAuthorsNoteInterval()).toBe(3);
        expect(accessors.getAuthorsNotePosition()).toBe(2);
        expect(accessors.getAuthorsNoteDepth()).toBe(7);
        expect(accessors.getAuthorsNoteRole()).toBe(1);

        // Reading is not a reason to write: a chat that never used a note stays clean, and a clean
        // chat is one the server can skip rewriting.
        expect(chatMetadata).toEqual({});
    });

    test('falls back to the built-in defaults when settings are empty', () => {
        const accessors = loadAccessors({}, {});

        expect(accessors.getAuthorsNotePrompt()).toBe('');
        expect(accessors.getAuthorsNoteInterval()).toBe(1);
        expect(accessors.getAuthorsNotePosition()).toBe(1);
        expect(accessors.getAuthorsNoteDepth()).toBe(4);
        expect(accessors.getAuthorsNoteRole()).toBe(0);
    });

    test('prefers a note the user actually set on the chat', () => {
        const accessors = loadAccessors(
            { note_prompt: 'chat note', note_interval: 5, note_position: 0, note_depth: 9, note_role: 2 },
            { default: 'settings note', defaultInterval: 3, defaultPosition: 2, defaultDepth: 7, defaultRole: 1 },
        );

        expect(accessors.getAuthorsNotePrompt()).toBe('chat note');
        expect(accessors.getAuthorsNoteInterval()).toBe(5);
        expect(accessors.getAuthorsNotePosition()).toBe(0);
        expect(accessors.getAuthorsNoteDepth()).toBe(9);
        expect(accessors.getAuthorsNoteRole()).toBe(2);
    });

    test('keeps a zeroed note setting instead of falling through to the default', () => {
        const accessors = loadAccessors(
            { note_prompt: '', note_interval: 0, note_position: 0, note_depth: 0, note_role: 0 },
            { default: 'settings note', defaultInterval: 3, defaultPosition: 2, defaultDepth: 7, defaultRole: 1 },
        );

        expect(accessors.getAuthorsNotePrompt()).toBe('');
        expect(accessors.getAuthorsNoteInterval()).toBe(0);
        expect(accessors.getAuthorsNotePosition()).toBe(0);
        expect(accessors.getAuthorsNoteDepth()).toBe(0);
        expect(accessors.getAuthorsNoteRole()).toBe(0);
    });

    test('the prompt builders read through the accessors instead of raw metadata', () => {
        expect(scriptSource).toContain('setExtensionPrompt(NOTE_MODULE_NAME, ANWithDesc, getAuthorsNotePosition(), getAuthorsNoteDepth(), extension_settings.note.allowWIScan, getAuthorsNoteRole());');
        expect(worldInfoSource).toContain('context.setExtensionPrompt(NOTE_MODULE_NAME, ANWithWI, getAuthorsNotePosition(), getAuthorsNoteDepth(), extension_settings.note.allowWIScan, getAuthorsNoteRole());');
        expect(scriptSource).not.toContain('chat_metadata[metadata_keys.');
        expect(worldInfoSource).not.toContain('chat_metadata[metadata_keys.');
    });
});
