import { describe, expect, jest, test } from '@jest/globals';
import vm from 'node:vm';

import { loadDeclarations } from '../util/load-declarations.js';

describe('persona backup payload (onBackupPersonas)', () => {
    test('exports personas, persona_descriptions and default_persona while omitting sb_folders by design', async () => {
        let downloadedBlob = null;
        let downloadedFileName = null;
        let downloadedMimeType = null;

        const powerUser = {
            personas: {
                'alice.png': 'Alice',
                'bob.png': 'Bob',
            },
            persona_descriptions: {
                'alice.png': { description: 'Traveler', position: 0, depth: 2, role: 0, lorebook: '', title: 'Hero' },
                'bob.png': { description: 'Scout', position: 0, depth: 2, role: 0, lorebook: '', title: '' },
            },
            default_persona: 'alice.png',
            sb_folders: {
                version: 1,
                personas: {
                    folders: [{ id: 'folder-1', name: 'Main Cast', color: 'blue', expanded: true }],
                    members: { 'alice.png': 'folder-1' },
                },
            },
        };

        const context = vm.createContext({
            Date,
            JSON,
            Blob,
            power_user: powerUser,
            download: jest.fn((blob, fileName, mimeType) => {
                downloadedBlob = blob;
                downloadedFileName = fileName;
                downloadedMimeType = mimeType;
            }),
        });

        loadDeclarations(context, 'scripts/personas.js', ['onBackupPersonas']);
        context.onBackupPersonas();

        expect(context.download).toHaveBeenCalledTimes(1);
        expect(downloadedFileName).toMatch(/^personas_\d{8}\.json$/);
        expect(downloadedMimeType).toBe('application/json');
        expect(downloadedBlob).toBeInstanceOf(Blob);

        const payload = JSON.parse(await downloadedBlob.text());
        expect(Object.keys(payload).sort()).toEqual(['default_persona', 'persona_descriptions', 'personas']);
        expect(payload).toEqual({
            personas: powerUser.personas,
            persona_descriptions: powerUser.persona_descriptions,
            default_persona: powerUser.default_persona,
        });
        expect(payload).not.toHaveProperty('sb_folders');
        expect(payload).not.toHaveProperty('folders');
    });
});
