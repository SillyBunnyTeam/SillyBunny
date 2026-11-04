import { describe, expect, test } from '@jest/globals';

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
    getSteps,
} from './util/world-info-cases.js';

const BOOK = 'Rules Book';

function createMath(random) {
    const rolls = [random ?? []].flat();
    let used = 0;
    return Object.assign(Object.create(Math), {
        random() {
            if (!rolls.length) {
                throw new Error('This case rolled Math.random without setting random.');
            }
            return rolls[Math.min(used++, rolls.length - 1)];
        },
    });
}

async function scanSteps(testCase) {
    const entries = Object.fromEntries(testCase.entries.map(item => [item.uid, item]));
    const context = createHarness({ books: { [BOOK]: { entries } } });
    Object.assign(context, {
        selected_world_info: [BOOK],
        world_info: { charLore: [] },
        chat_metadata: {},
        power_user: {},
        extensionPrompts: { note: { value: '', scan: true } },
        ...testCase.state,
    });
    context.characters.forEach(character => {
        character.data.extensions = {};
    });

    const outcomes = [];
    for (const step of getSteps(testCase)) {
        Object.assign(context, BASELINE_SETTINGS, testCase.settings, step.settings);
        context.Math = createMath(step.random ?? testCase.random);
        context.eventSource.emit.mockClear();
        const globalScanData = { ...context.defaultGlobalScanData, ...testCase.scanData };
        const result = await context.checkWorldInfo(step.chat, step.maxContext ?? testCase.maxContext ?? 4000, false, globalScanData);
        const uids = [...result.allActivatedEntries].map(item => item.uid);
        outcomes.push({
            uids: step.ordered ? uids : uids.sort((a, b) => a - b),
            loops: context.eventSource.emit.mock.calls.filter(([name]) => name === event_types.WORLDINFO_SCAN_DONE).length,
        });
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
        const steps = getSteps(testCase);
        const outcomes = await scanSteps(testCase);

        const actual = outcomes.map((outcome, index) => ({
            uids: outcome.uids,
            ...(steps[index].loops === undefined ? {} : { loops: outcome.loops }),
        }));
        const expected = steps.map(step => ({
            uids: step.expected,
            ...(step.loops === undefined ? {} : { loops: step.loops }),
        }));
        expect(actual).toEqual(expected);
    });
});
