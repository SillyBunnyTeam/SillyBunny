#!/usr/bin/env node

// Compares per-folder Jest V8 unit-test line coverage against scripts/unit-coverage-baseline.json.
// Fails when any tracked folder drops below its baseline or disappears; improvements pass and only
// raise the baseline when updated explicitly with --update-baseline.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDirectory, '..');
const baselineVersion = 1;

export const defaultReportPath = path.join(defaultRepoRoot, 'coverage', 'unit', 'coverage-summary.json');
export const defaultBaselinePath = path.join(scriptDirectory, 'unit-coverage-baseline.json');
export const UPDATE_COMMAND = 'node scripts/check-unit-coverage.js --update-baseline';

function toPosix(value) {
    return String(value).replace(/\\/g, '/');
}

export function roundPercent(value) {
    return Math.round(value * 100) / 100;
}

export function computePercent(covered, total) {
    if (!Number.isFinite(total) || total <= 0) {
        return 100;
    }
    return roundPercent((covered / total) * 100);
}

/**
 * Resolves a Jest coverage-summary file key to a POSIX path relative to `repoRoot`.
 * Returns `null` when the path lies outside `repoRoot` or escapes it.
 */
export function normalizeCoverageFilePath(rawPath, repoRoot = defaultRepoRoot) {
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
        return null;
    }

    const posixRaw = path.posix.normalize(toPosix(rawPath.trim()));
    const trimmedRoot = String(repoRoot).trim();
    const isExplicitRoot = trimmedRoot.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(trimmedRoot);
    const posixRoot = path.posix.normalize(toPosix(isExplicitRoot ? trimmedRoot : path.resolve(trimmedRoot))).replace(/\/+$/, '');
    const isAbsolute = posixRaw.startsWith('/') || /^[a-zA-Z]:\//.test(posixRaw);

    let relative;
    if (isAbsolute) {
        if (posixRaw.startsWith(`${posixRoot}/`)) {
            relative = posixRaw.slice(posixRoot.length + 1);
        } else if (/^[a-zA-Z]:\//.test(posixRaw) && posixRaw.toLowerCase().startsWith(`${posixRoot.toLowerCase()}/`)) {
            // Windows drive-letter casing can differ between Jest and path.resolve().
            relative = posixRaw.slice(posixRoot.length + 1);
        } else {
            return null;
        }
    } else {
        relative = posixRaw.replace(/^\.\//, '');
    }

    const cleaned = path.posix.normalize(relative).replace(/^\/+/, '');
    if (!cleaned || cleaned === '.' || cleaned === '..' || cleaned.startsWith('../')) {
        return null;
    }

    return cleaned;
}

/**
 * Groups a repository-relative POSIX source path into its stable coverage folder bucket.
 */
export function folderForFile(relativePath) {
    const normalized = toPosix(relativePath).replace(/^\.\//, '');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length < 2) {
        return null;
    }

    if (parts[0] === 'src') {
        if (parts.length === 2) {
            return 'src/';
        }
        if (parts[1] === 'endpoints' && parts[2] === 'backends' && parts.length >= 4) {
            return 'src/endpoints/backends/';
        }
        return `src/${parts[1]}/`;
    }

    if (parts[0] === 'scripts') {
        return 'scripts/';
    }

    if (parts[0] === 'public') {
        if (parts.length === 2) {
            return 'public/';
        }
        if (parts[1] === 'scripts') {
            if (parts.length === 3) {
                return 'public/scripts/';
            }
            if (parts[2] === 'extensions') {
                if (parts.length === 4) {
                    return 'public/scripts/extensions/';
                }
                return `public/scripts/extensions/${parts[3]}/`;
            }
            return `public/scripts/${parts[2]}/`;
        }
        return `public/${parts[1]}/`;
    }

    return `${parts.slice(0, -1).join('/')}/`;
}

