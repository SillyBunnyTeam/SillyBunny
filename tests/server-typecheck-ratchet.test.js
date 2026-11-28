import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
    BASELINE_VERSION,
    GLOBAL_DIAGNOSTIC_FILE,
    UPDATE_COMMAND,
    buildBaseline,
    compareDiagnosticsToBaseline,
    defaultBaselinePath,
    defaultConfigPath,
    filterServerDiagnostics,
    formatComparisonReport,
    formatStepSummary,
    isServerScopeFile,
    normalizeDiagnosticPath,
    parseArguments,
    parseTscDiagnostics,
    runTsc,
    updateBaseline,
    validateBaseline,
} from '../scripts/check-server-typecheck.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(repoRoot, 'scripts', 'check-server-typecheck.js');
const localTscPath = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

function withTempFixture(files, callback) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-server-typecheck-'));
    try {
        const tsconfig = {
            compilerOptions: {
                module: 'ESNext',
                target: 'ES2023',
                moduleResolution: 'Bundler',
                allowJs: true,
                checkJs: true,
                noEmit: true,
                skipLibCheck: true,
                strictNullChecks: true,
                strictFunctionTypes: true,
                strictBindCallApply: true,
                types: [],
            },
            include: [
                'server.js',
                'src/**/*.js',
            ],
            exclude: [
                '**/node_modules/**',
                'src/tokenizers/**',
            ],
        };
        fs.writeFileSync(path.join(root, 'tsconfig.server.json'), `${JSON.stringify(tsconfig, null, 4)}\n`, 'utf8');

        for (const [relativePath, content] of Object.entries(files)) {
            const fullPath = path.join(root, relativePath);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, content, 'utf8');
        }

        return callback(root);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function runCliAgainstFixture(fixtureRoot, extraArgs = [], envOverrides = {}) {
    return spawnSync(
        process.execPath,
        [scriptPath, '--root', fixtureRoot, ...extraArgs],
        {
            cwd: repoRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                GITHUB_STEP_SUMMARY: '',
                ...envOverrides,
            },
        },
    );
}

