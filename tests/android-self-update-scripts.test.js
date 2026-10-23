import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const updaterSource = readFileSync(path.join(repoRoot, 'scripts', 'self-update.sh'), 'utf8');
const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('Android app self-update gate with a bare upstream', () => {
    let workDir;
    let seedDir;
    let cloneDir;
    let upstreamDir;
    let statusDir;
    let gitEnv;
    let initialHead;
    let revision;

    function writeFile(file, contents) {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, contents);
    }

    function git(cwd, ...args) {
        const result = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
        if (result.status !== 0) {
            throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
        }
        return result.stdout.trim();
    }

    function publishMinimum(contents, { branch = 'release' } = {}) {
        revision += 1;
        if (contents === null) {
            rmSync(path.join(seedDir, 'android', 'min-app-version'), { force: true });
        } else {
            writeFile(path.join(seedDir, 'android', 'min-app-version'), contents);
        }
        writeFile(path.join(seedDir, 'revision.txt'), `${revision}\n`);
        git(seedDir, 'add', '-A');
        git(seedDir, 'commit', '--quiet', '-m', `upstream ${revision}`);
        git(seedDir, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
        return git(seedDir, 'rev-parse', 'HEAD');
    }

    function runUpdater({ optional = true, env = {}, stderrFile } = {}) {
        const updaterEnv = {
            ...gitEnv,
            SILLYBUNNY_ANDROID_APP: '1',
            SILLYBUNNY_ANDROID_APP_VERSION_CODE: '1',
            SILLYBUNNY_ANDROID_STATUS_DIR: statusDir,
            ...env,
        };
        for (const [key, value] of Object.entries(updaterEnv)) {
            if (value === undefined) {
                delete updaterEnv[key];
            }
        }
        const stderr = stderrFile ? openSync(stderrFile, 'w') : 'pipe';
        try {
            const result = spawnSync('bash', [path.join(cloneDir, 'scripts', 'self-update.sh'), ...(optional ? ['--optional'] : [])], {
                cwd: cloneDir,
                env: updaterEnv,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', stderr],
            });
            return { ...result, stderr: stderrFile ? readFileSync(stderrFile, 'utf8') : result.stderr };
        } finally {
            if (stderrFile) {
                closeSync(stderr);
            }
        }
    }

    function stubCommand(name, source) {
        const binDir = path.join(workDir, 'bin');
        const realCommand = spawnSync('bash', ['-c', 'command -v "$1"', 'bash', name], { env: gitEnv, encoding: 'utf8' }).stdout.trim();
        mkdirSync(binDir, { recursive: true });
        writeFileSync(path.join(binDir, name), `#!/bin/bash\n${source}\n`, { mode: 0o755 });
        return {
            PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
            TEST_REAL_COMMAND: realCommand,
        };
    }

    beforeEach(() => {
        workDir = mkdtempSync(path.join(tmpdir(), 'sb-android-update-'));
        seedDir = path.join(workDir, 'seed');
        cloneDir = path.join(workDir, 'clone');
        upstreamDir = path.join(workDir, 'upstream.git');
        statusDir = path.join(workDir, 'status with spaces');
        gitEnv = { ...process.env };
        for (const key of Object.keys(gitEnv)) {
            if (key.startsWith('SILLYBUNNY_') || key.startsWith('GIT_') || ['BASH_ENV', 'ENV'].includes(key)) {
                delete gitEnv[key];
            }
        }
        Object.assign(gitEnv, {
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_DEFAULT_HASH: 'sha1',
            GIT_AUTHOR_NAME: 'test',
            GIT_AUTHOR_EMAIL: 'test@example.invalid',
            GIT_COMMITTER_NAME: 'test',
            GIT_COMMITTER_EMAIL: 'test@example.invalid',
            HOME: path.join(workDir, 'home'),
        });
        mkdirSync(gitEnv.HOME);
        git(workDir, 'init', '--quiet', '--bare', '--initial-branch=release', upstreamDir);
        git(workDir, 'init', '--quiet', '--initial-branch=release', seedDir);
        writeFile(path.join(seedDir, 'scripts', 'self-update.sh'), updaterSource);
        writeFile(path.join(seedDir, 'android', 'min-app-version'), '1\n');
        writeFile(path.join(seedDir, 'revision.txt'), '0\n');
        git(seedDir, 'add', '-A');
        git(seedDir, 'commit', '--quiet', '-m', 'fixture');
        git(seedDir, 'remote', 'add', 'origin', upstreamDir);
        git(seedDir, 'push', '--quiet', '--set-upstream', 'origin', 'release');
        git(workDir, 'clone', '--quiet', '--branch', 'release', upstreamDir, cloneDir);
        initialHead = git(cloneDir, 'rev-parse', 'HEAD');
        revision = 0;
    });

    afterEach(() => {
        if (workDir) {
            rmSync(workDir, { recursive: true, force: true });
        }
    });

    test('a newer minimum blocks an optional pull and writes the exact status', () => {
        const upstream = publishMinimum('2\n');
        const result = runUpdater();
        expect(result.status).toBe(0);
        expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(initialHead);
        expect(result.stdout).toBe('Checking for updates on origin/release...\n');
        expect(result.stderr).toBe('Skipping self-update: TODO(copy)\n');
        expect(readFileSync(path.join(statusDir, 'update-blocked.json'), 'utf8'))
            .toBe(`{"required":2,"installed":1,"reason":"newer","upstream":"${upstream}","branch":"release"}\n`);
        expect(readdirSync(statusDir)).toEqual(['update-blocked.json']);
    });

    test('a newer minimum fails a requested update without changing HEAD', () => {
        const upstream = publishMinimum('2\n');
        writeFile(path.join(statusDir, 'update-blocked.json'), 'stale\n');
        const result = runUpdater({ optional: false });
        expect(result.status).toBe(1);
        expect(result.stderr).toBe('Self-update failed: TODO(copy)\n');
        expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(initialHead);
        expect(readFileSync(path.join(statusDir, 'update-blocked.json'), 'utf8'))
            .toBe(`{"required":2,"installed":1,"reason":"newer","upstream":"${upstream}","branch":"release"}\n`);
    });

    test('the blocked log is visible before status-file publication starts', () => {
        publishMinimum('2\n');
        const stderrFile = path.join(workDir, 'stderr.log');
        const orderFile = path.join(workDir, 'log-at-mkdir');
        const env = stubCommand('mkdir', [
            'IFS= read -r line < "$TEST_STDERR_FILE" || true',
            'printf "%s\\n" "${line:-missing}" > "$TEST_ORDER_FILE"',
            'exec "$TEST_REAL_COMMAND" "$@"',
        ].join('\n'));
        const result = runUpdater({ stderrFile, env: { ...env, TEST_STDERR_FILE: stderrFile, TEST_ORDER_FILE: orderFile } });
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('Skipping self-update: TODO(copy)\n');
        expect(readFileSync(orderFile, 'utf8')).toBe('Skipping self-update: TODO(copy)\n');
        expect(existsSync(path.join(statusDir, 'update-blocked.json'))).toBe(true);
        expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(initialHead);
    });

    test.each([
        [true, false, 0],
        [true, true, 0],
        [false, false, 1],
        [false, true, 1],
    ])('status removal failure honors optional=%j, behind=%j', (optional, behind, exitCode) => {
        if (behind) {
            publishMinimum('1\n');
        }
        writeFile(path.join(statusDir, 'update-blocked.json'), 'stale\n');
        const env = stubCommand('rm', 'exit 17');
        const result = runUpdater({ optional, env });
        expect(result.status).toBe(exitCode);
        expect(result.stderr).toBe(`${optional ? 'Skipping self-update' : 'Self-update failed'}: TODO(copy)\n`);
        expect(readFileSync(path.join(statusDir, 'update-blocked.json'), 'utf8')).toBe('stale\n');
        expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(initialHead);
    });

    test.each([[true, 0], [false, 1]])('upstream SHA failure honors optional=%j without pulling', (optional, exitCode) => {
        publishMinimum('2\n');
        const env = stubCommand('git', [
            'if [[ "$1" == rev-parse && "${2:-}" == "@{upstream}" ]]; then exit 128; fi',
            'exec "$TEST_REAL_COMMAND" "$@"',
        ].join('\n'));
        const result = runUpdater({ optional, env });
        expect(result.status).toBe(exitCode);
        expect(result.stderr).toBe(`${optional ? 'Skipping self-update' : 'Self-update failed'}: TODO(copy)\n`);
        expect(existsSync(statusDir)).toBe(false);
        expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(initialHead);
    });

    test.each([
        ['mkdir', true, 0],
        ['mkdir', false, 1],
        ['mv', true, 0],
        ['mv', false, 1],
    ])('%s failure stays blocked and cleans temporary status, optional=%j', (command, optional, exitCode) => {
        publishMinimum('2\n');
        mkdirSync(statusDir);
        const env = stubCommand(command, 'exit 17');
        const result = runUpdater({ optional, env });
        expect(result.status).toBe(exitCode);
        expect(result.stderr).toBe(`${optional ? 'Skipping self-update' : 'Self-update failed'}: TODO(copy)\n`);
        expect(readdirSync(statusDir)).toEqual([]);
        expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(initialHead);
    });

    test.each([
        ['lower', '1\n', '2'],
        ['equal', '1\n', '1'],
        ['without a trailing newline', '1', '1'],
        ['zero', '0\n', '0'],
        ['zero-padded zero', '000\n', '000'],
        ['surrounding whitespace', ' \t\r\n0008 \v\f\r\n', '0008'],
        ['larger than shell integers', '99999999999999999999999999999999999998\n', '99999999999999999999999999999999999999'],
    ])('an allowed %s minimum pulls and removes a stale status', (label, contents, installed) => {
        const upstream = publishMinimum(contents);
        writeFile(path.join(statusDir, 'update-blocked.json'), 'stale\n');
        const result = runUpdater({ env: { SILLYBUNNY_ANDROID_APP_VERSION_CODE: installed } });
        expect(result.status).toBe(0);
        expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(upstream);
        expect(existsSync(path.join(statusDir, 'update-blocked.json'))).toBe(false);
        expect(result.stdout).toContain('Updating SillyBunny...\n');
        expect(result.stdout).not.toContain('TODO(copy)');
    });

    test.each([
        ['missing', null, 'missing'],
        ['empty', '', 'invalid'],
        ['whitespace only', ' \t\n', 'invalid'],
        ['negative', '-1\n', 'invalid'],
        ['signed', '+1\n', 'invalid'],
        ['decimal', '1.0\n', 'invalid'],
        ['exponent', '1e2\n', 'invalid'],
        ['two integers', '1\n2\n', 'invalid'],
        ['internal whitespace', '1 2\n', 'invalid'],
        ['suffix', '1 trailing\n', 'invalid'],
        ['binary', '1\0\n', 'invalid'],
        ['sentinel-looking binary', '1\0missing\0', 'invalid'],
    ])('%s minimum blocks with required null', (label, contents, reason) => {
        const upstream = publishMinimum(contents);
        const result = runUpdater();
        expect(result.status).toBe(0);
        expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(initialHead);
        expect(readFileSync(path.join(statusDir, 'update-blocked.json'), 'utf8'))
            .toBe(`{"required":null,"installed":1,"reason":"${reason}","upstream":"${upstream}","branch":"release"}\n`);
        expect(result.stderr).toBe('Skipping self-update: TODO(copy)\n');
    });

    test.each([
        [null, 'missing'],
        ['invalid\n', 'invalid'],
    ])('non-optional minimum %j blocks with required null', (contents, reason) => {
        const upstream = publishMinimum(contents);
        const result = runUpdater({ optional: false });
        expect(result.status).toBe(1);
        expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(initialHead);
        expect(result.stderr).toBe('Self-update failed: TODO(copy)\n');
        expect(readFileSync(path.join(statusDir, 'update-blocked.json'), 'utf8'))
            .toBe(`{"required":null,"installed":1,"reason":"${reason}","upstream":"${upstream}","branch":"release"}\n`);
    });

    test.each([undefined, '', '-1', '+1', 'true', '1.0', ' 1 ', '1\n', '1+1', '0x10'])('invalid installed version %j is zero', installed => {
        const upstream = publishMinimum('1\n');
        const result = runUpdater({ env: { SILLYBUNNY_ANDROID_APP_VERSION_CODE: installed } });
        expect(result.status).toBe(0);
        expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(initialHead);
        expect(readFileSync(path.join(statusDir, 'update-blocked.json'), 'utf8'))
            .toBe(`{"required":1,"installed":0,"reason":"newer","upstream":"${upstream}","branch":"release"}\n`);
    });

    test('a failed git show is missing even when it returned partial valid content', () => {
        const upstream = publishMinimum('1\n');
        const binDir = path.join(workDir, 'bin');
        const realGit = spawnSync('bash', ['-c', 'command -v git'], { env: gitEnv, encoding: 'utf8' }).stdout.trim();
        mkdirSync(binDir);
        writeFileSync(path.join(binDir, 'git'), [
            '#!/bin/bash',
            'if [[ "$1" == show ]]; then',
            '    printf "1\\n"',
            '    exit 1',
            'fi',
            'exec "$TEST_REAL_GIT" "$@"',
            '',
        ].join('\n'), { mode: 0o755 });
        const result = runUpdater({ env: {
            PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
            TEST_REAL_GIT: realGit,
        } });
        expect(result.status).toBe(0);
        expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(initialHead);
        expect(readFileSync(path.join(statusDir, 'update-blocked.json'), 'utf8'))
            .toBe(`{"required":null,"installed":1,"reason":"missing","upstream":"${upstream}","branch":"release"}\n`);
    });

    test('leading zeroes produce decimal JSON instead of octal arithmetic', () => {
        const upstream = publishMinimum('0009\n');
        const result = runUpdater({ env: { SILLYBUNNY_ANDROID_APP_VERSION_CODE: '0008' } });
        expect(result.status).toBe(0);
        expect(readFileSync(path.join(statusDir, 'update-blocked.json'), 'utf8'))
            .toBe(`{"required":9,"installed":8,"reason":"newer","upstream":"${upstream}","branch":"release"}\n`);
        expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(initialHead);
    });

    test('a larger minimum cannot wrap around shell integers', () => {
        const upstream = publishMinimum('99999999999999999999999999999999999999\n');
        const result = runUpdater();
        expect(result.status).toBe(0);
        expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(initialHead);
        expect(readFileSync(path.join(statusDir, 'update-blocked.json'), 'utf8'))
            .toBe(`{"required":99999999999999999999999999999999999999,"installed":1,"reason":"newer","upstream":"${upstream}","branch":"release"}\n`);
    });

    test('up-to-date code removes the status without rechecking its own minimum', () => {
        publishMinimum(null);
        git(cloneDir, 'pull', '--quiet', '--ff-only');
        const head = git(cloneDir, 'rev-parse', 'HEAD');
        writeFile(path.join(statusDir, 'update-blocked.json'), 'stale\n');
        const result = runUpdater();
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('Checking for updates on origin/release...\nSillyBunny is already up to date.\n');
        expect(result.stderr).toBe('');
        expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(head);
        expect(existsSync(path.join(statusDir, 'update-blocked.json'))).toBe(false);
    });

    test('an ahead-only branch removes the status and keeps the existing decision', () => {
        writeFile(path.join(cloneDir, 'local.txt'), 'local\n');
        git(cloneDir, 'add', 'local.txt');
        git(cloneDir, 'commit', '--quiet', '-m', 'local');
        writeFile(path.join(statusDir, 'update-blocked.json'), 'stale\n');
        const result = runUpdater();
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Local branch \'release\' is already ahead of \'origin/release\'; nothing to pull.\n');
        expect(result.stderr).toBe('');
        expect(existsSync(path.join(statusDir, 'update-blocked.json'))).toBe(false);
    });

    test.each([
        ['1\n', false],
        ['2\n', true],
    ])('the APK gate runs before a diverged-branch decision for minimum %j', (contents, blocked) => {
        publishMinimum(contents);
        writeFile(path.join(cloneDir, 'local.txt'), 'local\n');
        git(cloneDir, 'add', 'local.txt');
        git(cloneDir, 'commit', '--quiet', '-m', 'local');
        const head = git(cloneDir, 'rev-parse', 'HEAD');
        writeFile(path.join(statusDir, 'update-blocked.json'), 'stale\n');
        const result = runUpdater();
        expect(result.status).toBe(0);
        expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(head);
        expect(existsSync(path.join(statusDir, 'update-blocked.json'))).toBe(blocked);
        expect(result.stderr).toBe(blocked
            ? 'Skipping self-update: TODO(copy)\n'
            : 'Skipping self-update: branch \'release\' has diverged from \'origin/release\'. Resolve it manually before using self-update.\n');
    });

    test('a quoted local branch is JSON-escaped', () => {
        const upstream = publishMinimum('2\n');
        git(cloneDir, 'branch', '-m', 'release"quoted');
        const result = runUpdater();
        expect(result.status).toBe(0);
        const status = readFileSync(path.join(statusDir, 'update-blocked.json'), 'utf8');
        expect(status).toBe(`{"required":2,"installed":1,"reason":"newer","upstream":"${upstream}","branch":"release\\"quoted"}\n`);
        expect(JSON.parse(status).branch).toBe('release"quoted');
        expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(initialHead);
    });

    test.each([undefined, '', '0', 'true', '01'])('non-APK flag %j ignores a huge minimum and does not create status', app => {
        const upstream = publishMinimum('99999999999999999999999999999999999999\n');
        const result = runUpdater({ env: { SILLYBUNNY_ANDROID_APP: app } });
        expect(result.status).toBe(0);
        expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(upstream);
        expect(existsSync(statusDir)).toBe(false);
        expect(result.stdout).not.toContain('TODO(copy)');
    });

    test('non-APK mode never removes or overwrites an existing status', () => {
        const upstream = publishMinimum('9999\n');
        writeFile(path.join(statusDir, 'update-blocked.json'), 'existing\n');
        const result = runUpdater({ env: { SILLYBUNNY_ANDROID_APP: undefined } });
        expect(result.status).toBe(0);
        expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(upstream);
        expect(readFileSync(path.join(statusDir, 'update-blocked.json'), 'utf8')).toBe('existing\n');
    });

    test.each([null, 'invalid\n'])('non-APK mode also pulls a missing or invalid minimum %j', minimum => {
        const upstream = publishMinimum(minimum);
        const result = runUpdater({ env: { SILLYBUNNY_ANDROID_APP: undefined } });
        expect(result.status).toBe(0);
        expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(upstream);
        expect(existsSync(statusDir)).toBe(false);
    });

    test.each([undefined, ''])('an unset or empty status directory %j writes nothing but still blocks', statusPath => {
        publishMinimum('2\n');
        const entries = readdirSync(workDir).sort();
        const result = runUpdater({ env: { SILLYBUNNY_ANDROID_STATUS_DIR: statusPath } });
        expect(result.status).toBe(0);
        expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(initialHead);
        expect(git(cloneDir, 'status', '--porcelain')).toBe('');
        expect(readdirSync(workDir).sort()).toEqual(entries);
        expect(result.stderr).toBe('Skipping self-update: TODO(copy)\n');
    });

    function advanceUpstreamOn(command, minimum, newerMinimum) {
        const checked = publishMinimum(minimum);
        writeFile(path.join(seedDir, 'android', 'min-app-version'), newerMinimum);
        git(seedDir, 'add', '-A');
        git(seedDir, 'commit', '--quiet', '-m', 'upstream advances during update');
        const newer = git(seedDir, 'rev-parse', 'HEAD');
        const callsFile = path.join(workDir, 'git-calls');
        // Advance both the remote and local tracking ref at the selected boundary, without timing races.
        const env = stubCommand('git', [
            'printf "%s\\n" "$*" >> "$TEST_GIT_CALLS"',
            'if [[ "$1" == "$TEST_ADVANCE_AT" || "$TEST_ADVANCE_AT" == update && ( "$1" == pull || "$1" == merge ) ]]; then',
            '    "$TEST_REAL_COMMAND" -C "$TEST_SEED_DIR" push --quiet origin HEAD:refs/heads/release || exit $?',
            '    "$TEST_REAL_COMMAND" fetch --quiet origin || exit $?',
            'fi',
            'exec "$TEST_REAL_COMMAND" "$@"',
        ].join('\n'));
        return {
            checked,
            newer,
            callsFile,
            env: { ...env, TEST_GIT_CALLS: callsFile, TEST_SEED_DIR: seedDir, TEST_ADVANCE_AT: command },
        };
    }

    test('APK fast-forward cannot merge code newer than the checked commit', () => {
        const { checked, newer, callsFile, env } = advanceUpstreamOn('update', '1\n', '2\n');
        writeFile(path.join(statusDir, 'update-blocked.json'), 'stale\n');
        const result = runUpdater({ env });
        expect(result.status).toBe(0);
        expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(checked);
        expect(git(cloneDir, 'rev-parse', '@{upstream}')).toBe(newer);
        expect(readFileSync(path.join(cloneDir, 'android', 'min-app-version'), 'utf8')).toBe('1\n');
        expect(existsSync(path.join(statusDir, 'update-blocked.json'))).toBe(false);
        const calls = readFileSync(callsFile, 'utf8').trimEnd().split('\n');
        expect(calls.filter(call => call === 'rev-parse @{upstream}')).toHaveLength(1);
        expect(calls).toContain(`show ${checked}:android/min-app-version`);
        expect(calls).toContain(`merge --ff-only ${checked}`);
        expect(calls).not.toContain('pull --ff-only');
        expect(calls.filter(call => call.startsWith('fetch '))).toEqual(['fetch --quiet origin']);
    });

    test('APK minimum and status use the same pinned SHA when the tracking ref advances before git show', () => {
        const { checked, newer, callsFile, env } = advanceUpstreamOn('show', '2\n', '3\n');
        const result = runUpdater({ env });
        expect(result.status).toBe(0);
        expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(initialHead);
        expect(git(cloneDir, 'rev-parse', '@{upstream}')).toBe(newer);
        expect(readFileSync(path.join(statusDir, 'update-blocked.json'), 'utf8'))
            .toBe(`{"required":2,"installed":1,"reason":"newer","upstream":"${checked}","branch":"release"}\n`);
        expect(result.stderr).toBe('Skipping self-update: TODO(copy)\n');
        const calls = readFileSync(callsFile, 'utf8').trimEnd().split('\n');
        expect(calls.filter(call => call === 'rev-parse @{upstream}')).toHaveLength(1);
        expect(calls).toContain(`show ${checked}:android/min-app-version`);
        expect(calls.some(call => /^(merge|pull) /.test(call))).toBe(false);
    });

    test.each([undefined, '', '0', 'true', '01'])('non-APK flag %j retains the existing pull and refetch behavior', app => {
        const { newer, callsFile, env } = advanceUpstreamOn('update', '1\n', '2\n');
        const result = runUpdater({ env: { ...env, SILLYBUNNY_ANDROID_APP: app } });
        expect(result.status).toBe(0);
        expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(newer);
        expect(git(cloneDir, 'rev-parse', '@{upstream}')).toBe(newer);
        expect(readFileSync(path.join(cloneDir, 'android', 'min-app-version'), 'utf8')).toBe('2\n');
        expect(existsSync(statusDir)).toBe(false);
        const calls = readFileSync(callsFile, 'utf8').trimEnd().split('\n');
        expect(calls).toContain('pull --ff-only');
        expect(calls.some(call => /^(merge|show) /.test(call))).toBe(false);
        expect(calls).not.toContain('rev-parse @{upstream}');
    });

    test.each([[true, 0], [false, 1]])('APK merge failure honors optional=%j without pulling', (optional, exitCode) => {
        publishMinimum('1\n');
        const env = stubCommand('git', [
            'if [[ "$1" == merge ]]; then exit 17; fi',
            'exec "$TEST_REAL_COMMAND" "$@"',
        ].join('\n'));
        const result = runUpdater({ optional, env });
        expect(result.status).toBe(exitCode);
        expect(result.stderr).toBe(`${optional ? 'Skipping self-update' : 'Self-update failed'}: TODO(copy)\n`);
        expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(initialHead);
    });
});
