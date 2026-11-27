import {
    REACT_COMMAND_RE,
    REMINDER_COMMAND_RE,
    SCHEDULE_UPDATE_RE,
    SELFIE_COMMAND_RE,
} from './constants.js';
import { firstEmoji } from './emoji/emoji-validate.js';

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
    const originalText = String(rawText || '');
    let text = originalText;
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

    // The marker is always taken out, whether or not the character may react, so that a model that echoes it shows no
    // brackets. Its value is read here, before the quotes of the text go, and the first marker decides.
    let reaction = null;
    let reactionMarkerSeen = false;
    text = text.replace(REACT_COMMAND_RE, (full, value) => {
        if (!reactionMarkerSeen) {
            reaction = firstEmoji(String(value).trim().replace(/^["'`“”]+|["'`“”]+$/g, '')) || null;
        }
        reactionMarkerSeen = true;
        return '';
    });

    text = text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    text = normalizeConversationOutputText(text);

    // SillyBunny: bracket-command stripping must never blank a real reply. If the strip
    // pass consumed everything (e.g. the model echoed bracket labels it saw in the persona),
    // fall back to the original text so the user always sees a response. A reply that was
    // only a reaction is a reaction with no bubble, and shows no marker.
    if (!text && originalText.trim() && !reactionMarkerSeen) {
        text = normalizeConversationOutputText(originalText.trim());
    }

    return { text, selfieRequests, scheduleUpdates, reminders, reaction };
}

/** Splits a reply into chat bubbles at its blank lines. Lives here, with the other pure text rules, so that the reply planner does not import the page. */
export function splitChatroomMessages(text) {
    const parts = String(text || '')
        .split(/\n\s*\n+/)
        .map(part => part.trim())
        .filter(Boolean);
    return parts.length ? parts : [String(text || '').trim()].filter(Boolean);
}

export function hasCharacterReplyCommandSideEffects(commandParts) {
    return Boolean(commandParts?.scheduleUpdates?.length || commandParts?.reminders?.length);
}

export function getCharacterReplyCommandMetadata(commandParts) {
    const commands = {};
    if (Array.isArray(commandParts?.selfieRequests) && commandParts.selfieRequests.length) {
        commands.selfieRequests = [...commandParts.selfieRequests];
    }
    if (Array.isArray(commandParts?.scheduleUpdates) && commandParts.scheduleUpdates.length) {
        commands.scheduleUpdates = [...commandParts.scheduleUpdates];
    }
    if (Array.isArray(commandParts?.reminders) && commandParts.reminders.length) {
        commands.reminders = commandParts.reminders.map(reminder => ({ ...reminder }));
    }

    return Object.keys(commands).length ? commands : null;
}

export function buildSelfieImagePromptTemplate(generatedPrompt, configuredTemplate, context, fallbackTemplate = 'raw photo, selfie of {{char}}') {
    const prompt = String(generatedPrompt || '').trim();
    const scene = String(context || '').trim();
    const template = prompt || String(configuredTemplate || fallbackTemplate).trim() || fallbackTemplate;
    if (!scene || template.includes('{{scene}}') || template.toLowerCase().includes(scene.toLowerCase())) {
        return template;
    }

    return `${template}\nPhoto context: {{scene}}`;
}