describe('server typecheck diagnostic parsing and normalization', () => {
    test('normalizes Windows, POSIX, relative and absolute paths to repo-relative POSIX paths', () => {
        expect(normalizeDiagnosticPath('src\\endpoints\\chats.js', 'C:\\repo')).toBe('src/endpoints/chats.js');
        expect(normalizeDiagnosticPath('./src/util.js', '/workspace/repo')).toBe('src/util.js');
        expect(normalizeDiagnosticPath('c:\\Repo\\src\\util.js', 'C:\\repo')).toBe('src/util.js');
        expect(normalizeDiagnosticPath('/workspace/repo/src/endpoints/users.js', '/workspace/repo')).toBe('src/endpoints/users.js');
        expect(normalizeDiagnosticPath(GLOBAL_DIAGNOSTIC_FILE, '/workspace/repo')).toBe(GLOBAL_DIAGNOSTIC_FILE);
    });

    test('parses paren format, colon format, Windows paths, multi-line messages and fileless TS errors', () => {
        const output = [
            'src\\endpoints\\chats.js(12,5): error TS2339: Property \'foo\' does not exist on type \'{}\'.',
            'src/util.js(80,10): error TS2322: Type \'string\' is not assignable to type \'number\'.',
            '  Type \'string\' is not comparable to type \'number\'.',
            '    Additional detail line.',
            '/workspace/repo/plugins.js:16:31 - error TS2339: Property \'dirname\' does not exist on type \'ImportMeta\'.',
            'error TS5023: Unknown compiler option \'nope\'.',
            '',
            'Found 4 errors.',
        ].join('\r\n');

        const parsed = parseTscDiagnostics(output, { repoRoot: '/workspace/repo' });
        expect(parsed).toEqual([
            {
                file: 'src/endpoints/chats.js',
                line: 12,
                column: 5,
                severity: 'error',
                code: 'TS2339',
                message: 'Property \'foo\' does not exist on type \'{}\'.',
            },
            {
                file: 'src/util.js',
                line: 80,
                column: 10,
                severity: 'error',
                code: 'TS2322',
                message: 'Type \'string\' is not assignable to type \'number\'.\n  Type \'string\' is not comparable to type \'number\'.\n    Additional detail line.',
            },
            {
                file: 'plugins.js',
                line: 16,
                column: 31,
                severity: 'error',
                code: 'TS2339',
                message: 'Property \'dirname\' does not exist on type \'ImportMeta\'.',
            },
            {
                file: GLOBAL_DIAGNOSTIC_FILE,
                line: null,
                column: null,
                severity: 'error',
                code: 'TS5023',
                message: 'Unknown compiler option \'nope\'.',
            },
        ]);
    });

    test('filters diagnostics to server scope and excludes transitive public and tokenizer files', () => {
        expect(isServerScopeFile('server.js')).toBe(true);
        expect(isServerScopeFile('plugins.js')).toBe(true);
        expect(isServerScopeFile('recover.js')).toBe(true);
        expect(isServerScopeFile('index.d.ts')).toBe(true);
        expect(isServerScopeFile('src/util.js')).toBe(true);
        expect(isServerScopeFile('src/types/byaf.d.ts')).toBe(true);
        expect(isServerScopeFile(GLOBAL_DIAGNOSTIC_FILE)).toBe(true);

        expect(isServerScopeFile('src/tokenizers/llama3.json')).toBe(false);
        expect(isServerScopeFile('public/script.js')).toBe(false);
        expect(isServerScopeFile('public/lib/pdf.min.mjs')).toBe(false);
        expect(isServerScopeFile('webpack.config.js')).toBe(false);
        expect(isServerScopeFile('tests/util.test.js')).toBe(false);

        const filtered = filterServerDiagnostics([
            { file: 'src/util.js', line: 1, column: 1, severity: 'error', code: 'TS2322', message: 'a' },
            { file: 'public/script.js', line: 2, column: 1, severity: 'error', code: 'TS2339', message: 'b' },
            { file: 'src/util.js', line: 3, column: 1, severity: 'warning', code: 'TS2339', message: 'c' },
            { file: GLOBAL_DIAGNOSTIC_FILE, line: null, column: null, severity: 'error', code: 'TS5023', message: 'd' },
        ]);
        expect(filtered.map(item => `${item.file}:${item.code}`)).toEqual([
            'src/util.js:TS2322',
            `${GLOBAL_DIAGNOSTIC_FILE}:TS5023`,
        ]);
    });
});

