import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    CHAT_RECOVERY_QUARANTINE_LIMIT,
    createCharacterChatTarget,
    createGroupChatTarget,
    getChatRecoveryPaths,
    isChatRecoverable,
    loadActiveChatWithRecovery,
    markChatDeleted,
    readChatJsonlStrict,
    rekeyChatRecoveryState,
    reverseChatRecoveryRekey,
    seedLatestChatSnapshot,
    writeLatestChatSnapshot,
} from '../src/chat-recovery.js';

let tempRoot;
let chatsDirectory;
let groupChatsDirectory;
let backupDirectory;

function chatData(label = 'one') {
    return Buffer.from(`\n{"chat_metadata":{"future":{"enabled":true}},"unknown_header":"${label}"}\r\n\r\n{"name":"Character","mes":"${label}","unknown_message":17}\n`, 'utf8');
}

function characterTarget(owner = 'character-one', filename = 'chat.jsonl') {
    return createCharacterChatTarget({
        chatsDirectory,
        backupDirectory,
        owner,
        filename,
    });
}

function writeActive(target, data) {
    fs.mkdirSync(target.activeDirectory, { recursive: true });
    fs.writeFileSync(target.activePath, data);
}

beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-chat-recovery-'));
    chatsDirectory = path.join(tempRoot, 'chats');
    groupChatsDirectory = path.join(tempRoot, 'group chats');
    backupDirectory = path.join(tempRoot, 'backups');
    fs.mkdirSync(chatsDirectory);
    fs.mkdirSync(groupChatsDirectory);
    fs.mkdirSync(backupDirectory);
});

afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('readChatJsonlStrict', () => {
    test('allows blank lines and preserves exact bytes and unknown fields', () => {
        const target = characterTarget();
        const serialized = chatData();
        writeActive(target, serialized);

        const result = readChatJsonlStrict(target.activePath);

        expect(result.status).toBe('ok');
        expect(result.data).toEqual(serialized);
        expect(result.records).toEqual([
            {
                chat_metadata: { future: { enabled: true } },
                unknown_header: 'one',
            },
            {
                name: 'Character',
                mes: 'one',
                unknown_message: 17,
            },
        ]);
    });

    test('distinguishes missing files', () => {
        expect(readChatJsonlStrict(characterTarget().activePath)).toEqual({
            status: 'missing',
            data: null,
            records: null,
        });
    });

    test('rejects invalid rows and headers', () => {
        const invalidChats = [
            ['blank input', ' \n\r\n', 'empty'],
            ['invalid JSON', '{"chat_metadata":{}}\n{', 'invalid-json'],
            ['a scalar row', '{"chat_metadata":{}}\n17', 'non-object'],
            ['an array row', '{"chat_metadata":{}}\n[]', 'non-object'],
            ['a missing metadata header', '{"name":"header"}\n{"mes":"hello"}', 'missing-chat-metadata'],
            ['non-object metadata', '{"chat_metadata":[]}', 'missing-chat-metadata'],
        ];

        for (const [label, serialized, reason] of invalidChats) {
            const target = characterTarget('character-one', `${label}.jsonl`);
            writeActive(target, serialized);

            const result = readChatJsonlStrict(target.activePath);

            expect(result.status).toBe('corrupt');
            expect(result.reason).toBe(reason);
            expect(result.data).toEqual(Buffer.from(serialized));
        }
    });

    test('rejects invalid UTF-8', () => {
        const target = characterTarget();
        const invalidUtf8 = Buffer.from([0x7b, 0xff, 0x7d]);
        writeActive(target, invalidUtf8);

        expect(readChatJsonlStrict(target.activePath)).toMatchObject({
            status: 'corrupt',
            reason: 'invalid-utf8',
            data: invalidUtf8,
        });
    });
});

