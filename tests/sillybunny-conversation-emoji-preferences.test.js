/** @jest-environment jsdom */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const writeModeKey = jest.fn();
const readModeSettings = jest.fn();
const applyEmojiFont = jest.fn();

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/details/access.js', () => ({
    readModeSettings,
    writeModeKey,
    conversationData: { subscribe: () => () => {} },
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/personas.js', () => ({
    getConnectionProfiles: () => [],
    getUserPersonaStatus: () => '',
    getUserStatus: () => 'online',
    setUserPersonaStatus: () => {},
    setUserStatus: () => {},
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({ normalizeConversationQuietHour: value => value }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/emoji/emoji-font.js', () => ({ applyEmojiFont }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/constants.js', () => ({ DEFAULT_GROUNDED_DIALOGUE_RULES: '' }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/details/details-logic.js', () => ({ getPageTitle: () => 'Preferences' }));
// The select row opens pickers that pull in the i18n tables; this page's other rows are not what the test is about.
await jest.unstable_mockModule('../public/scripts/sillybunny-editor/select-row.js', () => ({ createSelectRow: () => ({ row: document.createElement('div') }) }));
await jest.unstable_mockModule('../public/scripts/sillybunny-action-menu.js', () => ({ openActionMenu: () => {} }));

const { buildPreferences } = await import('../public/scripts/sillybunny-conversation/details/pages/preferences.js');

const settingsWith = overrides => ({
    grounded_dialogue_rules_enabled: false,
    lorebooks_enabled: true,
    simulate_reply_delay: true,
    connection_profile: '',
    custom_instructions: '',
    quiet_hours_start: '',
    quiet_hours_end: '',
    use_device_emoji: false,
    ...overrides,
});

function render(overrides = {}) {
    readModeSettings.mockReturnValue(settingsWith(overrides));
    const { content } = buildPreferences({ nav: { push() {} } });
    document.body.replaceChildren(content);
    return content;
}

const emojiSwitch = content => content.querySelector('[data-sb-editor-field="prefs-emoji"] input[role="switch"]');

beforeEach(() => {
    jest.clearAllMocks();
});

describe('the Use Device Emoji preference', () => {
    test('is a switch in a group of its own, named for what it does, off by default', () => {
        const content = render();
        const group = content.querySelector('[data-sb-editor-field="prefs-emoji"]');
        expect(group).not.toBeNull();
        expect(group.textContent).toContain('Use Device Emoji');
        expect(emojiSwitch(content)).not.toBeNull();
        expect(emojiSwitch(content).checked).toBe(false);
    });

    test('shows the saved choice', () => {
        const content = render({ use_device_emoji: true });
        expect(emojiSwitch(content).checked).toBe(true);
    });

    test('saves for the whole mode and applies the font at once, with no reload', () => {
        const content = render();
        const toggle = emojiSwitch(content);
        toggle.click();
        expect(writeModeKey).toHaveBeenCalledWith('use_device_emoji', true);
        expect(applyEmojiFont).toHaveBeenCalledWith({ useDeviceEmoji: true });
        toggle.click();
        expect(writeModeKey).toHaveBeenLastCalledWith('use_device_emoji', false);
        expect(applyEmojiFont).toHaveBeenLastCalledWith({ useDeviceEmoji: false });
    });

    test('leaves what the switch does to the maintainer, as a marked placeholder', () => {
        const content = render();
        const note = content.querySelector('[data-sb-editor-field="prefs-emoji"] [data-sb-copy-placeholder="true"]');
        expect(note?.textContent).toBe('TODO(copy)');
    });
});
