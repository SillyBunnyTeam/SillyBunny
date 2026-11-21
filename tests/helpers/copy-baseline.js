/**
 * The baseline of the copy check (`audit/surface-audit.e2e.js`): how a string that breaks the Capitalisation Rule becomes a record, how a
 * run is compared with `fixtures/copy-baseline.json`, and how the fixture is updated. Nothing here imports Playwright, so the unit tests
 * load it. It follows `axe-baseline.js`: two sections, `upstream` for wording that upstream wrote (verbatim in the upstream base commit)
 * and `sillybunny` for the rest, which must shrink to nothing, so an update never adds to it unless it is told to.
 *
 * A record is one string in one role on one surface (or one state of it): `{ surface, state?, role, text, expected, target }`. The key is
 * the surface, the state, the role and the text; `target` and `expected` say where it is and what the rule gives, and a change of either
 * alone is not a new violation. The text of a unit is the union of what its 1440x900 and 390x844 boots show, because a string that only one
 * layout draws (an icon-only button's name) must be judged, and one that a slow boot misses in one layout must not be a new record.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomically, withFileLock } from './axe-baseline.js';

export const COPY_BASELINE_VERSION = 1;
export const COPY_BASELINE_PATH = fileURLToPath(new URL('../fixtures/copy-baseline.json', import.meta.url));
export const COPY_SECTIONS = Object.freeze(['upstream', 'sillybunny']);
export const COPY_UPDATE_VARIABLE = 'SURFACE_COPY_UPDATE';
export const COPY_ALLOW_VARIABLE = 'SURFACE_COPY_ALLOW_SILLYBUNNY';
export const COPY_FIXTURE_VARIABLE = 'SURFACE_COPY_FIXTURE';
export const COPY_UPDATE_COMMAND = `${COPY_UPDATE_VARIABLE}=1 SURFACE_CHECKS=copy ~/bin/e2e -c playwright.audit.config.js audit/surface-audit.e2e.js (run from tests/)`;
export const COPY_ALLOW_HINT = `Records may be added to the sillybunny section only with ${COPY_ALLOW_VARIABLE}=1 next to ${COPY_UPDATE_VARIABLE}=1.`;

/**
 * @typedef {object} CopyRecord
 * @property {string} surface
 * @property {string} [state] Absent for the surface as found.
 * @property {string} role
 * @property {string} text The rendered text, or the template that it fills.
 * @property {string} expected The text as the rule writes it; empty when the string needs other words.
 * @property {string} target A normalised selector of the first element that shows it.
 *
 * @typedef {{ upstream: CopyRecord[], sillybunny: CopyRecord[] }} CopySections
 * @typedef {CopyRecord & { section: 'upstream' | 'sillybunny' }} Observation
 * @typedef {{ surface: string, state?: string }} CopyUnit A surface or state whose strings were collected.
 */

export const copyKey = record => JSON.stringify([record.surface, record.state ?? '', record.role, record.text]);
const wordingKey = record => JSON.stringify([record.role, record.text]);
const unitKey = unit => JSON.stringify([unit.surface, unit.state ?? '']);

const compareRecords = (first, second) => {
    const [a, b] = [copyKey(first), copyKey(second)];
    return a < b ? -1 : a > b ? 1 : 0;
};

const publicRecord = ({ surface, state, role, text, expected, target }) => ({
    surface, ...(state && { state }), role, text, expected, target,
});

/**
 * One observation for each key: the first element that shows a string names its target.
 * @param {readonly Observation[]} items
 */
export function uniqueObservations(items) {
    const byKey = new Map();
    for (const item of items) {
        if (!byKey.has(copyKey(item))) {
            byKey.set(copyKey(item), item);
        }
    }
    return [...byKey.values()];
}

/**
 * Compares the violations of a run with the fixture. Only the records whose unit was collected in the run (`units`) are judged, so a run
 * of one surface leaves the other surfaces' records alone.
 * @param {{ observed: readonly Observation[], baseline: CopySections, units: readonly CopyUnit[] }} input
 */
