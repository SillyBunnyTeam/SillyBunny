#!/usr/bin/env node

// Runs TypeScript typechecking for server code against a per-(file, TS code) baseline.
// Keying by (file, code) count prevents line-number shifts from causing false failures
// while catching any new error or new error code in any server file.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDirectory, '..');

export const BASELINE_VERSION = 1;
export const GLOBAL_DIAGNOSTIC_FILE = '<tsconfig>';
export const UPDATE_COMMAND = 'node scripts/check-server-typecheck.js --update-baseline';
export const defaultConfigPath = path.join(defaultRepoRoot, 'tsconfig.server.json');
export const defaultBaselinePath = path.join(scriptDirectory, 'server-typecheck-baseline.json');

const ROOT_SERVER_FILES = new Set([
    'index.d.ts',
    'plugins.js',
    'recover.js',
    'server.js',
]);

const PAREN_DIAGNOSTIC_PATTERN = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
const COLON_DIAGNOSTIC_PATTERN = /^(.+?):(\d+):(\d+)\s+-\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
const GLOBAL_DIAGNOSTIC_PATTERN = /^(error|warning)\s+(TS\d+):\s+(.*)$/;
const TS_CODE_PATTERN = /^TS\d+$/;
const MAX_TSC_BUFFER_BYTES = 64 * 1024 * 1024;