function createEmptyBucket() {
    return {
        files: 0,
        coveredFiles: 0,
        lines: { covered: 0, total: 0, pct: 100 },
        statements: { covered: 0, total: 0, pct: 100 },
        functions: { covered: 0, total: 0, pct: 100 },
        branches: { covered: 0, total: 0, pct: 100 },
    };
}

function addMetric(target, source) {
    const covered = Number(source?.covered ?? 0);
    const total = Number(source?.total ?? 0);
    if (Number.isFinite(covered) && covered > 0) {
        target.covered += covered;
    }
    if (Number.isFinite(total) && total > 0) {
        target.total += total;
    }
}

function finalizeBucket(bucket) {
    for (const metric of ['lines', 'statements', 'functions', 'branches']) {
        bucket[metric].pct = computePercent(bucket[metric].covered, bucket[metric].total);
    }
    return bucket;
}

/**
 * Aggregates Jest's `coverage-summary.json` into per-folder coverage totals.
 */
export function aggregateCoverageSummary(summary, { repoRoot = defaultRepoRoot } = {}) {
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
        throw new Error('Invalid Jest coverage-summary.json payload');
    }

    const buckets = new Map();
    const total = createEmptyBucket();

    for (const [fileKey, entry] of Object.entries(summary)) {
        if (fileKey === 'total' || !entry || typeof entry !== 'object') {
            continue;
        }
        const relativePath = normalizeCoverageFilePath(fileKey, repoRoot);
        if (!relativePath) {
            continue;
        }
        const folder = folderForFile(relativePath);
        if (!folder) {
            continue;
        }

        const bucket = buckets.get(folder) ?? createEmptyBucket();
        bucket.files += 1;
        total.files += 1;
        if (Number(entry.lines?.covered ?? 0) > 0) {
            bucket.coveredFiles += 1;
            total.coveredFiles += 1;
        }

        for (const metric of ['lines', 'statements', 'functions', 'branches']) {
            addMetric(bucket[metric], entry[metric]);
            addMetric(total[metric], entry[metric]);
        }

        buckets.set(folder, bucket);
    }

    const folders = {};
    for (const folder of [...buckets.keys()].sort((left, right) => left.localeCompare(right))) {
        folders[folder] = finalizeBucket(buckets.get(folder));
    }

    return {
        version: baselineVersion,
        folders,
        total: finalizeBucket(total),
    };
}

export function buildBaseline(aggregated, { tolerance = 0 } = {}) {
    const folders = {};
    for (const folder of Object.keys(aggregated.folders).sort((left, right) => left.localeCompare(right))) {
        folders[folder] = aggregated.folders[folder].lines.pct;
    }

    return {
        version: baselineVersion,
        metric: 'lines',
        tolerance,
        folders,
    };
}

export function validateBaseline(baseline) {
    const valid = Boolean(
        baseline
        && typeof baseline === 'object'
        && !Array.isArray(baseline)
        && baseline.version === baselineVersion
        && baseline.metric === 'lines'
        && typeof baseline.tolerance === 'number'
        && Number.isFinite(baseline.tolerance)
        && baseline.tolerance >= 0
        && baseline.tolerance <= 100
        && baseline.folders
        && typeof baseline.folders === 'object'
        && !Array.isArray(baseline.folders)
        && Object.entries(baseline.folders).every(([folder, pct]) => (
            typeof folder === 'string'
            && folder.endsWith('/')
            && typeof pct === 'number'
            && Number.isFinite(pct)
            && pct >= 0
            && pct <= 100
        )),
    );

    if (!valid) {
        throw new Error('Invalid unit coverage baseline');
    }

    return baseline;
}

/**
 * Compares aggregated per-folder coverage against a validated baseline.
 */
