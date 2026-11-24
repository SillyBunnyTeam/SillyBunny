import {
    DEFAULT_CONVERSATION_REPLY_MAX_TOKENS,
    MAX_CONVERSATION_REPLY_MAX_TOKENS,
    MIN_CONVERSATION_REPLY_MAX_TOKENS,
    SCHEDULE_GENERATION_RESPONSE_TOKENS,
    SCHEDULE_PREFIX,
} from './constants.js';
import {
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getCurrentCharAvatar,
    parsePositiveInt,
} from './context.js';
import { conversationData } from './conversation-data-browser.js';
import { generateConversationRaw } from './generation.js';
import { formatPromptText } from './shared-helpers.js';
import { getSettings } from './settings-store.js';
import { runtimeStatusOverrides } from './state.js';
import {
    clamp,
    getCurrentActivityFromSchedule as getCurrentActivityFromScheduleBase,
    parseScheduleResponse,
} from './schedule-utils.js';

export {
    clamp,
    inferStatusFromActivity,
    normalizeScheduleBlock,
    parseDurationToMs,
    parsePositiveIntValue,
    parseScheduleResponse,
    parseScheduleTimeRange,
    repairScheduleJson,
} from './schedule-utils.js';

export function getConversationReplyMaxTokens(settings = {}) {
    return clamp(
        parsePositiveInt(settings?.reply_max_tokens, DEFAULT_CONVERSATION_REPLY_MAX_TOKENS, MIN_CONVERSATION_REPLY_MAX_TOKENS),
        MIN_CONVERSATION_REPLY_MAX_TOKENS,
        MAX_CONVERSATION_REPLY_MAX_TOKENS,
    );
}

export function getScheduleStorageKey(avatar) {
    return `${SCHEDULE_PREFIX}${avatar}`;
}

export function getConversationRuntimeStatusKey(avatar, personaId = getConversationPersonaId()) {
    return `${getConversationPersonaId(personaId)}\u001f${String(avatar || '').trim()}`;
}

export function getCurrentActivityFromSchedule(schedule, avatar = getCurrentCharAvatar(), now = new Date(), { personaId = getConversationPersonaId() } = {}) {
    return getCurrentActivityFromScheduleBase(schedule, getConversationRuntimeStatusKey(avatar, personaId), now, runtimeStatusOverrides);
}

/**
 * The schedule of a character, from its routine in `characters.json`. The routine holds the schedule as JSON text, so
 * that its form can change without a change of the file; a routine that is off or that does not parse is no schedule.
 * A character has one routine for every persona and every conversation.
 */
export function getStoredSchedule(avatar = getCurrentCharAvatar()) {
    const routine = avatar ? conversationData.characterState(avatar).routine : null;
    if (!routine || routine.enabled === false || typeof routine.text !== 'string') {
        return null;
    }

    try {
        const schedule = JSON.parse(routine.text);
        return schedule && typeof schedule === 'object' && !Array.isArray(schedule) ? { ...schedule, generatedAt: routine.generatedAt ?? schedule.generatedAt } : null;
    } catch {
        return null;
    }
}

export function saveStoredSchedule(avatar, schedule) {
    if (!avatar) {
        return;
    }

    if (!schedule || typeof schedule !== 'object') {
        conversationData.patchCharacter(avatar, { routine: null });
        return;
    }

    const { generatedAt = Date.now(), ...rest } = schedule;
    conversationData.patchCharacter(avatar, { routine: { enabled: true, text: JSON.stringify(rest), generatedAt } });
}

export async function generateCharacterSchedule(character, { groupId = getConversationGroupIdForAvatar(character?.avatar), personaId = getConversationPersonaId() } = {}) {
    if (!character) {
        return null;
    }

    const name = character.name || 'The character';
    const description = formatPromptText(character.description || '', 1800);
    const personality = formatPromptText(character.personality || '', 1200);

    const systemPrompt = [
        'You are a schedule generator. Create a realistic weekly schedule for a character based on their personality and description.',
        'Each time block must include a "status" field indicating availability:',
        '- "online": awake and available (free time, socializing, casual activities)',
        '- "idle": semi-available (eating, commuting, showering, cooking)',
        '- "dnd": busy / do not disturb (working, studying, training, in a meeting, focused tasks)',
        '- "offline": unavailable (sleeping, passed out, unconscious)',
        'Also assess the character\'s talkativeness on a scale of 0-100 (how often they initiate contact).',
        'And estimate how long in minutes this character would wait before messaging someone who has not replied (very patient: 180-360, average: 90-150, eager: 15-60).',
        'RESPOND IN EXACTLY THIS JSON FORMAT (no markdown, no code blocks, just raw JSON):',
        '{"talkativeness":50,"inactivityThresholdMinutes":120,"days":{"0":[{"time":"08:00-12:00","activity":"working","status":"dnd"}],"1":[],"2":[],"3":[],"4":[],"5":[],"6":[]}}',
        'Days are keyed 0=Sunday through 6=Saturday. Cover each day with several blocks spanning a full 24 hours including sleep.',
    ].join('\n');

    const promptParts = [`Character name: ${name}`];
    if (description) {
        promptParts.push(`Description: ${description}`);
    }
    if (personality) {
        promptParts.push(`Personality: ${personality}`);
    }
    promptParts.push('Generate the weekly schedule JSON now.');

    const settings = getSettings(character.avatar, { groupId, personaId });
    const response = await generateConversationRaw({
        prompt: promptParts.join('\n\n'),
        systemPrompt,
        responseLength: SCHEDULE_GENERATION_RESPONSE_TOKENS,
        trimNames: false,
        cacheScope: 'conversation-mode-schedule',
    }, settings);

    return parseScheduleResponse(response);
}
