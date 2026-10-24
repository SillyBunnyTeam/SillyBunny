/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { parse } from 'yaml';

const WORKFLOWS = new URL('../.github/workflows/', import.meta.url);
const source = readFileSync(new URL('android-runtime.yml', WORKFLOWS), 'utf8');
const workflow = parse(source);
const runtimeLock = JSON.parse(readFileSync(new URL('../android/runtime.lock', import.meta.url), 'utf8'));
const jobs = workflow.jobs;
const steps = Object.values(jobs).flatMap(job => job.steps);
const USES = /^([\w.-]+\/[\w.-]+)@([0-9a-f]{40}) # (v\d+(?:\.\d+)*)$/;
const describePosix = process.platform === 'win32' ? describe.skip : describe;

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
    test('runs only for staging pushes that touch the Node pipeline or the input mirror, and for manual dispatch', () => {
        expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch']);
        expect(workflow.on.push).toEqual({
            branches: ['staging'],
            paths: [
                'android/runtime.lock',
                'android/runtime/sources.lock',
                'android/runtime/patches/node/**',
                'android/runtime/build-node.sh',
                'android/runtime/runtime-mirror.py',
                'android/runtime/sources.py',
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
        expect(jobs.mirror.needs).toBe('plan');
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
            mirror: { contents: 'read', packages: 'write' },
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

    test.each(['publish', 'mirror'])('%s installs a checksum-pinned oras and logs in with the workflow token only', name => {
        const oras = jobs[name].steps.find(step => step.uses?.startsWith('oras-project/setup-oras@'));
        expect(oras.with.url).toMatch(/^https:\/\/github\.com\/oras-project\/oras\/releases\/download\/v[\d.]+\/oras_[\d.]+_linux_amd64\.tar\.gz$/);
        expect(oras.with.checksum).toMatch(/^[0-9a-f]{64}$/);
        const login = jobs[name].steps.find(step => step.uses?.startsWith('docker/login-action@'));
        expect(login.with).toEqual({ registry: 'ghcr.io', username: '${{ github.actor }}', password: '${{ github.token }}' });
    });

    test('plans the input mirror with runtime-mirror.py --plan', () => {
        expect(jobs.plan.outputs).toEqual({ build: '${{ steps.plan.outputs.build }}', mirror: '${{ steps.mirror.outputs.mirror }}' });
        const step = jobs.plan.steps.find(step => step.id === 'mirror');
        expect(step.name).toBe('Check the input mirror');
        expect(step.run).toMatch(/^if python3 -I -B android\/runtime\/runtime-mirror\.py --plan > "\$RUNNER_TEMP\/mirror\.json" \\$/m);
        expect(step.run).toMatch(/\.present/);
    });

    test('publishes the input mirror only from staging, for pushes or a dispatch with publish set, one run at a time', () => {
        expect(jobs.mirror.if).toBe('needs.plan.outputs.mirror == \'true\' && github.ref == \'refs/heads/staging\' '
            + '&& (github.event_name == \'push\' || inputs.publish)');
        expect(jobs.mirror.concurrency).toEqual({ group: 'android-runtime-mirror', 'cancel-in-progress': false });
    });

    test('pushes the input mirror to the repository that runtime.lock names', () => {
        expect(workflow.env.IMAGE).toBe(runtimeLock.mirror.repository);
    });

    test('stages the pinned inputs before it sets up oras and logs in, then pushes and reads the tag back', () => {
        expect(jobs.mirror.steps.map(step => step.name)).toEqual([
            'Checkout Repository',
            'Stage the pinned inputs',
            'Set up oras',
            'Log in to GHCR',
            'Push the mirror',
        ]);
        expect(jobs.mirror.steps[1].run).toBe('python3 -I -B android/runtime/runtime-mirror.py --stage "$RUNNER_TEMP/mirror"');
        const push = jobs.mirror.steps[4].run;
        expect(push).toMatch(/oras push --artifact-type application\/vnd\.sillybunnyteam\.android\.inputs\.v1 /);
        expect(push).toContain('--annotation \'org.opencontainers.image.description=TODO(copy)\'');
        expect(push).toContain('--export-manifest manifest.json "$reference" "${files[@]}"');
        expect(push).toMatch(/^test "\$\(oras resolve "\$reference"\)" = "sha256:\$\(sha256sum "\$stage\/manifest\.json" \| cut -d ' ' -f 1\)"$/m);
        expect(push).toMatch(/^python3 -I -B android\/runtime\/runtime-mirror\.py --check$/m);
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

describePosix('android-runtime.yml mirror step scripts (POSIX)', () => {
    const IMAGE = 'ghcr.io/team/app-runtime';
    const REFERENCE = `${IMAGE}:inputs-0123456789ab`;
    let temp;
    beforeAll(() => {
        temp = realpathSync(mkdtempSync(path.join(tmpdir(), 'android-runtime-workflow-')));
    });
    afterAll(() => {
        rmSync(temp, { recursive: true, force: true });
    });

    /** Runs a `run:` block like the runner's default shell (`bash -e`), in its own RUNNER_TEMP with fake commands first on PATH. */
    function runStep(name, script, { commands, env = {}, cwd } = {}) {
        const dir = path.join(temp, name);
        const bin = path.join(dir, 'bin');
        mkdirSync(bin, { recursive: true });
        for (const [command, body] of Object.entries(commands)) {
            writeFileSync(path.join(bin, command), `#!/usr/bin/env bash\n${body}`);
            chmodSync(path.join(bin, command), 0o755);
        }
        writeFileSync(path.join(dir, 'step.sh'), script);
        writeFileSync(path.join(dir, 'output'), '');
        writeFileSync(path.join(dir, 'log'), '');
        const result = spawnSync('bash', ['-e', path.join(dir, 'step.sh')], {
            cwd: cwd ?? dir,
            env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: process.env.HOME, RUNNER_TEMP: dir, GITHUB_OUTPUT: path.join(dir, 'output'), ...env },
            encoding: 'utf8',
        });
        const calls = readFileSync(path.join(dir, 'log'), 'utf8').split('\n').filter(Boolean).map(line => line.split('\t').slice(0, -1));
        return { code: result.status, output: readFileSync(path.join(dir, 'output'), 'utf8'), calls };
    }

    const logCall = command => `printf '%s\\t' ${command} "$PWD" "$@" >> "$RUNNER_TEMP/log"\nprintf '\\n' >> "$RUNNER_TEMP/log"\n`;

    test('the plan publishes the mirror unless runtime-mirror.py --plan finds its tag, and never fails for it', () => {
        const step = jobs.plan.steps.find(step => step.id === 'mirror');
        const plan = (name, stdout, status) => runStep(name, step.run, {
            commands: { python3: `${logCall('python3')}printf '%s\\n' '${stdout}'\nexit ${status}\n` },
        });
        const present = plan('plan-present', JSON.stringify({ reference: REFERENCE, present: true }), 0);
        expect([present.code, present.output]).toEqual([0, 'mirror=false\n']);
        expect(present.calls).toEqual([['python3', path.join(temp, 'plan-present'), '-I', '-B', 'android/runtime/runtime-mirror.py', '--plan']]);
        expect(plan('plan-missing', JSON.stringify({ reference: REFERENCE, present: false }), 0)).toMatchObject({ code: 0, output: 'mirror=true\n' });
        // --plan exits 1 when it cannot tell, for example while GHCR is unreachable.
        expect(plan('plan-unknown', '', 1)).toMatchObject({ code: 0, output: 'mirror=true\n' });
    });

    test('the push runs oras in the staged folder with every staged file, checks the manifest digest, then checks the tag anonymously', () => {
        const step = jobs.mirror.steps.find(step => step.name === 'Push the mirror');
        const files = [
            'debs/ca-certificates_1:2026.10.20-1_all.deb:application/vnd.debian.binary-package',
            `objects/${'ab'.repeat(32)}:application/octet-stream`,
        ];
        const oras = [
            logCall('oras'),
            'if [ "$1" = push ]; then',
            '    while [ "$#" -gt 0 ]; do [ "$1" != --export-manifest ] || printf \'{"layers":[]}\' > "$2"; shift; done',
            'elif [ "$1" = resolve ]; then',
            '    echo "${FAKE_DIGEST:-sha256:$(sha256sum "$RUNNER_TEMP/mirror/manifest.json" | cut -d \' \' -f 1)}"',
            'fi',
            '',
        ].join('\n');
        const push = (name, { reference = REFERENCE, env = {} } = {}) => {
            const stage = path.join(temp, name, 'mirror');
            const checkout = path.join(temp, name, 'checkout');
            mkdirSync(stage, { recursive: true });
            mkdirSync(checkout);
            writeFileSync(path.join(stage, 'reference'), `${reference}\n`);
            writeFileSync(path.join(stage, 'oras-files'), `${files.join('\n')}\n`);
            const result = runStep(name, step.run, {
                cwd: checkout,
                env: { IMAGE, GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'team/app', ...env },
                commands: { oras, python3: `${logCall('python3')}exit "\${CHECK_STATUS:-0}"\n` },
            });
            return { ...result, stage, checkout };
        };

        const pushed = push('push-ok');
        expect(pushed.code).toBe(0);
        expect(pushed.calls).toEqual([
            ['oras', pushed.stage, 'push', '--artifact-type', 'application/vnd.sillybunnyteam.android.inputs.v1',
                '--annotation', 'org.opencontainers.image.source=https://github.com/team/app',
                '--annotation', 'org.opencontainers.image.description=TODO(copy)',
                '--export-manifest', 'manifest.json', REFERENCE, ...files],
            ['oras', pushed.checkout, 'resolve', REFERENCE],
            ['python3', pushed.checkout, '-I', '-B', 'android/runtime/runtime-mirror.py', '--check'],
        ]);

        // The registry's tag must name the manifest this push exported.
        const moved = push('push-moved', { env: { FAKE_DIGEST: `sha256:${'0'.repeat(64)}` } });
        expect([moved.code, moved.calls.map(call => call.slice(0, 3))]).toEqual([1, [['oras', moved.stage, 'push'], ['oras', moved.checkout, 'resolve']]]);
        // A lock that names another repository than IMAGE pushes nothing.
        const elsewhere = push('push-elsewhere', { reference: 'ghcr.io/team/other:inputs-0123456789ab' });
        expect([elsewhere.code, elsewhere.calls]).toEqual([1, []]);
        // Builds read the mirror anonymously, so a tag they cannot read fails the job.
        expect(push('push-unreadable', { env: { CHECK_STATUS: '1' } }).code).toBe(1);
    });
});
