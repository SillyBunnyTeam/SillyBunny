import { describe, expect, test } from '@jest/globals';

import {
    getCurrentActivityFromSchedule,
    parseDurationToMs,
    parseScheduleResponse,
} from '../public/scripts/sillybunny-conversation/schedule-utils.js';

describe('sillybunny conversation schedule utils', () => {
    test('repairs generated JSON and normalizes schedule blocks', () => {
        const schedule = parseScheduleResponse(`
            \`\`\`json
            {
                "talkativeness": 200,
                "inactivityThresholdMinutes": 5,
                "days": {
                    "Mon": [
                        { "time": "09:00-12:00", "activity": "studying" },
                    ],
                    "Wed": [
                        { "time": "18:00-19:00", "activity": "free", "status": "away" },
                    ],
                },
            }
            \`\`\`
        `);

        expect(schedule).toEqual(expect.objectContaining({
            talkativeness: 100,
            inactivityThresholdMinutes: 120,
        }));
        expect(schedule.days[1]).toEqual([{ time: '09:00-12:00', activity: 'studying', status: 'dnd' }]);
        expect(schedule.days[3]).toEqual([{ time: '18:00-19:00', activity: 'free', status: 'online' }]);
    });

    test('resolves overnight blocks and temporary status overrides', () => {
        const now = new Date(2026, 5, 15, 23, 30);
        const schedule = {
            days: {
                1: [{ time: '22:00-02:00', activity: 'gaming', status: 'idle' }],
            },
        };
        const overrides = new Map([
            ['avatar.png', { status: 'dnd', activity: 'coding', expiresAt: now.getTime() + 1000 }],
        ]);

        expect(getCurrentActivityFromSchedule(schedule, 'avatar.png', now, overrides)).toEqual({
            status: 'dnd',
            activity: 'coding',
            source: 'override',
        });

        overrides.set('avatar.png', { status: 'offline', activity: 'sleeping', expiresAt: now.getTime() - 1 });
        expect(getCurrentActivityFromSchedule(schedule, 'avatar.png', now, overrides)).toEqual({
            status: 'idle',
            activity: 'gaming',
            source: 'schedule',
        });
        expect(overrides.has('avatar.png')).toBe(false);
    });

    test('parses schedule update durations', () => {
        expect(parseDurationToMs('1h 30m')).toBe(90 * 60 * 1000);
        expect(parseDurationToMs('45m')).toBe(45 * 60 * 1000);
        expect(parseDurationToMs('not a duration')).toBe(0);
    });
});
