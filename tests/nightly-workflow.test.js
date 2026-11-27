import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from '@jest/globals';
import { parse } from 'yaml';

const repoRoot = path.resolve(process.cwd(), '..');
const source = readFileSync(path.join(repoRoot, '.github', 'workflows', 'nightly.yml'), 'utf8');
const workflow = parse(source);

describe('nightly workflow', () => {
    test('runs on a schedule but tests the staging SHA it resolved', () => {
        expect(source).toContain('- cron: \'17 3 * * *\'');
        expect(source).toContain('gh api "repos/$REPOSITORY/commits/staging" --jq .sha');
        expect(source).toContain('ref: ${{ needs.gate.outputs.sha }}');
    });

    test('skips a staging SHA that already passed unless forced', () => {
        expect(source).toContain('if [ "$FORCE" != "true" ] && [ "$state" = "success" ]; then');
        expect(source).toContain('if: needs.gate.outputs.run == \'true\'');
    });

    test('keeps one failure issue and one staleness reminder', () => {
        expect(source).toContain('FAILURE_LABEL: nightly-failure');
        expect(source).toContain('gh issue list --label "$FAILURE_LABEL" --state open --limit 1');
        expect(source).toContain('gh issue list --label "$REMINDER_LABEL" --state open --limit 1');
        expect(source).toContain('repos/$GH_REPO/releases/latest');
    });

    test('keeps launcher flags off the unit-test step', () => {
        // tests/server-supervisor.test.js asserts these are unset, so job-level env would fail every nightly.
        const checksJob = source.slice(source.indexOf('  checks:'), source.indexOf('  report:'));
        const jobEnv = checksJob.slice(0, checksJob.indexOf('    steps:'));
        const unitStep = checksJob.slice(checksJob.indexOf('- name: Unit tests'), checksJob.indexOf('- name: Frontend budgets'));
        for (const block of [jobEnv, unitStep]) {
            expect(block).not.toContain('SILLYBUNNY_LAUNCHER');
            expect(block).not.toContain('SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH');
        }
    });

    test('lints the root and tests packages', () => {
        const lintStep = source.slice(source.indexOf('- name: Lint'), source.indexOf('- name: Unit tests'));
        expect(lintStep).toContain('npm run lint\n');
        expect(lintStep).toContain('npm run lint --prefix tests');
    });

    test('runs WebKit and Firefox e2e legs on the resolved staging SHA and reports failures from either', () => {
        const job = workflow.jobs['e2e-browsers'];
        expect(job.needs).toBe('gate');
        expect(job.if).toBe('needs.gate.outputs.run == \'true\'');
        expect(job.strategy['fail-fast']).toBe(false);
        expect(job.strategy.matrix.browser).toEqual(['webkit', 'firefox']);

        const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
        expect(checkout.with.ref).toBe('${{ needs.gate.outputs.sha }}');

        const installBrowser = job.steps.find(step => step.name === 'Install browser');
        expect(installBrowser.env).toEqual({ BROWSER: '${{ matrix.browser }}' });
        expect(installBrowser.run).toContain('npx --no-install playwright install --with-deps "$BROWSER"');

        const runStep = job.steps.find(step => step.name === 'Run browser e2e');
        expect(runStep.env).toEqual({
            BROWSER: '${{ matrix.browser }}',
            SILLYBUNNY_LAUNCHER: '1',
            SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH: '1',
        });
        expect(runStep.run).toContain('node tests/e2e-servers-prime.js --browser="$BROWSER"');
        expect(runStep.run).toContain('npm run "test:e2e:$BROWSER" --prefix tests');

        const uploadStep = job.steps.find(step => step.name === 'Upload failure diagnostics');
        expect(uploadStep.if).toBe('failure() || cancelled()');

        const report = workflow.jobs.report;
        expect(report.needs).toEqual(['gate', 'checks', 'e2e-browsers']);
        const reportStep = report.steps[0];
        expect(reportStep.env.CHECKS_RESULT).toBe('${{ needs.checks.result }}');
        expect(reportStep.env.BROWSERS_RESULT).toBe('${{ needs.e2e-browsers.result }}');
    });

    test('pins every action to a full commit SHA', () => {
        const uses = [...source.matchAll(/^\s*(?:- )?uses:\s*([^\s#]+)/gm)].map(match => match[1]);
        expect(uses.length).toBeGreaterThan(0);
        for (const reference of uses) {
            expect(reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
        }
    });
});
