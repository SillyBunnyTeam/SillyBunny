/**
 * Android smoke fixtures launcher (task 6.1).
 *
 * Starts any subset of the fixture services on random free loopback ports in 20000-49151 (inside the
 * 20000-60999 fixture range, never 4444), prints exactly one JSON line with every URL, port and scratch
 * path, and shuts down cleanly on SIGINT/SIGTERM (or, with --watch-stdin, when stdin closes; use that
 * on Windows).
 *
 *   node tests/android-smoke/launcher.js start [--services git,llm,update] [--scratch DIR]
 *       [--source DIR] [--ref REV] [--host 127.0.0.1] [--update-dir DIR] [--llm-chunk-delay-ms N] [--watch-stdin]
 *
 * Helper commands for later steps work on the scratch repositories directly, also while `start` runs.
 * Each prints one JSON line:
 *
 *   push-marker --repo DIR --branch NAME [--marker PATH]           step 4
 *   raise-min-app-version --repo DIR --branch NAME --above N       step 5
 *   publish --repo DIR [--branch NAME]                             steps 7 and 8 (pending update commit)
 *   heads --repo DIR                                               expected heads, tags and pending commits
 *   manifest --dir DIR --apk ABI=FILE... --version-code N --version-name S --release-tag T
 *       --node V --npm V --git V --bash V [--prerelease] [--default-ref release|staging] [--min-sdk N]
 *       [--signing-cert-sha256 HEX] [--inputs-hash HEX] [--base-url URL]   step 6
 *   seed-data --dir DATA_DIR [--user NAME]                         step 14 baseline
 *   checksum --dir DATA_DIR [--baseline FILE] [--allow-added PREFIX]...  step 14 check (exit 1 on change)
 *
 * Emulator networking: `10.0.2.2` is not guest loopback, so the smoke job maps each fixture port into
 * the guest and the app addresses fixtures as guest 127.0.0.1. The JSON line lists the exact arguments
 * in `adbReverse` (prefix them with `adb -s <serial>`):
 *
 *   adb reverse tcp:<port> tcp:<port>            one per started service (git, llm, update)
 *   adb reverse --remove tcp:<port>              when the job is done (or: adb reverse --remove-all)
 *
 * Service ports come from 20000-49151, below the 49152-65535 range the app draws its own server port
 * from (PortPolicy.RANGE), so a reverse rule never takes the port the app's server wants.
 * Guest and host ports are the same, so the printed URLs work unchanged on the device:
 * `gradleProperties.debugRepoUrl`, `debugUpdateManifestUrl` and `debugReleasesApiUrl` are the debug
 * build overrides, `services.llm.baseUrl` is the Custom endpoint URL, and the extension and plugin
 * URLs are under `services.git.repos`. The real npm registry stays the npm source. The caller owns
 * the scratch directory; it is never removed. Starting again on the same scratch directory reuses its
 * repositories, helper commits included, but only when each is complete and the SillyBunny remote was
 * built from the requested source commit; otherwise `start` fails and names the repository.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { checksumTree, compareChecksums, seedDataFixture } from './data-fixture.js';
import { gitResult, runGit } from './git.js';
import { startGitServer } from './git-server.js';
import { startMockLlm } from './mock-llm.js';
import { DEVICE_PORT_MAX } from './ports.js';
import {
    buildExtensionRepo,
    buildPluginRepo,
    buildSillyBunnyRemote,
    EXTENSION_DEFAULT_BRANCH,
    EXTENSION_REPO,
    EXTENSION_SECOND_BRANCH,
    PLUGIN_DEFAULT_BRANCH,
    PLUGIN_REPO,
    PLUGIN_TAG,
    publishPending,
    pushMarkerCommit,
    raiseMinAppVersion,
    readRefs,
    resolveCommit,
    SILLYBUNNY_BRANCHES,
    SILLYBUNNY_REPO,
} from './repos.js';
import { startStaticServer } from './static-server.js';
import { MANIFEST_NAME, RELEASES_INDEX_NAME, writeUpdateFixture } from './update-manifest.js';

export const SERVICES = Object.freeze(['git', 'llm', 'update']);
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const BUILD_RECORD = 'git-fixtures.json';
const COMMIT_ID = /^[0-9a-f]{40}$/;

/**
 * Reads the build record of a scratch directory.
 * @param {string} file Record file.
 * @returns {Record<string, any>} Record, empty before the first build.
 */
