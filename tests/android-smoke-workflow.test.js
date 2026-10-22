import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from '@jest/globals';
import { parse } from 'yaml';

import { OPTIONS } from './android-smoke/run-smoke.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOWS = path.join(repoRoot, '.github', 'workflows');
const RUN_SMOKE = fileURLToPath(new URL('android-smoke/run-smoke.js', import.meta.url));
const ANDROID_SMOKE = './.github/workflows/android-smoke.yml';
const EMULATOR_RUNNER = 'reactivecircus/android-emulator-runner@a421e43855164a8197daf9d8d40fe71c6996bb0d';
const PINNED = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;
const PINNED_LINE = /^([\w.-]+\/[\w.-]+)@([0-9a-f]{40}) # (v\d+(?:\.\d+)*)$/;
const ON_FAILURE = 'failure() || cancelled()';
const ERROR_ANNOTATION = '::error title=TODO(copy)::TODO(copy)';
// Plan §7.1's list, plus the smoke's own workflow and harness, and the tests package files the harness loads.
const ANDROID_FILES = [
    'android/*',
    'start.sh',
    'scripts/*',
    'src/middleware/launchToken.js',
    'src/server-main.js',
    'src/android-app-gate.js',
    'src/endpoints/server-admin.js',
    'package.json',
    'package-lock.json',
    'bun.lock',
    '.npmrc',
    '.github/workflows/android-smoke.yml',
    'tests/android-smoke/*',
    'tests/frontend/frontent-test-utils.js',
    'tests/package.json',
    'tests/package-lock.json',
];
const describePosix = process.platform === 'win32' ? describe.skip : describe;

function readWorkflow(name) {
    const source = fs.readFileSync(path.join(WORKFLOWS, name), 'utf8');
    return { source, workflow: parse(source) };
}

const smoke = readWorkflow('android-smoke.yml');
const bootstrap = readWorkflow('bootstrap-smoke.yml');
const nightly = readWorkflow('nightly.yml');
const jobs = smoke.workflow.jobs;

const stepNamed = (job, name) => job.steps.find(step => step.name === name);
const stepRunning = (job, text) => job.steps.findIndex(step => String(step.run ?? '').includes(text));

/** Job-level calls and step-level actions of a workflow. */
function usesOf(workflow) {
    const all = Object.values(workflow.jobs);
    return {
        calls: all.map(job => job.uses).filter(value => value !== undefined),
        actions: all.flatMap(job => job.steps ?? []).map(step => step.uses).filter(value => value !== undefined),
    };
}

/** Every `uses:` value as written, comment included. */
function usesLines(source) {
    return source.split('\n')
        .filter(line => /^\s*(?:-\s+)?uses:/.test(line))
        .map(line => line.replace(/^\s*(?:-\s+)?uses:\s*/, '').trim());
}

/** Actions that `lines` pins to another SHA than the other workflows do. */
function mismatchedPins(lines, workflowName) {
    const pins = new Map();
    for (const name of fs.readdirSync(WORKFLOWS)) {
        if (name === workflowName || !/\.ya?ml$/.test(name)) {
            continue;
        }
        for (const match of fs.readFileSync(path.join(WORKFLOWS, name), 'utf8').matchAll(/uses: ([\w.-]+\/[\w.-]+)@([0-9a-f]{40})/g)) {
            pins.set(match[1], [...(pins.get(match[1]) ?? []), match[2]]);
        }
    }
    return lines.map(line => PINNED_LINE.exec(line))
        .filter(match => match !== null && pins.has(match[1]) && !pins.get(match[1]).includes(match[2]))
        .map(match => match[1]);
}

/** Runs a `run:` block like the runner's default shell (`bash -e`) and returns what it wrote to GITHUB_OUTPUT. */
function runStep(script, { env = {}, cwd } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'android-smoke-workflow-'));
    try {
        const file = path.join(dir, 'step.sh');
        const output = path.join(dir, 'output');
        fs.writeFileSync(file, script);
        fs.writeFileSync(output, '');
        const result = spawnSync('bash', ['-e', file], {
            cwd: cwd ?? dir,
            env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env, GITHUB_OUTPUT: output },
            encoding: 'utf8',
        });
        return { code: result.status, stdout: result.stdout, stderr: result.stderr, outputs: fs.readFileSync(output, 'utf8') };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function git(cwd, args) {
    const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: os.devNull,
            GIT_AUTHOR_NAME: 'Smoke',
            GIT_AUTHOR_EMAIL: 'smoke@sillybunny.invalid',
            GIT_COMMITTER_NAME: 'Smoke',
            GIT_COMMITTER_EMAIL: 'smoke@sillybunny.invalid',
        },
    });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    }
}

