/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importTabsModule } from './util/tabs-harness.js';

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
    jest.restoreAllMocks();
});

describe('preset/API sync lifecycle wiring', () => {
    test('resolves active main API through preset-api-sync-lifecycle for Connections panel', async () => {
        let capturedGetActiveApi = null;
        loaded = await importTabsModule({
            context: { mainApi: '  TEXTGENERATIONWEBUI  ' },
            mocks: {
                'scripts/sillybunny-connections-panel.js': {
                    createConnectionsPanel: jest.fn(options => {
                        capturedGetActiveApi = options.getActiveApi;
                        return { column: document.createElement('div'), sync: jest.fn() };
                    }),
                },
            },
        });

        expect(typeof capturedGetActiveApi).toBe('function');

        const mainApiSelect = /** @type {HTMLSelectElement} */ (document.getElementById('main_api'));
        mainApiSelect.value = 'novel';
        expect(capturedGetActiveApi()).toBe('novel');

        // Empty select falls back to context.mainApi, normalized by preset-api-sync-lifecycle.
        mainApiSelect.value = '';
        expect(capturedGetActiveApi()).toBe('textgenerationwebui');

        // Whitespace and casing on select values are normalized too.
        const customOpt = document.createElement('option');
        customOpt.value = '  OpenAI  ';
        mainApiSelect.append(customOpt);
        mainApiSelect.value = '  OpenAI  ';
        expect(capturedGetActiveApi()).toBe('openai');
    });
});