export function compareToCopyBaseline({ observed, baseline, units }) {
    const collected = new Set(units.map(unitKey));
    // Upstream wording is never changed here, and some of it shows only once a value has loaded (a token count's tooltip), so
    // the state it turns up in varies between runs. The gate holds the upstream section to the wording it knows, wherever it
    // shows, and leaves its records to the update; the sillybunny section stays held record by record.
    const upstreamWording = new Set(baseline.upstream.map(wordingKey));
    const recorded = new Map();
    for (const section of COPY_SECTIONS) {
        for (const record of baseline[section]) {
            if (collected.has(unitKey(record))) {
                recorded.set(copyKey(record), { section, record });
            }
        }
    }
    const seen = new Set();
    const added = [];
    const moved = [];
    for (const item of observed) {
        const key = copyKey(item);
        seen.add(key);
        const known = recorded.get(key);
        // A string whose origin is not known (the upstream commit is not in this clone) is judged in the section of its record.
        const section = item.section ?? known?.section ?? 'sillybunny';
        if (!known) {
            if (section === 'upstream' && upstreamWording.has(wordingKey(item))) continue;
            added.push({ section, record: publicRecord(item) });
        } else if (known.section !== section) {
            moved.push({ from: known.section, to: section, record: publicRecord(item) });
        }
    }
    const fixed = [...recorded.entries()]
        .filter(([key, { section }]) => section === 'sillybunny' && !seen.has(key))
        .map(([, { section, record }]) => ({ section, record }));
    return { added, fixed, moved };
}

/** The records that an update would add to the `sillybunny` section: new ones, and ones that move there from `upstream`. */
export const copySillybunnyAdditions = comparison => [
    ...comparison.added.filter(item => item.section === 'sillybunny').map(item => item.record),
    ...comparison.moved.filter(item => item.to === 'sillybunny').map(item => item.record),
];

export function describeCopyRecord(record) {
    return `${record.surface}${record.state ? ` state ${record.state}` : ''}: ${record.role} "${record.text}"${record.expected ? ` should be "${record.expected}"` : ' needs other words'} at ${record.target}`;
}

const MAX_LISTED = 25;
const listOf = (title, items) => (items.length
    ? [`${title} (${items.length}):`, ...items.slice(0, MAX_LISTED).map(item => `  ${item}`), ...(items.length > MAX_LISTED ? [`  and ${items.length - MAX_LISTED} more`] : [])]
    : []);

/** The failure message of a comparison; empty when the run equals the fixture. */
export function formatCopyComparison(comparison) {
    const problems = [];
    const added = comparison.added.map(item => `${describeCopyRecord(item.record)} [${item.section} section]`);
    if (added.length) {
        problems.push(listOf('Strings that break the Capitalisation Rule and are in neither section of copy-baseline.json. Fix the string; an update would add them', added).join('\n'));
    }
    const moved = comparison.moved.map(item => `${describeCopyRecord(item.record)}: the fixture has it in ${item.from}, the string is ${item.to}`);
    if (moved.length) {
        problems.push(listOf('Records in the other section than the string belongs to', moved).join('\n'));
    }
    const fixed = comparison.fixed.map(item => `${describeCopyRecord(item.record)} [${item.section}]`);
    if (fixed.length) {
        problems.push(listOf('Records that no longer occur', fixed).join('\n'));
    }
    if (fixed.length || moved.length) {
        problems.push(`Remove the fixed records from the baseline, so that the file only shrinks. The update removes them and adds nothing to the sillybunny section on its own: ${COPY_UPDATE_COMMAND}`);
    }
    return problems;
}

/**
 * Whether a baseline is well formed.
 * @param {unknown} baseline
 * @returns {string[]} The problems; empty when valid.
 */
