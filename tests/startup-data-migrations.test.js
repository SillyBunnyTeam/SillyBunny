import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import { createInstallSandbox, snapshotTree, writeFiles } from './util/install-sandbox.js';

const sandbox = createInstallSandbox('sillybunny-startup-migrations');
const originalWorkingDirectory = process.cwd();
const originalDataRoot = global.DATA_ROOT;

const { setConfigFilePath } = await import('../src/util.js');
setConfigFilePath(sandbox.configPath);
global.DATA_ROOT = sandbox.dataRoot;

const { default: storage } = await import('node-persist');
const { ensurePublicDirectoriesExist, getUserDirectories, getUserDirectoriesList, initUserStorage, toKey } = await import('../src/users.js');
const { PRESET_CONTENT_TYPES, checkForNewContent, recordDefaultPresetDeletion } = await import('../src/endpoints/content-manager.js');
const { migrateGroupChatsMetadataFormat } = await import('../src/endpoints/groups.js');
const { SECRETS_FILE, migrateFlatSecrets, readSecret } = await import('../src/endpoints/secrets.js');
const { getAccessLogPath, migrateAccessLog } = await import('../src/middleware/accessLogWriter.js');

const FIRST_HANDLE = 'default-user';
const SECOND_HANDLE = 'second-user';
const skipContentCheckEnvironmentKey = 'SILLYTAVERN_SKIPCONTENTCHECK';
const originalSkipContentCheck = process.env[skipContentCheckEnvironmentKey];

const readHex = filePath => fs.readFileSync(filePath).toString('hex');
const readJson = filePath => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const readJsonLines = filePath => fs.readFileSync(filePath, 'utf8').split('\n').map(line => JSON.parse(line));
const toJsonLines = entries => entries.map(entry => JSON.stringify(entry)).join('\n');
const without = (object, ...keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));

async function addSecondUser() {
    await storage.setItem(toKey(SECOND_HANDLE), { handle: SECOND_HANDLE, name: 'Second', enabled: true, admin: false });
    await ensurePublicDirectoriesExist();
}

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
    jest.restoreAllMocks();
    if (originalSkipContentCheck === undefined) {
        delete process.env[skipContentCheckEnvironmentKey];
    } else {
        process.env[skipContentCheckEnvironmentKey] = originalSkipContentCheck;
    }
});

afterAll(() => {
    process.chdir(originalWorkingDirectory);
    global.DATA_ROOT = originalDataRoot;
    sandbox.dispose();
});