function readBuildRecord(file) {
    if (!fs.existsSync(file)) {
        return {};
    }
    let record = null;
    try {
        record = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        // Reported below.
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error(`Unreadable build record ${file}; use a new --scratch.`);
    }
    return record;
}

/**
 * Writes the build record through a temporary file, so an interrupted write never leaves half a record.
 * @param {string} file Record file.
 * @param {Record<string, any>} record Record.
 */
function writeBuildRecord(file, record) {
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 4)}\n`);
    fs.renameSync(temporary, file);
}

/**
 * Checks that a repository an earlier run left in the scratch directory is the complete build its
 * record describes. Served as it is, a partial repository would fail only later, on the device.
 * @param {string} repo Repository.
 * @param {object} expected What the repository must hold.
 * @param {readonly string[]} expected.heads Branches.
 * @param {readonly string[]} [expected.tags] Tags.
 * @param {unknown[]} expected.commits Commits from the build record.
 */
function checkReusedRepository(repo, { heads, tags = [], commits }) {
    const problem = text => new Error(`${repo} ${text}; remove it or use a new --scratch.`);
    if (commits.length === 0 || !commits.every(commit => typeof commit === 'string' && COMMIT_ID.test(commit))) {
        throw problem('has no complete build record');
    }
    // --git-dir: a directory that is not a repository itself must not resolve to one around it.
    if (gitResult([`--git-dir=${repo}`, 'rev-parse', '--is-bare-repository']).stdout.trim() !== 'true') {
        throw problem('is not a bare repository');
    }
    const refs = readRefs(repo);
    const missing = [
        ...heads.filter(head => !refs.heads[head]).map(head => `branch ${head}`),
        ...tags.filter(tag => !refs.tags[tag]).map(tag => `tag ${tag}`),
        ...commits.filter(commit => !resolveCommit(repo, commit)).map(commit => `commit ${commit}`),
    ];
    if (missing.length > 0) {
        throw problem(`is incomplete (missing ${missing.join(', ')})`);
    }
}

/**
 * Builds the fixture repositories that are missing and checks the ones an earlier run left behind.
 * The builders put a repository in place only once it is complete, and each build is recorded at
 * once. A reused SillyBunny remote must come from the requested source commit.
 * @param {string} gitRoot Repositories root.
 * @param {object} options Options.
 * @param {string} options.source SillyBunny source repository.
 * @param {string} options.ref Source revision.
 * @param {string} options.tmpDir Temporary directory.
 * @param {string} options.recordFile Build record (kept across reuse of the scratch directory).
 * @returns {Record<string, object>} Repository facts.
 */
function ensureRepositories(gitRoot, { source, ref, tmpDir, recordFile }) {
    fs.mkdirSync(gitRoot, { recursive: true });
    const record = readBuildRecord(recordFile);

    const sillybunny = path.join(gitRoot, SILLYBUNNY_REPO);
    if (fs.existsSync(sillybunny)) {
        const entry = record.sillybunny ?? {};
        checkReusedRepository(sillybunny, { heads: SILLYBUNNY_BRANCHES, commits: [entry.commit] });
        const requested = runGit(['-C', source, 'rev-parse', '--verify', `${ref}^{commit}`]);
        if (entry.sourceCommit !== requested) {
            throw new Error(`${sillybunny} was built from ${entry.sourceCommit}, not ${requested} (${ref} in ${source}); remove it or use a new --scratch.`);
        }
    } else {
        const built = buildSillyBunnyRemote({ root: gitRoot, source, ref, tmpDir });
        record.sillybunny = { sourceCommit: built.sourceCommit, sourceTree: built.sourceTree, commit: built.commit };
        writeBuildRecord(recordFile, record);
    }

    const extension = path.join(gitRoot, EXTENSION_REPO);
    if (fs.existsSync(extension)) {
        const commits = Object.values(record.extension?.commits ?? {});
        checkReusedRepository(extension, { heads: [EXTENSION_DEFAULT_BRANCH, EXTENSION_SECOND_BRANCH], commits });
    } else {
        record.extension = { commits: buildExtensionRepo({ root: gitRoot }).commits };
        writeBuildRecord(recordFile, record);
    }

    const plugin = path.join(gitRoot, PLUGIN_REPO);
    if (fs.existsSync(plugin)) {
        const commits = Object.values(record.plugin?.commits ?? {});
        checkReusedRepository(plugin, { heads: [PLUGIN_DEFAULT_BRANCH], tags: [PLUGIN_TAG], commits });
    } else {
        const built = buildPluginRepo({ root: gitRoot });
        record.plugin = { commits: built.commits, tag: built.tag };
        writeBuildRecord(recordFile, record);
    }
    return record;
}

/**
 * Starts fixture services. The CLI's `start` command wraps this; JavaScript callers can use it directly.
 * @param {object} [options] Options.
 * @param {string[]} [options.services] Subset of git, llm and update.
 * @param {string} [options.scratch] Scratch directory (default: a new temporary directory).
 * @param {string} [options.source] SillyBunny source repository (default: this checkout).
 * @param {string} [options.ref] Source revision (default HEAD).
 * @param {string} [options.host] Bind host (default 127.0.0.1).
 * @param {string} [options.updateDir] Directory the update server serves (default `<scratch>/update`).
 * @param {number} [options.llmChunkDelayMs] Delay between mock stream chunks.
 * @returns {Promise<{info: object, close: () => Promise<void>}>} Running fixtures.
 */
export async function startFixtures({
    services = SERVICES,
    scratch,
    source = REPO_ROOT,
    ref = 'HEAD',
    host = '127.0.0.1',
    updateDir,
    llmChunkDelayMs = 0,
} = {}) {
    const unknown = services.filter(service => !SERVICES.includes(service));
    if (services.length === 0 || unknown.length > 0) {
        throw new Error(`Unknown services: ${unknown.join(', ') || '(none given)'}`);
    }
    const scratchDir = path.resolve(scratch ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-android-smoke-')));
    const dirs = {
        git: path.join(scratchDir, 'git'),
        update: path.resolve(updateDir ?? path.join(scratchDir, 'update')),
        logs: path.join(scratchDir, 'logs'),
        home: path.join(scratchDir, 'home'),
        tmp: path.join(scratchDir, 'tmp'),
    };
    for (const directory of [dirs.logs, dirs.home, dirs.tmp]) {
        fs.mkdirSync(directory, { recursive: true });
    }

    const running = [];
    const info = { ok: true, pid: process.pid, scratch: scratchDir, logs: dirs.logs, services: {}, gradleProperties: {}, adbReverse: [] };
    try {
        if (services.includes('git')) {
            const record = ensureRepositories(dirs.git, {
                source,
                ref,
                tmpDir: dirs.tmp,
                recordFile: path.join(scratchDir, BUILD_RECORD),
            });
            const log = path.join(dirs.logs, 'git.jsonl');
            const git = await startGitServer({ projectRoot: dirs.git, host, maxPort: DEVICE_PORT_MAX, logFile: log, home: dirs.home });
            running.push(git);
            const describeRepo = (name, extra) => ({
                name,
                path: path.join(dirs.git, name),
                url: git.urlFor(name),
                ...readRefs(path.join(dirs.git, name)),
                ...extra,
            });
            info.services.git = {
                port: git.port,
                url: git.url,
                root: dirs.git,
                log,
                repos: {
                    sillybunny: describeRepo(SILLYBUNNY_REPO, record.sillybunny),
                    extension: describeRepo(EXTENSION_REPO, record.extension),
                    plugin: describeRepo(PLUGIN_REPO, record.plugin),
                },
            };
            info.gradleProperties.debugRepoUrl = git.urlFor(SILLYBUNNY_REPO);
        }
        if (services.includes('llm')) {
            const log = path.join(dirs.logs, 'llm.jsonl');
            const llm = await startMockLlm({ host, maxPort: DEVICE_PORT_MAX, logFile: log, chunkDelayMs: llmChunkDelayMs });
            running.push(llm);
            info.services.llm = { port: llm.port, url: llm.url, baseUrl: llm.baseUrl, model: llm.model, log };
        }
        if (services.includes('update')) {
            const log = path.join(dirs.logs, 'update.jsonl');
            const update = await startStaticServer({ root: dirs.update, host, maxPort: DEVICE_PORT_MAX, logFile: log });
            running.push(update);
            info.services.update = {
                port: update.port,
                url: update.url,
                root: dirs.update,
                manifestUrl: `${update.url}/${MANIFEST_NAME}`,
                releasesUrl: `${update.url}/${RELEASES_INDEX_NAME}`,
                log,
            };
            info.gradleProperties.debugUpdateManifestUrl = info.services.update.manifestUrl;
            info.gradleProperties.debugReleasesApiUrl = info.services.update.releasesUrl;
        }
    } catch (error) {
        await Promise.allSettled(running.map(server => server.close()));
        throw error;
    }

    info.adbReverse = Object.entries(info.services).map(([service, details]) => ({
        service,
        devicePort: details.port,
        hostPort: details.port,
        args: ['reverse', `tcp:${details.port}`, `tcp:${details.port}`],
        removeArgs: ['reverse', '--remove', `tcp:${details.port}`],
    }));

    let closing = null;
    return {
        info,
        close: () => {
            closing ??= Promise.all(running.map(server => server.close())).then(() => {});
            return closing;
        },
    };
}

const OPTIONS = {
    'services': { type: 'string' },
    'scratch': { type: 'string' },
    'source': { type: 'string' },
    'ref': { type: 'string' },
    'host': { type: 'string' },
    'update-dir': { type: 'string' },
    'llm-chunk-delay-ms': { type: 'string' },
    'watch-stdin': { type: 'boolean' },
    'repo': { type: 'string' },
    'branch': { type: 'string' },
    'marker': { type: 'string' },
    'above': { type: 'string' },
    'dir': { type: 'string' },
    'apk': { type: 'string', multiple: true },
    'version-code': { type: 'string' },
    'version-name': { type: 'string' },
    'release-tag': { type: 'string' },
    'prerelease': { type: 'boolean' },
    'default-ref': { type: 'string' },
    'min-sdk': { type: 'string' },
    'signing-cert-sha256': { type: 'string' },
    'inputs-hash': { type: 'string' },
    'base-url': { type: 'string' },
    'node': { type: 'string' },
    'npm': { type: 'string' },
    'git': { type: 'string' },
    'bash': { type: 'string' },
    'user': { type: 'string' },
    'baseline': { type: 'string' },
    'allow-added': { type: 'string', multiple: true },
    'help': { type: 'boolean' },
};

/** A command-line mistake. Output carries a machine code and the option, never prose. */
class UsageError extends Error {
    /**
     * @param {string} code Machine-readable code.
     * @param {Record<string, string>} [details] Offending option or value.
     */
    constructor(code, details = {}) {
        super(code);
        this.code = code;
        this.details = details;
    }
}

function required(values, name) {
    if (values[name] === undefined || values[name] === '') {
        throw new UsageError('missing-option', { option: name });
    }
    return values[name];
}

function integer(values, name, { optional = false } = {}) {
    if (optional && values[name] === undefined) {
        return undefined;
    }
    const text = required(values, name);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
        throw new UsageError('invalid-integer', { option: name });
    }
    return Number(text);
}

function serviceList(values) {
    if (values.services === undefined) {
        return undefined;
    }
    const services = values.services.split(',').map(item => item.trim()).filter(Boolean);
    const unknown = services.find(service => !SERVICES.includes(service));
    if (services.length === 0 || unknown !== undefined) {
        throw new UsageError('unknown-service', { option: 'services', value: unknown ?? '' });
    }
    return services;
}

function print(value) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}

function readBaseline(file) {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value?.manifest?.files ? value.manifest : value;
}

async function runStart(values) {
    const fixtures = await startFixtures({
        services: serviceList(values),
        scratch: values.scratch,
        source: values.source,
        ref: values.ref,
        host: values.host,
        updateDir: values['update-dir'],
        llmChunkDelayMs: integer(values, 'llm-chunk-delay-ms', { optional: true }),
    });
    let stopping = false;
    const stop = async () => {
        if (stopping) {
            return;
        }
        stopping = true;
        try {
            await fixtures.close();
            process.exit(0);
        } catch {
            process.exit(1);
        }
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    if (values['watch-stdin']) {
        process.stdin.on('end', stop);
        process.stdin.on('close', stop);
        process.stdin.resume();
    }
    print(fixtures.info);
}

const COMMANDS = {
    start: runStart,
    'push-marker': async (values) => {
        const repo = path.resolve(required(values, 'repo'));
        print({ ok: true, repo, ...pushMarkerCommit({ repo, branch: required(values, 'branch'), marker: values.marker }) });
    },
    'raise-min-app-version': async (values) => {
        const repo = path.resolve(required(values, 'repo'));
        print({ ok: true, repo, ...raiseMinAppVersion({ repo, branch: required(values, 'branch'), above: integer(values, 'above') }) });
    },
    publish: async (values) => {
        const repo = path.resolve(required(values, 'repo'));
        print({ ok: true, repo, ...publishPending({ repo, branch: values.branch }) });
    },
    heads: async (values) => {
        const repo = path.resolve(required(values, 'repo'));
        print({ ok: true, repo, ...readRefs(repo) });
    },
    manifest: async (values) => {
        const apks = {};
        for (const item of values.apk ?? []) {
            const separator = item.indexOf('=');
            if (separator <= 0) {
                throw new UsageError('invalid-apk', { option: 'apk', value: item });
            }
            apks[item.slice(0, separator)] = path.resolve(item.slice(separator + 1));
        }
        if (Object.keys(apks).length === 0) {
            throw new UsageError('missing-option', { option: 'apk' });
        }
        const defaultRef = values['default-ref'] ?? 'release';
        if (defaultRef !== 'release' && defaultRef !== 'staging') {
            throw new UsageError('invalid-default-ref', { option: 'default-ref', value: defaultRef });
        }
        const result = await writeUpdateFixture({
            dir: path.resolve(required(values, 'dir')),
            apks,
            versionCode: integer(values, 'version-code'),
            versionName: required(values, 'version-name'),
            releaseTag: required(values, 'release-tag'),
            prerelease: values.prerelease === true,
            defaultRef,
            minSdk: integer(values, 'min-sdk', { optional: true }) ?? 29,
            signingCertSha256: values['signing-cert-sha256'],
            inputsHash: values['inputs-hash'],
            runtime: {
                node: required(values, 'node'),
                npm: required(values, 'npm'),
                git: required(values, 'git'),
                bash: required(values, 'bash'),
            },
            baseUrl: values['base-url'],
        });
        print({ ok: true, ...result });
    },
    'seed-data': async (values) => {
        const dir = path.resolve(required(values, 'dir'));
        print({ ok: true, dir, ...(await seedDataFixture(dir, values.user ? { user: values.user } : {})) });
    },
    checksum: async (values) => {
        const dir = path.resolve(required(values, 'dir'));
        const manifest = await checksumTree(dir);
        if (!values.baseline) {
            print({ ok: true, dir, manifest });
            return;
        }
        const allowAdded = values['allow-added'];
        const comparison = compareChecksums(readBaseline(values.baseline), manifest, allowAdded ? { allowAdded } : {});
        print({ dir, digest: manifest.digest, ...comparison });
        if (!comparison.ok) {
            process.exitCode = 1;
        }
    },
};

/**
 * Runs the CLI.
 * @param {string[]} argv Arguments after the script path.
 * @returns {Promise<void>}
 */
export async function main(argv) {
    let command = 'start';
    let args = argv;
    if (argv[0] && !argv[0].startsWith('-')) {
        command = argv[0];
        args = argv.slice(1);
    }
    try {
        const { values } = parseArgs({ args, options: OPTIONS, strict: true, allowPositionals: false });
        if (values.help || command === 'help') {
            process.stdout.write('TODO(copy)\n');
            return;
        }
        const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
        if (!handler) {
            throw new UsageError('unknown-command', { value: command });
        }
        await handler(values);
    } catch (error) {
        if (error instanceof UsageError) {
            print({ ok: false, error: 'TODO(copy)', code: error.code, ...error.details });
            process.exitCode = 2;
        } else if (String(error?.code ?? '').startsWith('ERR_PARSE_ARGS')) {
            print({ ok: false, error: 'TODO(copy)', code: 'invalid-arguments' });
            process.exitCode = 2;
        } else {
            // Diagnostics for the CI log: the failing step's own message (git, fs, validation).
            print({ ok: false, error: 'TODO(copy)', code: 'failed', detail: String(error?.message ?? error) });
            process.exitCode = 1;
        }
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    await main(process.argv.slice(2));
}
