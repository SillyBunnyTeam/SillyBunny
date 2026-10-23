/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
import { describe, expect, test } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';

const WORKFLOWS = new URL('../.github/workflows/', import.meta.url);
const source = readFileSync(new URL('android-runtime.yml', WORKFLOWS), 'utf8');
const workflow = parse(source);
const runtimeLock = JSON.parse(readFileSync(new URL('../android/runtime.lock', import.meta.url), 'utf8'));
const jobs = workflow.jobs;
const steps = Object.values(jobs).flatMap(job => job.steps);
const USES = /^([\w.-]+\/[\w.-]+)@([0-9a-f]{40}) # (v\d+(?:\.\d+)*)$/;

function existingPins() {
    const pins = new Map();
    for (const name of readdirSync(WORKFLOWS)) {
        if (name === 'android-runtime.yml' || !/\.ya?ml$/.test(name)) {
            continue;
        }
        for (const match of readFileSync(new URL(name, WORKFLOWS), 'utf8').matchAll(/uses: ([\w.-]+\/[\w.-]+)@([0-9a-f]{40})/g)) {
            pins.set(match[1], [...(pins.get(match[1]) ?? []), match[2]]);
        }
    }
    return pins;
}

// Actions this workflow pins to a different SHA than the other workflows do.
function mismatchedPins(lines) {
    const pins = existingPins();
    return lines.map(line => USES.exec(line.replace(/^\s*(?:-\s+)?uses:\s*/, '')))
        .filter(match => match !== null && pins.has(match[1]) && !pins.get(match[1]).includes(match[2]))
        .map(match => match[1]);
}

