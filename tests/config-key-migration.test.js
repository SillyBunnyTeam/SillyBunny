import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import { createInstallSandbox, snapshotTree, writeFiles } from './util/install-sandbox.js';

const sandbox = createInstallSandbox('sillybunny-config-migration');

const { default: yaml } = await import('yaml');
const { default: _ } = await import('lodash');
const { keyToEnv } = await import('../src/util.js');
const { addMissingConfigValues } = await import('../src/config-init.js');

const defaultConfig = `port: 8000
listen: false
thumbnails:
  enabled: true
  quality: 95
  format: jpg
backups:
  chat:
    enabled: true
    maxTotalBackups: 25
  common:
    numberOfBackups: 50
extensions:
  enabled: true
performance:
  memoryCacheCapacity: 100mb
newOption:
  enabled: false
`;

const oldConfig = `# settings kept from an old install
port: 9100
listen: true
disableThumbnails: true
thumbnailsQuality: 70
avatarThumbnailsPng: true
disableChatBackup: true
numberOfBackups: 12
enableExtensions: false
cardsCacheCapacity: 256
`;

const deprecatedEnvKey = 'SILLYTAVERN_DISABLETHUMBNAILS';
const currentEnvKey = 'SILLYTAVERN_THUMBNAILS_ENABLED';
const originalEnvironment = Object.fromEntries([deprecatedEnvKey, currentEnvKey].map(key => [key, process.env[key]]));

const configPath = () => path.join(sandbox.root, 'config.yaml');
const readConfig = () => yaml.parse(fs.readFileSync(configPath(), 'utf8'));

beforeEach(() => {
    for (const method of ['debug', 'info', 'log', 'warn', 'error']) {
        jest.spyOn(console, method).mockImplementation(() => {});
    }
    delete process.env[deprecatedEnvKey];
    delete process.env[currentEnvKey];
    writeFiles(sandbox.installDir, { 'default/config.yaml': defaultConfig });
});

afterEach(() => {
    jest.restoreAllMocks();
    for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
});

afterAll(() => {
    sandbox.dispose();
});

describe('addMissingConfigValues', () => {
    test('moves renamed settings to their new keys and converts their values', () => {
        fs.writeFileSync(configPath(), oldConfig);

        addMissingConfigValues(configPath());

        const config = readConfig();
        expect(config.thumbnails).toEqual({ enabled: false, quality: 70, format: 'png' });
        expect(config.backups).toEqual({ chat: { enabled: false, maxTotalBackups: 25 }, common: { numberOfBackups: 12 } });
        expect(config.extensions).toEqual({ enabled: false });
        expect(config.performance).toEqual({ memoryCacheCapacity: '256mb' });
    });

    test('removes the old keys it migrated', () => {
        fs.writeFileSync(configPath(), oldConfig);

        addMissingConfigValues(configPath());

        const config = readConfig();
        const oldKeys = ['disableThumbnails', 'thumbnailsQuality', 'avatarThumbnailsPng', 'disableChatBackup', 'numberOfBackups', 'enableExtensions', 'cardsCacheCapacity'];
        expect(oldKeys.filter(key => Object.hasOwn(config, key))).toEqual([]);
    });

    test('keeps the values the user already set and adds the options that are missing', () => {
        fs.writeFileSync(configPath(), oldConfig);

        addMissingConfigValues(configPath());

        const config = readConfig();
        expect(config.port).toBe(9100);
        expect(config.listen).toBe(true);
        expect(config.newOption).toEqual({ enabled: false });
    });

    test('rewrites nothing when it runs a second time', () => {
        fs.writeFileSync(configPath(), oldConfig);
        addMissingConfigValues(configPath());
        const afterFirstRun = fs.readFileSync(configPath(), 'utf8');

        addMissingConfigValues(configPath());

        expect(fs.readFileSync(configPath(), 'utf8')).toBe(afterFirstRun);
    });

    test('leaves a config that already has every option exactly as it is', () => {
        const current = [
            '# my own notes',
            'port: 9100',
            'listen: true',
            'thumbnails: {enabled: false, quality: 70, format: png}',
            'backups: {chat: {enabled: true, maxTotalBackups: 25}, common: {numberOfBackups: 50}}',
            'extensions: {enabled: true}',
            'performance: {memoryCacheCapacity: 100mb}',
            'newOption: {enabled: true}',
            '',
        ].join('\n');
        fs.writeFileSync(configPath(), current);

        addMissingConfigValues(configPath());

        expect(fs.readFileSync(configPath(), 'utf8')).toBe(current);
    });

    test('creates a config with the default options when there is none', () => {
        fs.rmSync(configPath(), { force: true });

        addMissingConfigValues(configPath());

        expect(readConfig()).toEqual(yaml.parse(defaultConfig));
    });

    test('redirects a deprecated environment variable to its new name and converts the value', () => {
        fs.writeFileSync(configPath(), defaultConfig);
        process.env[deprecatedEnvKey] = 'false';

        addMissingConfigValues(configPath());

        expect(process.env[currentEnvKey]).toBe('true');
        expect(process.env[deprecatedEnvKey]).toBeUndefined();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(deprecatedEnvKey));
    });

    test('prefers the new environment variable when both are set', () => {
        fs.writeFileSync(configPath(), defaultConfig);
        process.env[deprecatedEnvKey] = 'false';
        process.env[currentEnvKey] = 'false';

        addMissingConfigValues(configPath());

        expect(process.env[currentEnvKey]).toBe('false');
    });
});

