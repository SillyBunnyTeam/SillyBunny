import { SAFE_TOAST_OPTIONS } from './constants.js';
import { getConversationGroupIdForAvatar, getConversationPersonaId, getConversationRecord, getCurrentCharAvatar } from './context.js';
import { generateSelfieFromContext } from './generation.js';
import { updateConversationMemorySummary } from './prompt.js';
import { scheduleTimelineRender } from './render-scheduler.js';
import { openScheduleEditorModal, renderConversationMemoryPanel } from './settings-panel.js';
import { getSettings } from './settings-store.js';
import { addConversationReminder, appendConversationChatMessage } from './conversation-store.js';
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

export function appendConversationOocNote(note, { avatar = getCurrentCharAvatar(), chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const text = String(note || '').trim();
    if (!avatar || !text) {
        return false;
    }

    appendConversationChatMessage(avatar, {
        role: 'system',
        name: 'OOC Note',
        mes: text,
        extra: {
            conversation_mode_ooc: true,
        },
    }, { chatId, create: !chatId, groupId, personaId });
    updateLastPreviewFromConversation(avatar, { chatId, groupId, personaId });
    scheduleTimelineRender();
    return true;
}

export async function quickConversationSummarize({ avatar = getCurrentCharAvatar(), chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return;
    }

    const capturedChatId = chatId || getConversationRecord(avatar, { create: false, groupId, personaId })?.activeBranchId || '';
    await updateConversationMemorySummary(avatar, { chatId: capturedChatId, force: true, groupId, notify: true, personaId });
    renderConversationMemoryPanel();
}

export async function handleConversationSlashAction(text, { avatar = getCurrentCharAvatar(), chatId = '', settings = null, groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const capturedChatId = chatId || getConversationRecord(avatar, { create: false, groupId, personaId })?.activeBranchId || '';
    const resolvedSettings = settings || getSettings(avatar, { groupId, personaId });
    const parsed = parseConversationSlashCommand(text);
    if (!parsed || !avatar) {
        return false;
    }

    switch (parsed.command) {
        case 'selfie': {
            const context = parsed.args || 'a casual selfie in the current DM conversation';
            await generateSelfieFromContext(context, resolvedSettings, avatar, { chatId: capturedChatId, groupId, personaId, force: true, notify: true });
            return true;
        }
        case 'remind': {
            const reminder = parseConversationReminderArgs(parsed.args);
            if (!reminder) {
                globalThis.toastr?.warning?.('Use /remind 1h | message to schedule a reminder', '', SAFE_TOAST_OPTIONS);
                return true;
            }

            addConversationReminder(avatar, groupId, reminder.delay, reminder.memo, { chatId: capturedChatId, personaId });
            return true;
        }
        case 'schedule':
            openScheduleEditorModal(avatar);
            return true;
        case 'summarize':
            await quickConversationSummarize({ avatar, chatId: capturedChatId, groupId, personaId });
            return true;
        case 'ooc':
            if (!parsed.args) {
                globalThis.toastr?.warning?.('Use /ooc followed by a note for the OOC channel', '', SAFE_TOAST_OPTIONS);
                return true;
            }
            appendConversationOocNote(parsed.args, { avatar, chatId: capturedChatId, groupId, personaId });
            return true;
        default:
            return false;
    }
}
