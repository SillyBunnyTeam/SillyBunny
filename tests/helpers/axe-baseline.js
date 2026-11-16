/**
 * The baseline of the accessibility scan (`audit/surface-audit.e2e.js`): how a violation becomes a record, how the violations of a run
 * are compared with the fixture `fixtures/axe-baseline.json`, and how the fixture is updated. Nothing here imports Playwright, so the
 * unit tests load it.
 *
 * The fixture has two sections. `upstream` holds the violations on elements that upstream wrote, which the project fixes only where
 * shared CSS can. `sillybunny` holds the violations on elements that SillyBunny wrote, which must shrink to nothing, so an update never
 * adds to it unless it is told to.
 *
 * A violation is one (surface, state, rule, target) in one cell (theme, viewport, backend). A record names a cell dimension only
 * where the violation does not occur on every scanned value of it. The comparison does not look at the shape of a record: it expands
 * the records of the fixture to the cells that the run scanned and compares cell by cell, so fixing a violation in one theme removes
 * that cell and does not read as a new record.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASELINE_VERSION = 1;
export const BASELINE_PATH = fileURLToPath(new URL('../fixtures/axe-baseline.json', import.meta.url));
export const SECTIONS = Object.freeze(['upstream', 'sillybunny']);
/** The variant axes of a scan. A record names one of them only where the violation does not occur on every value. */
export const DIMENSIONS = Object.freeze(['theme', 'viewport', 'backend']);

export const UPDATE_VARIABLE = 'SURFACE_AXE_UPDATE';
export const ALLOW_VARIABLE = 'SURFACE_AXE_ALLOW_SILLYBUNNY';
export const FIXTURE_VARIABLE = 'SURFACE_AXE_FIXTURE';
export const UPDATE_COMMAND = `${UPDATE_VARIABLE}=1 SILLYBUNNY_TEST_SERVERS=3 npx playwright test -c playwright.audit.config.js audit/surface-audit.e2e.js (run from tests/)`;
export const ALLOW_HINT = `Records may be added to the sillybunny section only with ${ALLOW_VARIABLE}=1 next to ${UPDATE_VARIABLE}=1.`;

/** An id or class that starts with one of these was written for SillyBunny; anything else on the page is upstream's. */
const SILLYBUNNY_TOKEN = /^(?:sb-|ds-|sillybunny)/i;

/**
 * Whether an element carries an id or a class that SillyBunny wrote.
 * @param {{ id?: string, classes?: readonly string[] }} element
 */
export const isSillyBunnyElement = ({ id = '', classes = [] }) => [id, ...classes].some(token => SILLYBUNNY_TOKEN.test(token));

/**
 * Which section holds a violation. A surface of owner A or C that is not marked `upstreamMarkup` is SillyBunny's markup throughout. On a
 * surface of owner B, or one marked `upstreamMarkup`, the violating element decides: its own id or class tokens, not those of an
 * ancestor, so that a SillyBunny frame around upstream content does not pull the content over.
 * @param {{ owner: string, upstreamMarkup?: boolean }} surface
 * @param {{ sillybunnyElement?: boolean }} [node]
 * @returns {'upstream' | 'sillybunny'}
 */
export function sectionOf(surface, { sillybunnyElement = false } = {}) {
    const upstreamMarkup = surface.owner === 'B' || surface.upstreamMarkup === true;
    return upstreamMarkup && !sillybunnyElement ? 'upstream' : 'sillybunny';
}

const UUID = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i;
const LONG_HEX = /(?:^|[-_])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{10,}(?:$|[-_])/i;

/** A selector writes a leading digit as a hex escape (`\35 4a…` for `54a…`), which would hide a generated token. */
const unescapeCss = value => value.replace(/\\([0-9a-f]{1,6})\s?/gi, (match, hex) => String.fromCodePoint(parseInt(hex, 16)));

/** The part of an id or attribute value that stays the same: a counter, a timestamp or a generated token becomes `*`. */
function stabiliseToken(token) {
    if (UUID.test(token) || LONG_HEX.test(token)) {
        return '*';
    }
    return token.replace(/\d{4,}/g, '*').replace(/\d+$/, '*');
}

