/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';

import { importPersonasModule } from '../util/personas-module-harness.js';

function readBlobText(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'));
        reader.readAsText(blob);
    });
}

afterEach(() => {
    document.body.replaceChildren();
    jest.restoreAllMocks();
});

describe('persona backup payload (onBackupPersonas)', () => {
    test('exports personas, persona_descriptions and default_persona while omitting sb_folders by design', async () => {
        document.body.innerHTML = '<button id="personas_backup" type="button"></button>';
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

        const download = jest.fn((blob, fileName, mimeType) => {
            downloadedBlob = blob;
            downloadedFileName = fileName;
            downloadedMimeType = mimeType;
        });

        const { personas, $ } = await importPersonasModule({
            power_user: powerUser,
            utils: { download },
        });
        await personas.initPersonas();

        $('#personas_backup').trigger('click');

        expect(download).toHaveBeenCalledTimes(1);
        expect(downloadedFileName).toMatch(/^personas_\d{8}\.json$/);
        expect(downloadedMimeType).toBe('application/json');
        expect(downloadedBlob).toBeInstanceOf(Blob);

        const payload = JSON.parse(await readBlobText(downloadedBlob));
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
