import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from '@jest/globals';

const repoRoot = path.resolve(process.cwd(), '..');
const source = readFileSync(path.join(repoRoot, '.github', 'workflows', 'nightly.yml'), 'utf8');

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

    test('pins every action to a full commit SHA', () => {
        const uses = [...source.matchAll(/^\s*(?:- )?uses:\s*([^\s#]+)/gm)].map(match => match[1]);
        expect(uses.length).toBeGreaterThan(0);
        for (const reference of uses) {
            expect(reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
        }
    });
});
