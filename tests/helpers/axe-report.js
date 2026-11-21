/**
 * The results of the accessibility scan as data: the findings of a surface, and the summary over all surfaces in
 * `summary.json` and `summary.md`. Nothing here imports Playwright, so the unit tests load it.
 *
 * A finding is one violation of one rule on one element of one surface (or one of its states), with every cell (theme,
 * viewport, backend) where it occurred. The summary groups the findings by rule, by surface and by owner class.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECTIONS } from './axe-baseline.js';

/** The tag groups of a result, in the order that a rule is put in the first one that it carries. */
export const AXE_GROUPS = Object.freeze(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']);
export const IMPACTS = Object.freeze(['critical', 'serious', 'moderate', 'minor']);
const IMPACT_RANK = Object.fromEntries(IMPACTS.map((impact, index) => [impact, index]));

/**
 * @param {readonly string[]} tags The tags of a rule.
 * @returns {string} The group of the rule, `other` when it has none of the groups.
 */
export function groupOf(tags) {
    return AXE_GROUPS.find(group => tags.includes(group)) ?? 'other';
}

const cellLabel = cell => [cell.theme, cell.viewport, cell.backend].filter(Boolean).join(' ');

/**
 * @typedef {object} RunResult The result of one axe run: one surface or state, in one theme and viewport.
 * @property {string | undefined} state
 * @property {string | undefined} backend
 * @property {string} theme
 * @property {string} viewport
 * @property {{ id: string, impact: string | null, group: string, help: string, helpUrl: string, nodes: { target: string, selector?: string, section?: 'upstream' | 'sillybunny', html: string, failureSummary: string }[] }[]} violations The WCAG results, which gate the scan.
 * @property {RunResult['violations']} [bestPractice] The best-practice results, which are only reported.
 * @property {{ id: string, nodes: number }[]} incomplete Results that axe could not decide, as a number of elements.
 * @property {boolean} [settled] False when the surface was still changing or loading when it was scanned.
 *
 * @typedef {object} Finding
 * @property {string | undefined} state
 * @property {string} rule
 * @property {string} impact
 * @property {string} group
 * @property {string} help
 * @property {string} helpUrl
 * @property {string} target The normalised selector that the baseline is keyed by.
 * @property {string} [selector] The selector that axe gave the element.
 * @property {'upstream' | 'sillybunny'} [section] The section of the baseline that the element belongs to.
 * @property {string} html
 * @property {string} failureSummary
 * @property {{ theme: string, viewport: string, backend?: string }[]} cells
 */

/**
 * Merges the runs of a surface into findings: the same rule on the same element of the same state is one finding.
 * @param {readonly RunResult[]} runs
 * @returns {Finding[]}
 */
export function collectFindings(runs) {
    const findings = new Map();
    for (const run of runs) {
        for (const violation of run.violations) {
            for (const node of violation.nodes) {
                const key = JSON.stringify([run.state ?? '', violation.id, node.target]);
                const finding = findings.get(key) ?? {
                    state: run.state,
                    rule: violation.id,
                    impact: violation.impact ?? 'minor',
                    group: violation.group,
                    help: violation.help,
                    helpUrl: violation.helpUrl,
                    section: node.section,
                    target: node.target,
                    selector: node.selector,
                    html: node.html,
                    failureSummary: node.failureSummary,
                    cells: [],
                };
                const cell = { theme: run.theme, viewport: run.viewport, ...(run.backend && { backend: run.backend }) };
                if (!finding.cells.some(known => cellLabel(known) === cellLabel(cell))) {
                    finding.cells.push(cell);
                }
                findings.set(key, finding);
            }
        }
    }
    return [...findings.values()].sort((a, b) => IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact] || a.rule.localeCompare(b.rule) || (a.state ?? '').localeCompare(b.state ?? '') || a.target.localeCompare(b.target));
}

/** The `incomplete` results of the runs as a number of node-runs per rule: an element that is undecided in each of several cells and states counts once per run. */
export function countIncomplete(runs) {
    const counts = {};
    for (const run of runs) {
        for (const item of run.incomplete) {
            counts[item.id] = (counts[item.id] ?? 0) + item.nodes;
        }
    }
    return counts;
}

