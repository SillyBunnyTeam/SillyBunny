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

    test('pins every action to a full commit SHA', () => {
        const uses = [...source.matchAll(/^\s*(?:- )?uses:\s*([^\s#]+)/gm)].map(match => match[1]);
        expect(uses.length).toBeGreaterThan(0);
        for (const reference of uses) {
            expect(reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
        }
    });
});
