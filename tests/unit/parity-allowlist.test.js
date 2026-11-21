import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from '@jest/globals';
import { LIBADWAITA_AUDIT_ALLOWLIST } from '../helpers/libadwaita-audit.js';
import { readAllowlist, readRatchet } from '../helpers/parity/allowlist.js';
import { buildFamilyCensus, buildSummary } from '../helpers/parity/census.js';
import {
    TEMPORARY_REASON,
    buildRows,
    checkSurface,
    compareToRatchet,
    entriesFromRows,
    entryKey,
    entryProblems,
    kindOf,
    mergeEntries,
    nextRatchet,
    normaliseValue,
    outliersOf,
    prepareRules,
    roundHalf,
    ruleProblems,
    rulesFor,
    temporaryCounts,
    unmatchedRegistered,
    valuesAgree,
} from '../helpers/parity/compare.js';
import { PARITY_FAMILIES, RULES } from '../helpers/parity/index.js';
import { viewportsFor } from '../helpers/surface-matrix.js';
import { LOAD_PROBLEMS, SURFACES } from '../helpers/surfaces/index.js';

const scriptFile = fileURLToPath(new URL('../../scripts/update-parity-allowlist.js', import.meta.url));

const rules = {
    family: 'status',
    forms: { sheet: { media: '(max-width: 450px)' } },
    parts: [
        {
            id: 'title',
            selectors: [{ id: 'shared', selector: '.t' }, { id: 'own', selector: 'strong' }],
            properties: [
                { property: 'fontSize', value: 20, source: 'census' },
                { property: 'textAlign', value: 'center', source: 'census' },
                { property: 'borderTopLeftRadius', token: '--sb-radius-card', source: 'DESIGN.md' },
                { property: 'borderTopWidth', value: 1, source: 'DESIGN.md' },
                { property: 'offsetHeight', value: { fine: 40, coarse: 44 }, floor: true, source: 'DESIGN.md' },
                { property: 'flexDirection', forms: [{ form: 'sheet', value: 'column-reverse' }], source: 'DESIGN.md' },
            ],
        },
        { id: 'icon', only: '^status\\.a\\.', selectors: [{ id: 'shared', selector: '.i' }, { id: 'ready', ready: true, only: 'one$' }], properties: [{ property: 'fontSize', value: 96, source: 'census' }] },
    ],
};

const cell = (value, count = 1, forms = []) => ({ value, forms, count, element: 'h3.t', alternative: 'shared' });

const BASE_CELLS = {
    fontSize: [cell('20px')],
    textAlign: [cell('center')],
    borderTopLeftRadius: [cell('12px')],
    borderTopWidth: [cell('1px')],
    offsetHeight: [cell(40)],
    flexDirection: [cell('row')],
};

const measured = ({ cells = {}, pointer = 'fine', alternatives = { shared: 1 }, icon = { absent: true } } = {}) => ({
    pointer,
    tokens: { 'borderTopLeftRadius|--sb-radius-card': '12px' },
    parts: {
        title: { absent: false, instances: Object.values(alternatives).reduce((total, count) => total + count, 0), capped: false, alternatives, cells: { ...BASE_CELLS, ...cells } },
        icon,
    },
});

const rowsOf = (options, surface = 'status.a.one', viewport = '1440x900') => buildRows({ surface, viewport, rules, measured: measured(options) }).rows;

describe('comparing a value with the canonical one', () => {
    test('a border, a radius, a padding and a font size agree within half a pixel and not beyond', () => {
        expect(valuesAgree(0, 1, 'length')).toBe(false);
        expect(valuesAgree(9, 10, 'length')).toBe(false);
        expect(valuesAgree(14, 15, 'length')).toBe(false);
        expect(valuesAgree(15.5, 15, 'length')).toBe(true);
        expect(valuesAgree(15, 15, 'length')).toBe(true);
        expect(kindOf('borderTopWidth')).toBe('length');
        expect(kindOf('columnGap')).toBe('length');
    });

    test('a size agrees within 1px, and a floor is satisfied by anything at or above it', () => {
        expect(kindOf('offsetWidth')).toBe('size');
        expect(kindOf('offsetHeight')).toBe('size');
        expect(kindOf('minHeight')).toBe('size');
        expect(valuesAgree(45, 44, 'size')).toBe(true);
        expect(valuesAgree(46, 44, 'size')).toBe(false);
        expect(valuesAgree(300, 44, 'size', true)).toBe(true);
        expect(valuesAgree(43, 44, 'size', true)).toBe(true);
        expect(valuesAgree(42, 44, 'size', true)).toBe(false);
    });

    test('a length is rounded to half a pixel, and text and counts are compared as they are', () => {
        expect(roundHalf(12.26)).toBe(12.5);
        expect(normaliseValue('13.74px', 'length')).toBe(13.5);
        expect(normaliseValue(44, 'size')).toBe(44);
        expect(normaliseValue('auto', 'size')).toBe('auto');
        expect(valuesAgree('auto', 44, 'size')).toBe(false);
        expect(valuesAgree('center', 'center', 'exact')).toBe(true);
        expect(valuesAgree('start', 'center', 'exact')).toBe(false);
        expect(normaliseValue('700', 'exact')).toBe('700');
        expect(kindOf('auditRowEdges')).toBe('exact');
        expect(normaliseValue(3, 'exact', 'auditRowEdges')).toBe(3);
        expect(valuesAgree(3, 0, 'exact')).toBe(false);
        expect(valuesAgree(0, 0, 'exact')).toBe(true);
    });

    test('left is start and right is end for the alignment of text', () => {
        expect(normaliseValue('left', 'exact', 'textAlign')).toBe('start');
        expect(normaliseValue('right', 'exact', 'textAlign')).toBe('end');
        expect(normaliseValue('left', 'exact', 'justifyContent')).toBe('left');
    });
});

