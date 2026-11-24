import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildAndroidNodeModulesBundle,
    createDeterministicTar,
    DUP_ORT_WASMS,
    extractSafeTar,
    installAndroidNodeModulesBundle,
    MANIFEST_FILENAME,
    verifyAndroidNodeModulesBundle,
} from '../scripts/build-android-node-modules-bundle.mjs';
import { getPublicLibCacheInfo, getPublicLibInputsSignature } from '../webpack.config.js';
import getWebpackServeMiddleware from '../src/middleware/webpack-serve.js';
import {
    createPrebuiltLibManifest,
    PREBUILT_LIB_MANIFEST_FILENAME,
    tryReusePrebuiltPublicLib,
} from '../src/webpack-prebuilt-lib.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcherSource = fs.readFileSync(path.join(repoRoot, 'start.sh'), 'utf8');
const installerSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'bootstrap', 'install.sh'), 'utf8');
const dependencyStateSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'dependency-state.js'), 'utf8');
const bundleScriptSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-android-node-modules-bundle.mjs'), 'utf8');
const describePosix = process.platform === 'win32' ? describe.skip : describe;

function makeTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(targetPath, content = 'x', mode = 0o644) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, { mode });
    return targetPath;
}

function createSampleNodeModulesProject(rootDir) {
    writeFile(path.join(rootDir, 'package.json'), '{"name":"sillybunny","version":"1.0.0"}\n');
    writeFile(path.join(rootDir, 'package-lock.json'), '{"name":"sillybunny","lockfileVersion":3,"packages":{}}\n');

    const nm = path.join(rootDir, 'node_modules');
    writeFile(path.join(nm, 'express', 'package.json'), '{"name":"express","version":"4.21.0"}\n');
    writeFile(path.join(nm, 'express', 'index.js'), 'export default function express() {}\n');
    writeFile(path.join(nm, 'express', 'index.d.ts'), 'export default function express(): void;\n');
    writeFile(path.join(nm, 'express', 'index.js.map'), '{}');
    writeFile(path.join(nm, 'express', 'docs', 'readme.md'), '# docs');
    writeFile(path.join(nm, 'express', 'test', 'express.test.js'), 'test');
    writeFile(path.join(nm, 'nested-pkg', 'test', 'package.json'), '{"type":"commonjs"}\n');
    writeFile(path.join(nm, 'nested-pkg', 'package.json'), '{"name":"nested-pkg"}\n');

    // Locked Decision #1B: keep sillytavern-transformers + active WASMs bundled, prune duplicate onnxruntime-web WASMs.
    writeFile(path.join(nm, 'sillytavern-transformers', 'package.json'), '{"name":"sillytavern-transformers"}\n');
    writeFile(path.join(nm, 'sillytavern-transformers', 'dist', 'transformers.min.js'), 'export const pipeline = () => {};\n');
    writeFile(path.join(nm, 'onnxruntime-web', 'package.json'), '{"name":"onnxruntime-web"}\n');
    writeFile(path.join(nm, 'onnxruntime-web', 'dist', 'ort.min.js'), 'export const env = {};\n');
    for (const wasm of DUP_ORT_WASMS) {
        writeFile(path.join(nm, 'sillytavern-transformers', 'dist', wasm), `active-${wasm}`);
        writeFile(path.join(nm, 'onnxruntime-web', 'dist', wasm), `duplicate-${wasm}`);
    }

    // Long nested path > 100 chars to exercise PAX extended headers deterministically.
    const deepRel = '@sillybunny-very-long-scope-name/deep-runtime-subpackage-with-extended-tar-header-name/dist/nested/subpath/module-entry-point.js';
    writeFile(path.join(nm, deepRel), 'export const deep = 42;\n');
    writeFile(
        path.join(nm, '@sillybunny-very-long-scope-name/deep-runtime-subpackage-with-extended-tar-header-name/package.json'),
        '{"name":"@sillybunny-very-long-scope-name/deep-runtime-subpackage-with-extended-tar-header-name"}\n',
    );
    return { nm, deepRel };
}

