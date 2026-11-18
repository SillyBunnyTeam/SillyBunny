import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';
import {
    COPY_BASELINE_PATH,
    compareToCopyBaseline,
    copyKey,
    emptyCopyBaseline,
    formatCopyBaseline,
    formatCopyComparison,
    readCopyBaseline,
    uniqueObservations,
    updateCopyBaselineFile,
    updatedCopyBaseline,
    validateCopyBaseline,
} from '../helpers/copy-baseline.js';

const record = (text, extra = {}) => ({ surface: 'settings.backend.sampling', role: 'button', text, expected: `${text}!`, target: 'div#a > button.b', ...extra });
const observed = (text, section = 'sillybunny', extra = {}) => ({ ...record(text, extra), section });
const UNITS = [{ surface: 'settings.backend.sampling' }];

describe('compareToCopyBaseline', () => {
    test('is empty when the run equals the file', () => {
        const baseline = { ...emptyCopyBaseline(), upstream: [record('Top nsigma')], sillybunny: [record('Reload file')] };
        const comparison = compareToCopyBaseline({ observed: [observed('Top nsigma', 'upstream'), observed('Reload file')], baseline, units: UNITS });
        expect(comparison).toEqual({ added: [], fixed: [], moved: [] });
        expect(formatCopyComparison(comparison)).toEqual([]);
    });

    test('fails a string that is in neither section, whichever section it would join', () => {
        const comparison = compareToCopyBaseline({ observed: [observed('Reload file'), observed('Top nsigma', 'upstream')], baseline: emptyCopyBaseline(), units: UNITS });
        expect(comparison.added.map(item => [item.section, item.record.text])).toEqual([['sillybunny', 'Reload file'], ['upstream', 'Top nsigma']]);
        expect(formatCopyComparison(comparison).join('\n')).toContain('in neither section of copy-baseline.json');
    });

    test('a string that no longer occurs is a removal that the failure message asks for', () => {
        const baseline = { ...emptyCopyBaseline(), sillybunny: [record('Reload file')] };
        const comparison = compareToCopyBaseline({ observed: [], baseline, units: UNITS });
        expect(comparison.fixed.map(item => item.record.text)).toEqual(['Reload file']);
        expect(formatCopyComparison(comparison).join('\n')).toContain('Remove the fixed records from the baseline');
    });

    test('a change of the target or the expected form alone is not a new violation', () => {
        const baseline = { ...emptyCopyBaseline(), sillybunny: [record('Reload file')] };
        const moved = { ...observed('Reload file'), target: 'section > span.other', expected: 'Reload File' };
        expect(compareToCopyBaseline({ observed: [moved], baseline, units: UNITS })).toEqual({ added: [], fixed: [], moved: [] });
    });

    test('tells the role and the state of a string apart', () => {
        const baseline = { ...emptyCopyBaseline(), sillybunny: [record('Reload file')] };
        const comparison = compareToCopyBaseline({ observed: [observed('Reload file', 'sillybunny', { role: 'tooltip' }), observed('Reload file', 'sillybunny', { state: 'expanded' })], baseline, units: [...UNITS, { surface: 'settings.backend.sampling', state: 'expanded' }] });
        expect(comparison.added).toHaveLength(2);
        expect(comparison.fixed.map(item => item.record.text)).toEqual(['Reload file']);
    });

    test('holds the upstream section to its wording: a known upstream string in another state or surface passes', () => {
        const baseline = { ...emptyCopyBaseline(), upstream: [record('Top nsigma', { state: 'loaded' })] };
        const elsewhere = observed('Top nsigma', 'upstream', { state: 'other' });
        expect(compareToCopyBaseline({ observed: [elsewhere], baseline, units: [...UNITS, { surface: 'settings.backend.sampling', state: 'other' }] }).added).toEqual([]);
        const newWording = observed('Top nsigma', 'upstream', { role: 'tooltip' });
        expect(compareToCopyBaseline({ observed: [newWording], baseline, units: UNITS }).added.map(item => item.record.role)).toEqual(['tooltip']);
    });

    test('an upstream record the run did not see is not a failure; a sillybunny one is', () => {
        const baseline = { ...emptyCopyBaseline(), upstream: [record('Top nsigma')], sillybunny: [record('Reload file')] };
        const comparison = compareToCopyBaseline({ observed: [], baseline, units: UNITS });
        expect(comparison.fixed.map(item => [item.section, item.record.text])).toEqual([['sillybunny', 'Reload file']]);
    });

    test('a sillybunny string is held record by record, even when the same wording is known in another state', () => {
        const baseline = { ...emptyCopyBaseline(), sillybunny: [record('Reload file', { state: 'loaded' })] };
        const elsewhere = observed('Reload file', 'sillybunny', { state: 'other' });
        const comparison = compareToCopyBaseline({ observed: [elsewhere], baseline, units: [{ surface: 'settings.backend.sampling', state: 'other' }] });
        expect(comparison.added.map(item => item.record.text)).toEqual(['Reload file']);
    });

    test('judges only the units that the run collected', () => {
        const baseline = { ...emptyCopyBaseline(), sillybunny: [record('Reload file'), record('Other', { surface: 'dialog.alert.popup-text' })] };
        const comparison = compareToCopyBaseline({ observed: [], baseline, units: UNITS });
        expect(comparison.fixed.map(item => item.record.text)).toEqual(['Reload file']);
    });

    test('reports a string that sits in the other section than its origin says as moved', () => {
        const baseline = { ...emptyCopyBaseline(), upstream: [record('Reload file')] };
        const comparison = compareToCopyBaseline({ observed: [observed('Reload file', 'sillybunny')], baseline, units: UNITS });
        expect(comparison.moved.map(item => [item.from, item.to])).toEqual([['upstream', 'sillybunny']]);
    });

    test('judges a string of unknown origin in the section of its record, and as sillybunny when it has none', () => {
        const baseline = { ...emptyCopyBaseline(), upstream: [record('Top nsigma')] };
        const comparison = compareToCopyBaseline({ observed: [observed('Top nsigma', null), observed('Reload file', null)], baseline, units: UNITS });
        expect(comparison.moved).toEqual([]);
        expect(comparison.added.map(item => [item.section, item.record.text])).toEqual([['sillybunny', 'Reload file']]);
    });
});

