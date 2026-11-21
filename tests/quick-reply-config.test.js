import { beforeEach, describe, expect, jest, test } from '@jest/globals';

// The presentation adapters build shared rows and need a DOM; these tests are about the extension's own logic.
await jest.unstable_mockModule('../public/scripts/sillybunny-editor/adapters/utility-dialogs.js', () => ({
    adoptQuickReplyRow: () => {},
    adoptQuickReplySetLink: () => {},
    adoptQuickReplySetPicker: () => {},
}));

await jest.unstable_mockModule('../public/script.js', () => ({
    getRequestHeaders: jest.fn(() => ({})),
    substituteParams: value => value,
}));

await jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    Popup: class Popup {},
    POPUP_RESULT: { AFFIRMATIVE: 1 },
    POPUP_TYPE: { CONFIRM: 1 },
}));

await jest.unstable_mockModule('../public/scripts/slash-commands.js', () => ({
    executeSlashCommandsOnChatInput: jest.fn(),
    executeSlashCommandsWithOptions: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandScope.js', () => ({
    SlashCommandScope: class SlashCommandScope {},
}));

await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandParser.js', () => ({
    SlashCommandParser: class SlashCommandParser {
        parse() {
            return {
                execute: jest.fn(async () => ({ pipe: undefined })),
                scope: { setMacro: jest.fn() },
            };
        }
    },
}));

await jest.unstable_mockModule('../public/scripts/extensions/quick-reply/src/QuickReply.js', () => ({
    QuickReply: class QuickReply {},
}));

await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    debounceAsync: fn => fn,
    getSortableDelay: jest.fn(() => 0),
}));

const { QuickReplyConfig } = await import('../public/scripts/extensions/quick-reply/src/QuickReplyConfig.js');
const { QuickReplySet } = await import('../public/scripts/extensions/quick-reply/src/QuickReplySet.js');

function createSet(name) {
    return QuickReplySet.from({
        name,
        qrList: [],
    });
}

beforeEach(() => {
    QuickReplySet.list = [];
});

describe('Quick Reply config persisted set links', () => {
    test('resolves saved links to the canonical set when duplicate names were skipped on load', () => {
        const canonicalSet = createSet('Memory Sharding');
        QuickReplySet.list = [canonicalSet];

        const config = QuickReplyConfig.from({
            setList: [
                { set: ' memory sharding ', isVisible: true },
                { set: 'MEMORY SHARDING', isVisible: false },
            ],
        });

        expect(config.setList).toHaveLength(1);
        expect(config.setList[0].set).toBe(canonicalSet);
        expect(config.setList[0].isVisible).toBe(true);
    });

    test('removes all active links matching a normalized set name', () => {
        const canonicalSet = createSet('Memory Sharding');
        const duplicateSet = createSet(' memory sharding ');
        const otherSet = createSet('Other');
        const config = QuickReplyConfig.from({ setList: [] });
        config.setList = [
            { set: canonicalSet },
            { set: duplicateSet },
            { set: otherSet },
        ];
        config.updateSetListDom = jest.fn();
        config.onUpdate = jest.fn();

        config.removeSet(canonicalSet);

        expect(config.setList).toEqual([{ set: otherSet }]);
        expect(config.onUpdate).toHaveBeenCalledTimes(1);
        expect(config.updateSetListDom).toHaveBeenCalledTimes(1);
    });
});