export function compareToBaseline(aggregated, baseline, { tolerance } = {}) {
    validateBaseline(baseline);
    const effectiveTolerance = tolerance === undefined ? baseline.tolerance : tolerance;
    if (!Number.isFinite(effectiveTolerance) || effectiveTolerance < 0 || effectiveTolerance > 100) {
        throw new Error(`Invalid coverage tolerance: ${effectiveTolerance}`);
    }

    const allFolders = [...new Set([
        ...Object.keys(baseline.folders),
        ...Object.keys(aggregated.folders),
    ])].sort((left, right) => left.localeCompare(right));

    const rows = [];
    const drops = [];
    const improvements = [];
    const missing = [];
    const added = [];

    for (const folder of allFolders) {
        const hasBaseline = Object.hasOwn(baseline.folders, folder);
        const bucket = aggregated.folders[folder];

        if (hasBaseline && !bucket) {
            const baselinePct = baseline.folders[folder];
            const row = {
                folder,
                files: 0,
                coveredFiles: 0,
                coveredLines: 0,
                totalLines: 0,
                baseline: baselinePct,
                current: null,
                delta: null,
                status: 'MISSING',
            };
            rows.push(row);
            missing.push(row);
            continue;
        }

        const currentPct = bucket.lines.pct;

        if (!hasBaseline) {
            const row = {
                folder,
                files: bucket.files,
                coveredFiles: bucket.coveredFiles,
                coveredLines: bucket.lines.covered,
                totalLines: bucket.lines.total,
                baseline: null,
                current: currentPct,
                delta: null,
                status: 'NEW',
            };
            rows.push(row);
            added.push(row);
            continue;
        }

        const baselinePct = baseline.folders[folder];
        const delta = roundPercent(currentPct - baselinePct);
        let status = 'OK';
        if (currentPct + effectiveTolerance < baselinePct) {
            status = 'DROP';
        } else if (currentPct > baselinePct) {
            status = 'UP';
        }

        const row = {
            folder,
            files: bucket.files,
            coveredFiles: bucket.coveredFiles,
            coveredLines: bucket.lines.covered,
            totalLines: bucket.lines.total,
            baseline: baselinePct,
            current: currentPct,
            delta,
            status,
        };
        rows.push(row);
        if (status === 'DROP') {
            drops.push(row);
        } else if (status === 'UP') {
            improvements.push(row);
        }
    }

    return {
        ok: drops.length === 0 && missing.length === 0,
        tolerance: effectiveTolerance,
        rows,
        drops,
        improvements,
        missing,
        added,
        total: aggregated.total,
    };
}

/**
 * Finds folders whose baseline would drop or disappear if `next` replaced `previous`.
 */
export function findBaselineDrops(previous, next) {
    validateBaseline(previous);
    validateBaseline(next);
    const regressions = [];

    for (const [folder, before] of Object.entries(previous.folders)) {
        if (!Object.hasOwn(next.folders, folder)) {
            regressions.push({ folder, before, after: null, missing: true });
            continue;
        }
        const after = next.folders[folder];
        if (after < before) {
            regressions.push({ folder, before, after, missing: false });
        }
    }

    return regressions;
}

function formatPct(value) {
    return value === null ? '-' : `${value.toFixed(2)}%`;
}

