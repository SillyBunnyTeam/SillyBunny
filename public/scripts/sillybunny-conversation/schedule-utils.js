import {
    DEFAULT_INACTIVITY_THRESHOLD,
    DEFAULT_TALKATIVENESS,
    MAX_INACTIVITY_THRESHOLD,
    MIN_INACTIVITY_THRESHOLD,
    SCHEDULE_STATUSES,
    WEEKDAY_LABELS,
} from './constants.js';

const WEEKDAY_FULL_LABELS = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);

export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

export function parsePositiveIntValue(value, fallback, min = 1) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

export function inferStatusFromActivity(activity) {
    const text = String(activity || '').toLowerCase();
    if (/sleep|asleep|nap|passed out|unconscious|bed|resting/.test(text)) {
        return 'offline';
    }
    if (/work|working|class|study|studying|meeting|training|focus|exam|shift|busy/.test(text)) {
        return 'dnd';
    }
    if (/eat|eating|commut|shower|cook|driving|errand|gym|lunch|dinner|breakfast/.test(text)) {
        return 'idle';
    }
    return 'online';
}

export function repairScheduleJson(raw) {
    let text = String(raw || '').trim();
    text = text.replace(/```(?:json)?/gi, '').trim();
    const firstBrace = text.indexOf('{');
    const firstBracket = text.indexOf('[');
    const starts = [firstBrace, firstBracket].filter(index => index >= 0);
    const firstJsonIndex = starts.length ? Math.min(...starts) : -1;
    const lastJsonIndex = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (firstJsonIndex !== -1 && lastJsonIndex !== -1 && lastJsonIndex > firstJsonIndex) {
        text = text.slice(firstJsonIndex, lastJsonIndex + 1);
    }
    text = text.replace(/,\s*([}\]])/g, '$1');
    return text;
}

function parseScheduleJson(rawText) {
    let parsed = JSON.parse(repairScheduleJson(rawText));
    if (typeof parsed === 'string') {
        parsed = JSON.parse(repairScheduleJson(parsed));
    }
    return parsed;
}

function getFirstDefined(sources, keys) {
    for (const source of sources) {
        if (!source || typeof source !== 'object') {
            continue;
        }
        for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined && source[key] !== null) {
                return source[key];
            }
        }
    }

    return undefined;
}

function getDayAliases(day) {
    const short = WEEKDAY_LABELS[day];
    const full = WEEKDAY_FULL_LABELS[day];
    return [
        String(day),
        day,
        short,
        short.toLowerCase(),
        short.toUpperCase(),
        full,
        full.toLowerCase(),
        full.toUpperCase(),
        `day${day}`,
        `day_${day}`,
    ];
}

function getDayIndexFromValue(value) {
    const text = String(value ?? '').trim().toLowerCase();
    if (!text) {
        return -1;
    }
    const numeric = Number.parseInt(text, 10);
    if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 6) {
        return numeric;
    }

    return WEEKDAY_FULL_LABELS.findIndex((label, index) => text === label.toLowerCase() || text === WEEKDAY_LABELS[index].toLowerCase());
}

function normalizeTimeValue(value) {
    const text = String(value ?? '').trim();
    if (!text) {
        return '';
    }

    const match = text.match(/^(\d{1,2})(?::(\d{2}))?$/);
    if (!match) {
        return text;
    }

    const hours = Number(match[1]);
    const minutes = Number(match[2] || 0);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
        return text;
    }

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function getScheduleBlockTime(block) {
    const explicit = getFirstDefined([block], ['time', 'range', 'timeRange', 'time_range', 'hours', 'period']);
    if (explicit) {
        return String(explicit).trim();
    }

    const start = getFirstDefined([block], ['start', 'startTime', 'start_time', 'from']);
    const end = getFirstDefined([block], ['end', 'endTime', 'end_time', 'to']);
    if (start !== undefined && end !== undefined) {
        return `${normalizeTimeValue(start)}-${normalizeTimeValue(end)}`;
    }

    return '';
}

function getScheduleBlockActivity(block) {
    return String(getFirstDefined([block], ['activity', 'description', 'label', 'name', 'title', 'task', 'event', 'doing']) || '').trim();
}

export function normalizeScheduleBlock(block) {
    if (!block || typeof block !== 'object') {
        return null;
    }

    const time = getScheduleBlockTime(block);
    const activity = getScheduleBlockActivity(block);
    if (!time || !activity) {
        return null;
    }

    let status = String(block.status || '').toLowerCase().trim();
    if (!SCHEDULE_STATUSES.includes(status)) {
        status = inferStatusFromActivity(activity);
    }

    return { time, activity, status };
}

function getScheduleBlocksFromDayValue(value) {
    if (Array.isArray(value)) {
        return value;
    }
    if (!value || typeof value !== 'object') {
        return [];
    }
    if (normalizeScheduleBlock(value)) {
        return [value];
    }

    const nested = getFirstDefined([value], ['blocks', 'timeBlocks', 'time_blocks', 'schedule', 'activities', 'events', 'entries', 'periods', 'items']);
    return Array.isArray(nested) ? nested : [];
}

function getScheduleSource(parsed) {
    const candidates = [
        parsed?.days,
        parsed?.schedule?.days,
        parsed?.weeklySchedule?.days,
        parsed?.weekly_schedule?.days,
        parsed?.week?.days,
        parsed?.routine?.days,
        parsed?.schedule,
        parsed?.weeklySchedule,
        parsed?.weekly_schedule,
        parsed?.week,
        parsed?.routine,
        parsed,
    ];

    return candidates.find(candidate => candidate && typeof candidate === 'object') || null;
}

function getScheduleBlocksForDay(sourceDays, day) {
    if (!sourceDays || typeof sourceDays !== 'object') {
        return [];
    }

    if (Array.isArray(sourceDays)) {
        const directValue = sourceDays[day];
        const directDay = getFirstDefined([directValue], ['day', 'weekday', 'name', 'label']);
        if (directDay === undefined || getDayIndexFromValue(directDay) === day) {
            const direct = getScheduleBlocksFromDayValue(directValue);
            if (direct.length) {
                return direct;
            }
        }

        const matchingDay = sourceDays.find((item) => {
            const itemDay = getFirstDefined([item], ['day', 'weekday', 'name', 'label']);
            return getDayIndexFromValue(itemDay) === day;
        });
        return getScheduleBlocksFromDayValue(matchingDay);
    }

    for (const key of getDayAliases(day)) {
        if (Object.prototype.hasOwnProperty.call(sourceDays, key)) {
            const blocks = getScheduleBlocksFromDayValue(sourceDays[key]);
            if (blocks.length) {
                return blocks;
            }
        }
    }

    return [];
}

export function parseScheduleResponse(rawText) {
    let parsed;
    try {
        parsed = parseScheduleJson(rawText);
    } catch (error) {
        console.warn('Conversation Mode: failed to parse generated schedule', error);
        return null;
    }

    if (!parsed || typeof parsed !== 'object') {
        return null;
    }

    const days = {};
    const sourceDays = getScheduleSource(parsed);
    let hasAnyBlock = false;
    for (let day = 0; day < 7; day++) {
        const normalized = getScheduleBlocksForDay(sourceDays, day).map(normalizeScheduleBlock).filter(Boolean);
        if (normalized.length) {
            hasAnyBlock = true;
        }
        days[day] = normalized;
    }

    if (!hasAnyBlock) {
        return null;
    }

    const metadataSources = [parsed, parsed?.schedule, parsed?.weeklySchedule, parsed?.weekly_schedule, parsed?.metadata].filter(Boolean);
    const talkativeness = clamp(parsePositiveIntValue(getFirstDefined(metadataSources, ['talkativeness', 'talkativenessScore', 'talkativeness_score']), DEFAULT_TALKATIVENESS, 0), 0, 100);
    const inactivityThresholdMinutes = clamp(
        parsePositiveIntValue(getFirstDefined(metadataSources, ['inactivityThresholdMinutes', 'inactivity_threshold', 'inactivityThreshold', 'patienceMinutes', 'patience_minutes']), DEFAULT_INACTIVITY_THRESHOLD, MIN_INACTIVITY_THRESHOLD),
        MIN_INACTIVITY_THRESHOLD,
        MAX_INACTIVITY_THRESHOLD,
    );

    return {
        days,
        talkativeness,
        inactivityThresholdMinutes,
        generatedAt: Date.now(),
    };
}

export function parseScheduleTimeRange(range) {
    const match = String(range || '').match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
    if (!match) {
        return null;
    }

    const startMinutes = parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
    const endMinutes = parseInt(match[3], 10) * 60 + parseInt(match[4], 10);
    return { startMinutes, endMinutes };
}

export function getCurrentActivityFromSchedule(schedule, avatar = '', now = new Date(), runtimeStatusOverrides = new Map()) {
    if (avatar && runtimeStatusOverrides.has(avatar)) {
        const override = runtimeStatusOverrides.get(avatar);
        if (override.expiresAt > now.getTime()) {
            return { status: override.status, activity: override.activity, source: 'override' };
        }
        runtimeStatusOverrides.delete(avatar);
    }

    if (!schedule || !schedule.days) {
        return { status: 'online', activity: 'free time', source: 'default' };
    }

    const day = now.getDay();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const blocks = Array.isArray(schedule.days[day]) ? schedule.days[day] : [];

    for (const block of blocks) {
        const range = parseScheduleTimeRange(block.time);
        if (!range) {
            continue;
        }

        const { startMinutes, endMinutes } = range;
        const inRange = startMinutes <= endMinutes
            ? nowMinutes >= startMinutes && nowMinutes < endMinutes
            : nowMinutes >= startMinutes || nowMinutes < endMinutes;
        if (inRange) {
            return { status: block.status, activity: block.activity, source: 'schedule' };
        }
    }

    return { status: 'online', activity: 'free time', source: 'default' };
}

export function parseDurationToMs(text) {
    const match = String(text || '').match(/(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i);
    if (!match) {
        return 0;
    }
    const hours = parseInt(match[1] || '0', 10);
    const minutes = parseInt(match[2] || '0', 10);
    return (hours * 60 + minutes) * 60 * 1000;
}
