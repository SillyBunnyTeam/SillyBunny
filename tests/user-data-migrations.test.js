import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import { assertSandboxedInstall, createInstallSandbox, snapshotTree, writeFiles } from './util/install-sandbox.js';

const sandbox = createInstallSandbox('sillybunny-user-migrations');
await assertSandboxedInstall(sandbox);
const originalWorkingDirectory = process.cwd();
const originalDataRoot = global.DATA_ROOT;
const cookieSecretEnvironmentKey = 'SILLYTAVERN_COOKIESECRET';
const originalCookieSecret = process.env[cookieSecretEnvironmentKey];

const { setConfigFilePath } = await import('../src/util.js');
setConfigFilePath(sandbox.configPath);
global.DATA_ROOT = sandbox.dataRoot;

const { default: storage } = await import('node-persist');
const {
    ensurePublicDirectoriesExist,
    getCookieSecret,
    getUserDirectories,
    initUserStorage,
    migratePublicOverrides,
    migrateSystemPrompts,
    migrateUserData,
    toKey,
} = await import('../src/users.js');

const DEFAULT_HANDLE = 'default-user';
const SECOND_HANDLE = 'second-user';
const BACKUP_DATE = '2026-03-04';

const folderEntry = (legacy, current, inner) => ({ legacy, current, inner });
const fileEntry = (legacy, current) => ({ legacy, current, inner: null });

const LEGACY_LAYOUT = [
    folderEntry('public/assets', 'assets', 'ambient/rain.txt'),
    folderEntry('public/backgrounds', 'backgrounds', 'dusk.jpg'),
    folderEntry('public/characters', 'characters', 'Alice.png'),
    folderEntry('public/chats', 'chats', 'Alice/Alice - 2024-01-01@12h00m00s.jsonl'),
    folderEntry('public/context', 'context', 'Story.json'),
    folderEntry('public/group chats', 'group chats', 'club-chat.jsonl'),
    folderEntry('public/groups', 'groups', 'club.json'),
    folderEntry('public/instruct', 'instruct', 'Format.json'),
    folderEntry('public/KoboldAI Settings', 'KoboldAI Settings', 'Preset.json'),
    folderEntry('public/movingUI', 'movingUI', 'layout.json'),
    folderEntry('public/NovelAI Settings', 'NovelAI Settings', 'Preset.json'),
    folderEntry('public/OpenAI Settings', 'OpenAI Settings', 'Preset.json'),
    folderEntry('public/QuickReplies', 'QuickReplies', 'Set.json'),
    folderEntry('public/TextGen Settings', 'TextGen Settings', 'Preset.json'),
    folderEntry('public/themes', 'themes', 'Night.json'),
    folderEntry('public/user', 'user', 'notes.txt'),
    folderEntry('public/User Avatars', 'User Avatars', 'me.png'),
    folderEntry('public/worlds', 'worlds', 'Atlas.json'),
    folderEntry('public/scripts/extensions/third-party', 'extensions', 'ext-a/manifest.json'),
    folderEntry('thumbnails', 'thumbnails', 'avatar/Alice.jpg'),
    folderEntry('vectors', 'vectors', 'store/index.bin'),
    fileEntry('secrets.json', 'secrets.json'),
    fileEntry('public/settings.json', 'settings.json'),
    fileEntry('public/stats.json', 'stats.json'),
];

const readHex = filePath => fs.existsSync(filePath) ? fs.readFileSync(filePath).toString('hex') : null;
const readJson = filePath => JSON.parse(fs.readFileSync(filePath, 'utf8'));

function fixtureContent(relativePath) {
    return /\.(png|bin)$/.test(relativePath)
        ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, ...Buffer.from(relativePath)])
        : Buffer.from(`legacy ${relativePath}\n`);
}

function describeLegacyLayout() {
    const userRoot = getUserDirectories(DEFAULT_HANDLE).root;
    return LEGACY_LAYOUT.map(({ legacy, current, inner }) => {
        const innerSegments = inner ? inner.split('/') : [];
        const legacyRelative = [legacy, ...innerSegments].join('/');
        return {
            legacyRelative,
            legacyPath: path.join(sandbox.installDir, ...legacyRelative.split('/')),
            currentPath: path.join(userRoot, ...current.split('/'), ...innerSegments),
            backupPath: path.join(sandbox.installDir, 'backups', '_migration', BACKUP_DATE, path.posix.basename(legacy), ...innerSegments),
            content: fixtureContent(legacyRelative),
        };
    });
}

