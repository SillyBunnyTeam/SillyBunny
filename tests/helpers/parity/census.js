/**
 * Builds the census of a record run from the measurements of its surfaces: for each family a JSON file with every row and
 * every part state, and a Markdown file with one table per part, and a one-line summary per family. Pure: the script that
 * reads the run folder and writes the files is `scripts/update-parity-allowlist.js`.
 *
 * A measurement is `{ family, surface, viewport, group?, pointer, parts, rows }` as the spec writes it (`parts` and `rows` are the
 * output of `buildRows`). A row is one distinct value of one property of one part of one member, with the number of
 * instances that have it; the JSON file holds all of them, and the Markdown file lists the values of each property over the
 * family and, per value that is not canonical, the members that have it.
 */

import { entryKey, outliersOf } from './compare.js';

const byText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const printable = value => (value === null || value === undefined ? 'not compared' : typeof value === 'number' ? `${value}` : `\`${value}\``);

/** How many absent members a part's note names; the JSON file lists them all. */
const ABSENT_LISTED = 12;

const where = row => `${row.surface}@${row.viewport.split('x')[0]}`;

/**
 * @param {any[]} measurements
 * @returns {any[]} The measurements in a fixed order, so that the output does not depend on the order that tests finished in.
 */
export function sortMeasurements(measurements) {
    return [...measurements].sort((left, right) => byText(`${left.surface}|${left.viewport}`, `${right.surface}|${right.viewport}`));
}

const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0);

/**
 * @param {Array<[number | string, number]>} pairs A value and its instance count.
 * @returns {string} The values in order, each with its count.
 */
function valueList(pairs) {
    const counts = new Map();
    for (const [value, count] of pairs) {
        counts.set(value, (counts.get(value) ?? 0) + count);
    }
    return [...counts.entries()]
        .sort((left, right) => (typeof left[0] === 'number' && typeof right[0] === 'number' ? left[0] - right[0] : byText(String(left[0]), String(right[0]))))
        .map(([value, count]) => `${printable(value)} (${count})`)
        .join(', ');
}

/**
 * The census of one family.
 * @param {object} input
 * @param {{ family: string, parts: any[], groupLabels?: Record<string, string> }} input.rules
 * @param {any[]} input.measurements The measurements of this family.
 * @returns {{ json: object, markdown: string, stats: { members: number, properties: number, instances: number, outliers: number, outlierMembers: number, partsAbsent: number } }}
 */