describe('migrateGroupChatsMetadataFormat', () => {
    const messages = {
        'club-1': [{ name: 'Alice', mes: 'First message' }, { name: 'You', mes: 'Second message' }],
        'club-2': [{ name: 'Alice', mes: 'An older chat' }],
        'half-1': [{ name: 'Alice', mes: 'Already has a header' }],
        'half-2': [{ name: 'Alice', mes: 'Still needs a header' }],
        'settled-1': [{ name: 'Alice', mes: 'Nothing to do here' }],
    };
    const club = {
        id: 'club',
        name: 'Club',
        members: ['Alice.png', 'Bob.png'],
        avatar_url: 'club.png',
        chats: ['club-1', 'club-2', 'ghost'],
        chat_id: 'club-1',
        chat_metadata: { note: 'current chat note' },
        past_metadata: { 'club-2': { note: 'older chat note' } },
    };
    const half = {
        id: 'half',
        name: 'Half',
        members: ['Alice.png'],
        chats: ['half-1', 'half-2'],
        chat_id: 'half-2',
        chat_metadata: { note: 'half note' },
        past_metadata: {},
    };
    const settled = { id: 'settled', name: 'Settled', members: ['Alice.png'], chats: ['settled-1'], chat_id: 'settled-1' };
    const bare = { id: 'bare', name: 'Bare', members: [], chat_metadata: { note: 'no chats to attach it to' } };
    const header = metadata => ({ chat_metadata: metadata, user_name: 'unused', character_name: 'unused' });
    const migratedHalfOne = toJsonLines([header({ note: 'migrated by an earlier run' }), ...messages['half-1']]);

    function writeOldGroups(handle = FIRST_HANDLE) {
        const { groups, groupChats } = getUserDirectories(handle);
        writeFiles(groups, {
            'club.json': JSON.stringify(club, null, 4),
            'half.json': JSON.stringify(half, null, 4),
            'settled.json': JSON.stringify(settled, null, 4),
            'bare.json': JSON.stringify(bare, null, 4),
            'notes.txt': 'not a group',
        });
        writeFiles(groupChats, {
            'club-1.jsonl': toJsonLines(messages['club-1']),
            'club-2.jsonl': toJsonLines(messages['club-2']),
            'half-1.jsonl': migratedHalfOne,
            'half-2.jsonl': toJsonLines(messages['half-2']),
            'settled-1.jsonl': toJsonLines(messages['settled-1']),
        });
    }

    const migrate = async () => migrateGroupChatsMetadataFormat(await getUserDirectoriesList());

    test('adds the group metadata to the header of each group chat', async () => {
        writeOldGroups();
        const { groupChats } = getUserDirectories(FIRST_HANDLE);

        await migrate();

        expect(readJsonLines(path.join(groupChats, 'club-1.jsonl'))).toEqual([header({ note: 'current chat note' }), ...messages['club-1']]);
        expect(readJsonLines(path.join(groupChats, 'club-2.jsonl'))).toEqual([header({ note: 'older chat note' }), ...messages['club-2']]);
        expect(console.error).not.toHaveBeenCalled();
    });

    test('removes the metadata keys from the group and keeps its other fields', async () => {
        writeOldGroups();
        const { groups } = getUserDirectories(FIRST_HANDLE);

        await migrate();

        expect(readJson(path.join(groups, 'club.json'))).toEqual(without(club, 'chat_metadata', 'past_metadata'));
    });

    test('backs up the original group and chat files before rewriting them', async () => {
        writeOldGroups();
        const { groups, groupChats, backups } = getUserDirectories(FIRST_HANDLE);
        const expectedBackups = {
            'club.json': readHex(path.join(groups, 'club.json')),
            'club-1.jsonl': readHex(path.join(groupChats, 'club-1.jsonl')),
            'club-2.jsonl': readHex(path.join(groupChats, 'club-2.jsonl')),
        };

        await migrate();

        const backupFolder = path.join(backups, '_group_metadata_update');
        for (const [name, hex] of Object.entries(expectedBackups)) {
            expect(readHex(path.join(backupFolder, name))).toBe(hex);
        }
    });

    test('finishes a group whose first chat was already migrated without adding a second header', async () => {
        writeOldGroups();
        const { groups, groupChats } = getUserDirectories(FIRST_HANDLE);

        await migrate();

        expect(fs.readFileSync(path.join(groupChats, 'half-1.jsonl'), 'utf8')).toBe(migratedHalfOne);
        expect(readJsonLines(path.join(groupChats, 'half-2.jsonl'))).toEqual([header({ note: 'half note' }), ...messages['half-2']]);
        expect(readJson(path.join(groups, 'half.json'))).toEqual(without(half, 'chat_metadata', 'past_metadata'));
        expect(console.error).not.toHaveBeenCalled();
    });

    test('leaves groups without legacy metadata and groups without a chat list as they are', async () => {
        writeOldGroups();
        const { groups, groupChats } = getUserDirectories(FIRST_HANDLE);
        const untouched = [
            path.join(groups, 'settled.json'),
            path.join(groups, 'bare.json'),
            path.join(groups, 'notes.txt'),
            path.join(groupChats, 'settled-1.jsonl'),
        ];
        const before = untouched.map(readHex);

        await migrate();

        expect(untouched.map(readHex)).toEqual(before);
    });

    test('migrates the groups of every user', async () => {
        await addSecondUser();
        writeOldGroups(FIRST_HANDLE);
        writeOldGroups(SECOND_HANDLE);

        await migrate();

        const second = getUserDirectories(SECOND_HANDLE);
        expect(readJsonLines(path.join(second.groupChats, 'club-1.jsonl'))[0]).toEqual(header({ note: 'current chat note' }));
        expect(readJson(path.join(second.groups, 'club.json'))).not.toHaveProperty('chat_metadata');
    });

    test('changes nothing when it runs a second time', async () => {
        writeOldGroups();
        await migrate();
        const before = snapshotTree(sandbox.root);
        jest.clearAllMocks();

        await migrate();

        expect(snapshotTree(sandbox.root)).toEqual(before);
        expect(console.error).not.toHaveBeenCalled();
    });

    test('leaves groups and chats unchanged and writes no backup when there is nothing to migrate', async () => {
        const { groups, groupChats, backups } = getUserDirectories(FIRST_HANDLE);
        writeFiles(groups, { 'settled.json': JSON.stringify(settled, null, 4) });
        writeFiles(groupChats, { 'settled-1.jsonl': toJsonLines(messages['settled-1']) });
        const before = { groups: snapshotTree(groups), groupChats: snapshotTree(groupChats) };

        await migrate();

        expect({ groups: snapshotTree(groups), groupChats: snapshotTree(groupChats) }).toEqual(before);
        expect(fs.existsSync(path.join(backups, '_group_metadata_update'))).toBe(false);
        expect(console.error).not.toHaveBeenCalled();

        const whole = snapshotTree(sandbox.root);
        await migrate();
        expect(snapshotTree(sandbox.root)).toEqual(whole);
    });
});

