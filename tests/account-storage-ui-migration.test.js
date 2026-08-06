/* global globalThis */
import { afterAll, describe, expect, jest, test } from '@jest/globals';

const saveSettingsDebounced = jest.fn();

await jest.unstable_mockModule('../public/script.js', () => ({
    saveSettingsDebounced,
}));

const { accountStorage } = await import('../public/scripts/util/AccountStorage.js');

function createLocalStorage(entries) {
    const values = new Map(entries);

    return {
        values,
        get length() {
            return values.size;
        },
        getItem: jest.fn(key => values.get(key) ?? null),
        key: jest.fn(index => [...values.keys()][index] ?? null),
        removeItem: jest.fn(key => values.delete(key)),
    };
}

afterAll(() => {
    delete globalThis.localStorage;
});

describe('account storage UI migration', () => {
    test('moves exact legacy values into missing account keys without migrating device trust controls', () => {
        const legacyValues = [
            ['ica--agent-list-tab', 'companion'],
            ['ica--tracker-panel-handle-top-v2', '{"edge":"left","fraction":0.25}'],
            ['ica--tracker-panel-locked', 'true'],
            ['pathfinder-collapsed-sections', '{"retrieval":true}'],
            ['pathfinder-quickstart-dismissed', 'true'],
            ['pathfinder-retrieval-log-mode', 'detailed'],
            ['pathfinder-summary-memory-state', '{"title":"Exact legacy summary"}'],
            ['st--inputHistory', '["first","second"]'],
            ['card_scripts_confirmed', 'true'],
            ['sillybunny.chatRenderLifecycle.enabled', 'false'],
        ];
        const localStorage = createLocalStorage(legacyValues);
        globalThis.localStorage = localStorage;

        accountStorage.init({
            __migrated: '1',
            'ica--agent-list-tab': 'pre',
        });

        expect(accountStorage.getState()).toEqual(expect.objectContaining({
            __migrated: '2',
            'ica--agent-list-tab': 'pre',
            'ica--tracker-panel-handle-top-v2': '{"edge":"left","fraction":0.25}',
            'ica--tracker-panel-locked': 'true',
            'pathfinder-collapsed-sections': '{"retrieval":true}',
            'pathfinder-quickstart-dismissed': 'true',
            'pathfinder-retrieval-log-mode': 'detailed',
            'pathfinder-summary-memory-state': '{"title":"Exact legacy summary"}',
            'st--inputHistory': '["first","second"]',
        }));
        expect(localStorage.values).toEqual(new Map([
            ['card_scripts_confirmed', 'true'],
            ['sillybunny.chatRenderLifecycle.enabled', 'false'],
        ]));
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });
});
