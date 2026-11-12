import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';
import {
    BASELINE_PATH,
    buildRecords,
    compareToBaseline,
    emptyBaseline,
    formatBaseline,
    formatComparison,
    isSillyBunnyElement,
    lockPathFor,
    normaliseTarget,
    readBaseline,
    recordKey,
    sectionOf,
    sillybunnyAdditions,
    toTriples,
    updateBaselineFile,
    updatedBaseline,
    validateBaseline,
    withFileLock,
} from '../helpers/axe-baseline.js';
import { collectFindings, formatMarkdown, groupOf, summarise, writeSummary } from '../helpers/axe-report.js';

const CELLS = [
    { theme: 'libadwaita', viewport: '1440x900' },
    { theme: 'libadwaita', viewport: '390x844' },
    { theme: 'libadwaita-light', viewport: '1440x900' },
    { theme: 'libadwaita-light', viewport: '390x844' },
];
const DESKTOP = CELLS.filter(cell => cell.viewport === '1440x900');
const unit = (overrides = {}) => ({ surface: 'dialog.about', state: undefined, cells: CELLS, ...overrides });
const seen = (cells, overrides = {}) => cells.map(cell => ({ surface: 'dialog.about', state: undefined, rule: 'color-contrast', target: '.label', cell, section: 'sillybunny', ...overrides }));
const record = (overrides = {}) => ({ surface: 'dialog.about', rule: 'color-contrast', target: '.label', ...overrides });
const baselineOf = (overrides = {}) => ({ version: 1, upstream: [], sillybunny: [], ...overrides });
const compare = (baseline, observations, { units = [unit()], inScope } = {}) => compareToBaseline({ observed: toTriples(observations), baseline, units, inScope });
const empty = { added: [], fixed: [], moved: [], grown: [], shrunk: [] };

describe('normaliseTarget', () => {
    test('drops positions, which move when a neighbour is added', () => {
        expect(normaliseTarget('#sheld > div:nth-child(3) > ul:nth-of-type(2) > li:nth-last-child(1)')).toBe('#sheld > div > ul > li');
    });

    test('keeps ids, classes and attributes that name the element', () => {
        const target = '.sb-row[data-prompt-id="enhanceDefinitions"] > button#save.primary[type="submit"]';
        expect(normaliseTarget(target)).toBe(target);
    });

    test('turns the counter of an id into a star and keeps the prefix that names the element', () => {
        expect(normaliseTarget('#CharID12 > #sb-popup-title-3 > #qr--set--item7 > #draggable_ab12 > #ui-id-14')).toBe('#CharID* > #sb-popup-title-* > #qr--set--item* > #draggable_ab* > #ui-id-*');
        expect(normaliseTarget('#toast-1699999999')).toBe('#toast-*');
    });

    test('reduces an attribute with a numeric or generated value to its name, and a counter in a value to a star', () => {
        expect(normaliseTarget('.mes[mesid="12"] > [data-uid="a1b2c3d4-1111-2222-3333-444455556666"] > #a1b2c3d4e5f6a7b8')).toBe('.mes[mesid] > [data-uid] > #*');
        expect(normaliseTarget('div[name="field3"]')).toBe('div[name="field*"]');
    });

    test('joins the parts of a target inside a shadow root or a frame', () => {
        expect(normaliseTarget(['iframe:nth-child(2)', ['.a:nth-child(1)', '.b']])).toBe('iframe >>> .a >>> .b');
    });

    test('gives the same selector for the same element on every run', () => {
        expect(normaliseTarget('  .a   >  .b:nth-child(7)  ')).toBe(normaliseTarget('.a > .b:nth-child(2)'));
    });
});

