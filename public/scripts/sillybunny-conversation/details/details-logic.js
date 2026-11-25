/**
 * What the details window decides without touching the page: who is listed where, what removing a member does, how one
 * setting row is stored, what a conversation shares, and how a routine reads as text. The pages call these functions and
 * draw the answer; they import nothing from the browser, so that the unit tests run them as they are.
 */

import { MEDIA_TYPE } from '../../constants.js';
import {
    DEFAULT_SETTINGS,
    GLOBAL_CONVERSATION_SETTINGS_KEY_SET,
    MAX_INACTIVITY_THRESHOLD,
    MIN_INACTIVITY_THRESHOLD,
} from '../constants.js';
import { isPendingServerReply } from '../pending-reply.js';

/** A group of up to this many members lists them on General (Fractal's rule for fewer than five); a bigger one has the Members page. */
export const INLINE_MEMBER_LIMIT = 4;
/** The most member pictures that tile the avatar of a group that has no picture of its own. */
export const AVATAR_TILE_LIMIT = 4;

const PAGE_TITLES = Object.freeze({
    general: 'Details',
    edit: 'Edit Details',
    members: 'Members',
    'add-member': 'Add Member',
    chats: 'Chats',
    media: 'Media',
    files: 'Files',
    pinned: 'Pinned',
    behaviour: 'Behaviour',
    advanced: 'Advanced',
    preferences: 'Preferences',
});

export function getPageTitle(pageId) {
    return PAGE_TITLES[pageId] ?? pageId;
}

// ---------------------------------------------------------------------------------------------------------------------
// People

export function listsMembersInline(view) {
    return view?.kind === 'group' && view.characters.length <= INLINE_MEMBER_LIMIT;
}

/**
 * The page that lists the people of a conversation for removal: the members of a group, or the extras that a direct
 * conversation still has. A direct conversation without extras has none.
 * @returns {{ title: 'Members'|'Extras', avatars: string[], kind: 'member'|'extra' }|null}
 */
export function getMembersPage(view) {
    if (view?.kind === 'group') {
        return { title: 'Members', avatars: [...view.characters], kind: 'member' };
    }
    if (view?.extras?.length) {
        return { title: 'Extras', avatars: [...view.extras], kind: 'extra' };
    }
    return null;
}

/**
 * What the Remove button of a member row does. A group keeps at least two members, so removing the second-to-last one
 * converts it into the direct conversation of the member that is left, which the user confirms first.
 * @returns {{ action: 'remove', avatar: string }|{ action: 'convert', avatar: string, remaining: string }|{ action: 'none', avatar: string }}
 */
export function planMemberRemoval(view, avatar) {
    if (view?.kind !== 'group' || !view.characters.includes(avatar)) {
        return { action: 'none', avatar };
    }
    if (view.characters.length > 2) {
        return { action: 'remove', avatar };
    }
    const remaining = view.characters.find(member => member !== avatar);
    return remaining ? { action: 'convert', avatar, remaining } : { action: 'none', avatar };
}

/** The members whose pictures tile a group avatar: the first few that are different from each other and named. */
export function pickTileAvatars(characters, limit = AVATAR_TILE_LIMIT) {
    const picked = [];
    for (const avatar of Array.isArray(characters) ? characters : []) {
        if (avatar && !picked.includes(avatar)) {
            picked.push(avatar);
        }
        if (picked.length === limit) {
            break;
        }
    }
    return picked;
}

// ---------------------------------------------------------------------------------------------------------------------
// One setting per row

/** The two keys of `DEFAULT_SETTINGS` that the conversation file has no place for: the status is the character's, the extras are a list of their own. */
const NOT_STORED_IN_THE_CONVERSATION = new Set(['availability', 'multi_char_names']);
/** The conversation file calls the system prompt `system_prompt`; the rest of the mode still reads the old key. */
const STORED_NAME = Object.freeze({ geechan_chatroom_prompt: 'system_prompt' });
const NUMBER_LIMITS = Object.freeze({
    inactivity_threshold: { min: MIN_INACTIVITY_THRESHOLD, max: MAX_INACTIVITY_THRESHOLD },
    max_followups: { min: 1, max: 3 },
    image_gen_cooldown: { min: 0, max: 1440 },
});

