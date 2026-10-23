/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installerPath = path.join(repoRoot, 'scripts', 'bootstrap', 'install.sh');
const installerSource = readFileSync(installerPath, 'utf8');
const prerequisitesPath = path.join(repoRoot, 'scripts', 'install-prerequisites.sh');
const describePosix = process.platform === 'win32' ? describe.skip : describe;

function extractShellFunction(source, name) {
    const lines = source.split('\n');
    const start = lines.findIndex(line => line.startsWith(`${name}() {`));
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((line, index) => index > start && line === '}');
    expect(end).toBeGreaterThan(start);
    return lines.slice(start, end + 1).join('\n');
}

function runBootstrapFunctions(names, script, extraEnv) {
    const env = { ...process.env };
    for (const name of ['BASH_ENV', 'TERMUX_VERSION', 'PREFIX', 'SILLYBUNNY_ANDROID_APP']) {
        delete env[name];
    }
    Object.assign(env, extraEnv);
    const source = ['set -euo pipefail', ...names.map(name => extractShellFunction(installerSource, name)), script].join('\n\n');
    return spawnSync('/bin/bash', ['-c', source], {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
    });
}

function runPrerequisites(args, androidApp) {
    const env = { ...process.env, PATH: '' };
    for (const name of ['HOME', 'BASH_ENV', 'BUN_INSTALL', 'TERMUX_BUN_SOURCE_DIR', 'SILLYBUNNY_NODE_INSTALL', 'SILLYBUNNY_ANDROID_APP']) {
        delete env[name];
    }
    if (androidApp !== undefined) {
        env.SILLYBUNNY_ANDROID_APP = androidApp;
    }
    return spawnSync('/bin/bash', [prerequisitesPath, ...args], {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
    });
}

describePosix('APK prerequisites installer', () => {
    test.each([
        { args: [] },
        { args: ['--require-git', '--require-node-runtime', '--require-bun'] },
        { args: ['--no-bun', '--node-runtime'] },
    ])('exits after parsing $args without PATH commands or HOME', ({ args }) => {
        const result = runPrerequisites(args, '1');
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
    });

    test.each([undefined, '', '0', '01', 'true', 'TRUE', ' 1', '1 '])('does not enable APK mode for %j', (androidApp) => {
        const result = runPrerequisites(['--skip-bun'], androidApp);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('HOME: unbound variable');
    });

    test.each([undefined, '1'])('preserves the unknown-argument failure with APK value %j', (androidApp) => {
        const result = runPrerequisites(['--not-an-option'], androidApp);
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('Unknown argument: --not-an-option\n');
    });
});