describe('migrateFlatSecrets', () => {
    const flatSecrets = {
        api_key_openai: 'synthetic-openai-key',
        api_key_openrouter: 'synthetic-openrouter-key',
        api_key_novel: '   ',
    };
    const flatText = JSON.stringify(flatSecrets, null, 4);
    const currentFormat = { api_key_openai: [{ id: 'fixed-id', value: 'synthetic-openai-key', label: 'Work', active: true }], _migrated: [] };

    const secretsFile = handle => path.join(getUserDirectories(handle).root, SECRETS_FILE);
    const backupNames = handle => fs.readdirSync(getUserDirectories(handle).backups).filter(name => name.startsWith('secrets_migration_'));

    test('converts each flat secret into an active entry labelled with its key', () => {
        fs.writeFileSync(secretsFile(FIRST_HANDLE), flatText);

        migrateFlatSecrets([getUserDirectories(FIRST_HANDLE)]);

        expect(readJson(secretsFile(FIRST_HANDLE))).toEqual({
            api_key_openai: [{ id: expect.any(String), value: 'synthetic-openai-key', label: 'api_key_openai', active: true }],
            api_key_openrouter: [{ id: expect.any(String), value: 'synthetic-openrouter-key', label: 'api_key_openrouter', active: true }],
            _migrated: [],
        });
    });

    test('keeps every secret readable through the secrets API', () => {
        fs.writeFileSync(secretsFile(FIRST_HANDLE), flatText);
        const directories = getUserDirectories(FIRST_HANDLE);

        migrateFlatSecrets([directories]);

        expect(readSecret(directories, 'api_key_openai')).toBe('synthetic-openai-key');
        expect(readSecret(directories, 'api_key_openrouter')).toBe('synthetic-openrouter-key');
    });

    test('backs up the flat file byte for byte', () => {
        fs.writeFileSync(secretsFile(FIRST_HANDLE), flatText);

        migrateFlatSecrets([getUserDirectories(FIRST_HANDLE)]);

        const [backupName, ...others] = backupNames(FIRST_HANDLE);
        expect(others).toEqual([]);
        expect(fs.readFileSync(path.join(getUserDirectories(FIRST_HANDLE).backups, backupName), 'utf8')).toBe(flatText);
    });

    test('changes nothing when it runs a second time', () => {
        fs.writeFileSync(secretsFile(FIRST_HANDLE), flatText);
        migrateFlatSecrets([getUserDirectories(FIRST_HANDLE)]);
        const before = snapshotTree(sandbox.root);
        jest.clearAllMocks();

        migrateFlatSecrets([getUserDirectories(FIRST_HANDLE)]);

        expect(snapshotTree(sandbox.root)).toEqual(before);
        expect(console.warn).not.toHaveBeenCalled();
    });

    test.each([
        ['in the current format', JSON.stringify(currentFormat, null, 4)],
        ['in the current format without the migration marker', JSON.stringify(without(currentFormat, '_migrated'), null, 4)],
        ['empty', '{}'],
    ])('leaves a secrets file that is %s as it is', (_description, content) => {
        fs.writeFileSync(secretsFile(FIRST_HANDLE), content);
        const before = snapshotTree(sandbox.root);

        migrateFlatSecrets([getUserDirectories(FIRST_HANDLE)]);

        expect(snapshotTree(sandbox.root)).toEqual(before);
        expect(console.warn).not.toHaveBeenCalled();
    });

    test('leaves a secrets file that is not readable as JSON as it is and reports it', () => {
        fs.writeFileSync(secretsFile(FIRST_HANDLE), 'not json at all');
        const before = snapshotTree(sandbox.root);

        migrateFlatSecrets([getUserDirectories(FIRST_HANDLE)]);

        expect(snapshotTree(sandbox.root)).toEqual(before);
        expect(console.warn).toHaveBeenCalledTimes(1);
    });

    test('creates no secrets file for a user without one', () => {
        const before = snapshotTree(sandbox.root);

        migrateFlatSecrets([getUserDirectories(FIRST_HANDLE)]);

        expect(snapshotTree(sandbox.root)).toEqual(before);
        expect(fs.existsSync(secretsFile(FIRST_HANDLE))).toBe(false);
        expect(console.warn).not.toHaveBeenCalled();
    });

    test('keeps going with the next user when one secrets file cannot be read', async () => {
        await addSecondUser();
        fs.writeFileSync(secretsFile(FIRST_HANDLE), 'not json at all');
        fs.writeFileSync(secretsFile(SECOND_HANDLE), flatText);

        migrateFlatSecrets([getUserDirectories(FIRST_HANDLE), getUserDirectories(SECOND_HANDLE)]);

        expect(fs.readFileSync(secretsFile(FIRST_HANDLE), 'utf8')).toBe('not json at all');
        expect(readSecret(getUserDirectories(SECOND_HANDLE), 'api_key_openai')).toBe('synthetic-openai-key');
        expect(console.warn).toHaveBeenCalledTimes(1);
    });
});