describe('Android Wave 3: install.sh clone flags and baseline profile presence', () => {
    test('install.sh Android clone passes --no-tags while keeping --no-single-branch for branch switching', () => {
        expect(installerSource).toContain(
            'git -c advice.detachedHead=false clone --no-single-branch --no-tags --depth 1 --filter=blob:none --no-checkout --branch "$ref" -- "$repo" "$install_dir"',
        );
        // Desktop clone branch remains untouched.
        expect(installerSource).toContain(
            'git -c advice.detachedHead=false clone --filter=blob:none --branch "$ref" -- "$repo" "$install_dir"',
        );
    });

    test('baseline-prof.txt covers SillyBunny cold-start classes with valid HRF rules', () => {
        const profPath = path.join(repoRoot, 'android', 'app', 'src', 'main', 'baseline-prof.txt');
        const lines = fs.readFileSync(profPath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
        const ruleLines = lines.filter(l => !l.startsWith('#'));
        expect(ruleLines.length).toBeGreaterThan(30);

        const methodRules = ruleLines.filter(l => /^[HSP]+L/.test(l));
        const classRules = ruleLines.filter(l => !/^[HSP]+L/.test(l));
        expect(methodRules.length).toBeGreaterThan(15);
        expect(classRules.length).toBeGreaterThan(15);
        for (const line of methodRules) {
            expect(line).toContain('->');
        }
        for (const line of classRules) {
            expect(line.startsWith('L')).toBe(true);
            expect(line.endsWith(';')).toBe(true);
        }
        const joined = ruleLines.join('\n');
        for (const required of [
            'MainActivity',
            'ServerService',
            'ServerManager',
            'RuntimeLayout',
            'RuntimeLayoutInstaller',
            'InstallScriptLayout',
            'WebShell',
            'WebScreen',
            'StaticAssetInterceptor',
            'ProcessEnvironment',
            'SessionProcess',
            'AppUpdater',
        ]) {
            expect(joined).toContain(required);
        }
    });
});

describe('Android Wave 3: deterministic node_modules bundle packager and verifier', () => {
    const tempDirs = [];

    afterEach(() => {
        while (tempDirs.length > 0) {
            fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
        }
    });

    test('builds byte-identical pruned bundles keeping sillytavern-transformers active WASMs (#1B) and leaving source untouched', () => {
        const projectDir = makeTempDir('sb-wave3-bundle-src-');
        const out1 = makeTempDir('sb-wave3-bundle-out1-');
        const out2 = makeTempDir('sb-wave3-bundle-out2-');
        const installTarget = makeTempDir('sb-wave3-bundle-dst-');
        tempDirs.push(projectDir, out1, out2, installTarget);

        const { nm, deepRel } = createSampleNodeModulesProject(projectDir);

        const first = buildAndroidNodeModulesBundle({ projectDir, outputDir: out1 });
        const second = buildAndroidNodeModulesBundle({ projectDir, outputDir: out2 });

        // Source node_modules was not mutated in place.
        expect(fs.existsSync(path.join(nm, 'express', 'index.d.ts'))).toBe(true);
        expect(fs.existsSync(path.join(nm, 'onnxruntime-web', 'dist', DUP_ORT_WASMS[0]))).toBe(true);

        // Deterministic archive bytes and manifest.
        expect(first.manifest).toEqual(second.manifest);
        expect(fs.readFileSync(first.archivePath).equals(fs.readFileSync(second.archivePath))).toBe(true);
        expect(first.manifest).toMatchObject({
            schemaVersion: 1,
            nodeModuleVersion: String(process.versions.modules),
            arch: process.arch,
            platform: process.platform,
            archiveFile: 'node_modules.tar.gz',
        });

        // Verify and install into a clean checkout with matching package-lock.json.
        writeFile(path.join(installTarget, 'package-lock.json'), fs.readFileSync(path.join(projectDir, 'package-lock.json')));
        const verified = verifyAndroidNodeModulesBundle({
            bundleDir: out1,
            packageLockPath: path.join(installTarget, 'package-lock.json'),
            expectedNodeModuleVersion: process.versions.modules,
            expectedArch: process.arch,
            expectedPlatform: process.platform,
        });
        expect(verified.manifest.archiveSha256).toBe(first.manifest.archiveSha256);

        installAndroidNodeModulesBundle({ bundleDir: out1, projectDir: installTarget });
        const extractedNm = path.join(installTarget, 'node_modules');

        // Active sillytavern-transformers + WASMs + ort.min.js + all package.json preserved; dead files & dup WASMs pruned.
        expect(fs.existsSync(path.join(extractedNm, 'sillytavern-transformers', 'dist', 'transformers.min.js'))).toBe(true);
        expect(fs.existsSync(path.join(extractedNm, 'onnxruntime-web', 'dist', 'ort.min.js'))).toBe(true);
        for (const wasm of DUP_ORT_WASMS) {
            expect(fs.existsSync(path.join(extractedNm, 'sillytavern-transformers', 'dist', wasm))).toBe(true);
            expect(fs.existsSync(path.join(extractedNm, 'onnxruntime-web', 'dist', wasm))).toBe(false);
        }
        expect(fs.existsSync(path.join(extractedNm, 'express', 'package.json'))).toBe(true);
        expect(fs.existsSync(path.join(extractedNm, 'express', 'index.js'))).toBe(true);
        expect(fs.existsSync(path.join(extractedNm, 'nested-pkg', 'test', 'package.json'))).toBe(true);
        expect(fs.existsSync(path.join(extractedNm, deepRel))).toBe(true);
        expect(fs.existsSync(path.join(extractedNm, 'express', 'index.d.ts'))).toBe(false);
        expect(fs.existsSync(path.join(extractedNm, 'express', 'index.js.map'))).toBe(false);
        expect(fs.existsSync(path.join(extractedNm, 'express', 'docs'))).toBe(false);
        expect(fs.existsSync(path.join(extractedNm, 'express', 'test'))).toBe(false);
    });

    test('rejects lock mismatch, ABI mismatch, arch mismatch, corrupt archive sha256, and path traversal tar entries', () => {
        const projectDir = makeTempDir('sb-wave3-neg-src-');
        const bundleDir = makeTempDir('sb-wave3-neg-bundle-');
        tempDirs.push(projectDir, bundleDir);

        createSampleNodeModulesProject(projectDir);
        buildAndroidNodeModulesBundle({ projectDir, outputDir: bundleDir });
        const lockPath = path.join(projectDir, 'package-lock.json');

        // ABI mismatch
        expect(() => verifyAndroidNodeModulesBundle({
            bundleDir,
            packageLockPath: lockPath,
            expectedNodeModuleVersion: '999',
        })).toThrow(/Node ABI/);

        // Arch mismatch
        expect(() => verifyAndroidNodeModulesBundle({
            bundleDir,
            packageLockPath: lockPath,
            expectedArch: 'mips64',
        })).toThrow(/process\.arch/);

        // Lockfile mismatch
        const otherLock = path.join(projectDir, 'other-lock.json');
        writeFile(otherLock, '{"lockfileVersion":3,"changed":true}\n');
        expect(() => verifyAndroidNodeModulesBundle({
            bundleDir,
            packageLockPath: otherLock,
        })).toThrow(/package-lock\.json sha256/);

        // Corrupt archive bytes (keep size identical so SHA-256 check catches single-bit corruption)
        const archivePath = path.join(bundleDir, 'node_modules.tar.gz');
        const corrupted = Buffer.from(fs.readFileSync(archivePath));
        corrupted[corrupted.length - 1] ^= 0xff;
        fs.writeFileSync(archivePath, corrupted);
        expect(() => verifyAndroidNodeModulesBundle({
            bundleDir,
            packageLockPath: lockPath,
        })).toThrow(/Archive sha256/);

        // Path traversal tar header rejected by extractSafeTar
        const evilRoot = makeTempDir('sb-wave3-evil-');
        tempDirs.push(evilRoot);
        writeFile(path.join(evilRoot, 'ok.txt'), 'ok');
        const validTar = Buffer.from(createDeterministicTar(evilRoot));
        // Overwrite entry name with ../escape.txt and recompute header checksum
        validTar.fill(0, 0, 100);
        validTar.write('../escape.txt', 0, 'utf8');
        validTar.fill(0x20, 148, 156);
        let sum = 0;
        for (let i = 0; i < 512; i += 1) {
            sum += validTar[i];
        }
        validTar.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
        validTar[154] = 0;
        validTar[155] = 0x20;
        const extractDest = makeTempDir('sb-wave3-evil-dest-');
        tempDirs.push(extractDest);
        expect(() => extractSafeTar(validTar, extractDest)).toThrow(/Unsafe/);
    });
});

describe('Android Wave 3: manifest-verified prebuilt lib.js reuse and fallback (#2A)', () => {
    const tempDirs = [];
    const originalDataRoot = global.DATA_ROOT;
    const originalPrebuiltEnv = process.env.SILLYBUNNY_PREBUILT_LIB_DIR;

    afterEach(() => {
        global.DATA_ROOT = originalDataRoot;
        if (originalPrebuiltEnv === undefined) {
            delete process.env.SILLYBUNNY_PREBUILT_LIB_DIR;
        } else {
            process.env.SILLYBUNNY_PREBUILT_LIB_DIR = originalPrebuiltEnv;
        }
        while (tempDirs.length > 0) {
            fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
        }
    });

    test('stages verified prebuilt lib.js into _webpack/<cacheVersion>/output/lib.js without running Webpack', async () => {
        const dataRoot = makeTempDir('sb-wave3-dataroot-');
        const prebuiltDir = makeTempDir('sb-wave3-prebuilt-lib-');
        tempDirs.push(dataRoot, prebuiltDir);
        global.DATA_ROOT = dataRoot;
        process.env.SILLYBUNNY_PREBUILT_LIB_DIR = prebuiltDir;

        const libSourcePath = path.join(prebuiltDir, 'lib.js');
        const expectedBundleContent = 'export const prebuiltVendorBundle = true;\n';
        writeFile(libSourcePath, expectedBundleContent);

        const manifest = createPrebuiltLibManifest({ libFilePath: libSourcePath });
        writeFile(path.join(prebuiltDir, PREBUILT_LIB_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`);

        const cacheInfo = getPublicLibCacheInfo();
        expect(fs.existsSync(cacheInfo.outputFilePath)).toBe(false);

        const middleware = getWebpackServeMiddleware();
        await middleware.runWebpackCompiler();
        expect(fs.readFileSync(cacheInfo.outputFilePath, 'utf8')).toBe(expectedBundleContent);
    });

    test('falls back cleanly (returns false) when prebuilt lib.js manifest is missing, mismatched, or corrupted', () => {
        const dataRoot = makeTempDir('sb-wave3-dataroot-fallback-');
        const prebuiltDir = makeTempDir('sb-wave3-prebuilt-bad-');
        tempDirs.push(dataRoot, prebuiltDir);
        global.DATA_ROOT = dataRoot;
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        try {
            const cacheInfo = getPublicLibCacheInfo();

            // Case 1: absent directory -> silent false
            expect(tryReusePrebuiltPublicLib({ cacheInfo, prebuiltDir: path.join(prebuiltDir, 'missing') })).toBe(false);
            expect(warnSpy).not.toHaveBeenCalled();

            // Prepare valid baseline
            const libPath = path.join(prebuiltDir, 'lib.js');
            writeFile(libPath, 'export const bundle = 1;\n');
            const baseManifest = createPrebuiltLibManifest({ libFilePath: libPath });

            // Case 2: cacheVersion mismatch
            writeFile(
                path.join(prebuiltDir, PREBUILT_LIB_MANIFEST_FILENAME),
                JSON.stringify({ ...baseManifest, cacheVersion: '0000000000000000' }),
            );
            expect(tryReusePrebuiltPublicLib({ cacheInfo, prebuiltDir })).toBe(false);
            expect(fs.existsSync(cacheInfo.outputFilePath)).toBe(false);

            // Case 3: inputsHash mismatch
            writeFile(
                path.join(prebuiltDir, PREBUILT_LIB_MANIFEST_FILENAME),
                JSON.stringify({ ...baseManifest, inputsHash: 'f'.repeat(64) }),
            );
            expect(tryReusePrebuiltPublicLib({ cacheInfo, prebuiltDir })).toBe(false);
            expect(fs.existsSync(cacheInfo.outputFilePath)).toBe(false);

            // Case 4: sha256 mismatch (tampered lib.js)
            writeFile(path.join(prebuiltDir, PREBUILT_LIB_MANIFEST_FILENAME), JSON.stringify(baseManifest));
            writeFile(libPath, 'export const bundle = 2;\n');
            expect(tryReusePrebuiltPublicLib({ cacheInfo, prebuiltDir })).toBe(false);
            expect(fs.existsSync(cacheInfo.outputFilePath)).toBe(false);

            // Confirm getPublicLibInputsSignature is deterministic 64-hex sha256
            expect(getPublicLibInputsSignature()).toMatch(/^[0-9a-f]{64}$/);
        } finally {
            warnSpy.mockRestore();
        }
    });
});

describePosix('Android Wave 3: start.sh prebuilt node_modules bundle integration and npm fallback', () => {
    const tempDirs = [];

    afterEach(() => {
        while (tempDirs.length > 0) {
            fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
        }
    });

    function setupFakeAndroidCheckout() {
        const root = makeTempDir('sb-wave3-launcher-');
        tempDirs.push(root);
        const repoDir = path.join(root, 'checkout');
        const binDir = path.join(root, 'bin');
        const homeDir = path.join(root, 'home');
        const bundleDir = path.join(root, 'bundle');
        const callsFile = path.join(root, 'calls.log');

        fs.mkdirSync(binDir, { recursive: true });
        fs.mkdirSync(homeDir, { recursive: true });
        fs.mkdirSync(path.join(repoDir, 'scripts'), { recursive: true });
        fs.mkdirSync(path.join(repoDir, 'default'), { recursive: true });

        // Build a real sample bundle from a seed project first.
        const seedDir = path.join(root, 'seed');
        createSampleNodeModulesProject(seedDir);
        buildAndroidNodeModulesBundle({ projectDir: seedDir, outputDir: bundleDir });

        writeFile(path.join(repoDir, 'start.sh'), launcherSource, 0o755);
        writeFile(path.join(repoDir, 'package.json'), fs.readFileSync(path.join(seedDir, 'package.json')));
        writeFile(path.join(repoDir, 'package-lock.json'), fs.readFileSync(path.join(seedDir, 'package-lock.json')));
        writeFile(path.join(repoDir, 'default', 'config.yaml'), 'port: 8000\n');
        writeFile(path.join(repoDir, 'config.yaml'), 'port: 8000\n');
        writeFile(path.join(repoDir, 'scripts', 'install-prerequisites.sh'), '#!/usr/bin/env bash\nexit 0\n', 0o755);
        writeFile(path.join(repoDir, 'scripts', 'dependency-state.js'), dependencyStateSource);
        writeFile(path.join(repoDir, 'scripts', 'build-android-node-modules-bundle.mjs'), bundleScriptSource, 0o755);
        writeFile(path.join(repoDir, 'server.js'), 'process.exit(0);\n');

        // Wrap real node to record server/script calls while executing dependency-state & bundle installer genuinely.
        writeFile(
            path.join(binDir, 'node'),
            `#!/usr/bin/env bash\nprintf 'node: %s\\n' "$*" >> "$TEST_CALLS"\nexec "${process.execPath}" "$@"\n`,
            0o755,
        );
        // Fake npm records `ci` vs `run init` calls and creates a fallback marker when `npm ci` runs.
        writeFile(
            path.join(binDir, 'npm'),
            [
                '#!/usr/bin/env bash',
                'printf \'npm: %s\\n\' "$*" >> "$TEST_CALLS"',
                'if [[ "${1:-}" == "ci" ]]; then',
                '    mkdir -p node_modules/fallback-installed',
                '    printf \'{"name":"fallback-installed"}\\n\' > node_modules/fallback-installed/package.json',
                'fi',
                '',
            ].join('\n'),
            0o755,
        );

        return { repoDir, binDir, homeDir, bundleDir, callsFile };
    }

    function runLauncher({ repoDir, binDir, homeDir, bundleDir, callsFile }, extraEnv = {}) {
        const env = { ...process.env };
        for (const key of Object.keys(env)) {
            if (key.startsWith('SILLYBUNNY_') || ['TERMUX_VERSION', 'PREFIX', 'BASH_ENV', 'ENV'].includes(key)) {
                delete env[key];
            }
        }
        Object.assign(env, {
            PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
            HOME: homeDir,
            SILLYBUNNY_ANDROID_APP: '1',
            SILLYBUNNY_ANDROID_NODE_MODULES_BUNDLE_DIR: bundleDir,
            TEST_CALLS: callsFile,
            ...extraEnv,
        });
        return spawnSync('bash', [path.join(repoDir, 'start.sh'), '--skip-self-update'], {
            cwd: repoDir,
            env,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }

    test('uses matching prebuilt Android node_modules bundle and skips npm ci completely', () => {
        const ctx = setupFakeAndroidCheckout();
        const result = runLauncher(ctx);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Installed prebuilt Android node_modules bundle.');
        const calls = fs.readFileSync(ctx.callsFile, 'utf8');
        expect(calls).not.toContain('npm: ci');
        expect(calls).toContain('npm: run init');
        expect(fs.existsSync(path.join(ctx.repoDir, 'node_modules', 'sillytavern-transformers', 'dist', DUP_ORT_WASMS[0]))).toBe(true);
        expect(fs.existsSync(path.join(ctx.repoDir, 'node_modules', '.sillybunny-dependencies.json'))).toBe(true);
    });

    test('falls back transparently to npm ci when prebuilt bundle lockfile or archive sha256 mismatches', () => {
        const ctx = setupFakeAndroidCheckout();
        // Corrupt archive sha256 in manifest to trigger verification failure -> npm ci fallback.
        const manifestPath = path.join(ctx.bundleDir, MANIFEST_FILENAME);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.archiveSha256 = crypto.createHash('sha256').update('tampered').digest('hex');
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

        const result = runLauncher(ctx);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Prebuilt Android node_modules bundle unavailable or mismatched; falling back to npm...');
        const calls = fs.readFileSync(ctx.callsFile, 'utf8');
        expect(calls).toContain('npm: ci --no-audit --no-fund --omit=dev');
        expect(fs.existsSync(path.join(ctx.repoDir, 'node_modules', 'fallback-installed', 'package.json'))).toBe(true);
    });

    test('ignores prebuilt Android node_modules bundle when SILLYBUNNY_ANDROID_APP is not 1', () => {
        const ctx = setupFakeAndroidCheckout();
        const result = runLauncher(ctx, {
            SILLYBUNNY_ANDROID_APP: '0',
            SILLYBUNNY_USE_NODE: '1',
        });

        expect(result.status).toBe(0);
        expect(result.stdout).not.toContain('Installed prebuilt Android node_modules bundle.');
        const calls = fs.readFileSync(ctx.callsFile, 'utf8');
        expect(calls).toContain('npm: ci --no-audit --no-fund --omit=dev');
    });
});
