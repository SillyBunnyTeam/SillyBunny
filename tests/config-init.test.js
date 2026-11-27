import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { addMissingConfigValues } from '../src/config-init.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const oldEnvKey = 'SILLYTAVERN_DISABLETHUMBNAILS';
const newEnvKey = 'SILLYTAVERN_THUMBNAILS_ENABLED';

describe('addMissingConfigValues', () => {
    let tempDirectory;
    let configPath;

    beforeEach(() => {
        tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-config-'));
        configPath = path.join(tempDirectory, 'config.yaml');
        fs.writeFileSync(configPath, '{}\n');
        delete process.env[oldEnvKey];
        delete process.env[newEnvKey];
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        delete process.env[oldEnvKey];
        delete process.env[newEnvKey];
        fs.rmSync(tempDirectory, { recursive: true, force: true });
        jest.restoreAllMocks();
    });

    test.each([
        ['false', 'true'],
        ['true', 'false'],
    ])('migrates the boolean environment value %s to %s', (oldValue, newValue) => {
        process.env[oldEnvKey] = oldValue;

        addMissingConfigValues(configPath);

        expect(process.env[newEnvKey]).toBe(newValue);
        expect(process.env[oldEnvKey]).toBeUndefined();
    });

    test('enables hostWhitelist and empties cors.origin on a fresh install', () => {
        fs.rmSync(configPath, { force: true });

        addMissingConfigValues(configPath);

        const created = yaml.parse(fs.readFileSync(configPath, 'utf8'));
        expect(created.hostWhitelist.enabled).toBe(true);
        expect(created.hostWhitelist.scan).toBe(true);
        expect(created.cors.origin).toEqual([]);
    });

    test('preserves hostWhitelist.enabled=false for an existing config missing the hostWhitelist key', () => {
        fs.writeFileSync(configPath, 'port: 4444\n');

        addMissingConfigValues(configPath);

        const upgraded = yaml.parse(fs.readFileSync(configPath, 'utf8'));
        expect(upgraded.hostWhitelist.enabled).toBe(false);
        expect(upgraded.hostWhitelist.scan).toBe(true);
        expect(upgraded.hostWhitelist.hosts).toEqual([]);

        const firstSnapshot = fs.readFileSync(configPath, 'utf8');
        addMissingConfigValues(configPath);
        expect(fs.readFileSync(configPath, 'utf8')).toBe(firstSnapshot);
    });

    test('keeps existing hostWhitelist and cors.origin values untouched on upgrade', () => {
        fs.writeFileSync(configPath, 'hostWhitelist:\n  enabled: false\ncors:\n  origin:\n    - "null"\n');

        addMissingConfigValues(configPath);

        const upgraded = yaml.parse(fs.readFileSync(configPath, 'utf8'));
        expect(upgraded.hostWhitelist.enabled).toBe(false);
        expect(upgraded.cors.origin).toEqual(['null']);
    });

    test('keeps Remote-Link.cmd compatible with default hostWhitelist and defaults CORS origin to []', () => {
        const remoteLink = fs.readFileSync(path.join(repoRoot, 'Remote-Link.cmd'), 'utf8');
        const serverMain = fs.readFileSync(path.join(repoRoot, 'src', 'server-main.js'), 'utf8');

        expect(remoteLink).toContain('--http-host-header localhost:4444');
        expect(serverMain).toContain('getConfigValue(\'cors.origin\', [])');
        expect(serverMain).toContain('corsOriginList.includes(\'null\')');
    });
});