describe('uniqueObservations', () => {
    test('keeps the first element that shows a string', () => {
        const unique = uniqueObservations([observed('Reload file', 'sillybunny', { target: 'first' }), observed('Reload file', 'sillybunny', { target: 'second' })]);
        expect(unique.map(item => item.target)).toEqual(['first']);
    });
});

describe('updating the baseline', () => {
    test('lets the sillybunny section shrink and the upstream section change, and leaves other units alone', () => {
        const baseline = { ...emptyCopyBaseline(), sillybunny: [record('Reload file'), record('Other', { surface: 'dialog.alert.popup-text' })] };
        const next = updatedCopyBaseline(baseline, { observed: [observed('Top nsigma', 'upstream')], units: UNITS });
        expect(next.sillybunny.map(item => item.text)).toEqual(['Other']);
        expect(next.upstream.map(item => item.text)).toEqual(['Top nsigma']);
    });

    test('refuses to add to the sillybunny section without the second switch, and writes nothing', async () => {
        expect(() => updatedCopyBaseline(emptyCopyBaseline(), { observed: [observed('Reload file')], units: UNITS })).toThrow(/SURFACE_COPY_ALLOW_SILLYBUNNY=1/);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-baseline-'));
        try {
            const file = path.join(directory, 'copy-baseline.json');
            await expect(updateCopyBaselineFile({ observed: [observed('Reload file')], units: UNITS }, { file })).rejects.toThrow(/sillybunny section/);
            expect(fs.existsSync(file)).toBe(false);
            await updateCopyBaselineFile({ observed: [observed('Reload file')], units: UNITS }, { file, allowSillybunny: true });
            expect(readCopyBaseline(file).sillybunny.map(item => item.text)).toEqual(['Reload file']);
            expect(fs.readFileSync(file, 'utf8')).toBe(formatCopyBaseline(readCopyBaseline(file)));
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('moving a string from upstream to sillybunny needs the second switch as well', () => {
        const baseline = { ...emptyCopyBaseline(), upstream: [record('Reload file')] };
        expect(() => updatedCopyBaseline(baseline, { observed: [observed('Reload file')], units: UNITS })).toThrow(/sillybunny section/);
    });
});

describe('the fixture', () => {
    test('exists, is valid and is formatted the way an update writes it', () => {
        expect(fs.existsSync(COPY_BASELINE_PATH)).toBe(true);
        const baseline = readCopyBaseline();
        expect(validateCopyBaseline(baseline)).toEqual([]);
        expect(formatCopyBaseline(baseline)).toBe(fs.readFileSync(COPY_BASELINE_PATH, 'utf8'));
    });

    test('rejects a repeated record, a record without a role or a target, and a bad version', () => {
        const item = record('Reload file');
        expect(validateCopyBaseline({ ...emptyCopyBaseline(), sillybunny: [item, item] }).join(' ')).toContain('repeats');
        expect(validateCopyBaseline({ ...emptyCopyBaseline(), upstream: [{ ...item, target: '' }] }).join(' ')).toContain('needs a surface');
        expect(validateCopyBaseline({ ...emptyCopyBaseline(), upstream: [{ ...item, role: undefined }] }).join(' ')).toContain('needs a surface');
        expect(validateCopyBaseline({ ...emptyCopyBaseline(), upstream: [{ ...item, expected: undefined }] }).join(' ')).toContain('expected form');
        expect(validateCopyBaseline({ ...emptyCopyBaseline(), upstream: [{ ...item, expected: '' }] })).toEqual([]);
        expect(validateCopyBaseline({ version: 2 })).toHaveLength(1);
    });

    test('names one record once: the key is the surface, state, role and text', () => {
        expect(copyKey(record('a'))).not.toBe(copyKey(record('a', { state: 's' })));
        expect(copyKey(record('a'))).toBe(copyKey({ ...record('a'), target: 'elsewhere', expected: 'A' }));
    });

    /**
     * The file at `HEAD`, or null when `HEAD` has none yet (the commit that adds it) or git cannot answer (an archive without history).
     */
    const fileAtHead = () => {
        try {
            return JSON.parse(execFileSync('git', ['show', 'HEAD:tests/fixtures/copy-baseline.json'], { cwd: path.dirname(COPY_BASELINE_PATH), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 }));
        } catch {
            return null;
        }
    };

    test('only shrinks: the sillybunny section holds no record that HEAD does not already hold', () => {
        const before = fileAtHead();
        if (before === null) {
            return;
        }
        const known = new Set(before.sillybunny.map(copyKey));
        const added = readCopyBaseline().sillybunny.filter(item => !known.has(copyKey(item)));
        // Records that the sillybunny section gained since HEAD: fix the strings instead, or add them with the second switch and a decision.
        expect(added.map(item => `${item.surface}: ${item.role} "${item.text}"`)).toEqual([]);
    });
});
