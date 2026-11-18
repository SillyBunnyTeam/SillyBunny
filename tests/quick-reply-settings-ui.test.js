import { describe, expect, jest, test } from '@jest/globals';

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
    Popup: { show: { confirm: jest.fn(), input: jest.fn() } },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
    POPUP_TYPE: { CONFIRM: 1 },
}));

await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
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

await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    debounceAsync: fn => fn,
    getSortableDelay: jest.fn(() => 0),
}));

await jest.unstable_mockModule('../public/scripts/extensions/quick-reply/src/QuickReply.js', () => ({
    QuickReply: class QuickReply {},
}));

await jest.unstable_mockModule('../public/scripts/extensions/quick-reply/src/QuickReplySettings.js', () => ({
    QuickReplySettings: class QuickReplySettings {},
}));

const { SettingsUi } = await import('../public/scripts/extensions/quick-reply/src/ui/SettingsUi.js');

function createLink(name) {
    return { set: { name } };
}

describe('Quick Reply settings deletion', () => {
    test('purges matching links by normalized set name across every active scope', async () => {
        const settings = {
            config: {
                setList: [
                    createLink('Memory Sharding'),
                    createLink(' memory sharding '),
                    createLink('Global Other'),
                ],
            },
            chatConfig: {
                setList: [
                    createLink('MEMORY SHARDING'),
                    createLink('Chat Other'),
                ],
            },
            charConfig: {
                setList: [
                    createLink('Memory Sharding'),
                    createLink('Character Other'),
                ],
            },
            save: jest.fn(),
        };
        const deletedSet = {
            name: 'Memory Sharding',
            delete: jest.fn(async () => true),
        };

        const ui = new SettingsUi(settings);
        await ui.doDeleteQrSet(deletedSet);

        expect(deletedSet.delete).toHaveBeenCalledTimes(1);
        expect(settings.config.setList).toEqual([createLink('Global Other')]);
        expect(settings.chatConfig.setList).toEqual([createLink('Chat Other')]);
        expect(settings.charConfig.setList).toEqual([createLink('Character Other')]);
        expect(settings.save).toHaveBeenCalledTimes(1);
    });

    test('keeps active links when set deletion fails', async () => {
        const settings = {
            config: {
                setList: [
                    createLink('Memory Sharding'),
                    createLink('Global Other'),
                ],
            },
            chatConfig: {
                setList: [
                    createLink('Memory Sharding'),
                    createLink('Chat Other'),
                ],
            },
            charConfig: {
                setList: [
                    createLink('Memory Sharding'),
                    createLink('Character Other'),
                ],
            },
            save: jest.fn(),
        };
        const deletedSet = {
            name: 'Memory Sharding',
            delete: jest.fn(async () => false),
        };

        const ui = new SettingsUi(settings);
        await expect(ui.doDeleteQrSet(deletedSet)).resolves.toBe(false);

        expect(deletedSet.delete).toHaveBeenCalledTimes(1);
        expect(settings.config.setList).toEqual([createLink('Memory Sharding'), createLink('Global Other')]);
        expect(settings.chatConfig.setList).toEqual([createLink('Memory Sharding'), createLink('Chat Other')]);
        expect(settings.charConfig.setList).toEqual([createLink('Memory Sharding'), createLink('Character Other')]);
        expect(settings.save).not.toHaveBeenCalled();
    });
});