describe('sectionOf', () => {
    test('puts every violation of a surface of owner A or C that is not upstream markup in sillybunny, whatever the element', () => {
        expect(sectionOf({ owner: 'A' })).toBe('sillybunny');
        expect(sectionOf({ owner: 'C' }, { sillybunnyElement: false })).toBe('sillybunny');
        expect(sectionOf({ owner: 'A', upstreamMarkup: false })).toBe('sillybunny');
    });

    test('decides by the violating element on a surface of owner B or one with upstream markup', () => {
        for (const surface of [{ owner: 'B' }, { owner: 'A', upstreamMarkup: true }, { owner: 'C', upstreamMarkup: true }]) {
            expect(sectionOf(surface)).toBe('upstream');
            expect(sectionOf(surface, { sillybunnyElement: false })).toBe('upstream');
            expect(sectionOf(surface, { sillybunnyElement: true })).toBe('sillybunny');
        }
    });

    test('reads the id and the classes of the element itself', () => {
        expect(isSillyBunnyElement({ id: 'sb-bottom-chat-select', classes: [] })).toBe(true);
        expect(isSillyBunnyElement({ id: '', classes: ['text_pole', 'ds-row'] })).toBe(true);
        expect(isSillyBunnyElement({ id: '', classes: ['sillybunnyPanel'] })).toBe(true);
        expect(isSillyBunnyElement({ id: 'chat_cfg_guidance_scale_counter', classes: ['text_pole', 'ui-sb-x', 'asb-thing'] })).toBe(false);
        expect(isSillyBunnyElement({})).toBe(false);
    });
});

describe('buildRecords', () => {
    test('names no theme or viewport for a violation that occurs in every cell', () => {
        expect(buildRecords([unit()], seen(CELLS)).sillybunny).toEqual([record()]);
    });

    test('names the theme for a violation of one theme, and the viewport for one of one viewport', () => {
        expect(buildRecords([unit()], seen(CELLS.filter(cell => cell.theme === 'libadwaita-light'))).sillybunny).toEqual([record({ theme: 'libadwaita-light' })]);
        expect(buildRecords([unit()], seen(CELLS.filter(cell => cell.viewport === '390x844'))).sillybunny).toEqual([record({ viewport: '390x844' })]);
    });

    test('names both for a violation of one cell', () => {
        expect(buildRecords([unit()], seen([CELLS[2]])).sillybunny).toEqual([record({ theme: 'libadwaita-light', viewport: '1440x900' })]);
    });

    test('lists a violation on a diagonal one cell at a time, so that the key means exactly the cells where it occurs', () => {
        const records = buildRecords([unit()], seen([CELLS[0], CELLS[3]])).sillybunny;
        expect(records.map(item => [item.theme, item.viewport])).toEqual([['libadwaita', '1440x900'], ['libadwaita-light', '390x844']]);
    });

    test('names no viewport that the scan did not vary', () => {
        expect(buildRecords([unit({ state: 'open', cells: DESKTOP })], seen([DESKTOP[1]], { state: 'open' })).sillybunny).toEqual([record({ state: 'open', theme: 'libadwaita-light' })]);
    });

    test('names the backend of a violation that only some backends show', () => {
        const cells = ['chat-completion', 'horde'].flatMap(backend => CELLS.map(cell => ({ ...cell, backend })));
        expect(buildRecords([unit({ cells })], seen(cells.filter(cell => cell.backend === 'horde'))).sillybunny).toEqual([record({ backend: 'horde' })]);
    });

    test('puts each element in its own section', () => {
        const records = buildRecords([unit()], [...seen(CELLS), ...seen(CELLS, { target: '.upstream', section: 'upstream' })]);
        expect(records.sillybunny.map(item => item.target)).toEqual(['.label']);
        expect(records.upstream.map(item => item.target)).toEqual(['.upstream']);
    });

    test('keeps a count for a sillybunny violation on several elements, and none for upstream', () => {
        const twice = [...seen(CELLS), ...seen(CELLS.slice(0, 2)), ...seen(CELLS, { target: '.up', section: 'upstream' }), ...seen(CELLS, { target: '.up', section: 'upstream' })];
        const records = buildRecords([unit()], twice);
        expect(records.sillybunny).toEqual([record({ count: 2 })]);
        expect(records.upstream).toEqual([{ surface: 'dialog.about', rule: 'color-contrast', target: '.up' }]);
    });

    test('rejects a violation of a unit that was not scanned', () => {
        expect(() => buildRecords([unit()], seen(CELLS, { state: 'missing' }))).toThrow('no scanned unit');
    });
});