function writeLegacyLayout(skippedLegacyFolders = []) {
    const files = describeLegacyLayout();
    for (const file of files) {
        if (!skippedLegacyFolders.some(skipped => file.legacyRelative.startsWith(`${skipped}/`))) {
            fs.mkdirSync(path.dirname(file.legacyPath), { recursive: true });
            fs.writeFileSync(file.legacyPath, file.content);
        }
    }
    return files;
}

const byLegacyPath = (files, getContent) => Object.fromEntries(files.map(file => [file.legacyRelative, getContent(file)]));

beforeAll(() => {
    // The migrations resolve legacy paths against the working directory.
    process.chdir(sandbox.installDir);
});

beforeEach(async () => {
    for (const method of ['debug', 'info', 'log', 'warn', 'error']) {
        jest.spyOn(console, method).mockImplementation(() => {});
    }
    sandbox.clear();
    await initUserStorage(sandbox.dataRoot);
    await ensurePublicDirectoriesExist();
});

afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (originalCookieSecret === undefined) {
        delete process.env[cookieSecretEnvironmentKey];
    } else {
        process.env[cookieSecretEnvironmentKey] = originalCookieSecret;
    }
});

afterAll(() => {
    process.chdir(originalWorkingDirectory);
    global.DATA_ROOT = originalDataRoot;
    sandbox.dispose();
});

