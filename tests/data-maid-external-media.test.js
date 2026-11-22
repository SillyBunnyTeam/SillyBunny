import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';

import { setConfigFilePath } from '../src/util.js';
import { USER_DIRECTORY_TEMPLATE } from '../src/constants.js';
import { createCardPng, createV2Card } from './util/card-corpus.js';

const MANIFEST = '.external-media.json';
const NAMED_BY_CARD = 'card-0123456789abcdef.png';
const NAMED_BY_LOREBOOK = 'lore-0123456789abcdef.png';
const NAMED_BY_NOTHING = 'gone-0123456789abcdef.png';

let root;
let directories;
let DataMaidService;

beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-data-maid-media-'));
    // Importing the service reads the config file, so the path is set first.
    fs.copyFileSync(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), path.join(root, 'config.yaml'));
    setConfigFilePath(path.join(root, 'config.yaml'));
    ({ DataMaidService } = await import('../src/endpoints/data-maid.js'));
});

afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
    const userRoot = fs.mkdtempSync(path.join(root, 'user-'));
    directories = { root: userRoot };
    for (const [key, relative] of Object.entries(USER_DIRECTORY_TEMPLATE)) {
        directories[key] = path.join(userRoot, relative);
        fs.mkdirSync(directories[key], { recursive: true });
    }
    directories.backups = path.join(userRoot, 'backups');
    fs.mkdirSync(directories.backups, { recursive: true });
});

function storeMedia(folder, names, manifestNames = names) {
    const folderPath = path.join(directories.userImages, folder);
    fs.mkdirSync(folderPath, { recursive: true });
    for (const name of names) {
        fs.writeFileSync(path.join(folderPath, name), 'x');
    }
    const manifest = Object.fromEntries(manifestNames.map(name => [name, { url: `https://files.catbox.moe/${name}` }]));
    fs.writeFileSync(path.join(folderPath, MANIFEST), JSON.stringify(manifest));
}

function storeCard(fileName, text) {
    const card = createV2Card();
    card.data.name = path.parse(fileName).name;
    card.data.first_mes = text;
    fs.writeFileSync(path.join(directories.characters, fileName), createCardPng(card));
}

const looseImages = async () => {
    const report = await new DataMaidService('media-test', directories).generateReport();
    return report.images.map(image => path.relative(directories.userImages, image).split(path.sep).join('/')).sort();
};

describe('Data Maid and external media that an import stored', () => {
    test('a stored file that a card or a lorebook names is not loose, one that nothing names is, and the manifest is never listed', async () => {
        storeMedia('Folder', [NAMED_BY_CARD, NAMED_BY_LOREBOOK, NAMED_BY_NOTHING]);
        storeCard('Alice.png', `![a](/user/images/Folder/${NAMED_BY_CARD})`);
        fs.writeFileSync(path.join(directories.worlds, 'Atlas.json'), JSON.stringify({
            entries: { 0: { uid: 0, content: `<img src="/user/images/Folder/${NAMED_BY_LOREBOOK}">` } },
        }));

        expect(await looseImages()).toEqual([`Folder/${NAMED_BY_NOTHING}`]);
    });

    test('a file in a media folder that the manifest does not list is still loose', async () => {
        storeMedia('Folder', [NAMED_BY_CARD, 'mine.png'], [NAMED_BY_CARD]);
        storeCard('Alice.png', `![a](/user/images/Folder/${NAMED_BY_CARD}) and ![b](/user/images/Folder/mine.png)`);

        expect(await looseImages()).toEqual(['Folder/mine.png']);
    });

    test('a folder name that the stored URL encodes is matched', async () => {
        storeMedia('D\'Artagnan (alt)', [NAMED_BY_CARD]);
        storeCard('Dart.png', `![a](/user/images/D%27Artagnan%20%28alt%29/${NAMED_BY_CARD})`);

        expect(await looseImages()).toEqual([]);
    });

    test('a path in a remote URL or in a longer name does not keep a file', async () => {
        storeMedia('Folder', [NAMED_BY_CARD]);
        storeCard('Alice.png', `https://example.com/user/images/Folder/${NAMED_BY_CARD} and /user/images/Folder/x${NAMED_BY_CARD}`);

        expect(await looseImages()).toEqual([`Folder/${NAMED_BY_CARD}`]);
    });

    test('every listed file stays known when a card cannot be read', async () => {
        storeMedia('Folder', [NAMED_BY_CARD, NAMED_BY_NOTHING]);
        fs.writeFileSync(path.join(directories.characters, 'Broken.png'), 'not a png');

        expect(await looseImages()).toEqual([]);
    });

    test('a damaged manifest lists nothing as known and is not listed itself', async () => {
        const folderPath = path.join(directories.userImages, 'Folder');
        fs.mkdirSync(folderPath, { recursive: true });
        fs.writeFileSync(path.join(folderPath, NAMED_BY_CARD), 'x');
        fs.writeFileSync(path.join(folderPath, MANIFEST), '{not json');
        storeCard('Alice.png', `![a](/user/images/Folder/${NAMED_BY_CARD})`);

        expect(await looseImages()).toEqual([`Folder/${NAMED_BY_CARD}`]);
    });

    test('without a manifest the cards are not read and a loose image is reported as before', async () => {
        const folderPath = path.join(directories.userImages, 'Gallery');
        fs.mkdirSync(folderPath, { recursive: true });
        fs.writeFileSync(path.join(folderPath, 'pic.png'), 'x');
        fs.writeFileSync(path.join(directories.characters, 'Broken.png'), 'not a png');

        expect(await looseImages()).toEqual(['Gallery/pic.png']);
    });
});
