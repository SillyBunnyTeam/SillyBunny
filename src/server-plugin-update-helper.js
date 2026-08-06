import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { isPathInside } from './path-containment.js';
import {
    acquireServerPluginUpdateMutex,
    getServerPluginReleaseDigest,
    releaseServerPluginUpdateLock,
    SERVER_PLUGIN_BACKUP_DIRECTORY,
    SERVER_PLUGIN_RELEASE_MARKER,
    SERVER_PLUGIN_UPDATE_DIRECTORY,
    SERVER_PLUGIN_UPDATE_MUTEX,
    syncServerPluginDirectory,
    syncServerPluginTree,
    validateServerPluginPreservePaths,
    validateServerPluginUpdateLock,
} from './server-plugin-manager.js';

const UPDATE_LOCK_NAME = 'active.lock';
const JOURNAL_SUFFIX = '.jsonl';
const TRANSACTION_PATTERN = /^[0-9a-f-]{36}$/i;
const RECOVERABLE_STATES = new Set([
    'staged', 'applying', 'original-moved', 'activation-pending', 'activated',
    'rolling-back', 'rolled-back', 'discarded',
]);

function createTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function appendLog(logPath, message) {
    try {
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
    } catch (error) {
        console.error(`Failed to append server plugin update log ${logPath}.`, error);
    }
}

function lstatIfPresent(targetPath) {
    try {
        return fs.lstatSync(targetPath);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

function validateRegularDirectory(directoryPath, description) {
    const stat = fs.lstatSync(directoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directoryPath) !== directoryPath) {
        throw new Error(`${description} must be a regular directory.`);
    }
}

function validateRegularFile(filePath, description) {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`${description} must be a regular file.`);
    }
}

function ensureManagedDirectory(pluginsRoot, directoryName) {
    const directoryPath = path.join(pluginsRoot, directoryName);
    if (!fs.existsSync(directoryPath)) {
        fs.mkdirSync(directoryPath, { mode: 0o700 });
        syncServerPluginDirectory(pluginsRoot);
    }
    validateRegularDirectory(directoryPath, directoryName);
    return directoryPath;
}

function assertNoSymlinks(targetPath) {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) {
        throw new Error(`Preserved server plugin state cannot contain symbolic links: ${targetPath}.`);
    }
    if (!stat.isDirectory()) {
        return;
    }
    for (const entry of fs.readdirSync(targetPath)) {
        assertNoSymlinks(path.join(targetPath, entry));
    }
}

function assertSafeSourcePath(pluginPath, relativePath) {
    let currentPath = pluginPath;
    for (const part of relativePath.split(path.sep)) {
        currentPath = path.join(currentPath, part);
        const stat = fs.lstatSync(currentPath);
        if (stat.isSymbolicLink()) {
            throw new Error(`Preserved server plugin state cannot contain symbolic links: ${relativePath}.`);
        }
    }
    assertNoSymlinks(currentPath);
}

function ensureSafeDestinationParent(releaseRoot, relativePath) {
    const parts = relativePath.split(path.sep);
    let currentPath = releaseRoot;

    for (const part of parts.slice(0, -1)) {
        currentPath = path.join(currentPath, part);
        const stat = lstatIfPresent(currentPath);
        if (!stat) {
            fs.mkdirSync(currentPath, { mode: 0o700 });
            continue;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error(`Preserve path has an unsafe release destination: ${relativePath}.`);
        }
    }
}

