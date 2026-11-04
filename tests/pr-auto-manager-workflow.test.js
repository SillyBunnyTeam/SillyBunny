import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import { parse } from 'yaml';

const workflow = parse(fs.readFileSync(new URL('../.github/workflows/pr-auto-manager.yml', import.meta.url), 'utf8'));

describe('pull request manager workflow', () => {
    test('relabels by branch when a pull request changes its base branch', () => {
        // GitHub sends a base-branch change as `edited` with `changes.base`; `synchronize` carries no `changes`.
        expect(workflow.on.pull_request_target.types).toContain('edited');
        const condition = workflow.jobs['label-by-branches'].if;
        expect(condition).toContain('github.event.action == \'opened\'');
        expect(condition).toContain('github.event.action == \'edited\' && github.event.changes.base');
        expect(condition).not.toContain('\'synchronize\' && github.event.changes.base');
    });
});