describe('rows of a measurement', () => {
    test('one row per distinct value, a markup row for each alternative used, and a state for each part', () => {
        const { rows, parts } = buildRows({ surface: 'status.a.one', viewport: '1440x900', rules, measured: measured({ cells: { fontSize: [cell('20px', 3), cell('22px', 2)] }, alternatives: { shared: 3, own: 2 } }) });
        expect(rows.filter(row => row.property === 'markup').map(row => `${row.value}:${row.count}:${row.agree}`)).toEqual(['shared:3:true', 'own:2:false']);
        expect(rows.filter(row => row.property === 'fontSize').map(row => `${row.value}:${row.count}:${row.agree}`)).toEqual(['20:3:true', '22:2:false']);
        expect(rows.find(row => row.property === 'borderTopLeftRadius')).toMatchObject({ canonical: 12, source: 'DESIGN.md', agree: true });
        expect(parts).toEqual([
            { part: 'title', absent: false, instances: 5, capped: false, alternatives: { shared: 3, own: 2 } },
            { part: 'icon', absent: true },
        ]);
    });

    test('values that differ only below half a pixel become one row', () => {
        const { rows } = buildRows({ surface: 's', viewport: '1440x900', rules, measured: measured({ cells: { fontSize: [cell('20.1px', 2), cell('19.9px', 1)] } }) });
        expect(rows.filter(row => row.property === 'fontSize')).toMatchObject([{ value: 20, count: 3 }]);
    });

    test('a border of 0 against a canonical 1 is an outlier, and so is a font size 1px off', () => {
        const [border] = outliersOf(rowsOf({ cells: { borderTopWidth: [cell('0px', 26)] } }));
        expect(border).toMatchObject({ part: 'title', property: 'borderTopWidth', value: 0, count: 26, canonical: 1, agree: false });
        expect(outliersOf(rowsOf({ cells: { fontSize: [cell('21px')] } }))).toHaveLength(1);
        expect(outliersOf(rowsOf({ cells: { fontSize: [cell('20.4px')] } }))).toHaveLength(0);
    });

    test('a part that the member lacks is absent, with no rows and no outlier', () => {
        const { rows, parts } = buildRows({ surface: 's', viewport: '1440x900', rules, measured: measured() });
        expect(rows.some(row => row.part === 'icon')).toBe(false);
        expect(parts.find(state => state.part === 'icon')).toEqual({ part: 'icon', absent: true });
    });

    test('a target size follows the pointer of the page, and a floor allows a taller element', () => {
        expect(outliersOf(rowsOf({ pointer: 'fine', cells: { offsetHeight: [cell(40)] } }))).toHaveLength(0);
        expect(outliersOf(rowsOf({ pointer: 'coarse', cells: { offsetHeight: [cell(40)] } }))[0]).toMatchObject({ property: 'offsetHeight', canonical: 44, floor: true });
        expect(outliersOf(rowsOf({ pointer: 'coarse', cells: { offsetHeight: [cell(287)] } }))).toHaveLength(0);
    });

    test('a pair with one pointer missing is not compared for the other', () => {
        const pairRules = { ...rules, parts: [{ id: 'title', selectors: [{ id: 'shared', selector: '.t' }], properties: [{ property: 'offsetHeight', value: { coarse: 44 }, floor: true, source: 'DESIGN.md' }] }] };
        const input = pointer => ({ pointer, tokens: {}, parts: { title: { absent: false, instances: 1, capped: false, alternatives: { shared: 1 }, cells: { offsetHeight: [cell(38)] } } } });
        expect(buildRows({ surface: 's', viewport: 'v', rules: pairRules, measured: input('fine') }).rows[0]).toMatchObject({ canonical: null, agree: true });
        expect(outliersOf(buildRows({ surface: 's', viewport: 'v', rules: pairRules, measured: input('coarse') }).rows)).toHaveLength(1);
    });

    test('a rule that DESIGN.md states for a form applies to the instances in that form and to no others', () => {
        const inSheet = rowsOf({ cells: { flexDirection: [cell('column-reverse', 1, ['sheet'])] } });
        expect(inSheet.find(row => row.property === 'flexDirection')).toMatchObject({ canonical: 'column-reverse', form: 'sheet', agree: true });
        expect(outliersOf(rowsOf({ cells: { flexDirection: [cell('column', 1, ['sheet'])] } }))[0]).toMatchObject({ canonical: 'column-reverse', value: 'column' });
        expect(rowsOf({ cells: { flexDirection: [cell('row')] } }).find(row => row.property === 'flexDirection')).toMatchObject({ canonical: null, agree: true });
    });

    test('a form can change a token and the default applies outside it', () => {
        const formRules = { ...rules, forms: { card: { closest: '.x' } }, parts: [{ id: 'title', selectors: [{ id: 'shared', selector: '.t' }], properties: [{ property: 'borderTopLeftRadius', token: '--sb-radius-lg', forms: [{ form: 'card', token: '--sb-radius-card' }], source: 'DESIGN.json' }] }] };
        const tokens = { 'borderTopLeftRadius|--sb-radius-lg': '16px', 'borderTopLeftRadius|--sb-radius-card': '12px' };
        const input = cells => ({ pointer: 'fine', tokens, parts: { title: { absent: false, instances: 2, capped: false, alternatives: { shared: 2 }, cells: { borderTopLeftRadius: cells } } } });
        const { rows } = buildRows({ surface: 's', viewport: 'v', rules: formRules, measured: input([cell('12px', 1, ['card']), cell('16px', 1, [])]) });
        expect(rows.map(row => `${row.value}:${row.canonical}:${row.agree}`)).toEqual(['12:12:true', '16:16:true']);
    });

    test('a part with `only` applies to the surfaces whose id matches, and so does an alternative', () => {
        expect(rulesFor(rules, 'status.a.one').parts.map(part => part.id)).toEqual(['title', 'icon']);
        expect(rulesFor(rules, 'status.b.one').parts.map(part => part.id)).toEqual(['title']);
        expect(rulesFor(rules, 'status.a.one').parts[1].selectors.map(alternative => alternative.id)).toEqual(['shared', 'ready']);
        expect(rulesFor(rules, 'status.a.two').parts[1].selectors.map(alternative => alternative.id)).toEqual(['shared']);
    });

    test('the rules sent to the page carry the selectors, forms and tokens, and no canonical text', () => {
        const prepared = prepareRules(rules);
        expect(prepared.forms).toEqual(rules.forms);
        expect(prepared.parts[0].properties.find(property => property.property === 'borderTopLeftRadius').token).toBe('--sb-radius-card');
        expect(prepared.parts[0].properties.find(property => property.property === 'flexDirection').formNames).toEqual(['sheet']);
        expect(JSON.stringify(prepared)).not.toContain('column-reverse');
        expect(prepared.parts[1].selectors[1]).toEqual({ id: 'ready', selector: '', ready: true });
    });
});

