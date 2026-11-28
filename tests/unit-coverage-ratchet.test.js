import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
    UPDATE_COMMAND,
    aggregateCoverageSummary,
    buildBaseline,
    compareToBaseline,
    computePercent,
    defaultBaselinePath,
    findBaselineDrops,
    folderForFile,
    formatConsoleReport,
    formatMarkdownSummary,
    normalizeCoverageFilePath,
    parseArguments,
    validateBaseline,
} from '../scripts/check-unit-coverage.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(repoRoot, 'scripts', 'check-unit-coverage.js');

function metric(covered, total) {
    return {
        covered,
        total,
        skipped: 0,
        pct: computePercent(covered, total),
    };
}

function fileEntry(coveredLines, totalLines) {
    const m = metric(coveredLines, totalLines);
    return { lines: m, statements: m, functions: m, branches: m };
}

describe('unit coverage path normalization and folder grouping', () => {
    test('normalizes POSIX, Windows, case-variant and relative file paths under repoRoot', () => {
        expect(normalizeCoverageFilePath('/workspace/app/src/util.js', '/workspace/app')).toBe('src/util.js');
        expect(normalizeCoverageFilePath('C:\\Repo\\src\\endpoints\\chats.js', 'c:\\repo')).toBe('src/endpoints/chats.js');
        expect(normalizeCoverageFilePath('./public/scripts/openai.js', '/workspace/app')).toBe('public/scripts/openai.js');
        expect(normalizeCoverageFilePath('src\\middleware\\requireHttps.js', '/workspace/app')).toBe('src/middleware/requireHttps.js');
        expect(normalizeCoverageFilePath('/other/repo/src/util.js', '/workspace/app')).toBeNull();
        expect(normalizeCoverageFilePath('../outside/secret.js', '/workspace/app')).toBeNull();
        expect(normalizeCoverageFilePath('', '/workspace/app')).toBeNull();
    });

    test.each([
        ['src/util.js', 'src/'],
        ['src/endpoints/chats.js', 'src/endpoints/'],
        ['src/endpoints/backends/chat-completions.js', 'src/endpoints/backends/'],
        ['src/middleware/requireHttps.js', 'src/middleware/'],
        ['src/vectors/embedding.js', 'src/vectors/'],
        ['public/script.js', 'public/'],
        ['public/scripts/openai.js', 'public/scripts/'],
        ['public/scripts/sillybunny-editor/adapters/side-panels.js', 'public/scripts/sillybunny-editor/'],
        ['public/scripts/extensions/extensions.js', 'public/scripts/extensions/'],
        ['public/scripts/extensions/in-chat-agents/ui/agent-editor.js', 'public/scripts/extensions/in-chat-agents/'],
        ['scripts/check-unit-coverage.js', 'scripts/'],
        ['scripts/lib/helper.js', 'scripts/'],
    ])('maps %s to folder bucket %s', (file, expected) => {
        expect(folderForFile(file)).toBe(expected);
    });
});

