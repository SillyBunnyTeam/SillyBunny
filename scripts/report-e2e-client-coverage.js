#!/usr/bin/env node

// Aggregates raw Chromium V8 JS coverage files written during an e2e run into a per-folder and
// per-module report showing which browser modules under public/ the e2e suite reached.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePercent, folderForFile } from './check-unit-coverage.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDirectory, '..');

export const E2E_COVERAGE_DIR_VARIABLE = 'SILLYBUNNY_E2E_COVERAGE_DIR';
export const defaultRawDir = path.join(defaultRepoRoot, 'coverage', 'e2e-raw');
export const defaultJsonOutPath = path.join(defaultRepoRoot, 'coverage', 'e2e-client-coverage.json');
export const defaultMarkdownOutPath = path.join(defaultRepoRoot, 'coverage', 'e2e-client-coverage.md');

// Matches the vendored browser exclusions in .eslintrc.cjs and tests/jest.config.json.
const EXCLUDED_CLIENT_PATTERNS = [
    /^public\/lib\//,
    /^public\/scripts\/extensions\/quick-image-gen\//,
    /^public\/scripts\/extensions\/third-party\//,
    /^public\/scripts\/extensions\/quick-reply\/lib\//,
    /^public\/scripts\/extensions\/tts\/lib\//,
    /^public\/scripts\/extensions\/sillybunny-debugger\/lib\/eruda\.js$/,
    /\.min\.js$/,
];

function toPosix(value) {
    return String(value).replace(/\\/g, '/');
}

export function isExcludedClientModule(relativePath) {
    const normalized = toPosix(relativePath).replace(/^\.\//, '');
    return EXCLUDED_CLIENT_PATTERNS.some(pattern => pattern.test(normalized));
}

export function mergeIntervals(intervals) {
    const valid = (intervals ?? [])
        .filter(pair => Array.isArray(pair) && pair.length >= 2
            && Number.isFinite(pair[0]) && Number.isFinite(pair[1]) && pair[1] > pair[0])
        .map(([start, end]) => [Math.max(0, Math.floor(start)), Math.floor(end)])
        .filter(([start, end]) => end > start)
        .sort((left, right) => left[0] - right[0] || left[1] - right[1]);

    if (valid.length === 0) {
        return [];
    }

    const merged = [valid[0]];
    for (let index = 1; index < valid.length; index++) {
        const [start, end] = valid[index];
        const previous = merged[merged.length - 1];
        if (start <= previous[1]) {
            if (end > previous[1]) {
                previous[1] = end;
            }
        } else {
            merged.push([start, end]);
        }
    }

    return merged;
}

export function countCoveredBytes(intervals) {
    let total = 0;
    for (const [start, end] of mergeIntervals(intervals)) {
        total += end - start;
    }
    return total;
}

/**
 * Maps a browser script URL or pathname to its repository-relative `public/...` path.
 * Returns `null` for non-client, traversal or vendored/excluded paths.
 */
export function mapClientUrlToRepoPath(urlOrPath) {
    if (typeof urlOrPath !== 'string' || !urlOrPath.trim()) {
        return null;
    }

    let pathname;
    const trimmed = urlOrPath.trim();
    if (trimmed.startsWith('/')) {
        pathname = trimmed.split(/[?#]/)[0];
    } else if (/^https?:\/\//i.test(trimmed)) {
        try {
            pathname = new URL(trimmed).pathname;
        } catch {
            return null;
        }
    } else {
        return null;
    }

    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return null;
    }

    const normalized = path.posix.normalize(decoded.replace(/\\/g, '/'));
    if (!normalized.startsWith('/') || normalized.includes('/../') || normalized.endsWith('/..')) {
        return null;
    }

    let repoPath = null;
    if (normalized === '/script.js') {
        repoPath = 'public/script.js';
    } else if (normalized.startsWith('/scripts/') && normalized.endsWith('.js')) {
        repoPath = `public${normalized}`;
    }

    if (!repoPath || isExcludedClientModule(repoPath)) {
        return null;
    }

    return repoPath;
}

function walkJsFiles(directory, repoRoot, files) {
    if (!fs.existsSync(directory)) {
        return;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'node_modules') {
                walkJsFiles(absolute, repoRoot, files);
            }
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            const relative = toPosix(path.relative(repoRoot, absolute));
            if (!isExcludedClientModule(relative)) {
                files.push(relative);
            }
        }
    }
}

