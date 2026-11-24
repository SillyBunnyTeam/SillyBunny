import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import getPublicLibConfig, {
    buildPublicLibMinimizer,
    getPublicLibCacheInfo,
    invalidatePublicLibCacheInfo,
    resolveTerserPluginPath,
} from '../webpack.config.js';
import getWebpackServeMiddleware from '../src/middleware/webpack-serve.js';
import {
    MemoryLimitedMap,
    enableNodeCompileCache,
    flushNodeCompileCache,
    getConfigValue,
    getVersion,
    invalidateFirefoxCache,
    invalidateVersionCache,
    setConfigFilePath,
} from '../src/util.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultConfigPath = path.join(repoRoot, 'default', 'config.yaml');
const originalDataRoot = global.DATA_ROOT;

setConfigFilePath(defaultConfigPath);

afterEach(() => {
    jest.restoreAllMocks();
    global.DATA_ROOT = originalDataRoot;
    invalidatePublicLibCacheInfo();
    invalidateVersionCache();
    setConfigFilePath(defaultConfigPath);
});

afterAll(() => {
    global.DATA_ROOT = originalDataRoot;
    setConfigFilePath(defaultConfigPath);
});

describe('lazy webpack configuration and middleware', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-perf-webpack-'));
        global.DATA_ROOT = tempDir;
        invalidatePublicLibCacheInfo();
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('importing webpack.config.js and webpack-serve.js does not eagerly load webpack', () => {
        const script = [
            `globalThis.DATA_ROOT = ${JSON.stringify(tempDir)};`,
            `await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'webpack.config.js')).href)});`,
            `await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'src', 'middleware', 'webpack-serve.js')).href)});`,
            'const loaded = process.moduleLoadList.filter(entry => entry.includes("webpack"));',
            'console.log(JSON.stringify({ loaded }));',
        ].join('\n');

        const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: repoRoot,
            encoding: 'utf8',
        }).trim();
        const parsed = JSON.parse(raw.split(/\r?\n/).pop());
        expect(parsed.loaded).toEqual([]);
    });

    test('memoizes getPublicLibCacheInfo per process without re-hashing lockfiles', () => {
        const first = getPublicLibCacheInfo();
        const readSpy = jest.spyOn(fs, 'readFileSync');

        const second = getPublicLibCacheInfo();
        const third = getPublicLibCacheInfo();

        expect(second).toEqual(first);
        expect(third).toEqual(first);
        expect(readSpy).not.toHaveBeenCalled();

        const alternateRoot = path.join(tempDir, 'alt-data');
        global.DATA_ROOT = alternateRoot;
        const relocated = getPublicLibCacheInfo();
        expect(relocated.webpackRoot).toBe(path.resolve(alternateRoot, '_webpack'));
        expect(relocated.cacheVersion).toBe(first.cacheVersion);
        expect(readSpy).not.toHaveBeenCalled();
    });

    test('disables filesystem pack cache and caps Terser parallelism with Android override', () => {
        const previousAndroid = process.env.SILLYBUNNY_ANDROID_APP;
        try {
            delete process.env.SILLYBUNNY_ANDROID_APP;
            const desktopConfig = getPublicLibConfig();
            expect(desktopConfig.cache).toBe(false);
            expect(desktopConfig.optimization.minimize).toBe(true);
            expect(desktopConfig.optimization.minimizer).toHaveLength(1);

            const capturedOptions = [];
            let appliedPluginInstance = null;
            const originalTap = desktopConfig.optimization.minimizer[0].apply;
            expect(typeof originalTap).toBe('function');

            process.env.SILLYBUNNY_ANDROID_APP = '1';
            const androidConfig = getPublicLibConfig();
            expect(androidConfig.optimization.minimizer).toHaveLength(1);

            const makeMockCompiler = () => ({
                options: {},
                hooks: {
                    compilation: {
                        tap: (name, fn) => {
                            appliedPluginInstance = name;
                            capturedOptions.push(fn);
                        },
                    },
                },
                webpack: {
                    javascript: { JavascriptModulesPlugin: { getCompilationHooks: () => ({ chunkHash: { tap: () => {} } }) } },
                    Compilation: { PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE: 400 },
                    util: { MinimizerModuleConcatenationPlugin: class {} },
                },
            });
            desktopConfig.optimization.minimizer[0].apply(makeMockCompiler());
            expect(appliedPluginInstance).toBe('TerserPlugin');
            expect(capturedOptions).toHaveLength(1);
        } finally {
            if (previousAndroid === undefined) {
                delete process.env.SILLYBUNNY_ANDROID_APP;
            } else {
                process.env.SILLYBUNNY_ANDROID_APP = previousAndroid;
            }
        }
    });

    test('resolves nested or isolated terser-webpack-plugin from webpack and falls back to default minimizer when absent', async () => {
        const { createRequire } = await import('node:module');

        const nestedRoot = path.join(tempDir, 'nested-layout');
        const nestedWebpackDir = path.join(nestedRoot, 'node_modules', 'webpack');
        const nestedTerserDir = path.join(nestedWebpackDir, 'node_modules', 'terser-webpack-plugin');
        fs.mkdirSync(nestedTerserDir, { recursive: true });
        fs.writeFileSync(path.join(nestedRoot, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }), 'utf8');
        fs.writeFileSync(path.join(nestedWebpackDir, 'package.json'), JSON.stringify({ name: 'webpack', version: '5.105.4' }), 'utf8');
        fs.writeFileSync(path.join(nestedTerserDir, 'package.json'), JSON.stringify({ name: 'terser-webpack-plugin', version: '5.3.17', main: 'index.js' }), 'utf8');
        fs.writeFileSync(path.join(nestedTerserDir, 'index.js'), 'module.exports = class NestedTerserPlugin { constructor(opts) { this.opts = opts; } apply(c) { c.applied = this.opts; } };\n', 'utf8');

        const nestedRequire = createRequire(path.join(nestedRoot, 'package.json'));
        const resolvedNested = resolveTerserPluginPath({
            baseRequire: nestedRequire,
            fallbackWebpackPkgPath: null,
        });
        expect(fs.realpathSync.native(resolvedNested)).toBe(fs.realpathSync.native(path.join(nestedTerserDir, 'index.js')));

        const minimizer = buildPublicLibMinimizer({
            env: { SILLYBUNNY_ANDROID_APP: '1' },
            resolvePluginPath: () => resolvedNested,
        });
        const stubCompiler = {};
        minimizer[0].apply(stubCompiler);
        expect(stubCompiler.applied).toEqual({
            parallel: false,
            terserOptions: { compress: { passes: 2 } },
        });

        const isolatedRoot = path.join(tempDir, 'isolated-layout');
        const storeNodeModules = path.join(isolatedRoot, 'node_modules', '.bun', 'webpack@5.105.4', 'node_modules');
        const storeWebpackDir = path.join(storeNodeModules, 'webpack');
        const storeTerserDir = path.join(storeNodeModules, 'terser-webpack-plugin');
        fs.mkdirSync(storeWebpackDir, { recursive: true });
        fs.mkdirSync(storeTerserDir, { recursive: true });
        fs.writeFileSync(path.join(isolatedRoot, 'package.json'), JSON.stringify({ name: 'isolated-fixture', version: '1.0.0' }), 'utf8');
        fs.writeFileSync(path.join(storeWebpackDir, 'package.json'), JSON.stringify({ name: 'webpack', version: '5.105.4' }), 'utf8');
        fs.writeFileSync(path.join(storeTerserDir, 'package.json'), JSON.stringify({ name: 'terser-webpack-plugin', version: '5.3.17', main: 'index.js' }), 'utf8');
        fs.writeFileSync(path.join(storeTerserDir, 'index.js'), 'module.exports = class IsolatedTerserPlugin {};\n', 'utf8');
        const symlinkWebpackDir = path.join(isolatedRoot, 'node_modules', 'webpack');
        fs.symlinkSync(storeWebpackDir, symlinkWebpackDir, process.platform === 'win32' ? 'junction' : 'dir');

        const isolatedRequire = createRequire(path.join(isolatedRoot, 'package.json'));
        const resolvedIsolated = resolveTerserPluginPath({
            baseRequire: isolatedRequire,
            fallbackWebpackPkgPath: path.join(symlinkWebpackDir, 'package.json'),
        });
        expect(fs.realpathSync.native(resolvedIsolated)).toBe(fs.realpathSync.native(path.join(storeTerserDir, 'index.js')));

        const emptyRoot = path.join(tempDir, 'empty-layout');
        fs.mkdirSync(emptyRoot, { recursive: true });
        fs.writeFileSync(path.join(emptyRoot, 'package.json'), JSON.stringify({ name: 'empty-fixture', version: '1.0.0' }), 'utf8');
        const emptyRequire = createRequire(path.join(emptyRoot, 'package.json'));

        const missingPath = resolveTerserPluginPath({
            baseRequire: emptyRequire,
            fallbackWebpackPkgPath: null,
        });
        expect(missingPath).toBeNull();
        expect(buildPublicLibMinimizer({ resolvePluginPath: () => missingPath })).toEqual(['...']);
        expect(buildPublicLibMinimizer({
            resolvePluginPath: () => { throw new Error('MODULE_NOT_FOUND'); },
        })).toEqual(['...']);
    });

    test('strips unused moment locales while keeping supported UI locales from lang.json', async () => {
        const { default: webpack } = await import('webpack');
        const entryFile = path.join(tempDir, 'moment-entry.js');
        const outDir = path.join(tempDir, 'moment-out');
        fs.writeFileSync(entryFile, 'import moment from \'moment\';\nexport { moment };\n', 'utf8');

        const baseConfig = getPublicLibConfig({ outputPath: outDir });
        const compiler = webpack({
            ...baseConfig,
            entry: entryFile,
            resolve: {
                ...baseConfig.resolve,
                modules: [path.join(repoRoot, 'node_modules'), 'node_modules'],
            },
        });

        await new Promise((resolve, reject) => {
            compiler.run((err, stats) => {
                compiler.close((closeErr) => {
                    if (err || closeErr) {
                        reject(err || closeErr);
                        return;
                    }
                    if (stats?.hasErrors()) {
                        reject(new Error(stats.toString()));
                        return;
                    }
                    resolve();
                });
            });
        });

        const bundle = fs.readFileSync(path.join(outDir, 'lib.js'), 'utf8');
        expect(bundle).toContain('月曜日');
        expect(bundle).not.toContain('wa’leS');
    }, 20_000);

    test('webpack-serve fast-paths non-lib.js requests and reuses precompiled lib.js without compiling', async () => {
        const cacheInfo = getPublicLibCacheInfo();
        fs.mkdirSync(cacheInfo.outputDirectory, { recursive: true });
        fs.writeFileSync(cacheInfo.outputFilePath, 'export const ready = true;\n', 'utf8');

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        const middleware = getWebpackServeMiddleware();

        await middleware.runWebpackCompiler();
        expect(logSpy).toHaveBeenCalledWith('Reusing precompiled frontend libraries...');

        const parseSpy = jest.spyOn(path, 'parse');
        let nextCalls = 0;
        const next = () => { nextCalls += 1; };

        middleware({ method: 'GET', path: '/style.css' }, {}, next);
        middleware({ method: 'POST', path: '/lib.js' }, {}, next);
        middleware({ method: 'GET', path: '/nested/lib.js' }, {}, next);

        expect(nextCalls).toBe(3);
        expect(parseSpy).not.toHaveBeenCalled();

        let sentRoot = null;
        let sentFile = null;
        const headers = new Map();
        middleware(
            { method: 'GET', path: '/lib.js' },
            {
                setHeader: (k, v) => headers.set(k, v),
                sendFile: (file, opts) => {
                    sentFile = file;
                    sentRoot = opts.root;
                },
            },
            next,
        );

        expect(headers.get('Cache-Control')).toBe('no-cache');
        expect(sentFile).toBe('lib.js');
        expect(sentRoot).toBe(cacheInfo.outputDirectory);
    });
});