describe('migrateAccessLog', () => {
    const legacyLog = () => path.join(sandbox.installDir, 'access.log');
    const logText = '2026-03-04T10:00:00.000Z 127.0.0.1 synthetic-agent\n2026-03-04T10:05:00.000Z 127.0.0.1 synthetic-agent\n';

    test('moves the access log from the install folder into the data root', () => {
        fs.writeFileSync(legacyLog(), logText);

        migrateAccessLog();

        expect(fs.readFileSync(getAccessLogPath(), 'utf8')).toBe(logText);
        expect(fs.existsSync(legacyLog())).toBe(false);
        expect(console.error).not.toHaveBeenCalled();
    });

    test('changes nothing when it runs a second time', () => {
        fs.writeFileSync(legacyLog(), logText);
        migrateAccessLog();
        const before = snapshotTree(sandbox.root);
        jest.clearAllMocks();

        migrateAccessLog();

        expect(snapshotTree(sandbox.root)).toEqual(before);
        expect(console.error).not.toHaveBeenCalled();
    });

    test('keeps both logs when the data root already has one', () => {
        fs.writeFileSync(legacyLog(), logText);
        fs.writeFileSync(getAccessLogPath(), 'newer log\n');

        migrateAccessLog();

        expect(fs.readFileSync(getAccessLogPath(), 'utf8')).toBe('newer log\n');
        expect(fs.readFileSync(legacyLog(), 'utf8')).toBe(logText);
    });

    test('changes nothing when there is no legacy log', () => {
        const before = snapshotTree(sandbox.root);

        migrateAccessLog();

        expect(snapshotTree(sandbox.root)).toEqual(before);
        expect(console.error).not.toHaveBeenCalled();
    });
});