/**
 * A selector that stays the same when unrelated markup moves. Positions (`:nth-child`) change when a neighbour is added, and ids or
 * attribute values that carry a counter or a generated token change from boot to boot (`#CharID3`, `#sb-popup-title-12`, `ui-id-14`),
 * so the positions are dropped and the counters become `*`, keeping the prefix that names the element. A target inside a shadow root
 * or a frame (an array) is joined with ` >>> `.
 * @param {string | readonly unknown[]} target
 * @returns {string}
 */
export function normaliseTarget(target) {
    if (Array.isArray(target)) {
        return target.map(normaliseTarget).join(' >>> ');
    }
    return String(target)
        .replace(/:nth-(?:last-)?(?:child|of-type)\([^)]*\)/g, '')
        .replace(/#((?:\\.|[^\s>+~.[#:,])+)/g, (match, id) => `#${stabiliseToken(id)}`)
        .replace(/\[([\w-]+)([~|^$*]?=)(?:"([^"]*)"|'([^']*)'|([^\]\s]+))(\s+[is])?\]/g, (match, name, operator, double, single, bare, flag = '') => {
            const value = double ?? single ?? bare ?? '';
            const plain = unescapeCss(value);
            if (/^\d+$/.test(plain) || UUID.test(plain) || LONG_HEX.test(plain)) {
                return `[${name}]`;
            }
            const stable = stabiliseToken(value);
            return stable === value ? match : `[${name}${operator}"${stable}"${flag}]`;
        })
        .replace(/\s+/g, ' ')
        .trim();
}

const cellId = cell => DIMENSIONS.map(dimension => cell[dimension] ?? '').join('\u0000');
const unitKey = (surface, state) => JSON.stringify([surface, state ?? '']);
const tripleKey = triple => JSON.stringify([triple.surface, triple.state ?? '', triple.rule, triple.target, cellId(triple.cell)]);
const matchesCell = (record, cell) => DIMENSIONS.every(dimension => record[dimension] === undefined || record[dimension] === cell[dimension]);

/**
 * @typedef {object} BaselineRecord
 * @property {string} surface
 * @property {string} [state] Absent for the surface as found.
 * @property {string} rule The axe rule id.
 * @property {string} target The normalised selector.
 * @property {string} [theme]
 * @property {string} [viewport]
 * @property {string} [backend]
 * @property {number} [count] How many elements of the surface have this selector, when more than one (sillybunny section only).
 *
 * @typedef {object} ScannedUnit A surface, or one state of it, with every cell that was scanned.
 * @property {string} surface
 * @property {string | undefined} state
 * @property {Record<string, string | undefined>[]} cells
 *
 * @typedef {object} Observation One element with a violation, in one cell.
 * @property {string} surface
 * @property {string | undefined} state
 * @property {string} rule
 * @property {string} target A normalised selector.
 * @property {Record<string, string | undefined>} cell
 * @property {'upstream' | 'sillybunny'} section
 *
 * @typedef {object} Triple A violation in one cell, with the number of elements that have it.
 * @property {string} surface
 * @property {string | undefined} state
 * @property {string} rule
 * @property {string} target
 * @property {Record<string, string | undefined>} cell
 * @property {'upstream' | 'sillybunny'} section
 * @property {number} count
 *
 * @typedef {{ upstream: BaselineRecord[], sillybunny: BaselineRecord[] }} Sections
 */

/**
 * The key of a record: what makes two records the same violation.
 * @param {BaselineRecord} record
 * @returns {string}
 */
export function recordKey(record) {
    return JSON.stringify([record.surface, record.state ?? '', record.rule, record.target, record.theme ?? '', record.viewport ?? '', record.backend ?? '']);
}