describePosix('APK bootstrap platform guards', () => {
    test.each(['TERMUX_VERSION', 'PREFIX'])('APK mode bypasses %s detection and its shared-storage check', (name) => {
        const termuxEnv = name === 'TERMUX_VERSION' ? { TERMUX_VERSION: '0.118.0' } : { PREFIX: '/data/data/com.termux/files/usr' };
        const result = runBootstrapFunctions(['is_android_app', 'is_termux', 'is_shared_storage_path'], [
            'if is_termux && is_shared_storage_path /sdcard/SillyBunny; then',
            '    printf "blocked\\n"',
            'else',
            '    printf "allowed\\n"',
            'fi',
        ].join('\n'), { ...termuxEnv, SILLYBUNNY_ANDROID_APP: '1', PATH: '' });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('allowed\n');
        expect(result.stderr).toBe('');
    });

    test.each([undefined, '', '0', '01', 'true', 'TRUE', ' 1', '1 '])('keeps the Termux shared-storage safeguard for APK value %j', (androidApp) => {
        const env = { TERMUX_VERSION: '0.118.0', PATH: '' };
        if (androidApp !== undefined) {
            env.SILLYBUNNY_ANDROID_APP = androidApp;
        }
        const result = runBootstrapFunctions(['is_android_app', 'is_termux', 'is_shared_storage_path'], [
            'if is_termux && is_shared_storage_path /sdcard/SillyBunny; then',
            '    printf "blocked\\n"',
            'else',
            '    printf "allowed\\n"',
            'fi',
        ].join('\n'), env);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('blocked\n');
        expect(result.stderr).toBe('');
    });

    test('skips Git package installation without consulting PATH', () => {
        const result = runBootstrapFunctions([
            'is_android_app', 'is_termux', 'have_command', 'have_working_git', 'run_with_privilege', 'log', 'die', 'install_git',
        ], 'install_git', { SILLYBUNNY_ANDROID_APP: '1', TERMUX_VERSION: '0.118.0', PATH: '' });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
    });

    test('skips macOS prerequisites without consulting PATH or clone settings', () => {
        const result = runBootstrapFunctions(['is_android_app', 'install_macos_node'], 'install_macos_node', {
            SILLYBUNNY_ANDROID_APP: '1', PATH: '',
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
    });
});

describePosix('Android bootstrap against a bare fixture upstream', () => {
    let workDir;
    let fixtureRepo;
    let homeDir;

    const gitEnv = {
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
        GIT_TERMINAL_PROMPT: '0',
    };

    function git(cwd, ...args) {
        const result = spawnSync('git', args, {
            cwd,
            env: { ...process.env, ...gitEnv },
            encoding: 'utf8',
            timeout: 10000,
        });
        if (result.status !== 0) {
            throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
        }
        return result.stdout.trim();
    }

    function writeFile(filePath, content, mode) {
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, content, { mode });
    }

    function runInstaller(args, extraEnv = {}) {
        const env = { ...process.env, ...gitEnv, HOME: homeDir };
        for (const name of ['BASH_ENV', 'TERMUX_VERSION', 'PREFIX', 'SILLYBUNNY_ANDROID_APP', 'SILLYBUNNY_USE_NODE', 'SILLYBUNNY_USE_BUN']) {
            delete env[name];
        }
        Object.assign(env, extraEnv);
        const result = spawnSync('/bin/bash', [installerPath, '--repo', fixtureRepo, ...args], {
            cwd: workDir,
            env,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            input: '',
            timeout: 10000,
        });
        return { ...result, output: `${result.stdout}${result.stderr}` };
    }

    function makeOldInstall(name, config = 'dataRoot: "./data" # comment\nport: 51427\n') {
        const oldDir = path.join(workDir, name);
        git(workDir, 'clone', '--quiet', fixtureRepo, oldDir);
        writeFile(path.join(oldDir, 'config.yaml'), config);
        writeFile(path.join(oldDir, 'data', 'default-user', 'chats', 'chat.jsonl'), '{"mes":"kept"}\n');
        writeFile(path.join(oldDir, 'plugins', 'my-plugin', 'index.js'), 'user plugin\n');
        writeFile(path.join(oldDir, 'plugins', 'package.json'), 'old tracked plugin metadata\n');
        writeFile(path.join(oldDir, 'public', 'scripts', 'extensions', 'third-party', 'Mine', 'index.js'), 'user extension\n');
        writeFile(path.join(oldDir, 'public', 'scripts', 'extensions', 'third-party', 'Bundled', 'index.js'), 'old bundled extension\n');
        writeFile(path.join(oldDir, 'secrets.json'), '{"fixture":"legacy secret"}\n');
        writeFile(path.join(oldDir, 'certs', 'fixture.pem'), 'fixture certificate\n');
        writeFile(path.join(oldDir, 'notes.txt'), 'not migrated\n');
        return oldDir;
    }

    function snapshot(dir) {
        return readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)).map(entry => {
            const filePath = path.join(dir, entry.name);
            const mode = lstatSync(filePath).mode;
            if (entry.isDirectory()) {
                return [entry.name, mode, snapshot(filePath)];
            }
            if (entry.isSymbolicLink()) {
                return [entry.name, mode, readlinkSync(filePath)];
            }
            return [entry.name, mode, readFileSync(filePath).toString('base64')];
        });
    }

    beforeAll(() => {
        workDir = mkdtempSync(path.join(tmpdir(), 'sb-android-bootstrap-'));
        homeDir = path.join(workDir, 'home');
        fixtureRepo = path.join(workDir, 'upstream.git');
        const seedRepo = path.join(workDir, 'seed');
        mkdirSync(homeDir);
        writeFile(path.join(seedRepo, 'package.json'), '{"name":"sillybunny"}\n');
        writeFile(path.join(seedRepo, 'data', '.gitkeep'), '');
        writeFile(path.join(seedRepo, 'plugins', 'package.json'), 'new tracked plugin metadata\n');
        writeFile(path.join(seedRepo, 'public', 'scripts', 'extensions', 'third-party', 'Bundled', 'index.js'), 'new bundled extension\n');
        writeFile(path.join(seedRepo, 'scripts', 'self-update.sh'), 'printf "FIXTURE_UPDATE %s\\n" "$*"\n');
        writeFile(path.join(seedRepo, 'scripts', 'install-prerequisites.sh'), 'printf "FIXTURE_PREREQUISITES %s\\n" "$*"\nexit 91\n');
        writeFile(path.join(seedRepo, 'start.sh'), 'printf "FIXTURE_STARTED\\n"\nexit 92\n');
        git(workDir, 'init', '--quiet', '--initial-branch=release', seedRepo);
        git(seedRepo, 'add', '-A');
        git(seedRepo, 'commit', '--quiet', '-m', 'fixture');
        git(workDir, 'clone', '--quiet', '--bare', seedRepo, fixtureRepo);
    });

    afterAll(() => {
        if (workDir) {
            rmSync(workDir, { recursive: true, force: true });
        }
    });

    test('APK flags and non-TTY stdin install without the wizard or macOS prerequisites', () => {
        const fakeBin = path.join(workDir, 'fake-mac-bin');
        const unameMarker = path.join(workDir, 'uname-called');
        writeFile(path.join(fakeBin, 'uname'), '#!/bin/sh\nprintf "called\\n" >> "$UNAME_MARKER"\nprintf "Darwin\\n"\n', 0o755);
        const target = path.join(workDir, 'apk-install');
        const { status, output } = runInstaller(['--no-start', '--dir', target, '--ref', 'release', '--use-node'], {
            SILLYBUNNY_ANDROID_APP: '1',
            TERMUX_VERSION: '0.118.0',
            PREFIX: '/data/data/com.termux/files/usr',
            PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
            UNAME_MARKER: unameMarker,
        });
        expect(status).toBe(0);
        expect(git(target, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/release');
        expect(output).not.toContain('[SillyBunny] Setup');
        expect(output).not.toContain('FIXTURE_PREREQUISITES');
        expect(output).not.toContain('FIXTURE_STARTED');
        expect(existsSync(unameMarker)).toBe(false);
        expect(readFileSync(path.join(target, 'package.json'), 'utf8')).toBe('{"name":"sillybunny"}\n');
    });

    test.each([undefined, '1'])('--allow-git-source repairs a Git checkout with APK mode %j and leaves its source unchanged', (androidApp) => {
        const name = androidApp === '1' ? 'apk' : 'desktop';
        const oldDir = makeOldInstall(`old-git-${name}`);
        const before = snapshot(oldDir);
        const target = path.join(workDir, `repaired-${name}`);
        const env = androidApp === undefined ? {} : { SILLYBUNNY_ANDROID_APP: androidApp };
        const { status, output } = runInstaller([
            '--no-start', '--dir', target, '--ref', 'release', '--use-node', '--migrate-from', oldDir, '--allow-git-source',
        ], env);
        expect(status).toBe(0);
        expect(snapshot(oldDir)).toEqual(before);
        expect(git(target, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/release');
        expect(readFileSync(path.join(target, 'config.yaml'), 'utf8')).toBe('dataRoot: "./data" # comment\nport: 51427\n');
        expect(readFileSync(path.join(target, 'data', 'default-user', 'chats', 'chat.jsonl'), 'utf8')).toBe('{"mes":"kept"}\n');
        expect(readFileSync(path.join(target, 'plugins', 'my-plugin', 'index.js'), 'utf8')).toBe('user plugin\n');
        expect(readFileSync(path.join(target, 'public', 'scripts', 'extensions', 'third-party', 'Mine', 'index.js'), 'utf8')).toBe('user extension\n');
        expect(readFileSync(path.join(target, 'secrets.json'), 'utf8')).toBe('{"fixture":"legacy secret"}\n');
        expect(readFileSync(path.join(target, 'certs', 'fixture.pem'), 'utf8')).toBe('fixture certificate\n');
        expect(readFileSync(path.join(target, 'plugins', 'package.json'), 'utf8')).toBe('new tracked plugin metadata\n');
        expect(readFileSync(path.join(target, 'public', 'scripts', 'extensions', 'third-party', 'Bundled', 'index.js'), 'utf8')).toBe('new bundled extension\n');
        expect(git(target, 'status', '--porcelain', '--', 'plugins/package.json', 'public/scripts/extensions/third-party/Bundled')).toBe('');
        expect(existsSync(path.join(target, 'notes.txt'))).toBe(false);
        expect(output).not.toContain('treating it as a ZIP release');
        expect(output).not.toContain('[SillyBunny] Setup');
        expect(output).not.toContain('FIXTURE_STARTED');
    });

    test.each([undefined, '1'])('without the repair flag, APK mode %j preserves the exact Git-source refusal', (androidApp) => {
        const name = androidApp === '1' ? 'apk' : 'desktop';
        const oldDir = makeOldInstall(`refused-old-git-${name}`);
        const before = snapshot(oldDir);
        const target = path.join(workDir, `refused-target-${name}`);
        const env = androidApp === undefined ? {} : { SILLYBUNNY_ANDROID_APP: androidApp };
        const result = runInstaller(['--no-start', '--dir', target, '--migrate-from', oldDir], env);
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe(`[SillyBunny] ${oldDir} is already a Git install and updates itself. Run its start.sh instead of migrating.\n`);
        expect(existsSync(target)).toBe(false);
        expect(snapshot(oldDir)).toEqual(before);
    });

    test.each([false, true])('preserves the packaged-ZIP note with the repair flag %j', (allowGitSource) => {
        const name = allowGitSource ? 'flagged' : 'unflagged';
        const oldDir = makeOldInstall(`zip-with-git-${name}`);
        rmSync(path.join(oldDir, 'scripts', 'self-update.sh'));
        const before = snapshot(oldDir);
        const target = path.join(workDir, `zip-migrated-${name}`);
        const result = runInstaller([
            '--no-start', '--dir', target, '--migrate-from', oldDir, ...(allowGitSource ? ['--allow-git-source'] : []),
        ]);
        expect(result.status).toBe(0);
        expect(result.output).toContain(`[SillyBunny] Note: ${oldDir} contains a .git folder but no self-update script; treating it as a ZIP release.\n`);
        expect(readFileSync(path.join(target, 'data', 'default-user', 'chats', 'chat.jsonl'), 'utf8')).toBe('{"mes":"kept"}\n');
        expect(snapshot(oldDir)).toEqual(before);
    });

    test.each([
        { id: 'same', config: 'dataRoot: ./data\n', error: 'already has an install. Migrate into a new folder with --dir.' },
        { id: 'nested', config: 'dataRoot: ./data\n', error: 'The new install folder cannot be inside the old one.' },
        { id: 'outside-data', config: 'dataRoot: ../shared\n', error: 'The old config.yaml has a dataRoot outside its folder' },
    ])('--allow-git-source retains the $id safeguard', ({ id, config, error }) => {
        const oldDir = makeOldInstall(`guard-old-${id}`, config);
        const before = snapshot(oldDir);
        const target = id === 'same' ? oldDir : id === 'nested' ? path.join(oldDir, 'new') : path.join(workDir, `guard-target-${id}`);
        const result = runInstaller(['--allow-git-source', '--no-start', '--dir', target, '--migrate-from', oldDir], {
            SILLYBUNNY_ANDROID_APP: '1',
        });
        expect(result.status).toBe(1);
        expect(result.output).toContain(error);
        expect(result.output).not.toContain('Downloading SillyBunny');
        expect(existsSync(target)).toBe(id === 'same');
        expect(snapshot(oldDir)).toEqual(before);
    });

    test.each([false, true])('--allow-git-source retains source validation for an existing folder %j', (sourceExists) => {
        const name = sourceExists ? 'unrelated' : 'missing';
        const oldDir = path.join(workDir, `invalid-source-${name}`);
        if (sourceExists) {
            writeFile(path.join(oldDir, 'package.json'), '{"name":"unrelated"}\n');
        }
        const target = path.join(workDir, `invalid-source-target-${name}`);
        const result = runInstaller(['--allow-git-source', '--no-start', '--dir', target, '--migrate-from', oldDir]);
        expect(result.status).toBe(1);
        expect(result.stderr).toBe(sourceExists
            ? `[SillyBunny] This doesn't look like a SillyBunny folder: ${oldDir}\n`
            : `[SillyBunny] The folder to migrate from does not exist: ${oldDir}\n`);
        expect(existsSync(target)).toBe(false);
    });

    test('--allow-git-source does not replace a non-empty target', () => {
        const oldDir = makeOldInstall('old-for-nonempty-target');
        const before = snapshot(oldDir);
        const target = path.join(workDir, 'nonempty-target');
        writeFile(path.join(target, 'notes.txt'), 'keep target\n');
        const targetBefore = snapshot(target);
        const result = runInstaller(['--allow-git-source', '--no-start', '--dir', target, '--migrate-from', oldDir], {
            SILLYBUNNY_ANDROID_APP: '1',
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toBe(`[SillyBunny] ${target} exists and isn't empty. Pick another folder with --dir.\n`);
        expect(snapshot(oldDir)).toEqual(before);
        expect(snapshot(target)).toEqual(targetBefore);
    });

    test('Git-source repair retains a custom relative dataRoot', () => {
        const oldDir = makeOldInstall('old-custom-root', 'dataRoot: ./userdata\n');
        writeFile(path.join(oldDir, 'userdata', 'default-user', 'settings.json'), '{"fixture":true}\n');
        const before = snapshot(oldDir);
        const target = path.join(workDir, 'custom-root-repaired');
        const result = runInstaller(['--allow-git-source', '--no-start', '--dir', target, '--migrate-from', oldDir]);
        expect(result.status).toBe(0);
        expect(readFileSync(path.join(target, 'userdata', 'default-user', 'settings.json'), 'utf8')).toBe('{"fixture":true}\n');
        expect(existsSync(path.join(target, 'data', 'default-user', 'chats', 'chat.jsonl'))).toBe(false);
        expect(snapshot(oldDir)).toEqual(before);
    });

    test('Git-source repair keeps using an absolute dataRoot without copying or modifying it', () => {
        const externalData = path.join(workDir, 'external-data');
        writeFile(path.join(externalData, 'default-user', 'settings.json'), '{"fixture":true}\n');
        const config = `dataRoot: "${externalData}"\n`;
        const oldDir = makeOldInstall('old-absolute-root', config);
        const before = snapshot(oldDir);
        const dataBefore = snapshot(externalData);
        const target = path.join(workDir, 'absolute-root-repaired');
        const result = runInstaller(['--allow-git-source', '--no-start', '--dir', target, '--migrate-from', oldDir], {
            SILLYBUNNY_ANDROID_APP: '1',
        });
        expect(result.status).toBe(0);
        expect(readFileSync(path.join(target, 'config.yaml'), 'utf8')).toBe(config);
        expect(result.output).toContain(`Your data root is ${externalData}, outside the old folder; the new install will keep using it.`);
        expect(existsSync(path.join(target, 'data', 'default-user', 'chats', 'chat.jsonl'))).toBe(false);
        expect(snapshot(oldDir)).toEqual(before);
        expect(snapshot(externalData)).toEqual(dataBefore);
    });

    test('help exposes the repair flag with only its approved placeholder', () => {
        const result = runInstaller(['--help']);
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/^ {2}--allow-git-source +TODO\(copy\)$/m);
        expect(result.stderr).toBe('');
    });
});
