import { afterEach, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(repoRoot, 'scripts', 'dependency-state.js');

const tempDirs = [];

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 4)}\n`);
}

function createFixture({
    expressDeps = { send: '~0.19.0', 'serve-static': '~1.16.2' },
    sendDeps = { mime: '1.6.0' },
    topMimeVersion = '3.0.0',
    nestedSendMimeVersion = '1.6.0',
    serveStaticDeps = { send: '~0.19.1' },
    nestedServeStaticSendDeps = null,
    nestedServeStaticSendMimeVersion = null,
    includeExpress = true,
    includeSend = true,
    includeServeStatic = true,
    includeEslint = false,
    eslintAjvRange = '^6.12.4',
    topAjvVersion = '6.15.0',
    nestedEslintAjvVersion = null,
} = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dep-state-'));
    tempDirs.push(dir);

    writeJson(path.join(dir, 'package.json'), { name: 'fixture', version: '1.0.0' });
    fs.writeFileSync(path.join(dir, 'bun.lock'), '{ "lockfileVersion": 1 }\n');
    writeJson(path.join(dir, 'package-lock.json'), { name: 'fixture', lockfileVersion: 3 });
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'port: 4444\n');
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });

    if (includeExpress) {
        writeJson(path.join(dir, 'node_modules', 'express', 'package.json'), {
            name: 'express',
            version: '4.22.3',
            dependencies: expressDeps,
        });
    }

    if (includeSend) {
        writeJson(path.join(dir, 'node_modules', 'send', 'package.json'), {
            name: 'send',
            version: '0.19.2',
            dependencies: sendDeps,
        });
    }

    if (includeServeStatic) {
        writeJson(path.join(dir, 'node_modules', 'serve-static', 'package.json'), {
            name: 'serve-static',
            version: '1.16.3',
            dependencies: serveStaticDeps,
        });
    }

    if (topMimeVersion) {
        writeJson(path.join(dir, 'node_modules', 'mime', 'package.json'), {
            name: 'mime',
            version: topMimeVersion,
        });
    }

    if (nestedSendMimeVersion) {
        writeJson(path.join(dir, 'node_modules', 'send', 'node_modules', 'mime', 'package.json'), {
            name: 'mime',
            version: nestedSendMimeVersion,
        });
    }

    if (nestedServeStaticSendDeps) {
        writeJson(path.join(dir, 'node_modules', 'serve-static', 'node_modules', 'send', 'package.json'), {
            name: 'send',
            version: '0.19.2',
            dependencies: nestedServeStaticSendDeps,
        });
    }

    if (nestedServeStaticSendMimeVersion) {
        writeJson(
            path.join(dir, 'node_modules', 'serve-static', 'node_modules', 'send', 'node_modules', 'mime', 'package.json'),
            {
                name: 'mime',
                version: nestedServeStaticSendMimeVersion,
            },
        );
    }

    if (includeEslint) {
        writeJson(path.join(dir, 'node_modules', '@eslint', 'eslintrc', 'package.json'), {
            name: '@eslint/eslintrc',
            version: '2.1.4',
            dependencies: { ajv: eslintAjvRange },
        });
        if (topAjvVersion) {
            writeJson(path.join(dir, 'node_modules', 'ajv', 'package.json'), {
                name: 'ajv',
                version: topAjvVersion,
            });
        }
        if (nestedEslintAjvVersion) {
            writeJson(path.join(dir, 'node_modules', '@eslint', 'eslintrc', 'node_modules', 'ajv', 'package.json'), {
                name: 'ajv',
                version: nestedEslintAjvVersion,
            });
        }
    }

    return dir;
}

function runDependencyState(cwd, args, { runtime = process.execPath, debug = true } = {}) {
    const env = { ...process.env, NODE_ENV: 'production' };
    if (debug) {
        env.SILLYBUNNY_DEPENDENCY_DEBUG = '1';
    } else {
        delete env.SILLYBUNNY_DEPENDENCY_DEBUG;
    }

    return spawnSync(runtime, [scriptPath, ...args], {
        cwd,
        env,
        encoding: 'utf8',
    });
}

function hasUsableBun() {
    const result = spawnSync('bun', ['--version'], { encoding: 'utf8' });
    return result.status === 0;
}

const describeBun = hasUsableBun() ? describe : describe.skip;

afterEach(() => {
    while (tempDirs.length > 0) {
        fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

describe('scripts/dependency-state.js', () => {
    test('passes when marked state has nested mime@1.6.0 under send and top-level mime@3.0.0', () => {
        const dir = createFixture();

        expect(runDependencyState(dir, ['mark', 'node-production']).status).toBe(0);
        const check = runDependencyState(dir, ['check', 'node-production']);

        expect(check.status).toBe(0);
        expect(check.stdout).toBe('');
    });

    test('passes when top-level mime already satisfies send (legacy hoisted layout)', () => {
        const dir = createFixture({
            topMimeVersion: '1.6.0',
            nestedSendMimeVersion: null,
        });

        expect(runDependencyState(dir, ['mark', 'node-production']).status).toBe(0);
        const check = runDependencyState(dir, ['check', 'node-production']);

        expect(check.status).toBe(0);
    });

    test('requires install when send/node_modules/mime is missing and top-level mime is 3.0.0, even with a fresh marker', () => {
        const dir = createFixture();

        expect(runDependencyState(dir, ['mark', 'bun-production']).status).toBe(0);
        fs.rmSync(path.join(dir, 'node_modules', 'send', 'node_modules', 'mime'), { recursive: true, force: true });

        const check = runDependencyState(dir, ['check', 'bun-production']);

        expect(check.status).toBe(1);
        expect(check.stdout).toContain('send resolved mime 3.0.0 but requires 1.6.0');
    });

    test('requires install when mime is missing entirely', () => {
        const dir = createFixture({
            topMimeVersion: null,
            nestedSendMimeVersion: null,
        });

        expect(runDependencyState(dir, ['mark', 'node-production']).status).toBe(0);
        const check = runDependencyState(dir, ['check', 'node-production']);

        expect(check.status).toBe(1);
        expect(check.stdout).toContain('send resolved mime missing but requires 1.6.0');
    });

    test('checks a separate nested send copy under serve-static', () => {
        const dir = createFixture({
            nestedServeStaticSendDeps: { mime: '1.6.0' },
            nestedServeStaticSendMimeVersion: null,
        });

        expect(runDependencyState(dir, ['mark', 'node-production']).status).toBe(0);
        const check = runDependencyState(dir, ['check', 'node-production']);

        expect(check.status).toBe(1);
        expect(check.stdout).toContain('send resolved mime 3.0.0 but requires 1.6.0');
    });

    test('requires install when express, send, or serve-static is missing', () => {
        const noExpress = createFixture({ includeExpress: false });
        expect(runDependencyState(noExpress, ['mark', 'node-production']).status).toBe(0);
        const noExpressCheck = runDependencyState(noExpress, ['check', 'node-production']);
        expect(noExpressCheck.status).toBe(1);
        expect(noExpressCheck.stdout).toContain('runtime dependencies are missing');

        const noSend = createFixture({ includeSend: false });
        expect(runDependencyState(noSend, ['mark', 'node-production']).status).toBe(0);
        const noSendCheck = runDependencyState(noSend, ['check', 'node-production']);
        expect(noSendCheck.status).toBe(1);
        expect(noSendCheck.stdout).toContain('Express dependency send is missing');

        const noServeStatic = createFixture({ includeServeStatic: false });
        expect(runDependencyState(noServeStatic, ['mark', 'node-production']).status).toBe(0);
        const noServeStaticCheck = runDependencyState(noServeStatic, ['check', 'node-production']);
        expect(noServeStaticCheck.status).toBe(1);
        expect(noServeStaticCheck.stdout).toContain('Express dependency serve-static is missing');
    });

    test('skips the mime check if send no longer declares a mime dependency', () => {
        const dir = createFixture({
            sendDeps: { 'mime-types': '^3.0.0' },
            nestedSendMimeVersion: null,
        });

        expect(runDependencyState(dir, ['mark', 'node-production']).status).toBe(0);
        const check = runDependencyState(dir, ['check', 'node-production']);

        expect(check.status).toBe(0);
    });

    test('preserves the development ESLint ajv major check', () => {
        const healthy = createFixture({
            includeEslint: true,
            topAjvVersion: '8.20.0',
            nestedEslintAjvVersion: '6.15.0',
        });
        expect(runDependencyState(healthy, ['mark', 'node-development']).status).toBe(0);
        expect(runDependencyState(healthy, ['check', 'node-development']).status).toBe(0);

        const broken = createFixture({
            includeEslint: true,
            topAjvVersion: '8.20.0',
            nestedEslintAjvVersion: null,
        });
        expect(runDependencyState(broken, ['mark', 'node-development']).status).toBe(0);
        const brokenCheck = runDependencyState(broken, ['check', 'node-development']);
        expect(brokenCheck.status).toBe(1);
        expect(brokenCheck.stdout).toContain('ESLint resolved ajv 8.20.0 but requires ^6.12.4');
    });
});

describeBun('scripts/dependency-state.js under Bun', () => {
    test('detects missing nested mime@1.6.0 under send and passes once restored', () => {
        const dir = createFixture();

        expect(runDependencyState(dir, ['mark', 'bun-production'], { runtime: 'bun' }).status).toBe(0);
        expect(runDependencyState(dir, ['check', 'bun-production'], { runtime: 'bun' }).status).toBe(0);

        const nestedMimeDir = path.join(dir, 'node_modules', 'send', 'node_modules', 'mime');
        fs.rmSync(nestedMimeDir, { recursive: true, force: true });

        const broken = runDependencyState(dir, ['check', 'bun-production'], { runtime: 'bun' });
        expect(broken.status).toBe(1);
        expect(broken.stdout).toContain('send resolved mime 3.0.0 but requires 1.6.0');

        writeJson(path.join(nestedMimeDir, 'package.json'), { name: 'mime', version: '1.6.0' });
        expect(runDependencyState(dir, ['check', 'bun-production'], { runtime: 'bun' }).status).toBe(0);
    });
});
