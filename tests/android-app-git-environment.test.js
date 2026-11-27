/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ANDROID_APP_GIT_ENVIRONMENT = [
    'GIT_EXEC_PATH',
    'GIT_TEMPLATE_DIR',
    'GIT_CONFIG_NOSYSTEM',
    'GIT_ATTR_NOSYSTEM',
    'GIT_SSL_CAINFO',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
];
const EXTENSION_NAME = 'test-extension';
const originalAndroidApp = process.env.SILLYBUNNY_ANDROID_APP;
const gitOptions = [];
let temporaryDirectory;
let modules;

// One untracked file stops the Server Tools update and branch switch right after they create their git instance.
function createGit() {
    return {
        checkIsRepo: async () => true,
        status: async () => ({ files: [{ path: 'notes.txt', index: '?', working_dir: '?' }], isClean: () => false }),
        revparse: async args => (args[0] === '--is-shallow-repository' ? 'false' : 'staging'),
        raw: async args => (args[0] === 'rev-list' ? '0\t0\n' : ''),
        show: async () => '',
        fetch: async () => ({}),
        branch: async () => ({ current: 'main', tracking: '', all: ['main'], branches: {} }),
        branchLocal: async () => ({ current: 'main', all: ['main'], branches: {} }),
        getRemotes: async () => [],
        remote: async () => '',
        log: async () => ({ total: 0 }),
    };
}

// simple-git takes a base directory string or options objects and merges them.
const simpleGit = jest.fn((...args) => {
    gitOptions.push(Object.assign({}, ...args.map(arg => (typeof arg === 'string' ? { baseDir: arg } : arg))));
    return createGit();
});

function setAndroidApp(value) {
    if (value === undefined) {
        delete process.env.SILLYBUNNY_ANDROID_APP;
    } else {
        process.env.SILLYBUNNY_ANDROID_APP = value;
    }
}

async function importModules() {
    jest.resetModules();
    await jest.unstable_mockModule('simple-git', () => ({
        simpleGit,
        CheckRepoActions: { IS_REPO_ROOT: 'root' },
    }));
    await jest.unstable_mockModule('command-exists', () => ({ sync: command => command === 'git' }));
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(temporaryDirectory, 'config.yaml'));
    return {
        serverAdmin: (await import('../src/endpoints/server-admin.js')).router,
        extensions: (await import('../src/endpoints/extensions.js')).router,
        createGitClient: (await import('../src/git/client.js')).createGitClient,
        loadPlugins: (await import('../src/plugin-loader.js')).loadPlugins,
    };
}

async function invoke(router, routePath, body = {}) {
    const route = router.stack.find(layer => layer.route?.path === routePath && layer.route.methods.post)?.route;
    if (!route) {
        throw new Error(`Missing POST handler: ${routePath}`);
    }
    const response = new EventEmitter();
    response.statusCode = 200;
    response.status = function (code) { this.statusCode = code; return this; };
    response.json = function (value) { this.body = value; return this; };
    response.send = function (value) { this.body = value; return this; };
    response.sendStatus = function (code) { this.statusCode = code; return this; };
    const request = {
        body,
        user: {
            profile: { handle: 'test-user', admin: false },
            directories: { extensions: path.join(temporaryDirectory, 'extensions') },
        },
    };
    await route.stack.at(-1).handle(request, response);
    return response;
}

function extensionSites(...sites) {
    return sites.map(site => `${site} in src/endpoints/extensions.js`);
}

const CALL_SITES = [
    {
        name: 'Server Tools status',
        sites: ['getVersion() in src/util.js', 'getRepositoryStatus() in src/endpoints/server-admin.js'],
        run: () => invoke(modules.serverAdmin, '/status'),
    },
    {
        name: 'Server Tools update',
        sites: ['getRepositoryStatus() in src/endpoints/server-admin.js', '/update in src/endpoints/server-admin.js'],
        run: () => invoke(modules.serverAdmin, '/update'),
    },
    {
        name: 'Server Tools branch list',
        sites: ['/branches in src/endpoints/server-admin.js'],
        run: () => invoke(modules.serverAdmin, '/branches'),
    },
    {
        name: 'Server Tools branch switch',
        sites: ['/switch-branch in src/endpoints/server-admin.js'],
        run: () => invoke(modules.serverAdmin, '/switch-branch', { branch: 'staging' }),
    },
    {
        name: 'extension update',
        sites: extensionSites('ensureExtensionRepo()', 'checkIfRepoIsUpToDate()', '/update'),
        run: () => invoke(modules.extensions, '/update', { extensionName: EXTENSION_NAME }),
    },
    {
        name: 'extension branch list',
        sites: extensionSites('ensureExtensionRepo()', '/branches'),
        run: () => invoke(modules.extensions, '/branches', { extensionName: EXTENSION_NAME }),
    },
    {
        name: 'extension branch switch',
        sites: extensionSites('ensureExtensionRepo()', '/switch'),
        run: () => invoke(modules.extensions, '/switch', { extensionName: EXTENSION_NAME, branch: 'main' }),
    },
    {
        name: 'extension version',
        sites: extensionSites('ensureExtensionRepo()', '/version', 'checkIfRepoIsUpToDate()'),
        run: () => invoke(modules.extensions, '/version', { extensionName: EXTENSION_NAME }),
    },
    {
        name: 'extension install',
        sites: ['SimpleGitClient in src/git/client.js'],
        run: () => modules.createGitClient({ backend: 'system' }),
    },
    {
        name: 'server plugin update at startup',
        sites: ['updatePlugins() in src/plugin-loader.js'],
        run: () => modules.loadPlugins({ use: jest.fn() }, path.join(temporaryDirectory, 'plugins')),
    },
];

beforeAll(() => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-android-git-environment-'));
    fs.mkdirSync(path.join(temporaryDirectory, 'extensions', EXTENSION_NAME), { recursive: true });
    fs.mkdirSync(path.join(temporaryDirectory, 'plugins', 'test-plugin'), { recursive: true });
    fs.writeFileSync(path.join(temporaryDirectory, 'config.yaml'), 'enableServerPlugins: true\nenableServerPluginsAutoUpdate: true\n');
});

beforeEach(() => {
    gitOptions.length = 0;
    for (const method of ['debug', 'info', 'log', 'warn', 'error']) {
        jest.spyOn(console, method).mockImplementation(() => {});
    }
});

afterEach(() => {
    jest.restoreAllMocks();
});

afterAll(() => {
    setAndroidApp(originalAndroidApp);
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe.each([
    { mode: 'in the Android app', androidApp: '1', allowEnvironment: ANDROID_APP_GIT_ENVIRONMENT },
    { mode: 'outside the Android app', androidApp: undefined, allowEnvironment: undefined },
])('git environment guard $mode', ({ androidApp, allowEnvironment }) => {
    beforeAll(async () => {
        setAndroidApp(androidApp);
        modules = await importModules();
    });

    test.each(CALL_SITES)('$name', async ({ sites, run }) => {
        await run();

        expect(gitOptions.map((options, index) => [sites[index], options.allowEnvironment])).toEqual(sites.map(site => [site, allowEnvironment]));
    });
});