describe('the shape of the rules', () => {
    test('rules that follow the grammar have no problems', () => {
        expect(ruleProblems(rules)).toEqual([]);
    });

    test('each fault is named: a missing value, an unknown source or form, a floor on a length, a pair on a length, a root fallback', () => {
        const broken = {
            family: 'status',
            forms: { sheet: { media: 'x', closest: 'y' } },
            parts: [{
                id: 'title',
                selectors: [{ id: 'shared', selector: '.t' }, { id: 'own', selector: ':scope' }],
                properties: [
                    { property: 'fontSize', source: 'census' },
                    { property: 'paddingTop', value: 4, source: 'plan.md' },
                    { property: 'borderTopWidth', value: 1, floor: true, source: 'census' },
                    { property: 'columnGap', value: { fine: 1, coarse: 2 }, source: 'census' },
                    { property: 'textAlign', value: 'start', forms: [{ form: 'nowhere', value: 'end' }], source: 'census' },
                    { property: 'offsetWidth', value: 40, alts: ['missing'], source: 'census' },
                ],
            }],
        };
        const problems = ruleProblems(broken).join('\n');
        expect(problems).toContain('the form sheet needs a media query or an ancestor selector, and only one');
        expect(problems).toContain('measures the surface root as the part');
        expect(problems).toContain('fontSize: there is no canonical value');
        expect(problems).toContain('paddingTop: the source must be one of DESIGN.md, DESIGN.json, token, census');
        expect(problems).toContain('borderTopWidth: a floor applies to sizes only');
        expect(problems).toContain('columnGap: a fine and coarse pair applies to target sizes only');
        expect(problems).toContain('the form nowhere is not defined by the family');
        expect(problems).toContain('alts names missing');
    });

    test('the plan is not a canonical source', () => {
        expect(ruleProblems({ ...rules, parts: [{ ...rules.parts[0], properties: [{ property: 'fontSize', value: 20, source: 'plan.md' }] }] })).toHaveLength(1);
    });
});