/**
 * Lists all first-party browser JS modules under `public/script.js` and `public/scripts/**`.
 */
export function listClientModules(repoRoot = defaultRepoRoot) {
    const files = [];
    const rootScript = path.join(repoRoot, 'public', 'script.js');
    if (fs.existsSync(rootScript) && fs.statSync(rootScript).isFile()) {
        files.push('public/script.js');
    }
    walkJsFiles(path.join(repoRoot, 'public', 'scripts'), repoRoot, files);
    return files.sort((left, right) => left.localeCompare(right));
}

/**
 * Reads all worker coverage JSON files from `rawDir`.
 */
export function readRawCoverageFiles(rawDir) {
    if (!rawDir || !fs.existsSync(rawDir)) {
        return [];
    }
    const entries = fs.readdirSync(rawDir, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(entry => entry.name)
        .sort((left, right) => left.localeCompare(right));

    return entries.map(name => ({
        file: name,
        data: JSON.parse(fs.readFileSync(path.join(rawDir, name), 'utf8')),
    }));
}

/**
 * Aggregates worker coverage records against the repository's browser JS module inventory.
 */
export function aggregateE2eClientCoverage({ repoRoot = defaultRepoRoot, rawRecords = [], clientModules } = {}) {
    const modulesList = clientModules ? [...clientModules].sort((left, right) => left.localeCompare(right)) : listClientModules(repoRoot);
    const knownModules = new Set(modulesList);
    const mergedByModule = new Map();

    for (const record of rawRecords) {
        const scripts = record?.data?.scripts ?? record?.scripts;
        if (!scripts || typeof scripts !== 'object') {
            continue;
        }
        for (const [urlOrPath, stats] of Object.entries(scripts)) {
            const repoPath = mapClientUrlToRepoPath(urlOrPath);
            if (!repoPath || !knownModules.has(repoPath)) {
                continue;
            }
            const totalBytes = Number(stats?.totalBytes ?? 0);
            const hits = Number(stats?.hits ?? 0);
            const ranges = Array.isArray(stats?.coveredRanges) ? stats.coveredRanges : [];
            const existing = mergedByModule.get(repoPath);
            if (!existing) {
                mergedByModule.set(repoPath, {
                    totalBytes: Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0,
                    coveredRanges: mergeIntervals(ranges),
                    hits: Number.isFinite(hits) && hits > 0 ? hits : 1,
                });
            } else {
                if (Number.isFinite(totalBytes) && totalBytes > existing.totalBytes) {
                    existing.totalBytes = totalBytes;
                }
                existing.coveredRanges = mergeIntervals([...existing.coveredRanges, ...ranges]);
                existing.hits += Number.isFinite(hits) && hits > 0 ? hits : 1;
            }
        }
    }

    const foldersMap = new Map();
    const modules = {};
    const unreached = [];

    let totalReachedModules = 0;
    let totalCoveredBytes = 0;
    let totalMeasuredBytes = 0;

    for (const modulePath of modulesList) {
        const folder = folderForFile(modulePath) ?? 'public/';
        const folderBucket = foldersMap.get(folder) ?? {
            folder,
            totalModules: 0,
            reachedModules: 0,
            unreachedModules: [],
            coveredBytes: 0,
            measuredBytes: 0,
        };
        folderBucket.totalModules += 1;

        const observed = mergedByModule.get(modulePath);
        if (observed) {
            const coveredBytes = countCoveredBytes(observed.coveredRanges);
            const totalBytes = Math.max(observed.totalBytes, coveredBytes);
            const bytePct = totalBytes > 0 ? computePercent(coveredBytes, totalBytes) : 0;
            modules[modulePath] = {
                folder,
                reached: true,
                hits: observed.hits,
                coveredBytes,
                totalBytes,
                bytePct,
            };
            folderBucket.reachedModules += 1;
            folderBucket.coveredBytes += coveredBytes;
            folderBucket.measuredBytes += totalBytes;
            totalReachedModules += 1;
            totalCoveredBytes += coveredBytes;
            totalMeasuredBytes += totalBytes;
        } else {
            modules[modulePath] = {
                folder,
                reached: false,
                hits: 0,
                coveredBytes: 0,
                totalBytes: 0,
                bytePct: 0,
            };
            folderBucket.unreachedModules.push(modulePath);
            unreached.push(modulePath);
        }

        foldersMap.set(folder, folderBucket);
    }

    const folders = [...foldersMap.values()]
        .sort((left, right) => left.folder.localeCompare(right.folder))
        .map(bucket => ({
            folder: bucket.folder,
            reachedModules: bucket.reachedModules,
            totalModules: bucket.totalModules,
            reachPct: computePercent(bucket.reachedModules, bucket.totalModules),
            coveredBytes: bucket.coveredBytes,
            measuredBytes: bucket.measuredBytes,
            bytePct: bucket.measuredBytes > 0 ? computePercent(bucket.coveredBytes, bucket.measuredBytes) : 0,
            unreachedModules: bucket.unreachedModules,
        }));

    return {
        version: 1,
        workerFiles: rawRecords.length,
        totals: {
            reachedModules: totalReachedModules,
            totalModules: modulesList.length,
            reachPct: computePercent(totalReachedModules, modulesList.length),
            coveredBytes: totalCoveredBytes,
            measuredBytes: totalMeasuredBytes,
            bytePct: totalMeasuredBytes > 0 ? computePercent(totalCoveredBytes, totalMeasuredBytes) : 0,
        },
        folders,
        unreached,
        modules,
    };
}

function formatPct(value) {
    return `${value.toFixed(2)}%`;
}

export function formatConsoleReport(report) {
    const folderWidth = Math.max('Folder'.length, ...report.folders.map(item => item.folder.length), 'Total'.length);
    const lines = [
        `${'Folder'.padEnd(folderWidth)}  ${'Modules'.padStart(11)}  ${'Reach %'.padStart(8)}  ${'Exec Bytes %'.padStart(12)}`,
        `${'-'.repeat(folderWidth)}  ${'-'.repeat(11)}  ${'-'.repeat(8)}  ${'-'.repeat(12)}`,
    ];

    for (const item of report.folders) {
        const modulesLabel = `${item.reachedModules}/${item.totalModules}`;
        const byteLabel = item.reachedModules > 0 ? formatPct(item.bytePct) : '-';
        lines.push(`${item.folder.padEnd(folderWidth)}  ${modulesLabel.padStart(11)}  ${formatPct(item.reachPct).padStart(8)}  ${byteLabel.padStart(12)}`);
    }

    const totalModulesLabel = `${report.totals.reachedModules}/${report.totals.totalModules}`;
    const totalByteLabel = report.totals.reachedModules > 0 ? formatPct(report.totals.bytePct) : '-';
    lines.push(
        `${'-'.repeat(folderWidth)}  ${'-'.repeat(11)}  ${'-'.repeat(8)}  ${'-'.repeat(12)}`,
        `${'Total'.padEnd(folderWidth)}  ${totalModulesLabel.padStart(11)}  ${formatPct(report.totals.reachPct).padStart(8)}  ${totalByteLabel.padStart(12)}`,
        '',
        `Worker coverage files merged: ${report.workerFiles}. Unreached client modules: ${report.unreached.length}.`,
    );

    return lines.join('\n');
}

export function formatMarkdownSummary(report) {
    const lines = [
        '### Nightly E2E Client Module Coverage',
        '',
        `Browser modules reached: **${report.totals.reachedModules} / ${report.totals.totalModules} (${formatPct(report.totals.reachPct)})**`
            + ` across ${report.workerFiles} worker coverage file(s)`
            + (report.totals.measuredBytes > 0 ? ` (${formatPct(report.totals.bytePct)} executed bytes within reached modules).` : '.'),
        '',
        '| Folder | Reached Modules | Reach % | Executed Bytes % (Reached) |',
        '|---|---:|---:|---:|',
    ];

    for (const item of report.folders) {
        const byteLabel = item.reachedModules > 0 ? formatPct(item.bytePct) : '-';
        lines.push(`| \`${item.folder}\` | ${item.reachedModules} / ${item.totalModules} | ${formatPct(item.reachPct)} | ${byteLabel} |`);
    }

    const totalByteLabel = report.totals.reachedModules > 0 ? formatPct(report.totals.bytePct) : '-';
    lines.push(`| **Total** | **${report.totals.reachedModules} / ${report.totals.totalModules}** | **${formatPct(report.totals.reachPct)}** | **${totalByteLabel}** |`);

    if (report.unreached.length > 0) {
        lines.push(
            '',
            `<details><summary>Unreached client modules (${report.unreached.length})</summary>`,
            '',
        );
        for (const item of report.folders) {
            if (item.unreachedModules.length === 0) {
                continue;
            }
            lines.push(`- \`${item.folder}\` (${item.unreachedModules.length}): ${item.unreachedModules.map(file => `\`${path.posix.basename(file)}\``).join(', ')}`);
        }
        lines.push('', '</details>');
    }

    return lines.join('\n');
}

export function parseArguments(argumentsList) {
    const options = {
        json: false,
        markdown: false,
        requireData: false,
    };

    for (let index = 0; index < argumentsList.length; index++) {
        const argument = argumentsList[index];
        if (argument === '--json') {
            options.json = true;
        } else if (argument === '--markdown') {
            options.markdown = true;
        } else if (argument === '--require-data') {
            options.requireData = true;
        } else if (['--dir', '--root', '--json-out', '--markdown-out', '--summary-file'].includes(argument)) {
            const value = argumentsList[++index];
            if (!value || value.startsWith('--')) {
                throw new Error(`Missing value for ${argument}`);
            }
            const keyMap = {
                '--dir': 'dir',
                '--root': 'root',
                '--json-out': 'jsonOut',
                '--markdown-out': 'markdownOut',
                '--summary-file': 'summaryFile',
            };
            options[keyMap[argument]] = path.resolve(value);
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }

    return options;
}

function writeOutputFile(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function runCli() {
    const options = parseArguments(process.argv.slice(2));
    const repoRoot = options.root ?? defaultRepoRoot;
    const rawDir = options.dir
        ?? (process.env[E2E_COVERAGE_DIR_VARIABLE] ? path.resolve(process.env[E2E_COVERAGE_DIR_VARIABLE]) : null)
        ?? (options.root ? path.join(repoRoot, 'coverage', 'e2e-raw') : defaultRawDir);

    const rawRecords = readRawCoverageFiles(rawDir);
    if (options.requireData && rawRecords.length === 0) {
        throw new Error(`No raw e2e client coverage files found in ${rawDir}.`);
    }

    const report = aggregateE2eClientCoverage({ repoRoot, rawRecords });
    const markdown = formatMarkdownSummary(report);

    if (options.jsonOut) {
        writeOutputFile(options.jsonOut, `${JSON.stringify(report, null, 4)}\n`);
    }
    if (options.markdownOut) {
        writeOutputFile(options.markdownOut, `${markdown}\n`);
    }

    const summaryTarget = options.summaryFile ?? process.env.GITHUB_STEP_SUMMARY;
    if (summaryTarget) {
        fs.mkdirSync(path.dirname(summaryTarget), { recursive: true });
        fs.appendFileSync(summaryTarget, `${markdown}\n\n`, 'utf8');
    }

    if (options.json) {
        console.log(JSON.stringify(report, null, 4));
    } else if (options.markdown) {
        console.log(markdown);
    } else {
        console.log(formatConsoleReport(report));
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
