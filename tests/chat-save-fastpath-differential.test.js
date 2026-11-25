import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
process.env.SILLYTAVERN_BACKUPS_CHAT_THROTTLEINTERVAL = '0';

const {
    ChatStateCache,
    backupDedupeCache,
    chatInfoCache,
    chatStateCache,
    clearDirtyByte0Tracking,
    computeNormalizedBackupHash,
    getCanonicalChatCacheKey,
    getDirtyByte0TrackingCount,
    isReliableStatTuple,
    writeDurableAtomicFileSync,
} = await import('../src/chat-io-fastpath.js');

const {
    clearChatRecoveryRuntimeCaches,
    clearChatRecoveryState,
    createCharacterChatTarget,
    getChatRecoveryPaths,
    loadActiveChatWithRecovery,
    readChatJsonlStrict,
    writeLatestChatSnapshotTrusted,
} = await import('../src/chat-recovery.js');

const {
    clearActiveDeferredChatPreWrites,
    createFragmentSearchMatcher,
    getChatInfo,
    isChatSaveExtensionFast,
    isChatSaveExtensionLegacy,
    isSameChatSaveContentFast,
    isSameChatSaveContentLegacy,
    router: chatsRouter,
    splitChatLinesForComparison,
    trySaveChat,
} = await import('../src/endpoints/chats.js');

const BOM = '\uFEFF';
const WORKTREE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG_PATH = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
const UTIL_URL = new URL('../src/util.js', import.meta.url).href;
const CHATS_URL = new URL('../src/endpoints/chats.js', import.meta.url).href;
const RECOVERY_URL = new URL('../src/chat-recovery.js', import.meta.url).href;

/**
 * Deterministic PRNG (Mulberry32) so property tests are reproducible across CI runs.
 * @param {number} seed
 * @returns {() => number}
 */
function createRng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function pick(rng, items) {
    return items[Math.floor(rng() * items.length)];
}

function buildRandomHeader(rng) {
    const headerKind = Math.floor(rng() * 6);
    if (headerKind === 0) {
        return { user_name: 'LegacyUser', character_name: 'LegacyChar' };
    }
    if (headerKind === 1) {
        return { name: 'LegacyNamedHeader' };
    }
    const meta = {};
    if (rng() < 0.7) {
        meta.integrity = `slug-${Math.floor(rng() * 4)}`;
    }
    if (rng() < 0.5) {
        meta.chat_id_hash = Math.floor(rng() * 5);
    }
    if (rng() < 0.4) {
        meta.tainted = rng() < 0.5;
    }
    if (rng() < 0.4) {
        meta.variables = rng() < 0.6 ? {} : { flag: Math.floor(rng() * 3) };
    }
    if (rng() < 0.3) {
        meta.note = pick(rng, ['alpha', 'beta', 'café']);
    }
    return {
        user_name: pick(rng, ['User', 'unused', 'Alice']),
        character_name: pick(rng, ['Bot', 'unused', 'Bunny']),
        chat_metadata: meta,
    };
}

function buildRandomExtra(rng) {
    const extra = {};
    if (rng() < 0.2) {
        extra.isSmallSys = true;
    }
    if (rng() < 0.3) {
        extra.file = rng() < 0.7 ? { url: `file-${Math.floor(rng() * 3)}.txt` } : '';
    }
    if (rng() < 0.3) {
        extra.files = rng() < 0.5 ? [] : [{ url: `file-${Math.floor(rng() * 3)}.txt` }];
    }
    if (rng() < 0.3) {
        extra.image = rng() < 0.8 ? `img-${Math.floor(rng() * 3)}.png` : '';
    }
    if (rng() < 0.25) {
        extra.image_swipes = [`img-${Math.floor(rng() * 3)}.png`, ''];
    }
    if (rng() < 0.25) {
        extra.video = `vid-${Math.floor(rng() * 2)}.mp4`;
    }
    if (rng() < 0.35) {
        extra.media = rng() < 0.5 ? [] : [{ type: 'image', url: `img-${Math.floor(rng() * 3)}.png` }];
        if (rng() < 0.5) {
            extra.media_display = pick(rng, ['gallery', 'list']);
        }
        if (rng() < 0.5) {
            extra.media_index = Math.floor(rng() * 2);
        }
    }
    return extra;
}

function buildRandomMessage(rng, index) {
    const isUser = rng() < 0.4;
    const mes = pick(rng, ['Hello', 'World', 'café', `msg-${index}`, '']);
    const msg = {
        name: isUser ? 'User' : 'Bot',
        is_user: isUser,
        send_date: `2026-06-0${(index % 9) + 1}T00:00:00.000Z`,
        mes,
        extra: buildRandomExtra(rng),
    };
    if (!isUser && rng() < 0.75) {
        const swipeCount = 1 + Math.floor(rng() * 3);
        const swipes = [];
        for (let s = 0; s < swipeCount; s++) {
            swipes.push(rng() < 0.5 ? mes : `alt-${s}`);
        }
        msg.swipes = swipes;
        msg.swipe_id = Math.floor(rng() * swipeCount);
        if (rng() < 0.7) {
            msg.swipe_info = swipes.map((_, s) => ({
                send_date: msg.send_date,
                extra: s === msg.swipe_id && rng() < 0.5 ? { ...msg.extra } : buildRandomExtra(rng),
            }));
        }
    }
    return msg;
}

function serializeWithFormatting(records, rng) {
    const lineSep = rng() < 0.35 ? '\r\n' : '\n';
    const parts = records.map(record => {
        let line = JSON.stringify(record);
        if (rng() < 0.2) {
            line = line.replace('café', 'caf\\u00e9');
        }
        if (rng() < 0.15) {
            line = `  ${line}  `;
        }
        return line;
    });

    let joined = parts.join(rng() < 0.25 ? `${lineSep}${lineSep}` : lineSep);
    if (rng() < 0.2) {
        joined = `${lineSep}${joined}`;
    }
    if (rng() < 0.2) {
        joined = `${joined}${lineSep}`;
    }
    if (rng() < 0.2) {
        joined = `${BOM}${joined}`;
    }
    return joined;
}

function mutateChat(records, rng) {
    const clone = structuredClone(records);
    const mode = Math.floor(rng() * 10);
    if (mode === 0) {
        // Semantic no-op with derived metadata / slug rotation
        if (clone[0]?.chat_metadata) {
            clone[0].chat_metadata.integrity = 'rotated-slug';
            clone[0].chat_metadata.chat_id_hash = 999;
            clone[0].chat_metadata.variables = {};
        }
    } else if (mode === 1) {
        // Append 1-2 messages
        clone.push(buildRandomMessage(rng, clone.length));
        if (rng() < 0.5) {
            clone.push(buildRandomMessage(rng, clone.length));
        }
    } else if (mode === 2 && clone.length > 1) {
        // Hydrate empty media/files arrays on a message
        const idx = 1 + Math.floor(rng() * (clone.length - 1));
        clone[idx].extra = { ...(clone[idx].extra || {}), media: [], files: [], media_display: 'gallery', media_index: 0 };
    } else if (mode === 3 && clone.length > 1) {
        // Edit a message
        const idx = 1 + Math.floor(rng() * (clone.length - 1));
        clone[idx].mes = `${clone[idx].mes}-edited`;
    } else if (mode === 4 && clone.length > 2) {
        // Truncate a message
        clone.pop();
    } else if (mode === 5) {
        // Toggle tainted
        if (clone[0]?.chat_metadata) {
            clone[0].chat_metadata.tainted = !clone[0].chat_metadata.tainted;
        }
    } else if (mode === 6 && clone.length > 1) {
        // Hydrate legacy file/image fields
        const idx = 1 + Math.floor(rng() * (clone.length - 1));
        if (clone[idx].extra?.image) {
            const url = clone[idx].extra.image;
            delete clone[idx].extra.image;
            clone[idx].extra.media = [{ type: 'image', url }];
        }
    } else if (mode === 7) {
        // Change metadata value
        if (clone[0]?.chat_metadata) {
            clone[0].chat_metadata.note = 'changed-meta';
        }
    } else if (mode === 8 && clone.length > 1) {
        // Reorder two messages
        if (clone.length > 2) {
            const tmp = clone[1];
            clone[1] = clone[2];
            clone[2] = tmp;
        }
    }
    return clone;
}

