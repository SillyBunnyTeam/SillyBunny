import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { event_types } from '../public/scripts/events.js';
import { createHarness } from './util/world-info-harness.js';
import {
    BASELINE_SETTINGS,
    BUDGET_CASES,
    CASE_SENSITIVITY_CASES,
    ENTRY_GATE_CASES,
    INCLUSION_GROUP_CASES,
    MIN_ACTIVATION_CASES,
    PRIMARY_KEY_CASES,
    RECURSION_CASES,
    REGEX_CASES,
    SCAN_DEPTH_CASES,
    SELECTIVE_LOGIC_CASES,
    TIMED_EFFECT_CASES,
    WHOLE_WORD_CASES,
    compareOutcomes,
    getSteps,
} from './util/world-info-cases.js';

const BOOK = 'Rules Book';

function mockMathRandom(random) {
    const rolls = [random ?? []].flat();
    let used = 0;
    return jest.spyOn(Math, 'random').mockImplementation(() => {
        if (!rolls.length) {
            throw new Error('This case rolled Math.random without setting random.');
        }
        return rolls[Math.min(used++, rolls.length - 1)];
    });
}

beforeEach(() => {
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
});

async function scanSteps(testCase) {
    const entries = Object.fromEntries(testCase.entries.map(item => [item.uid, item]));
    const harness = await createHarness({
        books: { [BOOK]: { entries } },
        selectedWorldInfo: [BOOK],
        charLore: [],
        state: {
            chat_metadata: {},
            power_user: {},
            extensionPrompts: { note: { value: '', scan: true } },
            ...testCase.state,
        },
    });
    harness.state.characters.forEach(character => {
        character.data.extensions = {};
    });

    const outcomes = [];
    for (const step of getSteps(testCase)) {
        harness.updateSettings({ ...BASELINE_SETTINGS, ...testCase.settings, ...step.settings }, [BOOK]);
        const randomSpy = mockMathRandom(step.random ?? testCase.random);
        harness.mocks.eventSource.emit.mockClear();
        const globalScanData = { ...harness.defaultGlobalScanData, ...testCase.scanData };
        try {
            const result = await harness.checkWorldInfo(step.chat, step.maxContext ?? testCase.maxContext ?? 4000, false, globalScanData);
            outcomes.push({
                uids: [...result.allActivatedEntries].map(item => item.uid),
                loops: harness.mocks.eventSource.emit.mock.calls.filter(([name]) => name === event_types.WORLDINFO_SCAN_DONE).length,
            });
        } finally {
            randomSpy.mockRestore();
        }
    }
    return outcomes;
}

describe.each([
    ['World Info primary keys', PRIMARY_KEY_CASES],
    ['World Info selective logic', SELECTIVE_LOGIC_CASES],
    ['World Info case sensitivity', CASE_SENSITIVITY_CASES],
    ['World Info whole word matching', WHOLE_WORD_CASES],
    ['World Info regular expression keys', REGEX_CASES],
    ['World Info scan depth', SCAN_DEPTH_CASES],
    ['World Info recursion', RECURSION_CASES],
    ['World Info minimum activations', MIN_ACTIVATION_CASES],
    ['World Info inclusion groups', INCLUSION_GROUP_CASES],
    ['World Info sticky, cooldown and delay', TIMED_EFFECT_CASES],
    ['World Info entry gates', ENTRY_GATE_CASES],
    ['World Info budget', BUDGET_CASES],
])('%s', (title, cases) => {
    test.each(cases)('$name', async testCase => {
        const { actual, expected } = compareOutcomes(testCase, await scanSteps(testCase));

        expect(actual).toEqual(expected);
    });
});
