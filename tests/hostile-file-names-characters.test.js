import { describe, expect, test } from '@jest/globals';

import { checkRow } from './util/hostile-file-names-harness.js';
import { ROW_TIMEOUT_MS, useRouteTable } from './util/hostile-file-names-suite.js';

const IMPORT_TIMEOUT_MS = 30_000;
const CARD_FORMATS = [
    ['V2', { spec: 'chara_card_v2', spec_version: '2.0' }],
    ['V3', { spec: 'chara_card_v3', spec_version: '3.0' }],
];

describe('hostile file names on character routes', () => {
    const { rows, getHarness } = useRouteTable({
        '/api/characters': () => import('../src/endpoints/characters.js'),
    });

    test.each(rows)('$title refuses hostile names or keeps them inside the user folder', async (row) => {
        expect(await checkRow(getHarness(), row)).toEqual([]);
    }, ROW_TIMEOUT_MS);

    describe.each(CARD_FORMATS)('POST /api/characters/import with a %s JSON card', (_format, spec) => {
        const importCard = (name) => {
            const card = { ...spec, data: { name, first_mes: 'hello', extensions: {} } };
            const row = {
                method: 'POST',
                mount: '/api/characters',
                path: '/import',
                field: 'file_type',
                transport: 'multipart',
                file: { name: 'card.json', type: 'application/json', content: Buffer.from(JSON.stringify(card)) },
            };
            return getHarness().run(row, { value: 'json' });
        };

        test('a name with ../ segments lands directly inside the characters folder', async () => {
            const result = await importCard('../../outside/escape');

            expect(result.status).toBe(200);
            const { file_name: fileName } = JSON.parse(result.text);
            expect(fileName).not.toMatch(/[/\\]/);
            expect(result.outsideChanges).toEqual([]);
            expect(result.userChanges.filter(change => change.startsWith('characters/'))).toEqual([`characters/${fileName}.png`]);
        }, IMPORT_TIMEOUT_MS);

        test('a name that ends in .png gets one .png extension', async () => {
            const result = await importCard('ends-with.png');

            expect(result.status).toBe(200);
            expect(JSON.parse(result.text)).toEqual({ file_name: 'ends-with' });
            expect(result.userChanges.filter(change => change.startsWith('characters/'))).toEqual(['characters/ends-with.png']);
        }, IMPORT_TIMEOUT_MS);

        test.each([['seed'], ['seed.png']])('the name %s keeps the existing card and takes a numbered file name', async (name) => {
            const result = await importCard(name);

            expect(result.status).toBe(200);
            expect(JSON.parse(result.text)).toEqual({ file_name: 'seed1' });
            expect(result.userChanges.filter(change => change.startsWith('characters/'))).toEqual(['characters/seed1.png']);
        }, IMPORT_TIMEOUT_MS);
    });
});