/**
 * Runs bootstrap-smoke's change detection in a repository whose HEAD commit changes `files` and moves
 * `renames` ([from, to] pairs of `base` files from the first commit). `HEAD^1` stands in for the pull
 * request merge commit's first parent. Git runs with its default settings, as on the runner.
 */
function detectChanges(files, { event = 'pull_request', parent = true, base = [], renames = [] } = {}) {
    const detect = bootstrap.workflow.jobs['android-changes'].steps.find(step => step.id === 'detect');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'android-smoke-changes-'));
    const write = (file, contents) => {
        const target = path.join(repo, ...file.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
    };
    try {
        git(repo, ['init', '--quiet']);
        fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
        for (const file of base) {
            write(file, `${file}\n`.repeat(20));
        }
        if (parent) {
            git(repo, ['add', '-A']);
            git(repo, ['commit', '--quiet', '-m', 'base']);
        }
        for (const [from, to] of renames) {
            fs.mkdirSync(path.dirname(path.join(repo, ...to.split('/'))), { recursive: true });
            fs.renameSync(path.join(repo, ...from.split('/')), path.join(repo, ...to.split('/')));
        }
        for (const file of files) {
            write(file, 'change\n');
        }
        git(repo, ['add', '-A']);
        git(repo, ['commit', '--quiet', '--allow-empty', '-m', 'change']);
        return runStep(detect.run, {
            cwd: repo,
            env: { EVENT_NAME: event, ANDROID_FILES: detect.env.ANDROID_FILES, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
        });
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
    }
}

/** Runs `run-smoke.js guard` on a lock file, with the GitHub file commands in a temporary directory. */
function runGuard(lock) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'android-smoke-guard-'));
    try {
        const lockFile = path.join(dir, 'runtime.lock');
        const output = path.join(dir, 'output');
        const summary = path.join(dir, 'summary');
        fs.writeFileSync(lockFile, typeof lock === 'string' ? lock : JSON.stringify(lock));
        const result = spawnSync(process.execPath, [RUN_SMOKE, 'guard', '--runtime-lock', lockFile], {
            env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
            encoding: 'utf8',
        });
        const read = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
        return { code: result.status, stdout: result.stdout, outputs: read(output), summary: read(summary) };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const realLock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'android', 'runtime.lock'), 'utf8'));

function lockWith(pinned) {
    const lock = structuredClone(realLock);
    for (const abi of lock.abis) {
        const entry = lock.node.binaries[abi];
        Object.assign(entry, pinned.includes(abi)
            ? { digest: `sha256:${'a'.repeat(64)}`, sha256: 'b'.repeat(64), size: 1234 }
            : { digest: null, sha256: null, size: null });
    }
    return lock;
}

