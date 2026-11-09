import { describe, expect, jest, test } from '@jest/globals';

import { BACKSLASHES, checkRow, LONG, NUL_BYTE, SLASHES, TRAILING } from './util/hostile-file-names-harness.js';
import { ROW_TIMEOUT_MS, useRouteTable } from './util/hostile-file-names-suite.js';

// The real module loads the transformers library when it is imported, and no request here uses it.
jest.unstable_mockModule('../src/vectors/embedding.js', () => ({
    getTransformersVector: async () => [0.5, 0.5],
    getTransformersBatchVector: async texts => texts.map(() => [0.5, 0.5]),
}));

// The export rows list no sanitized inputs, so every hostile name must be refused.
function exportRow(variant, fixed, plain) {
    return { method: 'POST', mount: '/api/chats', path: '/export', field: 'file', transport: 'json', title: `POST /api/chats/export file (${variant})`, fixed, plain, reject: [400, 404] };
}

const ROWS = [
    exportRow('character chat as text', { avatar_url: 'seed.png', format: 'txt' }, 'seed.jsonl'),
    exportRow('character chat as JSONL', { avatar_url: 'seed.png', format: 'jsonl' }, 'seed.jsonl'),
    exportRow('group chat as text', { is_group: true, format: 'txt' }, 'seedchat.jsonl'),
    { method: 'POST', mount: '/api/vector', path: '/purge', field: 'collectionId', transport: 'json', title: 'POST /api/vector/purge collectionId', plain: 'seed', reject: [400], sanitized: [SLASHES, BACKSLASHES, NUL_BYTE, TRAILING, LONG], body: 'OK' },
];

describe('hostile names on chat export and vector purge', () => {
    const { getHarness } = useRouteTable({
        '/api/chats': () => import('../src/endpoints/chats.js'),
        '/api/vector': () => import('../src/endpoints/vectors.js'),
    });

    test.each(ROWS)('$title refuses hostile names and keeps the user folder unchanged', async (row) => {
        expect(await checkRow(getHarness(), row)).toEqual([]);
    }, ROW_TIMEOUT_MS);
});
