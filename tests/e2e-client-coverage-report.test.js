import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
    E2E_COVERAGE_DIR_VARIABLE,
    countCoveredBytes,
    createCoverageCollector,
    extractCoveredIntervals,
    installE2eClientCoverage,
    mergeIntervals,
    normalizeClientScriptPathname,
} from './e2e-client-coverage.js';
import {
    aggregateE2eClientCoverage,
    formatConsoleReport,
    formatMarkdownSummary,
    isExcludedClientModule,
    listClientModules,
    mapClientUrlToRepoPath,
    readRawCoverageFiles,
} from '../scripts/report-e2e-client-coverage.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportScriptPath = path.join(repoRoot, 'scripts', 'report-e2e-client-coverage.js');

describe('e2e client coverage V8 collector', () => {
    test('merges overlapping and adjacent intervals and counts covered bytes accurately', () => {
        expect(mergeIntervals([[30, 40], [0, 10], [10, 20], [15, 25], [50, 50], [-5, 4]])).toEqual([
            [0, 25],
            [30, 40],
        ]);
        expect(countCoveredBytes([[0, 25], [20, 35], [40, 50]])).toBe(45);
    });

    test('normalizes client script URLs and rejects external schemes, traversal and non-script paths', () => {
        expect(normalizeClientScriptPathname('http://127.0.0.1:4444/script.js?v=123')).toBe('/script.js');
        expect(normalizeClientScriptPathname('http://127.0.0.1:4444/scripts/sillybunny-tabs.js?cache=1#top')).toBe('/scripts/sillybunny-tabs.js');
        expect(normalizeClientScriptPathname('/scripts/extensions/in-chat-agents/index.js')).toBe('/scripts/extensions/in-chat-agents/index.js');
        expect(normalizeClientScriptPathname('chrome-extension://abc/scripts/foo.js')).toBeNull();
        expect(normalizeClientScriptPathname('data:text/javascript,alert(1)')).toBeNull();
        expect(normalizeClientScriptPathname('http://127.0.0.1:4444/lib/jquery.min.js')).toBeNull();
        expect(normalizeClientScriptPathname('http://127.0.0.1:4444/scripts/../secret.js')).toBeNull();
        expect(normalizeClientScriptPathname('http://127.0.0.1:4444/css/sillybunny-theme.css')).toBeNull();
    });

    test('flattens nested V8 block coverage ranges across script and inner functions', () => {
        // Mirrors real Chromium stopJSCoverage() output where the outer script spans [0, 132] count 1,
        // `used` has an uncovered else block [46, 65] count 0, and `unused` [75, 106] has count 0.
        const extracted = extractCoveredIntervals({
            url: 'http://127.0.0.1:4444/scripts/demo.js',
            source: 'x'.repeat(132),
            functions: [
                { functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 132, count: 1 }] },
                {
                    functionName: 'used',
                    isBlockCoverage: true,
                    ranges: [
                        { startOffset: 7, endOffset: 67, count: 1 },
                        { startOffset: 46, endOffset: 65, count: 0 },
                    ],
                },
                { functionName: 'unused', isBlockCoverage: false, ranges: [{ startOffset: 75, endOffset: 106, count: 0 }] },
            ],
        });

        expect(extracted.totalBytes).toBe(132);
        expect(extracted.coveredRanges).toEqual([
            [0, 46],
            [65, 75],
            [106, 132],
        ]);
        expect(countCoveredBytes(extracted.coveredRanges)).toBe(82);
    });

    test('accumulates union coverage across pages without writing source strings', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-collector-'));
        try {
            const collector = createCoverageCollector({ outputDir: tmpDir, workerId: '0', pid: 4242 });
            collector.recordEntries([
                {
                    url: 'http://127.0.0.1:4444/scripts/foo.js?v=1',
                    source: 'a'.repeat(100),
                    functions: [
                        { ranges: [{ startOffset: 0, endOffset: 100, count: 1 }, { startOffset: 50, endOffset: 100, count: 0 }] },
                    ],
                },
                {
                    url: 'http://127.0.0.1:4444/lib/vendor.js',
                    source: 'v'.repeat(50),
                    functions: [{ ranges: [{ startOffset: 0, endOffset: 50, count: 1 }] }],
                },
            ]);
            collector.recordEntries([
                {
                    url: 'http://127.0.0.1:4444/scripts/foo.js?v=2',
                    source: 'a'.repeat(100),
                    functions: [
                        { ranges: [{ startOffset: 0, endOffset: 100, count: 1 }, { startOffset: 0, endOffset: 40, count: 0 }] },
                    ],
                },
            ]);

            expect(collector.flush()).toBe(true);
            const written = JSON.parse(fs.readFileSync(collector.outputFile, 'utf8'));
            expect(written.scripts['/scripts/foo.js']).toEqual({
                totalBytes: 100,
                coveredRanges: [[0, 100]],
                hits: 2,
            });
            expect(written.scripts['/lib/vendor.js']).toBeUndefined();
            expect(JSON.stringify(written)).not.toContain('aaaa');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('installE2eClientCoverage is a no-op without env var and wraps worker browser launches safely', async () => {
        const mockBrowserType = { launch: async () => ({}) };
        expect(installE2eClientCoverage({ env: {}, browserType: mockBrowserType })).toEqual({ installed: false });

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-install-'));
        try {
            // Main process (no TEST_PARALLEL_INDEX) creates the directory without wrapping launches.
            const mainResult = installE2eClientCoverage({
                env: { [E2E_COVERAGE_DIR_VARIABLE]: tmpDir },
                browserType: mockBrowserType,
            });
            expect(mainResult.installed).toBe(false);

            let started = 0;
            let stopped = 0;
            const makeMockPage = (shouldThrowOnStop = false) => ({
                coverage: {
                    startJSCoverage: async () => { started += 1; },
                    stopJSCoverage: async () => {
                        stopped += 1;
                        if (shouldThrowOnStop) {
                            throw new Error('Target closed');
                        }
                        return [{
                            url: 'http://127.0.0.1:4444/scripts/sillybunny-tabs.js',
                            source: 'x'.repeat(200),
                            functions: [{ ranges: [{ startOffset: 0, endOffset: 100, count: 1 }] }],
                        }];
                    },
                },
                close: async () => {},
            });

            const workerBrowserType = {
                launch: async () => ({
                    newContext: async () => ({
                        on: () => {},
                        newPage: async () => makeMockPage(false),
                        close: async () => {},
                    }),
                    newPage: async () => makeMockPage(true),
                    close: async () => {},
                }),
            };

            const installed = installE2eClientCoverage({
                env: { [E2E_COVERAGE_DIR_VARIABLE]: tmpDir, TEST_PARALLEL_INDEX: '2' },
                browserType: workerBrowserType,
            });
            expect(installed.installed).toBe(true);

            // Second call is idempotent.
            const second = installE2eClientCoverage({
                env: { [E2E_COVERAGE_DIR_VARIABLE]: tmpDir, TEST_PARALLEL_INDEX: '2' },
                browserType: workerBrowserType,
            });
            expect(second.collector).toBe(installed.collector);

            const browser = await workerBrowserType.launch();
            const context = await browser.newContext();
            const page = await context.newPage();
            await page.close();
            await context.close();

            // A page whose stopJSCoverage fails must never break close().
            const loosePage = await browser.newPage();
            await expect(loosePage.close()).resolves.toBeUndefined();
            await browser.close();

            expect(started).toBe(2);
            expect(stopped).toBe(2);
            const files = readRawCoverageFiles(tmpDir);
            expect(files).toHaveLength(1);
            expect(files[0].data.scripts['/scripts/sillybunny-tabs.js'].coveredRanges).toEqual([[0, 100]]);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('e2e client module coverage aggregator and reporter', () => {
    test('maps browser URLs to repo paths and excludes vendored browser files', () => {
        expect(mapClientUrlToRepoPath('http://127.0.0.1:4444/script.js')).toBe('public/script.js');
        expect(mapClientUrlToRepoPath('/scripts/sillybunny-home/footer-fit.js?v=2')).toBe('public/scripts/sillybunny-home/footer-fit.js');
        expect(mapClientUrlToRepoPath('/scripts/extensions/quick-image-gen/index.js')).toBeNull();
        expect(mapClientUrlToRepoPath('/scripts/extensions/third-party/BunnyPresetTools/index.js')).toBeNull();
        expect(mapClientUrlToRepoPath('/scripts/extensions/quick-reply/lib/foo.js')).toBeNull();
        expect(mapClientUrlToRepoPath('/scripts/extensions/tts/lib/foo.js')).toBeNull();
        expect(mapClientUrlToRepoPath('/scripts/extensions/sillybunny-debugger/lib/eruda.js')).toBeNull();
        expect(mapClientUrlToRepoPath('/scripts/vendor.min.js')).toBeNull();
        expect(mapClientUrlToRepoPath('/scripts/../../src/util.js')).toBeNull();
        expect(isExcludedClientModule('public/lib/jquery.js')).toBe(true);
        expect(isExcludedClientModule('public/scripts/sillybunny-tabs.js')).toBe(false);
    });

    test('lists first-party client modules while excluding vendored directories and minified files', () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-list-'));
        try {
            const write = relative => {
                const full = path.join(tmpRoot, relative);
                fs.mkdirSync(path.dirname(full), { recursive: true });
                fs.writeFileSync(full, 'export const ok = true;\n', 'utf8');
            };
            write('public/script.js');
            write('public/lib/jquery.js');
            write('public/scripts/openai.js');
            write('public/scripts/vendor.min.js');
            write('public/scripts/sillybunny-home/hero.js');
            write('public/scripts/extensions/quick-image-gen/index.js');
            write('public/scripts/extensions/third-party/BunnyPresetTools/index.js');
            write('public/scripts/extensions/sillybunny-debugger/lib/eruda.js');
            write('public/scripts/extensions/sillybunny-debugger/index.js');

            expect(listClientModules(tmpRoot)).toEqual([
                'public/script.js',
                'public/scripts/extensions/sillybunny-debugger/index.js',
                'public/scripts/openai.js',
                'public/scripts/sillybunny-home/hero.js',
            ]);
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });

    test('merges multi-worker intervals, computes per-folder reach and byte coverage, and lists unreached modules', () => {
        const clientModules = [
            'public/script.js',
            'public/scripts/a.js',
            'public/scripts/b.js',
            'public/scripts/sillybunny-home/hero.js',
            'public/scripts/sillybunny-home/unused.js',
        ];
        const rawRecords = [
            {
                file: 'worker-0.json',
                data: {
                    scripts: {
                        '/script.js': { totalBytes: 200, coveredRanges: [[0, 60]], hits: 1 },
                        '/scripts/a.js': { totalBytes: 100, coveredRanges: [[0, 50]], hits: 1 },
                        '/scripts/sillybunny-home/hero.js': { totalBytes: 100, coveredRanges: [[0, 80]], hits: 2 },
                    },
                },
            },
            {
                file: 'worker-1.json',
                data: {
                    scripts: {
                        '/scripts/a.js': { totalBytes: 100, coveredRanges: [[40, 100]], hits: 1 },
                    },
                },
            },
        ];

        const report = aggregateE2eClientCoverage({ clientModules, rawRecords });
        expect(report.workerFiles).toBe(2);
        expect(report.totals).toEqual({
            reachedModules: 3,
            totalModules: 5,
            reachPct: 60,
            coveredBytes: 240,
            measuredBytes: 400,
            bytePct: 60,
        });
        // Overlapping intervals [0, 50] + [40, 100] merge to 100 bytes, not 110.
        expect(report.modules['public/scripts/a.js']).toMatchObject({
            reached: true,
            hits: 2,
            coveredBytes: 100,
            totalBytes: 100,
            bytePct: 100,
        });
        expect(report.unreached).toEqual([
            'public/scripts/b.js',
            'public/scripts/sillybunny-home/unused.js',
        ]);

        const markdown = formatMarkdownSummary(report);
        expect(markdown).toContain('### Nightly E2E Client Module Coverage');
        expect(markdown).toContain('| `public/scripts/` | 1 / 2 | 50.00% | 100.00% |');
        expect(markdown).toContain('Unreached client modules (2)');
        expect(markdown).toContain('`unused.js`');
        expect(formatConsoleReport(report)).toContain('Unreached client modules: 2.');
    });

    test('CLI writes JSON, Markdown and GITHUB_STEP_SUMMARY and enforces --require-data when requested', () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-cli-'));
        try {
            const rawDir = path.join(tmpRoot, 'raw');
            const jsonOut = path.join(tmpRoot, 'out', 'report.json');
            const mdOut = path.join(tmpRoot, 'out', 'report.md');
            const stepSummary = path.join(tmpRoot, 'summary.md');

            fs.mkdirSync(path.join(tmpRoot, 'public', 'scripts'), { recursive: true });
            fs.writeFileSync(path.join(tmpRoot, 'public', 'script.js'), 'console.log(1);\n', 'utf8');
            fs.writeFileSync(path.join(tmpRoot, 'public', 'scripts', 'one.js'), 'export const one = 1;\n', 'utf8');
            fs.writeFileSync(path.join(tmpRoot, 'public', 'scripts', 'two.js'), 'export const two = 2;\n', 'utf8');

            const missingData = spawnSync(process.execPath, [
                reportScriptPath,
                '--root', tmpRoot,
                '--dir', rawDir,
                '--require-data',
            ], { encoding: 'utf8' });
            expect(missingData.status).toBe(1);
            expect(missingData.stderr).toContain('No raw e2e client coverage files found');

            fs.mkdirSync(rawDir, { recursive: true });
            fs.writeFileSync(path.join(rawDir, 'worker-0.json'), JSON.stringify({
                version: 1,
                scripts: {
                    '/script.js': { totalBytes: 16, coveredRanges: [[0, 16]], hits: 1 },
                    '/scripts/one.js': { totalBytes: 22, coveredRanges: [[0, 11]], hits: 1 },
                },
            }), 'utf8');

            const run = spawnSync(process.execPath, [
                reportScriptPath,
                '--root', tmpRoot,
                '--dir', rawDir,
                '--json-out', jsonOut,
                '--markdown-out', mdOut,
                '--require-data',
            ], {
                encoding: 'utf8',
                env: { ...process.env, GITHUB_STEP_SUMMARY: stepSummary },
            });
            expect(run.status).toBe(0);
            const jsonReport = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
            expect(jsonReport.totals.reachedModules).toBe(2);
            expect(jsonReport.totals.totalModules).toBe(3);
            expect(jsonReport.unreached).toEqual(['public/scripts/two.js']);
            expect(fs.readFileSync(mdOut, 'utf8')).toContain('| `public/` | 1 / 1 | 100.00% | 100.00% |');
            expect(fs.readFileSync(stepSummary, 'utf8')).toContain('### Nightly E2E Client Module Coverage');
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });
});

describe('nightly workflow and playwright config e2e coverage wiring', () => {
    test('playwright.config.js wires the opt-in e2e client coverage hook', () => {
        const configSource = fs.readFileSync(path.join(repoRoot, 'tests', 'playwright.config.js'), 'utf8');
        expect(configSource).toContain('from \'./e2e-client-coverage.js\'');
        expect(configSource).toContain('installE2eClientCoverage()');
    });

    test('nightly workflow enables e2e client coverage, runs the reporter, and uploads the report artifact', () => {
        const workflow = parse(fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'nightly.yml'), 'utf8'));
        const steps = workflow.jobs.checks.steps;
        const e2eStep = steps.find(step => step.name === 'Bun boot smoke and e2e');
        const reportStep = steps.find(step => step.name === 'Report e2e client module coverage');
        const uploadStep = steps.find(step => step.name === 'Upload e2e client coverage report');

        expect(e2eStep.env.SILLYBUNNY_E2E_COVERAGE_DIR).toBe('${{ runner.temp }}/e2e-coverage-raw');
        expect(reportStep).toBeDefined();
        expect(reportStep.if).toBe('always()');
        expect(reportStep.run).toContain('node scripts/report-e2e-client-coverage.js');
        expect(uploadStep).toBeDefined();
        expect(uploadStep.if).toBe('always()');
        expect(uploadStep.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
        expect(uploadStep.with.path).toContain('e2e-client-coverage/');
    });
});
