import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import { parse } from 'yaml';

const workflowsDir = new URL('../.github/workflows/', import.meta.url);
const playwrightJobs = fs.readdirSync(workflowsDir)
    .filter(name => /\.ya?ml$/.test(name))
    .flatMap(name => {
        const workflow = parse(fs.readFileSync(new URL(name, workflowsDir), 'utf8'));
        return Object.entries(workflow.jobs ?? {})
            .filter(([, job]) => job.steps?.some(step => step.run?.includes('playwright install')))
            .map(([id, job]) => ({ name: `${name} ${id}`, runsOn: job['runs-on'] }));
    });

describe('workflows that install Playwright browsers', () => {
    test('include the nightly and release e2e jobs', () => {
        expect(playwrightJobs.map(job => job.name)).toEqual(expect.arrayContaining(['nightly.yml checks', 'release-e2e.yml run-release-e2e']));
    });

    // Each Playwright version installs only on the Ubuntu releases it lists, and ubuntu-latest moves without a commit.
    test('pin an Ubuntu release instead of ubuntu-latest', () => {
        const unpinned = playwrightJobs.filter(job => !/^ubuntu-\d+\.\d+$/.test(job.runsOn));
        expect(unpinned).toEqual([]);
    });
});
