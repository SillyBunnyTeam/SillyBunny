import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { startCharacterRouter } from './util/character-router-harness.js';

describe('character route names', () => {
    let harness;

    beforeAll(async () => {
        harness = await startCharacterRouter('sillybunny-character-route-names-');
    });

    beforeEach(() => {
        harness.reset();
        for (const method of ['error', 'info', 'log', 'warn']) {
            jest.spyOn(console, method).mockImplementation(() => {});
        }
    });

    afterEach(() => {
        jest.restoreAllMocks();
        harness.remove();
    });

    afterAll(async () => {
        await harness.close();
    });

    test('an import file type that names an Object.prototype member is an unsupported format', async () => {
        const fileTypes = Object.getOwnPropertyNames(Object.prototype);
        const before = harness.entries();
        const answers = [];
        for (const fileType of fileTypes) {
            answers.push({ fileType, ...await harness.importCard(Buffer.from('anything'), fileType) });
        }

        expect(answers).toEqual(fileTypes.map(fileType => ({ fileType, status: 200, body: { error: true } })));
        expect(harness.entries().filter(entry => !before.includes(entry) && !entry.startsWith('_uploads/'))).toEqual([]);
    });
});
