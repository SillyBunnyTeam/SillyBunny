import { readFileSync } from 'node:fs';

const RUNTIME_BUDGET_URL = new URL('../../scripts/frontend-perf-budget.json', import.meta.url);

/**
 * The runtime scenarios that the frontend performance spec measures, with the metrics that it checks. The names are
 * the paths of the measurement result of `scripts/measure-frontend-performance.js`, below
 * `profiles.<profile>.cold.metrics`, so that the spec and `perf:frontend` read one budget file.
 */
export const IDLE_BEHIND_SETTINGS = Object.freeze({
    scenario: 'settingsInteractions.idleBehindSettings',
    metrics: Object.freeze(['runningAnimations', 'mutationCallbacks', 'cdp.recalcStyleCount', 'cdp.layoutCount']),
});

export const STREAMING_REASONING = Object.freeze({
    scenario: 'chatRender.streamingReasoning',
    metrics: Object.freeze(['getBoundingClientRectCount', 'querySelectorAllCount', 'cdp.recalcStyleCount']),
});

/** The `max` budgets of the checked-in budget file, by metric path. */
export function readRuntimeBudget(budgetUrl = RUNTIME_BUDGET_URL) {
    return JSON.parse(readFileSync(budgetUrl, 'utf8')).max ?? {};
}

/**
 * The upper limit of every metric of a scenario for one measurement profile. A metric without a number in the budget
 * file throws, so a spec cannot run with a limit that is absent.
 * @param {string} profile `mobile` or `desktop`
 * @param {{ scenario: string, metrics: readonly string[] }} scenario
 * @param {Record<string, number>} [maxBudgets]
 * @returns {{ metric: string, limit: number }[]}
 */
export function runtimeBudgetsFor(profile, { scenario, metrics }, maxBudgets = readRuntimeBudget()) {
    return metrics.map((metric) => {
        const key = `profiles.${profile}.cold.metrics.${scenario}.${metric}`;
        const limit = maxBudgets[key];
        if (typeof limit !== 'number') {
            throw new Error(`scripts/frontend-perf-budget.json has no number for "${key}", so the budget cannot be checked.`);
        }
        return { metric, limit };
    });
}
