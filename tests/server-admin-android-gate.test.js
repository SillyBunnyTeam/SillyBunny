/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCAL_BRANCH = 'runtime/sillybunny-server';
const TRACKING_BRANCH = 'origin/staging';
const UPSTREAM = '0123456789abcdef0123456789abcdef01234567';
const RELEASE_UPSTREAM = '2222222222222222222222222222222222222222';
const MOVED_UPSTREAM = 'fedcba9876543210fedcba9876543210fedcba98';
const ENV_KEYS = [
    'SILLYBUNNY_ANDROID_APP',
    'SILLYBUNNY_ANDROID_APP_VERSION_CODE',
    'SILLYBUNNY_ANDROID_STATUS_DIR',
    'SILLYTAVERN_AUTOSTASHBEFOREPULL',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const tempDirectories = [];
const blockedVersions = [
    { reason: 'newer', value: '2\n', required: 2 },
    { reason: 'missing', value: new Error('missing minimum version file'), required: null },
    { reason: 'invalid', value: '1.5\n', required: null },
];
const branchSwitchPaths = [
    {
        branch: LOCAL_BRANCH,
        rawCalls: [
            [['checkout', '-B', LOCAL_BRANCH, 'origin/release']],
            [['branch', '--set-upstream-to=origin/release', LOCAL_BRANCH]],
        ],
        apkRawCalls: [
            [['checkout', '-B', LOCAL_BRANCH, RELEASE_UPSTREAM]],
            [['branch', '--set-upstream-to=origin/release', LOCAL_BRANCH]],
        ],
        checkoutCalls: [],
    },
    { branch: 'staging', rawCalls: [], apkRawCalls: [], checkoutCalls: [['release']] },
];
let fixture;
let configDirectory;
let router;

function createRepository({ branch = LOCAL_BRANCH, dirty = false, required = '2\n' } = {}) {
    const state = {
        branch,
        dirty,
        ahead: 0,
        behind: 1,
        commit: '1111111111111111111111111111111111111111',
        trackingBranch: TRACKING_BRANCH,
        refs: {
            [TRACKING_BRANCH]: UPSTREAM,
            'origin/release': RELEASE_UPSTREAM,
            'fork/release': RELEASE_UPSTREAM,
            release: RELEASE_UPSTREAM,
            'local-only': UPSTREAM,
        },
        minimumVersions: {
            [UPSTREAM]: required,
            [RELEASE_UPSTREAM]: required,
            [MOVED_UPSTREAM]: '2\n',
        },
        onMinimumRead: null,
        remoteBranches: ['origin/HEAD', 'origin/staging', 'origin/release'],
        remoteBranchesAfterFetch: null,
        stashed: false,
        stashPopError: null,
    };
    function resolveCommit(ref) {
        if (ref === 'HEAD') {
            return state.commit;
        }
        if (/^[a-f0-9]{40}$/.test(ref)) {
            return ref;
        }
        const commit = state.refs[ref];
        if (!commit) {
            throw new Error(`Unknown ref: ${ref}`);
        }
        return commit;
    }
    const git = {
        checkIsRepo: jest.fn(async () => true),
        status: jest.fn(async () => {
            const files = state.dirty ? [{ path: 'local-notes.txt', index: '?', working_dir: '?' }] : [];
            return { files, isClean: () => files.length === 0 };
        }),
        fetch: jest.fn(async () => {
            if (state.remoteBranchesAfterFetch) {
                state.remoteBranches = state.remoteBranchesAfterFetch;
            }
        }),
        branch: jest.fn(async () => ({ branches: Object.fromEntries(state.remoteBranches.map(branch => [branch, {}])) })),
        revparse: jest.fn(async args => {
            if (args[0] === '--abbrev-ref') {
                return args[1] === 'HEAD' ? state.branch : state.trackingBranch;
            }
            if (args[0] === '--short') {
                return resolveCommit(args[1]).slice(0, 7);
            }
            if (args.length === 1) {
                return resolveCommit(args[0]);
            }
            throw new Error(`Unexpected revparse: ${JSON.stringify(args)}`);
        }),
        show: jest.fn(async args => {
            // getVersion also uses show; keep that existing read distinct from the gate.
            if (args[0] === '-s') {
                return '2026-10-20 12:00:00 +0000\n';
            }
            if (args.length === 1 && args[0].endsWith(':android/min-app-version')) {
                // Ref movement must not change a minimum read addressed by an immutable commit.
                state.onMinimumRead?.();
                const commit = resolveCommit(args[0].slice(0, -':android/min-app-version'.length));
                const value = state.minimumVersions[commit];
                if (value instanceof Error) {
                    throw value;
                }
                if (value === undefined) {
                    throw new Error(`Missing minimum version at ${commit}`);
                }
                return value;
            }
            throw new Error(`Unexpected show: ${JSON.stringify(args)}`);
        }),
        raw: jest.fn(async args => {
            switch (args[0]) {
                case 'rev-list':
                    return `${state.ahead}\t${state.behind}\n`;
                case 'merge':
                    state.commit = resolveCommit(args[2]);
                    state.behind = state.commit === resolveCommit(state.trackingBranch) ? 0 : 1;
                    return '';
                case 'checkout':
                    state.branch = args[2];
                    state.commit = resolveCommit(args[3]);
                    return '';
                case 'branch':
                    state.trackingBranch = args[1].replace('--set-upstream-to=', '');
                    return '';
                default:
                    throw new Error(`Unexpected raw git call: ${JSON.stringify(args)}`);
            }
        }),
        checkout: jest.fn(async branch => {
            state.branch = branch;
            state.commit = resolveCommit(branch);
        }),
        stash: jest.fn(async args => {
            if (args[0] === 'push') {
                state.stashed = true;
                state.dirty = false;
                return '';
            }
            if (args[0] === 'pop' && state.stashed) {
                if (state.stashPopError) {
                    throw state.stashPopError;
                }
                state.stashed = false;
                state.dirty = true;
                return '';
            }
            throw new Error(`Unexpected stash: ${JSON.stringify(args)}`);
        }),
    };
    return { git, state };
}

const gitFactory = jest.fn(() => fixture.git);
const spawn = jest.fn(() => { throw new Error('Unexpected child process spawn'); });
const requestGracefulExit = jest.fn();

await jest.unstable_mockModule('simple-git', () => ({
    default: gitFactory,
    CheckRepoActions: { IS_REPO_ROOT: 'IS_REPO_ROOT' },
}));
await jest.unstable_mockModule('command-exists', () => ({ sync: command => command === 'git' }));
await jest.unstable_mockModule('node:child_process', () => ({ ...childProcess, spawn }));
await jest.unstable_mockModule('../src/shutdown.js', () => ({ requestGracefulExit }));

beforeAll(async () => {
    configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-admin-android-config-'));
    const configPath = path.join(configDirectory, 'config.yaml');
    fs.writeFileSync(configPath, 'autoStashBeforePull: true\n');
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(configPath);
    ({ router } = await import('../src/endpoints/server-admin.js'));
});

beforeEach(() => {
    jest.clearAllMocks();
    for (const key of ENV_KEYS) {
        delete process.env[key];
    }
    process.env.SILLYBUNNY_ANDROID_APP = '1';
    process.env.SILLYBUNNY_ANDROID_APP_VERSION_CODE = '1';
    fixture = createRepository();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
    for (const key of ENV_KEYS) {
        if (originalEnv[key] === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = originalEnv[key];
        }
    }
    for (const directory of tempDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

afterAll(() => {
    fs.rmSync(configDirectory, { recursive: true, force: true });
});

async function invoke(routePath, body = {}) {
    const route = router.stack.find(layer => layer.route?.path === routePath && layer.route.methods.post)?.route;
    if (!route) {
        throw new Error(`Missing POST handler: ${routePath}`);
    }
    const response = new EventEmitter();
    response.statusCode = 200;
    response.status = function (code) { this.statusCode = code; return this; };
    // A real finish event starts the restart timer; JSON here only records the response.
    response.json = function (value) { this.body = value; return this; };
    await route.stack.at(-1).handle({ body }, response);
    expect(spawn).not.toHaveBeenCalled();
    expect(requestGracefulExit).not.toHaveBeenCalled();
    return response;
}

function expectNoCheckoutOrMerge() {
    expect(fixture.git.checkout).not.toHaveBeenCalled();
    expect(fixture.git.raw.mock.calls.filter(([args]) => args[0] !== 'rev-list')).toEqual([]);
}

function expectStashRoundTrip() {
    expect(fixture.git.stash.mock.calls.map(([args]) => args[0])).toEqual(['push', 'pop']);
    expect(fixture.git.stash).toHaveBeenNthCalledWith(1, ['push', '-u', '-m', expect.any(String)]);
    expect(fixture.git.stash).toHaveBeenNthCalledWith(2, ['pop']);
}

function expectPinnedMinimumRead(ref, commit) {
    const resolutionIndex = fixture.git.revparse.mock.calls.findIndex(([args]) => args.length === 1 && args[0] === ref);
    expect(resolutionIndex).toBeGreaterThanOrEqual(0);
    const minimumReadIndex = fixture.git.show.mock.calls.findIndex(([args]) => args[0] !== '-s');
    expect(minimumReadIndex).toBeGreaterThanOrEqual(0);
    expect(fixture.git.show.mock.calls.filter(([args]) => args[0] !== '-s')).toEqual([[[`${commit}:android/min-app-version`]]]);
    const resolutionOrder = fixture.git.revparse.mock.invocationCallOrder[resolutionIndex];
    const minimumReadOrder = fixture.git.show.mock.invocationCallOrder[minimumReadIndex];
    expect(resolutionOrder).toBeLessThan(minimumReadOrder);
    return { resolutionOrder, minimumReadOrder };
}

function getGitCalls() {
    return Object.entries(fixture.git)
        .flatMap(([method, mock]) => mock.mock.calls.map((args, index) => ({ order: mock.mock.invocationCallOrder[index], call: [method, ...args] })))
        .sort((left, right) => left.order - right.order)
        .map(({ call }) => call);
}

function enableStatusFile() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-admin-android-status-'));
    tempDirectories.push(directory);
    process.env.SILLYBUNNY_ANDROID_STATUS_DIR = directory;
    return path.join(directory, 'update-blocked.json');
}

describe('server admin Android update gate', () => {
    test.each(blockedVersions)('/update blocks $reason and restores auto-stashed changes', async ({ value, required, reason }) => {
        fixture = createRepository({ dirty: true, required: value });

        const response = await invoke('/update');

        expect(response.statusCode).toBe(409);
        expect(response.body).toMatchObject({
            error: 'TODO(copy)',
            code: 'android_app_update_required',
            required,
            installed: 1,
            reason,
            repository: { branch: LOCAL_BRANCH, trackingBranch: TRACKING_BRANCH, hasLocalChanges: true },
            stashed: true,
            stashPopWarning: null,
        });
        const { resolutionOrder, minimumReadOrder } = expectPinnedMinimumRead(TRACKING_BRANCH, UPSTREAM);
        expect(fixture.git.fetch).toHaveBeenCalledTimes(2);
        expect(resolutionOrder).toBeGreaterThan(fixture.git.fetch.mock.invocationCallOrder[1]);
        expectNoCheckoutOrMerge();
        expectStashRoundTrip();
        expect(fixture.git.stash.mock.invocationCallOrder[1]).toBeGreaterThan(minimumReadOrder);
        expect(fixture.state.dirty).toBe(true);
        expect(fixture.state.stashed).toBe(false);
        expect(response.listenerCount('finish')).toBe(0);
    });

    test('/update blocks a clean checkout without trying to pop an existing stash', async () => {
        const response = await invoke('/update');

        expect(response.statusCode).toBe(409);
        expect(response.body).toMatchObject({ code: 'android_app_update_required', stashed: false, stashPopWarning: null });
        expect(fixture.git.stash).not.toHaveBeenCalled();
        expectNoCheckoutOrMerge();
    });

    test('/update keeps the gate response and warning when stash pop fails', async () => {
        fixture.state.dirty = true;
        fixture.state.stashPopError = new Error('stash conflict');

        const response = await invoke('/update');

        expect(response.statusCode).toBe(409);
        expect(response.body).toMatchObject({
            error: 'TODO(copy)',
            code: 'android_app_update_required',
            stashed: true,
            stashPopWarning: expect.stringContaining('stash conflict'),
        });
        expectStashRoundTrip();
        expect(fixture.state.stashed).toBe(true);
        expectNoCheckoutOrMerge();
        expect(response.listenerCount('finish')).toBe(0);
    });

    test('/update records the current local branch rather than its display or upstream name', async () => {
        const statusPath = enableStatusFile();

        const response = await invoke('/update');

        expect(response.statusCode).toBe(409);
        expect(response.body.repository).toMatchObject({ branch: LOCAL_BRANCH, displayBranch: 'staging' });
        expect(JSON.parse(fs.readFileSync(statusPath, 'utf8'))).toEqual({
            required: 2, installed: 1, reason: 'newer', upstream: UPSTREAM, branch: LOCAL_BRANCH,
        });
    });

    test('/update records the checked SHA even when the tracking ref moves during the minimum read', async () => {
        const statusPath = enableStatusFile();
        fixture.state.minimumVersions[MOVED_UPSTREAM] = '1\n';
        fixture.state.onMinimumRead = () => { fixture.state.refs[TRACKING_BRANCH] = MOVED_UPSTREAM; };

        const response = await invoke('/update');

        expect(response.statusCode).toBe(409);
        expect(response.body).toMatchObject({ code: 'android_app_update_required', required: 2, reason: 'newer' });
        expectPinnedMinimumRead(TRACKING_BRANCH, UPSTREAM);
        expect(fixture.state.refs[TRACKING_BRANCH]).toBe(MOVED_UPSTREAM);
        expect(fixture.git.revparse.mock.calls.filter(([args]) => args.length === 1)).toEqual([[[TRACKING_BRANCH]]]);
        expect(fs.readFileSync(statusPath, 'utf8')).toBe(`{"required":2,"installed":1,"reason":"newer","upstream":"${UPSTREAM}","branch":"${LOCAL_BRANCH}"}\n`);
        expectNoCheckoutOrMerge();
        expect(response.listenerCount('finish')).toBe(0);
    });

    test('/update blocks an unresolved ref without reading a minimum and restores its auto-stash', async () => {
        const statusPath = enableStatusFile();
        fixture = createRepository({ dirty: true, required: '1\n' });
        delete fixture.state.refs[TRACKING_BRANCH];

        const response = await invoke('/update');

        expect(response.statusCode).toBe(409);
        expect(response.body).toMatchObject({
            error: 'TODO(copy)', code: 'android_app_update_required', required: null, installed: 1, reason: 'missing',
            repository: { branch: LOCAL_BRANCH, trackingBranch: TRACKING_BRANCH }, stashed: true, stashPopWarning: null,
        });
        expect(fixture.git.revparse.mock.calls.filter(([args]) => args.length === 1)).toEqual([[[TRACKING_BRANCH]]]);
        const resolutionIndex = fixture.git.revparse.mock.calls.findIndex(([args]) => args.length === 1);
        expect(fixture.git.revparse.mock.invocationCallOrder[resolutionIndex]).toBeGreaterThan(fixture.git.fetch.mock.invocationCallOrder[1]);
        expect(fixture.git.show).not.toHaveBeenCalled();
        expect(fs.readFileSync(statusPath, 'utf8')).toBe(`{"required":null,"installed":1,"reason":"missing","upstream":null,"branch":"${LOCAL_BRANCH}"}\n`);
        expectNoCheckoutOrMerge();
        expectStashRoundTrip();
        expect(fixture.git.stash.mock.invocationCallOrder[1]).toBeGreaterThan(fixture.git.revparse.mock.invocationCallOrder[resolutionIndex]);
        expect(fixture.state.dirty).toBe(true);
        expect(fixture.state.stashed).toBe(false);
        expect(response.listenerCount('finish')).toBe(0);
    });

    test.each(['0\n', '1\n'])('/update continues the existing merge and stash flow for allowed minimum %j', async required => {
        fixture = createRepository({ dirty: true, required });

        const response = await invoke('/update');

        expect(response.statusCode).toBe(202);
        expect(response.body).toMatchObject({ updated: true, restarting: true, stashed: true, stashPopWarning: null, install: null });
        expect(fixture.git.raw).toHaveBeenCalledWith(['merge', '--ff-only', UPSTREAM]);
        const { resolutionOrder, minimumReadOrder } = expectPinnedMinimumRead(TRACKING_BRANCH, UPSTREAM);
        expect(resolutionOrder).toBeGreaterThan(fixture.git.fetch.mock.invocationCallOrder[1]);
        const mergeIndex = fixture.git.raw.mock.calls.findIndex(([args]) => args[0] === 'merge');
        expect(minimumReadOrder).toBeLessThan(fixture.git.raw.mock.invocationCallOrder[mergeIndex]);
        expect(fixture.git.show.mock.calls.filter(([args]) => args[0] === '-s')).toEqual([[['-s', '--format=%ci', UPSTREAM.slice(0, 7)]]]);
        expect(fixture.state.commit).toBe(UPSTREAM);
        expectStashRoundTrip();
        expect(response.listenerCount('finish')).toBe(1);
    });

    test('/update merges only the checked SHA when the tracking ref moves to a newer minimum during the read', async () => {
        fixture = createRepository({ dirty: true, required: '1\n' });
        fixture.state.onMinimumRead = () => { fixture.state.refs[TRACKING_BRANCH] = MOVED_UPSTREAM; };

        const response = await invoke('/update');

        expect(response.statusCode).toBe(202);
        expect(response.body).toMatchObject({
            updated: true, stashed: true, stashPopWarning: null,
            repository: { currentCommit: UPSTREAM.slice(0, 7), remoteCommit: MOVED_UPSTREAM.slice(0, 7), behind: 1 },
            version: { gitRevision: UPSTREAM.slice(0, 7), isLatest: false },
        });
        const { resolutionOrder, minimumReadOrder } = expectPinnedMinimumRead(TRACKING_BRANCH, UPSTREAM);
        expect(resolutionOrder).toBeGreaterThan(fixture.git.fetch.mock.invocationCallOrder[1]);
        expect(fixture.git.raw.mock.calls.filter(([args]) => args[0] === 'merge')).toEqual([[['merge', '--ff-only', UPSTREAM]]]);
        const mergeIndex = fixture.git.raw.mock.calls.findIndex(([args]) => args[0] === 'merge');
        expect(minimumReadOrder).toBeLessThan(fixture.git.raw.mock.invocationCallOrder[mergeIndex]);
        expect(fixture.git.show.mock.calls.filter(([args]) => args[0] === '-s')).toEqual([[['-s', '--format=%ci', UPSTREAM.slice(0, 7)]]]);
        expect(fixture.state.refs[TRACKING_BRANCH]).toBe(MOVED_UPSTREAM);
        expect(fixture.state.commit).toBe(UPSTREAM);
        expectStashRoundTrip();
        expect(response.listenerCount('finish')).toBe(1);
    });

    test.each([undefined, '0', 'true'])('/update preserves non-APK git reads when mode is %j', async mode => {
        if (mode === undefined) {
            delete process.env.SILLYBUNNY_ANDROID_APP;
        } else {
            process.env.SILLYBUNNY_ANDROID_APP = mode;
        }
        fixture.state.dirty = true;

        const response = await invoke('/update');

        expect(response.statusCode).toBe(202);
        expect(response.body).toMatchObject({ updated: true, stashed: true, install: null });
        expect(fixture.git.show.mock.calls).toEqual([[['-s', '--format=%ci', UPSTREAM.slice(0, 7)]]]);
        expect(fixture.git.revparse).toHaveBeenCalledTimes(13);
        expect(fixture.git.revparse.mock.calls.filter(([args]) => args.length === 1)).toEqual([[['HEAD']], [[TRACKING_BRANCH]]]);
        expect(fixture.git.raw.mock.calls.filter(([args]) => args[0] !== 'rev-list')).toEqual([[['merge', '--ff-only', TRACKING_BRANCH]]]);
        expectStashRoundTrip();
        expect(getGitCalls()).toEqual([
            ['checkIsRepo'],
            ['revparse', ['--abbrev-ref', 'HEAD']],
            ['revparse', ['--short', 'HEAD']],
            ['status'],
            ['revparse', ['--abbrev-ref', '@{u}']],
            ['fetch'],
            ['raw', ['rev-list', '--left-right', '--count', `HEAD...${TRACKING_BRANCH}`]],
            ['revparse', ['--short', TRACKING_BRANCH]],
            ['stash', ['push', '-u', '-m', 'SillyBunny auto-stash before update']],
            ['fetch'],
            ['raw', ['merge', '--ff-only', TRACKING_BRANCH]],
            ['stash', ['pop']],
            ['checkIsRepo'],
            ['revparse', ['--abbrev-ref', 'HEAD']],
            ['revparse', ['--short', 'HEAD']],
            ['status'],
            ['revparse', ['--abbrev-ref', '@{u}']],
            ['fetch'],
            ['raw', ['rev-list', '--left-right', '--count', `HEAD...${TRACKING_BRANCH}`]],
            ['revparse', ['--short', TRACKING_BRANCH]],
            ['revparse', ['--short', 'HEAD']],
            ['revparse', ['--abbrev-ref', 'HEAD']],
            ['show', ['-s', '--format=%ci', UPSTREAM.slice(0, 7)]],
            ['revparse', ['--abbrev-ref', '@{u}']],
            ['revparse', ['HEAD']],
            ['revparse', [TRACKING_BRANCH]],
        ]);
    });

    test.each([
        { ahead: 0, behind: 0, status: 200 },
        { ahead: 1, behind: 1, status: 409 },
    ])('/update leaves its existing early stop intact at $ahead ahead and $behind behind', async ({ ahead, behind, status }) => {
        Object.assign(fixture.state, { ahead, behind, dirty: true });

        const response = await invoke('/update');

        expect(response.statusCode).toBe(status);
        expect(response.body).toMatchObject({ stashed: true, stashPopWarning: null });
        expect(fixture.git.show).not.toHaveBeenCalled();
        expectStashRoundTrip();
        expectNoCheckoutOrMerge();
    });
});

describe('server admin Android branch-switch gate', () => {
    test.each([
        ...blockedVersions.map(version => ({ ...version, branch: LOCAL_BRANCH })),
        { reason: 'newer', value: '2\n', required: 2, branch: 'staging' },
    ])('/switch-branch blocks $reason from $branch before either checkout path', async ({ value, required, reason, branch }) => {
        fixture = createRepository({ branch, dirty: true, required: value });

        const response = await invoke('/switch-branch', { branch: 'release', autoStash: true });

        expect(response.statusCode).toBe(409);
        expect(response.body).toEqual({ error: 'TODO(copy)', code: 'android_app_update_required', required, installed: 1, reason, branch: 'release' });
        const { resolutionOrder, minimumReadOrder } = expectPinnedMinimumRead('origin/release', RELEASE_UPSTREAM);
        expect(resolutionOrder).toBeGreaterThan(fixture.git.branch.mock.invocationCallOrder[0]);
        expectNoCheckoutOrMerge();
        expectStashRoundTrip();
        expect(fixture.git.stash.mock.invocationCallOrder[1]).toBeGreaterThan(minimumReadOrder);
        expect(fixture.state.branch).toBe(branch);
        expect(fixture.state.dirty).toBe(true);
        expect(response.listenerCount('finish')).toBe(0);
    });

    test('/switch-branch does not pop a stash when the checkout was clean', async () => {
        const response = await invoke('/switch-branch', { branch: 'release', autoStash: true });

        expect(response.statusCode).toBe(409);
        expect(response.body.code).toBe('android_app_update_required');
        expect(fixture.git.stash).not.toHaveBeenCalled();
        expectNoCheckoutOrMerge();
    });

    test('/switch-branch still returns the gate response when stash pop fails', async () => {
        fixture.state.dirty = true;
        fixture.state.stashPopError = new Error('stash conflict');

        const response = await invoke('/switch-branch', { branch: 'release', autoStash: true });

        expect(response.statusCode).toBe(409);
        expect(response.body).toMatchObject({ error: 'TODO(copy)', code: 'android_app_update_required', reason: 'newer', branch: 'release' });
        expectStashRoundTrip();
        expect(fixture.state.stashed).toBe(true);
        expectNoCheckoutOrMerge();
        expect(response.listenerCount('finish')).toBe(0);
    });

    test.each(branchSwitchPaths)('/switch-branch continues its allowed checkout path from $branch', async ({ branch, apkRawCalls, checkoutCalls }) => {
        fixture = createRepository({ branch, dirty: true, required: '1\n' });

        const response = await invoke('/switch-branch', { branch: 'release', autoStash: true });

        expect(response.statusCode).toBe(202);
        expect(response.body).toMatchObject({ ok: true, branch: 'release', stashed: true, stashRestored: true, restarting: true });
        const { minimumReadOrder } = expectPinnedMinimumRead('origin/release', RELEASE_UPSTREAM);
        expect(fixture.git.raw.mock.calls).toEqual(apkRawCalls);
        expect(fixture.git.checkout.mock.calls).toEqual(checkoutCalls);
        const checkoutOrder = fixture.git.raw.mock.invocationCallOrder[0] ?? fixture.git.checkout.mock.invocationCallOrder[0];
        expect(minimumReadOrder).toBeLessThan(checkoutOrder);
        expect(fixture.state.commit).toBe(RELEASE_UPSTREAM);
        expectStashRoundTrip();
        expect(response.listenerCount('finish')).toBe(1);
    });

    test('/switch-branch checks out only the checked SHA when the remote ref moves during the minimum read', async () => {
        fixture = createRepository({ dirty: true, required: '1\n' });
        fixture.state.onMinimumRead = () => { fixture.state.refs['origin/release'] = MOVED_UPSTREAM; };

        const response = await invoke('/switch-branch', { branch: 'release', autoStash: true });

        expect(response.statusCode).toBe(202);
        expect(response.body).toMatchObject({ ok: true, branch: 'release', stashed: true, stashRestored: true, restarting: true });
        const { minimumReadOrder } = expectPinnedMinimumRead('origin/release', RELEASE_UPSTREAM);
        expect(fixture.git.revparse.mock.calls).toEqual([[['--abbrev-ref', 'HEAD']], [['origin/release']]]);
        expect(fixture.git.raw.mock.calls).toEqual([
            [['checkout', '-B', LOCAL_BRANCH, RELEASE_UPSTREAM]],
            [['branch', '--set-upstream-to=origin/release', LOCAL_BRANCH]],
        ]);
        expect(minimumReadOrder).toBeLessThan(fixture.git.raw.mock.invocationCallOrder[0]);
        expect(fixture.git.checkout).not.toHaveBeenCalled();
        expect(fixture.state.refs['origin/release']).toBe(MOVED_UPSTREAM);
        expect(fixture.state.commit).toBe(RELEASE_UPSTREAM);
        expect(fixture.state.branch).toBe(LOCAL_BRANCH);
        expect(fixture.state.trackingBranch).toBe('origin/release');
        expectStashRoundTrip();
        expect(response.listenerCount('finish')).toBe(1);
    });

    test.each(branchSwitchPaths)('/switch-branch preserves non-APK git reads from $branch', async ({ branch, rawCalls, checkoutCalls }) => {
        delete process.env.SILLYBUNNY_ANDROID_APP;
        fixture = createRepository({ branch, dirty: true });

        const response = await invoke('/switch-branch', { branch: 'release', autoStash: true });

        expect(response.statusCode).toBe(202);
        expect(response.body).toMatchObject({ ok: true, stashed: true, stashRestored: true });
        expect(fixture.git.show).not.toHaveBeenCalled();
        expect(fixture.git.revparse.mock.calls).toEqual([[['--abbrev-ref', 'HEAD']]]);
        expect(fixture.git.fetch).not.toHaveBeenCalled();
        expect(fixture.git.raw.mock.calls).toEqual(rawCalls);
        expect(fixture.git.checkout.mock.calls).toEqual(checkoutCalls);
        expectStashRoundTrip();
        expect(getGitCalls()).toEqual([
            ['checkIsRepo'],
            ['status'],
            ['stash', ['push', '-u', '-m', 'Auto-stash before switching to release']],
            ['branch', ['-r']],
            ['revparse', ['--abbrev-ref', 'HEAD']],
            ...rawCalls.map(([args]) => ['raw', args]),
            ...checkoutCalls.map(([checkoutBranch]) => ['checkout', checkoutBranch]),
            ['stash', ['pop']],
        ]);
    });

    test.each([
        { branch: 'release', remote: 'origin/release' },
        { branch: 'fork/release', remote: 'fork/release' },
    ])('/switch-branch checks $remote resolved after the fallback fetch', async ({ branch, remote }) => {
        fixture.state.dirty = true;
        fixture.state.remoteBranches = ['origin/staging'];
        fixture.state.remoteBranchesAfterFetch = ['origin/staging', remote];

        const response = await invoke('/switch-branch', { branch, autoStash: true });

        expect(response.statusCode).toBe(409);
        expect(response.body.code).toBe('android_app_update_required');
        expect(fixture.git.fetch).toHaveBeenCalledWith(['--all', '--prune']);
        expect(fixture.git.branch).toHaveBeenCalledTimes(2);
        const { resolutionOrder } = expectPinnedMinimumRead(remote, RELEASE_UPSTREAM);
        expect(resolutionOrder).toBeGreaterThan(fixture.git.branch.mock.invocationCallOrder[1]);
        expectStashRoundTrip();
        expectNoCheckoutOrMerge();
    });

    test('/switch-branch checks the requested local ref when no remote resolves', async () => {
        fixture.state.dirty = true;
        fixture.state.remoteBranches = ['origin/staging'];

        const response = await invoke('/switch-branch', { branch: 'local-only', autoStash: true });

        expect(response.statusCode).toBe(409);
        expect(response.body).toMatchObject({ code: 'android_app_update_required', branch: 'local-only' });
        expect(fixture.git.branch).toHaveBeenCalledTimes(2);
        const { resolutionOrder } = expectPinnedMinimumRead('local-only', UPSTREAM);
        expect(resolutionOrder).toBeGreaterThan(fixture.git.branch.mock.invocationCallOrder[1]);
        expectStashRoundTrip();
        expectNoCheckoutOrMerge();
    });

    test('/switch-branch records the current local branch before changing it', async () => {
        const statusPath = enableStatusFile();

        const response = await invoke('/switch-branch', { branch: 'release' });

        expect(response.statusCode).toBe(409);
        expect(JSON.parse(fs.readFileSync(statusPath, 'utf8'))).toEqual({
            required: 2, installed: 1, reason: 'newer', upstream: RELEASE_UPSTREAM, branch: LOCAL_BRANCH,
        });
        expect(fixture.state.branch).toBe(LOCAL_BRANCH);
    });

    test('/switch-branch records the checked SHA when the remote ref moves during a blocked minimum read', async () => {
        const statusPath = enableStatusFile();
        fixture.state.minimumVersions[MOVED_UPSTREAM] = '1\n';
        fixture.state.onMinimumRead = () => { fixture.state.refs['origin/release'] = MOVED_UPSTREAM; };

        const response = await invoke('/switch-branch', { branch: 'release' });

        expect(response.statusCode).toBe(409);
        expect(response.body).toEqual({
            error: 'TODO(copy)', code: 'android_app_update_required', required: 2, installed: 1, reason: 'newer', branch: 'release',
        });
        expectPinnedMinimumRead('origin/release', RELEASE_UPSTREAM);
        expect(fixture.git.revparse.mock.calls).toEqual([[['--abbrev-ref', 'HEAD']], [['origin/release']]]);
        expect(fixture.state.refs['origin/release']).toBe(MOVED_UPSTREAM);
        expect(fs.readFileSync(statusPath, 'utf8')).toBe(`{"required":2,"installed":1,"reason":"newer","upstream":"${RELEASE_UPSTREAM}","branch":"${LOCAL_BRANCH}"}\n`);
        expectNoCheckoutOrMerge();
        expect(fixture.state.branch).toBe(LOCAL_BRANCH);
        expect(response.listenerCount('finish')).toBe(0);
    });

    test.each(branchSwitchPaths)('/switch-branch blocks an unresolved ref from $branch without a minimum read and restores its auto-stash', async ({ branch }) => {
        const statusPath = enableStatusFile();
        fixture = createRepository({ branch, dirty: true, required: '1\n' });
        delete fixture.state.refs['origin/release'];

        const response = await invoke('/switch-branch', { branch: 'release', autoStash: true });

        expect(response.statusCode).toBe(409);
        expect(response.body).toEqual({
            error: 'TODO(copy)', code: 'android_app_update_required', required: null, installed: 1, reason: 'missing', branch: 'release',
        });
        expect(fixture.git.revparse.mock.calls).toEqual([[['--abbrev-ref', 'HEAD']], [['origin/release']]]);
        expect(fixture.git.revparse.mock.invocationCallOrder[1]).toBeGreaterThan(fixture.git.branch.mock.invocationCallOrder[0]);
        expect(fixture.git.show).not.toHaveBeenCalled();
        expect(fs.readFileSync(statusPath, 'utf8')).toBe(`{"required":null,"installed":1,"reason":"missing","upstream":null,"branch":"${branch}"}\n`);
        expectNoCheckoutOrMerge();
        expectStashRoundTrip();
        expect(fixture.git.stash.mock.invocationCallOrder[1]).toBeGreaterThan(fixture.git.revparse.mock.invocationCallOrder[1]);
        expect(fixture.state.branch).toBe(branch);
        expect(fixture.state.dirty).toBe(true);
        expect(fixture.state.stashed).toBe(false);
        expect(response.listenerCount('finish')).toBe(0);
    });
});

test.each(['/update', '/switch-branch'])('%s reads APK mode and installed version for every request', async route => {
    process.env.SILLYBUNNY_ANDROID_APP = '0';
    expect((await invoke(route, { branch: 'release' })).statusCode).toBe(202);

    fixture = createRepository();
    process.env.SILLYBUNNY_ANDROID_APP = '1';
    const blocked = await invoke(route, { branch: 'release' });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body.code).toBe('android_app_update_required');

    fixture = createRepository();
    process.env.SILLYBUNNY_ANDROID_APP_VERSION_CODE = '2';
    expect((await invoke(route, { branch: 'release' })).statusCode).toBe(202);
});