function copyPreservedState(validated) {
    for (const relativePath of validated.preservePaths) {
        const sourcePath = path.resolve(validated.pluginPath, relativePath);
        const destinationPath = path.resolve(validated.releaseRoot, relativePath);

        if (!isPathInside(validated.pluginPath, sourcePath) || !isPathInside(validated.releaseRoot, destinationPath)) {
            throw new Error(`Preserve path escapes the server plugin directory: ${relativePath}.`);
        }

        ensureSafeDestinationParent(validated.releaseRoot, relativePath);
        if (lstatIfPresent(destinationPath)) {
            throw new Error(`Release already contains preserved path ${relativePath}.`);
        }

        const sourceStat = lstatIfPresent(sourcePath);
        if (!sourceStat) {
            continue;
        }

        assertSafeSourcePath(validated.pluginPath, relativePath);
        fs.cpSync(sourcePath, destinationPath, { recursive: true, force: false, preserveTimestamps: true });
    }
}

function journalFields(transaction) {
    const fields = [
        'transactionId', 'pluginsRoot', 'directoryName', 'pluginPath', 'stagingRoot', 'releaseRoot',
        'lockPath', 'journalPath', 'targetVersion', 'tag', 'commit', 'preservePaths',
        'expectedPluginId', 'releaseDigest', 'backupRoot', 'backupPath', 'logPath',
    ];
    return Object.fromEntries(fields
        .filter(field => transaction[field] !== undefined)
        .map(field => [field, transaction[field]]));
}