function legacyNormalizeBackupComparison(data) {
    const serialized = String(data ?? '');
    const lines = serialized.split('\n');
    if (!lines[0]) {
        return serialized;
    }
    try {
        const header = JSON.parse(lines[0]);
        if (!header?.chat_metadata || typeof header.chat_metadata !== 'object' || Array.isArray(header.chat_metadata)) {
            return serialized;
        }
        const chatMetadata = { ...header.chat_metadata };
        delete chatMetadata.integrity;
        lines[0] = JSON.stringify({ ...header, chat_metadata: chatMetadata });
        return lines.join('\n');
    } catch {
        return serialized;
    }
}

function makeLargeChat(messageCount, integrity = 'bench-slug-0') {
    const rows = [
        {
            user_name: 'User',
            character_name: 'BenchChar',
            chat_metadata: { integrity, note: 'benchmark' },
        },
    ];
    for (let i = 0; i < messageCount; i++) {
        const isUser = i % 2 === 0;
        const mes = `Turn ${i}: ${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(4)}marker_${i}`;
        rows.push({
            name: isUser ? 'User' : 'BenchChar',
            is_user: isUser,
            send_date: `2026-06-01T00:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
            mes,
            extra: {},
            ...(isUser ? {} : {
                swipes: [mes],
                swipe_id: 0,
                swipe_info: [{ send_date: `2026-06-01T00:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`, extra: {} }],
            }),
        });
    }
    return rows;
}

describe('differential property tests: fast row-level comparison === legacy', () => {
    test('matches legacy across 300 randomized edits, swipes, media, headers, and CRLF/BOM/blank-line formats', () => {
        const rng = createRng(0x5177B001);
        for (let trial = 0; trial < 300; trial++) {
            const msgCount = Math.floor(rng() * 5); // includes 0, 1, 2, 3, 4 messages
            const baseRecords = [buildRandomHeader(rng)];
            for (let m = 0; m < msgCount; m++) {
                baseRecords.push(buildRandomMessage(rng, m));
            }
            const mutatedRecords = mutateChat(baseRecords, rng);
            const diskText = serializeWithFormatting(baseRecords, rng);
            const incomingText = serializeWithFormatting(mutatedRecords, rng);
            const ignoreDerivedMetadata = rng() < 0.7;

            const inSplit = splitChatLinesForComparison(incomingText);
            const diskSplit = splitChatLinesForComparison(diskText);

            const legacySame = isSameChatSaveContentLegacy(incomingText, diskText, { ignoreDerivedMetadata });
            const fastSame = isSameChatSaveContentFast(
                { lines: inSplit.lines },
                { lines: diskSplit.lines },
                { ignoreDerivedMetadata },
            );
            expect(fastSame).toBe(legacySame);

            const legacyExt = isChatSaveExtensionLegacy(incomingText, diskText, { ignoreDerivedMetadata });
            const fastExt = isChatSaveExtensionFast(
                { lines: inSplit.lines, rawText: incomingText },
                { lines: diskSplit.lines, rawText: diskText },
                { ignoreDerivedMetadata },
            );
            expect(fastExt).toBe(legacyExt);
        }
    });

    test('handles the 1->2 message non-tainted mandatory fallback and differing tainted flags identically to legacy', () => {
        const headerUntainted = { user_name: 'User', character_name: 'Char', chat_metadata: { integrity: 'slug-1' } };
        const headerTainted = { user_name: 'User', character_name: 'Char', chat_metadata: { integrity: 'slug-1', tainted: true } };
        // Message 0 has mes !== swipes[0]: normalization differs between messageCount === 1 and messageCount > 1 when !tainted!
        const staleSwipeMsg = {
            name: 'Char',
            is_user: false,
            send_date: '2026-06-01T00:00:00.000Z',
            mes: 'Edited greeting',
            swipes: ['Original greeting'],
            swipe_id: 0,
            swipe_info: [{ send_date: '2026-06-01T00:00:00.000Z', extra: {} }],
            extra: {},
        };
        const followUpMsg = {
            name: 'User',
            is_user: true,
            send_date: '2026-06-01T00:01:00.000Z',
            mes: 'Hello!',
            extra: {},
        };

        // Case 1: 1 -> 2 non-tainted, byte-equal row 1 with mes !== swipes[0] MUST NOT match as extension!
        const disk1Untainted = [headerUntainted, staleSwipeMsg].map(JSON.stringify).join('\n');
        const in2Untainted = [headerUntainted, staleSwipeMsg, followUpMsg].map(JSON.stringify).join('\n');
        expect(isChatSaveExtensionLegacy(in2Untainted, disk1Untainted)).toBe(false);
        expect(isChatSaveExtensionFast(
            { lines: splitChatLinesForComparison(in2Untainted).lines, rawText: in2Untainted, validated: true },
            { lines: splitChatLinesForComparison(disk1Untainted).lines, rawText: disk1Untainted, validated: true },
        )).toBe(false);

        // Case 2: 1 -> 2 tainted, byte-equal row 1 MUST match as extension!
        const disk1Tainted = [headerTainted, staleSwipeMsg].map(JSON.stringify).join('\n');
        const in2Tainted = [headerTainted, staleSwipeMsg, followUpMsg].map(JSON.stringify).join('\n');
        expect(isChatSaveExtensionLegacy(in2Tainted, disk1Tainted)).toBe(true);
        expect(isChatSaveExtensionFast(
            { lines: splitChatLinesForComparison(in2Tainted).lines, rawText: in2Tainted, validated: true },
            { lines: splitChatLinesForComparison(disk1Tainted).lines, rawText: disk1Tainted, validated: true },
        )).toBe(true);

        // Case 3: differing tainted flag -> MUST match legacy (false)
        expect(isChatSaveExtensionLegacy(in2Tainted, disk1Untainted)).toBe(false);
        expect(isChatSaveExtensionFast(
            { lines: splitChatLinesForComparison(in2Tainted).lines, rawText: in2Tainted, validated: true },
            { lines: splitChatLinesForComparison(disk1Untainted).lines, rawText: disk1Untainted, validated: true },
        )).toBe(false);
    });

    test('matches legacy on corrupt rows, BOM-after-newline, unrecognized headers, and empty inputs', () => {
        const valid = [
            { user_name: 'U', character_name: 'C', chat_metadata: { integrity: 'a' } },
            { name: 'C', is_user: false, mes: 'hi' },
        ].map(JSON.stringify).join('\n');

        const edgeCases = [
            '',
            '   \r\n\n  ',
            `${BOM}${valid}`,
            `\n${BOM}${valid}`,
            `${valid}\n{broken`,
            `${valid}\n42`,
            `${valid}\n[]`,
            '{"unexpected":true}\n{"mes":"hi"}',
            '{"chat_metadata":[]}\n{"mes":"hi"}',
            'not json\n{"mes":"hi"}',
            `\r\n${JSON.stringify({ user_name: 'Legacy' })}\r\n\r\n${JSON.stringify({ name: 'C', is_user: false, mes: 'hi' })}\r\n`,
        ];

        for (const candidate of edgeCases) {
            const cSplit = splitChatLinesForComparison(candidate);
            const vSplit = splitChatLinesForComparison(valid);

            expect(isSameChatSaveContentFast({ lines: vSplit.lines }, { lines: cSplit.lines }))
                .toBe(isSameChatSaveContentLegacy(valid, candidate));
            expect(isSameChatSaveContentFast({ lines: cSplit.lines }, { lines: vSplit.lines }))
                .toBe(isSameChatSaveContentLegacy(candidate, valid));
            expect(isChatSaveExtensionFast({ lines: vSplit.lines, rawText: valid }, { lines: cSplit.lines, rawText: candidate }))
                .toBe(isChatSaveExtensionLegacy(valid, candidate));
            expect(isChatSaveExtensionFast({ lines: cSplit.lines, rawText: candidate }, { lines: vSplit.lines, rawText: valid }))
                .toBe(isChatSaveExtensionLegacy(candidate, valid));
        }
    });

    test('computeNormalizedBackupHash matches SHA-256 of legacy normalizeSerializedChatForBackupComparison', () => {
        const samples = [
            '',
            '\n{"chat_metadata":{"integrity":"a"}}\n{"mes":"x"}',
            '{"chat_metadata":{"integrity":"a","note":1}}\n{"mes":"hello"}',
            '{"chat_metadata":{"integrity":"b","note":1}}\n{"mes":"hello"}',
            '{"chat_metadata":{"note":1}}',
            '{"user_name":"legacy"}\n{"mes":"hello"}',
            '{not-json\n{"mes":"hello"}',
        ];

        for (const sample of samples) {
            const expected = crypto.createHash('sha256').update(legacyNormalizeBackupComparison(sample)).digest('hex');
            expect(computeNormalizedBackupHash(sample)).toBe(expected);
        }
        // Rotating only integrity produces the exact same normalized backup hash
        expect(computeNormalizedBackupHash(samples[2])).toBe(computeNormalizedBackupHash(samples[3]));
    });
});

describe('ChatStateCache bounds, stat-tuple guards, hard-link pre-write, and fsync budget', () => {
    let tempRoot;
    let chatsDir;
    let backupsDir;
    let ownerDir;
    let chatFile;
    let recoveryTarget;

    beforeEach(() => {
        chatStateCache.clear();
        chatInfoCache.clear();
        backupDedupeCache.clear();
        clearDirtyByte0Tracking();
        clearChatRecoveryRuntimeCaches();
        clearActiveDeferredChatPreWrites();

        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fastpath-unit-'));
        chatsDir = path.join(tempRoot, 'chats');
        backupsDir = path.join(tempRoot, 'backups');
        ownerDir = path.join(chatsDir, 'TestCard');
        fs.mkdirSync(ownerDir, { recursive: true });
        fs.mkdirSync(backupsDir, { recursive: true });
        chatFile = path.join(ownerDir, 'session.jsonl');
        recoveryTarget = createCharacterChatTarget({
            chatsDirectory: chatsDir,
            backupDirectory: backupsDir,
            owner: 'TestCard',
            filename: 'session.jsonl',
            maxRecoveryStates: 25,
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('enforces byte-capped LRU eviction and rejects zero-field or coarse-granularity stat tuples', () => {
        expect(isReliableStatTuple({ dev: 1n, ino: 2n, size: 10n, mtimeNs: 1_000_000_001n, ctimeNs: 1_000_000_000n })).toBe(true);
        expect(isReliableStatTuple({ dev: 0n, ino: 2n, size: 10n, mtimeNs: 1_000_000_001n, ctimeNs: 1_000_000_001n })).toBe(false);
        expect(isReliableStatTuple({ dev: 1n, ino: 0n, size: 10n, mtimeNs: 1_000_000_001n, ctimeNs: 1_000_000_001n })).toBe(false);
        expect(isReliableStatTuple({ dev: 1n, ino: 2n, size: 0n, mtimeNs: 1_000_000_001n, ctimeNs: 1_000_000_001n })).toBe(false);
        expect(isReliableStatTuple({ dev: 1n, ino: 2n, size: 10n, mtimeNs: 2_000_000_000n, ctimeNs: 3_000_000_000n })).toBe(false);

        const smallCache = new ChatStateCache(5_000);
        const f1 = path.join(ownerDir, 'a.jsonl');
        const f2 = path.join(ownerDir, 'b.jsonl');
        const f3 = path.join(ownerDir, 'c.jsonl');
        const base = { dev: 1n, ino: 10n, size: 500n, mtimeNs: 123456789n, ctimeNs: 123456789n, sha256: 'x', lines: ['{}'], header: {}, headerFixedUp: false, isCanonical: true, rawBuffer: null };
        smallCache.set(f1, { ...base, ino: 1n });
        smallCache.set(f2, { ...base, ino: 2n });
        // Touch f1 so f2 becomes LRU
        expect(smallCache.get(f1)).not.toBeNull();
        smallCache.set(f3, { ...base, ino: 3n });
        expect(smallCache.getStats().totalBytes).toBeLessThanOrEqual(5_000);
        expect(smallCache.get(f2)).toBeNull();
        expect(smallCache.get(f1)).not.toBeNull();
        expect(smallCache.get(f3)).not.toBeNull();
    });

    test('uses <= 3 file fsyncs on steady-state cached save, hard-links pre-write before latest rename, and never hard-links regular backups', async () => {
        const initial = makeLargeChat(10, 'init-slug');
        const firstSave = await trySaveChat(initial, chatFile, false, 'user1', 'TestCard', backupsDir, {
            recoveryTarget,
            deferBackup: false,
        });

        // Second save: warm cache hit + latestEqualsActive === true
        const nextPayload = structuredClone(initial);
        nextPayload[0].chat_metadata.integrity = firstSave.integrity;
        nextPayload.push({
            name: 'User',
            is_user: true,
            send_date: '2026-06-02T00:00:00.000Z',
            mes: 'Brand new turn',
            extra: {},
        });

        const realFsyncSync = fs.fsyncSync.bind(fs);
        let fileFsyncCount = 0;
        let dirFsyncCount = 0;
        jest.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
            const fdStats = fs.fstatSync(fd);
            if (fdStats.isDirectory()) {
                dirFsyncCount++;
            } else if (fdStats.isFile()) {
                fileFsyncCount++;
            }
            return realFsyncSync(fd);
        });
        const linkSpy = jest.spyOn(fs, 'linkSync');
        const readSyncSpy = jest.spyOn(fs, 'readSync');

        const secondSave = await trySaveChat(nextPayload, chatFile, false, 'user1', 'TestCard', backupsDir, {
            recoveryTarget,
            deferBackup: false,
        });

        // 1 file fsync for .latest.jsonl + 2 file fsyncs for active file (Barrier #1 + Barrier #2);
        // 0 file fsyncs for pre-write hard-link & regular backup; <= 2 POSIX directory fsyncs (pre-write link + latest rename).
        expect(fileFsyncCount).toBeLessThanOrEqual(3);
        expect(fileFsyncCount).toBeGreaterThanOrEqual(2);
        expect(dirFsyncCount).toBeLessThanOrEqual(2);
        // Zero active-file readSync on warm cache hit
        expect(readSyncSpy).not.toHaveBeenCalled();
        // Pre-write hard-link attempted from .latest.jsonl
        expect(linkSpy).toHaveBeenCalledTimes(1);
        expect(secondSave.integrity).not.toBe(firstSave.integrity);

        const { latestPath } = getChatRecoveryPaths(recoveryTarget);
        const latestStat = fs.statSync(latestPath, { bigint: true });
        const backupEntries = fs.readdirSync(backupsDir);
        const prewriteFiles = backupEntries.filter(f => f.startsWith('chat_pre_write_'));
        const regularFiles = backupEntries.filter(f => f.startsWith('chat_') && !f.startsWith('chat_pre_write_') && !f.startsWith('chat_forced_overwrite_'));

        expect(prewriteFiles.length).toBeGreaterThanOrEqual(1);
        // Pre-write backup preserves pre-image and no longer shares inode with newly renamed .latest.jsonl
        const newestPrewritePath = path.join(backupsDir, prewriteFiles[prewriteFiles.length - 1]);
        expect(fs.readFileSync(newestPrewritePath, 'utf8')).not.toContain('Brand new turn');
        expect(fs.statSync(newestPrewritePath, { bigint: true }).ino).not.toBe(latestStat.ino);

        // Regular backup must NEVER share an inode with .latest.jsonl
        expect(regularFiles.length).toBeGreaterThanOrEqual(1);
        for (const regFile of regularFiles) {
            expect(fs.statSync(path.join(backupsDir, regFile), { bigint: true }).ino).not.toBe(latestStat.ino);
        }
    });

    test('falls back cleanly to copy write when pre-write fs.linkSync fails with EXDEV/EPERM/ENOTSUP', async () => {
        const initial = makeLargeChat(6, 'init-slug');
        const firstSave = await trySaveChat(initial, chatFile, false, 'user-exdev', 'TestCard', backupsDir, {
            recoveryTarget,
            deferBackup: true,
        });

        for (const code of ['EXDEV', 'EPERM', 'ENOTSUP']) {
            const payload = structuredClone(initial);
            payload[0].chat_metadata.integrity = firstSave.integrity;
            payload.push({ name: 'User', is_user: true, mes: `fallback-${code}`, extra: {} });

            jest.spyOn(fs, 'linkSync').mockImplementationOnce(() => {
                throw Object.assign(new Error(`Simulated ${code}`), { code });
            });

            const res = await trySaveChat(payload, chatFile, false, 'user-exdev', 'TestCard', backupsDir, {
                recoveryTarget,
                deferBackup: true,
            });
            firstSave.integrity = res.integrity;
            initial.push({ name: 'User', is_user: true, mes: `fallback-${code}`, extra: {} });
            expect(fs.readFileSync(chatFile, 'utf8')).toContain(`fallback-${code}`);
        }

        const prewrites = fs.readdirSync(backupsDir).filter(f => f.startsWith('chat_pre_write_'));
        expect(prewrites).toHaveLength(3);
    });

    test('writeLatestChatSnapshotTrusted skips redundant read-back and detects zero-limit pruning', () => {
        const payload = makeLargeChat(5, 'trusted-slug').map(JSON.stringify).join('\n');
        const stored = writeLatestChatSnapshotTrusted(recoveryTarget, payload);
        expect(stored.stored).toBe(true);
        expect(stored.latestTuple).not.toBeNull();

        const readFileSpy = jest.spyOn(fs, 'readFileSync');
        const repeat = writeLatestChatSnapshotTrusted(recoveryTarget, payload, {
            dataSha: stored.latestSha,
            cachedLatestTuple: stored.latestTuple,
            cachedLatestSha: stored.latestSha,
        });
        expect(repeat.stored).toBe(true);
        expect(readFileSpy).not.toHaveBeenCalled();

        const zeroTarget = createCharacterChatTarget({
            chatsDirectory: chatsDir,
            backupDirectory: backupsDir,
            owner: 'TestCard',
            filename: 'zero-limit.jsonl',
            maxRecoveryStates: 0,
        });
        const pruned = writeLatestChatSnapshotTrusted(zeroTarget, payload);
        expect(pruned.stored).toBe(false);
        expect(fs.existsSync(getChatRecoveryPaths(zeroTarget).latestPath)).toBe(false);
    });
    test('enforces integrity conflicts, 1->2 non-tainted guard, and destructive shrink guards end-to-end', async () => {
        const oneMsgUntainted = [
            { user_name: 'User', character_name: 'TestCard', chat_metadata: { integrity: 'slug-v1' } },
            {
                name: 'TestCard',
                is_user: false,
                send_date: '2026-06-01T00:00:00.000Z',
                mes: 'Edited greeting',
                swipes: ['Original greeting'],
                swipe_id: 0,
                swipe_info: [{ send_date: '2026-06-01T00:00:00.000Z', extra: {} }],
                extra: {},
            },
        ];
        fs.writeFileSync(chatFile, oneMsgUntainted.map(JSON.stringify).join('\n'), 'utf8');

        // Stale-slug append to 1-msg non-tainted chat with mes !== swipes[0] MUST fail integrity check
        const divergentAppend = [
            { ...oneMsgUntainted[0], chat_metadata: { integrity: 'wrong-slug' } },
            oneMsgUntainted[1],
            { name: 'User', is_user: true, mes: 'Follow-up', extra: {} },
        ];
        await expect(trySaveChat(divergentAppend, chatFile, false, 'user1', 'TestCard', backupsDir, {
            recoveryTarget,
            deferBackup: true,
        })).rejects.toThrow(/integrity check failed/i);

        // Populated chat: superset append with stale slug succeeds, while destructive shrink & emptied fail before pre-write ring
        const populated = makeLargeChat(10, 'pop-slug-1');
        const savedPop = await trySaveChat(populated, chatFile, true, 'user1', 'TestCard', backupsDir, {
            recoveryTarget,
            deferBackup: true,
        });
        const prewritesBefore = fs.readdirSync(backupsDir).filter(f => f.startsWith('chat_pre_write_')).length;

        const supersetRetry = structuredClone(populated);
        supersetRetry[0].chat_metadata.integrity = 'old-dropped-slug';
        supersetRetry.push({ name: 'User', is_user: true, mes: 'Superset retry message', extra: {} });
        const supersetRes = await trySaveChat(supersetRetry, chatFile, false, 'user1', 'TestCard', backupsDir, {
            recoveryTarget,
            deferBackup: true,
        });
        expect(supersetRes.integrity).not.toBe(savedPop.integrity);

        const prewritesAfterGood = fs.readdirSync(backupsDir).filter(f => f.startsWith('chat_pre_write_')).length;
        expect(prewritesAfterGood).toBeGreaterThanOrEqual(prewritesBefore);

        const shrunkPayload = makeLargeChat(2, supersetRes.integrity);
        await expect(trySaveChat(shrunkPayload, chatFile, false, 'user1', 'TestCard', backupsDir, {
            recoveryTarget,
            deferBackup: true,
        })).rejects.toMatchObject({ reason: 'shrink' });

        await expect(trySaveChat([{ chat_metadata: { integrity: supersetRes.integrity } }], chatFile, false, 'user1', 'TestCard', backupsDir, {
            recoveryTarget,
            deferBackup: true,
        })).rejects.toMatchObject({ reason: 'emptied' });

        expect(fs.readdirSync(backupsDir).filter(f => f.startsWith('chat_pre_write_')).length).toBe(prewritesAfterGood);
    });

    test('preserves brand-new hard-linked pre-write backup of an older chat when global pre-write ring is full (and falls back if utimes fails)', async () => {
        const oldDir = path.join(chatsDir, 'OldChar');
        fs.mkdirSync(oldDir, { recursive: true });
        const oldChatPath = path.join(oldDir, 'old.jsonl');
        const oldTarget = createCharacterChatTarget({
            chatsDirectory: chatsDir,
            backupDirectory: backupsDir,
            owner: 'OldChar',
            filename: 'old.jsonl',
            maxRecoveryStates: 25,
        });

        const oldPayload = [
            { user_name: 'User', character_name: 'OldChar', chat_metadata: { integrity: 'old-slug' } },
            { name: 'OldChar', is_user: false, mes: 'Original message from 6 months ago', extra: {} },
        ];
        const savedOld = await trySaveChat(oldPayload, oldChatPath, false, 'user1', 'OldChar', backupsDir, {
            recoveryTarget: oldTarget,
            deferBackup: true,
        });

        // Age both the active chat and its .latest.jsonl snapshot by 6 months
        const sixMonthsAgo = new Date(Date.now() - 180 * 86_400 * 1000);
        const { latestPath } = getChatRecoveryPaths(oldTarget);
        fs.utimesSync(oldChatPath, sixMonthsAgo, sixMonthsAgo);
        fs.utimesSync(latestPath, sixMonthsAgo, sixMonthsAgo);

        // Simulate restart + normal chat load (alreadyCurrent === true keeps old .latest.jsonl mtime)
        chatStateCache.clear();
        backupDedupeCache.clear();
        clearChatRecoveryRuntimeCaches();
        expect(loadActiveChatWithRecovery(oldTarget).status).toBe('ok');

        // Fill the global 25-file chat_pre_write_* ring with recent backups from other chats
        for (let i = 0; i < 25; i++) {
            const p = path.join(backupsDir, `chat_pre_write_other${i}_20261126-0000${String(i).padStart(2, '0')}_uuid${i}.jsonl`);
            fs.writeFileSync(p, '{"chat_metadata":{}}\n{"mes":"other"}', 'utf8');
        }

        // Editing OldChar must bump the hard-linked pre-write backup's mtime so global pruning keeps it
        const editedOld = structuredClone(oldPayload);
        editedOld[0].chat_metadata.integrity = savedOld.integrity;
        editedOld[1].mes = 'Edited message today';
        const res1 = await trySaveChat(editedOld, oldChatPath, false, 'user1', 'OldChar', backupsDir, {
            recoveryTarget: oldTarget,
            deferBackup: true,
        });

        const survivingOldPrewrites = fs.readdirSync(backupsDir).filter(f => f.startsWith('chat_pre_write_oldchar_'));
        expect(survivingOldPrewrites).toHaveLength(1);
        expect(fs.readFileSync(path.join(backupsDir, survivingOldPrewrites[0]), 'utf8')).toContain('Original message from 6 months ago');

        // If utimesSync fails on the hard-linked pre-write backup, it must unlink & fall back to a fresh copy
        fs.utimesSync(latestPath, sixMonthsAgo, sixMonthsAgo);
        const cachedOld = chatStateCache.get(oldChatPath);
        expect(cachedOld).not.toBeNull();
        const agedLatestStat = fs.lstatSync(latestPath, { bigint: true });
        chatStateCache.update(oldChatPath, {
            latestTuple: {
                dev: agedLatestStat.dev,
                ino: agedLatestStat.ino,
                size: agedLatestStat.size,
                mtimeNs: agedLatestStat.mtimeNs,
                ctimeNs: agedLatestStat.ctimeNs,
            },
        });
        jest.spyOn(fs, 'utimesSync').mockImplementationOnce(() => {
            throw Object.assign(new Error('EPERM utimes'), { code: 'EPERM' });
        });
        const editedOld2 = structuredClone(editedOld);
        editedOld2[0].chat_metadata.integrity = res1.integrity;
        editedOld2[1].mes = 'Second edit after utimes fallback';
        await trySaveChat(editedOld2, oldChatPath, false, 'user1', 'OldChar', backupsDir, {
            recoveryTarget: oldTarget,
            deferBackup: true,
        });
        const survivingAfterFallback = fs.readdirSync(backupsDir).filter(f => f.startsWith('chat_pre_write_oldchar_'));
        expect(survivingAfterFallback).toHaveLength(2);
    });

    test('writeDurableAtomicFileSync refuses in-place copyFileSync onto a hard-linked peer and retries temp writes without EEXIST', () => {
        const latestFile = path.join(backupsDir, 'hardlinked.latest.jsonl');
        const prewritePeer = path.join(backupsDir, 'hardlinked.prewrite.jsonl');
        fs.writeFileSync(latestFile, 'ORIGINAL_PREWRITE_DATA', 'utf8');
        fs.linkSync(latestFile, prewritePeer);

        const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        try {
            const copySpy = jest.spyOn(fs, 'copyFileSync');
            const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation(() => {
                throw Object.assign(new Error('Simulated Windows rename lock'), { code: 'EPERM' });
            });

            expect(() => writeDurableAtomicFileSync(latestFile, 'NEW_POSTWRITE_DATA')).toThrow(/Simulated Windows rename lock/);
            expect(copySpy).not.toHaveBeenCalled();
            expect(fs.readFileSync(prewritePeer, 'utf8')).toBe('ORIGINAL_PREWRITE_DATA');
            expect(fs.readFileSync(latestFile, 'utf8')).toBe('ORIGINAL_PREWRITE_DATA');

            // Verify temp-write retry creates a fresh candidate path instead of failing with EEXIST
            renameSpy.mockRestore();
            const unlinkedFile = path.join(backupsDir, 'retry-temp.jsonl');
            fs.writeFileSync(unlinkedFile, 'OLD', 'utf8');
            let renameFailCount = 0;
            const realRenameSync = fs.renameSync.bind(fs);
            jest.spyOn(fs, 'renameSync').mockImplementation((src, dst) => {
                // Fail write-file-atomic's 4 attempts so we enter the temp-file fallback, then succeed
                if (renameFailCount < 4) {
                    renameFailCount++;
                    throw Object.assign(new Error('Simulated atomic EBUSY'), { code: 'EBUSY' });
                }
                return realRenameSync(src, dst);
            });
            let fsyncFailOnce = false;
            const realFsyncSync = fs.fsyncSync.bind(fs);
            jest.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
                if (renameFailCount === 4 && !fsyncFailOnce) {
                    fsyncFailOnce = true;
                    throw Object.assign(new Error('Simulated temp fsync EBUSY'), { code: 'EBUSY' });
                }
                return realFsyncSync(fd);
            });

            const tuple = writeDurableAtomicFileSync(unlinkedFile, 'RETRIED_CONTENT');
            expect(tuple).not.toBeNull();
            expect(fs.readFileSync(unlinkedFile, 'utf8')).toBe('RETRIED_CONTENT');
        } finally {
            if (originalPlatform) {
                Object.defineProperty(process, 'platform', originalPlatform);
            }
        }
    });

    test('cache-miss unchanged save on invalid-UTF-8 raw bytes falls back to validated snapshot and never writes corrupt .latest.jsonl', async () => {
        const utf8Dir = path.join(chatsDir, 'Utf8Char');
        fs.mkdirSync(utf8Dir, { recursive: true });
        const utf8Path = path.join(utf8Dir, 'badutf8.jsonl');
        const badBuf = Buffer.concat([
            Buffer.from('{"user_name":"User","character_name":"Utf8Char","chat_metadata":{"integrity":"u1"}}\n{"name":"User","is_user":true,"mes":"hi '),
            Buffer.from([0xFF]),
            Buffer.from(' there"}'),
        ]);
        fs.writeFileSync(utf8Path, badBuf);
        const utf8Target = createCharacterChatTarget({
            chatsDirectory: chatsDir,
            backupDirectory: backupsDir,
            owner: 'Utf8Char',
            filename: 'badutf8.jsonl',
            maxRecoveryStates: 25,
        });

        const payload = [
            { user_name: 'User', character_name: 'Utf8Char', chat_metadata: { integrity: 'u1' } },
            { name: 'User', is_user: true, mes: 'hi \uFFFD there' },
        ];
        const res = await trySaveChat(payload, utf8Path, false, 'user1', 'Utf8Char', backupsDir, {
            recoveryTarget: utf8Target,
            deferBackup: true,
        });
        expect(res.integrity).toBe('u1');

        const { latestPath } = getChatRecoveryPaths(utf8Target);
        const strictLatest = readChatJsonlStrict(latestPath);
        expect(strictLatest.status).toBe('ok');
        expect(chatStateCache.get(utf8Path)).toBeNull();
    });

    test('flushes pending Barrier #3 byte-0 active file before pruning or clearing its .latest.jsonl redo snapshot', async () => {
        const targetA = createCharacterChatTarget({
            chatsDirectory: chatsDir,
            backupDirectory: backupsDir,
            owner: 'TestCard',
            filename: 'chat-a.jsonl',
            maxRecoveryStates: 1,
        });
        const targetB = createCharacterChatTarget({
            chatsDirectory: chatsDir,
            backupDirectory: backupsDir,
            owner: 'TestCard',
            filename: 'chat-b.jsonl',
            maxRecoveryStates: 1,
        });

        const chatA = makeLargeChat(4, 'slug-a1');
        const saveA1 = await trySaveChat(chatA, targetA.activePath, false, 'user1', 'TestCard', backupsDir, {
            recoveryTarget: targetA,
            deferBackup: true,
        });
        // Second save triggers writeChatFileInPlaceFast (omits Barrier #3 and tracks dirty byte 0)
        chatA[0].chat_metadata.integrity = saveA1.integrity;
        chatA.push({ name: 'User', is_user: true, mes: 'second save in-place', extra: {} });
        await trySaveChat(chatA, targetA.activePath, false, 'user1', 'TestCard', backupsDir, {
            recoveryTarget: targetA,
            deferBackup: true,
        });
        expect(getDirtyByte0TrackingCount()).toBe(1);

        // Track ordering: active chat-a must be fsynced BEFORE its .latest.jsonl is unlinked by pruning
        const { latestPath: latestPathA } = getChatRecoveryPaths(targetA);
        const events = [];
        const realOpenSync = fs.openSync.bind(fs);
        const realFsyncSync = fs.fsyncSync.bind(fs);
        const realUnlinkSync = fs.unlinkSync.bind(fs);
        const fdPaths = new Map();
        jest.spyOn(fs, 'openSync').mockImplementation((p, ...rest) => {
            const fd = realOpenSync(p, ...rest);
            fdPaths.set(fd, String(p));
            return fd;
        });
        jest.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
            if (fdPaths.get(fd) === targetA.activePath) {
                events.push('fsync:chat-a');
            }
            return realFsyncSync(fd);
        });
        jest.spyOn(fs, 'unlinkSync').mockImplementation((p) => {
            if (String(p) === latestPathA) {
                events.push('unlink:latest-a');
            }
            return realUnlinkSync(p);
        });

        // Saving chat-b with maxRecoveryStates=1 evicts chat-a's .latest.jsonl
        const chatB = makeLargeChat(4, 'slug-b1');
        await trySaveChat(chatB, targetB.activePath, false, 'user1', 'TestCard', backupsDir, {
            recoveryTarget: targetB,
            deferBackup: true,
        });

        expect(events).toEqual(['fsync:chat-a', 'unlink:latest-a']);
        expect(getDirtyByte0TrackingCount()).toBe(0);

        // Verify clearChatRecoveryState also flushes a dirty active file
        const saveB2Payload = structuredClone(chatB);
        const loadedB = loadActiveChatWithRecovery(targetB);
        saveB2Payload[0].chat_metadata.integrity = loadedB.records[0].chat_metadata.integrity;
        saveB2Payload.push({ name: 'User', is_user: true, mes: 'trigger dirty B', extra: {} });
        await trySaveChat(saveB2Payload, targetB.activePath, false, 'user1', 'TestCard', backupsDir, {
            recoveryTarget: targetB,
            deferBackup: true,
        });
        expect(getDirtyByte0TrackingCount()).toBe(1);
        clearChatRecoveryState(targetB);
        expect(getDirtyByte0TrackingCount()).toBe(0);
    });

    test('getCanonicalChatCacheKey resolves the same key after both file and parent directory are deleted', () => {
        const nestedDir = path.join(ownerDir, 'ephemeral-sub');
        fs.mkdirSync(nestedDir, { recursive: true });
        const nestedFile = path.join(nestedDir, 'gone.jsonl');
        fs.writeFileSync(nestedFile, '{}', 'utf8');

        const keyBeforeDelete = getCanonicalChatCacheKey(nestedFile);
        fs.rmSync(nestedDir, { recursive: true, force: true });
        const keyAfterDelete = getCanonicalChatCacheKey(nestedFile);

        expect(keyAfterDelete).toBe(keyBeforeDelete);
    });
});

describe('crash fault-injection tests (SIGKILL via SB_FAULT_AT=)', () => {
    let tempRoot;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fault-inject-'));
    });

    afterEach(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    function runFaultInjectedChild({ chatsDir, backupsDir, owner, fileName, activePath, nextChat, faultAt, shrink }) {
        const childScript = `
            import { setConfigFilePath } from ${JSON.stringify(UTIL_URL)};
            setConfigFilePath(${JSON.stringify(CONFIG_PATH)});
            const { trySaveChat } = await import(${JSON.stringify(CHATS_URL)});
            const { createCharacterChatTarget } = await import(${JSON.stringify(RECOVERY_URL)});
            const target = createCharacterChatTarget({
                chatsDirectory: ${JSON.stringify(chatsDir)},
                backupDirectory: ${JSON.stringify(backupsDir)},
                owner: ${JSON.stringify(owner)},
                filename: ${JSON.stringify(fileName)},
                maxRecoveryStates: 25,
            });
            await trySaveChat(
                ${JSON.stringify(nextChat)},
                ${JSON.stringify(activePath)},
                false,
                'fault-user',
                ${JSON.stringify(owner)},
                ${JSON.stringify(backupsDir)},
                { deferBackup: true, recoveryTarget: target, allowShrink: ${JSON.stringify(shrink)} },
            );
            process.stdout.write('completed\\n');
        `;

        return spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
            cwd: WORKTREE_ROOT,
            env: {
                ...process.env,
                SB_ALLOW_TEST_FAULTS: '1',
                SB_FAULT_AT: faultAt,
                SB_FAULT_MODE: 'kill',
            },
            encoding: 'utf8',
            timeout: 15_000,
        });
    }

    const activeMutationFaultCases = [
        { faultAt: 'after_barrier_1', shrink: false },
        { faultAt: 'during_body_write', shrink: false },
        { faultAt: 'after_barrier_2', shrink: false },
        { faultAt: 'before_restore_byte0', shrink: false },
        { faultAt: 'before_restore_byte0', shrink: true },
    ];

    test.each(activeMutationFaultCases)(
        'recovers 100% of messages from .latest.jsonl after kill-9 at $faultAt (shrink=$shrink)',
        ({ faultAt, shrink }) => {
            const chatsDir = path.join(tempRoot, 'chats');
            const backupsDir = path.join(tempRoot, 'backups');
            const owner = 'CrashCard';
            const fileName = 'crash-session.jsonl';
            const activePath = path.join(chatsDir, owner, fileName);
            fs.mkdirSync(path.dirname(activePath), { recursive: true });
            fs.mkdirSync(backupsDir, { recursive: true });

            const recoveryTarget = createCharacterChatTarget({
                chatsDirectory: chatsDir,
                backupDirectory: backupsDir,
                owner,
                filename: fileName,
                maxRecoveryStates: 25,
            });

            const originalChat = makeLargeChat(shrink ? 40 : 12, 'pre-crash-slug');
            fs.writeFileSync(activePath, originalChat.map(JSON.stringify).join('\n'), 'utf8');

            const nextChat = shrink
                ? makeLargeChat(5, 'pre-crash-slug')
                : [
                    ...originalChat,
                    {
                        name: 'User',
                        is_user: true,
                        send_date: '2026-06-05T10:00:00.000Z',
                        mes: `Critical unsaved user message for ${faultAt}`,
                        extra: {},
                    },
                    {
                        name: 'BenchChar',
                        is_user: false,
                        send_date: '2026-06-05T10:00:05.000Z',
                        mes: `Critical assistant reply for ${faultAt}`,
                        extra: {},
                    },
                ];

            const child = runFaultInjectedChild({ chatsDir, backupsDir, owner, fileName, activePath, nextChat, faultAt, shrink });
            expect(child.stdout).not.toContain('completed');
            expect(child.status !== 0 || child.signal !== null).toBe(true);

            const { latestPath } = getChatRecoveryPaths(recoveryTarget);
            expect(fs.existsSync(latestPath)).toBe(true);
            const latestBytes = fs.readFileSync(latestPath);
            const rawActiveBytes = fs.readFileSync(activePath);

            // Byte 0 MUST be poisoned (`{` ^ 0xFF === 0x84), forcing strict read to treat active as corrupt
            expect(rawActiveBytes[0]).toBe('{'.charCodeAt(0) ^ 0xFF);
            expect(readChatJsonlStrict(activePath).status).toBe('corrupt');

            const recovered = loadActiveChatWithRecovery(recoveryTarget);
            expect(recovered.status).toBe('ok');
            expect(recovered.recovered).toBe(true);
            expect(recovered.source).toBe('snapshot');
            expect(recovered.records).toHaveLength(nextChat.length);
            expect(recovered.records[recovered.records.length - 1].mes).toBe(nextChat[nextChat.length - 1].mes);
            expect(fs.readFileSync(activePath)).toEqual(latestBytes);
        },
    );

    test('preserves valid authoritative active file when killed right after .latest.jsonl write (Invariant I1/I2)', () => {
        const chatsDir = path.join(tempRoot, 'chats');
        const backupsDir = path.join(tempRoot, 'backups');
        const owner = 'CrashCard';
        const fileName = 'pre-mutate.jsonl';
        const activePath = path.join(chatsDir, owner, fileName);
        fs.mkdirSync(path.dirname(activePath), { recursive: true });
        fs.mkdirSync(backupsDir, { recursive: true });

        const recoveryTarget = createCharacterChatTarget({
            chatsDirectory: chatsDir,
            backupDirectory: backupsDir,
            owner,
            filename: fileName,
            maxRecoveryStates: 25,
        });

        const originalChat = makeLargeChat(12, 'pre-crash-slug');
        fs.writeFileSync(activePath, originalChat.map(JSON.stringify).join('\n'), 'utf8');

        const nextChat = [
            ...originalChat,
            { name: 'User', is_user: true, send_date: '2026-06-05T10:00:00.000Z', mes: 'After latest snapshot', extra: {} },
        ];

        const child = runFaultInjectedChild({
            chatsDir,
            backupsDir,
            owner,
            fileName,
            activePath,
            nextChat,
            faultAt: 'after_latest_snapshot',
            shrink: false,
        });
        expect(child.stdout).not.toContain('completed');
        expect(child.status !== 0 || child.signal !== null).toBe(true);

        const activeResult = readChatJsonlStrict(activePath);
        expect(activeResult.status).toBe('ok');
        expect(activeResult.records).toHaveLength(originalChat.length);

        const { latestPath } = getChatRecoveryPaths(recoveryTarget);
        const latestResult = readChatJsonlStrict(latestPath);
        expect(latestResult.status).toBe('ok');
        expect(latestResult.records).toHaveLength(nextChat.length);
    });
});

describe('HTTP fast paths (/api/chats/get, /api/chats/search, /api/chats/recent) & 2,000-msg benchmark', () => {
    let server;
    let baseUrl;
    let tempRoot;
    let directories;

    beforeAll(async () => {
        const app = express();
        app.use(express.json({ limit: '50mb' }));
        app.use((req, _res, next) => {
            req.user = {
                profile: { handle: 'bench-user' },
                directories,
            };
            next();
        });
        app.use('/api/chats', chatsRouter);
        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        chatStateCache.clear();
        chatInfoCache.clear();
        backupDedupeCache.clear();
        clearDirtyByte0Tracking();
        clearChatRecoveryRuntimeCaches();
        clearActiveDeferredChatPreWrites();

        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fastpath-http-'));
        directories = {
            backups: path.join(tempRoot, 'backups'),
            chats: path.join(tempRoot, 'chats'),
            characters: path.join(tempRoot, 'characters'),
            groupChats: path.join(tempRoot, 'group chats'),
            groups: path.join(tempRoot, 'groups'),
        };
        for (const dir of Object.values(directories)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    afterAll(async () => {
        if (server) {
            await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
        }
    });

    function postJson(endpoint, body) {
        return fetch(`${baseUrl}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    test('/api/chats/get serves exact JSON via raw-row fast path and falls back for legacy header chat_metadata fixup', async () => {
        const charDir = path.join(directories.chats, 'Alice');
        fs.mkdirSync(charDir, { recursive: true });

        // Normal chat
        const chatPayload = makeLargeChat(20, 'slug-get');
        const saveRes = await postJson('/api/chats/save', {
            avatar_url: 'Alice.png',
            file_name: 'normal',
            chat: chatPayload,
            deferBackup: true,
        });
        const saveBody = await saveRes.json();
        expect(saveRes.status).toBe(200);
        expect(saveBody.ok).toBe(true);

        // Warm GET (hits ChatStateCache + rawRows fast response, skips JSON.parse & JSON.stringify)
        const getRes = await postJson('/api/chats/get', {
            avatar_url: 'Alice.png',
            file_name: 'normal',
        });
        expect(getRes.status).toBe(200);
        expect(getRes.headers.get('content-type')).toContain('application/json');
        const loaded = await getRes.json();
        expect(loaded).toHaveLength(chatPayload.length);
        expect(loaded[0].chat_metadata.integrity).toBe(saveBody.integrity);
        expect(loaded[loaded.length - 1].mes).toBe(chatPayload[chatPayload.length - 1].mes);

        // Legacy chat without chat_metadata must fall back to records fix-up and include chat_metadata: {}
        const legacyPath = path.join(charDir, 'legacy.jsonl');
        fs.writeFileSync(legacyPath, [
            JSON.stringify({ user_name: 'User', character_name: 'Alice' }),
            JSON.stringify({ name: 'Alice', is_user: false, mes: 'Legacy greeting' }),
        ].join('\n'), 'utf8');

        const legacyRes = await postJson('/api/chats/get', {
            avatar_url: 'Alice.png',
            file_name: 'legacy',
        });
        expect(legacyRes.status).toBe(200);
        const legacyLoaded = await legacyRes.json();
        expect(legacyLoaded[0].chat_metadata).toEqual({});
        expect(legacyLoaded[1].mes).toBe('Legacy greeting');
    });

    test('/api/chats/search uses O(M*F) fragment matcher and /api/chats/recent uses cached ChatInfo & Set pinned sort', async () => {
        const charDir = path.join(directories.chats, 'SearchChar');
        fs.mkdirSync(charDir, { recursive: true });
        fs.writeFileSync(path.join(directories.characters, 'SearchChar.png'), 'png');

        const chatA = makeLargeChat(200, 'slug-a');
        chatA[50].mes = 'The quick silver fox jumped';
        chatA[195].mes = 'over the lazy obsidian hound';
        fs.writeFileSync(path.join(charDir, 'chat-a.jsonl'), chatA.map(JSON.stringify).join('\n'), 'utf8');

        const chatB = makeLargeChat(200, 'slug-b');
        fs.writeFileSync(path.join(charDir, 'special-needle-file.jsonl'), chatB.map(JSON.stringify).join('\n'), 'utf8');

        // Multi-fragment split across distant messages
        const searchRes = await postJson('/api/chats/search', {
            avatar_url: 'SearchChar.png',
            query: 'silver obsidian',
        });
        expect(searchRes.status).toBe(200);
        const matches = await searchRes.json();
        expect(matches.map(m => m.file_name)).toEqual(['chat-a']);

        // Filename match
        const fileSearchRes = await postJson('/api/chats/search', {
            avatar_url: 'SearchChar.png',
            query: 'needle',
        });
        const fileMatches = await fileSearchRes.json();
        expect(fileMatches.map(m => m.file_name)).toEqual(['special-needle-file']);

        // Direct unit check on createFragmentSearchMatcher
        const fragMatcher = createFragmentSearchMatcher(['alpha', 'beta']);
        expect(fragMatcher(['only alpha'])).toBe(false);
        expect(fragMatcher(['first alpha', 'second beta'])).toBe(true);

        // /api/chats/recent pinned sort + ChatInfo cache hit on second call
        const recent1 = await postJson('/api/chats/recent', {
            max: 10,
            metadata: true,
            previewMessages: 3,
            pinned: [{ avatar: 'SearchChar.png', file_name: 'chat-a.jsonl' }],
        });
        expect(recent1.status).toBe(200);
        const recentBody1 = await recent1.json();
        expect(recentBody1).toHaveLength(2);
        expect(recentBody1[0].file_name).toBe('chat-a.jsonl');
        expect(recentBody1[0].preview_messages).toHaveLength(3);
        expect(recentBody1[0].chat_metadata.integrity).toBe('slug-a');

        const createReadStreamSpy = jest.spyOn(fs, 'createReadStream');
        const infoCached = await getChatInfo(path.join(charDir, 'chat-a.jsonl'), {}, true, null, 2);
        expect(infoCached.chat_items).toBe(200);
        expect(infoCached.preview_messages).toHaveLength(2);
        expect(createReadStreamSpy).not.toHaveBeenCalled();
    });

    test('micro-benchmark: 2,000-message chat save, get, and search complete rapidly with verified equivalence', async () => {
        const charDir = path.join(directories.chats, 'BenchChar');
        fs.mkdirSync(charDir, { recursive: true });
        const chatPath = path.join(charDir, 'big.jsonl');
        const recoveryTarget = createCharacterChatTarget({
            chatsDirectory: directories.chats,
            backupDirectory: directories.backups,
            owner: 'BenchChar',
            filename: 'big.jsonl',
            maxRecoveryStates: 25,
        });

        const chat2k = makeLargeChat(2000, 'bench-init');
        // Seed initial chat
        const seedRes = await trySaveChat(chat2k, chatPath, false, 'bench', 'BenchChar', directories.backups, {
            recoveryTarget,
            deferBackup: true,
        });
        let slug = seedRes.integrity;

        // Warm 2,000-msg append saves (5 iterations)
        const saveTimings = [];
        for (let iter = 0; iter < 5; iter++) {
            chat2k[0].chat_metadata.integrity = slug;
            chat2k.push({
                name: 'User',
                is_user: true,
                send_date: '2026-06-05T12:00:00.000Z',
                mes: `Incremental message #${iter}`,
                extra: {},
            });
            const t0 = performance.now();
            const res = await trySaveChat(chat2k, chatPath, false, 'bench', 'BenchChar', directories.backups, {
                recoveryTarget,
                deferBackup: true,
            });
            saveTimings.push(performance.now() - t0);
            slug = res.integrity;
        }

        // Warm 2,000-msg HTTP GETs (5 iterations)
        const getTimings = [];
        for (let iter = 0; iter < 5; iter++) {
            const t0 = performance.now();
            const res = await postJson('/api/chats/get', {
                avatar_url: 'BenchChar.png',
                file_name: 'big',
            });
            const body = await res.json();
            getTimings.push(performance.now() - t0);
            expect(res.status).toBe(200);
            expect(body).toHaveLength(chat2k.length);
        }

        // 2,000-msg multi-fragment search (non-matching worst case to exercise full scan!)
        const tSearch0 = performance.now();
        const searchRes = await postJson('/api/chats/search', {
            avatar_url: 'BenchChar.png',
            query: 'marker_0 nonexistent_tail_fragment',
        });
        const searchMs = performance.now() - tSearch0;
        expect(searchRes.status).toBe(200);
        await expect(searchRes.json()).resolves.toEqual([]);

        // Verify fast comparison beats legacy by a wide margin on 2,000-msg chat
        const diskStr = fs.readFileSync(chatPath, 'utf8');
        const diskSplit = splitChatLinesForComparison(diskStr);
        const tLegacy0 = performance.now();
        const legacySame = isSameChatSaveContentLegacy(diskStr, diskStr);
        const legacyCompareMs = performance.now() - tLegacy0;

        const tFast0 = performance.now();
        const fastSame = isSameChatSaveContentFast({ lines: diskSplit.lines, validated: true }, { lines: diskSplit.lines, validated: true });
        const fastCompareMs = performance.now() - tFast0;

        expect(fastSame).toBe(true);
        expect(fastSame).toBe(legacySame);
        expect(fastCompareMs).toBeLessThan(legacyCompareMs);
        expect(Math.min(...saveTimings)).toBeLessThan(1000);
        expect(Math.min(...getTimings)).toBeLessThan(500);
        expect(searchMs).toBeLessThan(2000);
    });
});
