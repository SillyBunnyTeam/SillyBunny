/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importScriptModule } from './util/script-harness.js';

let activeScript = null;

afterEach(() => {
    activeScript?.cleanup();
    activeScript = null;
});

describe('public/script.js author\'s note persona prompt wiring', () => {
    test('delegates Author\'s Note position, depth, and role to accessors without writing note_* keys to chat_metadata', async () => {
        const getAuthorsNotePosition = jest.fn(() => 2);
        const getAuthorsNoteDepth = jest.fn(() => 7);
        const getAuthorsNoteRole = jest.fn(() => 1);
        const loaded = await importScriptModule({
            mocks: {
                'scripts/authors-note.js': {
                    NOTE_MODULE_NAME: 'note',
                    getAuthorsNoteDepth,
                    getAuthorsNotePosition,
                    getAuthorsNoteRole,
                    initAuthorsNote: jest.fn(),
                    setFloatingPrompt: jest.fn(),
                    shouldWIAddPrompt: true,
                },
            },
        });
        activeScript = loaded;

        const { script, state } = loaded;
        state.power_user.persona_description = 'Persona blurb';
        state.power_user.persona_description_position = 2; // TOP_AN
        state.extension_settings.note = { allowWIScan: true };
        script.setExtensionPrompt('note', 'Existing AN', 1, 4, false, 0);
        script.characters.push({
            name: 'Aster',
            avatar: 'aster.png',
            chat: 'chat-1',
            description: '',
            personality: '',
            scenario: '',
            mes_example: '',
        });
        script.setCharacterId(0);
        script.setCharacterName('Aster');
        script.chat.push({ is_user: true, name: 'User', mes: 'Hello' });

        await script.Generate('normal', { automatic_trigger: false, force_name2: false, quiet_prompt: '', quietToLoud: false, skipWIAN: false, force_chid: null, signal: null, quietImage: null, quietName: null }, true);

        expect(getAuthorsNotePosition).toHaveBeenCalled();
        expect(getAuthorsNoteDepth).toHaveBeenCalled();
        expect(getAuthorsNoteRole).toHaveBeenCalled();
        expect(script.extension_prompts.note).toMatchObject({
            value: 'Persona blurb\nExisting AN',
            position: 2,
            depth: 7,
            scan: true,
            role: 1,
        });
        expect(Object.keys(script.chat_metadata).filter(key => key.startsWith('note_'))).toEqual([]);
    });
});
