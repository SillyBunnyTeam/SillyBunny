import { afterEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    applyServerPluginRelease,
    finalizeServerPluginRelease,
    recoverInterruptedServerPluginUpdates,
    rollbackServerPluginRelease,
    validateServerPluginUpdatePayload,
} from '../src/server-plugin-update-helper.js';
import { getServerPluginReleaseDigest, SERVER_PLUGIN_RELEASE_MARKER } from '../src/server-plugin-manager.js';

const tempDirectories = [];

function createFixture({ preservePaths = ['.cursor-key'] } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-server-plugin-helper-'));
    tempDirectories.push(root);
    const pluginsRoot = path.join(root, 'plugins');
    const pluginPath = path.join(pluginsRoot, 'ExamplePlugin');
    const updatesRoot = path.join(pluginsRoot, '.server-plugin-updates');
    const stagingRoot = path.join(updatesRoot, 'ExamplePlugin-stage');
    const releaseRoot = path.join(stagingRoot, 'release');
    const lockPath = path.join(updatesRoot, 'active.lock');
    const transactionId = '11111111-1111-4111-8111-111111111111';
    const journalPath = path.join(updatesRoot, `${transactionId}.jsonl`);
    fs.mkdirSync(pluginPath, { recursive: true });
    fs.mkdirSync(releaseRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginPath, 'package.json'), JSON.stringify({ name: 'example-server-plugin', version: '1.0.0' }));
    fs.writeFileSync(path.join(pluginPath, 'stale.txt'), 'remove me');
    fs.writeFileSync(path.join(pluginPath, '.cursor-key'), 'persistent-secret', { mode: 0o600 });
    fs.writeFileSync(path.join(releaseRoot, 'package.json'), JSON.stringify({
        name: 'example-server-plugin',
        version: '2.0.0',
        sillybunny: {
            serverPlugin: {
                id: 'example-server-plugin',
                preservePaths,
            },
        },
    }));
    fs.writeFileSync(path.join(releaseRoot, 'fresh.txt'), 'new release');
    fs.writeFileSync(path.join(releaseRoot, SERVER_PLUGIN_RELEASE_MARKER), JSON.stringify({
        packageName: 'example-server-plugin',
        version: '2.0.0',
        tag: 'v2.0.0',
        commit: 'a'.repeat(40),
    }));
    const releaseDigest = getServerPluginReleaseDigest(releaseRoot, { excludePaths: preservePaths });
    const payload = {
        transactionId,
        pluginsRoot,
        directoryName: 'ExamplePlugin',
        pluginPath,
        stagingRoot,
        releaseRoot,
        lockPath,
        journalPath,
        targetVersion: '2.0.0',
        tag: 'v2.0.0',
        commit: 'a'.repeat(40),
        preservePaths,
        expectedPluginId: 'example-server-plugin',
        releaseDigest,
    };
    fs.writeFileSync(lockPath, JSON.stringify({ schemaVersion: 1, transactionId, pid: process.pid }));
    fs.writeFileSync(journalPath, `${JSON.stringify({ schemaVersion: 1, state: 'staged', ...payload })}\n`);

    return { root, pluginsRoot, pluginPath, stagingRoot, releaseRoot, lockPath, journalPath, payload };
}

afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('server plugin update helper', () => {
    test('removes a pre-journal staging directory left by a stopped worker', () => {
        const fixture = createFixture();
        fs.rmSync(fixture.journalPath);

        recoverInterruptedServerPluginUpdates(fixture.pluginsRoot);

        expect(fs.existsSync(fixture.stagingRoot)).toBe(false);
        expect(fs.existsSync(fixture.lockPath)).toBe(false);
        expect(fs.existsSync(fixture.pluginPath)).toBe(true);
    });

    test('copies shutdown-time state and atomically replaces the complete plugin directory', () => {
        const fixture = createFixture();
        const transaction = applyServerPluginRelease(fixture.payload);

        expect(fs.readFileSync(path.join(fixture.pluginPath, 'fresh.txt'), 'utf8')).toBe('new release');
        expect(fs.readFileSync(path.join(fixture.pluginPath, '.cursor-key'), 'utf8')).toBe('persistent-secret');
        expect(fs.existsSync(path.join(fixture.pluginPath, 'stale.txt'))).toBe(false);
        expect(fs.readFileSync(path.join(transaction.backupPath, 'stale.txt'), 'utf8')).toBe('remove me');
        expect(fs.existsSync(fixture.stagingRoot)).toBe(false);
        expect(fs.existsSync(fixture.lockPath)).toBe(true);

        finalizeServerPluginRelease(transaction);
        expect(fs.existsSync(fixture.lockPath)).toBe(false);
        expect(fs.existsSync(fixture.journalPath)).toBe(false);
    });

    test('copies a nested preserved path whose parent is absent from the release', () => {
        const fixture = createFixture({ preservePaths: ['state/key'] });
        fs.mkdirSync(path.join(fixture.pluginPath, 'state'));
        fs.writeFileSync(path.join(fixture.pluginPath, 'state', 'key'), 'runtime-state');

        const transaction = applyServerPluginRelease(fixture.payload);

        expect(fs.readFileSync(path.join(fixture.pluginPath, 'state', 'key'), 'utf8')).toBe('runtime-state');
        finalizeServerPluginRelease(transaction);
    });

    test('restores the previous plugin after activation validation fails', () => {
        const fixture = createFixture();
        const transaction = applyServerPluginRelease(fixture.payload);
        const failedPath = rollbackServerPluginRelease(transaction, 'plugin did not load');

        expect(fs.readFileSync(path.join(fixture.pluginPath, 'stale.txt'), 'utf8')).toBe('remove me');
        expect(fs.readFileSync(path.join(failedPath, 'fresh.txt'), 'utf8')).toBe('new release');
        expect(fs.existsSync(fixture.lockPath)).toBe(false);
    });

    test('rejects staged metadata that differs from the request', () => {
        const fixture = createFixture();
        fixture.payload.commit = 'b'.repeat(40);

        expect(() => validateServerPluginUpdatePayload(fixture.payload)).toThrow('does not match');
    });

    test('rejects a symlink inserted into the verified release without writing outside staging', () => {
        const fixture = createFixture({ preservePaths: ['state/key'] });
        const outside = path.join(fixture.root, 'outside');
        fs.mkdirSync(path.join(fixture.pluginPath, 'state'));
        fs.writeFileSync(path.join(fixture.pluginPath, 'state', 'key'), 'secret');
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(fixture.releaseRoot, 'state'), 'dir');

        expect(() => applyServerPluginRelease(fixture.payload)).toThrow('unsafe symbolic link');
        expect(fs.existsSync(path.join(outside, 'key'))).toBe(false);
        expect(fs.readFileSync(path.join(fixture.pluginPath, 'stale.txt'), 'utf8')).toBe('remove me');
    });

    test('rejects symlinked preserve source ancestors', () => {
        const fixture = createFixture({ preservePaths: ['state/key'] });
        const outside = path.join(fixture.root, 'outside-state');
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, 'key'), 'external-secret');
        fs.symlinkSync(outside, path.join(fixture.pluginPath, 'state'), 'dir');

        expect(() => applyServerPluginRelease(fixture.payload)).toThrow('cannot contain symbolic links');
        expect(fs.readFileSync(path.join(fixture.pluginPath, 'stale.txt'), 'utf8')).toBe('remove me');
    });

    test('rejects a post-staging preserve file when the installed state is absent', () => {
        const fixture = createFixture();
        fs.rmSync(path.join(fixture.pluginPath, '.cursor-key'));
        fs.writeFileSync(path.join(fixture.releaseRoot, '.cursor-key'), 'unverified-state');

        expect(() => applyServerPluginRelease(fixture.payload)).toThrow('already contains preserved path');
        expect(fs.readFileSync(path.join(fixture.pluginPath, 'stale.txt'), 'utf8')).toBe('remove me');
    });

    test('rejects a symlinked backup directory', () => {
        const fixture = createFixture();
        const outside = path.join(fixture.root, 'outside-backups');
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(fixture.pluginsRoot, '.server-plugin-backups'), 'dir');

        expect(() => applyServerPluginRelease(fixture.payload)).toThrow('must be a regular directory');
        expect(fs.readFileSync(path.join(fixture.pluginPath, 'stale.txt'), 'utf8')).toBe('remove me');
    });

    test('restores the previous plugin from the journal after interrupted activation', () => {
        const fixture = createFixture();
        applyServerPluginRelease(fixture.payload);

        expect(fs.readFileSync(path.join(fixture.pluginPath, 'fresh.txt'), 'utf8')).toBe('new release');
        expect(recoverInterruptedServerPluginUpdates(fixture.pluginsRoot)).toEqual([fixture.payload.transactionId]);
        expect(fs.readFileSync(path.join(fixture.pluginPath, 'stale.txt'), 'utf8')).toBe('remove me');
        expect(fs.existsSync(fixture.lockPath)).toBe(false);
        expect(fs.existsSync(fixture.journalPath)).toBe(false);
    });

    test('recognizes a rollback completed before its final journal record', () => {
        const fixture = createFixture();
        const transaction = applyServerPluginRelease(fixture.payload);
        const failedPath = path.join(transaction.backupRoot, 'ExamplePlugin-failed-before-journal');
        const latest = fs.readFileSync(fixture.journalPath, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
        fs.appendFileSync(fixture.journalPath, `${JSON.stringify({
            ...latest,
            state: 'rolling-back',
            failedPath,
            rollbackHadLiveTarget: true,
        })}\n`);
        fs.renameSync(fixture.pluginPath, failedPath);
        fs.renameSync(transaction.backupPath, fixture.pluginPath);

        expect(recoverInterruptedServerPluginUpdates(fixture.pluginsRoot)).toEqual([fixture.payload.transactionId]);
        expect(fs.readFileSync(path.join(fixture.pluginPath, 'stale.txt'), 'utf8')).toBe('remove me');
        expect(fs.readFileSync(path.join(failedPath, 'fresh.txt'), 'utf8')).toBe('new release');
        expect(fs.existsSync(fixture.lockPath)).toBe(false);
        expect(fs.existsSync(fixture.journalPath)).toBe(false);
    });

    test('uses a valid journal to recover a partial lock after a crash', () => {
        const fixture = createFixture();
        applyServerPluginRelease(fixture.payload);
        fs.writeFileSync(fixture.lockPath, '');

        expect(recoverInterruptedServerPluginUpdates(fixture.pluginsRoot)).toEqual([fixture.payload.transactionId]);
        expect(fs.readFileSync(path.join(fixture.pluginPath, 'stale.txt'), 'utf8')).toBe('remove me');
        expect(fs.existsSync(fixture.lockPath)).toBe(false);
    });

    test('refuses recovery while another live supervisor owns the transaction', () => {
        const fixture = createFixture();
        fs.writeFileSync(fixture.lockPath, JSON.stringify({
            schemaVersion: 1,
            transactionId: fixture.payload.transactionId,
            pid: process.ppid,
        }));

        expect(() => recoverInterruptedServerPluginUpdates(fixture.pluginsRoot)).toThrow('Another SillyBunny supervisor owns');
        expect(fs.existsSync(fixture.lockPath)).toBe(true);
        expect(fs.existsSync(fixture.journalPath)).toBe(true);
    });

    test('fails closed when an unvalidated live release has lost its rollback backup', () => {
        const fixture = createFixture();
        const transaction = applyServerPluginRelease(fixture.payload);
        fs.rmSync(transaction.backupPath, { recursive: true, force: true });

        expect(() => recoverInterruptedServerPluginUpdates(fixture.pluginsRoot)).toThrow('rollback backup is missing');
        expect(fs.existsSync(fixture.lockPath)).toBe(true);
        expect(fs.existsSync(fixture.journalPath)).toBe(true);
    });

    test('never removes an update lock owned by a different transaction', () => {
        const fixture = createFixture();
        const transaction = applyServerPluginRelease(fixture.payload);
        const otherTransactionId = '22222222-2222-4222-8222-222222222222';
        fs.writeFileSync(fixture.lockPath, JSON.stringify({
            schemaVersion: 1,
            transactionId: otherTransactionId,
            pid: process.pid,
        }));

        expect(() => finalizeServerPluginRelease(transaction)).toThrow('belongs to another transaction');
        expect(JSON.parse(fs.readFileSync(fixture.lockPath, 'utf8')).transactionId).toBe(otherTransactionId);
    });
});