function appendJournal(transaction, state, extra = {}) {
    const record = {
        schemaVersion: 1,
        state,
        recordedAt: new Date().toISOString(),
        ...journalFields(transaction),
        ...extra,
    };
    const descriptor = fs.openSync(transaction.journalPath, 'a');
    try {
        fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
    return record;
}

function readLatestJournal(journalPath) {
    validateRegularFile(journalPath, 'Server plugin update journal');
    const lines = fs.readFileSync(journalPath, 'utf8').split('\n').filter(line => line.trim() !== '');
    const records = [];
    for (let index = 0; index < lines.length; index++) {
        try {
            records.push(JSON.parse(lines[index]));
        } catch (error) {
            if (index !== lines.length - 1) {
                throw error;
            }
        }
    }
    if (records.length === 0) {
        throw new Error('Server plugin update journal is empty or invalid.');
    }
    return records.at(-1);
}

function journalMatchesPayload(journal, payload) {
    const scalarFields = [
        'transactionId', 'pluginsRoot', 'directoryName', 'pluginPath', 'stagingRoot', 'releaseRoot',
        'lockPath', 'journalPath', 'targetVersion', 'tag', 'commit', 'expectedPluginId', 'releaseDigest',
    ];
    return journal?.schemaVersion === 1
        && journal?.state === 'staged'
        && scalarFields.every(field => journal[field] === payload[field])
        && JSON.stringify(journal.preservePaths) === JSON.stringify(payload.preservePaths);
}

function cleanupTransaction(transaction, { removeStaging = true } = {}) {
    if (removeStaging) {
        fs.rmSync(transaction.stagingRoot, { recursive: true, force: true });
        syncServerPluginDirectory(path.dirname(transaction.stagingRoot));
    }
    releaseServerPluginUpdateLock(transaction.lockPath, transaction.transactionId);
    fs.rmSync(transaction.journalPath, { force: true });
    syncServerPluginDirectory(path.dirname(transaction.journalPath));
}

export function validateServerPluginUpdatePayload(payload) {
    const pluginsRoot = path.resolve(String(payload?.pluginsRoot ?? ''));
    const directoryName = String(payload?.directoryName ?? '').trim();
    const pluginPath = path.resolve(pluginsRoot, directoryName);
    const stagingRoot = path.resolve(String(payload?.stagingRoot ?? ''));
    const releaseRoot = path.resolve(String(payload?.releaseRoot ?? ''));
    const lockPath = path.resolve(String(payload?.lockPath ?? ''));
    const journalPath = path.resolve(String(payload?.journalPath ?? ''));
    const updatesRoot = path.join(pluginsRoot, SERVER_PLUGIN_UPDATE_DIRECTORY);
    const transactionId = String(payload?.transactionId ?? '');
    const releaseDigest = String(payload?.releaseDigest ?? '');

    if (!TRANSACTION_PATTERN.test(transactionId)) {
        throw new Error('Server plugin update payload did not include a valid transaction ID.');
    }
    if (!directoryName || path.dirname(pluginPath) !== pluginsRoot) {
        throw new Error('Server plugin update payload did not identify a direct plugin directory.');
    }

    validateRegularDirectory(pluginsRoot, 'Plugins root');
    validateRegularDirectory(updatesRoot, 'Server plugin updates directory');
    validateRegularDirectory(pluginPath, 'Installed server plugin');
    validateRegularDirectory(stagingRoot, 'Server plugin staging root');
    validateRegularDirectory(releaseRoot, 'Staged server plugin release');

    if (!isPathInside(updatesRoot, stagingRoot) || !isPathInside(stagingRoot, releaseRoot)) {
        throw new Error('Server plugin release is outside the managed staging directory.');
    }
    if (lockPath !== path.join(updatesRoot, UPDATE_LOCK_NAME)) {
        throw new Error('Server plugin update lock path is invalid.');
    }
    if (journalPath !== path.join(updatesRoot, `${transactionId}${JOURNAL_SUFFIX}`)) {
        throw new Error('Server plugin update journal path is invalid.');
    }
    validateRegularFile(lockPath, 'Server plugin update lock');
    validateServerPluginUpdateLock(lockPath, transactionId);

    const markerPath = path.join(releaseRoot, SERVER_PLUGIN_RELEASE_MARKER);
    const packagePath = path.join(releaseRoot, 'package.json');
    validateRegularFile(markerPath, 'Server plugin release marker');
    validateRegularFile(packagePath, 'Staged server plugin package.json');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const preservePaths = validateServerPluginPreservePaths(packageJson);
    const expectedPluginId = String(packageJson?.sillybunny?.serverPlugin?.id ?? '');
    const journal = readLatestJournal(journalPath);

    if (
        !/^[0-9a-f]{64}$/i.test(releaseDigest)
        || marker.version !== payload?.targetVersion
        || marker.tag !== payload?.tag
        || marker.commit !== payload?.commit
        || packageJson.version !== payload?.targetVersion
        || packageJson.name !== marker.packageName
        || expectedPluginId !== payload?.expectedPluginId
        || JSON.stringify(preservePaths) !== JSON.stringify(payload?.preservePaths)
        || !journalMatchesPayload(journal, payload)
        || getServerPluginReleaseDigest(releaseRoot, { excludePaths: preservePaths }) !== releaseDigest
    ) {
        throw new Error('Staged server plugin release does not match the verified update request.');
    }

    return {
        transactionId,
        pluginsRoot,
        directoryName,
        pluginPath,
        stagingRoot,
        releaseRoot,
        lockPath,
        journalPath,
        preservePaths,
        expectedPluginId,
        releaseDigest,
        targetVersion: payload.targetVersion,
        tag: payload.tag,
        commit: payload.commit,
    };
}

function restoreAppliedTransaction(transaction, failedPath) {
    if (!lstatIfPresent(transaction.backupPath)) {
        return;
    }
    if (lstatIfPresent(transaction.pluginPath)) {
        fs.renameSync(transaction.pluginPath, failedPath);
        syncServerPluginDirectory(transaction.backupRoot);
        syncServerPluginDirectory(transaction.pluginsRoot);
    }
    fs.renameSync(transaction.backupPath, transaction.pluginPath);
    syncServerPluginDirectory(transaction.backupRoot);
    syncServerPluginDirectory(transaction.pluginsRoot);
}

export function applyServerPluginRelease(payload) {
    const validated = validateServerPluginUpdatePayload(payload);
    let backupRoot;
    try {
        backupRoot = ensureManagedDirectory(validated.pluginsRoot, SERVER_PLUGIN_BACKUP_DIRECTORY);
    } catch (error) {
        cleanupTransaction(validated);
        error.serverPluginTransactionCleaned = true;
        throw error;
    }
    const backupPath = path.join(backupRoot, `${validated.directoryName}-${createTimestamp()}-${validated.transactionId.slice(0, 8)}`);
    const logPath = `${backupPath}.log`;
    const transaction = { ...validated, backupRoot, backupPath, logPath };

    try {
        appendJournal(transaction, 'applying');
        appendLog(logPath, 'Copying preserved plugin state after graceful shutdown.');
        copyPreservedState(validated);
        if (getServerPluginReleaseDigest(validated.releaseRoot, { excludePaths: validated.preservePaths }) !== validated.releaseDigest) {
            throw new Error('Staged server plugin changed while preserved state was copied.');
        }
        syncServerPluginTree(validated.releaseRoot);

        appendLog(logPath, `Moving installed plugin to ${backupPath}.`);
        fs.renameSync(validated.pluginPath, backupPath);
        syncServerPluginDirectory(backupRoot);
        syncServerPluginDirectory(validated.pluginsRoot);
        appendJournal(transaction, 'original-moved');
        fs.renameSync(validated.releaseRoot, validated.pluginPath);
        syncServerPluginDirectory(validated.stagingRoot);
        syncServerPluginDirectory(validated.pluginsRoot);
        fs.rmSync(validated.stagingRoot, { recursive: true, force: true });
        syncServerPluginDirectory(path.dirname(validated.stagingRoot));
        appendJournal(transaction, 'activation-pending');
        appendLog(logPath, `Server plugin ${validated.directoryName} replaced; waiting for startup validation.`);
        return transaction;
    } catch (error) {
        appendLog(logPath, `Server plugin replacement failed: ${error?.message || error}`);
        try {
            if (lstatIfPresent(transaction.backupPath)) {
                const rollbackHadLiveTarget = Boolean(lstatIfPresent(transaction.pluginPath));
                const failedPath = rollbackHadLiveTarget
                    ? path.join(backupRoot, `${validated.directoryName}-failed-${createTimestamp()}-${validated.transactionId.slice(0, 8)}`)
                    : null;
                appendJournal(transaction, 'rolling-back', { failedPath, rollbackHadLiveTarget });
                restoreAppliedTransaction(transaction, failedPath);
                appendJournal(transaction, 'rolled-back', { failedPath, rollbackHadLiveTarget });
            }
            cleanupTransaction(transaction);
            error.serverPluginTransactionCleaned = true;
            appendLog(logPath, 'Restored the previous server plugin directory.');
        } catch (rollbackError) {
            appendLog(logPath, `Server plugin rollback failed: ${rollbackError?.message || rollbackError}`);
            const aggregate = new AggregateError([error, rollbackError], 'Server plugin replacement and rollback both failed.');
            aggregate.preserveServerPluginTransaction = true;
            throw aggregate;
        }
        throw error;
    }
}

export function finalizeServerPluginRelease(transaction) {
    appendLog(transaction.logPath, `Server plugin ${transaction.expectedPluginId} loaded successfully.`);
    try {
        appendJournal(transaction, 'activated');
    } catch (error) {
        error.serverPluginActivationRecorded = false;
        throw error;
    }
    try {
        cleanupTransaction(transaction);
    } catch (error) {
        error.serverPluginActivationRecorded = true;
        throw error;
    }
}

export function rollbackServerPluginRelease(transaction, reason = 'startup validation failed') {
    const failedPath = path.join(transaction.backupRoot, `${transaction.directoryName}-failed-${createTimestamp()}-${transaction.transactionId.slice(0, 8)}`);
    appendLog(transaction.logPath, `Rolling back server plugin update: ${reason}.`);
    appendJournal(transaction, 'rolling-back', { failedPath, rollbackHadLiveTarget: true });

    fs.renameSync(transaction.pluginPath, failedPath);
    syncServerPluginDirectory(transaction.pluginsRoot);
    syncServerPluginDirectory(transaction.backupRoot);
    try {
        fs.renameSync(transaction.backupPath, transaction.pluginPath);
        syncServerPluginDirectory(transaction.backupRoot);
        syncServerPluginDirectory(transaction.pluginsRoot);
    } catch (error) {
        fs.renameSync(failedPath, transaction.pluginPath);
        syncServerPluginDirectory(transaction.backupRoot);
        syncServerPluginDirectory(transaction.pluginsRoot);
        appendLog(transaction.logPath, `Rollback failed: ${error?.message || error}`);
        throw error;
    }

    appendJournal(transaction, 'rolled-back', { failedPath, rollbackHadLiveTarget: true });
    cleanupTransaction(transaction);
    appendLog(transaction.logPath, `Previous server plugin restored; failed release retained at ${failedPath}.`);
    return failedPath;
}

export function discardQueuedServerPluginRelease(payload) {
    const validated = validateServerPluginUpdatePayload(payload);
    appendJournal(validated, 'discarded');
    cleanupTransaction(validated);
}

export function discardPreparedServerPluginRelease(payload) {
    const pluginsRoot = fs.realpathSync(path.resolve(String(payload?.pluginsRoot ?? '')));
    const journalPath = path.resolve(String(payload?.journalPath ?? ''));
    const record = validateRecoveryRecord(readLatestJournal(journalPath), pluginsRoot, journalPath);
    if (record.state !== 'staged' || record.transactionId !== payload?.transactionId) {
        throw new Error('Prepared server plugin update is no longer safe to discard.');
    }
    cleanupTransaction(record);
}

function validateRecoveryRecord(record, pluginsRoot, journalPath) {
    const transactionId = String(record?.transactionId ?? '');
    const directoryName = String(record?.directoryName ?? '');
    const updatesRoot = path.join(pluginsRoot, SERVER_PLUGIN_UPDATE_DIRECTORY);
    const pluginPath = path.join(pluginsRoot, directoryName);
    const stagingRoot = path.resolve(String(record?.stagingRoot ?? ''));
    const releaseRoot = path.resolve(String(record?.releaseRoot ?? ''));
    const lockPath = path.resolve(String(record?.lockPath ?? ''));

    if (
        record?.schemaVersion !== 1
        || !TRANSACTION_PATTERN.test(transactionId)
        || !directoryName
        || path.dirname(pluginPath) !== pluginsRoot
        || record.pluginsRoot !== pluginsRoot
        || record.pluginPath !== pluginPath
        || journalPath !== path.join(updatesRoot, `${transactionId}${JOURNAL_SUFFIX}`)
        || record.journalPath !== journalPath
        || !isPathInside(updatesRoot, stagingRoot)
        || !isPathInside(stagingRoot, releaseRoot)
        || lockPath !== path.join(updatesRoot, UPDATE_LOCK_NAME)
    ) {
        throw new Error(`Invalid interrupted server plugin update journal: ${journalPath}.`);
    }

    const recovered = { ...record, transactionId, directoryName, pluginsRoot, pluginPath, stagingRoot, releaseRoot, lockPath, journalPath };
    if (record.backupPath !== undefined) {
        const backupRoot = path.join(pluginsRoot, SERVER_PLUGIN_BACKUP_DIRECTORY);
        const backupPath = path.resolve(String(record.backupPath));
        validateRegularDirectory(backupRoot, 'Server plugin backup directory');
        if (record.backupRoot !== backupRoot || path.dirname(backupPath) !== backupRoot) {
            throw new Error(`Invalid backup path in interrupted server plugin update journal: ${journalPath}.`);
        }
        recovered.backupRoot = backupRoot;
        recovered.backupPath = backupPath;
    }
    if (['rolling-back', 'rolled-back'].includes(record.state)) {
        if (typeof record.rollbackHadLiveTarget !== 'boolean') {
            throw new Error(`Invalid rollback state in interrupted server plugin update journal: ${journalPath}.`);
        }
        if (record.rollbackHadLiveTarget) {
            const failedPath = path.resolve(String(record.failedPath ?? ''));
            if (!recovered.backupRoot || path.dirname(failedPath) !== recovered.backupRoot) {
                throw new Error(`Invalid failed release path in interrupted server plugin update journal: ${journalPath}.`);
            }
            recovered.failedPath = failedPath;
        } else if (record.failedPath !== null && record.failedPath !== undefined) {
            throw new Error(`Unexpected failed release path in interrupted server plugin update journal: ${journalPath}.`);
        }
        recovered.rollbackHadLiveTarget = record.rollbackHadLiveTarget;
    }
    return recovered;
}

function recoverTransaction(record) {
    const liveStat = lstatIfPresent(record.pluginPath);
    const backupStat = record.backupPath ? lstatIfPresent(record.backupPath) : null;
    const failedStat = record.failedPath ? lstatIfPresent(record.failedPath) : null;

    if (liveStat && (!liveStat.isDirectory() || liveStat.isSymbolicLink())) {
        throw new Error(`Interrupted server plugin path is not a regular directory: ${record.pluginPath}.`);
    }
    if (backupStat && (!backupStat.isDirectory() || backupStat.isSymbolicLink())) {
        throw new Error(`Interrupted server plugin backup is not a regular directory: ${record.backupPath}.`);
    }
    if (failedStat && (!failedStat.isDirectory() || failedStat.isSymbolicLink())) {
        throw new Error(`Interrupted failed server plugin release is not a regular directory: ${record.failedPath}.`);
    }

    if (!RECOVERABLE_STATES.has(record.state)) {
        throw new Error(`Unknown interrupted server plugin update state: ${record.state}.`);
    }
    const rollbackState = ['rolling-back', 'rolled-back'].includes(record.state);
    const completedRollback = rollbackState
        && !backupStat
        && liveStat
        && (record.rollbackHadLiveTarget ? failedStat : true);
    if (['original-moved', 'activation-pending'].includes(record.state) && !backupStat) {
        throw new Error(`Unvalidated server plugin ${record.directoryName} is live but its rollback backup is missing.`);
    }
    if (rollbackState && !backupStat && !completedRollback) {
        throw new Error(`Interrupted rollback for server plugin ${record.directoryName} is missing required state.`);
    }

    if (record.state === 'activated') {
        if (!liveStat && backupStat) {
            fs.renameSync(record.backupPath, record.pluginPath);
            syncServerPluginDirectory(record.backupRoot);
            syncServerPluginDirectory(record.pluginsRoot);
        } else if (!liveStat) {
            throw new Error(`Activated server plugin ${record.directoryName} is missing and has no rollback backup.`);
        }
    } else if (backupStat) {
        if (rollbackState) {
            if (liveStat) {
                if (!record.rollbackHadLiveTarget || failedStat) {
                    throw new Error(`Interrupted rollback for server plugin ${record.directoryName} has conflicting live state.`);
                }
                fs.renameSync(record.pluginPath, record.failedPath);
                syncServerPluginDirectory(record.pluginsRoot);
                syncServerPluginDirectory(record.backupRoot);
            }
        } else if (liveStat) {
            const interruptedPath = path.join(record.backupRoot, `${record.directoryName}-interrupted-${createTimestamp()}-${record.transactionId.slice(0, 8)}`);
            fs.renameSync(record.pluginPath, interruptedPath);
            syncServerPluginDirectory(record.pluginsRoot);
            syncServerPluginDirectory(record.backupRoot);
        }
        fs.renameSync(record.backupPath, record.pluginPath);
        syncServerPluginDirectory(record.backupRoot);
        syncServerPluginDirectory(record.pluginsRoot);
    } else if (!liveStat) {
        throw new Error(`Interrupted server plugin ${record.directoryName} has neither a live directory nor a rollback backup.`);
    }

    const stagingStat = lstatIfPresent(record.stagingRoot);
    if (stagingStat) {
        validateRegularDirectory(record.stagingRoot, 'Interrupted server plugin staging directory');
        fs.rmSync(record.stagingRoot, { recursive: true, force: true });
        syncServerPluginDirectory(path.dirname(record.stagingRoot));
    }
    if (lstatIfPresent(record.lockPath)) {
        try {
            releaseServerPluginUpdateLock(record.lockPath, record.transactionId);
        } catch (error) {
            let lock = null;
            try {
                lock = JSON.parse(fs.readFileSync(record.lockPath, 'utf8'));
            } catch {
                // A valid journal is authoritative when a crash interrupted
                // the lock write itself.
            }
            if (lock?.transactionId && lock.transactionId !== record.transactionId) {
                throw error;
            }
            fs.rmSync(record.lockPath);
            syncServerPluginDirectory(path.dirname(record.lockPath));
        }
    }
    fs.rmSync(record.journalPath);
    syncServerPluginDirectory(path.dirname(record.journalPath));
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error?.code === 'EPERM') {
            return true;
        }
        if (error?.code === 'ESRCH') {
            return false;
        }
        throw error;
    }
}