describe('checkForNewContent', () => {
    const chat = { filename: 'presets/openai/Synthetic Chat.json', type: 'openai_preset', content: '{"bundled":"chat preset"}' };
    const theme = { filename: 'themes/Synthetic Theme.json', type: 'theme', content: '{"name":"Synthetic Theme"}' };
    const bundledItems = [
        { filename: 'settings.json', type: 'settings', content: '{"bundled":"settings"}' },
        chat,
        { filename: 'presets/sysprompt/Synthetic Prompt.json', type: 'sysprompt', content: '{"name":"Synthetic Prompt","content":"bundled prompt"}' },
        theme,
        { filename: 'errors/unauthorized.html', type: 'error_page', content: '<p>bundled unauthorized page</p>' },
        { filename: 'user.css', type: 'stylesheet', content: '/* bundled stylesheet */\n' },
    ];
    const newItems = [
        { filename: 'presets/openai/Synthetic Added.json', type: 'openai_preset', content: '{"bundled":"added preset"}' },
        { filename: 'themes/Synthetic New Theme.json', type: 'theme', content: '{"name":"Synthetic New Theme"}' },
    ];

    function writeBundledContent(items) {
        writeFiles(path.join(sandbox.installDir, 'default', 'content'), {
            'index.json': JSON.stringify(items.map(({ filename, type }) => ({ filename, type }))),
            ...Object.fromEntries(items.map(item => [item.filename, item.content])),
        });
    }

    function installedPaths() {
        const user = getUserDirectories(FIRST_HANDLE);
        return {
            settings: path.join(user.root, 'settings.json'),
            chat: path.join(user.openAI_Settings, 'Synthetic Chat.json'),
            prompt: path.join(user.sysprompt, 'Synthetic Prompt.json'),
            theme: path.join(user.themes, 'Synthetic Theme.json'),
            added: path.join(user.openAI_Settings, 'Synthetic Added.json'),
            newTheme: path.join(user.themes, 'Synthetic New Theme.json'),
            errorPage: path.join(sandbox.dataRoot, '_errors', 'unauthorized.html'),
            stylesheet: path.join(sandbox.dataRoot, '_css', 'user.css'),
            userLog: path.join(user.root, 'content.log'),
            globalLog: path.join(sandbox.dataRoot, 'content.log'),
        };
    }

    const readIfPresent = filePath => fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
    // The log of a user starts with an empty line.
    const readLogEntries = filePath => fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    const run = async (forcedTypes = PRESET_CONTENT_TYPES) => checkForNewContent(await getUserDirectoriesList(), forcedTypes);

    beforeEach(() => {
        writeBundledContent(bundledItems);
    });

    test('copies the bundled content into a new user folder and the data root', async () => {
        const paths = installedPaths();

        await run();

        expect({
            settings: readIfPresent(paths.settings),
            chat: readIfPresent(paths.chat),
            prompt: readIfPresent(paths.prompt),
            theme: readIfPresent(paths.theme),
            errorPage: readIfPresent(paths.errorPage),
            stylesheet: readIfPresent(paths.stylesheet),
        }).toEqual({
            settings: '{"bundled":"settings"}',
            chat: '{"bundled":"chat preset"}',
            prompt: '{"name":"Synthetic Prompt","content":"bundled prompt"}',
            theme: '{"name":"Synthetic Theme"}',
            errorPage: '<p>bundled unauthorized page</p>',
            stylesheet: '/* bundled stylesheet */\n',
        });
    });

    test('records each copied file in the content log of its scope', async () => {
        const paths = installedPaths();

        await run();

        expect(readLogEntries(paths.userLog)).toEqual([
            'settings.json',
            'presets/openai/Synthetic Chat.json',
            'presets/sysprompt/Synthetic Prompt.json',
            'themes/Synthetic Theme.json',
        ]);
        expect(readLogEntries(paths.globalLog)).toEqual(['errors/unauthorized.html', 'user.css']);
    });

    test('adds content that is new since the last run and leaves existing and deleted files alone', async () => {
        const paths = installedPaths();
        await run();
        fs.writeFileSync(paths.chat, '{"edited":"by the user"}');
        fs.rmSync(paths.theme);
        writeBundledContent([...bundledItems, ...newItems]);

        await run();

        expect({
            chat: readIfPresent(paths.chat),
            theme: readIfPresent(paths.theme),
            added: readIfPresent(paths.added),
            newTheme: readIfPresent(paths.newTheme),
        }).toEqual({
            chat: '{"edited":"by the user"}',
            theme: null,
            added: '{"bundled":"added preset"}',
            newTheme: '{"name":"Synthetic New Theme"}',
        });
    });

    test('does not bring back a bundled preset that is recorded as deleted', async () => {
        const paths = installedPaths();
        await run();
        fs.rmSync(paths.chat);
        recordDefaultPresetDeletion(getUserDirectories(FIRST_HANDLE), chat);

        await run();

        expect(fs.existsSync(paths.chat)).toBe(false);
    });

    test('changes nothing when it runs a second time', async () => {
        await run();
        const before = snapshotTree(sandbox.root);
        jest.clearAllMocks();

        await run();

        expect(snapshotTree(sandbox.root)).toEqual(before);
        expect(console.error).not.toHaveBeenCalled();
    });

    test('adds nothing when content checks are switched off and no category is forced', async () => {
        process.env[skipContentCheckEnvironmentKey] = 'true';
        const before = snapshotTree(sandbox.root);

        await run([]);

        expect(snapshotTree(sandbox.root)).toEqual(before);
    });

    describe('with a bundled quick reply set', () => {
        const bundledSet = '{"name":"Synthetic Quick Replies","qrList":[]}';
        const quickReplyFolder = () => getUserDirectories(FIRST_HANDLE).quickreplies;
        const readTexts = folder => Object.fromEntries(Object.keys(snapshotTree(folder))
            .filter(key => fs.statSync(path.join(folder, key)).isFile())
            .map(key => [key, fs.readFileSync(path.join(folder, key), 'utf8')]));

        beforeEach(() => {
            writeFiles(path.join(sandbox.installDir, 'default', 'content'), { 'presets/quick-replies/Memory Sharding.json': bundledSet });
        });

        test('removes byte-identical copies of the set and keeps the file with the bundled name', async () => {
            writeFiles(quickReplyFolder(), {
                'Memory Sharding.json': bundledSet,
                'Archive/Memory Sharding.json': bundledSet,
            });

            await run();

            expect(readTexts(quickReplyFolder())).toEqual({ 'Memory Sharding.json': bundledSet });
        });

        test('keeps edited copies and other quick reply sets', async () => {
            const edited = '{"name":"Synthetic Quick Replies","qrList":[{"label":"added by the user"}]}';
            const other = '{"name":"Other Set","qrList":[]}';
            writeFiles(quickReplyFolder(), {
                'Memory Sharding.json': bundledSet,
                'Archive/Memory Sharding.json': bundledSet,
                'Edited Copy.json': edited,
                'Other Set.json': other,
            });

            await run();

            expect(readTexts(quickReplyFolder())).toEqual({
                'Edited Copy.json': edited,
                'Memory Sharding.json': bundledSet,
                'Other Set.json': other,
            });
        });

        test('changes nothing when it runs a second time', async () => {
            writeFiles(quickReplyFolder(), {
                'Memory Sharding.json': bundledSet,
                'Archive/Memory Sharding.json': bundledSet,
            });
            await run();
            const before = snapshotTree(sandbox.root);
            jest.clearAllMocks();

            await run();

            expect(snapshotTree(sandbox.root)).toEqual(before);
            expect(console.error).not.toHaveBeenCalled();
        });
    });

    describe('with obsolete bundled presets', () => {
        const obsoletePresets = [
            ['openAI_Settings', 'presets/openai/Geechan - Universal Roleplay (Chat Completions) (v5.0).json'],
            ['context', 'presets/context/Geechan - Universal Roleplay (V5.0).json'],
            ['sysprompt', 'presets/sysprompt/Geechan - Universal Roleplay (V5.0).json'],
            ['sysprompt', 'presets/sysprompt/Geechan - Universal Roleplay (NSFW) (V5.0).json'],
            ['sysprompt', 'presets/sysprompt/Geechan - Universal Roleplay (Simplified) (V5.0).json'],
            ['sysprompt', 'presets/sysprompt/Geechan - Universal Roleplay (NSFW Simplified) (V5.0).json'],
        ];
        const obsoleteLogEntries = obsoletePresets.map(([, filename]) => filename);
        const noLongerBundledLogEntry = 'presets/openai/No Longer Bundled.json';
        const contentLogPath = handle => path.join(getUserDirectories(handle).root, 'content.log');
        const readContentLog = handle => fs.existsSync(contentLogPath(handle)) ? fs.readFileSync(contentLogPath(handle), 'utf8') : '';
        const toSnapshotKey = filePath => path.relative(sandbox.root, filePath).split(path.sep).join('/');
        const stillPresent = filePaths => filePaths.filter(filePath => fs.existsSync(filePath));

        function writeObsoletePresets(handle) {
            const directories = getUserDirectories(handle);
            return obsoletePresets.map(([folder, filename]) => {
                const filePath = path.join(directories[folder], path.posix.basename(filename));
                fs.writeFileSync(filePath, '{"synthetic":"preset from an older bundle"}');
                return filePath;
            });
        }

        function listObsoletePresetsInContentLog(handle) {
            const [firstLine, ...otherLines] = readContentLog(handle).split('\n');
            const lines = [firstLine, ...obsoleteLogEntries.slice(0, 3), ...otherLines, ...obsoleteLogEntries.slice(3)];
            fs.writeFileSync(contentLogPath(handle), lines.join('\n'));
        }

        function writeUserPresets(handle) {
            const directories = getUserDirectories(handle);
            writeFiles(directories.openAI_Settings, { 'My Chat Preset.json': '{"name":"My Chat Preset"}' });
            writeFiles(directories.context, { 'My Context.json': '{"name":"My Context"}' });
            writeFiles(directories.sysprompt, {
                'My Prompt.json': '{"name":"My Prompt"}',
                'Geechan - Universal Roleplay (V5.0) (copy).json': '{"name":"Edited copy of an older bundled prompt"}',
            });
        }

        beforeEach(async () => {
            await run();
            fs.appendFileSync(contentLogPath(FIRST_HANDLE), `\n${noLongerBundledLogEntry}`);
        });

        test('removes each one that the content log lists', async () => {
            const presets = writeObsoletePresets(FIRST_HANDLE);
            listObsoletePresetsInContentLog(FIRST_HANDLE);

            await run();

            expect(stillPresent(presets)).toEqual([]);
            expect(console.error).not.toHaveBeenCalled();
        });

        test('removes them from the content log and keeps the other entries in order', async () => {
            const log = readContentLog(FIRST_HANDLE);
            writeObsoletePresets(FIRST_HANDLE);
            listObsoletePresetsInContentLog(FIRST_HANDLE);

            await run();

            expect(readContentLog(FIRST_HANDLE)).toBe(log);
        });

        test('keeps user presets and all other content', async () => {
            writeUserPresets(FIRST_HANDLE);
            const presetKeys = writeObsoletePresets(FIRST_HANDLE).map(toSnapshotKey);
            listObsoletePresetsInContentLog(FIRST_HANDLE);
            const logKey = toSnapshotKey(contentLogPath(FIRST_HANDLE));
            const before = snapshotTree(sandbox.root);

            await run();

            expect(without(snapshotTree(sandbox.root), logKey)).toEqual(without(before, logKey, ...presetKeys));
        });

        test('removes them for every user', async () => {
            await addSecondUser();
            const presets = [FIRST_HANDLE, SECOND_HANDLE].flatMap(handle => {
                listObsoletePresetsInContentLog(handle);
                return writeObsoletePresets(handle);
            });

            await run();

            expect(stillPresent(presets)).toEqual([]);
        });

        test('keeps files with obsolete names that the content log does not list', async () => {
            writeObsoletePresets(FIRST_HANDLE);
            const before = snapshotTree(sandbox.root);

            await run();

            expect(snapshotTree(sandbox.root)).toEqual(before);
        });

        test('removes the log entries of obsolete presets that the user already deleted', async () => {
            const log = readContentLog(FIRST_HANDLE);
            listObsoletePresetsInContentLog(FIRST_HANDLE);
            const logKey = toSnapshotKey(contentLogPath(FIRST_HANDLE));
            const before = snapshotTree(sandbox.root);

            await run();

            expect(readContentLog(FIRST_HANDLE)).toBe(log);
            expect(without(snapshotTree(sandbox.root), logKey)).toEqual(without(before, logKey));
            expect(console.error).not.toHaveBeenCalled();
        });

        test('changes nothing when it runs a second time', async () => {
            writeUserPresets(FIRST_HANDLE);
            writeObsoletePresets(FIRST_HANDLE);
            listObsoletePresetsInContentLog(FIRST_HANDLE);
            await run();
            const before = snapshotTree(sandbox.root);
            jest.clearAllMocks();

            await run();

            expect(snapshotTree(sandbox.root)).toEqual(before);
            expect(console.error).not.toHaveBeenCalled();
        });
    });
});