const compareRecords = (first, second) => {
    const [a, b] = [recordKey(first), recordKey(second)];
    return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Counts the observations of each violation in each cell.
 * @param {readonly Observation[]} observations
 * @returns {Triple[]}
 */
export function toTriples(observations) {
    const triples = new Map();
    for (const observation of observations) {
        const triple = { surface: observation.surface, state: observation.state, rule: observation.rule, target: observation.target, cell: observation.cell, section: observation.section, count: 0 };
        const key = tripleKey(triple);
        const known = triples.get(key) ?? triple;
        known.count++;
        triples.set(key, known);
    }
    return [...triples.values()];
}

/**
 * The partial cells that describe where a violation occurs, given the cells that were scanned for its state and the cells where it
 * occurs. A dimension is named only when the scan varied it and the violation does not occur on all of its values. When the named
 * dimensions do not describe exactly the cells where the violation occurs (it occurs on a diagonal), every varying dimension is
 * named, one partial cell per cell.
 * @param {readonly Record<string, string | undefined>[]} scanned
 * @param {readonly Record<string, string | undefined>[]} observed
 * @returns {Record<string, string>[]} `{}` for a violation that occurs everywhere.
 */
function projectCells(scanned, observed) {
    const valuesOf = (cells, dimension) => new Set(cells.map(cell => cell[dimension]));
    const varying = DIMENSIONS.filter(dimension => valuesOf(scanned, dimension).size > 1);
    const named = varying.filter(dimension => valuesOf(observed, dimension).size < valuesOf(scanned, dimension).size);
    const project = dimensions => {
        const partials = new Map();
        for (const cell of observed) {
            const partial = Object.fromEntries(dimensions.map(dimension => [dimension, cell[dimension]]));
            partials.set(JSON.stringify(partial), partial);
        }
        return [...partials.values()];
    };
    const observedIds = new Set(observed.map(cellId));
    let partials = project(named);
    const covered = scanned.filter(cell => partials.some(partial => matchesCell(partial, cell)));
    if (covered.length !== observedIds.size || !covered.every(cell => observedIds.has(cellId(cell)))) {
        partials = project(varying);
    }
    return partials;
}

/**
 * Turns violations in cells into records, grouped by section. A record that holds more than one element carries the highest count of
 * its cells, in the sillybunny section only.
 * @param {readonly Triple[]} triples
 * @param {(surface: string, state: string | undefined) => readonly Record<string, string | undefined>[] | undefined} scannedCells The cells that were scanned for a unit.
 * @returns {Sections}
 */
function recordsFromTriples(triples, scannedCells) {
    const groups = new Map();
    for (const triple of triples) {
        const key = JSON.stringify([triple.surface, triple.state ?? '', triple.rule, triple.target, triple.section]);
        const group = groups.get(key) ?? { first: triple, triples: [] };
        group.triples.push(triple);
        groups.set(key, group);
    }
    const records = { upstream: [], sillybunny: [] };
    for (const { first, triples: members } of groups.values()) {
        const scanned = scannedCells(first.surface, first.state) ?? members.map(member => member.cell);
        for (const partial of projectCells(scanned, members.map(member => member.cell))) {
            const record = { surface: first.surface };
            if (first.state) {
                record.state = first.state;
            }
            record.rule = first.rule;
            record.target = first.target;
            for (const dimension of DIMENSIONS) {
                if (partial[dimension] !== undefined) {
                    record[dimension] = partial[dimension];
                }
            }
            const count = Math.max(...members.filter(member => matchesCell(partial, member.cell)).map(member => member.count));
            if (first.section === 'sillybunny' && count > 1) {
                record.count = count;
            }
            records[first.section].push(record);
        }
    }
    for (const section of SECTIONS) {
        records[section].sort(compareRecords);
    }
    return records;
}

const cellsLookup = units => {
    const cells = new Map(units.map(unit => [unitKey(unit.surface, unit.state), unit.cells]));
    return (surface, state) => cells.get(unitKey(surface, state));
};

/**
 * Turns the observations of a scan into records, grouped by section.
 * @param {readonly ScannedUnit[]} units
 * @param {readonly Observation[]} observations
 * @returns {Sections}
 */
export function buildRecords(units, observations) {
    const known = cellsLookup(units);
    for (const observation of observations) {
        if (!known(observation.surface, observation.state)) {
            throw new Error(`The violation of ${observation.surface} ${observation.state ?? ''} has no scanned unit.`);
        }
    }
    return recordsFromTriples(toTriples(observations), known);
}

/**
 * Compares the violations of a run with the fixture, cell by cell. The records of the fixture are expanded to the cells that the run
 * scanned, so a record that is still true in some cells and fixed in others loses those cells and is not new, and a cell that this
 * run did not scan is left alone.
 *
 * `added` are violations that no record covers; `fixed` are covered violations that no longer occur (and records of a state that is
 * gone); `moved` are covered by a record of the other section; `grown` and `shrunk` are sillybunny violations whose number of
 * elements changed. Only records that `inScope` accepts are judged.
 * @param {{ observed: readonly Triple[], baseline: Sections, units: readonly ScannedUnit[], inScope?: (record: BaselineRecord) => boolean }} input
 */
export function compareToBaseline({ observed, baseline, units, inScope = () => true }) {
    const known = cellsLookup(units);
    const covered = new Map();
    const fixed = [];
    for (const section of SECTIONS) {
        for (const record of baseline[section]) {
            if (!inScope(record)) {
                continue;
            }
            const cells = known(record.surface, record.state);
            if (!cells) {
                fixed.push({ section, record });
                continue;
            }
            for (const cell of cells.filter(candidate => matchesCell(record, candidate))) {
                const triple = { surface: record.surface, state: record.state, rule: record.rule, target: record.target, cell, section, count: record.count ?? 1, record };
                covered.set(tripleKey(triple), triple);
            }
        }
    }
    const added = [];
    const moved = new Map();
    // The count of a record is the highest count of its cells, so it is compared with the highest count that the run found in them.
    const counts = new Map();
    const seen = new Set();
    for (const triple of observed) {
        const key = tripleKey(triple);
        seen.add(key);
        const base = covered.get(key);
        if (!base) {
            added.push(triple);
        } else if (base.section !== triple.section) {
            const direction = `${base.section}>${triple.section}`;
            moved.set(direction, [...(moved.get(direction) ?? []), triple]);
        } else if (triple.section === 'sillybunny') {
            const known = counts.get(base.record) ?? { from: base.count, to: 0 };
            known.to = Math.max(known.to, triple.count);
            counts.set(base.record, known);
        }
    }
    const lostTriples = [...covered.entries()].filter(([key]) => !seen.has(key)).map(([, triple]) => triple);
    const recordsOf = (triples, section) => recordsFromTriples(triples.map(triple => ({ ...triple, section })), known)[section];
    const bySection = (triples, key) => SECTIONS.flatMap(section => recordsOf(triples.filter(triple => triple[key] === section), section).map(record => ({ section, record })));
    const countChanges = direction => [...counts.entries()]
        .filter(([, { from, to }]) => (direction === 'grown' ? to > from : to < from))
        .map(([record, { from, to }]) => ({ record: { ...record, count: undefined }, from, to }))
        .map(item => ({ ...item, record: Object.fromEntries(Object.entries(item.record).filter(([, value]) => value !== undefined)) }));
    return {
        added: bySection(added, 'section'),
        fixed: [...bySection(lostTriples, 'section'), ...fixed],
        moved: [...moved.entries()].flatMap(([direction, triples]) => {
            const [from, to] = direction.split('>');
            return recordsOf(triples, to).map(record => ({ from, to, record }));
        }),
        grown: countChanges('grown'),
        shrunk: countChanges('shrunk'),
    };
}

/** The records that an update would add to the `sillybunny` section: new ones, ones that move there from `upstream`, and ones with more elements. */
export function sillybunnyAdditions(comparison) {
    return [
        ...comparison.added.filter(item => item.section === 'sillybunny').map(item => item.record),
        ...comparison.moved.filter(item => item.to === 'sillybunny').map(item => item.record),
        ...comparison.grown.map(item => item.record),
    ];
}

/**
 * @param {BaselineRecord} record
 * @returns {string}
 */
export function describeRecord(record) {
    const cell = [record.theme, record.viewport, record.backend].filter(Boolean).join(' ');
    return `${record.surface}${record.state ? ` state ${record.state}` : ''}: ${record.rule} at ${record.target}${cell ? ` (${cell} only)` : ''}${record.count ? ` (${record.count} elements)` : ''}`;
}

const MAX_LISTED = 25;

const listOf = (title, items) => (items.length
    ? [`${title} (${items.length}):`, ...items.slice(0, MAX_LISTED).map(item => `  ${item}`), ...(items.length > MAX_LISTED ? [`  and ${items.length - MAX_LISTED} more`] : [])]
    : []);

/**
 * The failure message of a comparison; empty when the run equals the fixture.
 * @param {ReturnType<typeof compareToBaseline>} comparison
 * @param {{ cellsOf?: (record: BaselineRecord) => string }} [options] Names the cells (theme, viewport, backend) where a new violation was seen.
 * @returns {string[]} One entry per problem group.
 */
export function formatComparison(comparison, { cellsOf } = {}) {
    const problems = [];
    const added = comparison.added.map(item => `${describeRecord(item.record)}${cellsOf ? ` [seen in: ${cellsOf(item.record)}]` : ''} [${item.section} section]`);
    if (added.length) {
        problems.push(listOf('Violations that are in neither section of axe-baseline.json. Fix the markup or the style; an update would add them', added).join('\n'));
    }
    const grown = comparison.grown.map(item => `${describeRecord(item.record)}: ${item.from} elements in the baseline, ${item.to} now`);
    if (grown.length) {
        problems.push(listOf('Violations on more elements than the baseline holds', grown).join('\n'));
    }
    const moved = comparison.moved.map(item => `${describeRecord(item.record)}: the fixture has it in ${item.from}, the element is ${item.to}`);
    if (moved.length) {
        problems.push(listOf('Records in the other section than the element belongs to', moved).join('\n'));
    }
    const fixed = comparison.fixed.map(item => `${describeRecord(item.record)} [${item.section}]`);
    if (fixed.length) {
        problems.push(listOf('Records that no longer occur', fixed).join('\n'));
    }
    const shrunk = comparison.shrunk.map(item => `${describeRecord(item.record)}: ${item.from} elements in the baseline, ${item.to} now`);
    if (shrunk.length) {
        problems.push(listOf('Violations on fewer elements than the baseline holds', shrunk).join('\n'));
    }
    if (fixed.length || moved.length || shrunk.length) {
        problems.push(`Remove the fixed records from the baseline, so that the file only shrinks. The update removes them and adds nothing to the sillybunny section on its own: ${UPDATE_COMMAND}`);
    }
    return problems;
}

/**
 * Whether a baseline is well formed.
 * @param {unknown} baseline
 * @returns {string[]} The problems; empty when valid.
 */
export function validateBaseline(baseline) {
    const problems = [];
    if (!baseline || typeof baseline !== 'object' || baseline.version !== BASELINE_VERSION) {
        return [`The baseline must be an object with version ${BASELINE_VERSION}.`];
    }
    const seen = new Map();
    for (const section of SECTIONS) {
        if (!Array.isArray(baseline[section])) {
            problems.push(`The "${section}" section must be an array.`);
            continue;
        }
        for (const [index, record] of baseline[section].entries()) {
            const where = `${section}[${index}]`;
            const text = value => typeof value === 'string' && value !== '';
            if (!record || typeof record !== 'object' || !text(record.surface) || !text(record.rule) || !text(record.target)) {
                problems.push(`${where} needs a surface, a rule and a target.`);
                continue;
            }
            for (const optional of ['state', ...DIMENSIONS]) {
                if (record[optional] !== undefined && !text(record[optional])) {
                    problems.push(`${where}: ${optional} must be a non-empty string when present.`);
                }
            }
            if (record.count !== undefined && (!Number.isInteger(record.count) || record.count < 2 || section !== 'sillybunny')) {
                problems.push(`${where}: count must be an integer above 1 and is kept in the sillybunny section only.`);
            }
            const key = recordKey(record);
            if (seen.has(key)) {
                problems.push(`${where} repeats ${seen.get(key)}.`);
            }
            seen.set(key, where);
        }
    }
    return problems;
}

export const emptyBaseline = () => ({ version: BASELINE_VERSION, upstream: [], sillybunny: [] });

/**
 * The text of the fixture: one record per line, in key order, so that a diff shows one change per line.
 * @param {Sections} baseline
 * @returns {string}
 */
export function formatBaseline(baseline) {
    const section = records => (records.length
        ? `[\n${[...records].sort(compareRecords).map(record => `        ${JSON.stringify(record)}`).join(',\n')}\n    ]`
        : '[]');
    return `{\n    "version": ${BASELINE_VERSION},\n    "upstream": ${section(baseline.upstream)},\n    "sillybunny": ${section(baseline.sillybunny)}\n}\n`;
}

/**
 * Reads the fixture; a missing file is `null`, and one that is not valid throws.
 * @param {string} [file]
 */
export function readBaseline(file = BASELINE_PATH) {
    if (!fs.existsSync(file)) {
        return null;
    }
    const baseline = JSON.parse(fs.readFileSync(file, 'utf8'));
    const problems = validateBaseline(baseline);
    if (problems.length) {
        throw new Error(`${path.basename(file)} is not valid:\n  ${problems.slice(0, 10).join('\n  ')}`);
    }
    return baseline;
}

/**
 * The fixture after a run of one surface. Its records inside the scope are replaced by the records of the run, except those that name
 * only cells that the run did not scan, which are kept. Throws when that adds to the `sillybunny` section and `allowSillybunny` is
 * not set.
 * @param {Sections} baseline
 * @param {{ observed: readonly Triple[], units: readonly ScannedUnit[], inScope: (record: BaselineRecord) => boolean }} run
 * @param {{ allowSillybunny?: boolean }} [options]
 */
export function updatedBaseline(baseline, { observed, units, inScope }, { allowSillybunny = false } = {}) {
    const additions = sillybunnyAdditions(compareToBaseline({ observed, baseline, units, inScope }));
    if (additions.length && !allowSillybunny) {
        throw new Error(`The update would add ${additions.length} record(s) to the sillybunny section:\n${listOf('Added', additions.map(describeRecord)).join('\n')}\n${ALLOW_HINT} The baseline was not written; fix the surface, or allow the rise when it is intended.`);
    }
    const known = cellsLookup(units);
    const kept = record => {
        if (!inScope(record)) {
            return true;
        }
        const cells = known(record.surface, record.state);
        return Boolean(cells) && DIMENSIONS.some(dimension => record[dimension] !== undefined) && !cells.some(cell => matchesCell(record, cell));
    };
    const current = recordsFromTriples(observed, known);
    return {
        version: BASELINE_VERSION,
        upstream: [...baseline.upstream.filter(kept), ...current.upstream],
        sillybunny: [...baseline.sillybunny.filter(kept), ...current.sillybunny],
    };
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const STALE_LOCK_MS = 120_000;

/** The lock of a file lives in the temp directory, keyed by the file's path, so that it never sits in the repository. */
export function lockPathFor(file) {
    const key = crypto.createHash('sha1').update(path.resolve(file)).digest('hex').slice(0, 16);
    return path.join(os.tmpdir(), 'surface-axe-locks', `${key}.lock`);
}

const ageOf = directory => Date.now() - (fs.statSync(directory, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());

/**
 * Removes a lock that its holder left behind. Waiters that all see the same stale lock take turns through a second lock, and each
 * checks again inside it, so that the one that comes second does not remove the fresh lock of the first.
 */
function removeStaleLock(lock) {
    const guard = `${lock}.takeover`;
    try {
        fs.mkdirSync(guard);
    } catch (error) {
        if (error.code === 'EEXIST') {
            if (ageOf(guard) > STALE_LOCK_MS) {
                fs.rmSync(guard, { recursive: true, force: true });
            }
            return;
        }
        throw error;
    }
    try {
        if (ageOf(lock) > STALE_LOCK_MS) {
            fs.rmSync(lock, { recursive: true, force: true });
        }
    } finally {
        fs.rmSync(guard, { recursive: true, force: true });
    }
}

/**
 * Runs `work` while holding a lock on a file, so that workers that update the same fixture or summary take turns. The lock is
 * released when `work` throws.
 * @template T
 * @param {string} file
 * @param {() => T | Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withFileLock(file, work) {
    const lock = lockPathFor(file);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const started = Date.now();
    for (;;) {
        try {
            fs.mkdirSync(lock);
            break;
        } catch (error) {
            if (error.code !== 'EEXIST') {
                throw error;
            }
            if (ageOf(lock) > STALE_LOCK_MS) {
                removeStaleLock(lock);
            } else if (Date.now() - started > 180_000) {
                throw new Error(`Could not lock ${path.basename(file)} for 3 minutes.`);
            } else {
                await sleep(50 + Math.random() * 100);
            }
        }
    }
    try {
        return await work();
    } finally {
        fs.rmSync(lock, { recursive: true, force: true });
    }
}

/**
 * Writes a file in one step, so that a reader never sees half of it.
 * @param {string} file
 * @param {string} text
 */
export function writeFileAtomically(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, text);
    fs.renameSync(temporary, file);
}

/**
 * Applies the run of one surface to the fixture file, under a lock.
 * @param {Parameters<typeof updatedBaseline>[1]} run
 * @param {{ allowSillybunny?: boolean, file?: string }} [options]
 */
export async function updateBaselineFile(run, { allowSillybunny = false, file = BASELINE_PATH } = {}) {
    await withFileLock(file, () => {
        const next = updatedBaseline(readBaseline(file) ?? emptyBaseline(), run, { allowSillybunny });
        writeFileAtomically(file, formatBaseline(next));
    });
}
