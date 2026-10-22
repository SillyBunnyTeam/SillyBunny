/* eslint-disable playwright/no-standalone-expect -- Jest tests, test.each tables and conditional blocks are not Playwright tests. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import zlib from 'node:zlib';

import urlJoin from 'url-join';

import { read as readCharacterCard } from '../src/character-card-parser.js';
import {
    CHARACTER_FILE,
    checksumTree,
    compareChecksums,
    DATA_USER,
    fixtureCharacterCard,
    seedDataFixture,
} from './android-smoke/data-fixture.js';
import { startGitServer } from './android-smoke/git-server.js';
import { createGitEnv, FIXTURE_EPOCH, gitResultAsync, runGit, runGitAsync } from './android-smoke/git.js';
import { startFixtures } from './android-smoke/launcher.js';
import { MOCK_MODEL_ID, MOCK_REPLY, startMockLlm } from './android-smoke/mock-llm.js';
import {
    closeHttpServer,
    DEVICE_PORT_MAX,
    guardRequestHandler,
    isFixturePort,
    listenOnFixturePort,
    PORT_MAX,
    PORT_MIN,
} from './android-smoke/ports.js';
import {
    buildExtensionRepo,
    buildPluginRepo,
    buildSillyBunnyRemote,
    initBareRepository,
    MARKER_PATH,
    MIN_APP_VERSION_PATH,
    PLUGIN_ID,
    PLUGIN_TAG,
    publishPending,
    pushMarkerCommit,
    raiseMinAppVersion,
    readRefs,
    updateRefs,
    writeCommit,
} from './android-smoke/repos.js';
import { startStaticServer } from './android-smoke/static-server.js';
import {
    checkReleasesIndex,
    checkUpdateManifest,
    colonFingerprint,
    createUpdateManifest,
    findApksigner,
    isAllowedUpdateUrl,
    MAX_APK_BYTES,
    parseUpdateManifest,
    readSigningCertSha256,
    writeUpdateFixture,
} from './android-smoke/update-manifest.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = path.join(REPO_ROOT, 'tests', 'android-smoke', 'launcher.js');
const IS_WINDOWS = process.platform === 'win32';
const JAVA_NAME = IS_WINDOWS ? 'java.exe' : 'java';
/** Runs a block only where its tool or platform exists; the block name says what it needs. */
const describeIf = condition => (condition ? describe : describe.skip);
const RUNTIME = Object.freeze({ node: '24.22.0', git: '2.56.0', bash: '5.3.20', npm: '11.6.2' });
const SIGNER = 'ab'.repeat(32);
// Big enough that pack generation outlasts every socket and pipe buffer when the client stops reading.
const STALL_BLOB_BYTES = 16 * 1024 * 1024;

// Request targets that Node's HTTP parser accepts and WHATWG URL rejects.
const MALFORMED_TARGETS = Object.freeze(['//[', '//a:b:c/', 'http://%zz/', '//:99999/']);

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-smoke-fixtures-'));

/** Cleanups for what the running test started. afterEach runs them even when the test failed or timed out. */
const cleanups = [];

function onCleanup(cleanup) {
    cleanups.push(cleanup);
}

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        try {
            await cleanup();
        } catch {
            // Keep cleaning up; the test reports its own failure.
        }
    }
}, 60000);

afterAll(() => {
    fs.rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 3 });
});

/**
 * Resolves whether a promise settles within a time limit.
 * @param {Promise<unknown>} promise Promise.
 * @param {number} ms Time limit.
 * @returns {Promise<boolean>} True when it settled in time.
 */
function settlesWithin(promise, ms) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
    });
    return Promise.race([promise.then(() => true, () => true), timeout]).finally(() => clearTimeout(timer));
}

function malformedRequest(target) {
    return `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`;
}

function scratchDir(name) {
    return fs.mkdtempSync(path.join(scratchRoot, `${name}-`));
}

function sha256(data) {
    return createHash('sha256').update(data).digest('hex');
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeFiles(root, files) {
    for (const [file, contents] of Object.entries(files)) {
        const target = path.join(root, ...file.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
    }
}

/**
 * A small stand-in for a SillyBunny checkout: one commit on `staging` with the files the fixtures touch.
 * @param {string} dir Directory.
 * @param {Record<string, string|Buffer>} [files] Extra files.
 * @returns {{path: string, head: string, tree: string}} Repository facts.
 */
function createSourceRepo(dir, files = {}) {
    runGit(['init', '--quiet', '--initial-branch=staging', dir]);
    writeFiles(dir, {
        'package.json': '{\n    "name": "sillybunny-smoke-source",\n    "private": true\n}\n',
        [MIN_APP_VERSION_PATH]: '1\n',
        ...files,
    });
    runGit(['-C', dir, 'add', '--all']);
    runGit(['-C', dir, 'commit', '--quiet', '-m', 'lorum ipsum']);
    return {
        path: dir,
        head: runGit(['-C', dir, 'rev-parse', 'HEAD']),
        tree: runGit(['-C', dir, 'rev-parse', 'HEAD^{tree}']),
    };
}

/**
 * Plain HTTP request without decompression or connection reuse.
 * @param {string} url URL.
 * @param {{method?: string, headers?: Record<string, string>, body?: string|Buffer}} [options] Options.
 * @returns {Promise<{status: number, headers: import('node:http').IncomingHttpHeaders, body: Buffer}>} Response.
 */
function request(url, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const outgoing = http.request(url, { method, headers, agent: false }, (response) => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
            response.on('error', reject);
        });
        outgoing.on('error', reject);
        outgoing.end(body);
    });
}

function postJson(url, value) {
    return request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
}

/**
 * Writes raw bytes to a server and collects everything it sends until it closes the connection.
 * @param {number} port Port.
 * @param {string|Buffer} data Request bytes.
 * @returns {Promise<string>} Response text.
 */
function rawExchange(port, data) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const socket = net.connect({ host: '127.0.0.1', port }, () => socket.write(data));
        socket.setTimeout(15000, () => socket.destroy(new Error('timeout')));
        socket.on('data', chunk => chunks.push(chunk));
        socket.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
        socket.on('error', reject);
    });
}

function pktLine(text) {
    const payload = Buffer.from(text, 'utf8');
    return Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, '0'), 'ascii'), payload]);
}

/**
 * Starts a protocol v2 fetch of one commit and stops reading after the first response bytes, so the
 * backend stays busy until the server kills it.
 * @param {number} port Git server port.
 * @param {string} repository Repository name.
 * @param {string} commit Commit to fetch.
 * @returns {Promise<{socket: import('node:net').Socket, first: Buffer}>} Paused socket and the first chunk.
 */
function stalledFetch(port, repository, commit) {
    const body = Buffer.concat([pktLine('command=fetch\n'), Buffer.from('0001'), pktLine(`want ${commit}\n`), pktLine('done\n'), Buffer.from('0000')]);
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port }, () => {
            socket.write([
                `POST /${repository}/git-upload-pack HTTP/1.1`,
                `Host: 127.0.0.1:${port}`,
                'Git-Protocol: version=2',
                'Content-Type: application/x-git-upload-pack-request',
                'Accept: application/x-git-upload-pack-result',
                `Content-Length: ${body.length}`,
                '',
                '',
            ].join('\r\n'));
            socket.write(body);
        });
        socket.once('data', (chunk) => {
            socket.pause();
            resolve({ socket, first: chunk });
        });
        socket.on('error', reject);
    });
}

/** @returns {[number, number][]} Every process as [pid, parent pid]. */
function processTable() {
    const result = IS_WINDOWS
        ? spawnSync('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
        ], { encoding: 'utf8', windowsHide: true })
        : spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(`process listing failed: ${result.error?.message ?? result.stderr}`);
    }
    return result.stdout.split(/\r?\n/)
        .map(line => line.trim().split(/\s+/).map(Number))
        .filter(([pid, parent]) => Number.isInteger(pid) && Number.isInteger(parent));
}

function descendantsOf(root) {
    const table = processTable();
    const found = [];
    let frontier = [root];
    while (frontier.length > 0) {
        const next = table.filter(([pid, parent]) => frontier.includes(parent) && pid !== root && !found.includes(pid)).map(([pid]) => pid);
        found.push(...next);
        frontier = next;
    }
    return found;
}

async function waitForDescendants(root, minimum, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let found = descendantsOf(root);
    while (found.length < minimum && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
        found = descendantsOf(root);
    }
    return found;
}

function isAlive(pid) {
    try {
        process.kill(pid, 0);
    } catch (error) {
        return error.code === 'EPERM';
    }
    if (process.platform !== 'linux') {
        return true;
    }
    try {
        // A zombie has exited and only waits for its reaper; the state follows the parenthesised name.
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat[stat.lastIndexOf(')') + 2] !== 'Z';
    } catch {
        return false;
    }
}

function connectionRefused(port) {
    return new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.once('connect', () => {
            socket.destroy();
            resolve(false);
        });
        socket.once('error', error => resolve(error.code === 'ECONNREFUSED'));
    });
}

/**
 * Stops a launcher that a failing test left running: first the way the test would have, so it closes
 * its services and their git backends, then by force together with every process it started.
 * @param {{child: import('node:child_process').ChildProcess, exited: Promise<object>}} launcher Launcher.
 */
async function cleanUpLauncher(launcher) {
    const { child } = launcher;
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    child.stdin.end();
    if (!IS_WINDOWS) {
        child.kill('SIGTERM');
    }
    if (await settlesWithin(launcher.exited, 15000)) {
        return;
    }
    if (IS_WINDOWS) {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
        for (const pid of [...descendantsOf(child.pid), child.pid]) {
            try {
                process.kill(pid, 'SIGKILL');
            } catch {
                // Already gone.
            }
        }
    }
    await settlesWithin(launcher.exited, 15000);
}

/**
 * Runs `launcher.js start` and resolves its JSON line. The launcher also watches stdin everywhere, so
 * it stops by itself if this process dies; afterEach stops it if the test does not.
 * @param {string[]} args Arguments after `start`.
 */
function startLauncher(args) {
    const child = spawn(process.execPath, [LAUNCHER, 'start', ...args, '--watch-stdin'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    // stdin only signals shutdown (--watch-stdin); a launcher that already exited must not fail the test with EPIPE.
    child.stdin.on('error', () => {});
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', chunk => stderr += chunk);
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
    const line = new Promise((resolve, reject) => {
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
            const end = stdout.indexOf('\n');
            if (end >= 0) {
                resolve(JSON.parse(stdout.slice(0, end)));
            }
        });
        exited.then(({ code }) => reject(new Error(`launcher exited with ${code}: ${stdout}${stderr}`)));
    });
    const launcher = { child, line, exited, output: () => ({ stdout, stderr }) };
    onCleanup(() => cleanUpLauncher(launcher));
    return launcher;
}

/** SIGTERM/SIGINT on POSIX; on Windows, where signals cannot be caught, closing stdin (`--watch-stdin`). */
function stopLauncher(launcher, signal = 'SIGTERM') {
    if (IS_WINDOWS) {
        launcher.child.stdin.end();
    } else {
        launcher.child.kill(signal);
    }
    return launcher.exited;
}

function parseJsonLine(line) {
    try {
        return JSON.parse(line);
    } catch {
        // `--help` prints its usage text, not JSON.
        return null;
    }
}

function runCli(args) {
    const result = spawnSync(process.execPath, [LAUNCHER, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    const lines = result.stdout.split('\n').filter(Boolean);
    return { status: result.status, stderr: result.stderr, lines, json: lines.length === 1 ? parseJsonLine(lines[0]) : null };
}

function findNpmCli() {
    const directory = path.dirname(process.execPath);
    return [
        path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ].find(candidate => fs.existsSync(candidate)) ?? null;
}

function findKeytool() {
    const name = IS_WINDOWS ? 'keytool.exe' : 'keytool';
    const candidates = [process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', name) : null, 'keytool'].filter(Boolean);
    return candidates.find(candidate => spawnSync(candidate, ['-help'], { stdio: 'ignore', windowsHide: true }).status === 0) ?? null;
}

/**
 * A ZIP with stored entries, enough for apksigner to sign.
 * @param {Record<string, Buffer>} entries Entries.
 * @returns {Buffer} Archive.
 */
function storedZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, data] of Object.entries(entries)) {
        const nameBytes = Buffer.from(name, 'utf8');
        const crc = zlib.crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        locals.push(local, nameBytes, data);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBytes);
        offset += local.length + nameBytes.length + data.length;
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(entries).length, 8);
    end.writeUInt16LE(Object.keys(entries).length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
}