describe('chat recovery targets', () => {
    test('hashes type, owner, and the exact sanitized filename', () => {
        const first = characterTarget('character-one', 'bad/name?.jsonl');
        const sameSanitizedTarget = characterTarget('character-one', 'badname.jsonl');
        const otherOwner = characterTarget('character-two', 'badname.jsonl');
        const group = createGroupChatTarget({
            groupChatsDirectory,
            backupDirectory,
            filename: 'badname.jsonl',
        });
        const expectedId = crypto.createHash('sha256')
            .update('character\0character-one\0badname.jsonl')
            .digest('hex');

        expect(first.filename).toBe('badname.jsonl');
        expect(first.id).toBe(expectedId);
        expect(sameSanitizedTarget.id).toBe(first.id);
        expect(otherOwner.id).not.toBe(first.id);
        expect(group.id).not.toBe(first.id);
        expect(getChatRecoveryPaths(first).latestPath).toMatch(new RegExp(`${expectedId}\\.latest\\.jsonl$`));
    });

    test('keeps snapshots isolated for otherwise identical character chat names', () => {
        const first = characterTarget('character-one');
        const second = characterTarget('character-two');
        const firstData = chatData('first');
        const secondData = chatData('second');

        writeLatestChatSnapshot(first, firstData);
        writeLatestChatSnapshot(second, secondData);

        expect(fs.readFileSync(getChatRecoveryPaths(first).latestPath)).toEqual(firstData);
        expect(fs.readFileSync(getChatRecoveryPaths(second).latestPath)).toEqual(secondData);
    });
});

describe('snapshot and recovery operations', () => {
    test('writes and seeds exact snapshots while clearing tombstones', () => {
        const target = characterTarget();
        const written = chatData('written');
        const seeded = chatData('seeded');
        const paths = getChatRecoveryPaths(target);

        markChatDeleted(target);
        expect(fs.existsSync(paths.tombstonePath)).toBe(true);

        writeLatestChatSnapshot(target, written);
        expect(fs.readFileSync(paths.latestPath)).toEqual(written);
        expect(fs.existsSync(paths.tombstonePath)).toBe(false);

        writeActive(target, seeded);
        const result = seedLatestChatSnapshot(target);
        expect(result).toMatchObject({ status: 'ok', seeded: true });
        expect(fs.readFileSync(paths.latestPath)).toEqual(seeded);
        expect(isChatRecoverable(target)).toBe(true);
    });

    test('valid active data seeds the latest snapshot on load', () => {
        const target = characterTarget();
        const serialized = chatData('active');
        writeActive(target, serialized);

        const result = loadActiveChatWithRecovery(target);

        expect(result).toMatchObject({ status: 'ok', source: 'active', recovered: false });
        expect(result.data).toEqual(serialized);
        expect(fs.readFileSync(getChatRecoveryPaths(target).latestPath)).toEqual(serialized);
    });

    test('restores a missing active file byte-for-byte', () => {
        const target = characterTarget();
        const serialized = chatData('missing');
        writeLatestChatSnapshot(target, serialized);

        const result = loadActiveChatWithRecovery(target);

        expect(result).toMatchObject({ status: 'ok', source: 'snapshot', recovered: true });
        expect(result.data).toEqual(serialized);
        expect(fs.readFileSync(target.activePath)).toEqual(serialized);
    });

    test('quarantines corrupt active bytes before restoring and bounds the quarantine ring', () => {
        const target = characterTarget();
        const snapshot = chatData('snapshot');
        const corruptVersions = [
            Buffer.from('bad-one'),
            Buffer.from('bad-two'),
            Buffer.from('bad-three'),
            Buffer.from('bad-four'),
        ];
        writeLatestChatSnapshot(target, snapshot);

        for (const corrupt of corruptVersions) {
            writeActive(target, corrupt);
            const result = loadActiveChatWithRecovery(target);
            expect(result).toMatchObject({ status: 'ok', source: 'snapshot', recovered: true });
            expect(fs.readFileSync(target.activePath)).toEqual(snapshot);
        }

        const paths = getChatRecoveryPaths(target);
        expect(paths.quarantinePaths).toHaveLength(CHAT_RECOVERY_QUARANTINE_LIMIT);
        expect(fs.readFileSync(paths.quarantinePaths[0])).toEqual(corruptVersions[3]);
        expect(fs.readFileSync(paths.quarantinePaths[1])).toEqual(corruptVersions[2]);
        expect(fs.readFileSync(paths.quarantinePaths[2])).toEqual(corruptVersions[1]);
        const quarantineFiles = fs.readdirSync(paths.directory).filter(file => file.includes(`${target.id}.corrupt-`));
        expect(quarantineFiles).toHaveLength(CHAT_RECOVERY_QUARANTINE_LIMIT);
    });

    test('leaves missing and corrupt active files alone without a valid snapshot', () => {
        const target = characterTarget();
        const missing = loadActiveChatWithRecovery(target);
        expect(missing).toMatchObject({
            status: 'missing',
            recovered: false,
            recoveryReason: 'no-snapshot',
        });

        const corrupt = Buffer.from('not-jsonl');
        writeActive(target, corrupt);
        const corruptResult = loadActiveChatWithRecovery(target);
        expect(corruptResult).toMatchObject({
            status: 'corrupt',
            recovered: false,
            recoveryReason: 'no-snapshot',
        });
        expect(fs.readFileSync(target.activePath)).toEqual(corrupt);
        expect(fs.existsSync(getChatRecoveryPaths(target).quarantinePaths[0])).toBe(false);
    });

    test('tombstones prevent intentional deletion from being recovered', () => {
        const target = characterTarget();
        const oldSnapshot = chatData('old');
        const active = chatData('active-at-delete');
        const paths = getChatRecoveryPaths(target);
        writeLatestChatSnapshot(target, oldSnapshot);
        writeActive(target, active);

        const result = markChatDeleted(target);
        expect(result).toMatchObject({ status: 'marked', snapshotUpdated: true, activePath: target.activePath });
        expect(fs.readFileSync(paths.latestPath)).toEqual(active);
        expect(fs.existsSync(paths.tombstonePath)).toBe(true);

        fs.unlinkSync(target.activePath);
        expect(loadActiveChatWithRecovery(target)).toMatchObject({
            status: 'missing',
            recovered: false,
            recoveryReason: 'tombstoned',
        });
        expect(fs.existsSync(target.activePath)).toBe(false);
        expect(isChatRecoverable(target)).toBe(false);
    });

    test('rejects symlinks and non-regular active paths without replacing them', () => {
        const target = characterTarget();
        const snapshot = chatData('snapshot');
        const linkedData = chatData('linked');
        const linkedFile = path.join(tempRoot, 'linked.jsonl');
        writeLatestChatSnapshot(target, snapshot);
        fs.writeFileSync(linkedFile, linkedData);
        fs.mkdirSync(target.activeDirectory, { recursive: true });
        fs.symlinkSync(linkedFile, target.activePath);

        expect(readChatJsonlStrict(target.activePath)).toMatchObject({ status: 'corrupt', reason: 'symlink' });
        expect(loadActiveChatWithRecovery(target)).toMatchObject({
            status: 'corrupt',
            reason: 'symlink',
            recovered: false,
            recoveryReason: 'unsafe-active',
        });
        expect(fs.lstatSync(target.activePath).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(linkedFile)).toEqual(linkedData);

        fs.unlinkSync(target.activePath);
        fs.mkdirSync(target.activePath);
        expect(readChatJsonlStrict(target.activePath)).toMatchObject({ status: 'corrupt', reason: 'non-regular' });
    });
});