function normalizeSettingValue(key, value) {
    const fallback = DEFAULT_SETTINGS[key];
    if (typeof fallback === 'boolean') {
        return Boolean(value);
    }
    if (typeof fallback === 'number') {
        const number = Number(value);
        const limits = NUMBER_LIMITS[key];
        if (!Number.isFinite(number) || value === '' || value === null) {
            return fallback;
        }
        return limits ? Math.min(limits.max, Math.max(limits.min, Math.round(number))) : number;
    }
    return String(value ?? '');
}

/**
 * How one setting row is written. A mode-wide key goes to `settings.json` with its value. A per-conversation key goes to the
 * conversation file under its stored name, and a value that equals the default is written as `null`, which removes it, so
 * that the file holds only what differs from the defaults.
 * @param {string} key A key of `DEFAULT_SETTINGS`.
 * @param {any} value
 * @returns {{ scope: 'mode'|'conversation', name: string, value: boolean|number|string|null }}
 * @throws {RangeError} For a key that is not a setting, or one that the conversation file does not hold.
 */
export function describeSettingWrite(key, value) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key) || NOT_STORED_IN_THE_CONVERSATION.has(key)) {
        throw new RangeError(`"${key}" is not a setting that a row can store.`);
    }
    const normalized = normalizeSettingValue(key, value);
    if (GLOBAL_CONVERSATION_SETTINGS_KEY_SET.has(key)) {
        return { scope: 'mode', name: key, value: normalized };
    }
    return {
        scope: 'conversation',
        name: STORED_NAME[key] ?? key,
        value: normalized === DEFAULT_SETTINGS[key] ? null : normalized,
    };
}

// ---------------------------------------------------------------------------------------------------------------------
// Media, Files and Pinned

/**
 * @typedef {object} SharedItem
 * @property {string} key The same on every read, so that a list keeps its rows.
 * @property {string} messageId
 * @property {number} createdAt
 * @property {string} senderRole
 * @property {string} senderName
 * @property {string} memberAvatar The avatar file of the member who sent it, for a group.
 */

function senderOf(message) {
    return {
        messageId: String(message.id),
        createdAt: Number(message.created_at) || 0,
        senderRole: String(message.role ?? ''),
        senderName: String(message.name ?? ''),
        memberAvatar: String(message.extra?.member_avatar ?? ''),
    };
}

/**
 * Sorts what the messages of a chat share into the three pages that replace the filter tabs: pictures and videos (Media),
 * documents and sound (Files), and pinned messages (Pinned), each with the newest first.
 * @param {Record<string, any>[]|undefined} messages The loaded messages of one chat.
 * @returns {{ media: (SharedItem & { kind: 'image'|'video', url: string, title: string })[], files: (SharedItem & { kind: 'file'|'audio', url: string, name: string, size: number|undefined })[], pinned: (SharedItem & { text: string })[] }}
 */
export function collectSharedItems(messages) {
    const media = [];
    const files = [];
    const pinned = [];
    for (const message of Array.isArray(messages) ? messages : []) {
        if (!message || typeof message !== 'object' || !message.id || isPendingServerReply(message)) {
            continue;
        }
        const from = senderOf(message);
        const extra = message.extra ?? {};
        if (typeof extra.image_url === 'string' && extra.image_url) {
            media.push({ ...from, key: `${message.id}:image`, kind: 'image', url: extra.image_url, title: String(extra.image_prompt ?? '') });
        }
        (Array.isArray(extra.media) ? extra.media : []).forEach((item, index) => {
            if (!item?.url) {
                return;
            }
            const type = String(item.type || MEDIA_TYPE.IMAGE);
            const title = String(item.title ?? '');
            if (type === MEDIA_TYPE.AUDIO) {
                files.push({ ...from, key: `${message.id}:media:${index}`, kind: 'audio', url: item.url, name: title, size: undefined });
            } else {
                media.push({ ...from, key: `${message.id}:media:${index}`, kind: type === MEDIA_TYPE.VIDEO ? 'video' : 'image', url: item.url, title });
            }
        });
        (Array.isArray(extra.files) ? extra.files : []).forEach((item, index) => {
            if (item?.url) {
                files.push({ ...from, key: `${message.id}:file:${index}`, kind: 'file', url: item.url, name: String(item.name ?? ''), size: Number.isFinite(item.size) ? item.size : undefined });
            }
        });
        if (extra.conversation_pinned) {
            pinned.push({ ...from, key: `${message.id}:pin`, text: String(message.mes ?? '') });
        }
    }
    const newestFirst = (left, right) => right.createdAt - left.createdAt;
    return { media: media.sort(newestFirst), files: files.sort(newestFirst), pinned: pinned.sort(newestFirst) };
}

