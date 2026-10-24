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

    test('reports the Android smoke with the checks, and a failure in either fails the night', () => {
        const report = workflow.jobs.report;
        expect(report.needs).toEqual(['gate', 'checks', 'android']);
        const step = report.steps[0];
        expect(step.env.RESULT).toBe('${{ needs.checks.result }}');
        expect(step.env.ANDROID_RESULT).toBe('${{ needs.android.result }}');
        const cases = step.run.slice(step.run.indexOf('case "$RESULT/$ANDROID_RESULT" in'), step.run.indexOf('esac'))
            .split('\n').slice(1).map(line => line.trim()).filter(Boolean);
        expect(cases).toEqual([
            'success/success) state=success ;;',
            'failure/* | */failure) state=failure ;;',
            'cancelled/* | */cancelled) state=error ;;',
            '*) state=failure ;;',
        ]);
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

    test('pins every action to a full commit SHA; the one local call is the shared Android smoke', () => {
        const pinned = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;
        const jobs = Object.values(workflow.jobs);
        const actions = jobs.flatMap(job => job.steps ?? []).map(step => step.uses).filter(Boolean);
        const calls = jobs.map(job => job.uses).filter(Boolean);
        // Every `uses:` line is a step's action or a job's call, so none escapes the checks below.
        const uses = [...source.matchAll(/^\s*(?:- )?uses:\s*([^\s#]+)/gm)].map(match => match[1]);
        expect([...uses].sort()).toEqual([...actions, ...calls].sort());
        expect(actions.length).toBeGreaterThan(0);
        for (const reference of actions) {
            expect(reference).toMatch(pinned);
        }
        // A job-level `uses:` calls a reusable workflow; .github/workflows/android-smoke.yml is the only local one.
        for (const reference of calls) {
            expect([reference, reference === './.github/workflows/android-smoke.yml' || pinned.test(reference)]).toEqual([reference, true]);
        }
    });
});