describe('server typecheck baseline comparison and validation', () => {
    const sampleDiagnostics = [
        { file: 'src/a.js', line: 10, column: 5, severity: 'error', code: 'TS2322', message: 'Type mismatch 1' },
        { file: 'src/a.js', line: 20, column: 5, severity: 'error', code: 'TS2322', message: 'Type mismatch 2' },
        { file: 'src/b.js', line: 5, column: 1, severity: 'error', code: 'TS2339', message: 'Missing prop' },
    ];
    const baseline = buildBaseline(sampleDiagnostics);

    test('passes when diagnostics match the baseline identically', () => {
        const comparison = compareDiagnosticsToBaseline(sampleDiagnostics, baseline);
        expect(comparison.passed).toBe(true);
        expect(comparison.canTighten).toBe(false);
        expect(comparison.regressions).toEqual([]);
        expect(comparison.improvements).toEqual([]);
        expect(formatComparisonReport(comparison)).toContain('3 baseline error(s), 0 new error(s)');
    });

    test('passes when line numbers shift without changing (file, code) counts', () => {
        const shifted = sampleDiagnostics.map(item => ({ ...item, line: item.line + 42 }));
        const comparison = compareDiagnosticsToBaseline(shifted, baseline);
        expect(comparison.passed).toBe(true);
        expect(comparison.regressions).toEqual([]);
        expect(comparison.improvements).toEqual([]);
    });

    test('passes when counts shrink and reminds how to tighten the baseline', () => {
        const shrunk = [sampleDiagnostics[0], sampleDiagnostics[2]];
        const comparison = compareDiagnosticsToBaseline(shrunk, baseline);
        expect(comparison.passed).toBe(true);
        expect(comparison.canTighten).toBe(true);
        expect(comparison.totalBaseline).toBe(3);
        expect(comparison.totalCurrent).toBe(2);
        expect(comparison.improvements).toEqual([
            { file: 'src/a.js', code: 'TS2322', baseline: 2, current: 1, delta: 1 },
        ]);
        const report = formatComparisonReport(comparison);
        expect(report).toContain('errors decreased from 3 to 2 (-1)');
        expect(report).toContain(UPDATE_COMMAND);
    });

    test('fails when an existing (file, code) count increases and prints exact diagnostics', () => {
        const increased = [
            ...sampleDiagnostics,
            { file: 'src/a.js', line: 33, column: 9, severity: 'error', code: 'TS2322', message: 'New type mismatch' },
        ];
        const comparison = compareDiagnosticsToBaseline(increased, baseline);
        expect(comparison.passed).toBe(false);
        expect(comparison.regressions).toHaveLength(1);
        expect(comparison.regressions[0]).toMatchObject({
            file: 'src/a.js',
            code: 'TS2322',
            baseline: 2,
            current: 3,
            delta: 1,
        });
        const report = formatComparisonReport(comparison);
        expect(report).toContain('[REGRESSION] src/a.js TS2322: 2 -> 3 (+1)');
        expect(report).toContain('src/a.js(33,9): error TS2322: New type mismatch');
    });

    test('fails when a new TS code appears in an existing file even if total errors decreased', () => {
        const swapped = [
            { file: 'src/a.js', line: 12, column: 3, severity: 'error', code: 'TS18047', message: 'Possibly null' },
        ];
        const comparison = compareDiagnosticsToBaseline(swapped, baseline);
        expect(comparison.totalCurrent).toBeLessThan(comparison.totalBaseline);
        expect(comparison.passed).toBe(false);
        expect(comparison.canTighten).toBe(false);
        expect(comparison.regressions).toHaveLength(1);
        expect(comparison.regressions[0]).toMatchObject({
            file: 'src/a.js',
            code: 'TS18047',
            baseline: 0,
            current: 1,
            delta: 1,
        });
    });

    test('fails when a new file introduces an error', () => {
        const addedFile = [
            ...sampleDiagnostics,
            { file: 'src/new-feature.js', line: 4, column: 7, severity: 'error', code: 'TS2345', message: 'Bad arg' },
        ];
        const comparison = compareDiagnosticsToBaseline(addedFile, baseline);
        expect(comparison.passed).toBe(false);
        expect(comparison.regressions).toHaveLength(1);
        expect(comparison.regressions[0]).toMatchObject({
            file: 'src/new-feature.js',
            code: 'TS2345',
            baseline: 0,
            current: 1,
            delta: 1,
        });
    });

    test('validates baseline structure and rejects malformed baselines', () => {
        expect(() => validateBaseline({ version: 2, totalErrors: 0, files: {} })).toThrow('Invalid server typecheck baseline');
        expect(() => validateBaseline({ version: 1, totalErrors: 2, files: { 'src/a.js': { TS2322: 1 } } })).toThrow('totalErrors');
        expect(() => validateBaseline({ version: 1, totalErrors: 1, files: { 'src\\a.js': { TS2322: 1 } } })).toThrow('Invalid server typecheck baseline');
        expect(() => validateBaseline({ version: 1, totalErrors: 1, files: { 'src/a.js': { NOT_TS: 1 } } })).toThrow('Invalid server typecheck baseline');
        expect(() => validateBaseline({ version: 1, totalErrors: 0, files: { 'src/a.js': { TS2322: 0 } } })).toThrow('Invalid server typecheck baseline');
        expect(() => validateBaseline({ version: 1, totalErrors: 0, files: { 'src/a.js': {} } })).toThrow('no error codes');
    });

    test('parses CLI arguments and rejects unknown flags or missing values', () => {
        expect(parseArguments(['--update-baseline', '--allow-increase', '--json'])).toMatchObject({
            updateBaseline: true,
            allowIncrease: true,
            json: true,
        });
        expect(() => parseArguments(['--bogus'])).toThrow('Unknown argument');
        expect(() => parseArguments(['--baseline'])).toThrow('Missing value');
    });

    test('formats concise GitHub step summary markdown', () => {
        const regressed = compareDiagnosticsToBaseline([
            ...sampleDiagnostics,
            { file: 'src/c.js', line: 1, column: 1, severity: 'error', code: 'TS2339', message: 'Oops' },
        ], baseline);
        const failMd = formatStepSummary(regressed);
        expect(failMd).toContain('## Server Typecheck Ratchet');
        expect(failMd).toContain('| Status | Failed |');
        expect(failMd).toContain('| `src/c.js` | `TS2339` | 0 | 1 | +1 |');

        const tightened = compareDiagnosticsToBaseline([sampleDiagnostics[0]], baseline);
        const shrinkMd = formatStepSummary(tightened);
        expect(shrinkMd).toContain('Passed (baseline can be tightened)');
        expect(shrinkMd).toContain(UPDATE_COMMAND);
    });
});