describe('memoized getVersion and util hotfixes', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-perf-version-'));
        invalidateVersionCache();
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('uses at most 2 git calls on cache miss and preserves exact return schema', async () => {
        fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ version: '2.0.0-test' }), 'utf8');
        fs.mkdirSync(path.join(tempDir, '.git', 'refs', 'heads'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, '.git', 'HEAD'), 'ref: refs/heads/staging\n', 'utf8');
        fs.writeFileSync(path.join(tempDir, '.git', 'refs', 'heads', 'staging'), 'abcdef1234567890abcdef1234567890abcdef12\n', 'utf8');

        const calls = [];
        const execGit = async (_dir, args) => {
            calls.push(args);
            if (args[0] === 'show') {
                return 'abcdef123\n2026-11-24 10:00:00 +0000\nabcdef1234567890abcdef1234567890abcdef12\n';
            }
            if (args[0] === 'rev-parse' && args[1] === '@{u}') {
                return '1111111111111111111111111111111111111111\n';
            }
            throw new Error(`Unexpected git args: ${args.join(' ')}`);
        };

        const version = await getVersion({ baseDir: tempDir, execGit });
        expect(calls.length).toBeLessThanOrEqual(2);
        expect(version).toEqual({
            agent: 'SillyBunny:2.0.0-test:fork',
            pkgVersion: '2.0.0-test',
            gitRevision: 'abcdef123',
            gitBranch: 'staging',
            commitDate: '2026-11-24 10:00:00 +0000',
            isLatest: false,
        });
    });

    test('keeps branch and revision with isLatest=true when no upstream branch is configured', async () => {
        fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ version: '2.0.0-local' }), 'utf8');
        fs.mkdirSync(path.join(tempDir, '.git', 'refs', 'heads'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, '.git', 'HEAD'), 'ref: refs/heads/feature/offline\n', 'utf8');

        const execGit = async (_dir, args) => {
            if (args[0] === 'show') {
                return 'deadbeef0\n2026-11-24 11:00:00 +0000\ndeadbeef00000000000000000000000000000000\n';
            }
            throw new Error('fatal: no upstream configured');
        };

        const version = await getVersion({ baseDir: tempDir, execGit });
        expect(version).toEqual({
            agent: 'SillyBunny:2.0.0-local:fork',
            pkgVersion: '2.0.0-local',
            gitRevision: 'deadbeef0',
            gitBranch: 'feature/offline',
            commitDate: '2026-11-24 11:00:00 +0000',
            isLatest: true,
        });
    });

    test('gracefully returns null git fields when git spawn fails with ENOENT', async () => {
        fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ version: '2.0.0-nogit' }), 'utf8');
        fs.mkdirSync(path.join(tempDir, '.git'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, '.git', 'HEAD'), 'ref: refs/heads/staging\n', 'utf8');

        const execGit = async () => {
            const err = new Error('spawn git ENOENT');
            err.code = 'ENOENT';
            throw err;
        };

        const version = await getVersion({ baseDir: tempDir, execGit });
        expect(version).toEqual({
            agent: 'SillyBunny:2.0.0-nogit:fork',
            pkgVersion: '2.0.0-nogit',
            gitRevision: null,
            gitBranch: null,
            commitDate: null,
            isLatest: true,
        });
    });

    test('memoizes real git getVersion(), coalesces concurrent calls, and invalidates on ref changes', async () => {
        execFileSync('git', ['init', '-b', 'main'], { cwd: tempDir, stdio: 'ignore' });
        execFileSync('git', ['config', 'user.email', 'test@users.noreply.github.com'], { cwd: tempDir, stdio: 'ignore' });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir, stdio: 'ignore' });
        fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ version: '2.0.0-repo' }), 'utf8');
        execFileSync('git', ['add', 'package.json'], { cwd: tempDir, stdio: 'ignore' });
        execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir, stdio: 'ignore' });

        const [first, concurrent] = await Promise.all([
            getVersion({ baseDir: tempDir }),
            getVersion({ baseDir: tempDir }),
        ]);
        expect(first.gitBranch).toBe('main');
        expect(first.gitRevision).toBeTruthy();
        expect(concurrent).toEqual(first);

        const t0 = performance.now();
        const cached = await getVersion({ baseDir: tempDir });
        const elapsedMs = performance.now() - t0;
        expect(cached).toEqual(first);
        expect(elapsedMs).toBeLessThan(15);

        fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ version: '2.0.1-repo' }), 'utf8');
        execFileSync('git', ['add', 'package.json'], { cwd: tempDir, stdio: 'ignore' });
        execFileSync('git', ['commit', '-m', 'bump'], { cwd: tempDir, stdio: 'ignore' });

        const updated = await getVersion({ baseDir: tempDir });
        expect(updated.pkgVersion).toBe('2.0.1-repo');
        expect(updated.gitRevision).not.toBe(first.gitRevision);
    });

    test('reloads cached config.yaml automatically when file mtime or size changes', () => {
        const cfgPath = path.join(tempDir, 'config.yaml');
        fs.writeFileSync(cfgPath, 'port: 8123\n', 'utf8');
        jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            setConfigFilePath(cfgPath);

            expect(getConfigValue('port', 8000, 'number')).toBe(8123);

            const readSpy = jest.spyOn(fs, 'readFileSync');
            expect(getConfigValue('port', 8000, 'number')).toBe(8123);
            expect(readSpy).not.toHaveBeenCalled();

            fs.writeFileSync(cfgPath, 'port: 9456\nextraFlag: true\n', 'utf8');
            const bumpedTime = new Date(Date.now() + 5_000);
            fs.utimesSync(cfgPath, bumpedTime, bumpedTime);

            expect(getConfigValue('port', 8000, 'number')).toBe(9456);
            expect(getConfigValue('extraFlag', false, 'boolean')).toBe(true);
        } finally {
            setConfigFilePath(defaultConfigPath);
        }
    });

    test('invalidateFirefoxCache sets Cache-Control: no-cache only for Firefox image responses', () => {
        const firefoxHeaders = new Map();
        invalidateFirefoxCache(
            'avatar.png',
            { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; rv:135.0) Gecko/20100101 Firefox/135.0' } },
            { setHeader: (k, v) => firefoxHeaders.set(k, v) },
        );
        expect(firefoxHeaders.get('Cache-Control')).toBe('no-cache');

        const chromeHeaders = new Map();
        invalidateFirefoxCache(
            'avatar.png',
            { headers: { 'user-agent': 'Mozilla/5.0 Chrome/135.0.0.0 Safari/537.36' } },
            { setHeader: (k, v) => chromeHeaders.set(k, v) },
        );
        expect(chromeHeaders.has('Cache-Control')).toBe(false);
    });
});