describe('fixture request handling', () => {
    test('a failing request handler ends only its own request', async () => {
        const logged = [];
        const server = http.createServer(guardRequestHandler(async (incoming, response) => {
            if (incoming.url === '/before-headers') {
                throw new Error('lorum ipsum');
            }
            if (incoming.url === '/after-headers') {
                response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                response.write('lorum');
                throw new Error('lorum ipsum');
            }
            response.end('ok');
        }, entry => logged.push(entry)));
        const port = await listenOnFixturePort(server);
        onCleanup(() => closeHttpServer(server));

        const failed = await request(`http://127.0.0.1:${port}/before-headers`);
        expect([failed.status, failed.headers['content-type'], failed.body.toString('utf8')]).toEqual([500, 'text/plain; charset=utf-8', 'lorum ipsum\n']);
        // Once the status line is out, the only honest answer is a reset.
        await expect(request(`http://127.0.0.1:${port}/after-headers`)).rejects.toThrow();
        expect((await request(`http://127.0.0.1:${port}/`)).body.toString('utf8')).toBe('ok');
        expect(logged).toEqual([
            { time: expect.any(String), method: 'GET', path: '/before-headers', status: 500, error: 'lorum ipsum' },
            { time: expect.any(String), method: 'GET', path: '/after-headers', status: 200, error: 'lorum ipsum' },
        ]);
    });
});

describe('git smart-HTTP server', () => {
    let dir;
    let root;
    let env;
    let source;
    let remote;
    let extension;
    let plugin;
    let server;
    let logFile;

    beforeAll(async () => {
        dir = scratchDir('git');
        root = path.join(dir, 'repos');
        const home = path.join(dir, 'home');
        fs.mkdirSync(home, { recursive: true });
        env = createGitEnv({ home });
        source = createSourceRepo(path.join(dir, 'source'));
        remote = buildSillyBunnyRemote({ root, source: source.path, tmpDir: path.join(dir, 'tmp') });
        extension = buildExtensionRepo({ root });
        plugin = buildPluginRepo({ root });
        logFile = path.join(dir, 'logs', 'git.jsonl');
        server = await startGitServer({ projectRoot: root, logFile, home });
    }, 120000);

    afterAll(async () => {
        await server?.close();
    });

    test('listens on a random loopback port in the fixture range', () => {
        expect(isFixturePort(server.port)).toBe(true);
        expect(server.port).toBeGreaterThanOrEqual(PORT_MIN);
        expect(server.port).toBeLessThanOrEqual(PORT_MAX);
        expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
        expect(server.urlFor(remote.name)).toBe(`${server.url}/SillyBunny.git`);
    });

    test('clones the SillyBunny remote the way install.sh does, over protocol v2', async () => {
        const checkout = path.join(dir, 'install');
        const clone = await gitResultAsync([
            '-c', 'advice.detachedHead=false', 'clone', '--quiet', '--filter=blob:none', '--branch', 'release', '--',
            server.urlFor(remote.name), checkout,
        ], { env });
        expect(clone.stderr).toBe('');
        expect(clone.status).toBe(0);
        expect(await runGitAsync(['-C', checkout, 'rev-parse', 'HEAD', '@{upstream}'], { env })).toBe(`${remote.commit}\n${remote.commit}`);
        expect(await runGitAsync(['-C', checkout, 'rev-parse', '--abbrev-ref', '@{upstream}'], { env })).toBe('origin/release');
        expect(fs.readFileSync(path.join(checkout, 'android', 'min-app-version'), 'utf8')).toBe('1\n');

        const entries = server.requests.filter(entry => entry.repo === remote.name);
        expect(entries.length).toBeGreaterThanOrEqual(2);
        expect(entries.filter(entry => entry.service !== 'git-upload-pack' || entry.gitProtocol !== 'version=2' || entry.status !== 200)).toEqual([]);
        const logged = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(logged).toEqual(JSON.parse(JSON.stringify(server.requests)));
    }, 60000);

    test('delivers marker and min-app-version commits to a fetch like self-update.sh', async () => {
        const checkout = path.join(dir, 'self-update');
        await runGitAsync(['clone', '--quiet', '--filter=blob:none', '--branch', 'release', '--', server.urlFor(remote.name), checkout], { env });
        const before = readRefs(remote.path).heads.release;

        const marker = pushMarkerCommit({ repo: remote.path, branch: 'release' });
        expect(marker).toMatchObject({ branch: 'release', parent: before, marker: MARKER_PATH });
        await runGitAsync(['-C', checkout, 'fetch', '--quiet', 'origin'], { env });
        const upstream = await runGitAsync(['-C', checkout, 'rev-parse', 'origin/release'], { env });
        expect(upstream).toBe(marker.commit);
        await runGitAsync(['-C', checkout, 'merge', '--quiet', '--ff-only', upstream], { env });
        expect(fs.readFileSync(path.join(checkout, MARKER_PATH), 'utf8')).toBe(`release ${before}\n`);

        const raised = raiseMinAppVersion({ repo: remote.path, branch: 'release', above: 1 });
        expect(raised).toMatchObject({ branch: 'release', parent: marker.commit, minAppVersion: 2 });
        await runGitAsync(['-C', checkout, 'fetch', '--quiet', 'origin'], { env });
        // The gate reads the minimum from the checked SHA; this partial clone fetches that blob lazily.
        expect(await runGitAsync(['-C', checkout, 'show', `${raised.commit}:${MIN_APP_VERSION_PATH}`], { env })).toBe('2');
        expect(readRefs(remote.path).heads).toEqual({ release: raised.commit, staging: remote.commit });
    }, 60000);

    test('installs, updates and switches the extension the way the extension endpoints do', async () => {
        const checkout = path.join(dir, 'extensions', 'sillybunny-smoke-extension');
        const head = () => runGitAsync(['-C', checkout, 'rev-parse', 'HEAD'], { env });
        const version = () => readJson(path.join(checkout, 'manifest.json')).version;

        // POST /api/extensions/install: a shallow clone of the default branch.
        await runGitAsync(['clone', '--quiet', '--depth', '1', server.urlFor(extension.name), checkout], { env });
        expect(await head()).toBe(extension.commits.initial);
        expect(version()).toBe('1.0.0');

        // The update step publishes the pending commit; POST /api/extensions/update pulls the current branch.
        expect(publishPending({ repo: extension.path })).toEqual({ branch: 'main', parent: extension.commits.initial, commit: extension.commits.update });
        await runGitAsync(['-C', checkout, 'pull', '--quiet', 'origin', 'main'], { env });
        expect(await head()).toBe(extension.commits.update);
        expect(version()).toBe('1.1.0');

        // POST /api/extensions/branches unshallows and fetches every branch; /switch checks out origin/next.
        await runGitAsync(['-C', checkout, 'fetch', '--quiet', '--unshallow', 'origin'], { env });
        await runGitAsync(['-C', checkout, 'remote', 'set-branches', 'origin', '*'], { env });
        await runGitAsync(['-C', checkout, 'fetch', '--quiet', 'origin'], { env });
        await runGitAsync(['-C', checkout, 'checkout', '--quiet', '-b', 'next', 'origin/next'], { env });
        expect(await head()).toBe(extension.commits.next);
        expect(version()).toBe('2.0.0');
    }, 60000);

    test('refuses pushes and leaves the repositories unchanged', async () => {
        const before = readRefs(plugin.path);
        const checkout = path.join(dir, 'push');
        await runGitAsync(['clone', '--quiet', server.urlFor(plugin.name), checkout], { env });
        fs.writeFileSync(path.join(checkout, 'index.js'), 'export const info = {};\n');
        await runGitAsync(['-C', checkout, 'commit', '--quiet', '--all', '-m', 'lorum ipsum'], { env });

        const branchPush = await gitResultAsync(['-C', checkout, 'push', 'origin', 'HEAD:main'], { env });
        expect(branchPush.status).not.toBe(0);
        expect(branchPush.stderr).toContain('403');
        const tagPush = await gitResultAsync(['-C', checkout, 'push', 'origin', 'HEAD:refs/tags/v9.9.9'], { env });
        expect(tagPush.status).not.toBe(0);
        expect(readRefs(plugin.path)).toEqual(before);

        const advertisement = await request(`${server.urlFor(plugin.name)}/info/refs?service=git-receive-pack`);
        expect(advertisement.status).toBe(403);
        const direct = await request(`${server.urlFor(plugin.name)}/git-receive-pack`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-git-receive-pack-request' },
            body: '0000',
        });
        expect(direct.status).toBe(403);
        const refused = server.requests.filter(entry => entry.service === 'git-receive-pack');
        expect(refused.length).toBeGreaterThanOrEqual(4);
        expect(refused.filter(entry => !entry.refused || entry.status !== 403)).toEqual([]);
        expect(readRefs(plugin.path)).toEqual(before);
    }, 60000);

    test('passes Git-Protocol through to http-backend and hides fixture-internal refs', async () => {
        const url = `${server.urlFor(plugin.name)}/info/refs?service=git-upload-pack`;
        const v2 = await request(url, { headers: { 'Git-Protocol': 'version=2' } });
        expect(v2.status).toBe(200);
        expect(v2.headers['content-type']).toBe('application/x-git-upload-pack-advertisement');
        expect(v2.body.toString('latin1')).toContain('version 2\n');

        const v0 = await request(url);
        expect(v0.status).toBe(200);
        const advertised = v0.body.toString('latin1');
        expect(advertised).toContain('# service=git-upload-pack');
        expect(advertised).toContain('refs/heads/main');
        expect(advertised).not.toContain('version 2');
        expect(advertised).not.toContain('refs/fixture/');

        // ls-remote looks for a repository in its directory; keep it out of this checkout.
        const listed = await runGitAsync(['ls-remote', server.urlFor(plugin.name)], { env, cwd: dir });
        expect(listed).toContain(`${plugin.commits.initial}\trefs/tags/${PLUGIN_TAG}^{}`);
        expect(listed).not.toContain('refs/fixture/');
    }, 60000);

    test('serves only smart-HTTP upload-pack routes', async () => {
        const base = server.urlFor(plugin.name);
        expect((await request(`${base}/HEAD`)).status).toBe(404);
        expect((await request(`${base}/objects/info/packs`)).status).toBe(404);
        expect((await request(`${base}/info/refs`)).status).toBe(403);
        expect((await request(`${server.url}/missing.git/info/refs?service=git-upload-pack`)).status).toBe(404);
        expect((await request(`${base}/info/refs?service=git-upload-pack`, { method: 'POST' })).status).toBe(405);
        expect((await request(`${base}/git-upload-pack`)).status).toBe(405);
        // The repository name also resolves without the .git suffix, like GitHub.
        expect((await request(`${server.url}/sillybunny-smoke-plugin/info/refs?service=git-upload-pack`)).status).toBe(200);
    });

    test('answers request targets that URL rejects with 400 and keeps serving', async () => {
        for (const target of MALFORMED_TARGETS) {
            const reply = await rawExchange(server.port, malformedRequest(target));
            expect([target, reply.split('\r\n')[0], reply.includes('\r\n\r\n') && reply.includes('lorum ipsum\n')]).toEqual([target, 'HTTP/1.1 400 Bad Request', true]);
        }
        // Backend requests are logged when the backend exits, so select by path rather than by position.
        const logged = server.requests.filter(entry => MALFORMED_TARGETS.includes(entry.path));
        expect(logged.map(entry => [entry.path, entry.status, entry.refused])).toEqual(MALFORMED_TARGETS.map(target => [target, 400, true]));
        expect((await request(`${server.urlFor(plugin.name)}/info/refs?service=git-upload-pack`)).status).toBe(200);
    });

    test('bounds request bodies', async () => {
        const limited = await startGitServer({ projectRoot: root, maxRequestBytes: 1024 });
        try {
            const head = `POST /${plugin.name}/git-upload-pack HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/x-git-upload-pack-request\r\n`;
            const declared = await rawExchange(limited.port, `${head}Content-Length: 4096\r\n\r\n`);
            expect(declared).toMatch(/^HTTP\/1\.1 413 /);
            const chunked = await rawExchange(limited.port, Buffer.concat([
                Buffer.from(`${head}Transfer-Encoding: chunked\r\n\r\n${(2048).toString(16)}\r\n`),
                Buffer.alloc(2048, 0x30),
                Buffer.from('\r\n'),
            ]));
            expect(chunked).toMatch(/^HTTP\/1\.1 413 /);
            expect(limited.requests.map(entry => [entry.status, entry.refused])).toEqual([[413, true], [413, true]]);
        } finally {
            await limited.close();
        }
    });

    test('close() stops in-flight backends and every process they started', async () => {
        const bigRoot = path.join(dir, 'big');
        const repo = initBareRepository(path.join(bigRoot, 'big.git'), 'main');
        const commit = writeCommit({ repo, files: { 'blob.bin': randomBytes(STALL_BLOB_BYTES) }, time: FIXTURE_EPOCH });
        updateRefs(repo, [{ ref: 'refs/heads/main', next: commit, previous: null }]);
        const local = await startGitServer({ projectRoot: bigRoot });
        onCleanup(() => local.close());

        const stalled = await stalledFetch(local.port, 'big.git', commit);
        onCleanup(() => stalled.socket.destroy());
        expect(stalled.first.toString('latin1')).toMatch(/^HTTP\/1\.1 200 /);
        expect(local.activePids()).toHaveLength(1);
        const [backend] = local.activePids();
        // http-backend and upload-pack (and pack-objects) run under the spawned `git`.
        const tree = [backend, ...await waitForDescendants(backend, 2)];
        expect(tree.length).toBeGreaterThanOrEqual(3);
        expect(tree.filter(isAlive)).toEqual(tree);

        await local.close();
        stalled.socket.destroy();
        expect(local.activePids()).toEqual([]);
        expect(tree.filter(isAlive)).toEqual([]);
    }, 120000);
});