export function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return '';
    }
    if (bytes < 1024) {
        return `${Math.round(bytes)} B`;
    }
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(1)} ${units[unit]}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reminders

/**
 * The reminders that the Behaviour page lists: the ones that wait, and the ones that gave up or lost their chat, so
 * that the user sees why nothing arrived. A delivered one is done. Soonest first.
 * @param {{ id: string, text?: string, triggerAt: number, chatId?: string, state: string }[]} reminders As `conversationData.reminders()` answers.
 */
export function listReminders(reminders) {
    return (Array.isArray(reminders) ? reminders : [])
        .filter(reminder => reminder.state !== 'delivered')
        .map(reminder => ({
            id: reminder.id,
            text: String(reminder.text ?? '').trim() || 'Reminder',
            triggerAt: reminder.triggerAt,
            chatId: reminder.chatId ?? '',
            state: reminder.state,
        }))
        .sort((left, right) => left.triggerAt - right.triggerAt);
}

// ---------------------------------------------------------------------------------------------------------------------
// Dates

function dayNumber(timestamp, { locale, timeZone }) {
    const parts = new Intl.DateTimeFormat(locale, { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(timestamp);
    const part = type => Number(parts.find(item => item.type === type)?.value);
    return Math.floor(Date.UTC(part('year'), part('month') - 1, part('day')) / 86_400_000);
}

/**
 * A time as a row shows it: "Today, 9:05 AM", "Yesterday, 11:30 PM", "Nov 3", or "Dec 30, 2025" for an earlier year.
 * @param {number|undefined} timestamp Milliseconds; 0 or missing gives an empty text.
 * @param {number} now
 * @param {{ locale?: string, timeZone?: string }} [options]
 */
export function formatWhen(timestamp, now = Date.now(), { locale, timeZone } = {}) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return '';
    }
    const zone = { locale, timeZone };
    const age = dayNumber(now, zone) - dayNumber(timestamp, zone);
    if (age === 0 || age === 1) {
        // Current ICU puts a narrow no-break space before AM and PM; a plain space wraps a row the way the rest of its text does.
        const time = new Intl.DateTimeFormat(locale, { timeZone, hour: 'numeric', minute: '2-digit' }).format(timestamp).replace(/\s/g, ' ');
        return `${age === 0 ? 'Today' : 'Yesterday'}, ${time}`;
    }
    const sameYear = new Intl.DateTimeFormat(locale, { timeZone, year: 'numeric' }).format(timestamp) === new Intl.DateTimeFormat(locale, { timeZone, year: 'numeric' }).format(now);
    return new Intl.DateTimeFormat(locale, { timeZone, month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }).format(timestamp);
}

// ---------------------------------------------------------------------------------------------------------------------
// Signatures: what a page shows, as one string, so that a page is rebuilt only when it would look different

/**
 * What General draws apart from its Notifications row, which updates in place so that a press on it keeps its focus. A
 * message that arrives changes none of it, so an open page is not rebuilt under the user's hand.
 */
export function getGeneralSignature(view) {
    return JSON.stringify([
        view.kind,
        view.name,
        view.description,
        view.avatar,
        view.characters,
        view.extras,
        (view.chats ?? []).map(chat => [chat.id, chat.name]),
    ]);
}

