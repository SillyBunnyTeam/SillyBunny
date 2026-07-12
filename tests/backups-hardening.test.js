import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const {
    isCanonicalChatBackupName,
    listChatBackupModels,
    router,
} = await import('../src/endpoints/backups.js');

describe('chat backup route hardening', () => {
    let backupDirectory;
    let outsideDirectory;
    let server;
    let baseUrl;

    beforeAll(async () => {
        backupDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-backups-'));
        outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-backups-outside-'));

        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            request.user = { directories: { backups: backupDirectory } };
            next();
        });
        app.use(router);

        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async () => {
        if (server) {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
        fs.rmSync(backupDirectory, { recursive: true, force: true });
        fs.rmSync(outsideDirectory, { recursive: true, force: true });
    });

    test('accepts only canonical top-level chat JSONL names', () => {
        expect(isCanonicalChatBackupName('chat_valid.jsonl')).toBe(true);
        expect(isCanonicalChatBackupName('../chat_valid.jsonl')).toBe(false);
        expect(isCanonicalChatBackupName('nested/chat_valid.jsonl')).toBe(false);
        expect(isCanonicalChatBackupName('chat_bad?.jsonl')).toBe(false);
        expect(isCanonicalChatBackupName('chat_valid.txt')).toBe(false);
        expect(isCanonicalChatBackupName('settings.jsonl')).toBe(false);
        expect(isCanonicalChatBackupName(null)).toBe(false);
    });

    test('keeps the backups drawer visible and recoverable while loading', () => {
        const source = fs.readFileSync(new URL('../public/scripts/chat-backups.js', import.meta.url), 'utf8');
        const loadingIndex = source.indexOf('replaceChildren(this.renderListMessage(t`Loading chat…`))');
        const requestIndex = source.indexOf('fetchBackupApi(\'/api/backups/chat/get\'');

        expect(source).toContain('import { fetchWithCsrfRetry } from \'./csrf-token-refresh.js\';');
        expect(source).toContain('refreshCsrfToken');
        expect(loadingIndex).toBeGreaterThan(-1);
        expect(requestIndex).toBeGreaterThan(loadingIndex);
        expect(source).toContain('t`Could not load chat data. Try reloading the page.`');
        expect(source).toContain('error?.name === \'AbortError\' || signal.aborted');
        expect(source).toContain('button.type = \'button\';');
        expect(source).toContain('button.setAttribute(\'aria-expanded\', \'false\');');
        expect(source).toContain('button.setAttribute(\'aria-controls\', BACKUPS_LIST_ID);');
        expect(source).toContain('backup.chat_items !== undefined && backup.chat_items !== null');
    });

    test('lists corrupt, empty, large, and unreadable regular backups without reading their contents', async () => {
        fs.writeFileSync(path.join(backupDirectory, 'chat_corrupt.jsonl'), 'not jsonl');
        fs.writeFileSync(path.join(backupDirectory, 'chat_empty.jsonl'), '');
        fs.writeFileSync(path.join(backupDirectory, 'chat_large.jsonl'), 'x'.repeat(2 * 1024 * 1024));
        fs.writeFileSync(path.join(backupDirectory, 'chat_unreadable.jsonl'), 'unreadable');
        fs.chmodSync(path.join(backupDirectory, 'chat_unreadable.jsonl'), 0o000);
        fs.writeFileSync(path.join(backupDirectory, 'chat_wrong.txt'), 'ignored');
        fs.writeFileSync(path.join(backupDirectory, 'settings.jsonl'), 'ignored');
        fs.mkdirSync(path.join(backupDirectory, 'chat_directory.jsonl'));
        fs.symlinkSync(path.join(backupDirectory, 'chat_corrupt.jsonl'), path.join(backupDirectory, 'chat_link.jsonl'));

        const readStreamSpy = jest.spyOn(fs, 'createReadStream');
        try {
            const backups = await listChatBackupModels(backupDirectory);
            expect(backups.map(backup => backup.file_name).sort()).toEqual([
                'chat_corrupt.jsonl',
                'chat_empty.jsonl',
                'chat_large.jsonl',
                'chat_unreadable.jsonl',
            ]);
            expect(backups.every(backup => !Object.hasOwn(backup, 'chat_items'))).toBe(true);
            expect(readStreamSpy).not.toHaveBeenCalled();
        } finally {
            readStreamSpy.mockRestore();
            fs.chmodSync(path.join(backupDirectory, 'chat_unreadable.jsonl'), 0o600);
        }
    });

    test('skips entries that disappear or cannot be inspected', async () => {
        fs.writeFileSync(path.join(backupDirectory, 'chat_stable.jsonl'), 'stable');
        fs.writeFileSync(path.join(backupDirectory, 'chat_disappeared.jsonl'), 'gone');
        fs.writeFileSync(path.join(backupDirectory, 'chat_inaccessible.jsonl'), 'blocked');

        const realLstat = fs.promises.lstat.bind(fs.promises);
        const lstatSpy = jest.spyOn(fs.promises, 'lstat').mockImplementation((filePath) => {
            if (path.basename(filePath) === 'chat_disappeared.jsonl') {
                return Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }));
            }
            if (path.basename(filePath) === 'chat_inaccessible.jsonl') {
                return Promise.reject(Object.assign(new Error('blocked'), { code: 'EACCES' }));
            }
            return realLstat(filePath);
        });

        try {
            const backups = await listChatBackupModels(backupDirectory);
            expect(backups.some(backup => backup.file_name === 'chat_stable.jsonl')).toBe(true);
            expect(backups.some(backup => backup.file_name === 'chat_disappeared.jsonl')).toBe(false);
            expect(backups.some(backup => backup.file_name === 'chat_inaccessible.jsonl')).toBe(false);
        } finally {
            lstatSpy.mockRestore();
        }
    });

    test('download and delete reject aliases, unrelated files, directories, and symlinks', async () => {
        const outsidePath = path.join(outsideDirectory, 'chat_outside.jsonl');
        const sanitizedTarget = path.join(backupDirectory, 'chat_bad.jsonl');
        fs.writeFileSync(outsidePath, 'outside');
        fs.writeFileSync(sanitizedTarget, 'inside');
        fs.mkdirSync(path.join(backupDirectory, 'chat_not_file.jsonl'));
        fs.symlinkSync(outsidePath, path.join(backupDirectory, 'chat_outside_link.jsonl'));

        const rejectedNames = [
            '../chat_outside.jsonl',
            'chat_bad?.jsonl',
            'chat_bad.txt',
            'settings.jsonl',
            'chat_not_file.jsonl',
            'chat_outside_link.jsonl',
        ];

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            for (const endpoint of ['download', 'delete']) {
                for (const name of rejectedNames) {
                    const response = await postBackupRequest(endpoint, name);
                    expect(response.status).toBe(400);
                }
            }
        } finally {
            warnSpy.mockRestore();
        }

        expect(fs.readFileSync(outsidePath, 'utf8')).toBe('outside');
        expect(fs.readFileSync(sanitizedTarget, 'utf8')).toBe('inside');
    });

    test('download and delete operate on regular scoped backups', async () => {
        const name = 'chat_route_valid.jsonl';
        const filePath = path.join(backupDirectory, name);
        fs.writeFileSync(filePath, 'backup body');

        const downloadResponse = await postBackupRequest('download', name);
        expect(downloadResponse.status).toBe(200);
        expect(await downloadResponse.text()).toBe('backup body');

        const deleteResponse = await postBackupRequest('delete', name);
        expect(deleteResponse.status).toBe(200);
        expect(fs.existsSync(filePath)).toBe(false);
        expect((await postBackupRequest('download', name)).status).toBe(404);
    });

    function postBackupRequest(endpoint, name) {
        return fetch(`${baseUrl}/chat/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
    }
});