export function buildFamilyCensus({ rules, measurements }) {
    const sorted = sortMeasurements(measurements);
    const rows = sorted.flatMap(measurement => measurement.rows.map(row => ({ ...row, group: measurement.group ?? null })));
    const states = sorted.flatMap(measurement => measurement.parts.map(state => ({ ...state, surface: measurement.surface, viewport: measurement.viewport, group: measurement.group ?? null })));
    const members = [...new Set(sorted.map(measurement => measurement.surface))];
    const labelOrder = Object.keys(rules.groupLabels ?? {});
    const groups = [...new Set(sorted.map(measurement => measurement.group ?? ''))]
        .sort((left, right) => (labelOrder.indexOf(left) - labelOrder.indexOf(right)) || byText(left, right));
    const outliers = outliersOf(rows);
    const outlierKeys = new Set(outliers.map(entryKey));
    const outlierMembers = new Set(outliers.map(row => row.surface));
    const absent = states.filter(state => state.absent);

    // The markup of a part is reported as a property of its own but is not one of the properties that the rules compare.
    const propertyCells = new Set(rows.filter(row => row.property !== 'markup').map(row => `${row.part}|${row.property}`));
    const stats = {
        members: members.length,
        properties: propertyCells.size,
        instances: sum(states.filter(state => !state.absent), state => state.instances),
        outliers: outlierKeys.size,
        outlierMembers: outlierMembers.size,
        partsAbsent: absent.length,
    };

    const json = {
        family: rules.family,
        stats,
        members: sorted.map(({ surface, viewport, group, pointer }) => ({ surface, viewport, ...(group && { group }), pointer })),
        parts: states.map(state => ({
            surface: state.surface,
            viewport: state.viewport,
            ...(state.group && { group: state.group }),
            part: state.part,
            absent: state.absent,
            ...(!state.absent && { instances: state.instances, capped: state.capped, alternatives: state.alternatives }),
            ...(state.hidden && { hidden: state.hidden }),
        })),
        rows: rows.map(row => ({
            surface: row.surface,
            viewport: row.viewport,
            ...(row.group && { group: row.group }),
            part: row.part,
            property: row.property,
            value: row.value,
            count: row.count,
            canonical: row.canonical,
            source: row.source,
            ...(row.form && { form: row.form }),
            ...(row.floor && { floor: true }),
            agree: row.agree,
            selector: row.selector,
            element: row.element,
            alternative: row.alternative,
        })),
    };

    const lines = [
        `# Census: ${rules.family}`,
        '',
        `${stats.members} members, ${sorted.length} measurements (a member at a viewport), ${stats.properties} compared properties, ${stats.instances} instances measured, ${stats.outliers} outlier entries in ${stats.outlierMembers} members, ${stats.partsAbsent} parts absent.`,
        '',
    ];
    for (const group of groups) {
        const inGroup = sorted.filter(measurement => (measurement.group ?? '') === group);
        if (groups.length > 1) {
            lines.push(`## ${rules.groupLabels?.[group] ?? group}`, '', `${new Set(inGroup.map(measurement => measurement.surface)).size} members, ${inGroup.length} measurements.`, '');
        }
        const level = groups.length > 1 ? '###' : '##';
        for (const part of rules.parts) {
            const partStates = states.filter(state => state.part === part.id && (state.group ?? '') === group);
            if (!partStates.length) {
                continue;
            }
            const partRows = rows.filter(row => row.part === part.id && (row.group ?? '') === group);
            const present = partStates.filter(state => !state.absent);
            const gone = partStates.filter(state => state.absent);
            const used = {};
            for (const state of present) {
                for (const [alternative, count] of Object.entries(state.alternatives)) {
                    used[alternative] = (used[alternative] ?? 0) + count;
                }
            }
            const notes = [`Present in ${present.length} of ${partStates.length} measurements, ${sum(present, state => state.instances)} instances measured.`];
            if (part.selectors.length > 1) {
                notes.push(`Markup used: ${part.selectors.filter(alternative => used[alternative.id]).map(alternative => `${alternative.id} (${used[alternative.id]})`).join(', ') || 'none'}; the first alternative (${part.selectors[0].id}) is the canonical one.`);
            }
            if (gone.length) {
                notes.push(`Absent in ${gone.length}: ${gone.slice(0, ABSENT_LISTED).map(where).join(', ')}${gone.length > ABSENT_LISTED ? `, and ${gone.length - ABSENT_LISTED} more (the JSON file has them all)` : ''}.`);
            }
            const capped = present.filter(state => state.capped);
            if (capped.length) {
                notes.push(`Reached the cap of instances: ${capped.map(where).join(', ')}.`);
            }
            lines.push(`${level} ${part.id}`, '', notes.join(' '), '');
            if (!partRows.length) {
                continue;
            }
            lines.push('| Property | Canonical | Source | Agree | Values (instances) | Outliers |', '|---|---|---|---|---|---|');
            const properties = [...new Set(partRows.map(row => row.property))];
            for (const property of properties) {
                const cells = partRows.filter(row => row.property === property);
                const bad = outliersOf(cells);
                const instances = sum(cells, row => row.count);
                const memberKeys = new Set(cells.map(row => `${row.surface}|${row.viewport}`));
                const badKeys = new Set(bad.map(row => `${row.surface}|${row.viewport}`));
                const canonicals = [...new Set(cells.map(row => (row.canonical === null ? 'not compared' : `${printable(row.canonical)}${row.floor ? ' or more' : ''}${row.form ? ` (${row.form})` : ''}`)))].sort(byText);
                const sources = [...new Set(cells.map(row => row.source))].sort(byText);
                const byValue = new Map();
                for (const row of bad) {
                    byValue.set(row.value, [...(byValue.get(row.value) ?? []), `${where(row)} (${row.count})`]);
                }
                const outlierText = [...byValue.entries()]
                    .sort((left, right) => (typeof left[0] === 'number' && typeof right[0] === 'number' ? left[0] - right[0] : byText(String(left[0]), String(right[0]))))
                    .map(([value, list]) => `${printable(value)}: ${list.join(', ')}`)
                    .join('; ');
                lines.push(`| ${property} | ${canonicals.join(' / ')} | ${sources.join(' / ')} | ${instances - sum(bad, row => row.count)} of ${instances} instances, ${memberKeys.size - badKeys.size} of ${memberKeys.size} members | ${valueList(cells.map(row => [row.value, row.count]))} | ${outlierText || 'none'} |`);
            }
            lines.push('');
        }
    }

    const hidden = states.filter(state => state.hidden?.length);
    if (hidden.length) {
        lines.push('## Hidden by LIBADWAITA_AUDIT_ALLOWLIST', '', 'The audit leaves records out of the failing counts above when an entry of its own allow-list covers them. The entries that hide a failing record at each member are listed so that nothing is hidden twice.', '', '| Member | Rule | Entry of the allow-list |', '|---|---|---|');
        for (const state of hidden) {
            for (const entry of state.hidden) {
                lines.push(`| ${where(state)} | ${entry.rule} | \`${entry.selector}\` |`);
            }
        }
        lines.push('');
    }
    return { json, markdown: `${lines.join('\n').trimEnd()}\n`, stats };
}

/**
 * @param {Record<string, ReturnType<typeof buildFamilyCensus>['stats']>} statsByFamily
 * @param {Record<string, number>} temporary The temporary allow-list entries of each family.
 * @returns {string}
 */
export function buildSummary(statsByFamily, temporary) {
    const lines = ['# Parity census', ''];
    for (const family of Object.keys(statsByFamily).sort(byText)) {
        const { members, properties, instances, outliers, outlierMembers, partsAbsent } = statsByFamily[family];
        lines.push(`- ${family}: ${members} members, ${properties} properties, ${instances} instances measured, ${outliers} outlier entries in ${outlierMembers} members, ${partsAbsent} parts absent, ${temporary[family] ?? 0} temporary entries`);
    }
    return `${lines.join('\n')}\n`;
}

/** The entries of an allow-list in their file order. */
export const sortEntries = entries => [...entries].sort((left, right) => byText(entryKey(left), entryKey(right)));