describe('compareToBaseline', () => {
    const baseline = baselineOf({ upstream: [record({ surface: 'dialog.upstream', target: '.up' })], sillybunny: [record(), record({ rule: 'button-name', target: '.close' })] });
    const units = [unit(), unit({ surface: 'dialog.upstream' })];
    const same = [
        ...seen(CELLS),
        ...seen(CELLS, { rule: 'button-name', target: '.close' }),
        ...seen(CELLS, { surface: 'dialog.upstream', target: '.up', section: 'upstream' }),
    ];

    test('is empty when the run equals the file', () => {
        const comparison = compare(baseline, same, { units });
        expect(comparison).toEqual(empty);
        expect(formatComparison(comparison)).toEqual([]);
    });

    test('fails a violation that is in neither section, whichever section it would join', () => {
        const { added } = compare(baseline, [...same, ...seen(CELLS, { rule: 'image-alt', target: 'img' }), ...seen(CELLS, { surface: 'dialog.upstream', rule: 'label', target: 'input', section: 'upstream' })], { units });
        expect(added.map(item => [item.section, item.record.rule])).toEqual([['upstream', 'label'], ['sillybunny', 'image-alt']]);
        expect(formatComparison(compare(baseline, [...same, ...seen(CELLS, { rule: 'image-alt', target: 'img' })], { units }), { cellsOf: () => 'libadwaita 1440x900' })[0]).toContain('[seen in: libadwaita 1440x900] [sillybunny section]');
    });

    test('a violation fixed in one cell of four is a removal, not a new record', () => {
        const comparison = compare(baselineOf({ sillybunny: [record()] }), seen(CELLS.slice(0, 3)));
        expect(comparison.added).toEqual([]);
        expect(comparison.fixed).toEqual([{ section: 'sillybunny', record: record({ theme: 'libadwaita-light', viewport: '390x844' }) }]);
        expect(() => updatedBaseline(baselineOf({ sillybunny: [record()] }), { observed: toTriples(seen(CELLS.slice(0, 3))), units: [unit()], inScope: () => true })).not.toThrow();
    });

    test('a violation fixed in one theme is a removal of that theme', () => {
        const comparison = compare(baselineOf({ sillybunny: [record()] }), seen(CELLS.filter(cell => cell.theme === 'libadwaita-light')));
        expect(comparison.added).toEqual([]);
        expect(comparison.fixed).toEqual([{ section: 'sillybunny', record: record({ theme: 'libadwaita' }) }]);
        const next = updatedBaseline(baselineOf({ sillybunny: [record()] }), { observed: toTriples(seen(CELLS.filter(cell => cell.theme === 'libadwaita-light'))), units: [unit()], inScope: () => true });
        expect(next.sillybunny).toEqual([record({ theme: 'libadwaita-light' })]);
    });

    test('a violation that appears in one more cell fails', () => {
        const comparison = compare(baselineOf({ sillybunny: [record({ theme: 'libadwaita-light' })] }), seen([...CELLS.filter(cell => cell.theme === 'libadwaita-light'), CELLS[0]]));
        expect(comparison.added).toEqual([{ section: 'sillybunny', record: record({ theme: 'libadwaita', viewport: '1440x900' }) }]);
        expect(comparison.fixed).toEqual([]);
        expect(() => updatedBaseline(baselineOf({ sillybunny: [record({ theme: 'libadwaita-light' })] }), { observed: toTriples(seen([...CELLS.filter(cell => cell.theme === 'libadwaita-light'), CELLS[0]])), units: [unit()], inScope: () => true })).toThrow('SURFACE_AXE_ALLOW_SILLYBUNNY=1');
    });

    test('leaves a cell that this run did not scan alone', () => {
        const mobileOnly = baselineOf({ sillybunny: [record({ viewport: '390x844' })] });
        expect(compare(mobileOnly, [], { units: [unit({ cells: DESKTOP })] })).toEqual(empty);
        const everywhere = baselineOf({ sillybunny: [record()] });
        expect(compare(everywhere, seen(DESKTOP), { units: [unit({ cells: DESKTOP })] })).toEqual(empty);
        const kept = updatedBaseline(mobileOnly, { observed: [], units: [unit({ cells: DESKTOP })], inScope: () => true });
        expect(kept.sillybunny).toEqual([record({ viewport: '390x844' })]);
    });

    test('fails a record of a state that is gone, in either section', () => {
        for (const section of ['upstream', 'sillybunny']) {
            const comparison = compare(baselineOf({ [section]: [record({ state: 'removed' })] }), []);
            expect(comparison.fixed).toEqual([{ section, record: record({ state: 'removed' }) }]);
        }
    });

    test('fails a record that no longer occurs in either section, and says to remove it from the baseline', () => {
        for (const section of ['upstream', 'sillybunny']) {
            const comparison = compare(baselineOf({ [section]: [record({ rule: 'gone' })] }), []);
            expect(comparison.fixed).toEqual([{ section, record: record({ rule: 'gone' }) }]);
            const message = formatComparison(comparison).join('\n');
            expect(message).toContain('no longer occur');
            expect(message).toContain('Remove the fixed records from the baseline');
            expect(message).toContain('npx playwright test');
            expect(message).not.toContain('~/bin');
        }
    });

    test('reports a violation that sits in the other section than its element belongs to as moved', () => {
        const comparison = compare(baselineOf({ sillybunny: [record()] }), seen(CELLS, { section: 'upstream' }));
        expect(comparison.moved).toEqual([{ from: 'sillybunny', to: 'upstream', record: record() }]);
        expect(comparison.added).toEqual([]);
        expect(comparison.fixed).toEqual([]);
        expect(formatComparison(comparison).join('\n')).toContain('SURFACE_AXE_UPDATE=1');
        expect(sillybunnyAdditions(compare(baselineOf({ upstream: [record()] }), seen(CELLS)))).toEqual([record()]);
        expect(sillybunnyAdditions(comparison)).toEqual([]);
    });

    test('compares the number of elements of a sillybunny record', () => {
        const three = baselineOf({ sillybunny: [record({ count: 3 })] });
        const more = compare(three, [...seen(CELLS), ...seen(CELLS), ...seen(CELLS), ...seen(CELLS)]);
        expect(more.grown).toHaveLength(1);
        expect(more.grown[0]).toMatchObject({ from: 3, to: 4 });
        expect(formatComparison(more).join('\n')).toContain('more elements than the baseline holds');
        expect(() => updatedBaseline(three, { observed: toTriples([...seen(CELLS), ...seen(CELLS), ...seen(CELLS), ...seen(CELLS)]), units: [unit()], inScope: () => true })).toThrow('sillybunny section');
        const fewer = compare(three, [...seen(CELLS), ...seen(CELLS)]);
        expect(fewer.shrunk[0]).toMatchObject({ from: 3, to: 2 });
        expect(formatComparison(fewer).join('\n')).toContain('Remove the fixed records');
        expect(updatedBaseline(three, { observed: toTriples([...seen(CELLS), ...seen(CELLS)]), units: [unit()], inScope: () => true }).sillybunny).toEqual([record({ count: 2 })]);
        const one = compare(baselineOf({ sillybunny: [record()] }), [...seen(CELLS), ...seen(CELLS)]);
        expect(one.grown).toHaveLength(1);
    });

    test('compares a record with the highest count of its cells, not cell by cell', () => {
        const rows = (cells, count) => cells.flatMap(cell => Array.from({ length: count }, () => seen([cell])[0]));
        const observations = [...rows(DESKTOP, 5), ...rows(CELLS.filter(cell => cell.viewport === '390x844'), 2)];
        const records = buildRecords([unit()], observations).sillybunny;
        expect(records).toEqual([record({ count: 5 })]);
        expect(compare(baselineOf({ sillybunny: records }), observations)).toEqual(empty);
    });

    test('judges only the records in scope', () => {
        const comparison = compare(baseline, seen(CELLS, { surface: 'dialog.other', rule: 'label' }), { units: [unit({ surface: 'dialog.other' })], inScope: item => item.surface === 'dialog.other' });
        expect(comparison.added).toHaveLength(1);
        expect(comparison.fixed).toEqual([]);
    });

    test('tells records of different cells apart', () => {
        expect(recordKey(record({ theme: 'libadwaita' }))).not.toBe(recordKey(record({ theme: 'libadwaita-light' })));
        expect(recordKey(record())).not.toBe(recordKey(record({ state: 'open' })));
    });
});