describe('server typecheck ratchet end-to-end with real tsc on a fixture', () => {
    const initialSource = [
        '/** @type {number} */',
        'export const existingMismatch = \'not-a-number\';',
        'export const cleanValue = 42;',
        '',
    ].join('\n');

    test('ratchets baseline updates, ignores line shifts, fails on new errors and writes step summary', () => {
        withTempFixture({ 'src/sample.js': initialSource }, fixtureRoot => {
            const baselinePath = path.join(fixtureRoot, 'scripts', 'server-typecheck-baseline.json');
            const summaryPath = path.join(fixtureRoot, 'step-summary.md');

            // Create initial baseline via CLI --update-baseline.
            const initRun = runCliAgainstFixture(fixtureRoot, ['--update-baseline']);
            expect(initRun.status).toBe(0);
            expect(fs.existsSync(baselinePath)).toBe(true);
            const initialBaseline = validateBaseline(JSON.parse(fs.readFileSync(baselinePath, 'utf8')));
            expect(initialBaseline).toEqual({
                version: BASELINE_VERSION,
                totalErrors: 1,
                files: {
                    'src/sample.js': {
                        TS2322: 1,
                    },
                },
            });

            // Identical tree passes and appends step summary.
            const passRun = runCliAgainstFixture(fixtureRoot, [], { GITHUB_STEP_SUMMARY: summaryPath });
            expect(passRun.status).toBe(0);
            expect(passRun.stdout).toContain('1 baseline error(s), 0 new error(s)');
            expect(fs.readFileSync(summaryPath, 'utf8')).toContain('| Status | Passed |');

            // Inserting lines above the existing error shifts line numbers without failing.
            fs.writeFileSync(path.join(fixtureRoot, 'src/sample.js'), `\n\n\n\n\n${initialSource}`, 'utf8');
            const shiftedRun = runCliAgainstFixture(fixtureRoot);
            expect(shiftedRun.status).toBe(0);

            // Adding a new type error fails check and --update-baseline refuses by default.
            fs.writeFileSync(
                path.join(fixtureRoot, 'src/sample.js'),
                `${initialSource}/** @type {string} */\nexport const secondMismatch = 123;\n`,
                'utf8',
            );
            const failRun = runCliAgainstFixture(fixtureRoot);
            expect(failRun.status).toBe(1);
            expect(failRun.stderr).toContain('[REGRESSION] src/sample.js TS2322: 1 -> 2 (+1)');
            expect(failRun.stderr).toContain('src/sample.js(5,14): error TS2322:');

            const refusedUpdate = runCliAgainstFixture(fixtureRoot, ['--update-baseline']);
            expect(refusedUpdate.status).toBe(1);
            expect(refusedUpdate.stderr).toContain('Baseline was not updated');
            expect(JSON.parse(fs.readFileSync(baselinePath, 'utf8')).totalErrors).toBe(1);

            // Explicit --allow-increase permits raising the baseline.
            const forcedUpdate = runCliAgainstFixture(fixtureRoot, ['--update-baseline', '--allow-increase']);
            expect(forcedUpdate.status).toBe(0);
            expect(JSON.parse(fs.readFileSync(baselinePath, 'utf8')).totalErrors).toBe(2);

            // Fixing both errors passes with tighten reminder and allows shrinking via --update-baseline.
            fs.writeFileSync(path.join(fixtureRoot, 'src/sample.js'), 'export const cleanValue = 42;\n', 'utf8');
            const shrinkCheck = runCliAgainstFixture(fixtureRoot);
            expect(shrinkCheck.status).toBe(0);
            expect(shrinkCheck.stdout).toContain('errors decreased from 2 to 0 (-2)');
            expect(shrinkCheck.stdout).toContain(UPDATE_COMMAND);

            const shrinkUpdate = runCliAgainstFixture(fixtureRoot, ['--update-baseline']);
            expect(shrinkUpdate.status).toBe(0);
            expect(JSON.parse(fs.readFileSync(baselinePath, 'utf8'))).toEqual({
                version: BASELINE_VERSION,
                totalErrors: 0,
                files: {},
            });
        });
    });

    test('fails loudly when the TypeScript compiler crashes instead of reporting zero errors', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tsc-crash-'));
        try {
            const fakeTsc = path.join(root, 'fake-tsc.js');
            fs.writeFileSync(fakeTsc, 'console.error("Error: Debug Failure. False expression."); process.exit(1);\n', 'utf8');
            expect(() => runTsc({ repoRoot: root, configPath: path.join(root, 'tsconfig.server.json'), tscPath: fakeTsc }))
                .toThrow('TypeScript compiler crashed or failed unexpectedly');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('updateBaseline refuses regressions in-memory without touching disk and allows tightening', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-update-baseline-'));
        try {
            const baselinePath = path.join(root, 'baseline.json');
            const initial = [
                { file: 'src/a.js', line: 1, column: 1, severity: 'error', code: 'TS2322', message: 'm1' },
                { file: 'src/a.js', line: 2, column: 1, severity: 'error', code: 'TS2322', message: 'm2' },
            ];
            expect(updateBaseline({ diagnostics: initial, baselinePath }).updated).toBe(true);

            const regressed = [
                ...initial,
                { file: 'src/b.js', line: 1, column: 1, severity: 'error', code: 'TS2339', message: 'm3' },
            ];
            const refused = updateBaseline({ diagnostics: regressed, baselinePath });
            expect(refused.refused).toBe(true);
            expect(refused.updated).toBe(false);
            expect(JSON.parse(fs.readFileSync(baselinePath, 'utf8')).totalErrors).toBe(2);

            const tightened = updateBaseline({ diagnostics: [initial[0]], baselinePath });
            expect(tightened.updated).toBe(true);
            expect(tightened.refused).toBe(false);
            expect(JSON.parse(fs.readFileSync(baselinePath, 'utf8')).totalErrors).toBe(1);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('committed server typecheck config, baseline and CI wiring', () => {
    test('tsconfig.server.json has deterministic server compiler options', () => {
        const config = JSON.parse(fs.readFileSync(defaultConfigPath, 'utf8'));
        expect(config.compilerOptions).toMatchObject({
            allowJs: true,
            checkJs: true,
            noEmit: true,
            skipLibCheck: true,
            strictNullChecks: true,
            strictFunctionTypes: true,
            strictBindCallApply: true,
        });
        expect(config.include).toEqual(expect.arrayContaining([
            'index.d.ts',
            'server.js',
            'plugins.js',
            'recover.js',
            'src/**/*.js',
        ]));
        expect(config.exclude).toEqual(expect.arrayContaining([
            '**/node_modules/**',
            'src/tokenizers/**',
        ]));
        expect(fs.existsSync(localTscPath)).toBe(true);
    });

    test('committed baseline JSON is valid, sorted and references existing server files', () => {
        const raw = fs.readFileSync(defaultBaselinePath, 'utf8');
        const baseline = validateBaseline(JSON.parse(raw));
        const files = Object.keys(baseline.files);
        expect(files).toEqual([...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));

        for (const file of files) {
            expect(isServerScopeFile(file)).toBe(true);
            expect(fs.existsSync(path.join(repoRoot, file))).toBe(true);
            const codes = Object.keys(baseline.files[file]);
            expect(codes).toEqual([...codes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
        }
    });

    test('package.json and pr-checks.yml wire the server typecheck ratchet', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
        expect(pkg.scripts['check:server-types']).toBe('node scripts/check-server-typecheck.js');

        const workflow = parseYaml(fs.readFileSync(path.join(repoRoot, '.github/workflows/pr-checks.yml'), 'utf8'));
        const job = workflow.jobs['server-typecheck'];
        expect(job).toBeDefined();
        expect(job.name).toBe('✅ Check Server Types');
        expect(job['runs-on']).toBe('ubuntu-latest');
        const commands = job.steps.map(step => step.run ?? '').join('\n');
        expect(commands).toContain('npm ci --ignore-scripts');
        expect(commands).toContain('npm run check:server-types');
    });
});
