import {
    DEFAULT_INACTIVITY_THRESHOLD,
    DEFAULT_TALKATIVENESS,
    MAX_INACTIVITY_THRESHOLD,
    MIN_INACTIVITY_THRESHOLD,
    SCHEDULE_STATUSES,
    WEEKDAY_LABELS,
} from './constants.js';

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
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        text = text.slice(firstBrace, lastBrace + 1);
    }
    text = text.replace(/,\s*([}\]])/g, '$1');
    return text;
}

export function normalizeScheduleBlock(block) {
    if (!block || typeof block !== 'object') {
        return null;
    }

    const time = String(block.time || '').trim();
    const activity = String(block.activity || '').trim();
    if (!time || !activity) {
        return null;
    }

    let status = String(block.status || '').toLowerCase().trim();
    if (!SCHEDULE_STATUSES.includes(status)) {
        status = inferStatusFromActivity(activity);
    }

    return { time, activity, status };
}

export function parseScheduleResponse(rawText) {
    let parsed;
    try {
        parsed = JSON.parse(repairScheduleJson(rawText));
    } catch (error) {
        console.warn('Conversation Mode: failed to parse generated schedule', error);
        return null;
    }

    if (!parsed || typeof parsed !== 'object') {
        return null;
    }

    const days = {};
    const sourceDays = parsed.days && typeof parsed.days === 'object' ? parsed.days : parsed;
    let hasAnyBlock = false;
    for (let day = 0; day < 7; day++) {
        const dayKeys = [String(day), WEEKDAY_LABELS[day], WEEKDAY_LABELS[day].toLowerCase()];
        let blocks = null;
        for (const key of dayKeys) {
            if (Array.isArray(sourceDays?.[key])) {
                blocks = sourceDays[key];
                break;
            }
        }
        const normalized = Array.isArray(blocks)
            ? blocks.map(normalizeScheduleBlock).filter(Boolean)
            : [];
        if (normalized.length) {
            hasAnyBlock = true;
        }
        days[day] = normalized;
    }

    if (!hasAnyBlock) {
        return null;
    }

    const talkativeness = clamp(parsePositiveIntValue(parsed.talkativeness, DEFAULT_TALKATIVENESS, 0), 0, 100);
    const inactivityThresholdMinutes = clamp(
        parsePositiveIntValue(parsed.inactivityThresholdMinutes ?? parsed.inactivity_threshold, DEFAULT_INACTIVITY_THRESHOLD, MIN_INACTIVITY_THRESHOLD),
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