function formatDelta(value) {
    if (value === null) {
        return '-';
    }
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}%`;
}

export function formatConsoleReport(comparison) {
    const folderWidth = Math.max('Folder'.length, ...comparison.rows.map(row => row.folder.length), 'Total'.length);
    const lines = [
        `${'Folder'.padEnd(folderWidth)}  ${'Lines'.padStart(15)}  ${'Baseline'.padStart(8)}  ${'Current'.padStart(8)}  ${'Delta'.padStart(8)}  Status`,
        `${'-'.repeat(folderWidth)}  ${'-'.repeat(15)}  ${'-'.repeat(8)}  ${'-'.repeat(8)}  ${'-'.repeat(8)}  ------`,
    ];

    for (const row of comparison.rows) {
        const lineCounts = row.status === 'MISSING' ? '-' : `${row.coveredLines}/${row.totalLines}`;
        lines.push(
            `${row.folder.padEnd(folderWidth)}  ${lineCounts.padStart(15)}  ${formatPct(row.baseline).padStart(8)}  ${formatPct(row.current).padStart(8)}  ${formatDelta(row.delta).padStart(8)}  ${row.status}`,
        );
    }

    const totalCounts = `${comparison.total.lines.covered}/${comparison.total.lines.total}`;
    lines.push(
        `${'-'.repeat(folderWidth)}  ${'-'.repeat(15)}  ${'-'.repeat(8)}  ${'-'.repeat(8)}  ${'-'.repeat(8)}  ------`,
        `${'Total'.padEnd(folderWidth)}  ${totalCounts.padStart(15)}  ${'-'.padStart(8)}  ${formatPct(comparison.total.lines.pct).padStart(8)}  ${'-'.padStart(8)}  ${comparison.ok ? 'PASS' : 'FAIL'}`,
    );

    if (comparison.drops.length > 0 || comparison.missing.length > 0) {
        lines.push('');
        for (const item of comparison.drops) {
            lines.push(`[DROP] ${item.folder}: ${item.current.toFixed(2)}% < ${item.baseline.toFixed(2)}% (${formatDelta(item.delta)}, ${item.coveredLines}/${item.totalLines} lines)`);
        }
        for (const item of comparison.missing) {
            lines.push(`[MISSING] ${item.folder}: tracked in baseline (${item.baseline.toFixed(2)}%) but absent from coverage report`);
        }
    } else if (comparison.improvements.length > 0 || comparison.added.length > 0) {
        lines.push('');
        lines.push(`Coverage passed (${comparison.improvements.length} folder(s) improved, ${comparison.added.length} new folder(s)). Raise the baseline deliberately with: ${UPDATE_COMMAND}`);
    } else {
        lines.push('');
        lines.push('Unit coverage matches the baseline across all folders.');
    }

    return lines.join('\n');
}

export function formatMarkdownSummary(comparison) {
    const lines = [
        '### Unit Test Coverage (Per-Folder Ratchet)',
        '',
        '| Folder | Lines | Baseline | Current | Delta | Status |',
        '|---|---:|---:|---:|---:|---|',
    ];

    for (const row of comparison.rows) {
        const lineCounts = row.status === 'MISSING' ? '-' : `${row.coveredLines} / ${row.totalLines}`;
        lines.push(`| \`${row.folder}\` | ${lineCounts} | ${formatPct(row.baseline)} | ${formatPct(row.current)} | ${formatDelta(row.delta)} | ${row.status} |`);
    }

    lines.push(
        `| **Total** | **${comparison.total.lines.covered} / ${comparison.total.lines.total}** | - | **${formatPct(comparison.total.lines.pct)}** | - | **${comparison.ok ? 'PASS' : 'FAIL'}** |`,
        '',
    );

    if (!comparison.ok) {
        const problems = [
            ...comparison.drops.map(item => `- \`${item.folder}\` dropped from ${item.baseline.toFixed(2)}% to ${item.current.toFixed(2)}% (${formatDelta(item.delta)}).`),
            ...comparison.missing.map(item => `- \`${item.folder}\` is in the baseline (${item.baseline.toFixed(2)}%) but missing from the coverage report.`),
        ];
        lines.push('**Coverage ratchet failed:**', ...problems);
    } else if (comparison.improvements.length > 0 || comparison.added.length > 0) {
        lines.push(`Coverage ratchet passed (${comparison.improvements.length} folder(s) improved, ${comparison.added.length} new folder(s)). To raise the baseline on purpose, run \`${UPDATE_COMMAND}\`.`);
    } else {
        lines.push('Coverage ratchet passed (all folders match the baseline).');
    }

    return lines.join('\n');
}

