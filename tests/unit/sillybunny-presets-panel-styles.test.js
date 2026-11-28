/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importTabsModule } from '../util/tabs-harness.js';

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
    jest.restoreAllMocks();
});

describe('Presets page deferred stylesheets', () => {
    test('opening the Presets page loads the entity list sheet for NovelAI Logit Bias entries', async () => {
        loaded = await importTabsModule();
        loaded.assets.loadStylesheetAsync.mockClear();

        loaded.shell.openTab('left', 'prompting');
        await loaded.flush();

        const loadedHrefs = loaded.assets.loadStylesheetAsync.mock.calls.map(([href]) => String(href));
        expect(loadedHrefs.some(href => href.startsWith('css/sillybunny-entity-list.css?v='))).toBe(true);
    });
});
