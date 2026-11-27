import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const characterStates = new Map();
const patchCharacter = jest.fn((avatar, patch) => {
    const current = characterStates.get(avatar) ?? {};
    const next = { ...current };
    if (patch.routine === null) {
        delete next.routine;
    } else if (patch.routine) {
        next.routine = { ...current.routine, ...patch.routine };
    }
    if (patch.statusOverride === null) {
        delete next.statusOverride;
    } else if (patch.statusOverride !== undefined) {
        next.statusOverride = patch.statusOverride;
    }
    characterStates.set(avatar, next);
});
const generateConversationRaw = jest.fn();

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? 'persona-a.png' : value || ''),
    getCurrentCharAvatar: () => 'char.png',
    parsePositiveInt: (value, fallback, min = 1) => {
        const parsed = Number.parseInt(String(value), 10);
        return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
    },
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-data-browser.js', () => ({
    conversationData: { characterState: avatar => characterStates.get(avatar) ?? {}, patchCharacter },
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/generation.js', () => ({ generateConversationRaw }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/shared-helpers.js', () => ({ formatPromptText: value => String(value || '') }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({ getSettings: () => ({}) }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({ runtimeStatusOverrides: new Map() }));

const { runtimeStatusOverrides } = await import('../public/scripts/sillybunny-conversation/state.js');
const {
    getCharacterStatus,
    getConversationRuntimeStatusKey,
    getRoutine,
    getStatusOverride,
    getStoredSchedule,
    regenerateRoutine,
    setRoutineEnabled,
    setRoutineText,
    setStatusOverride,
} = await import('../public/scripts/sillybunny-conversation/schedule.js');

afterEach(() => {
    jest.restoreAllMocks();
});

const CARD = { avatar: 'char.png', name: 'Aster', description: 'A night-shift baker.', personality: 'Dry and kind.' };
const WORKDAY = [{ time: '08:00-12:00', activity: 'baking', status: 'dnd' }];
const generated = (activity = 'baking') => JSON.stringify({ days: { 1: [{ time: '08:00-12:00', activity, status: 'dnd' }] } });

beforeEach(() => {
    runtimeStatusOverrides.clear();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    characterStates.clear();
    patchCharacter.mockClear();
    generateConversationRaw.mockReset();
    generateConversationRaw.mockResolvedValue(generated());
});

describe('turning the routine of a character on', () => {
    test('generates it from the card the first time, and stores the days as JSON text', async () => {
        await setRoutineEnabled('char.png', true, { character: CARD });

        const [request] = generateConversationRaw.mock.calls[0];
        expect(request.prompt).toContain('Aster');
        expect(request.prompt).toContain('A night-shift baker.');
        expect(request.prompt).toContain('Dry and kind.');
        const routine = getRoutine('char.png');
        expect(routine).toMatchObject({ enabled: true, generatedAt: expect.any(Number) });
        expect(Object.keys(JSON.parse(routine.text))).toEqual(['days']);
        expect(JSON.parse(routine.text).days[1]).toEqual(WORKDAY);
        expect(Object.keys(JSON.parse(routine.text).days)).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    });

    test('does not ask the model again when the character has a routine from before', async () => {
        await setRoutineEnabled('char.png', true, { character: CARD });
        await setRoutineEnabled('char.png', false);
        generateConversationRaw.mockClear();

        await setRoutineEnabled('char.png', true, { character: CARD });

        expect(generateConversationRaw).not.toHaveBeenCalled();
        expect(getRoutine('char.png').enabled).toBe(true);
    });

    test('stays off, and stores nothing, when the model answers no schedule', async () => {
        generateConversationRaw.mockResolvedValue('Sorry, I cannot do that.');

        await expect(setRoutineEnabled('char.png', true, { character: CARD })).rejects.toThrow(/routine/i);

        expect(getRoutine('char.png')).toBeNull();
        expect(patchCharacter).not.toHaveBeenCalled();
    });

    test('needs the card of the character to generate from', async () => {
        await expect(setRoutineEnabled('char.png', true)).rejects.toThrow(/card/i);
    });
});

describe('turning the routine off', () => {
    test('keeps its text, so that turning it on again costs no request', async () => {
        await setRoutineEnabled('char.png', true, { character: CARD });
        const before = getRoutine('char.png').text;

        await setRoutineEnabled('char.png', false);

        expect(getRoutine('char.png')).toMatchObject({ enabled: false, text: before });
        expect(getStoredSchedule('char.png')).toBeNull();
    });

    test('is a no-op for a character that has no routine', async () => {
        await setRoutineEnabled('char.png', false);

        expect(getRoutine('char.png')).toBeNull();
        expect(patchCharacter).not.toHaveBeenCalled();
    });
});

describe('regenerating the routine', () => {
    test('replaces the text with a new one, from the card, and turns the routine on', async () => {
        await setRoutineEnabled('char.png', true, { character: CARD });
        await setRoutineEnabled('char.png', false);
        generateConversationRaw.mockResolvedValue(generated('reading'));

        await regenerateRoutine('char.png', { character: CARD });

        expect(JSON.parse(getRoutine('char.png').text).days[1][0].activity).toBe('reading');
        expect(getRoutine('char.png').enabled).toBe(true);
    });

    test('keeps the routine it has when the model answers no schedule', async () => {
        await setRoutineEnabled('char.png', true, { character: CARD });
        const before = getRoutine('char.png');
        generateConversationRaw.mockResolvedValue('no');

        await expect(regenerateRoutine('char.png', { character: CARD })).rejects.toThrow(/routine/i);

        expect(getRoutine('char.png')).toEqual(before);
    });
});

describe('editing the routine as text', () => {
    test('stores the days of the text that the user wrote, in the form of a generated routine', async () => {
        await setRoutineEnabled('char.png', true, { character: CARD });
        const generatedAt = getRoutine('char.png').generatedAt;

        setRoutineText('char.png', '{"days":{"2":[{"time":"22:00-06:00","activity":"asleep","status":"offline"}]}}');

        const routine = getRoutine('char.png');
        expect(JSON.parse(routine.text).days[2]).toEqual([{ time: '22:00-06:00', activity: 'asleep', status: 'offline' }]);
        expect(JSON.parse(routine.text).days[1]).toEqual([]);
        expect(routine.generatedAt).toBe(generatedAt);
    });

    test('infers the status of a block that names none, and reads the loose key names that models use', () => {
        setRoutineText('char.png', '{"schedule":{"Mon":[{"start":"9:00","end":"17:00","description":"working"}]}}');

        expect(JSON.parse(getRoutine('char.png').text).days[1]).toEqual([{ time: '09:00-17:00', activity: 'working', status: 'dnd' }]);
    });

    test('refuses a text that holds no schedule, and keeps the text it had', async () => {
        await setRoutineEnabled('char.png', true, { character: CARD });
        const before = getRoutine('char.png');

        expect(() => setRoutineText('char.png', 'wakes up late, bakes bread')).toThrow(/schedule/i);
        expect(() => setRoutineText('char.png', '{"days":{}}')).toThrow(/schedule/i);

        expect(getRoutine('char.png')).toEqual(before);
    });

    test('does not turn a routine on that is off', () => {
        setRoutineText('char.png', generated());

        expect(getRoutine('char.png').enabled).toBe(false);
        expect(getStoredSchedule('char.png')).toBeNull();
    });
});

describe('the status override of a character', () => {
    test('is none until the user sets one', () => {
        expect(getStatusOverride('char.png')).toBeNull();
    });

    test('is one of the four statuses, and null takes it away', () => {
        setStatusOverride('char.png', 'dnd');
        expect(getStatusOverride('char.png')).toBe('dnd');

        setStatusOverride('char.png', null);
        expect(getStatusOverride('char.png')).toBeNull();
    });

    test('refuses a value that is not a status', () => {
        expect(() => setStatusOverride('char.png', 'away')).toThrow(/status/i);
        expect(patchCharacter).not.toHaveBeenCalled();
    });

    test('is kept when the routine is turned off, on or regenerated', async () => {
        setStatusOverride('char.png', 'idle');

        await setRoutineEnabled('char.png', true, { character: CARD });
        await regenerateRoutine('char.png', { character: CARD });
        await setRoutineEnabled('char.png', false);

        expect(getStatusOverride('char.png')).toBe('idle');
    });
});

describe('what a character is doing', () => {
    // 2026-07-27 is a Monday; the routine below has Monday 08:00 to 12:00 as work
    const MONDAY_NINE = new Date(2026, 6, 27, 9, 0);
    const MONDAY_THIRTEEN = new Date(2026, 6, 27, 13, 0);
    const routineText = '{"days":{"1":[{"time":"08:00-12:00","activity":"baking","status":"dnd"}]}}';

    test('is online, and manual, for a character with no override and no routine', () => {
        expect(getCharacterStatus('char.png', MONDAY_NINE)).toEqual({ status: 'online', activity: null, source: 'manual' });
    });

    test('follows the routine while the user has set no override', async () => {
        await setRoutineEnabled('char.png', true, { character: CARD });
        setRoutineText('char.png', routineText);

        expect(getCharacterStatus('char.png', MONDAY_NINE)).toEqual({ status: 'dnd', activity: 'baking', source: 'schedule' });
        expect(getCharacterStatus('char.png', MONDAY_THIRTEEN)).toEqual({ status: 'online', activity: 'free time', source: 'default' });
    });

    test('is the override of the user whatever the routine says', async () => {
        await setRoutineEnabled('char.png', true, { character: CARD });
        setRoutineText('char.png', routineText);
        setStatusOverride('char.png', 'offline');

        expect(getCharacterStatus('char.png', MONDAY_NINE)).toEqual({ status: 'offline', activity: null, source: 'manual' });
    });

    test('follows the routine again when the override is taken away', async () => {
        await setRoutineEnabled('char.png', true, { character: CARD });
        setRoutineText('char.png', routineText);
        setStatusOverride('char.png', 'offline');
        setStatusOverride('char.png', null);

        expect(getCharacterStatus('char.png', MONDAY_NINE).status).toBe('dnd');
    });

    test('ignores a routine that is off', async () => {
        await setRoutineEnabled('char.png', true, { character: CARD });
        setRoutineText('char.png', routineText);
        await setRoutineEnabled('char.png', false);

        expect(getCharacterStatus('char.png', MONDAY_NINE)).toMatchObject({ status: 'online', source: 'manual' });
    });

    test('is what the character set for itself until that runs out, when the user has set no override', () => {
        runtimeStatusOverrides.set(getConversationRuntimeStatusKey('char.png', 'persona-a.png'), { status: 'idle', activity: 'commuting', expiresAt: MONDAY_NINE.getTime() + 60_000 });

        expect(getCharacterStatus('char.png', MONDAY_NINE)).toEqual({ status: 'idle', activity: 'commuting', source: 'override' });
        expect(getCharacterStatus('char.png', MONDAY_THIRTEEN)).toMatchObject({ status: 'online', source: 'manual' });
    });
});
