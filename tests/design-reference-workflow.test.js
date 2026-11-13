import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from '@jest/globals';

const repoRoot = path.resolve(process.cwd(), '..');
const source = readFileSync(path.join(repoRoot, '.github', 'workflows', 'design-reference.yml'), 'utf8');

describe('design reference workflow', () => {
    test('runs when staging changes its version, or by hand', () => {
        const trigger = source.slice(source.indexOf('on:'), source.indexOf('permissions:'));
        expect(trigger).toContain('branches:\n      - staging');
        expect(trigger).toContain('paths:\n      - package.json');
        expect(trigger).toContain('workflow_dispatch:');
    });

    test('checks only when the version became a new minor -dev version', () => {
        expect(source).toContain('[[ "$version" =~ ^[0-9]+\\.[0-9]+\\.0-dev$ ]]');
        expect(source).toContain('if [ "$previous" != "$version" ]; then');
        expect(source).toContain('if: steps.gate.outputs.run == \'true\'');
    });

    test('keeps one issue: opened or updated when the reference moved, closed when it is current', () => {
        expect(source).toContain('REFERENCE_LABEL: design-reference');
        expect(source).toContain('gh issue list --label "$REFERENCE_LABEL" --state open --limit 1');
        expect(source).toContain('node scripts/check-design-reference.js --markdown');
        expect(source).toMatch(/0\)\n\s+if \[ -n "\$issue" \]; then\n\s+gh issue close/);
        expect(source).toMatch(/1\)\n\s+if \[ -n "\$issue" \]; then\n\s+gh issue edit[^\n]+\n\s+else\n\s+gh issue create/);
    });

    test('fails when the reference cannot be compared', () => {
        expect(source).toMatch(/\*\)\n\s+echo "::error::[^\n]+"\n\s+exit 1/);
    });

    test('grants issue writes to the job only', () => {
        const top = source.slice(0, source.indexOf('jobs:'));
        expect(top).toContain('permissions:\n  contents: read\n');
        expect(top).not.toContain('issues: write');
        expect(source.slice(source.indexOf('jobs:'))).toContain('issues: write');
    });

    test('pins every action to a full commit SHA', () => {
        const uses = [...source.matchAll(/^\s*(?:- )?uses:\s*([^\s#]+)/gm)].map(match => match[1]);
        expect(uses.length).toBeGreaterThan(0);
        for (const reference of uses) {
            expect(reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
        }
    });
});