export function recoverInterruptedServerPluginUpdates(pluginsRoot) {
    const root = fs.realpathSync(path.resolve(pluginsRoot));
    validateRegularDirectory(root, 'Plugins root');
    const updatesRoot = path.join(root, SERVER_PLUGIN_UPDATE_DIRECTORY);
    if (!fs.existsSync(updatesRoot)) {
        return [];
    }
    validateRegularDirectory(updatesRoot, 'Server plugin updates directory');

    const releaseMutex = acquireServerPluginUpdateMutex(updatesRoot);

    try {
        const lockPath = path.join(updatesRoot, UPDATE_LOCK_NAME);
        let updateLock = null;
        if (lstatIfPresent(lockPath)) {
            try {
                updateLock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            } catch {
                // With no worker child running, an incomplete lock is recoverable.
            }
            if (
                Number.isInteger(updateLock?.pid)
                && updateLock.pid > 0
                && updateLock.pid !== process.pid
                && isProcessAlive(updateLock.pid)
            ) {
                // Another supervisor owns this shared plugin root. Never recover
                // or delete its in-flight transaction.
                throw new Error('Another SillyBunny supervisor owns the server plugin update transaction.');
            }
        }

        const recovered = [];
        for (const name of fs.readdirSync(updatesRoot).filter(value => value.endsWith(JOURNAL_SUFFIX)).sort()) {
            const journalPath = path.join(updatesRoot, name);
            const record = validateRecoveryRecord(readLatestJournal(journalPath), root, journalPath);
            recoverTransaction(record);
            recovered.push(record.transactionId);
            console.warn(`[SillyBunny] Recovered interrupted server plugin update ${record.transactionId}.`);
        }

        // A worker can exit during clone/npm before its journal is written. At
        // this point no worker child is running, so staging entries left without a
        // journal are unambiguously abandoned and can be removed before relaunch.
        for (const name of fs.readdirSync(updatesRoot)) {
            if (name === UPDATE_LOCK_NAME || name === SERVER_PLUGIN_UPDATE_MUTEX || name.endsWith(JOURNAL_SUFFIX)) {
                continue;
            }
            fs.rmSync(path.join(updatesRoot, name), { recursive: true, force: true });
        }
        syncServerPluginDirectory(updatesRoot);
        if (lstatIfPresent(lockPath)) {
            try {
                const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
                releaseServerPluginUpdateLock(lockPath, lock.transactionId);
            } catch {
                fs.rmSync(lockPath, { force: true });
                syncServerPluginDirectory(updatesRoot);
            }
        }
        return recovered;
    } finally {
        releaseMutex();
    }
}