describe('rekeyChatRecoveryState', () => {
    test('moves recovery state and reverses without losing prior destination state', () => {
        const source = characterTarget('character-one', 'old.jsonl');
        const destination = characterTarget('character-one', 'new.jsonl');
        const sourceData = chatData('source');
        const destinationData = chatData('destination');
        writeLatestChatSnapshot(source, sourceData);
        writeLatestChatSnapshot(destination, destinationData);
        markChatDeleted(destination);

        const token = rekeyChatRecoveryState(source, destination);

        expect(isChatRecoverable(source)).toBe(false);
        expect(isChatRecoverable(destination)).toBe(true);
        expect(fs.readFileSync(getChatRecoveryPaths(destination).latestPath)).toEqual(sourceData);

        reverseChatRecoveryRekey(token);
        expect(isChatRecoverable(source)).toBe(true);
        expect(isChatRecoverable(destination)).toBe(false);
        expect(fs.readFileSync(getChatRecoveryPaths(source).latestPath)).toEqual(sourceData);
        expect(fs.readFileSync(getChatRecoveryPaths(destination).latestPath)).toEqual(destinationData);
        expect(() => reverseChatRecoveryRekey(token)).toThrow('Invalid or already reversed');
    });

    test('refuses to reverse over recovery state changed after the rekey', () => {
        const source = characterTarget('character-one', 'old.jsonl');
        const destination = characterTarget('character-one', 'new.jsonl');
        const changedData = chatData('changed');
        writeLatestChatSnapshot(source, chatData('source'));
        const token = rekeyChatRecoveryState(source, destination);
        writeLatestChatSnapshot(destination, changedData);

        expect(() => reverseChatRecoveryRekey(token)).toThrow('state changed after rekey');
        expect(fs.readFileSync(getChatRecoveryPaths(destination).latestPath)).toEqual(changedData);
    });
});