describe('Android runtime workflow', () => {
    test('runs only for staging pushes that touch the Node pipeline and for manual dispatch', () => {
        expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch']);
        expect(workflow.on.push).toEqual({
            branches: ['staging'],
            paths: [
                'android/runtime.lock',
                'android/runtime/sources.lock',
                'android/runtime/patches/node/**',
                'android/runtime/build-node.sh',
                '.github/workflows/android-runtime.yml',
            ],
        });
        expect(workflow.on.workflow_dispatch).toEqual({
            inputs: { publish: { description: 'TODO(copy)', type: 'boolean', default: false } },
        });
        expect(source).not.toMatch(/pull_request/);
    });

    test('runs only in the SillyBunnyTeam repository: every other job depends on the guarded plan job', () => {
        expect(jobs.plan.if).toBe('github.repository == \'SillyBunnyTeam/SillyBunny\'');
        expect(jobs.plan.needs).toBeUndefined();
        expect(jobs.build.needs).toBe('plan');
        expect(jobs.publish.needs).toContain('plan');
        expect(jobs['update-lock'].needs).toBe('publish');
        // A status function in a dependent job's condition would let it run after the plan job was skipped.
        for (const [name, job] of Object.entries(jobs)) {
            expect([name, /always\(|cancelled\(|failure\(|success\(/.test(String(job.if ?? ''))]).toEqual([name, false]);
        }
    });

    test('grants no permissions at the top level and only what each job needs', () => {
        expect(workflow.permissions).toEqual({});
        expect(Object.fromEntries(Object.entries(jobs).map(([name, job]) => [name, job.permissions]))).toEqual({
            plan: { contents: 'read' },
            build: { contents: 'read' },
            publish: { contents: 'read', packages: 'write', 'id-token': 'write', attestations: 'write' },
            'update-lock': { contents: 'write', 'pull-requests': 'write' },
        });
    });

    test('uses GitHub-hosted Ubuntu with a timeout on every job, and no environments or secrets', () => {
        for (const [name, job] of Object.entries(jobs)) {
            expect([name, job['runs-on']]).toEqual([name, 'ubuntu-24.04']);
            expect(Number.isInteger(job['timeout-minutes'])).toBe(true);
            expect(job['timeout-minutes']).toBeGreaterThan(0);
            expect(job['timeout-minutes']).toBeLessThanOrEqual(345);
            expect(job.environment).toBeUndefined();
        }
        expect(jobs.build['timeout-minutes']).toBeGreaterThanOrEqual(240);
        expect(source).not.toMatch(/secrets\./);
        expect(source).not.toMatch(/^\s*environment:/m);
    });

    test('pins every action to a full commit SHA with a version comment, matching existing pins', () => {
        const lines = source.split('\n').filter(line => /^\s*(?:-\s+)?uses:/.test(line));
        expect(lines.length).toBe(steps.filter(step => step.uses).length);
        for (const line of lines) {
            expect(line.replace(/^\s*(?:-\s+)?uses:\s*/, '')).toMatch(USES);
        }
        for (const step of steps.filter(step => step.uses)) {
            expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
        }
        expect(mismatchedPins(lines)).toEqual([]);
        expect(existingPins().get('actions/checkout')).toContain('3d3c42e5aac5ba805825da76410c181273ba90b1');
    });

    test('builds exactly the lock ABIs in a matrix that calls build-node.sh', () => {
        const matrix = jobs.build.strategy.matrix;
        expect(Object.keys(matrix)).toEqual(['abi']);
        expect([...matrix.abi].sort()).toEqual([...runtimeLock.abis].sort());
        expect(jobs.build.strategy['fail-fast']).toBe(false);
        expect(jobs.build.needs).toBe('plan');
        expect(jobs.build.if).toBe('needs.plan.outputs.build == \'true\'');
        const build = jobs.build.steps.find(step => step.name === 'Build libnode.so');
        expect(build.run).toBe('bash android/runtime/build-node.sh "$ABI" "$RUNNER_TEMP/node-out/$ABI"');
        expect(build.env).toMatchObject({ ABI: '${{ matrix.abi }}', NODE_BUILD_JOBS: '4', NODE_REQUIRE_SIGNATURE: '1' });
        expect(build.env.NODE_NDK_DIR).toBeUndefined();
        expect(jobs.build.steps.find(step => step.name === 'Install build tools').run).toMatch(/g\+\+-multilib/);
    });

    test('plans a build for dispatches and for pushes only while a digest is unpinned', () => {
        const run = jobs.plan.steps.find(step => step.id === 'plan').run;
        expect(run).toMatch(/update-node-digests\.py --plan/);
        expect(run).toMatch(/GITHUB_EVENT_NAME" = workflow_dispatch/);
        expect(run).toMatch(/\.needsBuild/);
    });

    test('publishes only from staging, for pushes or a dispatch with publish set, one run at a time', () => {
        const publish = jobs.publish;
        expect(publish.needs).toEqual(['plan', 'build']);
        expect(publish.if).toBe('needs.plan.outputs.build == \'true\' && github.ref == \'refs/heads/staging\' '
            + '&& (github.event_name == \'push\' || inputs.publish)');
        expect(publish.concurrency).toEqual({ group: 'android-runtime-publish', 'cancel-in-progress': false });
        expect(workflow.concurrency['cancel-in-progress']).toBe(false);
        expect(jobs['update-lock'].needs).toBe('publish');
        expect(jobs['update-lock'].if).toBeUndefined();
    });

    test.each(runtimeLock.abis)('pushes %s with oras to the lock repository and attests it in the registry', abi => {
        expect(workflow.env.IMAGE).toBe(runtimeLock.node.binaries[abi].repository);
        const attest = jobs.publish.steps.find(step => step.name === `Attest ${abi}`);
        expect(attest.uses).toMatch(/^actions\/attest-build-provenance@/);
        expect(attest.with).toEqual({
            'subject-name': '${{ env.IMAGE }}',
            'subject-digest': `\${{ steps.push.outputs.digest_${abi.replaceAll('-', '_')} }}`,
            'push-to-registry': true,
        });
        const push = jobs.publish.steps.find(step => step.id === 'push').run;
        expect(push).toMatch(/oras push /);
        expect(push).toMatch(/fetch-node\.py --audit/);
        expect(push).toMatch(/oras resolve/);
    });

    test('installs a checksum-pinned oras and logs in with the workflow token only', () => {
        const oras = jobs.publish.steps.find(step => step.uses?.startsWith('oras-project/setup-oras@'));
        expect(oras.with.url).toMatch(/^https:\/\/github\.com\/oras-project\/oras\/releases\/download\/v[\d.]+\/oras_[\d.]+_linux_amd64\.tar\.gz$/);
        expect(oras.with.checksum).toMatch(/^[0-9a-f]{64}$/);
        const login = jobs.publish.steps.find(step => step.uses?.startsWith('docker/login-action@'));
        expect(login.with).toEqual({ registry: 'ghcr.io', username: '${{ github.actor }}', password: '${{ github.token }}' });
    });

    test('opens the digest PR through update-node-digests.py and gh', () => {
        const step = jobs['update-lock'].steps.find(step => step.name === 'Open the digest PR');
        expect(step.env).toEqual({ GH_TOKEN: '${{ github.token }}', PUBLISHED: '${{ needs.publish.outputs.published }}' });
        expect(step.run).toMatch(/update-node-digests\.py --published/);
        expect(step.run).toMatch(/git add android\/runtime\.lock android\/runtime\/sources\.lock\n/);
        expect(step.run).toMatch(/gh pr create --base "\$GITHUB_REF_NAME" --head "\$branch" --title 'TODO\(copy\)' --body 'TODO\(copy\)'/);
    });

    test('lets a re-run of the digest PR job replace its branch and open the PR only once', () => {
        const run = jobs['update-lock'].steps.find(step => step.name === 'Open the digest PR').run;
        expect(run).toMatch(/^branch="android-runtime\/node-digests-\$GITHUB_RUN_ID"$/m);
        expect(run).toMatch(/^git push --force origin "\$branch"$/m);
        expect(run).not.toMatch(/^git push origin/m);
        // An assignment, so a failing gh query fails the step instead of skipping the PR.
        expect(run).toMatch(/^open=\$\(gh pr list --head "\$branch" --state open --json number --jq length\)$/m);
        expect(run).toMatch(/^if \[ "\$open" = 0 \]; then\n {2}gh pr create /m);
    });

    test('keeps expressions out of shell scripts and credentials out of read-only checkouts', () => {
        for (const step of steps.filter(step => step.run)) {
            expect(step.run).not.toMatch(/\$\{\{/);
        }
        for (const [name, job] of Object.entries(jobs)) {
            const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
            expect([name, checkout.with?.['persist-credentials']]).toEqual([name, name === 'update-lock' ? undefined : false]);
        }
    });
});
