import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import {
    extractSafeTarGz,
    parseSha256Sums,
    seedReleaseAssets,
} from '../scripts/seed-release-assets.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sha256Hex(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

function makePaxRecord(key, value) {
    const body = ` ${key}=${value}\n`;
    let length = Buffer.byteLength(body, 'utf8') + 1;
    while (true) {
        const candidate = `${length}${body}`;
        const actualLength = Buffer.byteLength(candidate, 'utf8');
        if (actualLength === length) {
            return Buffer.from(candidate, 'utf8');
        }
        length = actualLength;
    }
}

function makeUstarHeader({ name, typeflag = '0', size = 0, linkname = '' }) {
    const header = Buffer.alloc(512, 0);
    Buffer.from(name, 'utf8').copy(header, 0, 0, Math.min(100, Buffer.byteLength(name, 'utf8')));
    Buffer.from('0000644\0', 'ascii').copy(header, 100);
    Buffer.from('0000000\0', 'ascii').copy(header, 108);
    Buffer.from('0000000\0', 'ascii').copy(header, 116);
    Buffer.from(`${size.toString(8).padStart(11, '0')}\0`, 'ascii').copy(header, 124);
    Buffer.from(`${(0).toString(8).padStart(11, '0')}\0`, 'ascii').copy(header, 136);
    header.fill(0x20, 148, 156);
    header[156] = typeflag.charCodeAt(0);
    if (linkname) {
        Buffer.from(linkname, 'utf8').copy(header, 157, 0, Math.min(100, Buffer.byteLength(linkname, 'utf8')));
    }
    Buffer.from('ustar\0', 'ascii').copy(header, 257);
    Buffer.from('00', 'ascii').copy(header, 263);

    let checksum = 0;
    for (let i = 0; i < 512; i += 1) {
        checksum += header[i];
    }
    Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `, 'ascii').copy(header, 148);
    return header;
}

function pushBlockPadded(blocks, buffer) {
    if (buffer.length > 0) {
        blocks.push(buffer);
        const remainder = buffer.length % 512;
        if (remainder !== 0) {
            blocks.push(Buffer.alloc(512 - remainder, 0));
        }
    }
}

function makeUstarArchive(entries) {
    const blocks = [];
    for (const entry of entries) {
        const name = entry.name;
        const typeflag = entry.typeflag || '0';
        const data = entry.content ? Buffer.from(entry.content) : Buffer.alloc(0);

        if (entry.paxPath) {
            const paxData = makePaxRecord('path', entry.paxPath);
            blocks.push(makeUstarHeader({ name: 'PaxHeader/entry', typeflag: 'x', size: paxData.length }));
            pushBlockPadded(blocks, paxData);
        }

        blocks.push(makeUstarHeader({
            name,
            typeflag,
            size: data.length,
            linkname: entry.linkname || '',
        }));
        pushBlockPadded(blocks, data);
    }
    blocks.push(Buffer.alloc(1024, 0));
    return zlib.gzipSync(Buffer.concat(blocks));
}

describe('release tarball seeder, Dockerfile layer caching, and direct Docker init', () => {
    let tempDir = '';
    let emptyGitConfigPath = '';
    let server = null;

    function makeGitEnv(extraEnv = {}) {
        const env = {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: emptyGitConfigPath,
            GIT_AUTHOR_NAME: 'Test Author',
            GIT_AUTHOR_EMAIL: 'test@example.com',
            GIT_COMMITTER_NAME: 'Test Author',
            GIT_COMMITTER_EMAIL: 'test@example.com',
            ...extraEnv,
        };
        delete env.GIT_DIR;
        delete env.GIT_WORK_TREE;
        delete env.GIT_INDEX_FILE;
        return env;
    }

    function git(cwd, ...args) {
        const result = spawnSync('git', args, {
            cwd,
            env: makeGitEnv(),
            encoding: 'utf8',
            windowsHide: true,
        });
        if (result.status !== 0) {
            throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
        }
        return result.stdout.trim();
    }

    beforeAll(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pr12-seeder-'));
        emptyGitConfigPath = path.join(tempDir, 'empty.gitconfig');
        fs.writeFileSync(emptyGitConfigPath, '');
    });

    afterEach(async () => {
        if (server) {
            await new Promise(resolve => server.close(resolve));
            server = null;
        }
    });

    afterAll(() => {
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('scripts/seed-release-assets.js, Dockerfile, and docker-entrypoint.sh preserve strict LF and wiring contracts', () => {
        const seederSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'seed-release-assets.js'), 'utf8');
        const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
        const entrypoint = fs.readFileSync(path.join(repoRoot, 'docker', 'docker-entrypoint.sh'), 'utf8');

        expect(seederSource.includes('\r')).toBe(false);
        expect(dockerfile.includes('\r')).toBe(false);
        expect(entrypoint.includes('\r')).toBe(false);

        // Zero non-node:* static imports so the seeder works standalone before PR 11/13 merge.
        const staticSpecifiers = [...seederSource.matchAll(/^\s*import\s+.*?from\s+['"]([^'"]+)['"]/gm)]
            .map(match => match[1]);
        expect(staticSpecifiers.length).toBeGreaterThan(0);
        expect(staticSpecifiers.every(specifier => specifier.startsWith('node:'))).toBe(true);

        // Dockerfile layer-caches dependencies ahead of full repo copy and conditionally builds dist assets.
        const copyPkgIdx = dockerfile.indexOf('COPY --chown=bun:bun package.json bun.lock .npmrc ./');
        const bunInstallIdx = dockerfile.indexOf('bun install --frozen-lockfile --production');
        const copyAllIdx = dockerfile.indexOf('COPY --chown=bun:bun . ./');
        expect(copyPkgIdx).toBeGreaterThan(-1);
        expect(bunInstallIdx).toBeGreaterThan(copyPkgIdx);
        expect(copyAllIdx).toBeGreaterThan(bunInstallIdx);
        expect(dockerfile).toContain('node "./scripts/build-prebuilt-lib.js"');
        expect(dockerfile).toContain('bun "./docker/build-lib.js"');
        expect(dockerfile).toContain('node "./scripts/build-frontend-assets.js"');
        expect(dockerfile).toContain('chown -R bun:bun dist');

        // docker-entrypoint.sh runs server-init.js directly.
        expect(entrypoint).toContain('$PREFIX bun src/server-init.js');
        expect(entrypoint).not.toContain('bun run init');
    });

    test('parseSha256Sums handles standard and binary-mode GNU sha256sum lines', () => {
        const hashA = '1'.repeat(64);
        const hashB = '2'.repeat(64);
        const parsed = parseSha256Sums([
            '# comment line',
            `${hashA}  sillybunny-prebuilt-lib.tar.gz`,
            `${hashB} *dist/sillybunny-frontend-assets.tar.gz`,
            'not-a-valid-line',
        ].join('\n'));

        expect(parsed.get('sillybunny-prebuilt-lib.tar.gz')).toBe(hashA);
        expect(parsed.get('sillybunny-frontend-assets.tar.gz')).toBe(hashB);
        expect(parsed.size).toBe(2);
    });

    test('extractSafeTarGz extracts valid USTAR/PAX entries and rejects traversal, outside prefix, and symlinks', () => {
        const happyDest = path.join(tempDir, 'happy-dest');
        const longRelPath = 'dist/frontend/scripts/nested/' + 'segment-'.repeat(12) + 'mod-abcdef123456.js';
        const happyTar = makeUstarArchive([
            { name: 'dist/frontend/', typeflag: '5' },
            { name: 'dist/frontend/asset-manifest.json', content: '{"schemaVersion":2}' },
            { name: 'dist/frontend/truncated-name', paxPath: longRelPath, content: 'export const ok = 1;\n' },
        ]);

        const extracted = extractSafeTarGz(happyTar, { expectedPrefix: 'dist/frontend', destDir: happyDest });
        expect(extracted.fileCount).toBe(2);
        expect(fs.readFileSync(path.join(happyDest, 'asset-manifest.json'), 'utf8')).toBe('{"schemaVersion":2}');
        expect(fs.readFileSync(path.join(happyDest, ...longRelPath.slice('dist/frontend/'.length).split('/')), 'utf8')).toBe('export const ok = 1;\n');

        const unsafeDest = path.join(tempDir, 'unsafe-dest');

        const traversalTar = makeUstarArchive([
            { name: 'dist/lib/../../escape.txt', content: 'nope' },
        ]);
        expect(() => extractSafeTarGz(traversalTar, { expectedPrefix: 'dist/lib/', destDir: unsafeDest })).toThrow(/traversal|Unsafe/i);

        const outsidePrefixTar = makeUstarArchive([
            { name: 'other/lib.js', content: 'nope' },
        ]);
        expect(() => extractSafeTarGz(outsidePrefixTar, { expectedPrefix: 'dist/lib/', destDir: unsafeDest })).toThrow(/outside expected prefix/i);

        const symlinkTar = makeUstarArchive([
            { name: 'dist/lib/link.js', typeflag: '2', linkname: '/etc/passwd' },
        ]);
        expect(() => extractSafeTarGz(symlinkTar, { expectedPrefix: 'dist/lib/', destDir: unsafeDest })).toThrow(/Unsupported tar entry type/i);
    });

    test('seedReleaseAssets downloads, verifies SHA-256, extracts dist/lib & dist/frontend, stamps HEAD, skips on rerun, and re-seeds on HEAD change', async () => {
        const fixtureRepo = path.join(tempDir, 'seed-git-repo');
        fs.mkdirSync(fixtureRepo, { recursive: true });
        git(tempDir, 'init', '--quiet', '--initial-branch=release', fixtureRepo);
        fs.writeFileSync(path.join(fixtureRepo, 'package.json'), JSON.stringify({ name: 'sillybunny', version: '2.0.0' }));
        git(fixtureRepo, 'add', 'package.json');
        git(fixtureRepo, 'commit', '--quiet', '-m', 'release 2.0.0');
        const headV1 = git(fixtureRepo, 'rev-parse', 'HEAD');

        const libTarV1 = makeUstarArchive([
            { name: 'dist/lib/lib.js', content: 'export const v = 1;\n' },
            { name: 'dist/lib/lib.manifest.json', content: JSON.stringify({ schemaVersion: 1, cacheVersion: 'v1' }) },
        ]);
        const frontendTarV1 = makeUstarArchive([
            { name: 'dist/frontend/asset-manifest.json', content: JSON.stringify({ schemaVersion: 2, assets: {} }) },
            { name: 'dist/frontend/style-abc123def456.css', content: 'body{color:#fff}\n' },
        ]);
        const sumsV1 = [
            `${sha256Hex(libTarV1)}  sillybunny-prebuilt-lib.tar.gz`,
            `${sha256Hex(frontendTarV1)}  sillybunny-frontend-assets.tar.gz`,
        ].join('\n') + '\n';

        const libTarV2 = makeUstarArchive([
            { name: 'dist/lib/lib.js', content: 'export const v = 2;\n' },
            { name: 'dist/lib/lib.manifest.json', content: JSON.stringify({ schemaVersion: 1, cacheVersion: 'v2' }) },
        ]);
        const frontendTarV2 = makeUstarArchive([
            { name: 'dist/frontend/asset-manifest.json', content: JSON.stringify({ schemaVersion: 2, assets: { a: 'b' } }) },
        ]);
        const sumsV2 = [
            `${sha256Hex(libTarV2)}  sillybunny-prebuilt-lib.tar.gz`,
            `${sha256Hex(frontendTarV2)}  sillybunny-frontend-assets.tar.gz`,
        ].join('\n') + '\n';

        let requestCount = 0;
        server = http.createServer((req, res) => {
            requestCount += 1;
            const routes = {
                '/v2.0.0/SHA256SUMS': sumsV1,
                '/v2.0.0/sillybunny-prebuilt-lib.tar.gz': libTarV1,
                '/v2.0.0/sillybunny-frontend-assets.tar.gz': frontendTarV1,
                '/v2.0.1/SHA256SUMS': sumsV2,
                '/v2.0.1/sillybunny-prebuilt-lib.tar.gz': libTarV2,
                '/v2.0.1/sillybunny-frontend-assets.tar.gz': frontendTarV2,
            };
            const payload = routes[req.url];
            if (payload !== undefined) {
                res.writeHead(200);
                res.end(payload);
                return;
            }
            res.writeHead(404);
            res.end('not found');
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const baseUrl = `http://127.0.0.1:${server.address().port}`;

        const firstRun = await seedReleaseAssets({
            repoDir: fixtureRepo,
            tag: 'v2.0.0',
            baseUrl,
            env: makeGitEnv(),
            stdout: () => {},
            stderr: () => {},
        });
        expect(firstRun.ok).toBe(true);
        expect(firstRun.seeded).toEqual(['prebuiltLib', 'frontendAssets']);
        expect(fs.readFileSync(path.join(fixtureRepo, 'dist', 'lib', 'lib.js'), 'utf8')).toBe('export const v = 1;\n');
        expect(fs.readFileSync(path.join(fixtureRepo, 'dist', '.release-assets-head'), 'utf8').trim()).toBe(headV1);

        // Rerun on same HEAD makes zero HTTP requests.
        const countAfterFirst = requestCount;
        const secondRun = await seedReleaseAssets({
            repoDir: fixtureRepo,
            tag: 'v2.0.0',
            baseUrl,
            env: makeGitEnv(),
            stdout: () => {},
            stderr: () => {},
        });
        expect(secondRun.ok).toBe(true);
        expect(secondRun.seeded).toEqual([]);
        expect(secondRun.skipped).toEqual(['already-fresh']);
        expect(requestCount).toBe(countAfterFirst);

        // Advancing HEAD invalidates .release-assets-head and triggers fresh download for v2.0.1.
        fs.writeFileSync(path.join(fixtureRepo, 'package.json'), JSON.stringify({ name: 'sillybunny', version: '2.0.1' }));
        git(fixtureRepo, 'add', 'package.json');
        git(fixtureRepo, 'commit', '--quiet', '-m', 'release 2.0.1');
        const headV2 = git(fixtureRepo, 'rev-parse', 'HEAD');

        const thirdRun = await seedReleaseAssets({
            repoDir: fixtureRepo,
            tag: 'v2.0.1',
            baseUrl,
            env: makeGitEnv(),
            stdout: () => {},
            stderr: () => {},
        });
        expect(thirdRun.ok).toBe(true);
        expect(thirdRun.seeded).toEqual(['prebuiltLib', 'frontendAssets']);
        expect(fs.readFileSync(path.join(fixtureRepo, 'dist', 'lib', 'lib.js'), 'utf8')).toBe('export const v = 2;\n');
        expect(fs.readFileSync(path.join(fixtureRepo, 'dist', '.release-assets-head'), 'utf8').trim()).toBe(headV2);
    });

    test('seedReleaseAssets rejects mismatched SHA-256, insecure base URLs, and honours SILLYBUNNY_SKIP_RELEASE_ASSETS', async () => {
        const fixtureRepo = path.join(tempDir, 'bad-sha-repo');
        fs.mkdirSync(fixtureRepo, { recursive: true });
        const badTar = makeUstarArchive([{ name: 'dist/lib/lib.js', content: 'tampered' }]);

        server = http.createServer((req, res) => {
            if (req.url === '/v2.0.2/SHA256SUMS') {
                res.writeHead(200);
                res.end(`${'0'.repeat(64)}  sillybunny-prebuilt-lib.tar.gz\n`);
                return;
            }
            if (req.url === '/v2.0.2/sillybunny-prebuilt-lib.tar.gz') {
                res.writeHead(200);
                res.end(badTar);
                return;
            }
            res.writeHead(404);
            res.end();
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const baseUrl = `http://127.0.0.1:${server.address().port}`;

        const strictResult = await seedReleaseAssets({
            repoDir: fixtureRepo,
            tag: 'v2.0.2',
            baseUrl,
            optional: false,
            stdout: () => {},
            stderr: () => {},
        });
        expect(strictResult.ok).toBe(false);
        expect(fs.existsSync(path.join(fixtureRepo, 'dist', 'lib', 'lib.js'))).toBe(false);

        const optionalResult = await seedReleaseAssets({
            repoDir: fixtureRepo,
            tag: 'v2.0.2',
            baseUrl,
            optional: true,
            stdout: () => {},
            stderr: () => {},
        });
        expect(optionalResult.ok).toBe(true);
        expect(optionalResult.seeded).toEqual([]);

        const insecureResult = await seedReleaseAssets({
            repoDir: fixtureRepo,
            tag: 'v2.0.2',
            baseUrl: 'http://example.com/releases',
            optional: false,
            stdout: () => {},
            stderr: () => {},
        });
        expect(insecureResult.ok).toBe(false);
        expect(insecureResult.skipped).toEqual(['invalid-base-url']);

        const disabledResult = await seedReleaseAssets({
            repoDir: fixtureRepo,
            tag: 'v2.0.2',
            baseUrl,
            env: { SILLYBUNNY_SKIP_RELEASE_ASSETS: '1' },
            stdout: () => {},
            stderr: () => {},
        });
        expect(disabledResult).toEqual({ ok: true, seeded: [], skipped: ['disabled'] });
    });

    function createReleaseRepo(name, version) {
        const repo = path.join(tempDir, name);
        fs.mkdirSync(repo, { recursive: true });
        git(tempDir, 'init', '--quiet', '--initial-branch=release', repo);
        fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'sillybunny', version }));
        git(repo, 'add', 'package.json');
        git(repo, 'commit', '--quiet', '-m', `release ${version}`);
        return repo;
    }

    async function listen(handler) {
        server = http.createServer(handler);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        return `http://127.0.0.1:${server.address().port}`;
    }

    describe('release without published tarballs on the launch path', () => {
        function optionalSeed(repo, baseUrl, extra = {}) {
            const stderrLines = [];
            const promise = seedReleaseAssets({
                repoDir: repo,
                tag: 'v2.3.0',
                baseUrl,
                optional: true,
                env: makeGitEnv(),
                stdout: () => {},
                stderr: message => stderrLines.push(message),
                ...extra,
            });
            return promise.then(result => ({ result, stderrLines }));
        }

        const noAssetsStamp = repo => path.join(repo, 'dist', '.release-assets-none');

        test('a 404 for SHA256SUMS is remembered per tag, is silent, and is not asked again', async () => {
            const repo = createReleaseRepo('no-assets-404', '2.3.0');
            const requestedUrls = [];
            const baseUrl = await listen((req, res) => {
                requestedUrls.push(req.url);
                res.writeHead(404);
                res.end('not found');
            });

            const first = await optionalSeed(repo, baseUrl);
            expect(first.result).toEqual({ ok: true, seeded: [], skipped: ['no-assets'] });
            expect(first.stderrLines).toEqual([]);
            expect(requestedUrls).toEqual(['/v2.3.0/SHA256SUMS']);
            expect(fs.readFileSync(noAssetsStamp(repo), 'utf8').trim()).toBe('v2.3.0');

            const second = await optionalSeed(repo, baseUrl);
            expect(second.result).toEqual({ ok: true, seeded: [], skipped: ['no-assets'] });
            expect(second.stderrLines).toEqual([]);
            expect(requestedUrls).toHaveLength(1);

            // A new release asks again, once.
            await optionalSeed(repo, baseUrl, { tag: 'v2.3.1' });
            await optionalSeed(repo, baseUrl, { tag: 'v2.3.1' });
            expect(requestedUrls).toEqual(['/v2.3.0/SHA256SUMS', '/v2.3.1/SHA256SUMS']);

            // An explicit run is not the launch path: it asks and it reports the 404.
            const stderrLines = [];
            const explicit = await seedReleaseAssets({
                repoDir: repo,
                tag: 'v2.3.1',
                baseUrl,
                optional: false,
                env: makeGitEnv(),
                stdout: () => {},
                stderr: message => stderrLines.push(message),
            });
            expect(explicit.ok).toBe(false);
            expect(stderrLines.join('\n')).toContain('HTTP 404');
            expect(requestedUrls).toHaveLength(3);
        });

        test('a SHA256SUMS without the tarball lines is remembered too', async () => {
            const repo = createReleaseRepo('no-assets-sums', '2.3.0');
            let requests = 0;
            const baseUrl = await listen((req, res) => {
                requests += 1;
                res.writeHead(200);
                res.end(`${sha256Hex('source')}  sillybunny-2.3.0.zip\n`);
            });

            const first = await optionalSeed(repo, baseUrl);
            expect(first.result.ok).toBe(true);
            expect(first.result.seeded).toEqual([]);
            expect(first.stderrLines).toEqual([]);
            expect(fs.readFileSync(noAssetsStamp(repo), 'utf8').trim()).toBe('v2.3.0');

            await optionalSeed(repo, baseUrl);
            expect(requests).toBe(1);
        });

        test('SILLYBUNNY_SKIP_RELEASE_ASSETS makes no request and writes no stamp', async () => {
            const repo = createReleaseRepo('no-assets-skip', '2.3.0');
            let requests = 0;
            const baseUrl = await listen((req, res) => {
                requests += 1;
                res.writeHead(404);
                res.end();
            });

            const { result } = await optionalSeed(repo, baseUrl, { env: makeGitEnv({ SILLYBUNNY_SKIP_RELEASE_ASSETS: '1' }) });
            expect(result).toEqual({ ok: true, seeded: [], skipped: ['disabled'] });
            expect(requests).toBe(0);
            expect(fs.existsSync(noAssetsStamp(repo))).toBe(false);
        });

        test('a refused connection, a server error and a stalled server are never remembered', async () => {
            const repo = createReleaseRepo('no-assets-errors', '2.3.0');

            // Nothing listens on this port any more.
            const deadBase = await listen((req, res) => res.end());
            await new Promise(resolve => server.close(resolve));
            server = null;
            const refused = await optionalSeed(repo, deadBase);
            expect(refused.result.ok).toBe(true);
            expect(refused.result.skipped).toContain('error');
            expect(refused.stderrLines).toHaveLength(1);
            expect(fs.existsSync(noAssetsStamp(repo))).toBe(false);

            const failingBase = await listen((req, res) => {
                res.writeHead(503);
                res.end('unavailable');
            });
            const unavailable = await optionalSeed(repo, failingBase);
            expect(unavailable.result.skipped).toContain('error');
            expect(unavailable.stderrLines).toHaveLength(1);
            expect(fs.existsSync(noAssetsStamp(repo))).toBe(false);
            await new Promise(resolve => server.close(resolve));
            server = null;

            const stalledBase = await listen(() => {});
            const startedAt = Date.now();
            const stalled = await optionalSeed(repo, stalledBase, { deadlineMs: 300 });
            expect(Date.now() - startedAt).toBeLessThan(3000);
            expect(stalled.result.skipped).toContain('error');
            expect(stalled.stderrLines).toHaveLength(1);
            expect(stalled.stderrLines[0]).toContain('Timed out');
            expect(fs.existsSync(noAssetsStamp(repo))).toBe(false);
            server.closeAllConnections();
        });

        test('one deadline covers all requests of the run, not each request on its own', async () => {
            const repo = createReleaseRepo('no-assets-deadline', '2.3.0');
            const libSum = `${sha256Hex('lib')}  sillybunny-prebuilt-lib.tar.gz\n`;
            const baseUrl = await listen((req, res) => {
                setTimeout(() => {
                    res.writeHead(200);
                    res.end(req.url.endsWith('SHA256SUMS') ? libSum : 'lib');
                }, 300);
            });

            const startedAt = Date.now();
            const { result, stderrLines } = await optionalSeed(repo, baseUrl, { deadlineMs: 500 });
            const elapsed = Date.now() - startedAt;
            // Two requests of 300 ms each fit a per-request limit of 15 s but not a 500 ms deadline.
            expect(elapsed).toBeLessThan(800);
            expect(result.skipped).toContain('error');
            expect(stderrLines).toHaveLength(1);
            expect(stderrLines[0]).toContain('Timed out');
            expect(fs.existsSync(noAssetsStamp(repo))).toBe(false);
            server.closeAllConnections();
        });
    });

    describe('updaters on a release checkout whose release has no tarballs', () => {
        function createReleaseClone(name, version) {
            const workParent = path.join(tempDir, name);
            const remoteDir = path.join(workParent, 'remote.git');
            const upstreamDir = path.join(workParent, 'upstream');
            const cloneDir = path.join(workParent, 'clone');
            fs.mkdirSync(workParent, { recursive: true });

            git(workParent, 'init', '--quiet', '--bare', '--initial-branch=release', remoteDir);
            git(workParent, 'init', '--quiet', '--initial-branch=release', upstreamDir);
            fs.mkdirSync(path.join(upstreamDir, 'scripts'), { recursive: true });
            for (const script of ['seed-release-assets.js', 'self-update.sh']) {
                fs.copyFileSync(path.join(repoRoot, 'scripts', script), path.join(upstreamDir, 'scripts', script));
            }
            fs.writeFileSync(path.join(upstreamDir, 'package.json'), JSON.stringify({ name: 'sillybunny', type: 'module', version }));
            fs.writeFileSync(path.join(upstreamDir, '.gitignore'), '/dist\n');
            git(upstreamDir, 'add', '-A');
            git(upstreamDir, 'commit', '--quiet', '-m', `v${version}`);
            git(upstreamDir, 'remote', 'add', 'origin', remoteDir);
            git(upstreamDir, 'push', '--quiet', '-u', 'origin', 'release');
            git(workParent, 'clone', '--quiet', '--branch', 'release', remoteDir, cloneDir);
            return cloneDir;
        }

        // The test's own HTTP server answers from this process, so the updater has to run asynchronously.
        function runUpdater(kind, cloneDir, baseUrl) {
            const [command, args] = kind === 'js'
                ? [process.execPath, [path.join(repoRoot, 'scripts', 'self-update.js'), '--optional', '--repo', cloneDir]]
                : ['bash', [path.join(cloneDir, 'scripts', 'self-update.sh'), '--optional']];
            return new Promise((resolve, reject) => {
                const startedAt = Date.now();
                const child = spawn(command, args, {
                    cwd: cloneDir,
                    env: makeGitEnv({ SILLYBUNNY_RELEASE_ASSET_BASE_URL: baseUrl }),
                    windowsHide: true,
                });
                let stdout = '';
                let stderr = '';
                child.stdout.setEncoding('utf8');
                child.stderr.setEncoding('utf8');
                child.stdout.on('data', chunk => { stdout += chunk; });
                child.stderr.on('data', chunk => { stderr += chunk; });
                child.on('error', reject);
                child.on('close', status => resolve({ status, stdout, stderr, elapsedMs: Date.now() - startedAt }));
            });
        }

        test.each([['js'], ['sh']])('self-update.%s asks for the tarballs once per release and says nothing on the 404', async (kind) => {
            const cloneDir = createReleaseClone(`release-clone-404-${kind}`, '2.4.0');
            const requestedUrls = [];
            const baseUrl = await listen((req, res) => {
                requestedUrls.push(req.url);
                res.writeHead(404);
                res.end('not found');
            });

            const firstLaunch = await runUpdater(kind, cloneDir, baseUrl);
            expect(firstLaunch.status).toBe(0);
            expect(firstLaunch.stdout).toContain('SillyBunny is already up to date.');
            expect(firstLaunch.stderr).toBe('');

            // From here on the updater must not even start the seeder.
            const marker = path.join(cloneDir, 'seeder-was-started');
            const seedScript = path.join(cloneDir, 'scripts', 'seed-release-assets.js');
            git(cloneDir, 'update-index', '--skip-worktree', 'scripts/seed-release-assets.js');
            fs.writeFileSync(seedScript, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'started');\n`);

            for (let launch = 0; launch < 2; launch += 1) {
                const result = await runUpdater(kind, cloneDir, baseUrl);
                expect(result.status).toBe(0);
                expect(result.stdout).toContain('SillyBunny is already up to date.');
                expect(result.stderr).toBe('');
            }
            expect(fs.existsSync(marker)).toBe(false);
            expect(requestedUrls).toEqual(['/v2.4.0/SHA256SUMS']);
        });

        test('both updaters stop waiting for a server that never answers within the seed deadline', async () => {
            const jsClone = createReleaseClone('release-clone-stall-js', '2.5.0');
            const shClone = createReleaseClone('release-clone-stall-sh', '2.5.0');
            const baseUrl = await listen(() => {});

            const [js, sh] = await Promise.all([
                runUpdater('js', jsClone, baseUrl),
                runUpdater('sh', shClone, baseUrl),
            ]);
            server.closeAllConnections();

            for (const result of [js, sh]) {
                expect(result.status).toBe(0);
                expect(result.stderr).toContain('Skipping release asset seed (v2.5.0): Timed out');
                // A request timeout of 15 s per request, up to three requests, was the limit before.
                expect(result.elapsedMs).toBeLessThan(12_000);
            }
            expect(fs.existsSync(path.join(jsClone, 'dist', '.release-assets-none'))).toBe(false);
            expect(fs.existsSync(path.join(shClone, 'dist', '.release-assets-none'))).toBe(false);
        }, 30_000);
    });

    test('self-update.js resolves package.json release tag after --no-tags pull and seeds release assets', async () => {
        const workParent = path.join(tempDir, 'self-update-seed');
        const remoteDir = path.join(workParent, 'remote.git');
        const upstreamDir = path.join(workParent, 'upstream');
        const cloneDir = path.join(workParent, 'clone');
        fs.mkdirSync(workParent, { recursive: true });

        git(workParent, 'init', '--quiet', '--bare', '--initial-branch=release', remoteDir);
        git(workParent, 'init', '--quiet', '--initial-branch=release', upstreamDir);
        fs.mkdirSync(path.join(upstreamDir, 'scripts'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'scripts', 'seed-release-assets.js'), path.join(upstreamDir, 'scripts', 'seed-release-assets.js'));
        fs.writeFileSync(path.join(upstreamDir, 'package.json'), JSON.stringify({ name: 'sillybunny', type: 'module', version: '2.1.0' }));
        git(upstreamDir, 'add', 'package.json', 'scripts/seed-release-assets.js');
        git(upstreamDir, 'commit', '--quiet', '-m', 'v2.1.0');
        git(upstreamDir, 'remote', 'add', 'origin', remoteDir);
        git(upstreamDir, 'push', '--quiet', '-u', 'origin', 'release');
        git(workParent, 'clone', '--quiet', '--branch', 'release', remoteDir, cloneDir);

        // Advance upstream to 2.1.1 without pushing any tag locally.
        fs.writeFileSync(path.join(upstreamDir, 'package.json'), JSON.stringify({ name: 'sillybunny', type: 'module', version: '2.1.1' }));
        git(upstreamDir, 'add', 'package.json');
        git(upstreamDir, 'commit', '--quiet', '-m', 'v2.1.1');
        git(upstreamDir, 'push', '--quiet', 'origin', 'release');
        const expectedHead = git(upstreamDir, 'rev-parse', 'HEAD');

        const libTar = makeUstarArchive([
            { name: 'dist/lib/lib.js', content: 'export const updated = "2.1.1";\n' },
            { name: 'dist/lib/lib.manifest.json', content: JSON.stringify({ schemaVersion: 1 }) },
        ]);
        const frontendTar = makeUstarArchive([
            { name: 'dist/frontend/asset-manifest.json', content: JSON.stringify({ schemaVersion: 2 }) },
        ]);
        const sums = [
            `${sha256Hex(libTar)}  sillybunny-prebuilt-lib.tar.gz`,
            `${sha256Hex(frontendTar)}  sillybunny-frontend-assets.tar.gz`,
        ].join('\n') + '\n';

        server = http.createServer((req, res) => {
            if (req.url === '/v2.1.1/SHA256SUMS') {
                res.writeHead(200);
                res.end(sums);
                return;
            }
            if (req.url === '/v2.1.1/sillybunny-prebuilt-lib.tar.gz') {
                res.writeHead(200);
                res.end(libTar);
                return;
            }
            if (req.url === '/v2.1.1/sillybunny-frontend-assets.tar.gz') {
                res.writeHead(200);
                res.end(frontendTar);
                return;
            }
            res.writeHead(404);
            res.end();
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const baseUrl = `http://127.0.0.1:${server.address().port}`;

        const selfUpdateScript = path.join(repoRoot, 'scripts', 'self-update.js');
        const result = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [selfUpdateScript, '--optional', '--repo', cloneDir], {
                cwd: cloneDir,
                env: makeGitEnv({ SILLYBUNNY_RELEASE_ASSET_BASE_URL: baseUrl }),
                windowsHide: true,
            });
            let stdout = '';
            let stderr = '';
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', chunk => { stdout += chunk; });
            child.stderr.on('data', chunk => { stderr += chunk; });
            child.on('error', reject);
            child.on('close', status => resolve({ status, stdout, stderr }));
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Updated SillyBunny from ');
        expect(result.stdout).toContain('Seeded release asset sillybunny-prebuilt-lib.tar.gz (v2.1.1).');
        expect(fs.readFileSync(path.join(cloneDir, 'dist', 'lib', 'lib.js'), 'utf8')).toBe('export const updated = "2.1.1";\n');
        expect(fs.readFileSync(path.join(cloneDir, 'dist', '.release-assets-head'), 'utf8').trim()).toBe(expectedHead);
    });
});