/**
 * @typedef {object} SurfaceDigest What a test keeps of one surface for the summary.
 * @property {string} surface
 * @property {string} family
 * @property {'A' | 'B' | 'C'} owner
 * @property {number} runs
 * @property {string[]} errors
 * @property {string[]} [retried]
 * @property {string[]} [unsettled] The runs that did not settle before the scan.
 * @property {Finding[]} findings
 * @property {Finding[]} [bestPractice]
 * @property {Record<string, number>} incomplete Node-runs per rule.
 */

const tally = (target, key, amount = 1) => {
    target[key] = (target[key] ?? 0) + amount;
};

const themesOf = finding => [...new Set(finding.cells.map(cell => cell.theme))];

const addToRule = (byRule, finding, digest) => {
    const rule = byRule.get(finding.rule) ?? {
        rule: finding.rule, impact: finding.impact, group: finding.group, help: finding.help, helpUrl: finding.helpUrl,
        findings: 0, byOwner: {}, bySection: {}, byTheme: {}, surfaces: new Set(), items: [],
    };
    rule.findings++;
    tally(rule.byOwner, digest.owner);
    tally(rule.bySection, finding.section);
    for (const theme of themesOf(finding)) {
        tally(rule.byTheme, theme);
    }
    rule.surfaces.add(digest.surface);
    rule.items.push({
        surface: digest.surface, state: finding.state, owner: digest.owner, section: finding.section, impact: finding.impact,
        target: finding.target, selector: finding.selector, failureSummary: finding.failureSummary, html: finding.html, cells: finding.cells,
    });
    byRule.set(finding.rule, rule);
};

const sortedRules = byRule => [...byRule.values()]
    .map(rule => ({ ...rule, surfaces: [...rule.surfaces].sort() }))
    .sort((a, b) => IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact] || b.findings - a.findings || a.rule.localeCompare(b.rule));

/**
 * Groups the findings of every surface by rule, by surface and by owner class. The best-practice findings are grouped on their own, and
 * the results that axe could not decide are counted in node-runs.
 * @param {readonly SurfaceDigest[]} digests
 * @param {Record<string, string>} [skipped]
 */
export function summarise(digests, skipped = {}) {
    const byRule = new Map();
    const bestPracticeByRule = new Map();
    const bySurface = [];
    const totals = { surfaces: digests.length, runs: 0, findings: 0, byImpact: {}, byGroup: {}, bySection: {}, byOwner: {}, byTheme: {} };
    const byOwner = {};
    const errors = [];
    const retried = [];
    const unsettled = [];
    const undecided = { nodeRuns: {}, colorContrastBySurface: [] };
    for (const digest of [...digests].sort((a, b) => a.surface.localeCompare(b.surface))) {
        totals.runs += digest.runs;
        errors.push(...digest.errors.map(message => `${digest.surface}: ${message}`));
        retried.push(...(digest.retried ?? []).map(label => `${digest.surface}: ${label}`));
        unsettled.push(...(digest.unsettled ?? []).map(label => `${digest.surface}: ${label}`));
        for (const [rule, count] of Object.entries(digest.incomplete)) {
            tally(undecided.nodeRuns, rule, count);
        }
        if (digest.incomplete['color-contrast']) {
            undecided.colorContrastBySurface.push({ surface: digest.surface, nodeRuns: digest.incomplete['color-contrast'] });
        }
        const surfaceRules = {};
        for (const finding of digest.findings) {
            totals.findings++;
            tally(totals.byImpact, finding.impact);
            tally(totals.byGroup, finding.group);
            tally(totals.bySection, finding.section);
            tally(totals.byOwner, digest.owner);
            for (const theme of themesOf(finding)) {
                tally(totals.byTheme, theme);
            }
            tally(surfaceRules, finding.rule);
            const owner = byOwner[digest.owner] ??= { findings: 0, byImpact: {}, byRule: {} };
            owner.findings++;
            tally(owner.byImpact, finding.impact);
            tally(owner.byRule, finding.rule);
            addToRule(byRule, finding, digest);
        }
        for (const finding of digest.bestPractice ?? []) {
            addToRule(bestPracticeByRule, finding, digest);
        }
        bySurface.push({
            surface: digest.surface, family: digest.family, owner: digest.owner,
            findings: digest.findings.length, sillybunny: digest.findings.filter(finding => finding.section === 'sillybunny').length, rules: surfaceRules,
        });
    }
    undecided.colorContrastBySurface = undecided.colorContrastBySurface.sort((a, b) => b.nodeRuns - a.nodeRuns || a.surface.localeCompare(b.surface)).slice(0, 10);
    return {
        totals,
        byRule: sortedRules(byRule),
        bySurface: bySurface.filter(surface => surface.findings > 0).sort((a, b) => b.findings - a.findings || a.surface.localeCompare(b.surface)),
        byOwner,
        bestPractice: sortedRules(bestPracticeByRule),
        undecided,
        errors,
        retried,
        unsettled,
        skipped,
    };
}

