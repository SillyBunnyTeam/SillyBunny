/* global globalThis */
import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConversationIndex } from '../src/conversation-index.js';

const originalDataRoot = globalThis.DATA_ROOT;

const SUMMARY = Object.freeze({ messageCount: 3, lastMessageAt: 1700000000123, preview: 'see you soon', unread: 2 });

afterAll(() => {
    globalThis.DATA_ROOT = originalDataRoot;
});

describe('conversation index', () => {
    let index;
    let tempRoot;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-conversation-index-'));
        globalThis.DATA_ROOT = tempRoot;
        index = new ConversationIndex({ enabled: true });
    });

    afterEach(() => {
        index.close();
        jest.restoreAllMocks();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    function chatFile(conversationId, chatId, text = 'one\n') {
        const filePath = path.join(tempRoot, 'conversations', conversationId, 'chats', `${chatId}.jsonl`);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, text);
        return { filePath, stat: fs.statSync(filePath) };
    }

    test('lives in the cache folder as conversations.sqlite', () => {
        expect(index.filePath).toBe(path.join(tempRoot, '_cache', 'conversations.sqlite'));
    });

    test('returns the summary of a chat while its file and read marker are unchanged', () => {
        const { filePath, stat } = chatFile('conv_1_aaaa', 'main');
        index.set(filePath, stat, 'm1', SUMMARY);

        expect(index.get(filePath, stat, 'm1')).toEqual(SUMMARY);
        expect(index.get(path.join(path.dirname(filePath), 'other.jsonl'), stat, 'm1')).toBeUndefined();
    });

    test.each([
        ['a different size', stat => ({ size: stat.size + 1, mtimeMs: stat.mtimeMs }), 'm1'],
        ['a different modification time', stat => ({ size: stat.size, mtimeMs: stat.mtimeMs + 1 }), 'm1'],
        ['another read marker', stat => stat, 'm2'],
        ['an empty read marker', stat => stat, ''],
    ])('does not return the summary for %s', (_name, changeStat, readThrough) => {
        const { filePath, stat } = chatFile('conv_1_aaaa', 'main');
        index.set(filePath, stat, 'm1', SUMMARY);

        expect(index.get(filePath, changeStat(stat), readThrough)).toBeUndefined();
    });

    test('keeps a row for an empty read marker apart from the row of a named one', () => {
        const { filePath, stat } = chatFile('conv_1_aaaa', 'main');
        index.set(filePath, stat, '', { ...SUMMARY, unread: 3 });

        expect(index.get(filePath, stat, '')).toEqual({ ...SUMMARY, unread: 3 });
        expect(index.get(filePath, stat, 'm1')).toBeUndefined();
    });

    test('replaces the row of a chat when it is set again', () => {
        const { filePath, stat } = chatFile('conv_1_aaaa', 'main');
        index.set(filePath, stat, 'm1', SUMMARY);
        index.set(filePath, stat, 'm1', { ...SUMMARY, messageCount: 9 });

        expect(index.get(filePath, stat, 'm1')?.messageCount).toBe(9);
    });

    test('keeps its rows when it is opened again', () => {
        const { filePath, stat } = chatFile('conv_1_aaaa', 'main');
        index.set(filePath, stat, 'm1', SUMMARY);
        index.close();

        const reopened = new ConversationIndex({ enabled: true });
        try {
            expect(reopened.get(filePath, stat, 'm1')).toEqual(SUMMARY);
        } finally {
            reopened.close();
        }
    });

    test('does not store a preview that has a NUL character, so the list reads the file for it', () => {
        const { filePath, stat } = chatFile('conv_1_aaaa', 'main');
        index.set(filePath, stat, 'm1', { ...SUMMARY, preview: 'cut\0off' });

        expect(index.get(filePath, stat, 'm1')).toBeUndefined();
    });

    test('does not store a row for a read marker that has a NUL character', () => {
        const { filePath, stat } = chatFile('conv_1_aaaa', 'main');
        index.set(filePath, stat, 'm\0one', SUMMARY);

        expect(index.get(filePath, stat, 'm\0one')).toBeUndefined();
    });

    test('keeps a preview with multi-byte text and quotes unchanged', () => {
        const { filePath, stat } = chatFile('conv_1_aaaa', 'main');
        const preview = '"quoted" \u{1F430} こんにちは \' ; --';
        index.set(filePath, stat, 'm1', { ...SUMMARY, preview });

        expect(index.get(filePath, stat, 'm1')?.preview).toBe(preview);
    });

    test('forgets one chat', () => {
        const first = chatFile('conv_1_aaaa', 'main');
        const second = chatFile('conv_1_aaaa', 'second');
        index.set(first.filePath, first.stat, '', SUMMARY);
        index.set(second.filePath, second.stat, '', SUMMARY);

        index.delete(first.filePath);

        expect(index.get(first.filePath, first.stat, '')).toBeUndefined();
        expect(index.get(second.filePath, second.stat, '')).toEqual(SUMMARY);
    });

    test('forgets every chat in a folder and no other', () => {
        const first = chatFile('conv_1_aaaa', 'main');
        const second = chatFile('conv_1_aaaa', 'second');
        const other = chatFile('conv_2_bbbb', 'main');
        for (const item of [first, second, other]) {
            index.set(item.filePath, item.stat, '', SUMMARY);
        }

        index.deleteFolder(path.dirname(first.filePath));

        expect(index.get(first.filePath, first.stat, '')).toBeUndefined();
        expect(index.get(second.filePath, second.stat, '')).toBeUndefined();
        expect(index.get(other.filePath, other.stat, '')).toEqual(SUMMARY);
    });

    test('retains the rows of the listed chats under a folder, and leaves rows outside it alone', () => {
        const kept = chatFile('conv_1_aaaa', 'main');
        const gone = chatFile('conv_1_aaaa', 'gone');
        const goneConversation = chatFile('conv_2_bbbb', 'main');
        const otherUser = {
            filePath: path.join(tempRoot, 'other-user', 'conversations', 'conv_3_cccc', 'chats', 'main.jsonl'),
        };
        fs.mkdirSync(path.dirname(otherUser.filePath), { recursive: true });
        fs.writeFileSync(otherUser.filePath, 'x');
        otherUser.stat = fs.statSync(otherUser.filePath);
        for (const item of [kept, gone, goneConversation, otherUser]) {
            index.set(item.filePath, item.stat, '', SUMMARY);
        }

        index.retain(path.join(tempRoot, 'conversations'), [kept.filePath]);

        expect(index.get(kept.filePath, kept.stat, '')).toEqual(SUMMARY);
        expect(index.get(gone.filePath, gone.stat, '')).toBeUndefined();
        expect(index.get(goneConversation.filePath, goneConversation.stat, '')).toBeUndefined();
        expect(index.get(otherUser.filePath, otherUser.stat, '')).toEqual(SUMMARY);
    });

    test('does not create a file while it is off', () => {
        const off = new ConversationIndex({ enabled: false });
        const { filePath, stat } = chatFile('conv_1_aaaa', 'main');

        off.set(filePath, stat, '', SUMMARY);

        expect(off.get(filePath, stat, '')).toBeUndefined();
        expect(fs.existsSync(off.filePath)).toBe(false);
    });

    test('turns itself off after an error, and answers as if every row were missing', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        // A data root that is a file makes the cache folder impossible to create.
        const blocker = path.join(tempRoot, 'blocked');
        fs.writeFileSync(blocker, 'x');
        globalThis.DATA_ROOT = blocker;
        const broken = new ConversationIndex({ enabled: true });
        const { filePath, stat } = chatFile('conv_1_aaaa', 'main');

        try {
            broken.set(filePath, stat, '', SUMMARY);
            expect(broken.get(filePath, stat, '')).toBeUndefined();
            expect(warn).toHaveBeenCalledTimes(1);
            expect(String(warn.mock.calls[0][0])).toContain('Conversation index');
        } finally {
            broken.close();
        }
    });
});