const entry = (overrides = {}) => ({
    family: 'status',
    surface: 'status.a.one',
    viewport: '1440x900',
    part: 'title',
    property: 'fontSize',
    value: 22,
    canonical: 20,
    kind: 'temporary',
    reason: TEMPORARY_REASON,
    ...overrides,
});

describe('checking a surface against the allow-list', () => {
    const check = (rows, entries, viewport = '1440x900') => checkSurface({ surface: 'status.a.one', viewport, rows, entries });
    const wide = { cells: { fontSize: [cell('22px', 4)] } };

    test('a surface that agrees with the canonical values passes with an empty allow-list', () => {
        expect(check(rowsOf(), []).failures).toEqual([]);
    });

    test('an outlier without an entry fails and names the surface, part, property, value, count and canonical value', () => {
        const { failures } = check(rowsOf(wide), []);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('status.a.one');
        expect(failures[0]).toContain('title fontSize is 22 in 4 of the instances');
        expect(failures[0]).toContain('canonical value is 20');
        expect(failures[0]).toContain('census');
    });

    test('an outlier with the entry for its value passes', () => {
        const { failures, allowed } = check(rowsOf(wide), [entry()]);
        expect(failures).toEqual([]);
        expect(allowed).toHaveLength(1);
    });

    test('an entry covers one value of a cell: a second value in the same cell still fails', () => {
        const { failures } = check(rowsOf({ cells: { fontSize: [cell('22px'), cell('24px')] } }), [entry()]);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('title fontSize is 24');
        expect(failures[0]).toContain('records 22');
    });

    test('an entry whose value no longer occurs fails with "remove this entry", while the cell\'s other entries still apply', () => {
        const { failures } = check(rowsOf({ cells: { fontSize: [cell('22px')] } }), [entry(), entry({ value: 25 })]);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('remove this entry');
        expect(failures[0]).toContain('25');
    });

    test('an entry whose difference no longer occurs fails with "remove this entry"', () => {
        const { failures } = check(rowsOf(), [entry()]);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('remove this entry');
        expect(failures[0]).toContain('title fontSize');
    });

    test('an entry whose part is absent fails the same way', () => {
        expect(check(rowsOf().filter(row => row.part !== 'title'), [entry()]).failures[0]).toContain('remove this entry');
    });

    test('an outlier whose value differs from the only entry of its cell fails once and says what the entry records', () => {
        const { failures } = check(rowsOf({ cells: { fontSize: [cell('24px')] } }), [entry()]);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('is 24');
        expect(failures[0]).toContain('records 22');
    });

    test('entries of another surface or viewport are not this test\'s business', () => {
        const others = [entry({ surface: 'status.a.two' }), entry({ viewport: '390x844' })];
        expect(check(rowsOf(), others).failures).toEqual([]);
    });

    test('a registered entry for every viewport allows the difference and is never stale in one test', () => {
        const registered = entry({ viewport: '*', kind: 'registered', reason: 'DESIGN.md Dialogs' });
        expect(check(rowsOf(wide), [registered]).failures).toEqual([]);
        expect(check(rowsOf(), [registered]).failures).toEqual([]);
    });

    test('a markup outlier needs an entry with the property markup and the alternative as its value', () => {
        const own = { alternatives: { own: 1 } };
        expect(check(rowsOf(own), []).failures[0]).toContain('title markup is own');
        expect(check(rowsOf(own), [entry({ property: 'markup', value: 'own', canonical: 'shared' })]).failures).toEqual([]);
    });
});