describe('android-smoke.yml interface', () => {
    test('is called only, with optional default-ref and ref inputs and an outcome output', () => {
        expect(Object.keys(smoke.workflow.on)).toEqual(['workflow_call']);
        const call = smoke.workflow.on.workflow_call;
        expect(Object.keys(call).sort()).toEqual(['inputs', 'outputs']);
        expect(call.inputs).toEqual({
            'default-ref': { type: 'string', required: false, default: 'staging' },
            'ref': { type: 'string', required: false, default: '' },
        });
        expect(call.outputs).toEqual({ outcome: { value: '${{ jobs.result.outputs.outcome }}' } });
    });

    test('takes no secrets or environments and grants every job only contents: read', () => {
        expect(smoke.source).not.toMatch(/\bsecrets\s*[.:]|inherit/);
        expect(smoke.source).not.toMatch(/^\s*environment:/m);
        expect(smoke.workflow.permissions).toEqual({});
        expect(Object.fromEntries(Object.entries(jobs).map(([name, job]) => [name, job.permissions]))).toEqual({
            plan: { contents: 'read' },
            build: { contents: 'read' },
            smoke: { contents: 'read' },
            result: { contents: 'read' },
        });
    });

    test('checks default-ref in the first step, and every later use goes through the checked value', () => {
        const first = jobs.plan.steps[0];
        expect(first.id).toBe('default-ref');
        expect(first.env).toEqual({ DEFAULT_REF: '${{ inputs.default-ref }}' });
        // inputs.ref appears only as the three checkouts' ref (see the pinning test), never in shell text.
        expect(smoke.source.match(/inputs\.[\w-]+/g)).toEqual(['inputs.default-ref', 'inputs.ref', 'inputs.ref', 'inputs.ref']);
        expect(jobs.plan.outputs['default-ref']).toBe('${{ steps.default-ref.outputs.default-ref }}');
        expect(jobs.build.env).toEqual({ DEFAULT_REF: '${{ needs.plan.outputs.default-ref }}' });
        expect(stepNamed(jobs.smoke, 'Run the smoke').env.SMOKE_DEFAULT_REF).toBe('${{ needs.plan.outputs.default-ref }}');
        // run-smoke.js accepts the same two values.
        expect(Object.keys(OPTIONS)).toContain('default-ref');
    });

    test('reports skipped or passed from the result job, which runs whenever the call was not cancelled', () => {
        expect(jobs.result.needs).toEqual(['plan', 'build', 'smoke']);
        expect(jobs.result.if).toBe('${{ !cancelled() }}');
        expect(jobs.result.outputs).toEqual({ outcome: '${{ steps.outcome.outputs.outcome }}' });
        expect(jobs.result.steps[0].env).toEqual({
            PLAN: '${{ needs.plan.result }}',
            RUN: '${{ needs.plan.outputs.run }}',
            REASON: '${{ needs.plan.outputs.reason }}',
            BUILD: '${{ needs.build.result }}',
            SMOKE: '${{ needs.smoke.result }}',
        });
    });
});