describe('fixture repository builders', () => {
    test('builds release and staging from a source commit without writing to the source', () => {
        const dir = scratchDir('remote');
        const source = createSourceRepo(path.join(dir, 'source'));
        const snapshot = () => ({
            refs: runGit(['-C', source.path, 'for-each-ref', '--format=%(refname) %(objectname)']),
            head: runGit(['-C', source.path, 'rev-parse', 'HEAD']),
            objects: runGit(['-C', source.path, 'count-objects', '-v']),
            status: runGit(['-C', source.path, 'status', '--porcelain', '--ignored']),
            gitFiles: fs.readdirSync(path.join(source.path, '.git')).sort(),
        });
        const before = snapshot();

        const remote = buildSillyBunnyRemote({ root: path.join(dir, 'repos'), source: source.path, tmpDir: path.join(dir, 'tmp') });
        expect(remote).toMatchObject({ name: 'SillyBunny.git', sourceCommit: source.head, sourceTree: source.tree });
        expect(readRefs(remote.path)).toEqual({ heads: { release: remote.commit, staging: remote.commit }, tags: {}, pending: {} });
        expect(runGit(['-C', remote.path, 'rev-parse', `${remote.commit}^{tree}`])).toBe(source.tree);
        expect(runGit(['-C', remote.path, 'rev-list', '--count', remote.commit])).toBe('1');
        expect(runGit(['-C', remote.path, 'show', `${remote.commit}:${MIN_APP_VERSION_PATH}`])).toBe('1');
        expect(snapshot()).toEqual(before);
        expect(fs.readdirSync(path.join(dir, 'tmp'))).toEqual([]);
        expect(() => buildSillyBunnyRemote({ root: path.join(dir, 'repos'), source: source.path })).toThrow('already exists');
    }, 60000);

    test('builds the SillyBunny remote from another revision of the source', () => {
        const dir = scratchDir('remote-ref');
        const source = createSourceRepo(path.join(dir, 'source'));
        writeFiles(source.path, { 'later.txt': 'lorum ipsum\n' });
        runGit(['-C', source.path, 'add', '--all']);
        runGit(['-C', source.path, 'commit', '--quiet', '-m', 'lorum ipsum']);

        const remote = buildSillyBunnyRemote({ root: path.join(dir, 'repos'), source: source.path, ref: 'HEAD~1', tmpDir: path.join(dir, 'tmp') });
        expect(remote).toMatchObject({ sourceCommit: source.head, sourceTree: source.tree });
        expect(runGit(['-C', remote.path, 'ls-tree', '--name-only', '-r', 'release'])).not.toContain('later.txt');
    }, 60000);

    test('leaves nothing behind when a build fails after creating the repository', () => {
        const dir = scratchDir('remote-failed');
        const root = path.join(dir, 'repos');
        const tmpDir = path.join(dir, 'tmp');
        const source = createSourceRepo(path.join(dir, 'source'));
        // The invalid branch name fails the push into the new, still empty repository.
        expect(() => buildSillyBunnyRemote({ root, source: source.path, branches: ['release', 'bad..name'], tmpDir })).toThrow('push');
        expect(fs.readdirSync(root)).toEqual([]);
        expect(fs.readdirSync(tmpDir)).toEqual([]);

        const remote = buildSillyBunnyRemote({ root, source: source.path, tmpDir });
        expect(readRefs(remote.path).heads).toEqual({ release: remote.commit, staging: remote.commit });
        expect(buildExtensionRepo({ root }).path).toBe(path.join(root, 'sillybunny-smoke-extension.git'));
        expect(buildPluginRepo({ root }).path).toBe(path.join(root, 'sillybunny-smoke-plugin.git'));
        expect(fs.readdirSync(root).sort()).toEqual(['SillyBunny.git', 'sillybunny-smoke-extension.git', 'sillybunny-smoke-plugin.git']);
        expect(() => buildExtensionRepo({ root })).toThrow('already exists');
        expect(() => buildPluginRepo({ root })).toThrow('already exists');
    }, 60000);

    test('publishes marker and min-app-version commits and reports the expected heads', () => {
        const dir = scratchDir('helpers');
        const remote = buildSillyBunnyRemote({ root: path.join(dir, 'repos'), source: createSourceRepo(path.join(dir, 'source')).path, tmpDir: path.join(dir, 'tmp') });

        const marker = pushMarkerCommit({ repo: remote.path, branch: 'release' });
        expect(marker).toEqual({ branch: 'release', parent: remote.commit, commit: expect.stringMatching(/^[0-9a-f]{40}$/), marker: MARKER_PATH });
        expect(runGit(['-C', remote.path, 'show', `release:${MARKER_PATH}`])).toBe(`release ${remote.commit}`);
        expect(runGit(['-C', remote.path, 'rev-parse', 'release^'])).toBe(remote.commit);
        const custom = pushMarkerCommit({ repo: remote.path, branch: 'staging', marker: 'step-4.txt', contents: 'lorum ipsum\n' });
        expect(runGit(['-C', remote.path, 'show', 'staging:step-4.txt'])).toBe('lorum ipsum');

        const raised = raiseMinAppVersion({ repo: remote.path, branch: 'release', above: 41 });
        expect(raised).toEqual({ branch: 'release', parent: marker.commit, commit: expect.stringMatching(/^[0-9a-f]{40}$/), minAppVersion: 42 });
        expect(runGit(['-C', remote.path, 'show', `release:${MIN_APP_VERSION_PATH}`])).toBe('42');
        // Only the minimum changes; the marker from the previous step stays.
        expect(runGit(['-C', remote.path, 'diff', '--name-only', marker.commit, raised.commit])).toBe(MIN_APP_VERSION_PATH);
        expect(readRefs(remote.path)).toEqual({ heads: { release: raised.commit, staging: custom.commit }, tags: {}, pending: {} });
        expect(() => raiseMinAppVersion({ repo: remote.path, branch: 'release', above: -1 })).toThrow('Invalid versionCode');
    }, 60000);

    test('builds a loadable UI extension with a pending update and a second branch', () => {
        const root = path.join(scratchDir('extension'), 'repos');
        const extension = buildExtensionRepo({ root });
        const { initial, update, next } = extension.commits;
        expect(readRefs(extension.path)).toEqual({ heads: { main: initial, next }, tags: {}, pending: { main: update } });
        expect(runGit(['-C', extension.path, 'symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
        expect(runGit(['-C', extension.path, 'rev-parse', `${update}^`, `${next}^`])).toBe(`${initial}\n${initial}`);

        const manifest = JSON.parse(runGit(['-C', extension.path, 'show', `${initial}:manifest.json`]));
        // public/scripts/extensions.js reads these fields; js and css name files in the repository.
        expect(manifest).toMatchObject({ display_name: 'lorum ipsum', js: 'index.js', css: 'style.css', requires: [], optional: [], loading_order: 100, version: '1.0.0' });
        expect(runGit(['-C', extension.path, 'ls-tree', '--name-only', initial]).split('\n').sort()).toEqual(['index.js', 'manifest.json', 'style.css']);
        const revisions = [[initial, 1, 'main', '1.0.0'], [update, 2, 'main', '1.1.0'], [next, 3, 'next', '2.0.0']].map(([commit, revision, branch, version]) => {
            const sandbox = {};
            vm.runInNewContext(runGit(['-C', extension.path, 'show', `${commit}:index.js`]), sandbox);
            return [sandbox.sillyBunnySmokeExtension, { version, revision, branch }];
        });
        expect(revisions.map(([loaded]) => loaded)).toEqual(revisions.map(([, expected]) => expected));
    }, 60000);

    test('builds a server plugin with a lockfile, an annotated tag and a pending update', async () => {
        const dir = scratchDir('plugin');
        const plugin = buildPluginRepo({ root: path.join(dir, 'repos') });
        const { initial, update } = plugin.commits;
        expect(plugin.tag).toBe('v1.0.0');
        expect(readRefs(plugin.path)).toEqual({ heads: { main: initial }, tags: { 'v1.0.0': initial }, pending: { main: update } });
        expect(runGit(['-C', plugin.path, 'cat-file', '-t', 'refs/tags/v1.0.0'])).toBe('tag');

        for (const [commit, version] of [[initial, '1.0.0'], [update, '1.1.0']]) {
            const packageJson = JSON.parse(runGit(['-C', plugin.path, 'show', `${commit}:package.json`]));
            const lock = JSON.parse(runGit(['-C', plugin.path, 'show', `${commit}:package-lock.json`]));
            expect(packageJson).toMatchObject({ name: PLUGIN_ID, version, type: 'module', main: 'index.js', sillybunny: { serverPlugin: { id: PLUGIN_ID } } });
            expect(lock).toMatchObject({ name: PLUGIN_ID, version, lockfileVersion: 3, packages: { '': { name: PLUGIN_ID, version } } });
        }

        // src/plugin-loader.js: info.id/name/description strings, a valid id, and init(router).
        const checkout = path.join(dir, 'checkout');
        runGit(['clone', '--quiet', plugin.path, checkout]);
        const module = await import(pathToFileURL(path.join(checkout, 'index.js')).href);
        expect(module.info).toEqual({ id: PLUGIN_ID, name: 'lorum ipsum', description: 'lorum ipsum' });
        expect(module.info.id).toMatch(/^[a-z0-9_-]+$/);
        expect(typeof module.exit).toBe('function');
        const routes = [];
        await module.init({ get: (route, handler) => routes.push([route, handler]) });
        expect(routes.map(([route]) => route)).toEqual(['/probe']);
        let sent = null;
        routes[0][1]({}, { json: (value) => sent = value });
        expect(sent).toEqual({ id: PLUGIN_ID, version: '1.0.0', revision: 1 });
    }, 60000);

    const npmCli = findNpmCli();
    describeIf(npmCli)('with the npm bundled with Node', () => {
        test('installs the fixture plugin with npm ci offline', () => {
            const dir = scratchDir('plugin-npm');
            const plugin = buildPluginRepo({ root: path.join(dir, 'repos') });
            const checkout = path.join(dir, 'checkout');
            runGit(['clone', '--quiet', '--branch', PLUGIN_TAG, plugin.path, checkout]);
            const userConfig = path.join(dir, 'npmrc');
            fs.writeFileSync(userConfig, '');
            // The same flags as the release-pinned plugin update (src/server-plugin-manager.js).
            const result = spawnSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--offline'], {
                cwd: checkout,
                encoding: 'utf8',
                env: { ...process.env, npm_config_userconfig: userConfig, npm_config_cache: path.join(dir, 'npm-cache'), npm_config_update_notifier: 'false' },
                windowsHide: true,
            });
            expect(result.stderr).not.toMatch(/ERR!/);
            expect(result.status).toBe(0);
        }, 120000);
    });

    test('produces the same commit ids on every build', () => {
        const first = path.join(scratchDir('deterministic'), 'repos');
        const second = path.join(scratchDir('deterministic'), 'repos');
        expect(buildExtensionRepo({ root: first }).commits).toEqual(buildExtensionRepo({ root: second }).commits);
        expect(buildPluginRepo({ root: first }).commits).toEqual(buildPluginRepo({ root: second }).commits);
        expect(readRefs(path.join(first, 'sillybunny-smoke-plugin.git'))).toEqual(readRefs(path.join(second, 'sillybunny-smoke-plugin.git')));
    }, 60000);

    // A worktree's .git can point at a gitdir this host cannot open (a Windows path seen from WSL).
    const checkoutReadable = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--verify', 'HEAD^{commit}'], { stdio: 'ignore', env: createGitEnv() }).status === 0;
    describeIf(checkoutReadable)('with a readable .git for this checkout', () => {
        test('builds the SillyBunny remote from this checkout HEAD', () => {
            const dir = scratchDir('checkout-remote');
            const remote = buildSillyBunnyRemote({ root: path.join(dir, 'repos'), source: REPO_ROOT, tmpDir: path.join(dir, 'tmp') });
            expect(runGit(['-C', remote.path, 'rev-parse', `${remote.commit}^{tree}`])).toBe(remote.sourceTree);
            expect(readRefs(remote.path).heads).toEqual({ release: remote.commit, staging: remote.commit });
            expect(runGit(['-C', remote.path, 'show', `${remote.commit}:${MIN_APP_VERSION_PATH}`])).toMatch(/^[1-9][0-9]*$/);
            expect(runGit(['-C', remote.path, 'cat-file', '-e', `${remote.commit}:package-lock.json`])).toBe('');
        }, 180000);
    });
});

describe('mock LLM', () => {
    let llm;
    let log;

    beforeAll(async () => {
        log = path.join(scratchDir('llm'), 'llm.jsonl');
        llm = await startMockLlm({ logFile: log });
    });

    afterAll(async () => {
        await llm?.close();
    });

    test('lists its model', async () => {
        expect(isFixturePort(llm.port)).toBe(true);
        expect(llm.baseUrl).toBe(`http://127.0.0.1:${llm.port}/v1`);
        const response = await request(`${llm.baseUrl}/models`);
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
        expect(JSON.parse(response.body.toString('utf8'))).toEqual({
            object: 'list',
            data: [{ id: MOCK_MODEL_ID, object: 'model', created: expect.any(Number), owned_by: expect.any(String) }],
        });
    });

    test('answers at the URLs the Custom source derives from its base URL', async () => {
        // src/endpoints/backends/chat-completions.js: status uses urlJoin(custom_url, '/models'); generation appends '/chat/completions'.
        for (const base of [llm.baseUrl, `${llm.baseUrl}/`]) {
            expect((await request(new URL(urlJoin(base, '/models')).href)).status).toBe(200);
            expect((await postJson(`${base}/chat/completions`, { model: MOCK_MODEL_ID, messages: [] })).status).toBe(200);
        }
    });

    test('returns a canned non-streaming completion and records the request', async () => {
        const messages = [{ role: 'system', content: 'lorum ipsum' }, { role: 'user', content: 'lorum ipsum' }];
        const before = llm.requests.length;
        const response = await postJson(`${llm.baseUrl}/chat/completions`, { model: 'requested-model', messages, stream: false });
        expect(response.status).toBe(200);
        const body = JSON.parse(response.body.toString('utf8'));
        expect(body).toMatchObject({
            object: 'chat.completion',
            model: 'requested-model',
            choices: [{ index: 0, message: { role: 'assistant', content: MOCK_REPLY }, finish_reason: 'stop' }],
        });
        expect(body.id).toMatch(/^chatcmpl-smoke-\d+$/);
        expect(llm.requests.slice(before)).toEqual([expect.objectContaining({ method: 'POST', path: '/v1/chat/completions', status: 200, model: 'requested-model', stream: false, messages })]);
    });

    test('streams SSE chunks that end with a [DONE] frame', async () => {
        const messages = [{ role: 'user', content: 'lorum ipsum' }];
        const response = await postJson(`${llm.baseUrl}/chat/completions`, { model: MOCK_MODEL_ID, messages, stream: true });
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8');
        expect(response.headers['content-length']).toBeUndefined();

        const text = response.body.toString('utf8');
        expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
        const frames = text.slice(0, -2).split('\n\n');
        expect(frames.every(frame => frame.startsWith('data: ') && !frame.includes('\n'))).toBe(true);
        expect(frames.at(-1)).toBe('data: [DONE]');
        const events = frames.slice(0, -1).map(frame => JSON.parse(frame.slice('data: '.length)));
        expect(new Set(events.map(event => event.id)).size).toBe(1);
        expect(events.every(event => event.object === 'chat.completion.chunk' && event.model === MOCK_MODEL_ID)).toBe(true);
        expect(events[0].choices[0].delta).toEqual({ role: 'assistant', content: '' });
        expect(events.slice(1, -1).length).toBeGreaterThan(1);
        expect(events.map(event => event.choices[0].delta.content ?? '').join('')).toBe(MOCK_REPLY);
        expect(events.at(-1).choices[0]).toEqual({ index: 0, delta: {}, finish_reason: 'stop' });
        expect(events.slice(0, -1).every(event => event.choices[0].finish_reason === null)).toBe(true);
        expect(llm.requests.at(-1)).toMatchObject({ stream: true, model: MOCK_MODEL_ID, messages });
    });

    test('streams the same deterministic frames every time', async () => {
        const body = { model: MOCK_MODEL_ID, messages: [{ role: 'user', content: 'lorum ipsum' }], stream: true };
        const first = (await postJson(`${llm.baseUrl}/chat/completions`, body)).body.toString('utf8');
        const second = (await postJson(`${llm.baseUrl}/chat/completions`, body)).body.toString('utf8');
        const normalize = text => text.replace(/chatcmpl-smoke-\d+/g, 'chatcmpl-smoke-N');
        expect(normalize(first)).toBe(normalize(second));
    });

    test('refuses unknown routes, wrong methods and bad bodies', async () => {
        expect((await request(`${llm.url}/v1/completions`, { method: 'POST' })).status).toBe(404);
        expect((await request(`${llm.baseUrl}/models`, { method: 'POST' })).status).toBe(405);
        expect((await request(`${llm.baseUrl}/chat/completions`)).status).toBe(405);
        const invalid = await request(`${llm.baseUrl}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
        expect(invalid.status).toBe(400);
        expect(JSON.parse(invalid.body.toString('utf8'))).toEqual({ error: { message: 'lorum ipsum', type: 'invalid_request_error', code: null } });
        expect((await postJson(`${llm.baseUrl}/chat/completions`, { model: MOCK_MODEL_ID })).status).toBe(400);

        const small = await startMockLlm({ maxRequestBytes: 64 });
        try {
            const tooLarge = await rawExchange(small.port, `POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 65\r\n\r\n${'x'.repeat(65)}`);
            expect(tooLarge).toMatch(/^HTTP\/1\.1 413 /);
        } finally {
            await small.close();
        }
        const logged = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(logged).toEqual(JSON.parse(JSON.stringify(llm.requests)));
    });

    test('answers request targets that URL rejects with 400 and keeps serving', async () => {
        for (const target of MALFORMED_TARGETS) {
            const reply = await rawExchange(llm.port, malformedRequest(target));
            expect([target, reply.split('\r\n')[0]]).toEqual([target, 'HTTP/1.1 400 Bad Request']);
            expect(JSON.parse(reply.slice(reply.indexOf('\r\n\r\n') + 4))).toEqual({ error: { message: 'lorum ipsum', type: 'invalid_request_error', code: null } });
        }
        const logged = llm.requests.filter(entry => MALFORMED_TARGETS.includes(entry.path));
        expect(logged).toEqual(MALFORMED_TARGETS.map(target => ({ time: expect.any(String), method: 'GET', path: target, status: 400 })));
        expect((await request(`${llm.baseUrl}/models`)).status).toBe(200);
    });
});

describe('update static server', () => {
    let dir;
    let server;
    const apk = randomBytes(256 * 1024 + 7);

    beforeAll(async () => {
        dir = scratchDir('static');
        writeFiles(path.join(dir, 'root'), {
            'SillyBunny-android-x86_64.apk': apk,
            'android-update.json': '{}\n',
            'notes.txt': 'lorum ipsum\n',
            'empty.apk': '',
            '.hidden.json': '{}\n',
            'nested/file.bin': 'lorum ipsum',
        });
        server = await startStaticServer({ root: path.join(dir, 'root'), logFile: path.join(dir, 'update.jsonl') });
    });

    afterAll(async () => {
        await server?.close();
    });

    test('serves exact bytes with Content-Length and no compression', async () => {
        const response = await request(`${server.url}/SillyBunny-android-x86_64.apk`, {
            headers: { 'Accept': 'application/vnd.android.package-archive', 'Accept-Encoding': 'gzip, deflate, br' },
        });
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toBe('application/vnd.android.package-archive');
        expect(response.headers['content-length']).toBe(String(apk.length));
        expect(response.headers['content-encoding']).toBeUndefined();
        expect(response.headers['transfer-encoding']).toBeUndefined();
        expect(sha256(response.body)).toBe(sha256(apk));

        const head = await request(`${server.url}/SillyBunny-android-x86_64.apk`, { method: 'HEAD' });
        expect(head.status).toBe(200);
        expect(head.headers['content-length']).toBe(String(apk.length));
        expect(head.body).toHaveLength(0);

        const empty = await request(`${server.url}/empty.apk`);
        expect([empty.status, empty.headers['content-length'], empty.body.length]).toEqual([200, '0', 0]);
    });

    test('labels JSON and text with their content types', async () => {
        const json = await request(`${server.url}/android-update.json`);
        expect([json.status, json.headers['content-type'], json.headers['content-length']]).toEqual([200, 'application/json; charset=utf-8', '3']);
        const text = await request(`${server.url}/notes.txt`);
        expect(text.headers['content-type']).toBe('text/plain; charset=utf-8');
        const nested = await request(`${server.url}/nested/file.bin`);
        expect([nested.status, nested.headers['content-type']]).toEqual([200, 'application/octet-stream']);
    });

    test('refuses directories, dot files, traversal and writes', async () => {
        for (const route of ['/', '/nested', '/.hidden.json', '/nested/..%2f..%2fpackage.json', '/%5c..%5cpackage.json', '/missing.apk']) {
            const response = await request(`${server.url}${route}`);
            expect([route, response.status]).toEqual([route, 404]);
        }
        const post = await request(`${server.url}/android-update.json`, { method: 'POST', body: '{}' });
        expect(post.status).toBe(405);
        expect(post.headers.allow).toBe('GET, HEAD');
        const entries = fs.readFileSync(path.join(dir, 'update.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(entries.length).toBe(server.requests.length);
        expect(entries.find(entry => entry.path === '/SillyBunny-android-x86_64.apk' && entry.method === 'GET')).toMatchObject({ status: 200, bytes: apk.length, complete: true, acceptEncoding: 'gzip, deflate, br' });
    });

    test('answers request targets that URL rejects with 400 and keeps serving', async () => {
        for (const target of MALFORMED_TARGETS) {
            const reply = await rawExchange(server.port, malformedRequest(target));
            expect([target, reply.split('\r\n')[0], reply.endsWith('\r\n\r\nlorum ipsum\n')]).toEqual([target, 'HTTP/1.1 400 Bad Request', true]);
        }
        const logged = server.requests.filter(entry => MALFORMED_TARGETS.includes(entry.path));
        expect(logged.map(entry => [entry.path, entry.status])).toEqual(MALFORMED_TARGETS.map(target => [target, 400]));
        expect((await request(`${server.url}/android-update.json`)).status).toBe(200);
    });
});

function manifestObject() {
    return {
        schema: 1,
        versionCode: 2,
        versionName: '1.0.1',
        prerelease: false,
        releaseTag: 'v2.0.0',
        defaultRef: 'release',
        minSdk: 29,
        signingCertSha256: colonFingerprint(SIGNER),
        inputsHash: 'b'.repeat(64),
        assets: {
            'arm64-v8a': { name: 'SillyBunny-android-arm64-v8a.apk', sha256: 'c'.repeat(64), size: 1000 },
            'x86_64': { name: 'SillyBunny-android-x86_64.apk', sha256: 'd'.repeat(64), size: 2000 },
        },
        runtime: { node: '24.22.0', bun: null, git: '2.56.0', bash: '5.3.20', npm: '11.6.2' },
    };
}

function mutated(change) {
    const manifest = manifestObject();
    change(manifest);
    return JSON.stringify(manifest);
}

const withAsset = patch => manifest => Object.assign(manifest.assets.x86_64, patch);
const VALID_MANIFEST = JSON.stringify(manifestObject());

describe('update manifest', () => {
    test('accepts a schema 1 manifest and normalizes it like UpdateManifestParser', () => {
        const json = JSON.stringify({ ...manifestObject(), inputsHash: 'B'.repeat(64), unknownField: { ignored: [1, 2] } });
        expect(parseUpdateManifest(json, 'x86_64', 29)).toEqual({
            versionCode: 2,
            versionName: '1.0.1',
            prerelease: false,
            releaseTag: 'v2.0.0',
            defaultRef: 'release',
            minSdk: 29,
            signingCertSha256: SIGNER,
            inputsHash: 'b'.repeat(64),
            asset: { name: 'SillyBunny-android-x86_64.apk', sha256: 'd'.repeat(64), size: 2000 },
        });
        expect(parseUpdateManifest(json, 'arm64-v8a', 37).asset.name).toBe('SillyBunny-android-arm64-v8a.apk');
        expect(checkUpdateManifest(mutated(m => m.signingCertSha256 = SIGNER.toUpperCase()), 'x86_64', 29).ok).toBe(true);
        expect(checkUpdateManifest(mutated(m => m.runtime.bun = '1.3.0'), 'x86_64', 29).ok).toBe(true);
        expect(checkUpdateManifest(mutated(withAsset({ size: MAX_APK_BYTES, sha256: 'D'.repeat(64) })), 'x86_64', 29).manifest.asset).toEqual({
            name: 'SillyBunny-android-x86_64.apk',
            sha256: 'd'.repeat(64),
            size: MAX_APK_BYTES,
        });
        const sixteen = mutated(m => Object.assign(m.assets, Object.fromEntries(Array.from({ length: 14 }, (_, index) => [`abi${index}`, { name: `SillyBunny-${index}.apk`, sha256: 'e'.repeat(64), size: 1 }]))));
        expect(checkUpdateManifest(sixteen, 'x86_64', 29).ok).toBe(true);
    });

    test.each([
        ['schema 2', m => m.schema = 2, 'schema'],
        ['a missing schema', m => delete m.schema, 'schema'],
        ['versionCode 0', m => m.versionCode = 0, 'versionCode'],
        ['a negative versionCode', m => m.versionCode = -2, 'versionCode'],
        ['a fractional versionCode', m => m.versionCode = 2.5, 'versionCode'],
        ['a string versionCode', m => m.versionCode = '2', 'versionCode'],
        ['a blank versionName', m => m.versionName = ' \u00a0\u2028', 'versionName'],
        ['a control character in versionName', m => m.versionName = '1.0\u007f', 'versionName'],
        ['a versionName over 128 characters', m => m.versionName = '1'.repeat(129), 'versionName'],
        ['a string prerelease', m => m.prerelease = 'false', 'prerelease'],
        ['a releaseTag over 256 characters', m => m.releaseTag = 'v'.repeat(257), 'releaseTag'],
        ['an unknown defaultRef', m => m.defaultRef = 'main', 'defaultRef'],
        ['a minSdk above the device', m => m.minSdk = 30, 'minSdk'],
        ['minSdk 0', m => m.minSdk = 0, 'minSdk'],
        ['a short signing fingerprint', m => m.signingCertSha256 = 'AB:CD', 'signingCertSha256'],
        ['a partly separated signing fingerprint', m => m.signingCertSha256 = `${'ab'.repeat(31)}:ab`, 'signingCertSha256'],
        ['a non-hex inputsHash', m => m.inputsHash = 'g'.repeat(64), 'inputsHash'],
        ['no assets', m => m.assets = {}, 'assets'],
        ['17 assets', m => Object.assign(m.assets, Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`abi${index}`, { name: `SillyBunny-${index}.apk`, sha256: 'e'.repeat(64), size: 1 }]))), 'assets'],
        ['an uppercase ABI key', m => m.assets.ARM = { name: 'SillyBunny-arm.apk', sha256: 'e'.repeat(64), size: 1 }, 'assets.ARM'],
        ['an asset name with a path', withAsset({ name: '../SillyBunny.apk' }), 'assets.x86_64.name'],
        ['an asset name with ..', withAsset({ name: 'SillyBunny..x86_64.apk' }), 'assets.x86_64.name'],
        ['an asset name without .apk', withAsset({ name: 'SillyBunny-android-x86_64.zip' }), 'assets.x86_64.name'],
        ['an asset name over 196 characters', withAsset({ name: `${'a'.repeat(193)}.apk` }), 'assets.x86_64.name'],
        ['duplicate asset names', withAsset({ name: 'SillyBunny-android-arm64-v8a.apk' }), 'assets.x86_64.name.duplicate'],
        ['a short asset sha256', withAsset({ sha256: 'abc' }), 'assets.x86_64.sha256'],
        ['asset size 0', withAsset({ size: 0 }), 'assets.x86_64.size'],
        ['an asset over 300 MiB', withAsset({ size: MAX_APK_BYTES + 1 }), 'assets.x86_64.size'],
        ['a string asset size', withAsset({ size: '2000' }), 'assets.x86_64.size'],
        ['no asset for the device ABI', m => delete m.assets.x86_64, 'assets.abi'],
        ['a missing runtime', m => delete m.runtime, 'runtime'],
        ['a missing runtime.node', m => delete m.runtime.node, 'runtime.node'],
        ['an empty runtime.git', m => m.runtime.git = '', 'runtime.git'],
        ['a missing runtime.bun', m => delete m.runtime.bun, 'runtime.bun'],
        ['a numeric runtime.bun', m => m.runtime.bun = 1, 'runtime.bun'],
    ])('rejects %s', (_name, change, reason) => {
        expect(checkUpdateManifest(mutated(change), 'x86_64', 29)).toEqual({ ok: false, reason });
    });

    test.each([
        ['a trailing comma', VALID_MANIFEST.replace(/}$/, ',}'), 'json.syntax'],
        ['a duplicate key', VALID_MANIFEST.replace('{', '{"schema":1,'), 'json.name'],
        ['NaN', VALID_MANIFEST.replace('"versionCode":2', '"versionCode":NaN'), 'json.tokens'],
        ['a capitalised literal', VALID_MANIFEST.replace('"prerelease":false', '"prerelease":False'), 'json.tokens'],
        ['a single-quoted string', VALID_MANIFEST.replace('"1.0.1"', '\'1.0.1\''), 'json.tokens'],
        ['a comment', `// lorum ipsum\n${VALID_MANIFEST}`, 'json.tokens'],
        ['an invalid escape', VALID_MANIFEST.replace('"v2.0.0"', '"v2.0.0\\x41"'), 'json.tokens'],
        ['a leading zero', VALID_MANIFEST.replace('"versionCode":2', '"versionCode":02'), 'json.tokens'],
        ['an exponent versionCode', VALID_MANIFEST.replace('"versionCode":2', '"versionCode":2e0'), 'versionCode'],
        ['a versionCode above Long.MAX_VALUE', VALID_MANIFEST.replace('"versionCode":2', '"versionCode":9223372036854775808'), 'versionCode'],
        ['a lone surrogate', VALID_MANIFEST.replace('"1.0.1"', '"1.0.1\\ud800"'), 'json.unicode'],
        ['a top-level string', '"lorum ipsum"', 'json.top-level'],
        ['a top-level array', '[]', 'root'],
        ['trailing data', `${VALID_MANIFEST} {}`, 'json.trailing'],
        ['nesting deeper than 32 levels', VALID_MANIFEST.replace('{', `{"deep":${'['.repeat(40)}${']'.repeat(40)},`), 'json.limits'],
        ['more than 2 MiB', VALID_MANIFEST.replace('{', `{"pad":"${'x'.repeat(2 * 1024 * 1024)}",`), 'json.size'],
    ])('rejects JSON with %s', (_name, json, reason) => {
        expect(checkUpdateManifest(json, 'x86_64', 29)).toEqual({ ok: false, reason });
    });

    test('rejects devices the app would refuse', () => {
        expect(checkUpdateManifest(VALID_MANIFEST, 'X86_64', 29)).toEqual({ ok: false, reason: 'device' });
        expect(checkUpdateManifest(VALID_MANIFEST, 'x86_64', 0)).toEqual({ ok: false, reason: 'device' });
        expect(checkUpdateManifest(VALID_MANIFEST, 'x86_64', 28)).toEqual({ ok: false, reason: 'minSdk' });
    });

    test('generates schema 1 manifests with bun: null and validates them', () => {
        const fields = {
            versionCode: 7,
            versionName: '1.2.0',
            prerelease: true,
            releaseTag: 'v2.1.0-rc.1',
            defaultRef: 'staging',
            minSdk: 29,
            signingCertSha256: SIGNER,
            assets: { x86_64: { name: 'SillyBunny-android-x86_64.apk', sha256: 'f'.repeat(64), size: 9 } },
            runtime: RUNTIME,
        };
        const { manifest, json } = createUpdateManifest(fields);
        expect(json).toBe(`${JSON.stringify(manifest, null, 4)}\n`);
        expect(manifest).toEqual({
            schema: 1,
            versionCode: 7,
            versionName: '1.2.0',
            prerelease: true,
            releaseTag: 'v2.1.0-rc.1',
            defaultRef: 'staging',
            minSdk: 29,
            signingCertSha256: colonFingerprint(SIGNER),
            inputsHash: expect.stringMatching(/^[0-9a-f]{64}$/),
            assets: fields.assets,
            runtime: { node: '24.22.0', bun: null, git: '2.56.0', bash: '5.3.20', npm: '11.6.2' },
        });
        expect(manifest.signingCertSha256).toMatch(/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/);
        expect(createUpdateManifest(fields).manifest.inputsHash).toBe(manifest.inputsHash);
        expect(createUpdateManifest({ ...fields, versionCode: 8 }).manifest.inputsHash).not.toBe(manifest.inputsHash);
        expect(createUpdateManifest({ ...fields, inputsHash: 'A'.repeat(64) }).manifest.inputsHash).toBe('A'.repeat(64));
        expect(parseUpdateManifest(json, 'x86_64', 29)).toMatchObject({ versionCode: 7, prerelease: true, defaultRef: 'staging', signingCertSha256: SIGNER });
    });

    test.each([
        ['an oversized asset', { assets: { x86_64: { name: 'SillyBunny-android-x86_64.apk', sha256: 'f'.repeat(64), size: MAX_APK_BYTES + 1 } } }, 'assets.x86_64.size'],
        ['no assets', { assets: {} }, 'assets'],
        ['17 assets', { assets: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`abi${index}`, { name: `SillyBunny-${index}.apk`, sha256: 'f'.repeat(64), size: 1 }])) }, 'assets'],
        ['an unsafe asset name', { assets: { x86_64: { name: 'x/../SillyBunny.apk', sha256: 'f'.repeat(64), size: 1 } } }, 'assets.x86_64.name'],
        ['a bad signing fingerprint', { signingCertSha256: 'abc' }, 'signingCertSha256'],
        ['an unknown defaultRef', { defaultRef: 'main' }, 'defaultRef'],
        ['minSdk 0', { minSdk: 0 }, 'minSdk'],
        ['a missing runtime version', { runtime: { node: '24.22.0', git: '2.56.0', bash: '5.3.20' } }, 'runtime.npm'],
        ['a bad inputsHash', { inputsHash: 'abc' }, 'inputsHash'],
    ])('refuses to generate a manifest with %s', (_name, override, reason) => {
        const fields = {
            versionCode: 7,
            versionName: '1.2.0',
            releaseTag: 'v2.1.0',
            signingCertSha256: SIGNER,
            assets: { x86_64: { name: 'SillyBunny-android-x86_64.apk', sha256: 'f'.repeat(64), size: 9 } },
            runtime: RUNTIME,
            ...override,
        };
        expect(() => createUpdateManifest(fields)).toThrow(`Invalid update manifest: ${reason}`);
    });

    test('writes an updater fixture that the static server delivers to both update channels', async () => {
        const dir = scratchDir('update-fixture');
        const apks = { 'arm64-v8a': randomBytes(64 * 1024), 'x86_64': randomBytes(96 * 1024 + 3) };
        writeFiles(path.join(dir, 'build'), { 'arm64.apk': apks['arm64-v8a'], 'x86.apk': apks.x86_64 });
        const served = path.join(dir, 'served');
        const server = await startStaticServer({ root: served });
        try {
            const fixture = await writeUpdateFixture({
                dir: served,
                apks: { 'arm64-v8a': path.join(dir, 'build', 'arm64.apk'), 'x86_64': path.join(dir, 'build', 'x86.apk') },
                versionCode: 3,
                versionName: '1.0.2',
                releaseTag: 'v2.0.1',
                // The stable channel refuses prerelease manifests (UpdateRepository.checkStable); the prerelease channel takes both.
                prerelease: false,
                defaultRef: 'staging',
                minSdk: 29,
                signingCertSha256: colonFingerprint(SIGNER).toLowerCase(),
                runtime: RUNTIME,
                baseUrl: `${server.url}/`,
            });
            expect(fs.readdirSync(served).sort()).toEqual(['SillyBunny-android-arm64-v8a.apk', 'SillyBunny-android-x86_64.apk', 'android-update.json', 'releases.json']);
            expect(fixture.assets).toEqual({
                'arm64-v8a': { name: 'SillyBunny-android-arm64-v8a.apk', sha256: sha256(apks['arm64-v8a']), size: apks['arm64-v8a'].length },
                'x86_64': { name: 'SillyBunny-android-x86_64.apk', sha256: sha256(apks.x86_64), size: apks.x86_64.length },
            });

            // Stable channel: UPDATE_MANIFEST_URL, then the APK next to it.
            const manifestResponse = await request(`${server.url}/android-update.json`, { headers: { 'Accept': 'application/json', 'Accept-Encoding': 'identity' } });
            expect(manifestResponse.headers['content-length']).toBe(String(manifestResponse.body.length));
            const manifestText = manifestResponse.body.toString('utf8');
            expect(manifestText).toBe(fs.readFileSync(fixture.manifestPath, 'utf8'));
            const parsed = parseUpdateManifest(manifestText, 'x86_64', 29);
            expect(parsed).toMatchObject({ versionCode: 3, prerelease: false, defaultRef: 'staging', signingCertSha256: SIGNER, asset: fixture.assets.x86_64 });
            const download = await request(new URL(parsed.asset.name, `${server.url}/android-update.json`).href);
            expect(download.headers['content-length']).toBe(String(parsed.asset.size));
            expect(sha256(download.body)).toBe(parsed.asset.sha256);

            // Prerelease channel: RELEASES_API_URL lists non-draft releases with browser_download_url assets.
            const releases = JSON.parse((await request(`${server.url}/releases.json`)).body.toString('utf8'));
            expect(releases).toEqual([{
                id: 3,
                tag_name: 'v2.0.1',
                draft: false,
                prerelease: false,
                assets: [
                    { name: 'android-update.json', size: Buffer.byteLength(manifestText), content_type: 'application/json', browser_download_url: `${server.url}/android-update.json` },
                    { name: 'SillyBunny-android-arm64-v8a.apk', size: apks['arm64-v8a'].length, content_type: 'application/vnd.android.package-archive', browser_download_url: `${server.url}/SillyBunny-android-arm64-v8a.apk` },
                    { name: 'SillyBunny-android-x86_64.apk', size: apks.x86_64.length, content_type: 'application/vnd.android.package-archive', browser_download_url: `${server.url}/SillyBunny-android-x86_64.apk` },
                ],
            }]);
            const arm = await request(releases[0].assets[1].browser_download_url);
            expect(sha256(arm.body)).toBe(fixture.manifest.assets['arm64-v8a'].sha256);
        } finally {
            await server.close();
        }
    });

    test('refuses an invalid updater fixture without writing anything', async () => {
        const dir = scratchDir('update-refused');
        const apk = path.join(dir, 'app.apk');
        fs.writeFileSync(apk, randomBytes(1024));
        const served = path.join(dir, 'served');
        const fields = { versionCode: 2, versionName: '1.0.1', releaseTag: 'v2.0.0', signingCertSha256: SIGNER, runtime: RUNTIME };
        await expect(writeUpdateFixture({ ...fields, dir: served, apks: { '../x86_64': apk } })).rejects.toThrow('Invalid update manifest: assets.../x86_64');
        await expect(writeUpdateFixture({ ...fields, dir: served, apks: { x86_64: apk }, baseUrl: 'http://10.0.2.2:20001' })).rejects.toThrow('Invalid releases index: baseUrl');
        expect(fs.existsSync(served)).toBe(false);

        const first = await writeUpdateFixture({ ...fields, dir: served, apks: { x86_64: apk } });
        const listing = fs.readdirSync(served).sort();
        expect(listing).toEqual(['SillyBunny-android-x86_64.apk', 'android-update.json']);
        const manifestText = fs.readFileSync(first.manifestPath, 'utf8');
        fs.writeFileSync(apk, randomBytes(2048));
        await expect(writeUpdateFixture({ ...fields, versionCode: 0, dir: served, apks: { x86_64: apk } })).rejects.toThrow('Invalid update manifest: versionCode');
        expect(fs.readdirSync(served).sort()).toEqual(listing);
        expect(fs.readFileSync(first.manifestPath, 'utf8')).toBe(manifestText);
        expect(sha256(fs.readFileSync(path.join(served, 'SillyBunny-android-x86_64.apk')))).toBe(first.assets.x86_64.sha256);
    });

    test('accepts only download URLs the app would fetch', () => {
        // UpdateHttpClient.validatedUrl: https anywhere; plain http only to 127.0.0.1 in debug builds.
        for (const url of [
            'https://github.com/SillyBunnyTeam/SillyBunny/releases/download/v2.0.0/SillyBunny-android-x86_64.apk',
            'https://example.com:8443/releases?per_page=20',
            'http://127.0.0.1:20001/android-update.json',
        ]) {
            expect([url, isAllowedUpdateUrl(url)]).toEqual([url, true]);
        }
        expect(isAllowedUpdateUrl('http://127.0.0.1:20001/android-update.json', { allowDebugLoopback: false })).toBe(false);
        for (const url of [
            'http://localhost:20001/android-update.json',
            'http://10.0.2.2:20001/android-update.json',
            'HTTPS://example.com/android-update.json',
            'ftp://example.com/android-update.json',
            'https://user@example.com/android-update.json',
            'https://example.com/android-update.json#latest',
            'https://example.com/lorum ipsum.json',
            'https://example.com/a[1].json',
            'https://example.com/%zz.json',
            'https://example.com:0/android-update.json',
            'https://example.com:65536/android-update.json',
            'https://exa_mple.com/android-update.json',
            'https://256.0.0.1/android-update.json',
            'https://[::1]/android-update.json',
            `https://example.com/${'a'.repeat(8192)}`,
        ]) {
            expect([url, isAllowedUpdateUrl(url)]).toEqual([url, false]);
        }
    });

    test('checks the releases index the prerelease channel reads', () => {
        const manifestAsset = { name: 'android-update.json', browser_download_url: 'http://127.0.0.1:20001/android-update.json' };
        const apkAsset = { name: 'SillyBunny-android-x86_64.apk', browser_download_url: 'http://127.0.0.1:20001/SillyBunny-android-x86_64.apk' };
        const index = release => JSON.stringify([{ draft: false, prerelease: true, assets: [manifestAsset, apkAsset], ...release }]);
        expect(checkReleasesIndex(index({}))).toEqual({
            ok: true,
            releases: [{
                manifestUrl: manifestAsset.browser_download_url,
                assets: { [manifestAsset.name]: manifestAsset.browser_download_url, [apkAsset.name]: apkAsset.browser_download_url },
            }],
        });
        expect(checkReleasesIndex(index({}), { allowDebugLoopback: false })).toEqual({ ok: false, reason: 'releases.0.assets.android-update.json.url' });
        expect(checkReleasesIndex(index({ draft: true }))).toEqual({ ok: false, reason: 'releases.0.draft' });
        expect(checkReleasesIndex(index({ assets: [apkAsset] }))).toEqual({ ok: false, reason: 'releases.0.manifest' });
        expect(checkReleasesIndex(index({ assets: [manifestAsset, manifestAsset] }))).toEqual({ ok: false, reason: 'releases.0.assets.name' });
        const lanAsset = { ...apkAsset, browser_download_url: 'http://10.0.2.2:20001/SillyBunny-android-x86_64.apk' };
        expect(checkReleasesIndex(index({ assets: [manifestAsset, lanAsset] }))).toEqual({ ok: false, reason: `releases.0.assets.${apkAsset.name}.url` });
        expect(checkReleasesIndex('{}')).toEqual({ ok: false, reason: 'releases' });
        expect(checkReleasesIndex('[]')).toEqual({ ok: false, reason: 'releases' });
    });

    test('reads the signer digest from apksigner output', () => {
        const dir = scratchDir('fake-apksigner');
        let count = 0;
        const fake = (output, exitCode = 0) => {
            const script = path.join(dir, `apksigner-${count++}.mjs`);
            fs.writeFileSync(script, `process.stdout.write(${JSON.stringify(output)});\nprocess.exitCode = ${exitCode};\n`);
            return { command: process.execPath, args: [script] };
        };
        const digest = 'c4'.repeat(32);
        const other = '5d'.repeat(32);
        const lines = (...values) => `${values.join('\n')}\n`;
        expect(readSigningCertSha256('app.apk', {
            apksigner: fake(lines(
                'V2 Signer: certificate DN: CN=fixture',
                `V2 Signer: certificate SHA-256 digest: ${digest}`,
                `V3.0 Signer: certificate SHA-256 digest: ${digest}`,
                `V3.1 Signer (minSdkVersion=33, maxSdkVersion=2147483647): certificate SHA-256 digest: ${digest}`,
                `Source Stamp Signer: certificate SHA-256 digest: ${other}`,
            )),
        })).toBe(digest);
        expect(readSigningCertSha256('app.apk', { apksigner: fake(lines(`Signer #1 certificate SHA-256 digest: ${digest.toUpperCase()}`)) })).toBe(digest);
        expect(() => readSigningCertSha256('app.apk', {
            apksigner: fake(lines(`Signer #1 certificate SHA-256 digest: ${digest}`, `Signer #2 certificate SHA-256 digest: ${other}`)),
        })).toThrow('exactly one signer');
        expect(() => readSigningCertSha256('app.apk', { apksigner: fake(lines(`Source Stamp Signer: certificate SHA-256 digest: ${other}`)) })).toThrow('exactly one signer');
        expect(() => readSigningCertSha256('app.apk', { apksigner: fake('DOES NOT VERIFY\n', 1) })).toThrow('apksigner verify failed (1)');
        expect(() => readSigningCertSha256('app.apk', { apksigner: null })).toThrow('apksigner was not found');
    });

    test('finds apksigner.jar in the newest build-tools and java in JAVA_HOME', () => {
        const dir = scratchDir('sdk');
        writeFiles(dir, {
            'sdk/build-tools/9.0.0/lib/apksigner.jar': '',
            'sdk/build-tools/37.0.0/lib/apksigner.jar': '',
            'sdk/build-tools/36.1.0/lib/apksigner.jar': '',
            [`jdk/bin/${JAVA_NAME}`]: '',
        });
        expect(findApksigner({ ANDROID_HOME: path.join(dir, 'sdk'), JAVA_HOME: path.join(dir, 'jdk') })).toEqual({
            command: path.join(dir, 'jdk', 'bin', JAVA_NAME),
            args: ['-jar', path.join(dir, 'sdk', 'build-tools', '37.0.0', 'lib', 'apksigner.jar')],
        });
        expect(findApksigner({ ANDROID_SDK_ROOT: path.join(dir, 'sdk') })?.command).toBe('java');
        expect(findApksigner({ APKSIGNER_JAR: path.join(dir, 'sdk', 'build-tools', '9.0.0', 'lib', 'apksigner.jar') })?.args[1]).toBe(path.join(dir, 'sdk', 'build-tools', '9.0.0', 'lib', 'apksigner.jar'));
        expect(findApksigner({ ANDROID_HOME: path.join(dir, 'missing') })).toBeNull();
    });

    const apksigner = findApksigner();
    const keytool = apksigner ? findKeytool() : null;
    describeIf(apksigner && keytool)('with the Android SDK apksigner and a JDK keytool', () => {
        test('takes signingCertSha256 from a signed APK with apksigner', async () => {
            const dir = scratchDir('apksigner');
            const keystore = path.join(dir, 'fixture.p12');
            const run = (command, args) => {
                const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
                expect({ command: path.basename(command), status: result.status, stderr: result.status === 0 ? '' : result.stderr }).toEqual({ command: path.basename(command), status: 0, stderr: '' });
            };
            const storeArgs = ['-keystore', keystore, '-storetype', 'PKCS12', '-storepass', 'fixture-store', '-alias', 'fixture'];
            run(keytool, ['-genkeypair', ...storeArgs, '-keypass', 'fixture-store', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '2', '-dname', 'CN=fixture']);
            run(keytool, ['-exportcert', ...storeArgs, '-file', path.join(dir, 'cert.der')]);
            fs.writeFileSync(path.join(dir, 'unsigned.apk'), storedZip({ 'AndroidManifest.xml': Buffer.from('lorum ipsum'), 'classes.dex': Buffer.from('lorum ipsum') }));
            run(apksigner.command, [
                ...apksigner.args, 'sign', '--ks', keystore, '--ks-type', 'PKCS12', '--ks-pass', 'pass:fixture-store', '--key-pass', 'pass:fixture-store',
                '--ks-key-alias', 'fixture', '--min-sdk-version', '29', '--v4-signing-enabled', 'false', '--out', path.join(dir, 'signed.apk'), path.join(dir, 'unsigned.apk'),
            ]);
            const expected = sha256(fs.readFileSync(path.join(dir, 'cert.der')));

            expect(readSigningCertSha256(path.join(dir, 'signed.apk'), { apksigner })).toBe(expected);
            const fixture = await writeUpdateFixture({
                dir: path.join(dir, 'served'),
                apks: { x86_64: path.join(dir, 'signed.apk') },
                versionCode: 2,
                versionName: '1.0.1',
                releaseTag: 'v2.0.0',
                runtime: RUNTIME,
            });
            expect(fixture.releasesPath).toBeNull();
            expect(parseUpdateManifest(fs.readFileSync(fixture.manifestPath, 'utf8'), 'x86_64', 29).signingCertSha256).toBe(expected);
            await expect(writeUpdateFixture({
                dir: path.join(dir, 'unsigned'),
                apks: { x86_64: path.join(dir, 'unsigned.apk') },
                versionCode: 2,
                versionName: '1.0.1',
                releaseTag: 'v2.0.0',
                runtime: RUNTIME,
            })).rejects.toThrow('apksigner verify failed');
        }, 180000);
    });
});

