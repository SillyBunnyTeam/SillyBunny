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

// src/prebuilt-lib.js and src/frontend-assets.js only exist once the prebuilt-lib and frontend-asset builds are
// merged, and a seeder that finds them validates what it unpacks. Tests pin the world they test with these.
const NO_HELPER_MODULES = Object.freeze({ prebuiltLib: null, frontendAssets: null });

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

        // Dockerfile layer-caches dependencies ahead of full repo copy and conditionally builds the prebuilt lib.
        const copyPkgIdx = dockerfile.indexOf('COPY --chown=bun:bun package.json bun.lock .npmrc ./');
        const bunInstallIdx = dockerfile.indexOf('bun install --frozen-lockfile --production');
        const copyAllIdx = dockerfile.indexOf('COPY --chown=bun:bun . ./');
        expect(copyPkgIdx).toBeGreaterThan(-1);
        expect(bunInstallIdx).toBeGreaterThan(copyPkgIdx);
        expect(copyAllIdx).toBeGreaterThan(bunInstallIdx);
        expect(dockerfile).toContain('node "./scripts/build-prebuilt-lib.js"');
        expect(dockerfile).toContain('bun "./docker/build-lib.js"');
        expect(dockerfile).toContain('chown -R bun:bun dist');

        // docker-entrypoint.sh runs server-init.js directly.
        expect(entrypoint).toContain('$PREFIX bun src/server-init.js');
        expect(entrypoint).not.toContain('bun run init');
    });

    describe('the Dockerfile step that builds the prebuilt assets', () => {
        // Runs the real RUN chain from the Dockerfile with stub node, bun and chown commands.
        function runBuildStep({ failing = [] }) {
            const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
            const block = dockerfile.split('\n\n').find(part => part.includes('build-lib.js'));
            const chain = block.slice(block.indexOf('RUN ') + 'RUN '.length).replace(/\\\n/g, ' ');

            const appDir = fs.mkdtempSync(path.join(tempDir, 'docker-step-'));
            const binDir = path.join(appDir, 'stub-bin');
            fs.mkdirSync(binDir);
            fs.mkdirSync(path.join(appDir, 'scripts'));
            fs.mkdirSync(path.join(appDir, 'docker'));
            for (const script of ['scripts/build-prebuilt-lib.js', 'scripts/build-frontend-assets.js', 'docker/build-lib.js']) {
                fs.writeFileSync(path.join(appDir, script), '');
            }
            const failCases = failing.map(name => `*${name}*) exit 3 ;;`).join('\n');
            for (const command of ['node', 'bun']) {
                fs.writeFileSync(
                    path.join(binDir, command),
                    `#!/bin/sh\necho "${command} $*" >> "${appDir}/calls.log"\ncase "$*" in\n${failCases}\nesac\nexit 0\n`,
                );
                fs.chmodSync(path.join(binDir, command), 0o755);
            }
            fs.writeFileSync(path.join(binDir, 'chown'), '#!/bin/sh\nexit 0\n');
            fs.chmodSync(path.join(binDir, 'chown'), 0o755);

            const result = spawnSync('/bin/sh', ['-c', `set -e; ${chain}`], {
                cwd: appDir,
                env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
                encoding: 'utf8',
            });
            const calls = fs.existsSync(path.join(appDir, 'calls.log')) ? fs.readFileSync(path.join(appDir, 'calls.log'), 'utf8') : '';
            return { status: result.status, calls };
        }

        test('a failed build of the prebuilt library fails the image build', () => {
            const { status, calls } = runBuildStep({ failing: ['build-prebuilt-lib.js', 'build-lib.js'] });
            expect(status).not.toBe(0);
            expect(calls).toMatch(/build-(?:prebuilt-)?lib\.js/);
        });

        test('the frontend asset build is not part of the image, so its failure cannot be hidden', () => {
            const { status, calls } = runBuildStep({ failing: ['build-frontend-assets.js'] });
            expect(status).toBe(0);
            expect(calls).not.toContain('build-frontend-assets.js');
        });
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
            helpers: NO_HELPER_MODULES,
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
            helpers: NO_HELPER_MODULES,
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
            helpers: NO_HELPER_MODULES,
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

    describe('when the helper modules are present, the seeder validates what it unpacks', () => {
        const hashOfPackageJson = (rootDir, prefix) => sha256Hex(`${prefix}${fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')}`);

        // Same contract as src/prebuilt-lib.js and src/frontend-assets.js; the inputs hash depends on the checkout's package.json.
        function makeHelperModules() {
            const stampCalls = [];
            const modules = {
                prebuiltLib: {
                    computePublicLibInputsHash: ({ rootDir }) => hashOfPackageJson(rootDir, 'lib:'),
                    readPrebuiltPublicLibManifest: (dir) => {
                        try {
                            const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'lib.manifest.json'), 'utf8'));
                            return typeof manifest.inputsHash === 'string' ? manifest : null;
                        } catch {
                            return null;
                        }
                    },
                },
                frontendAssets: {
                    computeFrontendInputsHash: ({ repoRoot }) => hashOfPackageJson(repoRoot, 'frontend:'),
                    writeFrontendInputsStamp: (hash, options) => {
                        stampCalls.push({ hash, ...options });
                        return true;
                    },
                },
            };
            return { modules, stampCalls };
        }

        function makeTarballs({ libHash, frontendHash, marker = 'v1' }) {
            const libTar = makeUstarArchive([
                { name: 'dist/lib/lib.js', content: `export const marker = '${marker}';\n` },
                { name: 'dist/lib/lib.manifest.json', content: JSON.stringify({ schemaVersion: 1, cacheVersion: 'c', inputsHash: libHash }) },
            ]);
            const frontendTar = makeUstarArchive([
                { name: 'dist/frontend/asset-manifest.json', content: JSON.stringify({ schemaVersion: 2, inputsHash: frontendHash }) },
                { name: 'dist/frontend/app-0123456789ab.js', content: `export const marker = '${marker}';\n` },
            ]);
            const sums = `${sha256Hex(libTar)}  sillybunny-prebuilt-lib.tar.gz\n${sha256Hex(frontendTar)}  sillybunny-frontend-assets.tar.gz\n`;
            return { libTar, frontendTar, sums };
        }

        function serveTarballs(tarballs, requestedUrls) {
            return listen((req, res) => {
                requestedUrls.push(req.url);
                const body = {
                    SHA256SUMS: tarballs.sums,
                    'sillybunny-prebuilt-lib.tar.gz': tarballs.libTar,
                    'sillybunny-frontend-assets.tar.gz': tarballs.frontendTar,
                }[req.url.split('/').pop()];
                res.writeHead(body === undefined ? 404 : 200);
                res.end(body);
            });
        }

        function seedWith(repo, baseUrl, modules, extra = {}) {
            const stderrLines = [];
            const promise = seedReleaseAssets({
                repoDir: repo,
                tag: 'v2.6.0',
                baseUrl,
                optional: true,
                helpers: modules,
                env: makeGitEnv(),
                stdout: () => {},
                stderr: message => stderrLines.push(message),
                ...extra,
            });
            return promise.then(result => ({ result, stderrLines }));
        }

        test('tarballs that fit the checkout are installed and stamped, and the next run asks for nothing', async () => {
            const repo = createReleaseRepo('helpers-valid', '2.6.0');
            const { modules, stampCalls } = makeHelperModules();
            const libHash = modules.prebuiltLib.computePublicLibInputsHash({ rootDir: repo });
            const frontendHash = modules.frontendAssets.computeFrontendInputsHash({ repoRoot: repo });
            const requestedUrls = [];
            const baseUrl = await serveTarballs(makeTarballs({ libHash, frontendHash }), requestedUrls);

            const first = await seedWith(repo, baseUrl, modules);
            expect(first.result).toEqual({ ok: true, seeded: ['prebuiltLib', 'frontendAssets'], skipped: [] });
            expect(first.stderrLines).toEqual([]);
            expect(fs.readFileSync(path.join(repo, 'dist', 'lib', 'lib.js'), 'utf8')).toContain('marker = \'v1\'');
            expect(fs.existsSync(path.join(repo, 'dist', 'frontend', 'app-0123456789ab.js'))).toBe(true);
            expect(fs.readFileSync(path.join(repo, 'dist', '.release-assets-head'), 'utf8').trim()).toBe(git(repo, 'rev-parse', 'HEAD'));
            expect(stampCalls).toEqual([{
                hash: frontendHash,
                distRoot: path.join(repo, 'dist', 'frontend'),
                repoRoot: repo,
                publicRoot: path.join(repo, 'public'),
            }]);

            const requestsAfterFirstRun = requestedUrls.length;
            const second = await seedWith(repo, baseUrl, modules);
            expect(second.result).toEqual({ ok: true, seeded: [], skipped: ['already-fresh'] });
            expect(requestedUrls).toHaveLength(requestsAfterFirstRun);

            // The checkout's build inputs change: the installed files are stale and this release's tarballs no longer fit.
            fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'sillybunny', version: '2.6.0', edited: true }));
            const third = await seedWith(repo, baseUrl, modules);
            expect(third.result).toEqual({ ok: true, seeded: [], skipped: ['prebuiltLib:mismatch', 'frontendAssets:mismatch'] });
            expect(third.stderrLines).toHaveLength(2);
            expect(fs.readFileSync(path.join(repo, 'dist', 'lib', 'lib.js'), 'utf8')).toContain('marker = \'v1\'');
            expect(stampCalls).toHaveLength(1);
        });

        test('tarballs that do not fit the checkout are not installed, not stamped, and reported', async () => {
            const repo = createReleaseRepo('helpers-mismatch', '2.6.0');
            const { modules, stampCalls } = makeHelperModules();
            const requestedUrls = [];
            const baseUrl = await serveTarballs(makeTarballs({ libHash: 'f'.repeat(64), frontendHash: 'e'.repeat(64) }), requestedUrls);

            const optionalRun = await seedWith(repo, baseUrl, modules);
            expect(optionalRun.result).toEqual({ ok: true, seeded: [], skipped: ['prebuiltLib:mismatch', 'frontendAssets:mismatch'] });
            expect(optionalRun.stderrLines).toHaveLength(2);
            expect(optionalRun.stderrLines[0]).toContain('sillybunny-prebuilt-lib.tar.gz does not match this checkout');
            expect(optionalRun.stderrLines[1]).toContain('sillybunny-frontend-assets.tar.gz does not match this checkout');
            expect(fs.existsSync(path.join(repo, 'dist', 'lib'))).toBe(false);
            expect(fs.existsSync(path.join(repo, 'dist', 'frontend'))).toBe(false);
            expect(fs.existsSync(path.join(repo, 'dist', '.release-assets-head'))).toBe(false);
            // A mismatch says something about this checkout, not about the release, so it is not remembered as "no assets".
            expect(fs.existsSync(path.join(repo, 'dist', '.release-assets-none'))).toBe(false);
            expect(stampCalls).toEqual([]);
            expect(fs.readdirSync(path.join(repo, 'dist')).filter(name => name.endsWith('.tmp'))).toEqual([]);

            const explicitRun = await seedWith(repo, baseUrl, modules, { optional: false });
            expect(explicitRun.result.ok).toBe(false);
            expect(explicitRun.stderrLines[0]).toContain('Failed to seed release assets (v2.6.0)');
        });

        test('a tarball that fits is installed even when the other one does not', async () => {
            const repo = createReleaseRepo('helpers-partial', '2.6.0');
            const { modules, stampCalls } = makeHelperModules();
            const libHash = modules.prebuiltLib.computePublicLibInputsHash({ rootDir: repo });
            const baseUrl = await serveTarballs(makeTarballs({ libHash, frontendHash: 'e'.repeat(64) }), []);

            const { result, stderrLines } = await seedWith(repo, baseUrl, modules);
            expect(result).toEqual({ ok: true, seeded: ['prebuiltLib'], skipped: ['frontendAssets:mismatch'] });
            expect(stderrLines).toHaveLength(1);
            expect(fs.existsSync(path.join(repo, 'dist', 'lib', 'lib.js'))).toBe(true);
            expect(fs.existsSync(path.join(repo, 'dist', 'frontend'))).toBe(false);
            expect(fs.existsSync(path.join(repo, 'dist', '.release-assets-head'))).toBe(false);
            expect(stampCalls).toEqual([]);
        });

        test('a helper module that lacks its functions counts as absent', async () => {
            const repo = createReleaseRepo('helpers-incomplete', '2.6.0');
            const baseUrl = await serveTarballs(makeTarballs({ libHash: 'f'.repeat(64), frontendHash: 'e'.repeat(64) }), []);

            const { result } = await seedWith(repo, baseUrl, { prebuiltLib: {}, frontendAssets: { computeFrontendInputsHash: 'nope' } });
            expect(result).toEqual({ ok: true, seeded: ['prebuiltLib', 'frontendAssets'], skipped: [] });
            expect(fs.readFileSync(path.join(repo, 'dist', '.release-assets-head'), 'utf8').trim()).toBe(git(repo, 'rev-parse', 'HEAD'));
        });

        const realHelpersPresent = fs.existsSync(path.join(repoRoot, 'src', 'prebuilt-lib.js'))
            && fs.readFileSync(path.join(repoRoot, 'src', 'frontend-assets.js'), 'utf8').includes('export function computeFrontendInputsHash');
        const describeWithRealHelpers = realHelpersPresent ? describe : describe.skip;

        describeWithRealHelpers('with the real helper modules next to the script', () => test('matching tarballs are accepted and the others refused', async () => {
            const prebuiltLib = await import('../src/prebuilt-lib.js');
            const frontendAssets = await import('../src/frontend-assets.js');
            const repo = createReleaseRepo('helpers-real', '2.6.0');
            const libJs = Buffer.from('export const bundled = true;\n');
            const buildTarballs = (libHash, frontendHash) => {
                const libTar = makeUstarArchive([
                    { name: 'dist/lib/lib.js', content: libJs },
                    {
                        name: 'dist/lib/lib.manifest.json',
                        content: JSON.stringify({
                            schemaVersion: 1,
                            cacheVersion: 'real',
                            inputsHash: libHash,
                            file: 'lib.js',
                            sha256: sha256Hex(libJs),
                            bundleBytes: libJs.length,
                            webpackVersion: '5.0.0',
                            builtWithNode: true,
                        }),
                    },
                ]);
                const frontendTar = makeUstarArchive([
                    { name: 'dist/frontend/asset-manifest.json', content: JSON.stringify({ schemaVersion: 2, inputsHash: frontendHash }) },
                ]);
                return {
                    libTar,
                    frontendTar,
                    sums: `${sha256Hex(libTar)}  sillybunny-prebuilt-lib.tar.gz\n${sha256Hex(frontendTar)}  sillybunny-frontend-assets.tar.gz\n`,
                };
            };

            const libHash = prebuiltLib.computePublicLibInputsHash({ rootDir: repo });
            const frontendHash = frontendAssets.computeFrontendInputsHash({ repoRoot: repo, publicRoot: path.join(repo, 'public') });
            const requestedUrls = [];
            const matching = buildTarballs(libHash, frontendHash);
            const baseUrl = await serveTarballs(matching, requestedUrls);

            // No `helpers` option: the seeder loads the modules that sit next to it.
            const first = await seedWith(repo, baseUrl, undefined);
            expect(first.stderrLines).toEqual([]);
            expect(first.result).toEqual({ ok: true, seeded: ['prebuiltLib', 'frontendAssets'], skipped: [] });
            expect(fs.readFileSync(path.join(repo, 'dist', '.release-assets-head'), 'utf8').trim()).toBe(git(repo, 'rev-parse', 'HEAD'));
            const inputsStamp = JSON.parse(fs.readFileSync(path.join(repo, 'dist', 'frontend', frontendAssets.FRONTEND_INPUTS_STAMP_FILE), 'utf8'));
            expect(inputsStamp.inputsHash).toBe(frontendHash);

            const requestsAfterFirstRun = requestedUrls.length;
            expect((await seedWith(repo, baseUrl, undefined)).result.skipped).toEqual(['already-fresh']);
            expect(requestedUrls).toHaveLength(requestsAfterFirstRun);

            await new Promise(resolve => server.close(resolve));
            server = null;
            const otherRepo = createReleaseRepo('helpers-real-mismatch', '2.6.1');
            const mismatching = buildTarballs('f'.repeat(64), 'e'.repeat(64));
            const mismatchUrl = await listen((req, res) => {
                const name = req.url.split('/').pop();
                const body = { SHA256SUMS: mismatching.sums, 'sillybunny-prebuilt-lib.tar.gz': mismatching.libTar, 'sillybunny-frontend-assets.tar.gz': mismatching.frontendTar }[name];
                res.writeHead(body === undefined ? 404 : 200);
                res.end(body);
            });
            const refused = await seedWith(otherRepo, mismatchUrl, undefined, { tag: 'v2.6.1' });
            expect(refused.result.seeded).toEqual([]);
            expect(refused.stderrLines).toHaveLength(2);
            expect(fs.existsSync(path.join(otherRepo, 'dist', 'lib'))).toBe(false);
            expect(fs.existsSync(path.join(otherRepo, 'dist', '.release-assets-head'))).toBe(false);
        }));
    });

    describe('updaters on a release checkout whose release has no tarballs', () => {
        // Modules with the contract of src/prebuilt-lib.js and src/frontend-assets.js, placed where the seeder imports them from.
        const FAKE_PREBUILT_LIB_MODULE = `import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
export function computePublicLibInputsHash({ rootDir }) {
    return crypto.createHash('sha256').update('lib:' + fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).digest('hex');
}
export function readPrebuiltPublicLibManifest(dir) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'lib.manifest.json'), 'utf8')); } catch { return null; }
}
`;
        const FAKE_FRONTEND_ASSETS_MODULE = `import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
export function computeFrontendInputsHash({ repoRoot }) {
    return crypto.createHash('sha256').update('frontend:' + fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).digest('hex');
}
export function writeFrontendInputsStamp(hash, { distRoot }) {
    fs.writeFileSync(path.join(distRoot, '.inputs-stamp.json'), JSON.stringify({ inputsHash: hash }));
    return true;
}
`;

        function createReleaseClone(name, version, { withHelperModules = false } = {}) {
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
            if (withHelperModules) {
                fs.mkdirSync(path.join(upstreamDir, 'src'), { recursive: true });
                fs.writeFileSync(path.join(upstreamDir, 'src', 'prebuilt-lib.js'), FAKE_PREBUILT_LIB_MODULE);
                fs.writeFileSync(path.join(upstreamDir, 'src', 'frontend-assets.js'), FAKE_FRONTEND_ASSETS_MODULE);
            }
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

        describe.each([['js'], ['sh']])('self-update.%s with helper modules in src/', (kind) => {
            const hashOf = (cloneDir, prefix) => sha256Hex(`${prefix}${fs.readFileSync(path.join(cloneDir, 'package.json'), 'utf8')}`);
            const tarballsFor = (libHash, frontendHash) => {
                const libTar = makeUstarArchive([
                    { name: 'dist/lib/lib.js', content: 'export const bundled = true;\n' },
                    { name: 'dist/lib/lib.manifest.json', content: JSON.stringify({ inputsHash: libHash }) },
                ]);
                const frontendTar = makeUstarArchive([
                    { name: 'dist/frontend/asset-manifest.json', content: JSON.stringify({ inputsHash: frontendHash }) },
                ]);
                return { libTar, frontendTar };
            };
            const serve = ({ libTar, frontendTar }) => listen((req, res) => {
                const body = {
                    SHA256SUMS: `${sha256Hex(libTar)}  sillybunny-prebuilt-lib.tar.gz\n${sha256Hex(frontendTar)}  sillybunny-frontend-assets.tar.gz\n`,
                    'sillybunny-prebuilt-lib.tar.gz': libTar,
                    'sillybunny-frontend-assets.tar.gz': frontendTar,
                }[req.url.split('/').pop()];
                res.writeHead(body === undefined ? 404 : 200);
                res.end(body);
            });

            test('installs and stamps tarballs that fit the checkout', async () => {
                const cloneDir = createReleaseClone(`release-clone-helpers-ok-${kind}`, '2.6.0', { withHelperModules: true });
                const baseUrl = await serve(tarballsFor(hashOf(cloneDir, 'lib:'), hashOf(cloneDir, 'frontend:')));

                const result = await runUpdater(kind, cloneDir, baseUrl);
                expect(result.status).toBe(0);
                expect(result.stderr).toBe('');
                expect(result.stdout).toContain('Seeded release asset sillybunny-prebuilt-lib.tar.gz (v2.6.0).');
                expect(result.stdout).toContain('Seeded release asset sillybunny-frontend-assets.tar.gz (v2.6.0).');
                expect(fs.existsSync(path.join(cloneDir, 'dist', 'lib', 'lib.js'))).toBe(true);
                expect(JSON.parse(fs.readFileSync(path.join(cloneDir, 'dist', 'frontend', '.inputs-stamp.json'), 'utf8')).inputsHash).toBe(hashOf(cloneDir, 'frontend:'));
                expect(fs.readFileSync(path.join(cloneDir, 'dist', '.release-assets-head'), 'utf8').trim()).toBe(git(cloneDir, 'rev-parse', 'HEAD'));
            });

            test('does not install tarballs that fail validation, says so, and lets the launch go on', async () => {
                const cloneDir = createReleaseClone(`release-clone-helpers-bad-${kind}`, '2.6.0', { withHelperModules: true });
                const baseUrl = await serve(tarballsFor('f'.repeat(64), 'e'.repeat(64)));

                const result = await runUpdater(kind, cloneDir, baseUrl);
                expect(result.status).toBe(0);
                expect(result.stdout).toContain('SillyBunny is already up to date.');
                expect(result.stdout).not.toContain('Seeded release asset');
                expect(result.stderr.trim().split('\n')).toEqual([
                    'Skipping release asset seed (v2.6.0): sillybunny-prebuilt-lib.tar.gz does not match this checkout and was not installed.',
                    'Skipping release asset seed (v2.6.0): sillybunny-frontend-assets.tar.gz does not match this checkout and was not installed.',
                ]);
                expect(fs.existsSync(path.join(cloneDir, 'dist', 'lib'))).toBe(false);
                expect(fs.existsSync(path.join(cloneDir, 'dist', 'frontend'))).toBe(false);
                expect(fs.existsSync(path.join(cloneDir, 'dist', '.release-assets-head'))).toBe(false);
            });
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