describe('generating the allow-list', () => {
    test('outliers become temporary entries in a stable order, one for each distinct value', () => {
        const rows = [
            ...rowsOf({ cells: { fontSize: [cell('22px', 3), cell('24px')] }, alternatives: { own: 1 } }),
            ...rowsOf({ cells: { textAlign: [cell('start')] } }),
        ];
        const entries = entriesFromRows(rows);
        expect(entries.map(item => `${item.property}:${item.value}`)).toEqual(['fontSize:22', 'fontSize:24', 'markup:own', 'textAlign:start']);
        expect(entries.every(item => item.kind === 'temporary' && item.reason === TEMPORARY_REASON && item.viewport === '1440x900')).toBe(true);
        expect(entries[0]).toMatchObject({ value: 22, canonical: 20 });
        expect(entries[0]).not.toHaveProperty('count');
        expect(entriesFromRows(rowsOf())).toEqual([]);
    });

    test('an outlier that a registered entry covers gets no temporary entry', () => {
        const registered = entry({ kind: 'registered', reason: 'DESIGN.md Dialogs: the sheet form' });
        const rows = rowsOf({ cells: { fontSize: [cell('22px'), cell('24px')] } });
        expect(entriesFromRows(rows, [registered]).map(item => item.value)).toEqual([24]);
        expect(entriesFromRows(rows, [{ ...registered, viewport: '*' }]).map(item => item.value)).toEqual([24]);
        expect(entriesFromRows(rows, [{ ...registered, viewport: '390x844' }]).map(item => item.value)).toEqual([22, 24]);
    });

    test('regenerating over a list that holds a registered entry does not duplicate it', () => {
        const registered = entry({ kind: 'registered', reason: 'DESIGN.md Dialogs: the sheet form' });
        const rows = rowsOf({ cells: { fontSize: [cell('22px')] } });
        const merged = mergeEntries([registered], entriesFromRows(rows, [registered]), new Set(['status.a.one|1440x900']));
        expect(merged).toEqual([registered]);
    });

    test('a run replaces the entries of what it measured and keeps the rest, and registered entries are never replaced', () => {
        const existing = [
            entry({ surface: 'status.a.one', viewport: '1440x900', value: 23 }),
            entry({ surface: 'status.a.two', viewport: '1440x900' }),
            entry({ surface: 'status.a.one', viewport: '390x844' }),
            entry({ surface: 'status.a.one', viewport: '1440x900', part: 'icon', kind: 'registered', reason: 'DESIGN.md Status Pages' }),
        ];
        const produced = [entry({ surface: 'status.a.one', viewport: '1440x900', value: 22 })];
        const merged = mergeEntries(existing, produced, new Set(['status.a.one|1440x900']));
        expect(merged).toHaveLength(4);
        expect(merged.filter(item => item.surface === 'status.a.one' && item.viewport === '1440x900' && item.kind === 'temporary')).toEqual([expect.objectContaining({ value: 22 })]);
        expect(merged.some(item => item.surface === 'status.a.two')).toBe(true);
        expect(merged.some(item => item.viewport === '390x844')).toBe(true);
        expect(merged.some(item => item.kind === 'registered')).toBe(true);
    });

    test('an entry that no longer occurs is dropped when its surface is measured again', () => {
        expect(mergeEntries([entry()], [], new Set(['status.a.one|1440x900']))).toEqual([]);
    });

    test('a registered entry that no outlier of a complete run matches is reported', () => {
        const matching = entry({ kind: 'registered', reason: 'DESIGN.md Dialogs', viewport: '*' });
        const stale = entry({ kind: 'registered', reason: 'DESIGN.md Dialogs', value: 99 });
        const rows = rowsOf({ cells: { fontSize: [cell('22px')] } });
        expect(unmatchedRegistered([matching, stale, entry()], rows)).toEqual([stale]);
    });

    test('an entry is identified by its cell and its value', () => {
        expect(entryKey(entry({ value: 22 }))).not.toBe(entryKey(entry({ value: 24 })));
        expect(entryKey(entry())).toBe(entryKey(entry()));
    });
});

describe('the ratchet', () => {
    const counts = { status: 3, list: 2 };

    test('a family over its count is reported, and one under it is reported separately', () => {
        expect(compareToRatchet(counts, { status: 4, list: 2 })).toEqual({ over: ['status: 4 temporary entries, the ratchet allows 3'], under: [] });
        expect(compareToRatchet(counts, { status: 3, list: 1 })).toEqual({ over: [], under: ['list: 1 temporary entries, the ratchet holds 2'] });
        expect(compareToRatchet(counts, { status: 3, list: 2 })).toEqual({ over: [], under: [] });
    });

    test('a family that the ratchet does not name has a count of zero', () => {
        expect(compareToRatchet(counts, { home: 1 }).over).toHaveLength(1);
    });

    test('the next counts only fall, a rise is refused, and the first run takes the counts as they are', () => {
        expect(nextRatchet(counts, { status: 1, list: 2 })).toEqual({ counts: { status: 1, list: 2 }, rises: [] });
        expect(nextRatchet(counts, { status: 5, list: 2 })).toEqual({ counts: { status: 3, list: 2 }, rises: ['status: 3 -> 5'] });
        expect(nextRatchet(counts, { status: 5, list: 2 }, { allowIncrease: true })).toEqual({ counts: { status: 5, list: 2 }, rises: [] });
        expect(nextRatchet(null, { status: 5 })).toEqual({ counts: { status: 5 }, rises: [] });
    });

    test('temporary entries are counted for each family, and registered ones are not', () => {
        const entries = [entry(), entry({ part: 'icon' }), entry({ kind: 'registered', reason: 'DESIGN.md Status Pages' }), entry({ family: 'list' })];
        expect(temporaryCounts(entries, ['status', 'list', 'home'])).toEqual({ status: 2, list: 1, home: 0 });
    });
});