/** What the Chats page draws: each chat's name, size and time, and which one is open. */
export function getChatsSignature(view) {
    return JSON.stringify([
        view.activeChatId,
        (view.chats ?? []).map(chat => [chat.id, chat.name, chat.messageCount ?? 0, chat.lastMessageAt ?? 0, chat.preview ?? '', chat.unread ?? 0]),
    ]);
}

// ---------------------------------------------------------------------------------------------------------------------
// The routine as text

const DAY_NAMES = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
const STATUS_AT_END = /\s*\((online|idle|dnd|offline)\)\s*$/i;
const BLOCK_LINE = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s+(\S.*)$/;

function parseDayHeading(line) {
    const match = /^(sun|mon|tue|wed|thu|fri|sat)[a-z]*:?$/i.exec(line);
    return match ? DAY_NAMES.findIndex(name => name.slice(0, 3).toLowerCase() === match[1].toLowerCase()) : -1;
}

function isClockTime(hours, minutes, { allowMidnightEnd = false } = {}) {
    if (minutes > 59) {
        return false;
    }
    return hours < 24 || (allowMidnightEnd && hours === 24 && minutes === 0);
}

const pad = number => String(number).padStart(2, '0');

/**
 * The stored routine (`{ days: { 0: [{ time, activity, status }] } }` as JSON) as text that a person edits: the day, then
 * one block to a line, `09:00-17:00 working (dnd)`. Days without blocks are left out.
 * @returns {string} Empty for text that holds no schedule.
 */
export function routineToText(storedText) {
    let schedule;
    try {
        schedule = JSON.parse(storedText);
    } catch {
        return '';
    }
    if (!schedule?.days || typeof schedule.days !== 'object') {
        return '';
    }
    const sections = [];
    DAY_NAMES.forEach((name, day) => {
        const blocks = Array.isArray(schedule.days[day]) ? schedule.days[day] : [];
        const lines = blocks
            .filter(block => block?.time && block?.activity)
            .map(block => `${block.time} ${block.activity}${block.status ? ` (${block.status})` : ''}`);
        if (lines.length) {
            sections.push([name, ...lines].join('\n'));
        }
    });
    return sections.join('\n\n');
}

/**
 * The text of {@link routineToText} back into the stored form. A block without a status is stored without one, and the
 * schedule reader infers it from the activity.
 * @returns {string} JSON, as `setRoutineText` takes it.
 * @throws {Error} Naming the line, for a block before the first day, a line that is no block, a time that is no time, or text without a block.
 */
export function textToRoutine(text) {
    const days = Object.fromEntries(DAY_NAMES.map((_, day) => [day, []]));
    let current = -1;
    let blocks = 0;
    String(text ?? '').split(/\r?\n/).forEach((raw, index) => {
        const line = raw.trim();
        if (!line) {
            return;
        }
        const heading = parseDayHeading(line);
        if (heading >= 0) {
            current = heading;
            return;
        }
        const match = BLOCK_LINE.exec(line);
        if (!match) {
            throw new Error(`Line ${index + 1} is not a block. Write a time range and an activity, such as 09:00-17:00 working.`);
        }
        const [startHours, startMinutes, endHours, endMinutes] = match.slice(1, 5).map(Number);
        if (!isClockTime(startHours, startMinutes) || !isClockTime(endHours, endMinutes, { allowMidnightEnd: true })) {
            throw new Error(`Line ${index + 1} has a time that is not on the clock.`);
        }
        if (current < 0) {
            throw new Error(`Line ${index + 1} comes before a day. Start each day with its name, such as Monday.`);
        }
        const statusMatch = STATUS_AT_END.exec(match[5]);
        const activity = (statusMatch ? match[5].slice(0, statusMatch.index) : match[5]).trim();
        days[current].push({
            time: `${pad(startHours)}:${pad(startMinutes)}-${pad(endHours)}:${pad(endMinutes)}`,
            activity,
            ...(statusMatch ? { status: statusMatch[1].toLowerCase() } : {}),
        });
        blocks += 1;
    });
    if (!blocks) {
        throw new Error('The routine has no blocks. Write at least one day with a time range and an activity.');
    }
    return JSON.stringify({ days });
}
