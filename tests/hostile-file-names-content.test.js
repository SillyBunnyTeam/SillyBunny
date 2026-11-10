import { describe, expect, test } from '@jest/globals';

import { checkRow } from './util/hostile-file-names-harness.js';
import { ROW_TIMEOUT_MS, useRouteTable } from './util/hostile-file-names-suite.js';

describe('hostile file names on theme, preset, World Info, agent and workflow routes', () => {
    const { rows, getHarness } = useRouteTable({
        '/api/themes': () => import('../src/endpoints/themes.js'),
        '/api/quick-replies': () => import('../src/endpoints/quick-replies.js'),
        '/api/moving-ui': () => import('../src/endpoints/moving-ui.js'),
        '/api/presets': () => import('../src/endpoints/presets.js'),
        '/api/worldinfo': () => import('../src/endpoints/worldinfo.js'),
        '/api/in-chat-agents': () => import('../src/endpoints/in-chat-agents.js'),
        '/api/sd': () => import('../src/endpoints/stable-diffusion.js'),
    });

    test.each(rows)('$title refuses hostile names or keeps them inside the user folder', async (row) => {
        expect(await checkRow(getHarness(), row)).toEqual([]);
    }, ROW_TIMEOUT_MS);
});
