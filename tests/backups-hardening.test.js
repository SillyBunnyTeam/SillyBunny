/* global globalThis */
import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const pub = relative => fileURLToPath(new URL(`../public/${relative}`, import.meta.url));

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

    test('keeps the backups drawer visible and recoverable while loading', async () => {
        const dom = new JSDOM('<!doctype html><html><body><div id="select_chat_popup"><input id="select_chat_search"><div id="select_chat_div"></div></div></body></html>');
        const previousGlobals = {
            window: globalThis.window,
            document: globalThis.document,
            HTMLElement: globalThis.HTMLElement,
            Node: globalThis.Node,
            Event: globalThis.Event,
            toastr: globalThis.toastr,
        };
        Object.assign(globalThis, {
            window: dom.window,
            document: dom.window.document,
            HTMLElement: dom.window.HTMLElement,
            Node: dom.window.Node,
            Event: dom.window.Event,
            toastr: { info: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() },
        });
        const refreshCsrfToken = jest.fn(async () => 'fresh-csrf');
        const fetchSpy = jest.spyOn(globalThis, 'fetch');
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            jest.resetModules();
            await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
                t: (strings, ...values) => strings.reduce((out, part, idx) => out + part + (values[idx] ?? ''), ''),
            }));
            await jest.unstable_mockModule(pub('scripts/popup.js'), () => ({
                callGenericPopup: jest.fn(async () => null),
                Popup: { show: { confirm: jest.fn(async () => false) } },
                POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
                POPUP_TYPE: { TEXT: 1 },
            }));
            await jest.unstable_mockModule(pub('scripts/utils.js'), () => ({
                clamp: (value, min, max) => Math.min(Math.max(value, min), max),
                escapeHtml: value => String(value ?? ''),
                getFileExtension: file => String(file?.name ?? '').split('.').pop(),
                sortMoments: () => 0,
                timestampToMoment: () => ({ isValid: () => true, valueOf: () => 0, format: () => 'Jan 1, 2026' }),
            }));
            await jest.unstable_mockModule(pub('script.js'), () => ({
                displayPastChats: jest.fn(async () => {}),
                getRequestHeaders: jest.fn(() => ({ 'Content-Type': 'application/json' })),
                importCharacterChat: jest.fn(async () => []),
                refreshCsrfToken,
            }));
            await jest.unstable_mockModule(pub('scripts/group-chats.js'), () => ({
                importGroupChat: jest.fn(async () => []),
            }));

            const { addChatBackupsBrowser } = await import('../public/scripts/chat-backups.js');
            addChatBackupsBrowser();

            const button = document.querySelector('[aria-controls="chat_backups_list"]');
            const list = document.getElementById('chat_backups_list');
            expect(button).not.toBeNull();
            expect(button.type).toBe('button');
            expect(button.getAttribute('aria-expanded')).toBe('false');
            expect(button.getAttribute('aria-controls')).toBe('chat_backups_list');

            // 1. Shows loading text before the request settles, retries once on 403 CSRF, and renders items without chat_items.
            const pendingFetch = Promise.withResolvers();
            fetchSpy
                .mockImplementationOnce(() => pendingFetch.promise)
                .mockResolvedValueOnce(new Response(JSON.stringify([
                    { file_name: 'chat_a.jsonl', file_size: '1 KB', mtime: 1000 },
                    { file_name: 'chat_b.jsonl', file_size: '2 KB', mtime: 2000, chat_items: 5 },
                ]), { status: 200, headers: { 'Content-Type': 'application/json' } }));

            button.click();
            expect(button.getAttribute('aria-expanded')).toBe('true');
            expect(list.textContent).toContain('Loading chat…');
            await Promise.resolve();
            expect(fetchSpy).toHaveBeenCalledWith('/api/backups/chat/get', expect.objectContaining({ method: 'POST' }));

            pendingFetch.resolve(new Response('Invalid CSRF token', { status: 403 }));
            for (let i = 0; i < 20 && !list.querySelector('.chatBackupsListItem'); i++) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            expect(refreshCsrfToken).toHaveBeenCalledTimes(1);
            const infos = [...list.querySelectorAll('.chatBackupsListItemInfo')].map(el => el.textContent);
            expect(infos.some(text => text.includes('1 KB') && !text.includes('undefined') && !text.includes('💬'))).toBe(true);
            expect(infos.some(text => text.includes('5 💬'))).toBe(true);

            // 2. Closing while loading aborts silently without showing an error message.
            button.click(); // close
            const abortableFetch = new Promise((_resolve, reject) => {
                fetchSpy.mockImplementationOnce((_url, init) => new Promise((_res, rej) => {
                    init.signal.addEventListener('abort', () => {
                        const err = new Error('Aborted');
                        err.name = 'AbortError';
                        rej(err);
                        reject(err);
                    });
                }));
            });
            button.click(); // open
            await Promise.resolve();
            button.click(); // close while loading -> triggers abort
            await abortableFetch.catch(() => {});
            await new Promise(resolve => setTimeout(resolve, 20));
            expect(list.textContent).not.toContain('Could not load chat data');

            // 3. A failed fetch shows the recovery message.
            fetchSpy.mockRejectedValueOnce(new Error('Network down'));
            button.click();
            for (let i = 0; i < 20 && !list.textContent.includes('Could not load chat data'); i++) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            expect(list.textContent).toContain('Could not load chat data. Try reloading the page.');
        } finally {
            consoleErrorSpy.mockRestore();
            fetchSpy.mockRestore();
            dom.window.close();
            for (const [key, value] of Object.entries(previousGlobals)) {
                if (value === undefined) delete globalThis[key];
                else globalThis[key] = value;
            }
        }
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
