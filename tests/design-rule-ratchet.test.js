import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    RULE_IDS,
    UPDATE_COMMAND,
    buildBaseline,
    compareToBaseline,
    defaultBaselinePath,
    formatComparison,
    scanDesignRules,
    validateBaseline,
} from '../scripts/audit-design-rules.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixtureReport(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ratchet-'));
    try {
        fs.mkdirSync(path.join(root, 'tests/fixtures'), { recursive: true });
        fs.writeFileSync(path.join(root, 'tests/fixtures/upstream-origin-public-files.json'), '[]');
        for (const [file, css] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            fs.writeFileSync(path.join(root, file), css);
        }
        return scanDesignRules({ repoRoot: root });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

describe('design-rule ratchet on the tree', () => {
    const baseline = validateBaseline(JSON.parse(fs.readFileSync(defaultBaselinePath, 'utf8')));
    const comparison = compareToBaseline(scanDesignRules({ repoRoot }), baseline);

    test('no SillyBunny stylesheet has a count above its baseline', () => {
        expect(formatComparison({ above: comparison.above, below: [] })).toBe('');
    });

    test('no count is below its baseline and no baseline sheet is gone, so the baseline equals the tree', () => {
        expect(formatComparison({ above: [], below: comparison.below, missing: comparison.missing })).toBe('');
    });

    test('the baseline file is what --update would write', () => {
        const report = scanDesignRules({ repoRoot });
        expect(baseline).toEqual(buildBaseline(report));
    });
});

describe('design-rule ratchet failure cases', () => {
    const original = { 'public/css/sillybunny-a.css': '.a { color: #fff; border-radius: 8px; }\n.b:hover { margin: 0; }' };
    const baseline = buildBaseline(fixtureReport(original));

    test('a baseline built from a tree matches that tree', () => {
        expect(baseline.files['public/css/sillybunny-a.css']).toEqual({ 'color-literal': 1, 'radius-literal': 1, 'hover-ungated': 1 });
        expect(compareToBaseline(fixtureReport(original), baseline)).toEqual({ above: [], below: [], missing: [] });
    });

    test('a raised count fails and names the file, rule and both numbers', () => {
        const raised = fixtureReport({ 'public/css/sillybunny-a.css': `${original['public/css/sillybunny-a.css']}\n.c { color: red; }` });
        const comparison = compareToBaseline(raised, baseline);
        expect(comparison.above).toEqual([{ file: 'public/css/sillybunny-a.css', rule: 'color-literal', current: 2, baseline: 1 }]);
        expect(comparison.below).toEqual([]);
        expect(formatComparison(comparison)).toContain('public/css/sillybunny-a.css color-literal: 2 > 1');
    });

    test('a lowered count fails and the message names the update command', () => {
        const lowered = fixtureReport({ 'public/css/sillybunny-a.css': '.a { color: #fff; }\n.b:hover { margin: 0; }' });
        const comparison = compareToBaseline(lowered, baseline);
        expect(comparison.above).toEqual([]);
        expect(comparison.below).toEqual([{ file: 'public/css/sillybunny-a.css', rule: 'radius-literal', current: 0, baseline: 1 }]);
        expect(formatComparison(comparison)).toContain(UPDATE_COMMAND);
    });

    test('a deleted stylesheet is one missing line, not one lowered count per rule', () => {
        const comparison = compareToBaseline(fixtureReport({}), baseline);
        expect(comparison).toEqual({ above: [], below: [], missing: ['public/css/sillybunny-a.css'] });
        expect(formatComparison(comparison).split('\n')).toEqual([
            '[MISSING] public/css/sillybunny-a.css',
            `Counts went down or a stylesheet is gone. Lock it in with: ${UPDATE_COMMAND}`,
        ]);
    });

    test('a renamed stylesheet is a missing line for the old name and raised counts for the new one', () => {
        const renamed = fixtureReport({ 'public/css/sillybunny-b.css': original['public/css/sillybunny-a.css'] });
        const comparison = compareToBaseline(renamed, baseline);
        expect(comparison.missing).toEqual(['public/css/sillybunny-a.css']);
        expect(comparison.below).toEqual([]);
        expect(comparison.above.map(item => `${item.file} ${item.rule}`)).toEqual([
            'public/css/sillybunny-b.css color-literal',
            'public/css/sillybunny-b.css radius-literal',
            'public/css/sillybunny-b.css hover-ungated',
        ]);
    });

    test('a new stylesheet with no baseline entry is held to zero in every rule', () => {
        const added = fixtureReport({
            ...original,
            'public/css/sillybunny-new.css': '.a { color: var(--x); }\n.b { letter-spacing: 0.06em; }\n.c { text-transform: uppercase; }',
        });
        const comparison = compareToBaseline(added, baseline);
        expect(comparison.below).toEqual([]);
        expect(comparison.above).toEqual([
            { file: 'public/css/sillybunny-new.css', rule: 'letter-spacing', current: 1, baseline: 0 },
            { file: 'public/css/sillybunny-new.css', rule: 'uppercase', current: 1, baseline: 0 },
        ]);
    });

    test('a new clean stylesheet passes', () => {
        const clean = fixtureReport({ ...original, 'public/css/sillybunny-new.css': '.a { color: var(--x); border-radius: var(--sb-radius-card); }' });
        expect(compareToBaseline(clean, baseline)).toEqual({ above: [], below: [], missing: [] });
    });

    test('every rule is compared, including the sub-counts', () => {
        const css = '.a { border-radius: 22px; }\n@media (max-width: 1000px) { .b { margin: 0; } }';
        const added = fixtureReport({ 'public/css/sillybunny-new.css': css });
        const rules = compareToBaseline(added, { version: 1, files: {} }).above.map(item => item.rule);
        expect(rules).toEqual(RULE_IDS.filter(id => ['radius-literal', 'radius-over-20', 'breakpoint-off-set', 'breakpoint-1000'].includes(id)));
    });

    test('a new off-scale spacing value fails, and one moved onto the scale lowers the count', () => {
        const css = '.a { padding: 5px 6px; margin: var(--x, 7px); }';
        const spacing = buildBaseline(fixtureReport({ 'public/css/sillybunny-s.css': css }));
        expect(spacing.files['public/css/sillybunny-s.css']).toEqual({ 'spacing-off-scale': 1, 'spacing-off-scale-fallback': 1 });

        const raised = fixtureReport({ 'public/css/sillybunny-s.css': '.a { padding: 5px 7px; margin: var(--x, 7px); }' });
        expect(compareToBaseline(raised, spacing).above).toEqual([{ file: 'public/css/sillybunny-s.css', rule: 'spacing-off-scale', current: 2, baseline: 1 }]);

        const lowered = fixtureReport({ 'public/css/sillybunny-s.css': '.a { padding: 6px; margin: var(--x, 7px); }' });
        const comparison = compareToBaseline(lowered, spacing);
        expect(comparison.above).toEqual([]);
        expect(comparison.below).toEqual([{ file: 'public/css/sillybunny-s.css', rule: 'spacing-off-scale', current: 0, baseline: 1 }]);
    });

    test('rejects a baseline with an unknown rule, a zero count or the wrong version', () => {
        expect(() => validateBaseline({ version: 1, files: { 'a.css': { nonsense: 1 } } })).toThrow('Invalid design-rule baseline');
        expect(() => validateBaseline({ version: 1, files: { 'a.css': { important: 0 } } })).toThrow('Invalid design-rule baseline');
        expect(() => validateBaseline({ version: 2, files: {} })).toThrow('Invalid design-rule baseline');
    });
});