describe('the script that lowers the ratchet', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-ratchet-'));
    afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

    const zeroCounts = Object.fromEntries(PARITY_FAMILIES.map(family => [family, 0]));
    const setUp = (name, temporary, entries) => {
        const allowlist = path.join(directory, `${name}-allowlist.json`);
        const ratchet = path.join(directory, `${name}-counts.json`);
        fs.writeFileSync(allowlist, `${JSON.stringify({ version: 1, entries })}\n`);
        fs.writeFileSync(ratchet, `${JSON.stringify({ version: 1, temporary })}\n`);
        return { allowlist, ratchet };
    };
    const lower = (files, ...extra) => spawnSync(process.execPath, [scriptFile, '--lower', '--allowlist', files.allowlist, '--ratchet', files.ratchet, ...extra], { encoding: 'utf8' });

    test('it refuses to raise a count and leaves both files as they were', () => {
        const files = setUp('rise', { ...zeroCounts, status: 1 }, [entry(), entry({ part: 'icon' })]);
        const before = fs.readFileSync(files.ratchet, 'utf8');
        const result = lower(files);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('status: 1 -> 2');
        expect(result.stderr).toContain('--allow-increase');
        expect(fs.readFileSync(files.ratchet, 'utf8')).toBe(before);
    });

    test('it lowers a count to the number of entries and keeps the others', () => {
        const files = setUp('fall', { ...zeroCounts, status: 5, list: 0 }, [entry(), entry({ part: 'icon' })]);
        const result = lower(files);
        expect(result.status).toBe(0);
        expect(readRatchet(files.ratchet).temporary).toEqual({ ...zeroCounts, status: 2 });
    });

    test('it raises a count only with --allow-increase', () => {
        const files = setUp('allow', { ...zeroCounts }, [entry()]);
        expect(lower(files, '--allow-increase').status).toBe(0);
        expect(readRatchet(files.ratchet).temporary.status).toBe(1);
    });

    test('a record run needs a census directory', () => {
        const result = spawnSync(process.execPath, [scriptFile], { encoding: 'utf8' });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('--census <dir>');
    });
});

describe('the shape of an entry', () => {
    test('a well formed temporary entry has no problems', () => {
        expect(entryProblems(entry())).toEqual([]);
    });

    test('each missing or wrong field is named', () => {
        expect(entryProblems(entry({ part: '' }))).toEqual(['part must be a non-empty string']);
        expect(entryProblems(entry({ kind: 'forever' }))).toEqual(['kind must be one of temporary, registered']);
        expect(entryProblems(entry({ value: undefined }))).toEqual(['value must be a number or a non-empty string']);
        expect(entryProblems(entry({ reason: 'later' }))).toEqual([`a temporary entry has the reason "${TEMPORARY_REASON}"`]);
    });

    test('a temporary entry names its viewport', () => {
        expect(entryProblems(entry({ viewport: '*' })).join()).toContain('a temporary entry names its viewport');
        expect(entryProblems(entry({ viewport: '*', kind: 'registered', reason: 'DESIGN.md Dialogs' }))).toEqual([]);
    });

    test('a registered entry cites DESIGN.md, DESIGN.json or a decision id, and the word "decision" is not a citation', () => {
        const problem = 'a registered entry needs a reason that cites DESIGN.md, DESIGN.json or a decision id such as D12';
        expect(entryProblems(entry({ kind: 'registered', reason: 'because' }))).toEqual([problem]);
        expect(entryProblems(entry({ kind: 'registered', reason: 'a decision of the team' }))).toEqual([problem]);
        expect(entryProblems(entry({ kind: 'registered', reason: 'DESIGN.md Status Pages: the compact variant' }))).toEqual([]);
        expect(entryProblems(entry({ kind: 'registered', reason: 'DESIGN.json Side Panels' }))).toEqual([]);
        expect(entryProblems(entry({ kind: 'registered', reason: 'decision D12' }))).toEqual([]);
    });

    test('the viewport belongs to the viewports the surface has', () => {
        expect(entryProblems(entry(), ['1440x900', '390x844'])).toEqual([]);
        expect(entryProblems(entry({ viewport: '390x844' }), ['1440x900'])).toEqual(['the surface is not measured at 390x844 (it has 1440x900)']);
    });
});