const ITEMS_PER_RULE = 6;
const firstLine = text => String(text).split('\n').map(line => line.trim()).filter(Boolean).slice(0, 3).join(' ');
const cell = text => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * @param {ReturnType<typeof summarise>} summary
 * @returns {string}
 */
export function formatMarkdown(summary) {
    const { totals } = summary;
    const lines = [
        '# Accessibility scan of the surface registry',
        '',
        `${totals.surfaces} surfaces, ${totals.runs} axe runs, ${totals.findings} findings (one per rule, element and state; the same element in several cells counts once).`,
        '',
        `- Impact: ${IMPACTS.map(impact => `${impact} ${totals.byImpact[impact] ?? 0}`).join(', ')}.`,
        `- Group: ${Object.entries(totals.byGroup).map(([group, count]) => `${group} ${count}`).join(', ') || 'none'}.`,
        `- Owner class of the surface: ${['A', 'B', 'C'].map(owner => `${owner} ${totals.byOwner[owner] ?? 0}`).join(', ')}; section of the element: ${SECTIONS.map(section => `${section} ${totals.bySection[section] ?? 0}`).join(', ')}.`,
        `- Theme (a finding that occurs in both counts in both): ${Object.entries(totals.byTheme).map(([theme, count]) => `${theme} ${count}`).join(', ') || 'none'}.`,
    ];
    if (summary.errors.length) {
        lines.push('', '## Runs that failed', '', ...summary.errors.map(message => `- ${cell(message)}`));
    }
    if (Object.keys(summary.skipped ?? {}).length) {
        lines.push('', '## Surfaces left out of the scan', '', ...Object.entries(summary.skipped).map(([id, reason]) => `- ${id}: ${cell(reason)}`));
    }
    if (summary.retried?.length) {
        lines.push('', '## Opened a second time (the first attempt failed)', '', ...summary.retried.map(message => `- ${cell(message)}`));
    }
    if (summary.unsettled?.length) {
        lines.push('', '## Scanned before the surface settled (still changing or loading)', '', ...summary.unsettled.map(message => `- ${cell(message)}`));
    }
    lines.push('', '## By rule', '', '| Rule | Impact | Group | Findings | A | B | C | Surfaces |', '|---|---|---|---:|---:|---:|---:|---:|');
    for (const rule of summary.byRule) {
        lines.push(`| \`${rule.rule}\` | ${rule.impact} | ${rule.group} | ${rule.findings} | ${rule.byOwner.A ?? 0} | ${rule.byOwner.B ?? 0} | ${rule.byOwner.C ?? 0} | ${rule.surfaces.length} |`);
    }
    lines.push('', '## By owner class', '', '| Owner | Findings | Critical | Serious | Moderate | Minor |', '|---|---:|---:|---:|---:|---:|');
    for (const owner of Object.keys(summary.byOwner).sort()) {
        const entry = summary.byOwner[owner];
        lines.push(`| ${owner} | ${entry.findings} | ${IMPACTS.map(impact => entry.byImpact[impact] ?? 0).join(' | ')} |`);
    }
    lines.push('', '## By surface', '', '| Surface | Owner | Findings | In the sillybunny section | Rules |', '|---|---|---:|---:|---|');
    for (const surface of summary.bySurface) {
        lines.push(`| ${surface.surface} | ${surface.owner} | ${surface.findings} | ${surface.sillybunny} | ${Object.entries(surface.rules).map(([rule, count]) => `${rule} ${count}`).join(', ')} |`);
    }
    if (summary.bestPractice?.length) {
        lines.push('', '## Best practices (reported, not gated)', '', '| Rule | Impact | Findings | Surfaces |', '|---|---|---:|---:|');
        for (const rule of summary.bestPractice) {
            lines.push(`| \`${rule.rule}\` | ${rule.impact} | ${rule.findings} | ${rule.surfaces.length} |`);
        }
    }
    if (Object.keys(summary.undecided?.nodeRuns ?? {}).length) {
        lines.push('', '## Undecided (axe could not decide), in node-runs', '', 'A node-run is one element in one run (one state, theme and viewport), so an element that is undecided in several runs counts once per run.', '',
            Object.entries(summary.undecided.nodeRuns).sort((a, b) => b[1] - a[1]).map(([rule, count]) => `${rule} ${count}`).join(', '),
            '', 'Surfaces with the most undecided `color-contrast` node-runs:', '', ...summary.undecided.colorContrastBySurface.map(item => `- ${item.surface}: ${item.nodeRuns}`));
    }
    lines.push('', '## Details', '', `The first ${ITEMS_PER_RULE} findings of each rule; \`summary.json\` has all of them.`);
    for (const rule of summary.byRule) {
        lines.push('', `### ${rule.rule} (${rule.impact}, ${rule.group}): ${rule.help}`, '', rule.helpUrl, '');
        for (const item of rule.items.slice(0, ITEMS_PER_RULE)) {
            lines.push(`- ${item.surface}${item.state ? ` / ${item.state}` : ''} [${item.owner}] \`${cell(item.selector ?? item.target)}\` (${item.cells.map(cellLabel).join('; ')}): ${cell(firstLine(item.failureSummary))}`);
        }
        if (rule.items.length > ITEMS_PER_RULE) {
            lines.push(`- and ${rule.items.length - ITEMS_PER_RULE} more`);
        }
    }
    return `${lines.join('\n')}\n`;
}

