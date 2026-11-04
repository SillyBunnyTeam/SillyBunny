import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import { createInstallSandbox, writeFiles } from './util/install-sandbox.js';

const sandbox = createInstallSandbox('sillybunny-config-migration');

const { default: yaml } = await import('yaml');
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