describe('migrateUserData', () => {
    beforeEach(() => {
        jest.useFakeTimers({ now: new Date(`${BACKUP_DATE}T10:00:00Z`) });
    });

    async function runMigration() {
        const run = migrateUserData();
        await jest.advanceTimersByTimeAsync(10_000);
        await run;
    }

    test('moves every legacy folder and file into the default user folder', async () => {
        const files = writeLegacyLayout();

        await runMigration();

        expect(byLegacyPath(files, file => readHex(file.currentPath))).toEqual(byLegacyPath(files, file => file.content.toString('hex')));
        expect(files.filter(file => fs.existsSync(file.legacyPath)).map(file => file.legacyRelative)).toEqual([]);
        expect(console.error).not.toHaveBeenCalled();
    });

    test('keeps a byte-identical backup of everything it moves', async () => {
        const files = writeLegacyLayout();

        await runMigration();

        expect(byLegacyPath(files, file => readHex(file.backupPath))).toEqual(byLegacyPath(files, file => file.content.toString('hex')));
    });

    test('waits ten seconds before it moves anything', async () => {
        const files = writeLegacyLayout();

        const run = migrateUserData();
        await jest.advanceTimersByTimeAsync(9_999);

        expect(files.every(file => fs.existsSync(file.legacyPath))).toBe(true);
        expect(files.some(file => fs.existsSync(file.currentPath))).toBe(false);

        await jest.advanceTimersByTimeAsync(1);
        await run;

        expect(files.some(file => fs.existsSync(file.legacyPath))).toBe(false);
        expect(files.every(file => fs.existsSync(file.currentPath))).toBe(true);
    });

    test('keeps files that only exist in the new location', async () => {
        writeLegacyLayout();
        const userRoot = getUserDirectories(DEFAULT_HANDLE).root;
        writeFiles(userRoot, {
            'characters/Bob.png': 'card made after the upgrade',
            'themes/Custom.json': '{"name":"Custom"}',
        });

        await runMigration();

        expect(fs.readFileSync(path.join(userRoot, 'characters', 'Bob.png'), 'utf8')).toBe('card made after the upgrade');
        expect(fs.readFileSync(path.join(userRoot, 'themes', 'Custom.json'), 'utf8')).toBe('{"name":"Custom"}');
        expect(fs.existsSync(path.join(userRoot, 'characters', 'Alice.png'))).toBe(true);
        expect(fs.existsSync(path.join(userRoot, 'themes', 'Night.json'))).toBe(true);
    });

    test('keeps a legacy folder it cannot copy and still moves the others', async () => {
        const files = writeLegacyLayout();
        const { themes } = getUserDirectories(DEFAULT_HANDLE);
        fs.rmSync(themes, { recursive: true, force: true });
        fs.writeFileSync(themes, 'a file where the themes folder belongs');

        await runMigration();

        const stuck = files.find(file => file.legacyRelative === 'public/themes/Night.json');
        const moved = files.filter(file => file !== stuck);
        expect(fs.readFileSync(stuck.legacyPath)).toEqual(stuck.content);
        expect(byLegacyPath(moved, file => readHex(file.currentPath))).toEqual(byLegacyPath(moved, file => file.content.toString('hex')));
        expect(moved.some(file => fs.existsSync(file.legacyPath))).toBe(false);
        expect(console.error).toHaveBeenCalledWith(path.join(process.cwd(), 'public', 'themes'));
    });

    test('finishes a layout whose first folders were already moved', async () => {
        const files = writeLegacyLayout(['public/assets', 'public/backgrounds']);
        const alreadyMoved = files.filter(file => /^public\/(assets|backgrounds)\//.test(file.legacyRelative));
        for (const file of alreadyMoved) {
            fs.mkdirSync(path.dirname(file.currentPath), { recursive: true });
            fs.writeFileSync(file.currentPath, file.content);
        }

        await runMigration();

        expect(byLegacyPath(files, file => readHex(file.currentPath))).toEqual(byLegacyPath(files, file => file.content.toString('hex')));
        expect(files.some(file => fs.existsSync(file.legacyPath))).toBe(false);
        expect(console.error).not.toHaveBeenCalled();
    });

    test('changes nothing and starts no countdown when public has no characters folder', async () => {
        writeFiles(getUserDirectories(DEFAULT_HANDLE).root, {
            'characters/Alice.png': 'card in the new location',
            'chats/Alice/log.jsonl': '{"mes":"hello"}\n',
            'settings.json': '{"firstRun":false}',
        });
        const before = snapshotTree(sandbox.root);

        const run = migrateUserData();

        expect(jest.getTimerCount()).toBe(0);
        await run;
        expect(snapshotTree(sandbox.root)).toEqual(before);
    });

    test('changes nothing when it runs a second time', async () => {
        writeLegacyLayout();
        await runMigration();
        const before = snapshotTree(sandbox.root);
        jest.clearAllMocks();

        const run = migrateUserData();

        expect(jest.getTimerCount()).toBe(0);
        await run;
        expect(snapshotTree(sandbox.root)).toEqual(before);
        expect(console.error).not.toHaveBeenCalled();
    });
});

describe('migrateSystemPrompts', () => {
    const originals = {
        Alpha: { name: 'Alpha', system_prompt: 'You are Alpha.', input_sequence: '### Instruction:', output_sequence: '### Response:', wrap: true },
        Beta: { name: 'Beta', system_prompt: 'You are Alpha.', input_sequence: '[INST]', output_sequence: '[/INST]' },
        Gamma: { name: 'Gamma', system_prompt: 'Bundled prompt text.', input_sequence: '<in>', output_sequence: '<out>' },
        Delta: { name: 'Delta', input_sequence: '<d-in>', output_sequence: '<d-out>' },
        Epsilon: { name: 'Epsilon', system_prompt: 'Keep this template as it is.', input_sequence: '<e-in>' },
    };
    const existingEpsilonPrompt = { name: 'Epsilon', content: 'A prompt that already exists.' };
    const asFile = value => JSON.stringify(value, null, 4);
    const withoutPrompt = ({ system_prompt: _removed, ...rest }) => rest;

    function writeOldTemplates(handle = DEFAULT_HANDLE) {
        const { instruct, sysprompt } = getUserDirectories(handle);
        writeFiles(instruct, {
            'Alpha.json': asFile(originals.Alpha),
            'Beta.json': asFile(originals.Beta),
            'Gamma.json': asFile(originals.Gamma),
            'Delta.json': asFile(originals.Delta),
            'Epsilon.json': asFile(originals.Epsilon),
            'notes.txt': 'not a template',
        });
        writeFiles(sysprompt, { 'Epsilon.json': asFile(existingEpsilonPrompt) });
    }

    beforeEach(() => {
        writeFiles(sandbox.installDir, {
            'default/content/index.json': JSON.stringify([{ filename: 'presets/sysprompt/Synthetic Default.json', type: 'sysprompt' }]),
            'default/content/presets/sysprompt/Synthetic Default.json': JSON.stringify({ name: 'Synthetic Default', content: 'Bundled prompt text.' }),
        });
    });

    test('turns each distinct system prompt into a migrated prompt named after its first template', async () => {
        writeOldTemplates();
        const { sysprompt } = getUserDirectories(DEFAULT_HANDLE);

        await migrateSystemPrompts();

        expect(fs.readdirSync(sysprompt).sort()).toEqual(['.migrated', 'Epsilon.json', '[Migrated] Alpha.json']);
        expect(readJson(path.join(sysprompt, '[Migrated] Alpha.json'))).toEqual({ name: '[Migrated] Alpha', content: 'You are Alpha.' });
    });

    test('removes only the system prompt from each template it migrates', async () => {
        writeOldTemplates();
        const { instruct } = getUserDirectories(DEFAULT_HANDLE);

        await migrateSystemPrompts();

        expect(readJson(path.join(instruct, 'Alpha.json'))).toEqual(withoutPrompt(originals.Alpha));
        expect(readJson(path.join(instruct, 'Beta.json'))).toEqual(withoutPrompt(originals.Beta));
        expect(readJson(path.join(instruct, 'Gamma.json'))).toEqual(withoutPrompt(originals.Gamma));
    });

    test('backs up the original bytes of every template it rewrites', async () => {
        writeOldTemplates();
        const { instruct, backups } = getUserDirectories(DEFAULT_HANDLE);
        const before = {
            Alpha: readHex(path.join(instruct, 'Alpha.json')),
            Beta: readHex(path.join(instruct, 'Beta.json')),
            Gamma: readHex(path.join(instruct, 'Gamma.json')),
        };

        await migrateSystemPrompts();

        expect(fs.readdirSync(path.join(backups, '_sysprompt')).sort()).toEqual(['Alpha.json', 'Beta.json', 'Gamma.json']);
        for (const name of Object.keys(before)) {
            expect(readHex(path.join(backups, '_sysprompt', `${name}.json`))).toBe(before[name]);
        }
    });

    test('leaves templates without a system prompt, other files and existing prompts untouched', async () => {
        writeOldTemplates();
        const { instruct, sysprompt } = getUserDirectories(DEFAULT_HANDLE);
        const untouched = ['Delta.json', 'Epsilon.json', 'notes.txt'].map(name => path.join(instruct, name));
        untouched.push(path.join(sysprompt, 'Epsilon.json'));
        const before = untouched.map(readHex);

        await migrateSystemPrompts();

        expect(untouched.map(readHex)).toEqual(before);
    });

    test('changes nothing when it runs a second time', async () => {
        writeOldTemplates();
        await migrateSystemPrompts();
        const before = snapshotTree(sandbox.root);
        jest.clearAllMocks();

        await migrateSystemPrompts();

        expect(snapshotTree(sandbox.root)).toEqual(before);
        expect(console.error).not.toHaveBeenCalled();
    });

    test('only records that it ran when no template has a system prompt', async () => {
        const { instruct, sysprompt, backups } = getUserDirectories(DEFAULT_HANDLE);
        writeFiles(instruct, { 'Delta.json': asFile(originals.Delta), 'notes.txt': 'not a template' });
        const instructBefore = snapshotTree(instruct);

        await migrateSystemPrompts();

        expect(snapshotTree(instruct)).toEqual(instructBefore);
        expect(fs.readdirSync(sysprompt)).toEqual(['.migrated']);
        expect(fs.readdirSync(path.join(backups, '_sysprompt'))).toEqual([]);

        const before = snapshotTree(sandbox.root);
        jest.clearAllMocks();
        await migrateSystemPrompts();
        expect(snapshotTree(sandbox.root)).toEqual(before);
        expect(console.error).not.toHaveBeenCalled();
    });

    test('skips a user that already has the marker and still migrates the other users', async () => {
        await storage.setItem(toKey(SECOND_HANDLE), { handle: SECOND_HANDLE, name: 'Second', enabled: true, admin: false });
        await ensurePublicDirectoriesExist();
        writeOldTemplates(DEFAULT_HANDLE);
        writeOldTemplates(SECOND_HANDLE);
        const first = getUserDirectories(DEFAULT_HANDLE);
        const second = getUserDirectories(SECOND_HANDLE);
        fs.writeFileSync(path.join(first.sysprompt, '.migrated'), '');
        const firstBefore = snapshotTree(first.root);

        await migrateSystemPrompts();

        expect(snapshotTree(first.root)).toEqual(firstBefore);
        expect(readJson(path.join(second.sysprompt, '[Migrated] Alpha.json'))).toEqual({ name: '[Migrated] Alpha', content: 'You are Alpha.' });
        expect(readJson(path.join(second.instruct, 'Alpha.json'))).toEqual(withoutPrompt(originals.Alpha));
        expect(fs.existsSync(path.join(first.sysprompt, '[Migrated] Alpha.json'))).toBe(false);
    });

    test('finishes a user whose first template was already migrated', async () => {
        const { instruct, sysprompt } = getUserDirectories(DEFAULT_HANDLE);
        writeFiles(instruct, {
            'Alpha.json': asFile(withoutPrompt(originals.Alpha)),
            'Zeta.json': asFile({ name: 'Zeta', system_prompt: 'You are Zeta.', input_sequence: '<z-in>' }),
        });
        writeFiles(sysprompt, { '[Migrated] Alpha.json': asFile({ name: '[Migrated] Alpha', content: 'You are Alpha.' }) });
        const alreadyMigrated = [path.join(instruct, 'Alpha.json'), path.join(sysprompt, '[Migrated] Alpha.json')];
        const before = alreadyMigrated.map(readHex);

        await migrateSystemPrompts();

        expect(alreadyMigrated.map(readHex)).toEqual(before);
        expect(readJson(path.join(sysprompt, '[Migrated] Zeta.json'))).toEqual({ name: '[Migrated] Zeta', content: 'You are Zeta.' });
        expect(readJson(path.join(instruct, 'Zeta.json'))).toEqual({ name: 'Zeta', input_sequence: '<z-in>' });
        expect(fs.existsSync(path.join(sysprompt, '.migrated'))).toBe(true);
    });
});

describe('migratePublicOverrides', () => {
    const overrides = {
        'public/error/forbidden-by-whitelist.html': '<p>custom forbidden page</p>',
        'public/error/host-not-allowed.html': '<p>custom host page</p>',
        'public/error/unauthorized.html': '<p>custom unauthorized page</p>',
        'public/error/url-not-found.html': '<p>custom not found page</p>',
        'public/css/user.css': 'body { color: teal; }\n',
    };
    const movedTo = {
        'public/error/forbidden-by-whitelist.html': '_errors/forbidden-by-whitelist.html',
        'public/error/host-not-allowed.html': '_errors/host-not-allowed.html',
        'public/error/unauthorized.html': '_errors/unauthorized.html',
        'public/error/url-not-found.html': '_errors/url-not-found.html',
        'public/css/user.css': '_css/user.css',
    };
    const readAll = (baseDir, relativePaths) => Object.fromEntries(relativePaths.map(relative => [relative, fs.existsSync(path.join(baseDir, relative)) ? fs.readFileSync(path.join(baseDir, relative), 'utf8') : null]));

    test('moves each customised page and stylesheet into the data root', async () => {
        writeFiles(sandbox.installDir, overrides);

        await migratePublicOverrides();

        expect(readAll(sandbox.dataRoot, Object.values(movedTo))).toEqual({
            '_errors/forbidden-by-whitelist.html': '<p>custom forbidden page</p>',
            '_errors/host-not-allowed.html': '<p>custom host page</p>',
            '_errors/unauthorized.html': '<p>custom unauthorized page</p>',
            '_errors/url-not-found.html': '<p>custom not found page</p>',
            '_css/user.css': 'body { color: teal; }\n',
        });
        expect(Object.values(readAll(sandbox.installDir, Object.keys(movedTo))).filter(content => content !== null)).toEqual([]);
        expect(console.error).not.toHaveBeenCalled();
    });

    test('moves only the overrides that exist', async () => {
        writeFiles(sandbox.installDir, {
            'public/error/unauthorized.html': overrides['public/error/unauthorized.html'],
            'public/css/user.css': overrides['public/css/user.css'],
        });

        await migratePublicOverrides();

        expect(readAll(sandbox.dataRoot, Object.values(movedTo))).toEqual({
            '_errors/forbidden-by-whitelist.html': null,
            '_errors/host-not-allowed.html': null,
            '_errors/unauthorized.html': '<p>custom unauthorized page</p>',
            '_errors/url-not-found.html': null,
            '_css/user.css': 'body { color: teal; }\n',
        });
        expect(console.error).not.toHaveBeenCalled();
    });

    test('keeps the data root copy and the legacy file when the data root already has an override', async () => {
        writeFiles(sandbox.installDir, overrides);
        writeFiles(sandbox.dataRoot, { '_css/user.css': 'body { color: crimson; }\n' });

        await migratePublicOverrides();

        expect(fs.readFileSync(path.join(sandbox.dataRoot, '_css', 'user.css'), 'utf8')).toBe('body { color: crimson; }\n');
        expect(fs.readFileSync(path.join(sandbox.installDir, 'public', 'css', 'user.css'), 'utf8')).toBe('body { color: teal; }\n');
        expect(fs.existsSync(path.join(sandbox.dataRoot, '_errors', 'unauthorized.html'))).toBe(true);
    });

    test('changes nothing when it runs a second time', async () => {
        writeFiles(sandbox.installDir, overrides);
        await migratePublicOverrides();
        const before = snapshotTree(sandbox.root);
        jest.clearAllMocks();

        await migratePublicOverrides();

        expect(snapshotTree(sandbox.root)).toEqual(before);
        expect(console.error).not.toHaveBeenCalled();
    });

    test('changes nothing when there are no legacy overrides', async () => {
        const before = snapshotTree(sandbox.root);

        await migratePublicOverrides();

        expect(snapshotTree(sandbox.root)).toEqual(before);
        expect(console.error).not.toHaveBeenCalled();
    });
});

describe('getCookieSecret', () => {
    const secretFile = () => path.join(sandbox.dataRoot, 'cookie-secret.txt');

    beforeEach(() => {
        delete process.env[cookieSecretEnvironmentKey];
    });

    test('copies the configured secret into the data root', () => {
        process.env[cookieSecretEnvironmentKey] = 'configured-secret';

        expect(getCookieSecret(sandbox.dataRoot)).toBe('configured-secret');
        expect(fs.readFileSync(secretFile(), 'utf8')).toBe('configured-secret');
    });

    test('keeps returning the stored secret after the configured one changes', () => {
        process.env[cookieSecretEnvironmentKey] = 'configured-secret';
        getCookieSecret(sandbox.dataRoot);
        process.env[cookieSecretEnvironmentKey] = 'edited-configured-secret';
        const before = snapshotTree(sandbox.root);

        expect(getCookieSecret(sandbox.dataRoot)).toBe('configured-secret');
        expect(snapshotTree(sandbox.root)).toEqual(before);
    });

    test('prefers an existing data root secret over the configured one', () => {
        fs.writeFileSync(secretFile(), 'stored-secret');
        process.env[cookieSecretEnvironmentKey] = 'configured-secret';

        expect(getCookieSecret(sandbox.dataRoot)).toBe('stored-secret');
        expect(fs.readFileSync(secretFile(), 'utf8')).toBe('stored-secret');
    });

    test('replaces an empty secret file with the configured secret', () => {
        fs.writeFileSync(secretFile(), '');
        process.env[cookieSecretEnvironmentKey] = 'configured-secret';

        expect(getCookieSecret(sandbox.dataRoot)).toBe('configured-secret');
        expect(fs.readFileSync(secretFile(), 'utf8')).toBe('configured-secret');
    });

    test('creates a secret once when none exists anywhere', () => {
        const created = getCookieSecret(sandbox.dataRoot);
        const before = snapshotTree(sandbox.root);

        expect(created).toMatch(/^[A-Za-z0-9+/]{86}==$/);
        expect(fs.readFileSync(secretFile(), 'utf8')).toBe(created);
        expect(getCookieSecret(sandbox.dataRoot)).toBe(created);
        expect(snapshotTree(sandbox.root)).toEqual(before);
    });
});
