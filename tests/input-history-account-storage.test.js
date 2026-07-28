import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const accountStorageValues = new Map();
const accountStorage = {
    getItem: jest.fn(key => accountStorageValues.get(key) ?? null),
    setItem: jest.fn((key, value) => accountStorageValues.set(key, String(value))),
};

await jest.unstable_mockModule('../public/script.js', () => ({
    eventSource: { on: jest.fn() },
    event_types: {
        APP_READY: 'app_ready',
        GENERATION_STARTED: 'generation_started',
    },
    saveSettingsDebounced: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
    extension_settings: {},
}));

await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    delay: jest.fn(async () => {}),
    isTrueBoolean: jest.fn(value => value === true || value === 'true'),
}));

await jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({
    accountStorage,
}));

await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommand.js', () => ({
    SlashCommand: { fromProps: jest.fn(props => props) },
}));

await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandArgument.js', () => ({
    ARGUMENT_TYPE: { BOOLEAN: 'boolean', NUMBER: 'number', STRING: 'string' },
    SlashCommandArgument: { fromProps: jest.fn(props => props) },
    SlashCommandNamedArgument: { fromProps: jest.fn(props => props) },
}));

await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandParser.js', () => ({
    SlashCommandParser: { addCommandObject: jest.fn() },
}));

await jest.unstable_mockModule('../public/scripts/extensions/input-history/lib/wait.js', () => ({
    waitForFrame: jest.fn(async () => {}),
}));

const { getInputHistory, setInputHistory } = await import('../public/scripts/extensions/input-history/index.js');

beforeEach(() => {
    accountStorageValues.clear();
    accountStorage.getItem.mockClear();
    accountStorage.setItem.mockClear();
});

describe('input history account storage', () => {
    test('reads and writes the existing key synchronously with unchanged JSON values', () => {
        accountStorageValues.set('st--inputHistory', '["first","second"]');

        expect(getInputHistory()).toEqual(['first', 'second']);

        setInputHistory(['new value']);

        expect(accountStorage.getItem).toHaveBeenCalledWith('st--inputHistory');
        expect(accountStorage.setItem).toHaveBeenCalledWith('st--inputHistory', '["new value"]');
        expect(accountStorageValues.get('st--inputHistory')).toBe('["new value"]');
    });

    test('keeps the existing empty-history fallback for invalid persisted JSON', () => {
        accountStorageValues.set('st--inputHistory', 'not-json');

        expect(getInputHistory()).toEqual([]);
    });
});