function compareCodeUnits(left, right) {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalizes a diagnostic file path to a POSIX relative path from `repoRoot`.
 * @param {string} rawPath
 * @param {string} [repoRoot]
 * @returns {string}
 */
export function normalizeDiagnosticPath(rawPath, repoRoot = defaultRepoRoot) {
    const trimmed = String(rawPath).trim();
    if (!trimmed || trimmed === GLOBAL_DIAGNOSTIC_FILE) {
        return GLOBAL_DIAGNOSTIC_FILE;
    }

    const slashPath = trimmed.replace(/\\/g, '/');
    const isWindowsAbsolute = /^[A-Za-z]:\//.test(slashPath);
    const isPosixAbsolute = slashPath.startsWith('/');

    if (isWindowsAbsolute || isPosixAbsolute) {
        const normalizedRoot = String(repoRoot).replace(/\\/g, '/').replace(/\/+$/, '');
        const rootPrefix = `${normalizedRoot}/`;
        if (isWindowsAbsolute) {
            if (slashPath.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
                return slashPath.slice(rootPrefix.length).replace(/^(?:\.\/)+/, '');
            }
        } else if (slashPath.startsWith(rootPrefix)) {
            return slashPath.slice(rootPrefix.length).replace(/^(?:\.\/)+/, '');
        }
        return path.relative(repoRoot, trimmed).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
    }

    return slashPath.replace(/^(?:\.\/)+/, '');
}

/**
 * Returns true when a normalized diagnostic path belongs to the ratcheted server surface.
 * Transitive imports into `public/**` (for example JSDoc type references) are outside server scope.
 * @param {string} normalizedPath
 * @returns {boolean}
 */
export function isServerScopeFile(normalizedPath) {
    if (normalizedPath === GLOBAL_DIAGNOSTIC_FILE) {
        return true;
    }
    if (ROOT_SERVER_FILES.has(normalizedPath)) {
        return true;
    }
    return normalizedPath.startsWith('src/') && !normalizedPath.startsWith('src/tokenizers/');
}

/**
 * Parses `tsc --noEmit --pretty false` output into structured diagnostics.
 * Continuation lines indented below a diagnostic are attached to its message.
 * @param {string} output
 * @param {{ repoRoot?: string }} [options]
 * @returns {Array<{ file: string, line: number | null, column: number | null, severity: string, code: string, message: string }>}
 */
export function parseTscDiagnostics(output, { repoRoot = defaultRepoRoot } = {}) {
    const diagnostics = [];
    const lines = String(output ?? '').split(/\r?\n/);
    let current = null;

    for (const rawLine of lines) {
        const parenMatch = PAREN_DIAGNOSTIC_PATTERN.exec(rawLine);
        if (parenMatch) {
            current = {
                file: normalizeDiagnosticPath(parenMatch[1], repoRoot),
                line: Number(parenMatch[2]),
                column: Number(parenMatch[3]),
                severity: parenMatch[4],
                code: parenMatch[5],
                message: parenMatch[6].trimEnd(),
            };
            diagnostics.push(current);
            continue;
        }

        const colonMatch = COLON_DIAGNOSTIC_PATTERN.exec(rawLine);
        if (colonMatch) {
            current = {
                file: normalizeDiagnosticPath(colonMatch[1], repoRoot),
                line: Number(colonMatch[2]),
                column: Number(colonMatch[3]),
                severity: colonMatch[4],
                code: colonMatch[5],
                message: colonMatch[6].trimEnd(),
            };
            diagnostics.push(current);
            continue;
        }

        const globalMatch = GLOBAL_DIAGNOSTIC_PATTERN.exec(rawLine);
        if (globalMatch) {
            current = {
                file: GLOBAL_DIAGNOSTIC_FILE,
                line: null,
                column: null,
                severity: globalMatch[1],
                code: globalMatch[2],
                message: globalMatch[3].trimEnd(),
            };
            diagnostics.push(current);
            continue;
        }

        if (current && /^\s+\S/.test(rawLine)) {
            current.message += `\n${rawLine.trimEnd()}`;
            continue;
        }

        current = null;
    }

    return diagnostics;
}

/**
 * Filters parsed diagnostics to errors within the server scope.
 * @param {Array<{ file: string, line: number | null, column: number | null, severity: string, code: string, message: string }>} diagnostics
 * @param {(file: string) => boolean} [includeFile]
 */
export function filterServerDiagnostics(diagnostics, includeFile = isServerScopeFile) {
    return diagnostics.filter(diagnostic => diagnostic.severity === 'error' && includeFile(diagnostic.file));
}

/**
 * Builds a deterministic baseline object from server diagnostics.
 * @param {Array<{ file: string, code: string }>} diagnostics
 */
export function buildBaseline(diagnostics) {
    const countsByFile = new Map();

    for (const diagnostic of diagnostics) {
        let codeCounts = countsByFile.get(diagnostic.file);
        if (!codeCounts) {
            codeCounts = new Map();
            countsByFile.set(diagnostic.file, codeCounts);
        }
        codeCounts.set(diagnostic.code, (codeCounts.get(diagnostic.code) ?? 0) + 1);
    }

    const files = {};
    let totalErrors = 0;

    for (const file of [...countsByFile.keys()].sort(compareCodeUnits)) {
        const codeCounts = countsByFile.get(file);
        const sortedCodes = {};
        for (const code of [...codeCounts.keys()].sort(compareCodeUnits)) {
            const count = codeCounts.get(code);
            sortedCodes[code] = count;
            totalErrors += count;
        }
        files[file] = sortedCodes;
    }

    return {
        version: BASELINE_VERSION,
        totalErrors,
        files,
    };
}

/**
 * Validates a parsed baseline JSON object.
 * @param {unknown} baseline
 */
export function validateBaseline(baseline) {
    if (!isPlainObject(baseline) || baseline.version !== BASELINE_VERSION || !isPlainObject(baseline.files)) {
        throw new Error('Invalid server typecheck baseline: expected { version: 1, totalErrors, files }.');
    }

    let computedTotal = 0;
    for (const [file, codeCounts] of Object.entries(baseline.files)) {
        if (!file || file.includes('\\') || file.startsWith('./') || !isPlainObject(codeCounts)) {
            throw new Error(`Invalid server typecheck baseline entry for file "${file}".`);
        }

        const codes = Object.entries(codeCounts);
        if (codes.length === 0) {
            throw new Error(`Invalid server typecheck baseline: "${file}" has no error codes.`);
        }

        for (const [code, count] of codes) {
            if (!TS_CODE_PATTERN.test(code) || !Number.isSafeInteger(count) || count <= 0) {
                throw new Error(`Invalid server typecheck baseline count for ${file} ${code}.`);
            }
            computedTotal += count;
        }
    }

    if (!Number.isSafeInteger(baseline.totalErrors) || baseline.totalErrors !== computedTotal) {
        throw new Error(`Invalid server typecheck baseline totalErrors: expected ${computedTotal}, got ${baseline.totalErrors}.`);
    }

    return baseline;
}

/**
 * Compares server diagnostics against a validated baseline.
 * @param {Array<{ file: string, line: number | null, column: number | null, severity: string, code: string, message: string }>} diagnostics
 * @param {object} baseline
 */
export function compareDiagnosticsToBaseline(diagnostics, baseline) {
    const validated = validateBaseline(baseline);
    const grouped = new Map();

    for (const diagnostic of diagnostics) {
        let byCode = grouped.get(diagnostic.file);
        if (!byCode) {
            byCode = new Map();
            grouped.set(diagnostic.file, byCode);
        }
        let list = byCode.get(diagnostic.code);
        if (!list) {
            list = [];
            byCode.set(diagnostic.code, list);
        }
        list.push(diagnostic);
    }

    const allFiles = new Set([
        ...Object.keys(validated.files),
        ...grouped.keys(),
    ]);

    const regressions = [];
    const improvements = [];

    for (const file of [...allFiles].sort(compareCodeUnits)) {
        const baselineCodes = validated.files[file] ?? {};
        const currentByCode = grouped.get(file) ?? new Map();
        const allCodes = new Set([
            ...Object.keys(baselineCodes),
            ...currentByCode.keys(),
        ]);

        for (const code of [...allCodes].sort(compareCodeUnits)) {
            const allowed = baselineCodes[code] ?? 0;
            const matchingDiagnostics = currentByCode.get(code) ?? [];
            const current = matchingDiagnostics.length;

            if (current > allowed) {
                regressions.push({
                    file,
                    code,
                    baseline: allowed,
                    current,
                    delta: current - allowed,
                    diagnostics: matchingDiagnostics,
                });
            } else if (current < allowed) {
                improvements.push({
                    file,
                    code,
                    baseline: allowed,
                    current,
                    delta: allowed - current,
                });
            }
        }
    }

    const totalBaseline = validated.totalErrors;
    const totalCurrent = diagnostics.length;

    return {
        totalBaseline,
        totalCurrent,
        delta: totalCurrent - totalBaseline,
        regressions,
        improvements,
        passed: regressions.length === 0,
        canTighten: regressions.length === 0 && totalCurrent < totalBaseline,
    };
}

function resolveTscPath(repoRoot) {
    const repoLocal = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    if (fs.existsSync(repoLocal)) {
        return repoLocal;
    }
    return path.join(defaultRepoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
}

/**
 * Invokes the local TypeScript compiler via `process.execPath` so it runs cleanly on Windows and Linux.
 * @param {{ repoRoot?: string, configPath?: string, tscPath?: string }} [options]
 */
export function runTsc({
    repoRoot = defaultRepoRoot,
    configPath = defaultConfigPath,
    tscPath = resolveTscPath(repoRoot),
} = {}) {
    if (!fs.existsSync(tscPath)) {
        throw new Error(`TypeScript compiler not found at ${tscPath}. Run "npm ci --ignore-scripts" first.`);
    }

    const result = spawnSync(
        process.execPath,
        [tscPath, '--noEmit', '--pretty', 'false', '-p', configPath],
        {
            cwd: repoRoot,
            encoding: 'utf8',
            maxBuffer: MAX_TSC_BUFFER_BYTES,
        },
    );

    if (result.error) {
        throw new Error(`Failed to execute TypeScript compiler: ${result.error.message}`);
    }

    if (result.signal) {
        throw new Error(`TypeScript compiler terminated by signal ${result.signal}.`);
    }

    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const combinedOutput = stderr ? `${stdout}\n${stderr}` : stdout;
    const allDiagnostics = parseTscDiagnostics(combinedOutput, { repoRoot });

    // A non-zero exit with stderr output (such as an internal Debug Failure or OOM crash) or
    // with no parsed diagnostics must fail loudly instead of looking like zero errors.
    if (result.status !== 0 && (stderr.trim().length > 0 || allDiagnostics.length === 0)) {
        const detail = (stderr.trim() || stdout.trim() || '(no output)').split(/\r?\n/).slice(0, 20).join('\n');
        throw new Error(`TypeScript compiler crashed or failed unexpectedly (exit ${result.status}):\n${detail}`);
    }

    return {
        status: result.status ?? 0,
        stdout,
        stderr,
        allDiagnostics,
    };
}

/**
 * Writes an updated baseline file unless regressions exist and `allowIncrease` is false.
 * @param {{ diagnostics: Array<any>, baselinePath: string, allowIncrease?: boolean }} options
 */
export function updateBaseline({ diagnostics, baselinePath, allowIncrease = false }) {
    const next = buildBaseline(diagnostics);
    let previous = null;

    if (fs.existsSync(baselinePath)) {
        previous = validateBaseline(JSON.parse(fs.readFileSync(baselinePath, 'utf8')));
        const comparison = compareDiagnosticsToBaseline(diagnostics, previous);
        if (!allowIncrease && (comparison.regressions.length > 0 || next.totalErrors > previous.totalErrors)) {
            return {
                updated: false,
                refused: true,
                previous,
                next,
                comparison,
            };
        }
    }

    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, `${JSON.stringify(next, null, 4)}\n`, 'utf8');

    return {
        updated: true,
        refused: false,
        previous,
        next,
        comparison: previous ? compareDiagnosticsToBaseline(diagnostics, previous) : null,
    };
}

function formatDiagnosticLine(diagnostic) {
    const location = diagnostic.line !== null && diagnostic.column !== null
        ? `${diagnostic.file}(${diagnostic.line},${diagnostic.column})`
        : diagnostic.file;
    const firstLine = diagnostic.message.split('\n')[0];
    return `  ${location}: error ${diagnostic.code}: ${firstLine}`;
}

export function formatComparisonReport(comparison) {
    const lines = [];

    if (comparison.regressions.length > 0) {
        const addedCount = comparison.regressions.reduce((sum, item) => sum + item.delta, 0);
        lines.push(`Server typecheck failed: ${addedCount} new error(s) across ${comparison.regressions.length} (file, code) bucket(s) (baseline: ${comparison.totalBaseline}, current: ${comparison.totalCurrent}).`);
        for (const regression of comparison.regressions) {
            lines.push(`[REGRESSION] ${regression.file} ${regression.code}: ${regression.baseline} -> ${regression.current} (+${regression.delta})`);
            for (const diagnostic of regression.diagnostics) {
                lines.push(formatDiagnosticLine(diagnostic));
            }
        }
        return lines.join('\n');
    }

    if (comparison.canTighten) {
        const removedCount = comparison.totalBaseline - comparison.totalCurrent;
        lines.push(`Server typecheck passed: errors decreased from ${comparison.totalBaseline} to ${comparison.totalCurrent} (-${removedCount}).`);
        for (const improvement of comparison.improvements) {
            lines.push(`[IMPROVED] ${improvement.file} ${improvement.code}: ${improvement.baseline} -> ${improvement.current} (-${improvement.delta})`);
        }
        lines.push(`Tighten the baseline with: ${UPDATE_COMMAND}`);
        return lines.join('\n');
    }

    lines.push(`Server typecheck passed: ${comparison.totalCurrent} baseline error(s), 0 new error(s).`);
    return lines.join('\n');
}

export function formatStepSummary(comparison) {
    const status = !comparison.passed
        ? 'Failed'
        : comparison.canTighten
            ? 'Passed (baseline can be tightened)'
            : 'Passed';
    const deltaLabel = comparison.delta > 0 ? `+${comparison.delta}` : String(comparison.delta);
    const lines = [
        '## Server Typecheck Ratchet',
        '',
        '| Metric | Value |',
        '| --- | --- |',
        `| Status | ${status} |`,
        `| Baseline errors | ${comparison.totalBaseline} |`,
        `| Current errors | ${comparison.totalCurrent} |`,
        `| Delta | ${deltaLabel} |`,
        `| Regressed buckets | ${comparison.regressions.length} |`,
        `| Improved buckets | ${comparison.improvements.length} |`,
    ];

    if (comparison.regressions.length > 0) {
        lines.push('', '### Regressions', '', '| File | Code | Baseline | Current | Delta |', '| --- | --- | ---: | ---: | ---: |');
        for (const regression of comparison.regressions.slice(0, 30)) {
            lines.push(`| \`${regression.file}\` | \`${regression.code}\` | ${regression.baseline} | ${regression.current} | +${regression.delta} |`);
        }
        if (comparison.regressions.length > 30) {
            lines.push('', `_...and ${comparison.regressions.length - 30} more regressed bucket(s)._`);
        }
    } else if (comparison.canTighten) {
        lines.push('', `Baseline can be tightened with \`${UPDATE_COMMAND}\`.`);
    }

    return `${lines.join('\n')}\n`;
}

export function parseArguments(argumentsList) {
    const options = {
        updateBaseline: false,
        allowIncrease: false,
        json: false,
        baseline: null,
        config: null,
        root: null,
        summaryFile: null,
    };

    for (let index = 0; index < argumentsList.length; index++) {
        const argument = argumentsList[index];
        if (argument === '--update-baseline') {
            options.updateBaseline = true;
        } else if (argument === '--allow-increase') {
            options.allowIncrease = true;
        } else if (argument === '--json') {
            options.json = true;
        } else if (['--baseline', '--config', '--root', '--summary-file'].includes(argument)) {
            const value = argumentsList[++index];
            if (!value || value.startsWith('--')) {
                throw new Error(`Missing value for ${argument}`);
            }
            const key = argument === '--summary-file' ? 'summaryFile' : argument.slice(2);
            options[key] = path.resolve(value);
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
    fs.appendFileSync(summaryPath, `${markdown}\n`, 'utf8');
}

function runCli() {
    const options = parseArguments(process.argv.slice(2));
    const repoRoot = options.root ?? defaultRepoRoot;
    const configPath = options.config ?? path.join(repoRoot, 'tsconfig.server.json');
    const baselinePath = options.baseline ?? path.join(repoRoot, 'scripts', 'server-typecheck-baseline.json');
    const summaryPath = options.summaryFile ?? process.env.GITHUB_STEP_SUMMARY ?? '';

    const { allDiagnostics } = runTsc({ repoRoot, configPath });
    const serverDiagnostics = filterServerDiagnostics(allDiagnostics);

    if (options.updateBaseline) {
        const outcome = updateBaseline({
            diagnostics: serverDiagnostics,
            baselinePath,
            allowIncrease: options.allowIncrease,
        });

        if (outcome.refused) {
            console.error(formatComparisonReport(outcome.comparison));
            console.error('Baseline was not updated because type errors increased. Fix the errors, or pass --allow-increase if intended.');
            process.exitCode = 1;
            return;
        }

        const relativeBaseline = path.relative(repoRoot, baselinePath).replace(/\\/g, '/');
        const beforeText = outcome.previous ? ` (was ${outcome.previous.totalErrors})` : '';
        console.log(`Updated ${relativeBaseline}: ${outcome.next.totalErrors} error(s) across ${Object.keys(outcome.next.files).length} file(s)${beforeText}.`);
        return;
    }

    if (!fs.existsSync(baselinePath)) {
        throw new Error(`Server typecheck baseline not found at ${baselinePath}. Create it with: ${UPDATE_COMMAND}`);
    }

    const baseline = validateBaseline(JSON.parse(fs.readFileSync(baselinePath, 'utf8')));
    const comparison = compareDiagnosticsToBaseline(serverDiagnostics, baseline);

    if (options.json) {
        console.log(JSON.stringify({
            totalBaseline: comparison.totalBaseline,
            totalCurrent: comparison.totalCurrent,
            delta: comparison.delta,
            passed: comparison.passed,
            canTighten: comparison.canTighten,
            regressions: comparison.regressions,
            improvements: comparison.improvements,
        }, null, 4));
    } else if (comparison.passed) {
        console.log(formatComparisonReport(comparison));
    } else {
        console.error(formatComparisonReport(comparison));
    }

    appendStepSummary(summaryPath, formatStepSummary(comparison));

    if (!comparison.passed) {
        process.exitCode = 1;
    }
}

function isEntryPoint(metaUrl, argv1) {
    if (!argv1) {
        return false;
    }
    const left = path.resolve(argv1);
    const right = path.resolve(fileURLToPath(metaUrl));
    return process.platform === 'win32'
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
    try {
        runCli();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
