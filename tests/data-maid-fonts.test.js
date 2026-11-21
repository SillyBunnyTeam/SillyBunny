import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

import { setConfigFilePath } from '../src/util.js';
import { USER_DIRECTORY_TEMPLATE } from '../src/constants.js';

let root;
let DataMaidService;

beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-data-maid-fonts-'));
    // Importing the service reads the config file, so the path is set first.
    fs.copyFileSync(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), path.join(root, 'config.yaml'));
    setConfigFilePath(path.join(root, 'config.yaml'));
    ({ DataMaidService } = await import('../src/endpoints/data-maid.js'));
});

afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('Data Maid and imported fonts', () => {
    test('an imported font is not a loose file, any other unreferenced file still is', async () => {
        const directories = { root };
        for (const [key, relative] of Object.entries(USER_DIRECTORY_TEMPLATE)) {
            directories[key] = path.join(root, relative);
            fs.mkdirSync(directories[key], { recursive: true });
        }
        directories.backups = path.join(root, 'backups');
        fs.mkdirSync(directories.backups, { recursive: true });
        for (const name of ['sb-font-0123456789ab.woff2', 'sb-font-ffffffffffff.ttf', '_sbca_organization.json', 'loose.txt', 'my-sb-font-0123456789ab.woff2']) {
            fs.writeFileSync(path.join(directories.files, name), 'x');
        }

        const report = await new DataMaidService('fonts-test', directories).generateReport();

        expect(report.files.map(file => path.basename(file)).sort()).toEqual(['loose.txt', 'my-sb-font-0123456789ab.woff2']);
    });
});