/**
 * Reads the digest of each given surface from `<directory>/surfaces/<id>.json` and writes `summary.json` and `summary.md`
 * next to it. A surface without a digest (not run yet) is left out. The skipped surfaces are kept in `skipped.json`, so that a rebuild
 * from the digests alone still lists them.
 * @param {string} directory
 * @param {readonly string[]} surfaceIds
 * @param {Record<string, string>} [skipped] Surface ids that the scan leaves out, with the reason; the last ones written when absent.
 */
export function writeSummary(directory, surfaceIds, skipped) {
    const skippedFile = path.join(directory, 'skipped.json');
    if (skipped) {
        fs.writeFileSync(skippedFile, `${JSON.stringify(skipped, null, 2)}\n`);
    }
    const kept = skipped ?? (fs.existsSync(skippedFile) ? JSON.parse(fs.readFileSync(skippedFile, 'utf8')) : {});
    const digests = surfaceIds
        .map(id => path.join(directory, 'surfaces', `${id}.json`))
        .filter(file => fs.existsSync(file))
        .map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
    const summary = summarise(digests, kept);
    fs.writeFileSync(path.join(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    fs.writeFileSync(path.join(directory, 'summary.md'), formatMarkdown(summary));
    return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const directory = path.resolve(process.argv[2] ?? '');
    const ids = fs.readdirSync(path.join(directory, 'surfaces')).filter(name => name.endsWith('.json')).map(name => name.slice(0, -'.json'.length));
    const summary = writeSummary(directory, ids);
    console.log(`Wrote summary.json and summary.md in ${directory}: ${summary.totals.findings} findings over ${summary.totals.surfaces} surfaces.`);
}