export function validateCopyBaseline(baseline) {
    if (!baseline || typeof baseline !== 'object' || baseline.version !== COPY_BASELINE_VERSION) {
        return [`The baseline must be an object with version ${COPY_BASELINE_VERSION}.`];
    }
    const problems = [];
    const seen = new Map();
    for (const section of COPY_SECTIONS) {
        if (!Array.isArray(baseline[section])) {
            problems.push(`The "${section}" section must be an array.`);
            continue;
        }
        for (const [index, record] of baseline[section].entries()) {
            const where = `${section}[${index}]`;
            const text = value => typeof value === 'string' && value !== '';
            if (!record || typeof record !== 'object' || !text(record.surface) || !text(record.role) || !text(record.text) || !text(record.target) || typeof record.expected !== 'string') {
                problems.push(`${where} needs a surface, a role, a text, an expected form (empty when the string needs other words) and a target.`);
                continue;
            }
            for (const optional of ['state']) {
                if (record[optional] !== undefined && !text(record[optional])) {
                    problems.push(`${where}: ${optional} must be a non-empty string when present.`);
                }
            }
            const key = copyKey(record);
            if (seen.has(key)) {
                problems.push(`${where} repeats ${seen.get(key)}.`);
            }
            seen.set(key, where);
        }
    }
    return problems;
}

export const emptyCopyBaseline = () => ({ version: COPY_BASELINE_VERSION, upstream: [], sillybunny: [] });

/** The text of the fixture: one record per line, in key order, so that a diff shows one change per line. */
export function formatCopyBaseline(baseline) {
    const section = records => (records.length
        ? `[\n${[...records].sort(compareRecords).map(record => `        ${JSON.stringify(publicRecord(record))}`).join(',\n')}\n    ]`
        : '[]');
    return `{\n    "version": ${COPY_BASELINE_VERSION},\n    "upstream": ${section(baseline.upstream)},\n    "sillybunny": ${section(baseline.sillybunny)}\n}\n`;
}

/** Reads the fixture; a missing file is `null`, and one that is not valid throws. */
export function readCopyBaseline(file = COPY_BASELINE_PATH) {
    if (!fs.existsSync(file)) {
        return null;
    }
    const baseline = JSON.parse(fs.readFileSync(file, 'utf8'));
    const problems = validateCopyBaseline(baseline);
    if (problems.length) {
        throw new Error(`${path.basename(file)} is not valid:\n  ${problems.slice(0, 10).join('\n  ')}`);
    }
    return baseline;
}

/**
 * The fixture after a run. Its records of the collected units are replaced by the observed ones. Throws when that adds to the
 * `sillybunny` section and `allowSillybunny` is not set.
 * @param {CopySections} baseline
 * @param {{ observed: readonly Observation[], units: readonly CopyUnit[] }} run
 * @param {{ allowSillybunny?: boolean }} [options]
 */
export function updatedCopyBaseline(baseline, { observed, units }, { allowSillybunny = false } = {}) {
    const additions = copySillybunnyAdditions(compareToCopyBaseline({ observed, baseline, units }));
    if (additions.length && !allowSillybunny) {
        throw new Error(`The update would add ${additions.length} record(s) to the sillybunny section:\n${listOf('Added', additions.map(describeCopyRecord)).join('\n')}\n${COPY_ALLOW_HINT} The baseline was not written; fix the string, or allow the rise when it is intended.`);
    }
    const collected = new Set(units.map(unitKey));
    const kept = record => !collected.has(unitKey(record));
    return {
        version: COPY_BASELINE_VERSION,
        upstream: [...baseline.upstream.filter(kept), ...observed.filter(item => item.section === 'upstream').map(publicRecord)],
        sillybunny: [...baseline.sillybunny.filter(kept), ...observed.filter(item => item.section === 'sillybunny').map(publicRecord)],
    };
}

/** Applies the run of one surface to the fixture file, under a lock. */
export async function updateCopyBaselineFile(run, { allowSillybunny = false, file = COPY_BASELINE_PATH } = {}) {
    await withFileLock(file, () => {
        const next = updatedCopyBaseline(readCopyBaseline(file) ?? emptyCopyBaseline(), run, { allowSillybunny });
        writeFileAtomically(file, formatCopyBaseline(next));
    });
}