describe('unit coverage aggregation and ratchet comparison', () => {
    const sampleRoot = path.resolve(os.tmpdir(), 'sb-cov-root');
    const sampleSummary = {
        total: fileEntry(150, 200),
        [path.join(sampleRoot, 'src', 'a.js')]: fileEntry(80, 100),
        [path.join(sampleRoot, 'src', 'b.js')]: fileEntry(20, 100),
        [path.join(sampleRoot, 'src', 'endpoints', 'chats.js')]: fileEntry(50, 100),
        [path.join(sampleRoot, 'src', 'endpoints', 'backends', 'openai.js')]: fileEntry(30, 60),
        [path.join(sampleRoot, 'public', 'scripts', 'sillybunny-editor', 'rows.js')]: fileEntry(90, 100),
        [path.join(sampleRoot, 'scripts', 'tool.js')]: fileEntry(40, 50),
        '/outside/repo/ignored.js': fileEntry(0, 500),
    };

    const aggregated = aggregateCoverageSummary(sampleSummary, { repoRoot: sampleRoot });
    const baseline = buildBaseline(aggregated);

    test('aggregates line counts per folder rather than averaging file percentages', () => {
        expect(Object.keys(aggregated.folders)).toEqual([
            'public/scripts/sillybunny-editor/',
            'scripts/',
            'src/',
            'src/endpoints/',
            'src/endpoints/backends/',
        ]);
        expect(aggregated.folders['src/'].files).toBe(2);
        expect(aggregated.folders['src/'].lines).toEqual({ covered: 100, total: 200, pct: 50 });
        expect(aggregated.folders['src/endpoints/backends/'].lines.pct).toBe(50);
        expect(aggregated.total.lines).toEqual({ covered: 310, total: 510, pct: 60.78 });
    });

    test('passes when every folder matches the baseline', () => {
        const comparison = compareToBaseline(aggregated, baseline);
        expect(comparison.ok).toBe(true);
        expect(comparison.drops).toEqual([]);
        expect(comparison.improvements).toEqual([]);
        expect(comparison.missing).toEqual([]);
        expect(comparison.added).toEqual([]);
    });

    test('fails when a folder drops below its baseline and names the folder and percentages', () => {
        const droppedSummary = {
            ...sampleSummary,
            [path.join(sampleRoot, 'src', 'b.js')]: fileEntry(10, 100),
        };
        const dropped = aggregateCoverageSummary(droppedSummary, { repoRoot: sampleRoot });
        const comparison = compareToBaseline(dropped, baseline);

        expect(comparison.ok).toBe(false);
        expect(comparison.drops).toHaveLength(1);
        expect(comparison.drops[0]).toMatchObject({
            folder: 'src/',
            baseline: 50,
            current: 45,
            delta: -5,
            status: 'DROP',
        });
        expect(formatConsoleReport(comparison)).toContain('[DROP] src/: 45.00% < 50.00% (-5.00%');
        expect(formatMarkdownSummary(comparison)).toContain('| `src/` | 90 / 200 | 50.00% | 45.00% | -5.00% | DROP |');
        expect(formatMarkdownSummary(comparison)).toContain('**Coverage ratchet failed:**');
    });

    test('respects an explicit tolerance when configured', () => {
        const slightlyLower = aggregateCoverageSummary({
            ...sampleSummary,
            [path.join(sampleRoot, 'src', 'b.js')]: fileEntry(19, 100),
        }, { repoRoot: sampleRoot });
        expect(compareToBaseline(slightlyLower, baseline).ok).toBe(false);
        expect(compareToBaseline(slightlyLower, baseline, { tolerance: 0.5 }).ok).toBe(true);
    });

    test('passes when a folder improves and suggests the update command', () => {
        const improved = aggregateCoverageSummary({
            ...sampleSummary,
            [path.join(sampleRoot, 'src', 'b.js')]: fileEntry(60, 100),
        }, { repoRoot: sampleRoot });
        const comparison = compareToBaseline(improved, baseline);

        expect(comparison.ok).toBe(true);
        expect(comparison.improvements).toHaveLength(1);
        expect(comparison.improvements[0]).toMatchObject({
            folder: 'src/',
            baseline: 50,
            current: 70,
            delta: 20,
            status: 'UP',
        });
        expect(formatConsoleReport(comparison)).toContain(UPDATE_COMMAND);
        expect(formatMarkdownSummary(comparison)).toContain(UPDATE_COMMAND);
    });

    test('fails when a baseline folder is missing from the coverage report', () => {
        const withoutScripts = { ...sampleSummary };
        delete withoutScripts[path.join(sampleRoot, 'scripts', 'tool.js')];
        const comparison = compareToBaseline(aggregateCoverageSummary(withoutScripts, { repoRoot: sampleRoot }), baseline);

        expect(comparison.ok).toBe(false);
        expect(comparison.missing).toHaveLength(1);
        expect(comparison.missing[0]).toMatchObject({ folder: 'scripts/', status: 'MISSING' });
        expect(formatConsoleReport(comparison)).toContain('[MISSING] scripts/');
    });

    test('passes and marks newly introduced folders as NEW', () => {
        const withNewFolder = aggregateCoverageSummary({
            ...sampleSummary,
            [path.join(sampleRoot, 'src', 'new-area', 'index.js')]: fileEntry(15, 20),
        }, { repoRoot: sampleRoot });
        const comparison = compareToBaseline(withNewFolder, baseline);

        expect(comparison.ok).toBe(true);
        expect(comparison.added).toHaveLength(1);
        expect(comparison.added[0]).toMatchObject({ folder: 'src/new-area/', current: 75, status: 'NEW' });
        expect(formatMarkdownSummary(comparison)).toContain('| `src/new-area/` | 15 / 20 | - | 75.00% | - | NEW |');
    });

    test('detects baseline regressions and rejects malformed baseline payloads', () => {
        const lowered = { ...baseline, folders: { ...baseline.folders, 'src/': 49 } };
        expect(findBaselineDrops(baseline, lowered)).toEqual([
            { folder: 'src/', before: 50, after: 49, missing: false },
        ]);

        expect(() => validateBaseline({ version: 2, metric: 'lines', tolerance: 0, folders: {} })).toThrow('Invalid unit coverage baseline');
        expect(() => validateBaseline({ version: 1, metric: 'branches', tolerance: 0, folders: {} })).toThrow('Invalid unit coverage baseline');
        expect(() => validateBaseline({ version: 1, metric: 'lines', tolerance: -1, folders: {} })).toThrow('Invalid unit coverage baseline');
        expect(() => validateBaseline({ version: 1, metric: 'lines', tolerance: 0, folders: { src: 50 } })).toThrow('Invalid unit coverage baseline');
        expect(() => validateBaseline({ version: 1, metric: 'lines', tolerance: 0, folders: { 'src/': 120 } })).toThrow('Invalid unit coverage baseline');
    });

    test('parses CLI arguments and rejects unknown or incomplete flags', () => {
        const parsed = parseArguments(['--report', 'cov.json', '--baseline', 'base.json', '--tolerance', '0.25', '--update-baseline', '--allow-drop', '--markdown']);
        expect(parsed.updateBaseline).toBe(true);
        expect(parsed.allowDrop).toBe(true);
        expect(parsed.markdown).toBe(true);
        expect(parsed.tolerance).toBe(0.25);

        expect(() => parseArguments(['--bogus'])).toThrow('Unknown argument');
        expect(() => parseArguments(['--report'])).toThrow('Missing value');
        expect(() => parseArguments(['--tolerance', '150'])).toThrow('Invalid value for --tolerance');
    });
});