describePosix('android-smoke.yml step scripts', () => {
    test('the default-ref check accepts staging and release', () => {
        const step = jobs.plan.steps[0];
        const results = ['staging', 'release'].map(value => runStep(step.run, { env: { DEFAULT_REF: value } }));
        expect(results.map(result => [result.code, result.outputs])).toEqual([
            [0, 'default-ref=staging\n'],
            [0, 'default-ref=release\n'],
        ]);
    });

    test('the default-ref check fails on any other value, with an annotation and a machine code', () => {
        const step = jobs.plan.steps[0];
        for (const value of ['main', '', 'Staging', 'release ', 'staging\nrun=true']) {
            const result = runStep(step.run, { env: { DEFAULT_REF: value } });
            expect([value, result.code, result.outputs]).toEqual([value, 1, '']);
            expect(result.stdout).toContain(ERROR_ANNOTATION);
            expect(JSON.parse(result.stderr)).toEqual({ code: 'invalid-default-ref', allowed: ['staging', 'release'] });
        }
    });

    test('the outcome is skipped only for an unpinned lock, passed only when everything passed', () => {
        const step = jobs.result.steps[0];
        const ran = { PLAN: 'success', RUN: 'true', REASON: 'node-digests-pinned' };
        const cases = [
            [{ PLAN: 'success', RUN: 'false', REASON: 'node-digests-unpinned', BUILD: 'skipped', SMOKE: 'skipped' }, 0, 'outcome=skipped\n'],
            [{ ...ran, BUILD: 'success', SMOKE: 'success' }, 0, 'outcome=passed\n'],
            [{ PLAN: 'failure', RUN: 'false', REASON: 'node-digests-partial', BUILD: 'skipped', SMOKE: 'skipped' }, 1, ''],
            [{ PLAN: 'failure', RUN: '', REASON: '', BUILD: 'skipped', SMOKE: 'skipped' }, 1, ''],
            [{ PLAN: 'success', RUN: '', REASON: '', BUILD: 'skipped', SMOKE: 'skipped' }, 1, ''],
            [{ ...ran, BUILD: 'failure', SMOKE: 'skipped' }, 1, ''],
            [{ ...ran, BUILD: 'skipped', SMOKE: 'skipped' }, 1, ''],
            [{ ...ran, BUILD: 'success', SMOKE: 'failure' }, 1, ''],
            [{ ...ran, BUILD: 'success', SMOKE: 'cancelled' }, 1, ''],
        ];
        const results = cases.map(([env]) => runStep(step.run, { env }));
        expect(results.map(result => [result.code, result.outputs])).toEqual(cases.map(([, code, outputs]) => [code, outputs]));
        for (const [index, result] of results.entries()) {
            const failed = cases[index][1] === 1;
            expect([index, result.stdout.includes(ERROR_ANNOTATION)]).toEqual([index, failed]);
        }
        expect(JSON.parse(results[5].stderr)).toEqual({ plan: 'success', run: 'true', reason: 'node-digests-pinned', build: 'failure', smoke: 'skipped' });
    });

    test('the acceleration check prints the emulator\'s reason, then fails on its exit status or a missing usable line', () => {
        const step = stepNamed(jobs.smoke, 'Check the hardware acceleration');
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'android-smoke-accel-'));
        const emulator = path.join(home, 'emulator', 'emulator');
        const check = (output, code) => {
            fs.writeFileSync(path.join(home, 'accel.txt'), output);
            fs.writeFileSync(emulator, `#!/bin/sh\ncat "$ANDROID_HOME/accel.txt"\nexit ${code}\n`, { mode: 0o755 });
            return runStep(step.run, { env: { ANDROID_HOME: home } });
        };
        const usable = 'accel:\n0\nKVM (version 12) is installed and usable.\naccel\n';
        const missing = 'accel:\n9\n/dev/kvm is not found: VT disabled in BIOS or KVM kernel module not loaded\naccel\n';
        try {
            fs.mkdirSync(path.dirname(emulator));
            const results = [check(usable, 0), check(missing, 9), check(usable, 1), check('accel:\n0\naccel\n', 0)];
            expect(results.map(result => result.code === 0)).toEqual([true, false, false, false]);
            expect(results[0].stdout).toContain('is installed and usable');
            expect(results[1].stdout).toContain('/dev/kvm is not found');
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});

describe('android-smoke.yml jobs', () => {
    test('gates the build and the emulators on the runtime-lock guard', () => {
        expect(Object.keys(jobs)).toEqual(['plan', 'build', 'smoke', 'result']);
        expect(jobs.plan.needs).toBeUndefined();
        expect(jobs.plan.if).toBeUndefined();
        expect(jobs.plan.outputs).toEqual({
            run: '${{ steps.guard.outputs.run }}',
            reason: '${{ steps.guard.outputs.reason }}',
            'default-ref': '${{ steps.default-ref.outputs.default-ref }}',
        });
        expect(stepNamed(jobs.plan, 'Check the Node runtime pins')).toEqual({
            name: 'Check the Node runtime pins',
            id: 'guard',
            run: 'node tests/android-smoke/run-smoke.js guard --runtime-lock android/runtime.lock',
        });
        expect(jobs.build.needs).toBe('plan');
        expect(jobs.build.if).toBe('needs.plan.outputs.run == \'true\'');
        expect(jobs.smoke.needs).toEqual(['plan', 'build']);
        expect(jobs.smoke.if).toBe('needs.plan.outputs.run == \'true\'');
    });

    test('the guard skips a lock without Node digests, runs a pinned one and fails a partial one', () => {
        const unpinned = runGuard(lockWith([]));
        expect(unpinned.code).toBe(0);
        expect(unpinned.outputs).toBe('run=false\nreason=node-digests-unpinned\n');
        expect(unpinned.stdout).toContain('::notice title=TODO(copy)::TODO(copy)');
        expect(unpinned.summary).toContain('- outcome: `skipped`');
        expect(unpinned.summary).toContain('- reason: `node-digests-unpinned`');

        const pinned = runGuard(lockWith(realLock.abis));
        expect([pinned.code, pinned.outputs, pinned.summary]).toEqual([0, 'run=true\nreason=node-digests-pinned\n', '']);
        expect(pinned.stdout).not.toContain('::notice');

        const partial = runGuard(lockWith(realLock.abis.slice(0, 1)));
        expect([partial.code, partial.outputs, partial.summary]).toEqual([1, 'run=false\nreason=node-digests-partial\n', '']);
        expect(partial.stdout).toContain(ERROR_ANNOTATION);

        const broken = runGuard('{');
        expect([broken.code, broken.outputs]).toEqual([1, 'run=false\nreason=runtime-lock-invalid\n']);
    });

    test('builds the test APKs from the runtime inputs in track p45b order', () => {
        const order = [
            'bash android/runtime/fetch-termux.sh',
            'python3 -B android/runtime/fetch-node.py',
            'python3 -B android/runtime/build-npm.py',
            'bash android/runtime/build-sources.sh --require-node',
            ':app:assembleDebug :app:assembleDebugAndroidTest',
        ].map(text => stepRunning(jobs.build, text));
        expect(order.every(index => index >= 0)).toBe(true);
        expect([...order].sort((left, right) => left - right)).toEqual(order);
        expect(stepNamed(jobs.build, 'Set up oras').uses).toMatch(/^oras-project\/setup-oras@[0-9a-f]{40}$/);

        const apks = stepNamed(jobs.build, 'Build the test APKs');
        expect(apks['working-directory']).toBe('android');
        expect(apks.run).toContain('urls=$(node ../tests/android-smoke/run-smoke.js gradle-args --format args)');
        expect(apks.run).toContain('test "${#fixture_urls[@]}" -eq 3');
        expect(apks.run).toContain('./gradlew --no-daemon --console=plain -PrequireRuntime -PincludeX86_64 "-PdefaultRef=$DEFAULT_REF"');
        expect(apks.run).toContain('app-x86_64-debug.apk "$RUNNER_TEMP/android-smoke-apks/app.apk"');
        expect(apks.run).toContain('app-debug-androidTest.apk "$RUNNER_TEMP/android-smoke-apks/test.apk"');
    });

    test('builds the step 6 update APK with versionCode + 1 and checks every ABI for Bun', () => {
        const update = stepNamed(jobs.build, 'Build the update APK');
        expect(update.run).toContain('sed -i "s/^versionCode=.*/versionCode=$((version_code + 1))/" app-version.properties');
        expect(update.run).toContain('grep -qx "versionCode=$((version_code + 1))" app-version.properties');
        expect(update.run).toContain('"$RUNNER_TEMP/android-smoke-apks/update.apk"');
        const bun = stepNamed(jobs.build, 'Check the APKs for Bun').run;
        for (const abi of realLock.abis) {
            expect(bun).toMatch(abi === 'x86_64' ? /--apk "\$RUNNER_TEMP\/android-smoke-apks\/app\.apk"/ : new RegExp(`app-${abi}-debug\\.apk`));
        }
        expect(bun).toContain('--apk "$RUNNER_TEMP/android-smoke-apks/update.apk"');
    });

    test('installs the SDK packages the app build names, with JDK 21', () => {
        const gradle = fs.readFileSync(path.join(repoRoot, 'android', 'app', 'build.gradle.kts'), 'utf8');
        const ndk = /ndkVersion = "([^"]+)"/.exec(gradle)[1];
        const buildTools = /buildToolsVersion = "([^"]+)"/.exec(gradle)[1];
        const compileSdk = /version = release\((\d+)\)/.exec(gradle)[1];
        const sdk = stepNamed(jobs.build, 'Set up JDK 21 and the Android SDK packages').run;
        expect(sdk).toContain(`'platforms;android-${compileSdk}.0' 'build-tools;${buildTools}' 'ndk;${ndk}'`);
        expect(sdk).toContain('echo "JAVA_HOME=$JAVA_HOME_21_X64" >> "$GITHUB_ENV"');
    });

    test('hands the APKs to the emulators as one artifact', () => {
        const upload = stepNamed(jobs.build, 'Upload the test APKs');
        const download = stepNamed(jobs.smoke, 'Download the test APKs');
        expect(upload.with).toMatchObject({ name: 'android-smoke-apks', path: '${{ runner.temp }}/android-smoke-apks', 'if-no-files-found': 'error' });
        expect(download.with).toEqual({ name: 'android-smoke-apks', path: '${{ runner.temp }}/android-smoke-apks' });
        expect(stepNamed(jobs.smoke, 'Run the smoke').env.SMOKE_APKS).toBe('${{ runner.temp }}/android-smoke-apks');
    });

    test('runs API 29 and 36 default and API 37.0 google_apis_ps16k, all x86_64', () => {
        expect(jobs.smoke.strategy).toEqual({
            'fail-fast': false,
            matrix: {
                include: [
                    { 'api-level': '29', target: 'default' },
                    { 'api-level': '36', target: 'default' },
                    { 'api-level': '37.0', target: 'google_apis_ps16k' },
                ],
            },
        });
        expect(stepNamed(jobs.smoke, 'Run the smoke').with).toMatchObject({
            'api-level': '${{ matrix.api-level }}',
            target: '${{ matrix.target }}',
            arch: 'x86_64',
        });
    });

    test('boots with KVM checked, the pinned emulator and Command-line Tools 23.0, and 4 GB of RAM', () => {
        const names = jobs.smoke.steps.map(step => step.name);
        const runner = stepNamed(jobs.smoke, 'Run the smoke');
        expect(runner.uses).toBe(EMULATOR_RUNNER);
        expect(runner.with).toMatchObject({
            'emulator-build': '16428233',
            'ram-size': '4096M',
            'disable-linux-hw-accel': false,
            'force-avd-creation': true,
        });
        const options = runner.with['emulator-options'].split(' ');
        expect(options).toEqual(expect.arrayContaining(['-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot']));
        expect(options[options.indexOf('-accel') + 1]).toBe('on');
        expect(options.filter(option => option === '-accel')).toHaveLength(1);

        expect(stepNamed(jobs.smoke, 'Enable KVM').run).toContain('test -r /dev/kvm && test -w /dev/kvm');
        const accel = stepNamed(jobs.smoke, 'Check the hardware acceleration').run;
        expect(accel).toContain('accel=$("$ANDROID_HOME/emulator/emulator" -accel-check 2>&1) || status=$?');
        expect(accel).toContain('test "$status" -eq 0');
        expect(accel).toContain('grep -q \'is installed and usable\' <<< "$accel"');

        const tools = stepNamed(jobs.smoke, 'Pin Command-line Tools 23.0').run;
        expect(tools).toContain('--install \'cmdline-tools;23.0\'');
        expect(tools).toContain('mv "$tools/23.0" "$tools/latest"');
        expect(tools).toContain('grep -qx \'Pkg.Revision=23.0\' "$tools/latest/source.properties"');
        const order = ['Pin Command-line Tools 23.0', 'Enable KVM', 'Check the hardware acceleration', 'Run the smoke'].map(name => names.indexOf(name));
        expect(order.every(index => index >= 0)).toBe(true);
        expect([...order].sort((left, right) => left - right)).toEqual(order);
    });

    test('runs preflight (accel, AVD target, UI and a 90 s DNS wait) and then the steps, one command per line', () => {
        const runner = stepNamed(jobs.smoke, 'Run the smoke');
        // The action runs each line with `sh -c` and drops lines starting with #.
        const lines = runner.with.script.trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatch(/^node tests\/android-smoke\/run-smoke\.js preflight /);
        expect(lines[0]).toContain('--api-level "$SMOKE_API_LEVEL" --avd test --emulator-build 16428233');
        expect(lines[0]).toContain('--dns-timeout-seconds 90');
        expect(lines[1]).toMatch(/^node tests\/android-smoke\/run-smoke\.js run /);
        expect(lines[1]).toContain('--apk "$SMOKE_APKS/app.apk" --update-apk "$SMOKE_APKS/update.apk" --test-apk "$SMOKE_APKS/test.apk"');
        expect(lines[1]).toContain('--default-ref "$SMOKE_DEFAULT_REF" --idle-wait-minutes 10');
        for (const line of lines) {
            expect(line).not.toMatch(/\\$|&&|\|\||;|^\s*#/);
            const options = [...line.matchAll(/ --([a-z-]+)/g)].map(match => match[1]);
            expect(options.filter(option => !Object.hasOwn(OPTIONS, option))).toEqual([]);
        }
        expect(runner.env.SMOKE_API_LEVEL).toBe('${{ matrix.api-level }}');
        expect(runner.with['emulator-boot-timeout']).toBeGreaterThanOrEqual(600);
    });

    test('installs the test dependencies like nightly does', () => {
        const install = stepNamed(jobs.smoke, 'Install test dependencies');
        expect(install).toEqual({
            name: 'Install test dependencies',
            env: { NPM_CONFIG_USERCONFIG: '${{ github.workspace }}/.npmrc' },
            run: 'npm ci --ignore-scripts --prefix tests',
        });
    });

    test('pins every action to a full commit SHA with a version comment, matching the other workflows', () => {
        const lines = usesLines(smoke.source);
        const { calls, actions } = usesOf(smoke.workflow);
        expect(calls).toEqual([]);
        expect(lines).toHaveLength(actions.length);
        for (const line of lines) {
            expect(line).toMatch(PINNED_LINE);
        }
        for (const reference of actions) {
            expect(reference).toMatch(PINNED);
        }
        expect(mismatchedPins(lines, 'android-smoke.yml')).toEqual([]);
        expect(lines).toContain(`${EMULATOR_RUNNER} # v2.38.0`);
        const checkouts = Object.values(jobs).flatMap(job => job.steps).filter(step => String(step.uses).startsWith('actions/checkout@'));
        expect(checkouts.map(step => step.with)).toEqual(checkouts.map(() => ({ 'ref': '${{ inputs.ref }}', 'persist-credentials': false })));
    });

    test('times out every job on GitHub-hosted Ubuntu 24.04', () => {
        for (const [name, job] of Object.entries(jobs)) {
            expect([name, job['runs-on']]).toEqual([name, 'ubuntu-24.04']);
            expect([name, Number.isInteger(job['timeout-minutes'])]).toEqual([name, true]);
            expect(job['timeout-minutes']).toBeGreaterThan(0);
            expect(job['timeout-minutes']).toBeLessThanOrEqual(360);
        }
        expect(jobs.smoke['timeout-minutes']).toBeGreaterThanOrEqual(120);
    });

    test('cancels superseded pull request runs in a group of its own', () => {
        expect(smoke.workflow.concurrency).toEqual({
            group: 'android-smoke-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
            'cancel-in-progress': '${{ github.event_name == \'pull_request\' }}',
        });
        // A called workflow sees the caller's github.workflow; sharing the caller's group would deadlock.
        expect(smoke.workflow.concurrency.group).not.toBe(bootstrap.workflow.concurrency.group);
    });

    test('uploads logs and reports only on failure, never android/.gradle/', () => {
        const uploads = Object.values(jobs).flatMap(job => job.steps).filter(step => String(step.uses).startsWith('actions/upload-artifact@'));
        expect(uploads.map(step => [step.name, step.if])).toEqual([
            ['Upload the test APKs', undefined],
            ['Upload build reports', ON_FAILURE],
            ['Upload smoke logs', ON_FAILURE],
        ]);
        for (const step of uploads) {
            expect(step.with.path).not.toMatch(/\.gradle|\.android|keystore|secret|signing/i);
        }
        expect(stepNamed(jobs.build, 'Upload build reports').with.path.trim().split('\n')).toEqual([
            'android/app/build/reports/',
            'android/build/reports/',
            '${{ runner.temp }}/sdkmanager.log',
        ]);
        expect(stepNamed(jobs.smoke, 'Upload smoke logs').with).toMatchObject({
            name: 'android-smoke-logs-api-${{ matrix.api-level }}-${{ github.run_attempt }}',
            path: '${{ runner.temp }}/android-smoke-out/',
        });
        expect(stepNamed(jobs.smoke, 'Run the smoke').env.SMOKE_OUT).toBe('${{ runner.temp }}/android-smoke-out');
    });
});

