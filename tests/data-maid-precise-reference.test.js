import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

import { setConfigFilePath } from '../src/util.js';
import { SETTINGS_FILE, USER_DIRECTORY_TEMPLATE } from '../src/constants.js';

let root;
let DataMaidService;

beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-data-maid-nai-ref-'));
    // Importing the service reads the config file, so the path is set first.
    fs.copyFileSync(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), path.join(root, 'config.yaml'));
    setConfigFilePath(path.join(root, 'config.yaml'));
    ({ DataMaidService } = await import('../src/endpoints/data-maid.js'));
});

afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('Data Maid and NovelAI Precise Reference files', () => {
    test('keeps reference PNGs named in Image Generation or Quick Image Gen settings and reports unreferenced ones', async () => {
        const directories = { root };
        for (const [key, relative] of Object.entries(USER_DIRECTORY_TEMPLATE)) {
            directories[key] = path.join(root, relative);
            fs.mkdirSync(directories[key], { recursive: true });
        }
        directories.backups = path.join(root, 'backups');
        fs.mkdirSync(directories.backups, { recursive: true });

        const keptNames = [
            'sb-nai-ref-1111111111111111.png',
            'sb-nai-ref-2222222222222222.png',
            'sb-nai-ref-3333333333333333.png',
            'sb-nai-ref-4444444444444444.png',
            'sb-nai-ref-5555555555555555.png',
        ];
        const orphanName = 'sb-nai-ref-9999999999999999.png';
        for (const name of [...keptNames, orphanName, 'loose.txt']) {
            fs.writeFileSync(path.join(directories.files, name), 'png');
        }

        const refEntry = name => ({ path: `/user/files/${name}`, bytes: 3, type: 'character', strength: 1, fidelity: 1 });
        fs.writeFileSync(path.join(root, SETTINGS_FILE), JSON.stringify({
            extension_settings: {
                sd: {
                    novel_precise_reference: { enabled: true, references: [refEntry(keptNames[0])] },
                },
                'quick-image-gen': {
                    naiPreciseReference: { enabled: true, references: [refEntry(keptNames[1])] },
                    _charSettingsBaseState: { naiPreciseReference: { enabled: false, references: [refEntry(keptNames[2])] } },
                    _backupConfigurations: [{ id: 'cfg-1', naiPreciseReference: { enabled: true, references: [refEntry(keptNames[3])] } }],
                    _backupCharRefImages: { alice: { naiPreciseReference: { enabled: true, references: [refEntry(keptNames[4])] } } },
                },
            },
        }));

        const report = await new DataMaidService('nai-ref-test', directories).generateReport();

        expect(report.files.map(file => path.basename(file)).sort()).toEqual(['loose.txt', orphanName]);
    });
});
