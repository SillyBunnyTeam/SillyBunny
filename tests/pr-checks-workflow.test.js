import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import { parse } from 'yaml';

const workflow = parse(fs.readFileSync(new URL('../.github/workflows/pr-checks.yml', import.meta.url), 'utf8'));
const runCommands = job => workflow.jobs[job].steps.map(step => step.run ?? '').join('\n');

describe('pull request checks workflow', () => {
    test('lints the tests package inside the required ESLint job', () => {
        expect(workflow.jobs['run-eslint'].name).toBe('✅ Check ESLint on PR');
        const commands = runCommands('run-eslint');
        expect(commands).toContain('npm ci --ignore-scripts --prefix tests');
        expect(commands).toContain('npm run lint --prefix tests');
    });

    test('pins every action to a full commit SHA', () => {
        const uses = Object.values(workflow.jobs).flatMap(job => job.steps.map(step => step.uses).filter(Boolean));
        expect(uses.length).toBeGreaterThan(0);
        for (const reference of uses) {
            expect(reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
        }
    });
});