describe('bootstrap-smoke.yml Android jobs', () => {
    const bootstrapJobs = bootstrap.workflow.jobs;

    test('adds change detection and the gated call next to the unchanged smoke jobs, with no file filter', () => {
        expect(Object.keys(bootstrapJobs)).toEqual(['posix', 'windows', 'android-changes', 'android']);
        expect(bootstrap.source).not.toContain('paths:');
        expect(bootstrapJobs.posix.needs).toBeUndefined();
        expect(bootstrapJobs.windows.needs).toBeUndefined();
    });

    test('detects changes with a script step over the plan §7.1 file list', () => {
        const changes = bootstrapJobs['android-changes'];
        expect(changes).toMatchObject({
            'runs-on': 'ubuntu-24.04',
            'timeout-minutes': 5,
            permissions: { contents: 'read' },
            outputs: { run: '${{ steps.detect.outputs.run }}' },
        });
        expect(changes.steps[0].with).toEqual({ 'fetch-depth': 2, 'persist-credentials': false });
        const detect = changes.steps.find(step => step.id === 'detect');
        expect(detect.env.EVENT_NAME).toBe('${{ github.event_name }}');
        expect(detect.env.ANDROID_FILES.trim().split('\n')).toEqual(ANDROID_FILES);
        expect(detect.run).toContain('changed=$(git diff --no-renames --name-only -z HEAD^1 HEAD | tr \'\\0\' \'\\n\')');
    });

    test('calls the Android smoke only after a relevant change, with nothing but uses, with, permissions, needs and if', () => {
        expect(bootstrapJobs.android).toEqual({
            needs: 'android-changes',
            if: 'needs.android-changes.outputs.run == \'true\'',
            permissions: { contents: 'read' },
            uses: ANDROID_SMOKE,
            with: { 'default-ref': '${{ github.base_ref == \'release\' && \'release\' || \'staging\' }}' },
        });
    });

    test('pins every action and calls only the Android smoke locally', () => {
        const { calls, actions } = usesOf(bootstrap.workflow);
        expect(calls).toEqual([ANDROID_SMOKE]);
        const lines = usesLines(bootstrap.source).filter(line => line !== ANDROID_SMOKE);
        expect(lines).toHaveLength(actions.length);
        for (const line of lines) {
            expect(line).toMatch(PINNED_LINE);
        }
        expect(mismatchedPins(lines, 'bootstrap-smoke.yml')).toEqual([]);
    });

    test('times out every job except the calling job, where GitHub does not allow it', () => {
        for (const [name, job] of Object.entries(bootstrapJobs)) {
            const calls = job.uses !== undefined;
            expect([name, Number.isInteger(job['timeout-minutes'])]).toEqual([name, !calls]);
        }
    });
});