export function parseArguments(argumentsList) {
    const options = {
        json: false,
        markdown: false,
        updateBaseline: false,
        allowDrop: false,
    };

    for (let index = 0; index < argumentsList.length; index++) {
        const argument = argumentsList[index];
        if (argument === '--json') {
            options.json = true;
        } else if (argument === '--markdown') {
            options.markdown = true;
        } else if (argument === '--update-baseline') {
            options.updateBaseline = true;
        } else if (argument === '--allow-drop') {
            options.allowDrop = true;
        } else if (['--report', '--baseline', '--root', '--summary-file'].includes(argument)) {
            const value = argumentsList[++index];
            if (!value || value.startsWith('--')) {
                throw new Error(`Missing value for ${argument}`);
            }
            const key = argument === '--summary-file' ? 'summaryFile' : argument.slice(2);
            options[key] = path.resolve(value);
        } else if (argument === '--tolerance') {
            const value = argumentsList[++index];
            if (!value || value.startsWith('--')) {
                throw new Error('Missing value for --tolerance');
            }
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
                throw new Error(`Invalid value for --tolerance: ${value}`);
            }
            options.tolerance = parsed;
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }

    return options;
}

function appendStepSummary(summaryPath, markdown) {
    if (!summaryPath) {
        return;
    }
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    fs.appendFileSync(summaryPath, `${markdown}\n\n`, 'utf8');
}

function runCli() {
    const options = parseArguments(process.argv.slice(2));
    const repoRoot = options.root ?? defaultRepoRoot;
    const reportPath = options.report ?? (options.root ? path.join(repoRoot, 'coverage', 'unit', 'coverage-summary.json') : defaultReportPath);
    const baselinePath = options.baseline ?? (options.root ? path.join(repoRoot, 'scripts', 'unit-coverage-baseline.json') : defaultBaselinePath);

    if (!fs.existsSync(reportPath)) {
        throw new Error(`Coverage summary not found at ${reportPath}. Run unit tests with --coverage --coverageProvider=v8 --coverageReporters=json-summary first.`);
    }

    const summary = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const aggregated = aggregateCoverageSummary(summary, { repoRoot });
    if (Object.keys(aggregated.folders).length === 0) {
        throw new Error(`No source files under ${repoRoot} were found in ${reportPath}.`);
    }

    if (options.updateBaseline) {
        const nextBaseline = buildBaseline(aggregated, { tolerance: options.tolerance ?? 0 });
        if (!options.allowDrop && fs.existsSync(baselinePath)) {
            const previousBaseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
            const regressions = findBaselineDrops(previousBaseline, nextBaseline);
            if (regressions.length > 0) {
                for (const item of regressions) {
                    if (item.missing) {
                        console.error(`[MISSING] ${item.folder}: ${item.before.toFixed(2)}% -> removed`);
                    } else {
                        console.error(`[DROP] ${item.folder}: ${item.before.toFixed(2)}% -> ${item.after.toFixed(2)}%`);
                    }
                }
                console.error('Baseline was not written. Fix the coverage drop, or pass --allow-drop when lowering the floor on purpose.');
                process.exitCode = 1;
                return;
            }
        }
        fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
        fs.writeFileSync(baselinePath, `${JSON.stringify(nextBaseline, null, 4)}\n`, 'utf8');
        console.log(`Wrote ${toPosix(path.relative(repoRoot, baselinePath))} (${Object.keys(nextBaseline.folders).length} folders, total ${aggregated.total.lines.pct.toFixed(2)}%).`);
        return;
    }

    if (!fs.existsSync(baselinePath)) {
        throw new Error(`Unit coverage baseline not found at ${baselinePath}. Create it with: ${UPDATE_COMMAND}`);
    }

    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const comparison = compareToBaseline(aggregated, baseline, { tolerance: options.tolerance });

    if (options.json) {
        console.log(JSON.stringify(comparison, null, 4));
    } else if (options.markdown) {
        console.log(formatMarkdownSummary(comparison));
    } else {
        console.log(formatConsoleReport(comparison));
    }

    const summaryTarget = options.summaryFile ?? process.env.GITHUB_STEP_SUMMARY;
    if (summaryTarget) {
        appendStepSummary(summaryTarget, formatMarkdownSummary(comparison));
    }

    if (!comparison.ok) {
        process.exitCode = 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        runCli();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
