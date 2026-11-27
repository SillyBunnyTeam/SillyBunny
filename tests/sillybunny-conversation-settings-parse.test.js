import { describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/script.js', () => ({ characters: [], saveSettingsDebounced: jest.fn(), this_chid: undefined }));
await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ extension_settings: {} }));
await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ groups: [], selected_group: null }));
await jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: 'persona-a.png' }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-data-browser.js', () => ({ conversationData: {} }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({ getCharacterForAvatar: () => null }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({ conversationState: {} }));

const { isConversationQuietHoursActive, safeParseSettings, shouldSurfaceConversationNotification } = await import('../public/scripts/sillybunny-conversation/context.js');
const { DEFAULT_SETTINGS } = await import('../public/scripts/sillybunny-conversation/constants.js');

const at = (hours, minutes = 0) => new Date(2026, 6, 27, hours, minutes);

describe('the settings of the mode as they are read', () => {
    test('hold the defaults of the keys that the rework keeps, and none of the keys that it removed', () => {
        const settings = safeParseSettings({});

        expect(settings).toMatchObject({ proactive_messaging: false, inactivity_threshold: 120, max_followups: 3, notifications_muted: false, simulate_reply_delay: true, quiet_hours_start: '', quiet_hours_end: '' });
        for (const removed of [
            'enabled', 'idle_action', 'idle_followup', 'idle_spontaneous', 'idle_limit', 'cooldown', 'auto_message', 'weekly_schedule',
            'ai_schedule', 'auto_schedule', 'schedule_generated_at', 'auto_character_chat', 'auto_chat_cooldown', 'auto_chat_names',
            'multi_char', 'talkativeness', 'reply_delay_multiplier', 'reply_max_tokens', 'copy_memory_to_new_branch',
            'notification_priority', 'editable_messages', 'selfie_prompt',
        ]) {
            expect(Object.keys(settings)).not.toContain(removed);
            expect(Object.keys(DEFAULT_SETTINGS)).not.toContain(removed);
        }
    });

    test('keep Simulate reply delay on unless it was turned off', () => {
        expect(safeParseSettings({ simulate_reply_delay: false }).simulate_reply_delay).toBe(false);
        expect(safeParseSettings({ simulate_reply_delay: 0 }).simulate_reply_delay).toBe(true);
        expect(safeParseSettings(JSON.stringify({ simulate_reply_delay: true })).simulate_reply_delay).toBe(true);
    });

    test('keep a quiet hour only when it reads as HH:MM', () => {
        expect(safeParseSettings({ quiet_hours_start: '9:05', quiet_hours_end: '25:00' })).toMatchObject({ quiet_hours_start: '09:05', quiet_hours_end: '' });
    });
});

describe('the notifications of a conversation', () => {
    test('show for a conversation that is not muted, outside of quiet hours', () => {
        expect(shouldSurfaceConversationNotification({ notifications_muted: false, quiet_hours_start: '', quiet_hours_end: '' }, at(12))).toBe(true);
        expect(shouldSurfaceConversationNotification({}, at(12))).toBe(true);
    });

    test('are silent for a muted conversation, whatever the hour', () => {
        expect(shouldSurfaceConversationNotification({ notifications_muted: true }, at(12))).toBe(false);
    });

    test('are silent inside the quiet hours of the mode, also when they cross midnight', () => {
        const night = { quiet_hours_start: '22:00', quiet_hours_end: '07:00' };

        expect(shouldSurfaceConversationNotification(night, at(23))).toBe(false);
        expect(shouldSurfaceConversationNotification(night, at(6, 59))).toBe(false);
        expect(shouldSurfaceConversationNotification(night, at(7))).toBe(true);
        expect(shouldSurfaceConversationNotification(night, at(12))).toBe(true);
        expect(shouldSurfaceConversationNotification({ quiet_hours_start: '13:00', quiet_hours_end: '14:00' }, at(13, 30))).toBe(false);
    });

    test('have no quiet hours when the window is empty, has one end, or starts where it ends', () => {
        expect(isConversationQuietHoursActive({ quiet_hours_start: '', quiet_hours_end: '' }, at(3))).toBe(false);
        expect(isConversationQuietHoursActive({ quiet_hours_start: '22:00', quiet_hours_end: '' }, at(23))).toBe(false);
        expect(isConversationQuietHoursActive({ quiet_hours_start: '08:00', quiet_hours_end: '08:00' }, at(8))).toBe(false);
    });

    test('ignore the old per-conversation priority', () => {
        expect(shouldSurfaceConversationNotification({ notification_priority: 'silent' }, at(12))).toBe(true);
        expect(shouldSurfaceConversationNotification({ notification_priority: 'priority', quiet_hours_start: '22:00', quiet_hours_end: '07:00' }, at(23))).toBe(false);
    });
});
