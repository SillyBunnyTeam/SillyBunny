import { describe, expect, test } from '@jest/globals';

import { checkRow } from './util/hostile-file-names-harness.js';
import { ROW_TIMEOUT_MS, useRouteTable } from './util/hostile-file-names-suite.js';

// The rows list no sanitized inputs, so every hostile name must be refused.
function exportRow(variant, fixed, plain) {
    return { method: 'POST', mount: '/api/chats', path: '/export', field: 'file', transport: 'json', title: `POST /api/chats/export file (${variant})`, fixed, plain, reject: [400, 404] };
}

const ROWS = [
    exportRow('character chat as text', { avatar_url: 'seed.png', format: 'txt' }, 'seed.jsonl'),
    exportRow('character chat as JSONL', { avatar_url: 'seed.png', format: 'jsonl' }, 'seed.jsonl'),
    exportRow('group chat as text', { is_group: true, format: 'txt' }, 'seedchat.jsonl'),
];

describe('hostile names on chat export', () => {
    const { getHarness } = useRouteTable({
        '/api/chats': () => import('../src/endpoints/chats.js'),
    });

    test.each(ROWS)('$title refuses hostile names and keeps the user folder unchanged', async (row) => {
        expect(await checkRow(getHarness(), row)).toEqual([]);
    }, ROW_TIMEOUT_MS);
});
