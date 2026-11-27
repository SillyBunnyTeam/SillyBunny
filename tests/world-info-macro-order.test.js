import { describe, expect, jest, test } from '@jest/globals';

import { createHarness } from './util/world-info-harness.js';

const countWords = text => String(text).split(/\s+/).filter(Boolean).length;

/**
 * Builds a scan harness whose macro expander keeps variables the way the real handlers do: a setter writes while the
 * expander runs, a getter reads at the same moment. `flag` stands in for any other macro with a side effect.
 */
function createScan(entries, { budget = 50, budgetCap = 0 } = {}) {
    const variables = {};
    const expanded = [];
    const context = createHarness({ books: { Lore: { entries } } });
    context.selected_world_info = ['Lore'];
    context.world_info = { charLore: [] };
    context.chat_metadata = {};
    context.power_user = {};
    context.world_info_budget = budget;
    context.world_info_budget_cap = budgetCap;
    context.getTokenCountAsync = jest.fn(async text => countWords(text));
    context.substituteParams = (content, options = {}) => {
        const text = String(content ?? '');
        expanded.push(text);
        return text
            .replace(/\{\{\s*setvar::(\w+)::([^}]*)\}\}/gi, (_, key, value) => { variables[key] = value; return ''; })
            .replace(/\{\{\s*deletevar::(\w+)\}\}/gi, (_, key) => { delete variables[key]; return ''; })
            .replace(/\{\{\s*flag::(\w+)\}\}/gi, (_, key) => { variables[key] = 'set'; return ''; })
            .replace(/\{\{\s*getvar::(\w+)\}\}/gi, (_, key) => variables[key] ?? '[unset]')
            .replace(/\{\{\s*char\s*\}\}/gi, options.name2Override ?? context.name2)
            .replace(/\{\{\s*user\s*\}\}/gi, options.name1Override ?? context.name1);
    };
    const run = async () => {
        const result = await context.checkWorldInfo(['We enter the tavern.'], 4000, false, context.defaultGlobalScanData);
        return [...result.allActivatedEntries].map(entry => ({ uid: entry.uid, content: entry.content }));
    };
    return { context, variables, expanded, run };
}

describe('World Info entry macros run in activation order', () => {
    test('a later entry reads the variable that an earlier entry sets', async () => {
        const { run } = createScan({
            0: { uid: 0, key: ['tavern'], content: '{{setvar::scene::tavern}}Setup.', order: 200, position: 0 },
            1: { uid: 1, key: ['tavern'], content: 'Scene is {{getvar::scene}}.', order: 100, position: 0 },
        });

        expect(await run()).toEqual([
            { uid: 0, content: 'Setup.' },
            { uid: 1, content: 'Scene is tavern.' },
        ]);
    });

    test('a later entry sees the variable that an earlier entry deletes', async () => {
        const { run, variables } = createScan({
            0: { uid: 0, key: ['tavern'], content: '{{deletevar::scene}}Reset.', order: 200, position: 0 },
            1: { uid: 1, key: ['tavern'], content: 'Scene is {{getvar::scene}}.', order: 100, position: 0 },
        });
        variables.scene = 'old';

        expect(await run()).toEqual([
            { uid: 0, content: 'Reset.' },
            { uid: 1, content: 'Scene is [unset].' },
        ]);
    });

    test('a reader placed before its writer still sees the old value', async () => {
        const { run, variables } = createScan({
            0: { uid: 0, key: ['tavern'], content: 'Scene is {{getvar::scene}}.', order: 200, position: 0 },
            1: { uid: 1, key: ['tavern'], content: '{{setvar::scene::tavern}}Setup.', order: 100, position: 0 },
        });

        expect(await run()).toEqual([
            { uid: 0, content: 'Scene is [unset].' },
            { uid: 1, content: 'Setup.' },
        ]);
        expect(variables.scene).toBe('tavern');
    });

    test('an entry that fails its probability check is never expanded', async () => {
        const { run, variables, expanded } = createScan({
            0: { uid: 0, key: ['tavern'], content: '{{flag::ghost}}Lost.', order: 200, position: 0, useProbability: true, probability: 0 },
            1: { uid: 1, key: ['tavern'], content: 'Ghost is {{getvar::ghost}}.', order: 100, position: 0 },
        });

        expect(await run()).toEqual([{ uid: 1, content: 'Ghost is [unset].' }]);
        expect(variables.ghost).toBeUndefined();
        expect(expanded.some(text => text.includes('flag::ghost'))).toBe(false);
    });

    test('entries after the budget cut-off are never expanded', async () => {
        const { run, variables, expanded } = createScan({
            0: { uid: 0, key: ['tavern'], content: 'one two', order: 300, position: 0 },
            1: { uid: 1, key: ['tavern'], content: 'three four five six seven eight nine ten', order: 200, position: 0 },
            2: { uid: 2, key: ['tavern'], content: '{{flag::late}}eleven', order: 100, position: 0 },
        }, { budget: 25, budgetCap: 6 });

        expect((await run()).map(entry => entry.uid)).toEqual([0]);
        expect(variables.late).toBeUndefined();
        expect(expanded.some(text => text.includes('flag::late'))).toBe(false);
    });

    test('entries with only name macros still count in parallel', async () => {
        const entries = {};
        for (let i = 1; i <= 12; i++) {
            entries[i] = { uid: i, key: ['tavern'], content: `{{char}} greets {{user}} at table ${i}.`, order: 1000 - i, position: 0 };
        }
        const { context, run } = createScan(entries);
        let active = 0;
        let maxConcurrent = 0;
        context.getTokenCountAsync = jest.fn(async text => {
            active++;
            maxConcurrent = Math.max(maxConcurrent, active);
            await Promise.resolve();
            active--;
            return countWords(text);
        });

        const activated = await run();

        expect(activated).toHaveLength(12);
        expect(activated[0].content).toBe('Aster greets Roleplay User at table 1.');
        expect(maxConcurrent).toBeGreaterThanOrEqual(12);
    });

    test('a variable macro inside an otherwise plain entry keeps the entry in order', async () => {
        const { run } = createScan({
            0: { uid: 0, key: ['tavern'], content: '{{char}} sets {{setvar::mood::calm}}the mood.', order: 300, position: 0 },
            1: { uid: 1, key: ['tavern'], content: 'Mood: {{getvar::mood}}, host {{char}}.', order: 200, position: 0 },
        });

        expect(await run()).toEqual([
            { uid: 0, content: 'Aster sets the mood.' },
            { uid: 1, content: 'Mood: calm, host Aster.' },
        ]);
    });
});
