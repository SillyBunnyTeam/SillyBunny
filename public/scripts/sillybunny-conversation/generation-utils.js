import {
    REMINDER_COMMAND_RE,
    SCHEDULE_UPDATE_RE,
    SELFIE_COMMAND_RE,
} from './constants.js';

export function parseCommandArgs(rawArgs) {
    const args = {};
    const re = /(\w+)\s*=\s*"([^"]*)"/g;
    let match;
    while ((match = re.exec(rawArgs)) !== null) {
        args[match[1].toLowerCase()] = match[2];
    }
    return args;
}

export function normalizeConversationOutputText(rawText) {
    let text = String(rawText || '').trim();
    let changed = true;
    while (changed) {
        changed = false;
        const normalized = text
            .replace(/[“”]"([^"\n]{1,240})"[“”]/g, '"$1"')
            .replace(/"[“”]([^“”\n]{1,240})[“”]"/g, '"$1"')
            .replace(/^[“”]+/, '"')
            .replace(/[“”]+$/, '"')
            .replace(/^['"]{2,}\s*/, '"')
            .replace(/\s*['"]{2,}$/, '"')
            .replace(/^"([\s\S]*)"$/, '$1')
            .replace(/[“”"]/g, '')
            .replace(/\s+([?!.,:;])/g, '$1')
            .trim();
        if (normalized !== text) {
            text = normalized;
            changed = true;
        }
    }
    return text;
}

export function extractCharacterReplyCommandParts(rawText, settings = {}) {
    let text = String(rawText || '');
    const scheduleUpdates = [];
    const selfieRequests = [];
    const reminders = [];

    if (settings.schedule_command_enabled) {
        text = text.replace(SCHEDULE_UPDATE_RE, (full, rawArgs) => {
            scheduleUpdates.push(rawArgs);
            return '';
        });
    }

    if (settings.selfie_command_enabled) {
        text = text.replace(SELFIE_COMMAND_RE, (full, context) => {
            selfieRequests.push((context || '').trim());
            return '';
        });
    }

    text = text.replace(REMINDER_COMMAND_RE, (full, delay, memo) => {
        reminders.push({ delay: String(delay || '').trim(), memo: String(memo || '').trim() });
        return '';
    });

    text = text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    text = normalizeConversationOutputText(text);
    return { text, selfieRequests, scheduleUpdates, reminders };
}
