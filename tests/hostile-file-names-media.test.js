import { describe, expect, test } from '@jest/globals';

import { checkRow } from './util/hostile-file-names-harness.js';
import { ROW_TIMEOUT_MS, useRouteTable } from './util/hostile-file-names-suite.js';

describe('hostile file names on avatar, background, image, sprite and thumbnail routes', () => {
    const { rows, getHarness } = useRouteTable({
        '/api/avatars': () => import('../src/endpoints/avatars.js'),
        '/api/backgrounds': () => import('../src/endpoints/backgrounds.js'),
        '/api/images': () => import('../src/endpoints/images.js'),
        '/api/sprites': () => import('../src/endpoints/sprites.js'),
        '/thumbnail': () => import('../src/endpoints/thumbnails.js'),
    });

    test.each(rows)('$title refuses hostile names or keeps them inside the user folder', async (row) => {
        expect(await checkRow(getHarness(), row)).toEqual([]);
    }, ROW_TIMEOUT_MS);
});