describe('updating the baseline', () => {
    const baseline = baselineOf({ upstream: [record({ surface: 'dialog.upstream' })], sillybunny: [record(), record({ surface: 'dialog.other' })] });
    const about = item => item.surface === 'dialog.about';
    const run = (observations, units = [unit()], inScope = about) => ({ observed: toTriples(observations), units, inScope });

    test('lets the sillybunny section shrink, and leaves the surfaces outside the scope alone', () => {
        const next = updatedBaseline(baseline, run([]));
        expect(next.sillybunny).toEqual([record({ surface: 'dialog.other' })]);
        expect(next.upstream).toEqual(baseline.upstream);
    });

    test('removes a fixed record from either section without the second variable', () => {
        expect(updatedBaseline(baseline, run([], [unit(), unit({ surface: 'dialog.upstream' }), unit({ surface: 'dialog.other' })], () => true))).toEqual({ version: 1, upstream: [], sillybunny: [] });
    });

    test('adds to the upstream section without the second variable', () => {
        const next = updatedBaseline(baseline, run([...seen(CELLS, { surface: 'dialog.upstream', section: 'upstream' }), ...seen(CELLS, { surface: 'dialog.upstream', rule: 'label', section: 'upstream' })], [unit({ surface: 'dialog.upstream' })], item => item.surface === 'dialog.upstream'));
        expect(next.upstream).toHaveLength(2);
    });

    test('refuses to add to the sillybunny section without the second variable', () => {
        const observations = [...seen(CELLS), ...seen(CELLS, { rule: 'image-alt', target: 'img' })];
        expect(() => updatedBaseline(baseline, run(observations))).toThrow('SURFACE_AXE_ALLOW_SILLYBUNNY=1');
        expect(updatedBaseline(baseline, run(observations), { allowSillybunny: true }).sillybunny).toHaveLength(3);
    });

    test('writes the file, one record per line in key order, and takes the same file back', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axe-baseline-'));
        const file = path.join(directory, 'axe-baseline.json');
        try {
            await updateBaselineFile(run([...seen(CELLS, { rule: 'b-rule' }), ...seen(CELLS, { rule: 'a-rule' })]), { allowSillybunny: true, file });
            const text = fs.readFileSync(file, 'utf8');
            expect(text.split('\n').filter(line => line.includes('"rule"'))).toHaveLength(2);
            expect(text.indexOf('a-rule')).toBeLessThan(text.indexOf('b-rule'));
            expect(readBaseline(file)).toEqual({ version: 1, upstream: [], sillybunny: [record({ rule: 'a-rule' }), record({ rule: 'b-rule' })] });
            expect(formatBaseline(readBaseline(file))).toBe(text);
            await expect(updateBaselineFile(run([...seen(CELLS, { rule: 'a-rule' }), ...seen(CELLS, { rule: 'new' })]), { file })).rejects.toThrow('sillybunny section');
            expect(fs.readFileSync(file, 'utf8')).toBe(text);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('two updates at once with different scopes both keep their records', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axe-baseline-'));
        const file = path.join(directory, 'axe-baseline.json');
        try {
            const surfaces = Array.from({ length: 6 }, (_, index) => `dialog.s${index}`);
            await Promise.all(surfaces.map(surface => updateBaselineFile(
                run(seen(CELLS, { surface }), [unit({ surface })], item => item.surface === surface),
                { allowSillybunny: true, file },
            )));
            expect(readBaseline(file).sillybunny.map(item => item.surface).sort()).toEqual(surfaces);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});

describe('the lock', () => {
    const scratch = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'axe-lock-')), 'file.json');

    test('lives in the temp directory, not beside the file', () => {
        const file = scratch();
        expect(lockPathFor(file).startsWith(os.tmpdir())).toBe(true);
        expect(path.dirname(lockPathFor(file))).not.toBe(path.dirname(file));
        expect(lockPathFor(file)).not.toBe(lockPathFor(`${file}.other`));
    });

    test('is released when the work throws', async () => {
        const file = scratch();
        await expect(withFileLock(file, () => {
            throw new Error('boom');
        })).rejects.toThrow('boom');
        expect(fs.existsSync(lockPathFor(file))).toBe(false);
        await expect(withFileLock(file, () => 'next')).resolves.toBe('next');
    });

    test('takes turns, and two waiters that find a stale lock at once do not run together', async () => {
        const file = scratch();
        const lock = lockPathFor(file);
        fs.mkdirSync(lock, { recursive: true });
        const old = new Date(Date.now() - 10 * 60_000);
        fs.utimesSync(lock, old, old);
        let running = 0;
        let overlapped = false;
        const work = async () => {
            running++;
            overlapped ||= running > 1;
            await new Promise(resolve => setTimeout(resolve, 20));
            running--;
        };
        await Promise.all(Array.from({ length: 5 }, () => withFileLock(file, work)));
        expect(overlapped).toBe(false);
        expect(fs.existsSync(lock)).toBe(false);
    });
});

describe('the fixture', () => {
    test('exists, is valid and is formatted the way an update writes it', () => {
        // The fixture is committed; a missing file must fail here instead of skipping the checks below.
        expect(fs.existsSync(BASELINE_PATH)).toBe(true);
        const baseline = readBaseline();
        expect(validateBaseline(baseline)).toEqual([]);
        expect(formatBaseline(baseline)).toBe(fs.readFileSync(BASELINE_PATH, 'utf8'));
    });

    test('rejects a repeated record, a record without a target, and a count in the upstream section', () => {
        const item = { surface: 'a.b', rule: 'r', target: 't' };
        expect(validateBaseline({ ...emptyBaseline(), sillybunny: [item, item] }).join(' ')).toContain('repeats');
        expect(validateBaseline({ ...emptyBaseline(), upstream: [{ surface: 'a.b', rule: 'r' }] }).join(' ')).toContain('needs a surface, a rule and a target');
        expect(validateBaseline({ ...emptyBaseline(), upstream: [{ ...item, count: 2 }] }).join(' ')).toContain('count');
        expect(validateBaseline({ ...emptyBaseline(), sillybunny: [{ ...item, count: 1 }] }).join(' ')).toContain('count');
        expect(validateBaseline({ ...emptyBaseline(), sillybunny: [{ ...item, count: 2 }] })).toEqual([]);
        expect(validateBaseline({ version: 2 })).toHaveLength(1);
    });
});

describe('the report', () => {
    const node = (target, section = 'sillybunny') => ({ target, section, selector: target, html: '<img>', failureSummary: 'Fix any of the following:\n  Element does not have an alt attribute' });
    const run = (theme, viewport, nodes, state, extra = {}) => ({
        state, backend: undefined, theme, viewport, incomplete: [{ id: 'color-contrast', nodes: 2 }], bestPractice: [],
        violations: [{ id: 'image-alt', impact: 'critical', group: 'wcag2a', help: 'Images need alternative text', helpUrl: 'https://example.test', nodes }],
        ...extra,
    });
    const digest = (surface, owner, runs, extra = {}) => ({
        surface, family: 'dialog', owner, runs: runs.length, errors: [], incomplete: { 'color-contrast': runs.length * 2 }, findings: collectFindings(runs),
        bestPractice: collectFindings(runs.map(item => ({ ...item, violations: item.bestPractice }))), ...extra,
    });

    test('puts a rule in the first group that it carries', () => {
        expect(groupOf(['cat.text-alternatives', 'wcag2a', 'wcag111'])).toBe('wcag2a');
        expect(groupOf(['cat.keyboard', 'best-practice'])).toBe('best-practice');
        expect(groupOf(['wcag21aa', 'wcag22aa'])).toBe('wcag21aa');
    });

    test('merges the runs of a surface into findings with their cells', () => {
        const findings = collectFindings([run('libadwaita', '1440x900', [node('img.a'), node('img.b')]), run('libadwaita-light', '1440x900', [node('img.a')])]);
        expect(findings.map(finding => [finding.target, finding.cells.map(cell => cell.theme)])).toEqual([
            ['img.a', ['libadwaita', 'libadwaita-light']],
            ['img.b', ['libadwaita']],
        ]);
    });

    test('summarises by rule, by surface and by owner class, with the section of each element', () => {
        const summary = summarise([
            digest('dialog.a', 'A', [run('libadwaita', '1440x900', [node('img.a'), node('img.b')])]),
            digest('dialog.b', 'B', [run('libadwaita', '1440x900', [node('img.c', 'upstream'), node('img.d.sb-x', 'sillybunny')])]),
        ]);
        expect(summary.totals).toMatchObject({ surfaces: 2, findings: 4, byImpact: { critical: 4 }, byOwner: { A: 2, B: 2 }, bySection: { sillybunny: 3, upstream: 1 } });
        expect(summary.byRule[0]).toMatchObject({ rule: 'image-alt', findings: 4, byOwner: { A: 2, B: 2 } });
        expect(summary.bySurface.map(surface => [surface.surface, surface.findings, surface.sillybunny])).toEqual([['dialog.a', 2, 2], ['dialog.b', 2, 1]]);
        expect(summary.undecided.nodeRuns).toEqual({ 'color-contrast': 4 });
    });

    test('keeps the best practices apart from the findings that gate', () => {
        const bestPractice = [{ id: 'landmark-unique', impact: 'moderate', group: 'best-practice', help: 'Landmarks must be unique', helpUrl: 'https://example.test/l', nodes: [node('nav')] }];
        const summary = summarise([digest('dialog.a', 'A', [run('libadwaita', '1440x900', [node('img.a')], undefined, { bestPractice })])]);
        expect(summary.totals.findings).toBe(1);
        expect(summary.bestPractice.map(rule => [rule.rule, rule.findings])).toEqual([['landmark-unique', 1]]);
        expect(formatMarkdown(summary)).toContain('## Best practices (reported, not gated)');
    });

    test('lists the skipped surfaces, the undecided node-runs and the runs that did not settle in the markdown', () => {
        const many = Array.from({ length: 12 }, (_, index) => digest(`dialog.s${index}`, 'A', [run('libadwaita', '1440x900', [node('img')])], { incomplete: { 'color-contrast': 100 + index }, unsettled: index === 0 ? ['libadwaita 1440x900 surface (still changing or loading)'] : [] }));
        const summary = summarise(many, { 'status.skipped': 'closes itself shortly after it opens' });
        expect(summary.undecided.colorContrastBySurface).toHaveLength(10);
        expect(summary.undecided.colorContrastBySurface[0]).toEqual({ surface: 'dialog.s11', nodeRuns: 111 });
        const markdown = formatMarkdown(summary);
        expect(markdown).toContain('## Surfaces left out of the scan');
        expect(markdown).toContain('status.skipped: closes itself shortly after it opens');
        expect(markdown).toContain('## Undecided (axe could not decide), in node-runs');
        expect(markdown).toContain('- dialog.s11: 111');
        expect(markdown).toContain('## Scanned before the surface settled');
        expect(markdown).toContain('dialog.s0: libadwaita 1440x900 surface (still changing or loading)');
    });

    test('keeps the skipped section when the summary is rebuilt from the digests alone', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axe-report-'));
        try {
            fs.mkdirSync(path.join(directory, 'surfaces'));
            fs.writeFileSync(path.join(directory, 'surfaces', 'dialog.a.json'), JSON.stringify(digest('dialog.a', 'A', [run('libadwaita', '1440x900', [node('img.a')])])));
            writeSummary(directory, ['dialog.a'], { 'status.skipped': 'a reason' });
            const rebuilt = writeSummary(directory, ['dialog.a']);
            expect(rebuilt.skipped).toEqual({ 'status.skipped': 'a reason' });
            expect(fs.readFileSync(path.join(directory, 'summary.md'), 'utf8')).toContain('status.skipped: a reason');
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
