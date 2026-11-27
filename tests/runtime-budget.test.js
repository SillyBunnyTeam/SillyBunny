import { describe, expect, test } from '@jest/globals';

import { PERFORMANCE_PROFILES } from '../scripts/measure-frontend-performance.js';
import {
    IDLE_BEHIND_SETTINGS,
    readRuntimeBudget,
    runtimeBudgetsFor,
    STREAMING_REASONING,
} from './helpers/runtime-budget.js';

describe('runtime budgets of the frontend performance spec', () => {
    test.each([
        ['mobile', IDLE_BEHIND_SETTINGS],
        ['desktop', IDLE_BEHIND_SETTINGS],
        ['mobile', STREAMING_REASONING],
        ['desktop', STREAMING_REASONING],
    ])('the checked-in budget file has a number for every %s metric of %j', (profile, scenario) => {
        const budgets = runtimeBudgetsFor(profile, scenario);

        expect(budgets.map(({ metric }) => metric)).toEqual(scenario.metrics);
        for (const { limit } of budgets) {
            expect(Number.isFinite(limit)).toBe(true);
        }
    });

    test('every key of the budget file is a known profile and a metric that the spec or perf:frontend reads', () => {
        const known = new Set(Object.keys(PERFORMANCE_PROFILES).flatMap(profile => [IDLE_BEHIND_SETTINGS, STREAMING_REASONING]
            .flatMap(({ scenario, metrics }) => metrics.map(metric => `profiles.${profile}.cold.metrics.${scenario}.${metric}`))));

        expect(Object.keys(readRuntimeBudget()).filter(key => !known.has(key))).toEqual([]);
    });

    test('a metric that has no number in the budget file stops the spec and names the key', () => {
        const budgets = { 'profiles.mobile.cold.metrics.settingsInteractions.idleBehindSettings.runningAnimations': 0 };

        expect(() => runtimeBudgetsFor('mobile', IDLE_BEHIND_SETTINGS, budgets))
            .toThrow('"profiles.mobile.cold.metrics.settingsInteractions.idleBehindSettings.mutationCallbacks"');
        expect(() => runtimeBudgetsFor('mobile', IDLE_BEHIND_SETTINGS, { ...budgets, 'profiles.mobile.cold.metrics.settingsInteractions.idleBehindSettings.mutationCallbacks': '10' }))
            .toThrow('mutationCallbacks');
    });
});