describePosix('bootstrap-smoke.yml change detection', () => {
    test('runs the smoke for Android-relevant files only', () => {
        const cases = [
            [['README.md'], false],
            [['docs/android-apk-plan.md'], false],
            [['tests/jest.config.json'], false],
            [['tests/frontend/chat.e2e.js'], false],
            [['src/endpoints/characters.js', 'public/index.html'], false],
            [['src/middleware/basicAuth.js'], false],
            [['tests/android-smoke-workflow.test.js'], false],
            [['android/app/build.gradle.kts'], true],
            [['android/runtime.lock'], true],
            [['scripts/bootstrap/install.sh'], true],
            [['start.sh'], true],
            [['src/middleware/launchToken.js'], true],
            [['src/server-main.js'], true],
            [['src/android-app-gate.js'], true],
            [['src/endpoints/server-admin.js'], true],
            [['package.json'], true],
            [['package-lock.json'], true],
            [['bun.lock'], true],
            [['.npmrc'], true],
            [['.github/workflows/android-smoke.yml'], true],
            [['tests/android-smoke/run-smoke.js'], true],
            [['tests/frontend/frontent-test-utils.js'], true],
            [['tests/package.json'], true],
            [['tests/package-lock.json'], true],
            [['docs/a b.md', 'android/res/x y.txt'], true],
        ];
        const results = cases.map(([files]) => detectChanges(files));
        expect(results.map(result => [result.code, result.outputs])).toEqual(cases.map(([, run]) => [0, `run=${run}\n`]));
    });

    test('counts both paths of a rename, and names git would quote', () => {
        const cases = [
            [{ base: ['android/app/proguard-rules.pro'], renames: [['android/app/proguard-rules.pro', 'docs/proguard-rules.pro']] }, true],
            [{ base: ['docs/notes.md'], renames: [['docs/notes.md', 'android/notes.md']] }, true],
            [{ base: ['docs/notes.md'], renames: [['docs/notes.md', 'docs/moved.md']] }, false],
            [{ files: ['android/app/src/main/res/raw/café.txt'] }, true],
            [{ files: ['android/a "quoted" \\ name.txt'] }, true],
            [{ files: ['docs/café.md'] }, false],
        ];
        const results = cases.map(([change]) => detectChanges(change.files ?? [], change));
        expect(results.map(result => [result.code, result.outputs])).toEqual(cases.map(([, run]) => [0, `run=${run}\n`]));
        expect(results[0].stdout).toContain('Android-relevant: android/app/proguard-rules.pro');
        expect(results[3].stdout).toContain('Android-relevant: android/app/src/main/res/raw/café.txt');
    });

    test('runs the smoke for every manual run', () => {
        const result = detectChanges(['README.md'], { event: 'workflow_dispatch' });
        expect([result.code, result.outputs]).toEqual([0, 'run=true\n']);
    });

    test('fails instead of skipping when the change list cannot be computed', () => {
        const result = detectChanges(['android/app/build.gradle.kts'], { parent: false });
        expect(result.code).not.toBe(0);
        expect(result.outputs).toBe('');
    });
});

describe('nightly.yml Android call', () => {
    test('smoke-tests the staging SHA the gate resolved, whenever the checks run, with only contents: read', () => {
        expect(nightly.workflow.jobs.android).toEqual({
            needs: 'gate',
            if: 'needs.gate.outputs.run == \'true\'',
            permissions: { contents: 'read' },
            uses: ANDROID_SMOKE,
            with: { 'default-ref': 'staging', 'ref': '${{ needs.gate.outputs.sha }}' },
        });
        expect(nightly.workflow.jobs.android.if).toBe(nightly.workflow.jobs.checks.if);
        expect(usesOf(nightly.workflow).calls).toEqual([ANDROID_SMOKE]);
    });
});