describe('MemoryLimitedMap O(1) LRU eviction', () => {
    test('promotes accessed keys on get() so least-recently-used entries evict first', () => {
        const map = new MemoryLimitedMap('20B');
        map.set('a', '12345');
        map.set('b', '67890');

        expect(map.get('a')).toBe('12345');

        map.set('c', 'abcde');
        expect(map.has('a')).toBe(true);
        expect(map.has('b')).toBe(false);
        expect(map.has('c')).toBe(true);
        expect(map.totalMemory()).toBe(20);
    });

    test('sustains O(1) throughput across thousands of updates and evictions', () => {
        const map = new MemoryLimitedMap('4 KB');
        const start = performance.now();
        for (let i = 0; i < 5_000; i++) {
            const key = `card-${i % 400}`;
            map.set(key, 'x'.repeat(16));
            if (i % 3 === 0) {
                map.get(key);
            }
        }
        const elapsedMs = performance.now() - start;
        expect(elapsedMs).toBeLessThan(200);
        expect(map.totalMemory()).toBeLessThanOrEqual(4096);
    });
});

describe('Node V8 compile cache and launcher hygiene', () => {
    test('enableNodeCompileCache and flushNodeCompileCache honor env, fallback path, Bun guard, and read-only errors', () => {
        const calls = [];
        const mockModule = {
            enableCompileCache: (dir) => { calls.push(['enable', dir]); },
            flushCompileCache: () => { calls.push(['flush']); },
        };

        const defaultDir = enableNodeCompileCache({
            moduleApi: mockModule,
            env: {},
            versions: { node: '24.0.0' },
            repoDir: '/opt/sillybunny',
        });
        expect(defaultDir).toBe(path.join('/opt/sillybunny', 'node_modules', '.cache', 'sillybunny-v8'));

        const customDir = enableNodeCompileCache({
            moduleApi: mockModule,
            env: { NODE_COMPILE_CACHE: '/tmp/custom-v8' },
            versions: { node: '24.0.0' },
            repoDir: '/opt/sillybunny',
        });
        expect(customDir).toBe('/tmp/custom-v8');

        expect(enableNodeCompileCache({
            moduleApi: mockModule,
            env: {},
            versions: { node: '24.0.0', bun: '1.4.4' },
            repoDir: '/opt/sillybunny',
        })).toBeNull();
        expect(flushNodeCompileCache({
            moduleApi: mockModule,
            versions: { node: '24.0.0', bun: '1.4.4' },
        })).toBe(false);

        expect(flushNodeCompileCache({
            moduleApi: mockModule,
            versions: { node: '24.0.0' },
        })).toBe(true);

        expect(calls).toEqual([
            ['enable', path.join('/opt/sillybunny', 'node_modules', '.cache', 'sillybunny-v8')],
            ['enable', '/tmp/custom-v8'],
            ['flush'],
        ]);

        const throwingModule = {
            enableCompileCache: () => { throw Object.assign(new Error('EROFS'), { code: 'EROFS' }); },
            flushCompileCache: () => { throw Object.assign(new Error('EROFS'), { code: 'EROFS' }); },
        };
        expect(enableNodeCompileCache({ moduleApi: throwingModule, env: {}, versions: { node: '24.0.0' } })).toBeNull();
        expect(flushNodeCompileCache({ moduleApi: throwingModule, versions: { node: '24.0.0' } })).toBe(false);
    });

    test('launchers, server.js, and server-main.js wire V8 compile cache and HTTP keep-alive hygiene safely', () => {
        const serverSource = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
        const serverMainSource = fs.readFileSync(path.join(repoRoot, 'src', 'server-main.js'), 'utf8');
        const startShSource = fs.readFileSync(path.join(repoRoot, 'start.sh'), 'utf8');
        const startBatSource = fs.readFileSync(path.join(repoRoot, 'Start.bat'), 'utf8');

        expect(serverSource.startsWith('#!/usr/bin/env bun')).toBe(true);
        expect(serverSource.indexOf('enableCompileCache')).toBeGreaterThan(0);
        expect(serverSource.indexOf('enableCompileCache')).toBeLessThan(serverSource.indexOf('server-supervisor.js'));

        expect(serverMainSource).toContain('keepAliveTimeout = 65_000');
        expect(serverMainSource).toContain('headersTimeout = 66_000');
        expect(serverMainSource).toContain('flushNodeCompileCache()');
        expect(serverMainSource).toContain('cachedShouldServeFrontendAssets = null');

        expect(startShSource).toContain('NODE_COMPILE_CACHE="$SCRIPT_DIR/node_modules/.cache/sillybunny-v8"');
        expect(startShSource).not.toMatch(/\bexec\s+"\$RUNTIME_CMD"/);
        expect(startBatSource).toContain('if not defined NODE_COMPILE_CACHE set "NODE_COMPILE_CACHE=%~dp0node_modules\\.cache\\sillybunny-v8"');
    });
});