describe('the census', () => {
    const measurement = (surface, options, group = '') => {
        const { rows, parts } = buildRows({ surface, viewport: '1440x900', rules, measured: measured(options) });
        return { family: 'status', surface, viewport: '1440x900', group, pointer: 'fine', parts, rows };
    };
    const measurements = [
        measurement('status.a.one'),
        measurement('status.a.two', { cells: { fontSize: [cell('30px', 2)] }, alternatives: { own: 2 } }),
    ];

    test('a family with groups gets one set of tables for each group, in the order of its labels', () => {
        const grouped = [measurement('status.a.one', {}, 'shared'), measurement('status.a.two', {}, 'own')];
        const { markdown } = buildFamilyCensus({ rules: { ...rules, groupLabels: { shared: 'Shared page', own: 'Own markup' } }, measurements: grouped });
        expect(markdown.indexOf('## Shared page')).toBeGreaterThan(0);
        expect(markdown.indexOf('## Own markup')).toBeGreaterThan(markdown.indexOf('## Shared page'));
    });

    test('counts the members, properties, instances, outlier entries, members with an outlier and absent parts', () => {
        const { json, markdown, stats } = buildFamilyCensus({ rules, measurements });
        expect(stats).toEqual({ members: 2, properties: 6, instances: 3, outliers: 2, outlierMembers: 1, partsAbsent: 2 });
        expect(json.rows.filter(row => !row.agree)).toHaveLength(2);
        expect(json.rows[0]).toHaveProperty('count');
        expect(json.rows[0]).toHaveProperty('selector');
        expect(json.parts.filter(state => state.absent)).toHaveLength(2);
        expect(markdown).toContain('## title');
        expect(markdown).toContain('| fontSize | 20 | census | 1 of 3 instances, 1 of 2 members | 20 (1), 30 (2) | 30: status.a.two@1440 (2) |');
        expect(markdown).toContain('Markup used: shared (1), own (2)');
        expect(markdown).toContain('Absent in 2: status.a.one@1440, status.a.two@1440.');
    });

    test('lists the members that reached the cap of instances', () => {
        const capped = { ...measurements[0], parts: measurements[0].parts.map(state => ({ ...state, capped: state.part === 'title' })) };
        expect(buildFamilyCensus({ rules, measurements: [capped] }).markdown).toContain('Reached the cap of instances: status.a.one@1440.');
    });

    test('lists what the audit\'s own allow-list hides', () => {
        const hidden = { ...measurements[0], parts: measurements[0].parts.map(state => (state.part === 'title' ? { ...state, hidden: [{ rule: 'row-edges', selector: '.x' }, { rule: 'content-inset', selector: '.y' }] } : state)) };
        const { markdown, json } = buildFamilyCensus({ rules, measurements: [hidden] });
        expect(markdown).toContain('## Hidden by LIBADWAITA_AUDIT_ALLOWLIST');
        expect(markdown).toContain('| status.a.one@1440 | row-edges | `.x` |');
        expect(markdown).toContain('| status.a.one@1440 | content-inset | `.y` |');
        expect(json.parts.find(state => state.part === 'title').hidden).toHaveLength(2);
    });

    test('the output does not depend on the order of the measurements', () => {
        const forward = buildFamilyCensus({ rules, measurements });
        const backward = buildFamilyCensus({ rules, measurements: [...measurements].reverse() });
        expect(backward.markdown).toBe(forward.markdown);
        expect(backward.json).toEqual(forward.json);
    });

    test('the summary has one line for each family', () => {
        const summary = buildSummary({ status: { members: 2, properties: 5, instances: 40, outliers: 2, outlierMembers: 1, partsAbsent: 3 } }, { status: 7 });
        expect(summary).toContain('- status: 2 members, 5 properties, 40 instances measured, 2 outlier entries in 1 members, 3 parts absent, 7 temporary entries');
    });
});

