import { SAFE_TOAST_OPTIONS } from './constants.js';
import { getConversationGroupIdForAvatar, getCurrentCharAvatar } from './context.js';
import { generateSelfieFromContext } from './generation.js';
import { updateConversationMemorySummary } from './prompt.js';
import { scheduleTimelineRender } from './render-scheduler.js';
import { openScheduleEditorModal, renderConversationMemoryPanel } from './settings-panel.js';
import { getSettings } from './settings-store.js';
import { addConversationReminder, appendConversationThreadMessage } from './thread-store.js';
import { updateLastPreviewFromConversation } from './typing.js';

export function parseConversationSlashCommand(text) {
    const value = String(text || '').trim();
    if (!value.startsWith('/')) {
        return null;
    }

    const match = value.match(/^\/([a-z]+)(?:\s+([\s\S]*))?$/i);
    if (!match) {
        return null;
    }

    return {
        command: match[1].toLowerCase(),
        args: String(match[2] || '').trim(),
    };
}

export function parseConversationReminderArgs(args) {
    const value = String(args || '').trim();
    if (!value) {
        return null;
    }

    const [delayPart, ...memoParts] = value.split('|');
    if (memoParts.length) {
        const delay = delayPart.trim();
        const memo = memoParts.join('|').trim();
        return delay && memo ? { delay, memo } : null;
    }

    const [delay, ...memoWords] = value.split(/\s+/);
    const memo = memoWords.join(' ').trim();
    return delay && memo ? { delay, memo } : null;
}

export function appendConversationOocNote(note, { avatar = getCurrentCharAvatar(), groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const text = String(note || '').trim();
    if (!avatar || !text) {
        return false;
    }

    appendConversationThreadMessage(avatar, {
        role: 'system',
        name: 'OOC Note',
        mes: text,
        extra: {
            conversation_mode_ooc: true,
        },
    }, { groupId });
    updateLastPreviewFromConversation(avatar, { groupId });
    scheduleTimelineRender();
    return true;
}

export async function quickConversationSummarize() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        return;
    }

    const groupId = getConversationGroupIdForAvatar(avatar);
    await updateConversationMemorySummary(avatar, { force: true, groupId, notify: true });
    renderConversationMemoryPanel();
}

export async function handleConversationSlashAction(text, { avatar = getCurrentCharAvatar(), settings = null, groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const resolvedSettings = settings || getSettings(avatar, { groupId });
    const parsed = parseConversationSlashCommand(text);
    if (!parsed || !avatar) {
        return false;
    }

    switch (parsed.command) {
        case 'selfie': {
            const context = parsed.args || 'a casual selfie in the current DM conversation';
            await generateSelfieFromContext(context, resolvedSettings, avatar, { groupId, force: true, notify: true });
            return true;
        }
        case 'remind': {
            const reminder = parseConversationReminderArgs(parsed.args);
            if (!reminder) {
                globalThis.toastr?.warning?.('Use /remind 1h | message to schedule a reminder.', '', SAFE_TOAST_OPTIONS);
                return true;
            }

            addConversationReminder(avatar, groupId, reminder.delay, reminder.memo);
            return true;
        }
        case 'schedule':
            openScheduleEditorModal(avatar);
            return true;
        case 'summarize':
            await quickConversationSummarize();
            return true;
        case 'ooc':
            if (!parsed.args) {
                globalThis.toastr?.warning?.('Use /ooc followed by a note for the OOC channel.', '', SAFE_TOAST_OPTIONS);
                return true;
            }
            appendConversationOocNote(parsed.args, { avatar, groupId });
            return true;
        default:
            return false;
    }
}
