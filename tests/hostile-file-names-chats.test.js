import { describe, expect, test } from '@jest/globals';

import { checkRow } from './util/hostile-file-names-harness.js';
import { ROW_TIMEOUT_MS, useRouteTable } from './util/hostile-file-names-suite.js';

describe('hostile file names on chat, chat archive and group routes', () => {
    const { rows, getHarness } = useRouteTable({
        '/api/chats/archive': () => import('../src/endpoints/chat-archive.js'),
        '/api/chats': () => import('../src/endpoints/chats.js'),
        '/api/groups': () => import('../src/endpoints/groups.js'),
    });

    test.each(rows)('$title refuses hostile names or keeps them inside the user folder', async (row) => {
        expect(await checkRow(getHarness(), row)).toEqual([]);
    }, ROW_TIMEOUT_MS);
});
