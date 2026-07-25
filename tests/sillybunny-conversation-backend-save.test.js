import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SETTINGS_FILE } from '../src/constants.js';
import { CONVERSATION_STORE_KEY, DEFAULT_BRANCH_ID } from '../public/scripts/sillybunny-conversation/constants.js';

const triggerAutoSave = jest.fn();
await jest.unstable_mockModule('../src/endpoints/settings.js', () => ({ triggerAutoSave }));
const { saveConversationStore } = await import('../src/endpoints/conversation-store.js');

describe('Conversation backend store commits', () => {
    const tempDirs = [];

    afterEach(() => {
        triggerAutoSave.mockClear();
        for (const directory of tempDirs.splice(0)) {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    function createRequest() {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-backend-save-'));
        tempDirs.push(root);
        fs.writeFileSync(path.join(root, SETTINGS_FILE), JSON.stringify({ _version: 0, extension_settings: {} }));
        return {
            user: {
                profile: { handle: 'backend-save-user' },
                directories: { root },
            },
        };
    }

    function createStore() {
        return {
            version: 1,
            localStorageMigrated: false,
            settings: {},
            characters: {},
            groups: [],
            legacyThreadPersonaAssignments: {},
            reminders: [],
        };
    }

    test('triggers the existing settings backup service only after a successful write', async () => {
        const request = createRequest();
        const result = await saveConversationStore(request, createStore(), 0);

        expect(result.ok).toBe(true);
        expect(triggerAutoSave).toHaveBeenCalledTimes(1);
        expect(triggerAutoSave).toHaveBeenCalledWith('backend-save-user');
        const settings = JSON.parse(fs.readFileSync(path.join(request.user.directories.root, SETTINGS_FILE), 'utf8'));
        expect(settings._version).toBe(1);
        expect(settings.extension_settings[CONVERSATION_STORE_KEY]).toEqual(createStore());

        const conflict = await saveConversationStore(request, createStore(), 0);
        expect(conflict).toMatchObject({ ok: false, status: 409 });
        expect(triggerAutoSave).toHaveBeenCalledTimes(1);
    });

    test('validates the final store before writing or triggering a backup', async () => {
        const request = createRequest();
        const store = createStore();
        store.characters['nova.png'] = {
            activeBranchId: DEFAULT_BRANCH_ID,
            branches: [],
        };

        const result = await saveConversationStore(request, store, 0);
        expect(result).toEqual({ ok: false, status: 400, body: { error: 'invalid_branches' } });
        expect(triggerAutoSave).not.toHaveBeenCalled();
        const settings = JSON.parse(fs.readFileSync(path.join(request.user.directories.root, SETTINGS_FILE), 'utf8'));
        expect(settings).toEqual({ _version: 0, extension_settings: {} });
    });
});
