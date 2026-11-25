import { SCHEDULE_GENERATION_RESPONSE_TOKENS, SCHEDULE_STATUSES } from './constants.js';
import {
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getCurrentCharAvatar,
} from './context.js';
import { conversationData } from './conversation-data-browser.js';
import { generateConversationRaw } from './generation.js';
import { formatPromptText } from './shared-helpers.js';
import { getSettings } from './settings-store.js';
import { runtimeStatusOverrides } from './state.js';
import {
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

export function getConversationRuntimeStatusKey(avatar, personaId = getConversationPersonaId()) {
    return `${getConversationPersonaId(personaId)}\u001f${String(avatar || '').trim()}`;
}

export function getCurrentActivityFromSchedule(schedule, avatar = getCurrentCharAvatar(), now = new Date(), { personaId = getConversationPersonaId() } = {}) {
    return getCurrentActivityFromScheduleBase(schedule, getConversationRuntimeStatusKey(avatar, personaId), now, runtimeStatusOverrides);
}

/**
 * The routine of a character, as `characters.json` holds it: `enabled`, `text` (the schedule as JSON, `{ "days": ... }`,
 * so that its form can change without a change of the file) and `generatedAt`. A character has one routine for every
 * persona and every conversation, and it is off until the user turns it on.
 * @returns {{ enabled: boolean, text: string, generatedAt: number }|null} Null for a character that has never had one.
 */
export function getRoutine(avatar) {
    const routine = avatar ? conversationData.characterState(avatar).routine : null;
    if (!routine) {
        return null;
    }
    return {
        enabled: routine.enabled === true,
        text: typeof routine.text === 'string' ? routine.text : '',
        generatedAt: routine.generatedAt ?? 0,
    };
}

/** The schedule of a character that has its routine on; a routine that is off or whose text does not parse is no schedule. */
export function getStoredSchedule(avatar = getCurrentCharAvatar()) {
    const routine = getRoutine(avatar);
    if (!routine?.enabled || !routine.text) {
        return null;
    }

    try {
        const schedule = JSON.parse(routine.text);
        return schedule && typeof schedule === 'object' && !Array.isArray(schedule) ? { ...schedule, generatedAt: routine.generatedAt } : null;
    } catch {
        return null;
    }
}

function createMissingScheduleError(subject) {
    return new Error(`${subject} holds no schedule: it needs a time range and an activity in at least one day.`);
}

function storeRoutineDays(avatar, days, extra) {
    const text = JSON.stringify({ days });
    conversationData.patchCharacter(avatar, { routine: { ...extra, text } });
}

/**
 * Makes a new routine for a character from its card, and turns the routine on. The old routine stays when the model
 * answers no schedule.
 * @param {string} avatar
 * @param {{ character: object, groupId?: string, personaId?: string }} options `character` is the card to make it from.
 * @throws {Error} When there is no card, or the model answers no schedule.
 */
export async function regenerateRoutine(avatar, { character, groupId, personaId } = {}) {
    if (!avatar || !character) {
        throw new Error('A routine is made from the card of the character, and no card was given.');
    }

    const schedule = await generateCharacterSchedule(character, { groupId, personaId });
    if (!schedule) {
        throw new Error('The model answered no routine for this character. Try again.');
    }
    storeRoutineDays(avatar, schedule.days, { enabled: true, generatedAt: Date.now() });
}

/**
 * Turns the routine of a character on or off. The first time it is turned on the routine is made from the card; after
 * that the text that is stored is used again, also after it was turned off, so that a switch costs no request.
 * @param {string} avatar
 * @param {boolean} enabled
 * @param {{ character?: object, groupId?: string, personaId?: string }} [options] `character` is the card, needed when there is no routine text yet.
 * @throws {Error} When the routine has to be made and cannot be.
 */
export async function setRoutineEnabled(avatar, enabled, options = {}) {
    if (!avatar) {
        return;
    }

    const routine = getRoutine(avatar);
    if (!enabled) {
        if (routine) {
            conversationData.patchCharacter(avatar, { routine: { enabled: false } });
        }
        return;
    }
    if (routine?.text) {
        conversationData.patchCharacter(avatar, { routine: { enabled: true } });
        return;
    }
    await regenerateRoutine(avatar, options);
}

/**
 * Replaces the text of the routine with one that the user wrote. A text that reads as a schedule is stored in the form
 * of a generated routine; any other text is refused and the old one stays. The switch of the routine is not touched.
 * @throws {Error} When the text holds no schedule.
 */
export function setRoutineText(avatar, text) {
    const schedule = parseScheduleResponse(text);
    if (!avatar || !schedule) {
        throw createMissingScheduleError('This text');
    }
    storeRoutineDays(avatar, schedule.days, getRoutine(avatar) ? {} : { generatedAt: Date.now() });
}

/** The status that the user set for a character, or null while it follows its routine. */
export function getStatusOverride(avatar) {
    const status = avatar ? conversationData.characterState(avatar).statusOverride : null;
    return SCHEDULE_STATUSES.includes(status) ? status : null;
}

/**
 * What a character is doing now. The status that the user set wins; without one the character follows what it set for
 * itself with `[schedule_update]` while that lasts, then its routine, and a character with neither is online.
 * @returns {{ status: string, activity: string|null, source: 'manual'|'override'|'schedule'|'default' }} `source` is
 * `manual` for a status that needs no activity text (the user's status, and a character without a routine), so
 * `activity` is null there; the caller words it.
 */
export function getCharacterStatus(avatar, now = new Date(), { personaId = getConversationPersonaId() } = {}) {
    const override = getStatusOverride(avatar);
    if (override) {
        return { status: override, activity: null, source: 'manual' };
    }

    const schedule = getStoredSchedule(avatar);
    const current = getCurrentActivityFromSchedule(schedule, avatar, now, { personaId });
    return !schedule && current.source === 'default' ? { status: 'online', activity: null, source: 'manual' } : current;
}

/**
 * @param {string} avatar
 * @param {string|null} status One of the four statuses, or null to follow the routine again.
 * @throws {Error} For any other value.
 */
export function setStatusOverride(avatar, status) {
    if (status !== null && !SCHEDULE_STATUSES.includes(status)) {
        throw new Error(`"${status}" is not a status. Use one of ${SCHEDULE_STATUSES.join(', ')}, or null.`);
    }
    conversationData.patchCharacter(avatar, { statusOverride: status });
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
        'RESPOND IN EXACTLY THIS JSON FORMAT (no markdown, no code blocks, just raw JSON):',
        '{"days":{"0":[{"time":"08:00-12:00","activity":"working","status":"dnd"}],"1":[],"2":[],"3":[],"4":[],"5":[],"6":[]}}',
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