describe('unit coverage CLI and committed baseline contract', () => {
    test('CLI exits 0 on pass, appends GITHUB_STEP_SUMMARY, exits 1 on drop, and guards --update-baseline', () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-unit-cov-cli-'));
        try {
            const reportFile = path.join(tmpRoot, 'coverage-summary.json');
            const baselineFile = path.join(tmpRoot, 'baseline.json');
            const stepSummaryFile = path.join(tmpRoot, 'step-summary.md');

            const writeSummary = (srcCovered, scriptsCovered) => {
                fs.writeFileSync(reportFile, JSON.stringify({
                    total: fileEntry(srcCovered + scriptsCovered, 200),
                    [path.join(tmpRoot, 'src', 'core.js')]: fileEntry(srcCovered, 100),
                    [path.join(tmpRoot, 'scripts', 'check.js')]: fileEntry(scriptsCovered, 100),
                }), 'utf8');
            };

            writeSummary(80, 60);
            const initResult = spawnSync(process.execPath, [
                scriptPath,
                '--root', tmpRoot,
                '--report', reportFile,
                '--baseline', baselineFile,
                '--update-baseline',
            ], { encoding: 'utf8' });
            expect(initResult.status).toBe(0);
            expect(JSON.parse(fs.readFileSync(baselineFile, 'utf8')).folders).toEqual({
                'scripts/': 60,
                'src/': 80,
            });

            const passResult = spawnSync(process.execPath, [
                scriptPath,
                '--root', tmpRoot,
                '--report', reportFile,
                '--baseline', baselineFile,
            ], {
                encoding: 'utf8',
                env: { ...process.env, GITHUB_STEP_SUMMARY: stepSummaryFile },
            });
            expect(passResult.status).toBe(0);
            expect(fs.readFileSync(stepSummaryFile, 'utf8')).toContain('### Unit Test Coverage (Per-Folder Ratchet)');
            expect(fs.readFileSync(stepSummaryFile, 'utf8')).toContain('| `src/` | 80 / 100 | 80.00% | 80.00% | 0.00% | OK |');

            // A coverage drop fails both normal checks and guarded --update-baseline.
            writeSummary(75, 60);
            const dropResult = spawnSync(process.execPath, [
                scriptPath,
                '--root', tmpRoot,
                '--report', reportFile,
                '--baseline', baselineFile,
            ], { encoding: 'utf8' });
            expect(dropResult.status).toBe(1);
            expect(dropResult.stdout).toContain('[DROP] src/: 75.00% < 80.00%');

            const refusedUpdate = spawnSync(process.execPath, [
                scriptPath,
                '--root', tmpRoot,
                '--report', reportFile,
                '--baseline', baselineFile,
                '--update-baseline',
            ], { encoding: 'utf8' });
            expect(refusedUpdate.status).toBe(1);
            expect(refusedUpdate.stderr).toContain('--allow-drop');
            expect(JSON.parse(fs.readFileSync(baselineFile, 'utf8')).folders['src/']).toBe(80);

            // An improvement passes --update-baseline and raises the floor.
            writeSummary(85, 60);
            const raiseResult = spawnSync(process.execPath, [
                scriptPath,
                '--root', tmpRoot,
                '--report', reportFile,
                '--baseline', baselineFile,
                '--update-baseline',
            ], { encoding: 'utf8' });
            expect(raiseResult.status).toBe(0);
            expect(JSON.parse(fs.readFileSync(baselineFile, 'utf8')).folders['src/']).toBe(85);
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });

    test('committed unit coverage baseline is valid and covers the core source folders', () => {
        const baseline = validateBaseline(JSON.parse(fs.readFileSync(defaultBaselinePath, 'utf8')));
        expect(baseline.folders).toHaveProperty('src/');
        expect(baseline.folders).toHaveProperty('src/endpoints/');
        expect(baseline.folders).toHaveProperty('src/endpoints/backends/');
        expect(baseline.folders).toHaveProperty('public/scripts/');
        expect(baseline.folders).toHaveProperty('scripts/');
    });

    test('pr-checks workflow generates unit coverage, enforces the ratchet, and uploads the summary', () => {
        const workflow = parse(fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'pr-checks.yml'), 'utf8'));
        const steps = workflow.jobs['run-tests'].steps;
        const testIndex = steps.findIndex(step => (step.run ?? '').includes('npm run test:unit:coverage --prefix tests'));
        const ratchetIndex = steps.findIndex(step => (step.run ?? '').includes('node scripts/check-unit-coverage.js'));
        const uploadStep = steps.find(step => step.name === 'Upload unit coverage summary');

        expect(testIndex).toBeGreaterThanOrEqual(0);
        expect(ratchetIndex).toBeGreaterThan(testIndex);
        expect(uploadStep).toBeDefined();
        expect(uploadStep.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
        expect(uploadStep.with.path).toContain('coverage/unit/coverage-summary.json');
    });
});