describe('addMissingConfigValues for each renamed or removed setting', () => {
    const renamedSettings = [
        ['disableThumbnails', true, 'thumbnails.enabled', false],
        ['disableThumbnails', false, 'thumbnails.enabled', true],
        ['thumbnailsQuality', 70, 'thumbnails.quality', 70],
        ['avatarThumbnailsPng', true, 'thumbnails.format', 'png'],
        ['avatarThumbnailsPng', false, 'thumbnails.format', 'jpg'],
        ['disableChatBackup', true, 'backups.chat.enabled', false],
        ['disableChatBackup', false, 'backups.chat.enabled', true],
        ['numberOfBackups', 12, 'backups.common.numberOfBackups', 12],
        ['maxTotalChatBackups', 7, 'backups.chat.maxTotalBackups', 7],
        ['chatBackupThrottleInterval', 30000, 'backups.chat.throttleInterval', 30000],
        ['enableExtensions', false, 'extensions.enabled', false],
        ['enableExtensionsAutoUpdate', false, 'extensions.autoUpdate', false],
        ['extras.disableAutoDownload', true, 'extensions.models.autoDownload', false],
        ['extras.disableAutoDownload', false, 'extensions.models.autoDownload', true],
        ['extras.classificationModel', 'synthetic/classification', 'extensions.models.classification', 'synthetic/classification'],
        ['extras.captioningModel', 'synthetic/captioning', 'extensions.models.captioning', 'synthetic/captioning'],
        ['extras.embeddingModel', 'synthetic/embedding', 'extensions.models.embedding', 'synthetic/embedding'],
        ['extras.speechToTextModel', 'synthetic/speech-to-text', 'extensions.models.speechToText', 'synthetic/speech-to-text'],
        ['extras.textToSpeechModel', 'synthetic/text-to-speech', 'extensions.models.textToSpeech', 'synthetic/text-to-speech'],
        ['minLogLevel', 3, 'logging.minLogLevel', 3],
        ['cardsCacheCapacity', 256, 'performance.memoryCacheCapacity', '256mb'],
        ['autheliaAuth', true, 'sso.autheliaAuth', true],
        ['authentikAuth', true, 'sso.authentikAuth', true],
    ];
    const renamedEnvironmentVariables = renamedSettings.map(([oldKey, oldValue, newKey, newValue]) => [keyToEnv(oldKey), String(oldValue), keyToEnv(newKey), String(newValue)]);
    const removedSettings = [
        ['cookieSecret', 'synthetic-cookie-secret'],
        ['extras.promptExpansionModel', 'synthetic/prompt-expansion'],
    ];
    const environmentKeys = [...new Set(renamedEnvironmentVariables.flatMap(([oldEnvKey, , newEnvKey]) => [oldEnvKey, newEnvKey]))];
    const savedEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
    const printedText = () => JSON.stringify(['debug', 'info', 'log', 'warn', 'error'].map(method => console[method].mock.calls));

    beforeEach(() => {
        for (const key of environmentKeys) {
            delete process.env[key];
        }
    });

    afterEach(() => {
        for (const [key, value] of Object.entries(savedEnvironment)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    });

    test.each(renamedSettings)('moves %s: %p to %s: %p', (oldKey, oldValue, newKey, newValue) => {
        fs.writeFileSync(configPath(), yaml.stringify(_.set({}, oldKey, oldValue)));

        addMissingConfigValues(configPath());

        const config = readConfig();
        expect(_.get(config, newKey)).toEqual(newValue);
        expect(_.has(config, oldKey)).toBe(false);
    });

    test.each(renamedEnvironmentVariables)('redirects %s=%s to %s=%s', (oldEnvKey, oldValue, newEnvKey, newValue) => {
        fs.writeFileSync(configPath(), defaultConfig);
        process.env[oldEnvKey] = oldValue;

        addMissingConfigValues(configPath());

        expect(process.env[newEnvKey]).toBe(newValue);
        expect(process.env[oldEnvKey]).toBeUndefined();
    });

    test.each(removedSettings)('removes %s from a config that needs no other change', (key, value) => {
        fs.writeFileSync(configPath(), `${defaultConfig}${yaml.stringify(_.set({}, key, value))}`);

        addMissingConfigValues(configPath());

        expect(_.has(readConfig(), key)).toBe(false);
        expect(fs.readFileSync(configPath(), 'utf8')).not.toContain(value);
    });

    test.each(removedSettings)('does not print the value of %s when it removes it', (key, value) => {
        fs.writeFileSync(configPath(), `${defaultConfig}${yaml.stringify(_.set({}, key, value))}`);

        addMissingConfigValues(configPath());

        expect(printedText()).not.toContain(value);
    });
});

describe('npm run init', () => {
    const legacyConfig = `const port = 9100;
const whitelist = ['127.0.0.1', '::1'];
const extras = {
    classificationModel: 'synthetic/classification',
};

module.exports = {
    port,
    listen: true,
    whitelist,
    extras,
};
`;
    const installPath = name => path.join(sandbox.installDir, name);
    const readInstalledConfig = () => yaml.parse(fs.readFileSync(installPath('config.yaml'), 'utf8'));
    const legacyFileNames = () => fs.readdirSync(sandbox.installDir).filter(name => name.startsWith('config.conf'));

    async function runInit() {
        jest.resetModules();
        const { serverDirectory } = await import('../src/server-directory.js');
        if (serverDirectory !== sandbox.installDir) {
            throw new Error('The install sandbox does not replace serverDirectory, so npm run init would change the real install folder.');
        }
        await import('../src/server-init.js');
    }

    beforeEach(() => {
        sandbox.clear();
        writeFiles(sandbox.installDir, { 'default/config.yaml': defaultConfig });
        fs.mkdirSync(installPath('default/public'));
    });

    test('turns config.conf into config.yaml with its settings under the current keys', async () => {
        fs.writeFileSync(installPath('config.conf'), legacyConfig);

        await runInit();

        expect(readInstalledConfig()).toMatchObject({
            port: 9100,
            listen: true,
            whitelist: ['127.0.0.1', '::1'],
            extensions: { models: { classification: 'synthetic/classification' } },
        });
        expect(console.error).not.toHaveBeenCalled();
    });

    test('keeps the original config.conf as config.conf.bak and no other copy', async () => {
        fs.writeFileSync(installPath('config.conf'), legacyConfig);

        await runInit();

        expect(legacyFileNames()).toEqual(['config.conf.bak']);
        expect(fs.readFileSync(installPath('config.conf.bak'), 'utf8')).toBe(legacyConfig);
    });

    test('leaves config.conf and config.yaml as they are when both exist', async () => {
        fs.writeFileSync(installPath('config.conf'), legacyConfig);
        fs.writeFileSync(installPath('config.yaml'), defaultConfig);

        await runInit();

        expect(legacyFileNames()).toEqual(['config.conf']);
        expect(fs.readFileSync(installPath('config.conf'), 'utf8')).toBe(legacyConfig);
        expect(fs.readFileSync(installPath('config.yaml'), 'utf8')).toBe(defaultConfig);
    });

    test('keeps later edits to the converted config.yaml when it runs again', async () => {
        fs.writeFileSync(installPath('config.conf'), legacyConfig);
        await runInit();
        fs.writeFileSync(installPath('config.yaml'), yaml.stringify({ ...readInstalledConfig(), port: 9200 }));
        const before = snapshotTree(sandbox.installDir);
        jest.clearAllMocks();

        await runInit();

        expect(snapshotTree(sandbox.installDir)).toEqual(before);
        expect(console.error).not.toHaveBeenCalled();
    });

    test('converts nothing and reports no error when there is no config.conf', async () => {
        await runInit();

        expect(legacyFileNames()).toEqual([]);
        expect(fs.readFileSync(installPath('config.yaml'), 'utf8')).toBe(defaultConfig);
        expect(console.error).not.toHaveBeenCalled();
    });
});
