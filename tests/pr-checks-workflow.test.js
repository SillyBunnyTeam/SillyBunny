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

    test('checks agent template versions against the merge ref inside the required unit test job', () => {
        expect(workflow.jobs['run-tests'].name).toBe('✅ Run Unit Tests on PR');
        const step = workflow.jobs['run-tests'].steps.find(candidate => candidate.name === 'Check agent template versions');
        expect(step.run).toContain('"+refs/pull/$PR_NUMBER/merge:refs/remotes/pr/merge"');
        expect(step.run).toContain('node scripts/bump-agent-template-versions.js --check --base \'refs/remotes/pr/merge^1\' --head refs/remotes/pr/merge');
        expect(step.env.BASE_REPOSITORY).toBe('${{ github.repository }}');
    });

    test('boots the server under Node.js and keeps the Bun check name', () => {
        expect(workflow.jobs['run-bun-checks'].name).toBe('✅ Check Bun Runtime');
        const job = workflow.jobs['run-node-checks'];
        expect(job.name).toBe('✅ Check Node Runtime');
        expect(job.steps.find(step => step.uses?.startsWith('actions/setup-node@')).with['node-version']).toBe(24);

        const bootStep = job.steps.find(step => step.name === 'Node boot smoke');
        expect(bootStep.run).toContain('node server.js --browserLaunchEnabled=false');
        expect(bootStep.run).toContain('curl --fail --silent --max-time 2 "$SILLYBUNNY_TEST_BASE_URL/"');
        expect(bootStep.env).toEqual({ SILLYBUNNY_LAUNCHER: '1', SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH: '1' });
    });

    test('pins every action to a full commit SHA', () => {
        const uses = Object.values(workflow.jobs).flatMap(job => job.steps.map(step => step.uses).filter(Boolean));
        expect(uses.length).toBeGreaterThan(0);
        for (const reference of uses) {
            expect(reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
        }
    });
});