describe('the rules of the families', () => {
    test.each(PARITY_FAMILIES)('%s has well formed rules of 6 to 20 properties', family => {
        const familyRules = RULES[family];
        expect(familyRules.family).toBe(family);
        const ids = familyRules.parts.map(part => part.id);
        const properties = familyRules.parts.reduce((total, part) => total + part.properties.length, 0);
        const names = familyRules.parts.flatMap(part => {
            const own = part.properties.map(property => property.property);
            return own.filter((name, index) => own.indexOf(name) !== index).map(name => `${part.id}: ${name} repeats`);
        });
        const markup = familyRules.parts.flatMap(part => part.properties.filter(property => property.property === 'markup').map(() => `${part.id}: markup is derived from the alternatives`));
        const audit = familyRules.audit && !ids.includes(familyRules.audit.part) ? [`the audit part ${familyRules.audit.part} is not one of the parts`] : [];
        expect([...ruleProblems(familyRules), ...names, ...markup, ...audit]).toEqual([]);
        expect(properties).toBeGreaterThanOrEqual(6);
        expect(properties).toBeLessThanOrEqual(20);
    });

    test('a token is a custom property of the page', () => {
        const bad = PARITY_FAMILIES.flatMap(family => RULES[family].parts.flatMap(part => part.properties.flatMap(property => [property, ...(property.forms ?? [])]
            .filter(spec => spec.token !== undefined && !/^--[a-z0-9-]+$/.test(spec.token))
            .map(spec => `${family} ${part.id} ${property.property}: ${spec.token}`))));
        expect(bad).toEqual([]);
    });

    test('a surface that a rules file skips is a registered surface of that family and has a reason', () => {
        const problems = [];
        for (const family of PARITY_FAMILIES.filter(name => !LOAD_PROBLEMS.some(problem => problem.family === name))) {
            for (const [id, reason] of Object.entries(RULES[family].skip ?? {})) {
                const surface = SURFACES.find(candidate => candidate.id === id);
                if (!surface || surface.family !== family) problems.push(`${id}: not a surface of ${family}`);
                if (typeof reason !== 'string' || reason.trim() === '') problems.push(`${id}: a skip needs a reason`);
            }
        }
        expect(problems).toEqual([]);
    });

    test('the settings audit counts the failing records of each rule and lists the allow-list entries that hide others', () => {
        const records = [
            { rule: 'row-edges', pass: false, allowlisted: false },
            { rule: 'row-edges', pass: false, allowlisted: false },
            { rule: 'row-edges', pass: true, allowlisted: false },
            { rule: 'content-inset', pass: false, allowlisted: true },
            { rule: 'content-inset', pass: false, allowlisted: true },
            { rule: 'cross-tab-parity', pass: false, allowlisted: true },
        ];
        const hiding = records.filter(record => !record.pass && record.allowlisted);
        const { values, hidden } = RULES.settings.audit.summarise(records, hiding, [0, 0, 0]);
        expect(values).toEqual({ auditContentInset: 0, auditRowEdges: 2, auditRowGeometry: 0, auditGroupAnatomy: 0 });
        expect(hidden).toEqual([{ rule: 'content-inset', selector: LIBADWAITA_AUDIT_ALLOWLIST[0].selector }]);
        expect(RULES.settings.audit.summarise([], [{ rule: 'row-edges' }], [-1]).hidden).toEqual([{ rule: 'row-edges', selector: 'unattributed' }]);
    });

    test('the family files and the registry agree on the family names', () => {
        expect(Object.keys(RULES).sort()).toEqual([...PARITY_FAMILIES].sort());
        expect(PARITY_FAMILIES).not.toContain('chat');
    });

    test('the rules name no file that is not in the repository', () => {
        const text = JSON.stringify(PARITY_FAMILIES.map(family => RULES[family].parts));
        expect(text).not.toMatch(/plan\.md/);
    });
});

describe('the allow-list file and its ratchet', () => {
    const { entries } = readAllowlist();
    const ratchet = readRatchet();
    const loaded = new Set(PARITY_FAMILIES.filter(family => !LOAD_PROBLEMS.some(problem => problem.family === family)));
    const surfaceById = new Map(SURFACES.map(surface => [surface.id, surface]));

    test('every entry is well formed, and its viewport is one of the surface\'s', () => {
        expect(entries.flatMap(item => entryProblems(item, surfaceById.has(item.surface) ? viewportsFor(surfaceById.get(item.surface)) : null).map(problem => `${item.surface} ${item.part} ${item.property}: ${problem}`))).toEqual([]);
    });

    test('no entry appears twice', () => {
        const keys = entries.map(entryKey);
        expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
    });

    test('every entry names a family, a surface, a part and a property that exist in the registry and the rules', () => {
        const problems = [];
        for (const item of entries) {
            const where = `${item.surface} ${item.part} ${item.property}`;
            if (!PARITY_FAMILIES.includes(item.family)) {
                problems.push(`${where}: family ${item.family} has no parity rules`);
                continue;
            }
            if (!loaded.has(item.family)) {
                continue;
            }
            const surface = surfaceById.get(item.surface);
            if (!surface) {
                problems.push(`${where}: no registered surface has this id`);
            } else if (surface.family !== item.family) {
                problems.push(`${where}: the surface belongs to ${surface.family}, not ${item.family}`);
            } else if (item.viewport !== '*' && !['1440x900', '390x844'].includes(item.viewport)) {
                problems.push(`${where}: ${item.viewport} is not a viewport that the census measures`);
            } else if (RULES[item.family].skip?.[item.surface]) {
                problems.push(`${where}: the surface is skipped, so it is not measured`);
            }
            const part = RULES[item.family].parts.find(candidate => candidate.id === item.part);
            if (!part) {
                problems.push(`${where}: the ${item.family} rules have no part ${item.part}`);
            } else if (item.property !== 'markup' && !part.properties.some(property => property.property === item.property)) {
                problems.push(`${where}: the part has no property ${item.property}`);
            } else if (item.property === 'markup' && part.selectors.length < 2) {
                problems.push(`${where}: the part has one markup, so it has no markup outlier`);
            }
        }
        expect(problems).toEqual([]);
    });

    test('the ratchet file names every family and holds the count of temporary entries', () => {
        expect(ratchet).not.toBeNull();
        expect(Object.keys(ratchet.temporary).sort()).toEqual([...PARITY_FAMILIES].sort());
        const { over, under } = compareToRatchet(ratchet.temporary, temporaryCounts(entries, PARITY_FAMILIES));
        // The list can only shrink: a family over its count is a rise, and one under it needs the ratchet lowered with
        // `node scripts/update-parity-allowlist.js --lower`.
        expect({ over, under }).toEqual({ over: [], under: [] });
    });
});