describe('data-safety helper', () => {
    const chatFile = `${DATA_USER}/chats/smoke-fixture/lorum ipsum.jsonl`;
    const cardFile = `${DATA_USER}/characters/${CHARACTER_FILE}`;
    const secretsFile = `${DATA_USER}/secrets.json`;

    test('seeds one character, one chat and secrets.json where the server reads them', async () => {
        const root = path.join(scratchDir('data'), 'data');
        const seeded = await seedDataFixture(root);
        expect(seeded.files).toEqual([cardFile, chatFile, secretsFile]);
        expect(Object.keys(seeded.manifest.files)).toEqual(seeded.files);

        const card = fs.readFileSync(path.join(root, ...cardFile.split('/')));
        expect(card.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        expect(card.readUInt32BE(16)).toBe(1);
        expect(card.readUInt32BE(20)).toBe(1);
        expect(zlib.inflateSync(card.subarray(41, 41 + card.readUInt32BE(33)))).toEqual(Buffer.alloc(5));
        // The server's own card reader (which also checks every chunk CRC) finds the card.
        expect(JSON.parse(readCharacterCard(card))).toEqual(fixtureCharacterCard());

        const lines = fs.readFileSync(path.join(root, ...chatFile.split('/')), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
        expect(lines[0]).toMatchObject({ character_name: 'lorum ipsum', chat_metadata: {} });
        expect(lines.slice(1).map(line => [line.is_user, line.mes])).toEqual([[false, 'lorum ipsum'], [true, 'lorum ipsum']]);

        // The current secrets format: the server's flat-secrets migration leaves it alone.
        const secrets = readJson(path.join(root, ...secretsFile.split('/')));
        expect(secrets._migrated).toEqual([]);
        expect(Object.values(secrets).every(Array.isArray)).toBe(true);
        expect(secrets.api_key_openai).toEqual([{ id: expect.any(String), value: expect.any(String), label: 'lorum ipsum', active: true }]);
    });

    test('computes the same manifest for the same content, whatever the timestamps', async () => {
        const first = path.join(scratchDir('data'), 'data');
        const second = path.join(scratchDir('data'), 'data');
        const a = await seedDataFixture(first);
        const b = await seedDataFixture(second);
        expect(a.manifest).toEqual(b.manifest);
        expect(a.manifest.digest).toMatch(/^[0-9a-f]{64}$/);
        expect(a.manifest.files[secretsFile]).toEqual({ type: 'file', sha256: sha256(fs.readFileSync(path.join(first, ...secretsFile.split('/')))), size: expect.any(Number) });

        const full = await checksumTree(first);
        expect(full).toEqual(a.manifest);
        const old = new Date('2001-02-03T04:05:06Z');
        fs.utimesSync(path.join(first, ...chatFile.split('/')), old, old);
        expect(await checksumTree(first)).toEqual(full);
        expect(await checksumTree(path.join(first, 'missing'))).toMatchObject({ files: {} });
    });

    test('reports changed, removed and added files against a baseline', async () => {
        const root = path.join(scratchDir('data'), 'data');
        const { manifest: baseline } = await seedDataFixture(root);
        const at = file => path.join(root, ...file.split('/'));

        writeFiles(root, { [`${DATA_USER}/chats/smoke-fixture/new chat.jsonl`]: '{}\n', [`${DATA_USER}/settings.json`]: '{}\n' });
        const added = await checksumTree(root);
        expect(compareChecksums(baseline, added)).toEqual({
            ok: true,
            changed: [],
            removed: [],
            added: [`${DATA_USER}/chats/smoke-fixture/new chat.jsonl`, `${DATA_USER}/settings.json`],
            unexpected: [],
        });
        expect(compareChecksums(baseline, added, { allowAdded: [`${DATA_USER}/chats/`] })).toMatchObject({ ok: false, unexpected: [`${DATA_USER}/settings.json`] });
        expect(compareChecksums(baseline, added, { allowAdded: file => file.endsWith('.json') })).toMatchObject({ ok: false, unexpected: [`${DATA_USER}/chats/smoke-fixture/new chat.jsonl`] });
        expect(compareChecksums(baseline, await checksumTree(root, { exclude: [`${DATA_USER}/settings.json`] }), { allowAdded: [`${DATA_USER}/chats`] }).ok).toBe(true);

        // A same-size edit is caught by content, not size or time.
        const secrets = fs.readFileSync(at(secretsFile), 'utf8');
        fs.writeFileSync(at(secretsFile), secrets.replace('"active": true', '"active": fals'));
        fs.rmSync(at(cardFile));
        const damaged = await checksumTree(root);
        expect(compareChecksums(baseline, damaged)).toMatchObject({ ok: false, changed: [secretsFile], removed: [cardFile] });
        // Only the seeded files, for steps that expect other data to change.
        expect(Object.keys((await checksumTree(root, { include: Object.keys(baseline.files) })).files)).toEqual([chatFile, secretsFile]);
    });

    // Windows needs Developer Mode or an elevated process to create symbolic links.
    describeIf(!IS_WINDOWS)('on POSIX hosts', () => {
        test('records symbolic links by target without following them', async () => {
            const root = path.join(scratchDir('data'), 'data');
            const { manifest: baseline } = await seedDataFixture(root);
            fs.symlinkSync('../secrets.json', path.join(root, DATA_USER, 'characters', 'link.json'));
            const manifest = await checksumTree(root);
            expect(manifest.files[`${DATA_USER}/characters/link.json`]).toEqual({ type: 'symlink', sha256: sha256('../secrets.json'), size: '../secrets.json'.length });
            expect(compareChecksums(baseline, manifest).added).toEqual([`${DATA_USER}/characters/link.json`]);
        });
    });
});

describe('launcher CLI', () => {
    test('starts the LLM and update services, prints one JSON line and shuts down cleanly', async () => {
        const scratch = scratchDir('launcher-services');
        const launcher = startLauncher(['--services', 'llm,update', '--scratch', scratch]);
        const info = await launcher.line;
        const { llm, update } = info.services;
        expect(info).toEqual({
            ok: true,
            pid: launcher.child.pid,
            scratch,
            logs: path.join(scratch, 'logs'),
            services: {
                llm: { port: llm.port, url: `http://127.0.0.1:${llm.port}`, baseUrl: `http://127.0.0.1:${llm.port}/v1`, model: MOCK_MODEL_ID, log: path.join(scratch, 'logs', 'llm.jsonl') },
                update: {
                    port: update.port,
                    url: `http://127.0.0.1:${update.port}`,
                    root: path.join(scratch, 'update'),
                    manifestUrl: `http://127.0.0.1:${update.port}/android-update.json`,
                    releasesUrl: `http://127.0.0.1:${update.port}/releases.json`,
                    log: path.join(scratch, 'logs', 'update.jsonl'),
                },
            },
            gradleProperties: { debugUpdateManifestUrl: update.manifestUrl, debugReleasesApiUrl: update.releasesUrl },
            adbReverse: [llm.port, update.port].map((port, index) => ({
                service: ['llm', 'update'][index],
                devicePort: port,
                hostPort: port,
                args: ['reverse', `tcp:${port}`, `tcp:${port}`],
                removeArgs: ['reverse', '--remove', `tcp:${port}`],
            })),
        });
        expect([llm.port, update.port].every(isFixturePort)).toBe(true);
        // Below the app's own server port range, so the reverse rules never take its port.
        expect(Math.max(llm.port, update.port)).toBeLessThanOrEqual(DEVICE_PORT_MAX);
        // A request target that URL rejects gets a 400 and leaves every service in the process running.
        for (const port of [llm.port, update.port]) {
            expect(await rawExchange(port, malformedRequest('//['))).toMatch(/^HTTP\/1\.1 400 /);
        }
        expect((await request(`${llm.baseUrl}/models`)).status).toBe(200);

        // The manifest command writes into the served directory while the server runs.
        const apk = path.join(scratch, 'app.apk');
        fs.writeFileSync(apk, randomBytes(4096));
        const written = runCli([
            'manifest', '--dir', update.root, '--apk', `x86_64=${apk}`, '--version-code', '2', '--version-name', '1.0.1', '--release-tag', 'v2.0.0',
            '--signing-cert-sha256', SIGNER, '--node', RUNTIME.node, '--npm', RUNTIME.npm, '--git', RUNTIME.git, '--bash', RUNTIME.bash, '--base-url', update.url,
        ]);
        expect([written.status, written.json?.ok]).toEqual([0, true]);
        const served = await request(update.manifestUrl);
        expect(parseUpdateManifest(served.body.toString('utf8'), 'x86_64', 29)).toMatchObject({ versionCode: 2, asset: { name: 'SillyBunny-android-x86_64.apk', size: 4096 } });
        expect(JSON.parse((await request(update.releasesUrl)).body.toString('utf8'))[0].assets[1].browser_download_url).toBe(`${update.url}/SillyBunny-android-x86_64.apk`);

        expect(await stopLauncher(launcher, 'SIGINT')).toEqual({ code: 0, signal: null });
        expect(await connectionRefused(llm.port)).toBe(true);
        expect(await connectionRefused(update.port)).toBe(true);
        expect(isAlive(launcher.child.pid)).toBe(false);
        expect(launcher.output().stdout.split('\n').filter(Boolean)).toHaveLength(1);
        expect(fs.readFileSync(llm.log, 'utf8')).toContain('"/v1/models"');
    }, 120000);

    test('serves the fixture repositories and leaves no process behind on shutdown', async () => {
        const scratch = scratchDir('launcher-git');
        const source = createSourceRepo(path.join(scratch, 'source'), { 'big.bin': randomBytes(STALL_BLOB_BYTES) });
        const run = path.join(scratch, 'run');
        const launcher = startLauncher(['--services', 'git', '--scratch', run, '--source', source.path]);
        const info = await launcher.line;
        const git = info.services.git;
        const remote = git.repos.sillybunny;
        expect(git).toMatchObject({ url: `http://127.0.0.1:${git.port}`, root: path.join(run, 'git'), log: path.join(run, 'logs', 'git.jsonl') });
        expect(isFixturePort(git.port)).toBe(true);
        expect(git.port).toBeLessThanOrEqual(DEVICE_PORT_MAX);
        expect(remote).toEqual({
            name: 'SillyBunny.git',
            path: path.join(run, 'git', 'SillyBunny.git'),
            url: `${git.url}/SillyBunny.git`,
            heads: { release: remote.commit, staging: remote.commit },
            tags: {},
            pending: {},
            sourceCommit: source.head,
            sourceTree: source.tree,
            commit: expect.stringMatching(/^[0-9a-f]{40}$/),
        });
        const extension = git.repos.extension;
        expect(extension).toMatchObject({ url: `${git.url}/sillybunny-smoke-extension.git`, heads: { main: extension.commits.initial, next: extension.commits.next }, pending: { main: extension.commits.update } });
        expect(git.repos.plugin).toMatchObject({ url: `${git.url}/sillybunny-smoke-plugin.git`, tag: PLUGIN_TAG, tags: { [PLUGIN_TAG]: git.repos.plugin.commits.initial } });
        expect(info.gradleProperties).toEqual({ debugRepoUrl: remote.url });
        expect(info.adbReverse).toEqual([{ service: 'git', devicePort: git.port, hostPort: git.port, args: ['reverse', `tcp:${git.port}`, `tcp:${git.port}`], removeArgs: ['reverse', '--remove', `tcp:${git.port}`] }]);
        expect(readJson(path.join(run, 'git-fixtures.json')).sillybunny).toEqual({ sourceCommit: source.head, sourceTree: source.tree, commit: remote.commit });

        const env = createGitEnv();
        expect(await runGitAsync(['ls-remote', remote.url], { env, cwd: scratch })).toContain(`${remote.commit}\trefs/heads/release`);
        expect(await rawExchange(git.port, malformedRequest('//['))).toMatch(/^HTTP\/1\.1 400 /);
        const checkout = path.join(scratch, 'checkout');
        await runGitAsync(['clone', '--quiet', '--no-checkout', '--filter=blob:none', '--branch', 'staging', '--', remote.url, checkout], { env });
        expect(await runGitAsync(['-C', checkout, 'rev-parse', 'HEAD'], { env })).toBe(remote.commit);

        // Stop while a fetch is still running: the backend tree must go with the launcher.
        const stalled = await stalledFetch(git.port, 'SillyBunny.git', remote.commit);
        onCleanup(() => stalled.socket.destroy());
        expect(stalled.first.toString('latin1')).toMatch(/^HTTP\/1\.1 200 /);
        const tree = await waitForDescendants(launcher.child.pid, 3);
        expect(tree.length).toBeGreaterThanOrEqual(3);

        const exit = await stopLauncher(launcher, 'SIGTERM');
        stalled.socket.destroy();
        expect(exit).toEqual({ code: 0, signal: null });
        expect(await connectionRefused(git.port)).toBe(true);
        expect([launcher.child.pid, ...tree].filter(isAlive)).toEqual([]);
        const logged = fs.readFileSync(git.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(logged.some(entry => entry.path === '/SillyBunny.git/git-upload-pack' && entry.gitProtocol === 'version=2')).toBe(true);
    }, 180000);

    test('reuses a complete scratch directory and refuses a stale or incomplete one', async () => {
        const scratch = scratchDir('launcher-reuse');
        const source = createSourceRepo(path.join(scratch, 'source'));
        const run = path.join(scratch, 'run');
        const start = async (options = {}) => {
            const fixtures = await startFixtures({ services: ['git'], scratch: run, source: source.path, ...options });
            onCleanup(() => fixtures.close());
            return fixtures;
        };

        const first = await start();
        const built = first.info.services.git.repos;
        await first.close();
        expect(fs.readdirSync(path.join(run, 'git')).sort()).toEqual(['SillyBunny.git', 'sillybunny-smoke-extension.git', 'sillybunny-smoke-plugin.git']);

        // Helper commits made between runs stay; nothing is rebuilt.
        const marker = pushMarkerCommit({ repo: built.sillybunny.path, branch: 'release' });
        publishPending({ repo: built.extension.path });
        const second = await start();
        const reused = second.info.services.git.repos;
        await second.close();
        expect(reused.sillybunny).toMatchObject({ commit: built.sillybunny.commit, sourceCommit: source.head, heads: { release: marker.commit, staging: built.sillybunny.commit } });
        expect(reused.extension).toMatchObject({ commits: built.extension.commits, heads: { main: built.extension.commits.update }, pending: {} });
        expect(reused.plugin).toMatchObject({ commits: built.plugin.commits, tags: built.plugin.tags });

        // A new source commit is refused rather than served from the old tree; the old commit by --ref still matches.
        writeFiles(source.path, { 'later.txt': 'lorum ipsum\n' });
        runGit(['-C', source.path, 'add', '--all']);
        runGit(['-C', source.path, 'commit', '--quiet', '-m', 'lorum ipsum']);
        await expect(start()).rejects.toThrow(`SillyBunny.git was built from ${source.head}, not `);
        await (await start({ ref: 'HEAD~1' })).close();

        updateRefs(built.plugin.path, [{ ref: `refs/tags/${PLUGIN_TAG}`, next: null }]);
        await expect(start({ ref: 'HEAD~1' })).rejects.toThrow(`sillybunny-smoke-plugin.git is incomplete (missing tag ${PLUGIN_TAG})`);
    }, 120000);

    test('refuses a repository that an interrupted run left half-built', () => {
        const scratch = scratchDir('launcher-partial');
        const source = createSourceRepo(path.join(scratch, 'source'));
        const run = path.join(scratch, 'run');
        // What an interrupted build used to leave: an empty bare repository and no build record.
        const partial = initBareRepository(path.join(run, 'git', 'SillyBunny.git'), 'release');

        const result = runCli(['start', '--services', 'git', '--scratch', run, '--source', source.path, '--watch-stdin']);
        expect(result).toMatchObject({
            status: 1,
            json: { ok: false, error: 'lorum ipsum', code: 'failed', detail: expect.stringContaining('SillyBunny.git has no complete build record') },
        });
        expect(readRefs(partial).heads).toEqual({});
        expect(fs.existsSync(path.join(run, 'git-fixtures.json'))).toBe(false);
    }, 60000);

    test('runs the helper commands, one JSON line each', async () => {
        const scratch = scratchDir('launcher-helpers');
        const root = path.join(scratch, 'git');
        const remote = buildSillyBunnyRemote({ root, source: createSourceRepo(path.join(scratch, 'source')).path, tmpDir: path.join(scratch, 'tmp') });
        const plugin = buildPluginRepo({ root });

        expect(runCli(['heads', '--repo', remote.path]).json).toEqual({ ok: true, repo: remote.path, heads: { release: remote.commit, staging: remote.commit }, tags: {}, pending: {} });
        const marker = runCli(['push-marker', '--repo', remote.path, '--branch', 'release']);
        expect(marker).toMatchObject({ status: 0, json: { ok: true, branch: 'release', parent: remote.commit, marker: MARKER_PATH } });
        const raised = runCli(['raise-min-app-version', '--repo', remote.path, '--branch', 'release', '--above', '7']);
        expect(raised).toMatchObject({ status: 0, json: { ok: true, branch: 'release', parent: marker.json.commit, minAppVersion: 8 } });
        expect(runGit(['-C', remote.path, 'show', `release:${MIN_APP_VERSION_PATH}`])).toBe('8');
        expect(runCli(['publish', '--repo', plugin.path]).json).toEqual({ ok: true, repo: plugin.path, branch: 'main', parent: plugin.commits.initial, commit: plugin.commits.update });
        expect(runCli(['publish', '--repo', plugin.path])).toMatchObject({ status: 1, json: { ok: false, error: 'lorum ipsum', code: 'failed' } });

        const data = path.join(scratch, 'data');
        const seeded = runCli(['seed-data', '--dir', data]);
        expect(seeded).toMatchObject({ status: 0, json: { ok: true, dir: data, files: [`${DATA_USER}/characters/${CHARACTER_FILE}`, `${DATA_USER}/chats/smoke-fixture/lorum ipsum.jsonl`, `${DATA_USER}/secrets.json`] } });
        const baseline = path.join(scratch, 'baseline.json');
        fs.writeFileSync(baseline, seeded.lines[0]);
        expect(runCli(['checksum', '--dir', data, '--baseline', baseline])).toMatchObject({ status: 0, json: { ok: true, changed: [], removed: [], added: [] } });
        writeFiles(data, { [`${DATA_USER}/settings.json`]: '{}\n' });
        expect(runCli(['checksum', '--dir', data, '--baseline', baseline, '--allow-added', `${DATA_USER}/chats`])).toMatchObject({ status: 1, json: { ok: false, unexpected: [`${DATA_USER}/settings.json`] } });
        const plain = runCli(['checksum', '--dir', data]);
        expect(plain.json.manifest).toEqual(await checksumTree(data));
        fs.appendFileSync(path.join(data, DATA_USER, 'secrets.json'), ' ');
        expect(runCli(['checksum', '--dir', data, '--baseline', baseline])).toMatchObject({ status: 1, json: { ok: false, changed: [`${DATA_USER}/secrets.json`] } });

        expect(runCli(['--help'])).toMatchObject({ status: 0, lines: ['lorum ipsum'] });
        expect(runCli(['push-marker', '--branch', 'release'])).toMatchObject({ status: 2, json: { ok: false, error: 'lorum ipsum', code: 'missing-option', option: 'repo' } });
        expect(runCli(['raise-min-app-version', '--repo', remote.path, '--branch', 'release', '--above', 'x'])).toMatchObject({ status: 2, json: { code: 'invalid-integer', option: 'above' } });
        expect(runCli(['start', '--services', 'git,ftp'])).toMatchObject({ status: 2, json: { code: 'unknown-service', value: 'ftp' } });
        expect(runCli(['manifest', '--dir', scratch, '--apk', 'x86_64'])).toMatchObject({ status: 2, json: { code: 'invalid-apk' } });
        expect(runCli(['frobnicate'])).toMatchObject({ status: 2, json: { code: 'unknown-command', value: 'frobnicate' } });
        expect(runCli(['heads', '--bogus'])).toMatchObject({ status: 2, json: { code: 'invalid-arguments' } });
        const failed = runCli(['heads', '--repo', path.join(scratch, 'missing.git')]);
        expect(failed).toMatchObject({ status: 1, json: { ok: false, error: 'lorum ipsum', code: 'failed', detail: expect.any(String) } });
    }, 120000);
});
