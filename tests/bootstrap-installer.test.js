import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bootstrapDir = path.join(repoRoot, 'scripts', 'bootstrap');
const installerPath = path.join(bootstrapDir, 'install.sh');
const installerSource = readFileSync(installerPath, 'utf8');
const powershellSource = readFileSync(path.join(bootstrapDir, 'Install-SillyBunny.ps1'), 'utf8');
const cmdSource = readFileSync(path.join(bootstrapDir, 'Install-SillyBunny.cmd'), 'utf8');
const releaseWorkflow = readFileSync(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
const smokeWorkflow = readFileSync(path.join(repoRoot, '.github', 'workflows', 'bootstrap-smoke.yml'), 'utf8');

// The behavioural suite drives install.sh against a local fixture repository.
// Windows runners cover Install-SillyBunny.ps1 in bootstrap-smoke.yml instead.
const describePosix = process.platform === 'win32' ? describe.skip : describe;

describe('bootstrap installer sources', () => {
    test('install.sh runs only from main() on its last line', () => {
        const lines = installerSource.trimEnd().split('\n');
        expect(lines.at(-1)).toBe('main "$@"');
        expect(installerSource).toContain('set -euo pipefail');
    });

    test('install.sh clones the release branch as a blob-filtered Git checkout', () => {
        expect(installerSource).toContain('DEFAULT_REF=\'release\'');
        expect(installerSource).toContain('clone --filter=blob:none --branch "$ref" -- "$repo" "$install_dir"');
        expect(installerSource).toContain('bash "$install_dir/scripts/self-update.sh" --optional');
    });

    test('the Windows installer pins portable Git by version and SHA-256', () => {
        expect(powershellSource).toContain('$minGitBaseUrl = \'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.1\'');
        expect(powershellSource).toMatch(/'x64' = @\{ File = 'MinGit-2\.56\.0-64-bit\.zip'; Sha256 = '[0-9a-f]{64}' \}/);
        expect(powershellSource).toMatch(/'arm64' = @\{ File = 'MinGit-2\.56\.0-arm64\.zip'; Sha256 = '[0-9a-f]{64}' \}/);
        expect(powershellSource).toContain('Get-FileHash -LiteralPath $zip -Algorithm SHA256');
    });

    test('the Windows installer tries winget, then Chocolatey, then Scoop, then portable Git', () => {
        const winget = powershellSource.indexOf('Name = \'winget\'');
        const choco = powershellSource.indexOf('Name = \'choco\'');
        const scoop = powershellSource.indexOf('Name = \'scoop\'');
        const minGit = powershellSource.indexOf('Install-MinGit\n        if');
        expect(winget).toBeGreaterThan(-1);
        expect(choco).toBeGreaterThan(winget);
        expect(scoop).toBeGreaterThan(choco);
        expect(minGit).toBeGreaterThan(scoop);
    });

    test('the Windows installer never calls exit, so `irm | iex` keeps the user\'s window open', () => {
        expect(powershellSource).not.toMatch(/^\s*exit\b/m);
        expect(powershellSource.trimEnd().split('\n').at(-1)).toMatch(/^Install-SillyBunny /);
    });

    test('the .cmd wrapper bypasses the execution policy for its own run and uses CRLF', () => {
        expect(cmdSource).toContain('powershell -NoProfile -ExecutionPolicy Bypass -File "%_installer%" %*');
        expect(cmdSource.split('\n').slice(0, -1).every(line => line.endsWith('\r'))).toBe(true);
    });

    test('release.yml ships every bootstrap script as a release asset', () => {
        expect(releaseWorkflow).toContain('if [ -d scripts/bootstrap ]; then');
        expect(releaseWorkflow).toContain('-name \'*.sh\' -o -name \'*.ps1\' -o -name \'*.cmd\'');
    });

    test('bootstrap-smoke runs on every PR to staging and release without a paths filter', () => {
        expect(smokeWorkflow).toMatch(/pull_request:\n\s+branches:\n\s+- staging\n\s+- release\n/);
        expect(smokeWorkflow).not.toContain('paths:');
        expect(smokeWorkflow).toContain('ubuntu-latest');
        expect(smokeWorkflow).toContain('macos-latest');
        expect(smokeWorkflow).toContain('windows-latest');
    });
});

describePosix('install.sh against a fixture repository', () => {
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
    };

    function git(cwd, ...args) {
        const result = spawnSync('git', args, { cwd, env: { ...process.env, ...gitEnv }, encoding: 'utf8' });
        if (result.status !== 0) {
            throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
        }
        return result.stdout.trim();
    }

    function writeFile(filePath, content) {
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, content);
    }

    function runInstaller(args, extraEnv = {}) {
        const env = { ...process.env, ...gitEnv, HOME: homeDir, ...extraEnv };
        delete env.TERMUX_VERSION;
        delete env.PREFIX;
        Object.assign(env, extraEnv);
        const result = spawnSync('bash', [installerPath, '--repo', fixtureRepo, ...args], {
            cwd: workDir,
            env,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { status: result.status, output: `${result.stdout}${result.stderr}` };
    }

    function makeOldInstall(name, configYaml) {
        const oldDir = path.join(workDir, name);
        writeFile(path.join(oldDir, 'package.json'), '{\n    "name": "sillybunny",\n    "version": "1.8.1"\n}\n');
        writeFile(path.join(oldDir, 'config.yaml'), configYaml);
        writeFile(path.join(oldDir, 'data', 'default-user', 'chats', 'Seraphina', 'chat.jsonl'), '{"mes":"hi"}\n');
        writeFile(path.join(oldDir, 'plugins', 'my-plugin', 'index.js'), 'user plugin\n');
        writeFile(path.join(oldDir, 'plugins', 'package.json'), 'old tracked copy\n');
        writeFile(path.join(oldDir, 'public', 'scripts', 'extensions', 'third-party', 'Bundled', 'index.js'), 'old bundled\n');
        writeFile(path.join(oldDir, 'public', 'scripts', 'extensions', 'third-party', 'Mine', 'index.js'), 'user extension\n');
        writeFile(path.join(oldDir, 'secrets.json'), '{"api_key_openai":"placeholder"}\n');
        return oldDir;
    }

    function snapshot(dir) {
        const result = spawnSync('bash', ['-c', 'find . -type f -exec cksum {} + | sort'], { cwd: dir, encoding: 'utf8' });
        return result.stdout;
    }

    beforeAll(() => {
        workDir = mkdtempSync(path.join(tmpdir(), 'sb-bootstrap-'));
        homeDir = path.join(workDir, 'home');
        fixtureRepo = path.join(workDir, 'fixture');
        mkdirSync(homeDir);

        writeFile(path.join(fixtureRepo, 'package.json'), '{\n    "name": "sillybunny"\n}\n');
        writeFile(path.join(fixtureRepo, 'data', '.gitkeep'), '');
        writeFile(path.join(fixtureRepo, 'plugins', 'package.json'), 'tracked\n');
        writeFile(path.join(fixtureRepo, 'public', 'scripts', 'extensions', 'third-party', 'Bundled', 'index.js'), 'new bundled\n');
        writeFile(path.join(fixtureRepo, 'scripts', 'self-update.sh'), 'echo "SELF-UPDATE $*"\n');
        writeFile(path.join(fixtureRepo, 'start.sh'), 'echo "STARTED in $PWD"\n');
        git(workDir, 'init', '--quiet', '--initial-branch=release', fixtureRepo);
        git(fixtureRepo, 'add', '-A');
        git(fixtureRepo, 'commit', '--quiet', '-m', 'fixture');
        git(fixtureRepo, 'tag', 'v9.9.9');
    });

    afterAll(() => {
        rmSync(workDir, { recursive: true, force: true });
    });

    test('a fresh install clones release into ~/SillyBunny and tracks origin/release', () => {
        const { status, output } = runInstaller(['--no-start']);
        expect(status).toBe(0);
        const target = path.join(homeDir, 'SillyBunny');
        expect(existsSync(path.join(target, '.git'))).toBe(true);
        expect(git(target, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/release');
        expect(output).toContain(`bash "${target}/start.sh"`);
    });

    test('rerunning on an existing install updates it and never re-clones', () => {
        const target = path.join(homeDir, 'SillyBunny');
        const head = git(target, 'rev-parse', 'HEAD');
        writeFile(path.join(target, 'data', 'default-user', 'marker.txt'), 'kept\n');
        const { status, output } = runInstaller(['--no-start', '--ref', 'v9.9.9']);
        expect(status).toBe(0);
        expect(output).toContain('SELF-UPDATE --optional');
        expect(output).toContain('--ref is ignored for an existing install.');
        expect(git(target, 'rev-parse', 'HEAD')).toBe(head);
        expect(readFileSync(path.join(target, 'data', 'default-user', 'marker.txt'), 'utf8')).toBe('kept\n');
    });

    test('--ref installs a pinned tag and says updates are off', () => {
        const target = path.join(workDir, 'pinned');
        const { status, output } = runInstaller(['--dir', target, '--ref', 'v9.9.9', '--no-start']);
        expect(status).toBe(0);
        expect(output).toContain('Installed tag v9.9.9. Automatic updates are off for a pinned tag.');
        expect(git(target, 'describe', '--tags')).toBe('v9.9.9');
    });

    test('without --no-start it hands off to the clone\'s start.sh', () => {
        const target = path.join(workDir, 'started');
        const { status, output } = runInstaller(['--dir', target]);
        expect(status).toBe(0);
        expect(output).toContain(`STARTED in ${target}`);
    });

    test('--migrate-from copies user data into a fresh clone and leaves the old folder untouched', () => {
        const oldDir = makeOldInstall('old-zip', 'dataRoot: "./data" # comment\nport: 4444\n');
        const before = snapshot(oldDir);
        const target = path.join(workDir, 'migrated');

        const { status, output } = runInstaller(['--dir', target, '--migrate-from', oldDir, '--no-start']);
        expect(status).toBe(0);
        expect(snapshot(oldDir)).toBe(before);

        expect(readFileSync(path.join(target, 'data', 'default-user', 'chats', 'Seraphina', 'chat.jsonl'), 'utf8')).toBe('{"mes":"hi"}\n');
        expect(readFileSync(path.join(target, 'config.yaml'), 'utf8')).toContain('port: 4444');
        expect(readFileSync(path.join(target, 'secrets.json'), 'utf8')).toContain('placeholder');
        expect(readFileSync(path.join(target, 'plugins', 'my-plugin', 'index.js'), 'utf8')).toBe('user plugin\n');
        expect(readFileSync(path.join(target, 'public', 'scripts', 'extensions', 'third-party', 'Mine', 'index.js'), 'utf8')).toBe('user extension\n');

        // Tracked files keep the freshly installed version.
        expect(readFileSync(path.join(target, 'plugins', 'package.json'), 'utf8')).toBe('tracked\n');
        expect(readFileSync(path.join(target, 'public', 'scripts', 'extensions', 'third-party', 'Bundled', 'index.js'), 'utf8')).toBe('new bundled\n');
        expect(git(target, 'status', '--porcelain', '--', 'plugins/package.json', 'public/scripts/extensions/third-party/Bundled')).toBe('');

        expect(output).toContain('plugins/my-plugin');
        expect(output).not.toContain('plugins/package.json');
    });

    test('--migrate-from follows a custom relative dataRoot', () => {
        const oldDir = makeOldInstall('old-custom-root', 'dataRoot: ./userdata\n');
        writeFile(path.join(oldDir, 'userdata', 'default-user', 'settings.json'), '{}\n');
        const target = path.join(workDir, 'migrated-custom');

        const { status } = runInstaller(['--dir', target, '--migrate-from', oldDir, '--no-start']);
        expect(status).toBe(0);
        expect(existsSync(path.join(target, 'userdata', 'default-user', 'settings.json'))).toBe(true);
    });

    test('--migrate-from refuses a relative dataRoot outside the old folder before cloning', () => {
        const oldDir = makeOldInstall('old-outside-root', 'dataRoot: ../shared\n');
        const target = path.join(workDir, 'migrated-outside');

        const { status, output } = runInstaller(['--dir', target, '--migrate-from', oldDir, '--no-start']);
        expect(status).not.toBe(0);
        expect(output).toContain('dataRoot outside its folder');
        expect(existsSync(target)).toBe(false);
    });

    test('an old ZIP install at the target is refused with the migration command', () => {
        const oldDir = makeOldInstall('old-at-target', 'dataRoot: ./data\n');
        const before = snapshot(oldDir);

        const { status, output } = runInstaller(['--dir', oldDir, '--no-start']);
        expect(status).not.toBe(0);
        expect(output).toContain(`--migrate-from "${oldDir}"`);
        expect(snapshot(oldDir)).toBe(before);
    });

    test('a non-empty unrelated folder is refused', () => {
        const target = path.join(workDir, 'not-empty');
        writeFile(path.join(target, 'notes.txt'), 'mine\n');
        const { status, output } = runInstaller(['--dir', target, '--no-start']);
        expect(status).not.toBe(0);
        expect(output).toContain('exists and isn\'t empty');
    });

    test('the folder holding the installer is refused with a subfolder suggestion', () => {
        const target = path.join(workDir, 'downloads');
        const copiedInstaller = path.join(target, 'install.sh');
        writeFile(copiedInstaller, installerSource);
        const result = spawnSync('bash', [copiedInstaller, '--repo', fixtureRepo, '--dir', target, '--no-start'], {
            cwd: workDir,
            env: { ...process.env, ...gitEnv, HOME: homeDir },
            encoding: 'utf8',
        });
        expect(result.status).not.toBe(0);
        const resolved = realpathSync(target);
        expect(`${result.stdout}${result.stderr}`).toContain(`${resolved} holds this installer (install.sh), and the install needs an empty folder. Install into a subfolder instead: --dir "${resolved}/SillyBunny"`);
        expect(existsSync(path.join(target, '.git'))).toBe(false);
    });

    test('Termux refuses Android shared storage', () => {
        const { status, output } = runInstaller(['--dir', '/sdcard/SillyBunny', '--no-start'], { TERMUX_VERSION: '0.118.0' });
        expect(status).not.toBe(0);
        expect(output).toContain('Android shared storage');
    });

    test('unknown options and missing values fail with usage', () => {
        expect(runInstaller(['--bogus']).output).toContain('Unknown option: --bogus');
        expect(runInstaller(['--ref']).output).toContain('--ref needs a value.');
        expect(runInstaller(['--dir', '--no-start']).output).toContain('--dir needs a value.');
    });
});
