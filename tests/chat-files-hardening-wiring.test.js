/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

const defaultConfigPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
const pub = relative => fileURLToPath(new URL(`../public/${relative}`, import.meta.url));

setConfigFilePath(defaultConfigPath);

function readSource(relativePath) {
    return fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

function getFunctionBody(source, start, end) {
    return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}

function mountChatHistoryDom() {
    const dom = new JSDOM(`<!doctype html><html><body>
        <div id="shadow_select_chat_popup">
            <div id="select_chat_popup">
                <div id="selectChatPopupHeaderText"><span data-i18n="Chat History">Chat History</span></div>
                <input id="select_chat_search" type="search">
                <div id="select_chat_div"><div class="select_chat_block">Chat 1</div></div>
            </div>
        </div>
    </body></html>`, { url: 'http://127.0.0.1/' });
    const previous = {
        window: globalThis.window,
        document: globalThis.document,
        HTMLElement: globalThis.HTMLElement,
        HTMLInputElement: globalThis.HTMLInputElement,
        HTMLButtonElement: globalThis.HTMLButtonElement,
        HTMLLabelElement: globalThis.HTMLLabelElement,
        HTMLDialogElement: globalThis.HTMLDialogElement,
        Node: globalThis.Node,
        Event: globalThis.Event,
        CustomEvent: globalThis.CustomEvent,
        MutationObserver: globalThis.MutationObserver,
        getComputedStyle: globalThis.getComputedStyle,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        cancelAnimationFrame: globalThis.cancelAnimationFrame,
        toastr: globalThis.toastr,
    };
    dom.window.matchMedia = () => ({ matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() });
    dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        HTMLElement: dom.window.HTMLElement,
        HTMLInputElement: dom.window.HTMLInputElement,
        HTMLButtonElement: dom.window.HTMLButtonElement,
        HTMLLabelElement: dom.window.HTMLLabelElement,
        HTMLDialogElement: dom.window.HTMLDialogElement,
        Node: dom.window.Node,
        Event: dom.window.Event,
        CustomEvent: dom.window.CustomEvent,
        MutationObserver: dom.window.MutationObserver,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        requestAnimationFrame: cb => setTimeout(cb, 0),
        cancelAnimationFrame: id => clearTimeout(id),
        toastr: { info: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() },
    });
    return {
        dom,
        restore() {
            dom.window.close();
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete globalThis[key];
                else globalThis[key] = value;
            }
        },
    };
}

describe('chat file hardening wiring', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        jest.resetModules();
    });

    test('uses pointer-only character rename persistence with rollback and exact reload checks', () => {
        const source = readSource('../public/script.js');
        const renameBody = getFunctionBody(
            source,
            'export async function renameGroupOrCharacterChat',
            'export async function renameChat',
        );

        expect(renameBody).toContain('await updateRemoteChatName(characterId, actualNewFileName);');
        expect(renameBody).not.toContain('createOrEditCharacter');
        expect(renameBody).toContain('await sendRenameRequest(rollbackBody);');
        expect(renameBody).toContain('wasActiveTarget && isStillActiveTarget');
        expect(renameBody).toContain('newFileName: `${actualNewFileName}.jsonl`');
    });

    test('does not turn strict character load failures into fresh greetings', () => {
        const source = readSource('../public/script.js');
        const getChatBody = getFunctionBody(
            source,
            'export async function getChat',
            'async function getChatResult',
        );

        expect(getChatBody).toContain('allow_create: resolvedChat.created');
        expect(getChatBody).toContain('return false;');
        expect(getChatBody.match(/getChatResult/g)).toHaveLength(1);
    });

    test('connects exact recovery to save, load, rename, and intentional deletion routes', async () => {
        const { setConfigFilePath: setFreshConfig } = await import('../src/util.js');
        setFreshConfig(defaultConfigPath);
        const {
            createCharacterChatTarget,
            createGroupChatTarget,
            getChatRecoveryPaths,
        } = await import('../src/chat-recovery.js');
        const { router: chatsRouter } = await import('../src/endpoints/chats.js');
        const { router: charactersRouter } = await import('../src/endpoints/characters.js');
        const { router: groupsRouter } = await import('../src/endpoints/groups.js');

        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-chat-hardening-'));
        const directories = {
            backups: path.join(tempRoot, 'backups'),
            chats: path.join(tempRoot, 'chats'),
            characters: path.join(tempRoot, 'characters'),
            groupChats: path.join(tempRoot, 'group chats'),
            groups: path.join(tempRoot, 'groups'),
            thumbnailsAvatar: path.join(tempRoot, 'thumbnails', 'avatar'),
            thumbnailsAvatarMobile: path.join(tempRoot, 'thumbnails', 'avatar-mobile'),
        };
        for (const dir of Object.values(directories)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { profile: { handle: 'hardening-user' }, directories };
            next();
        });
        app.use('/api/chats', chatsRouter);
        app.use('/api/characters', charactersRouter);
        app.use('/api/groups', groupsRouter);

        const server = await new Promise(resolve => {
            const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
        });
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        const postJson = (route, body) => fetch(`${baseUrl}${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        try {
            // 1. Save writes a latest recovery snapshot; corrupt primary recovers from it on load.
            const owner = 'Hero';
            fs.mkdirSync(path.join(directories.chats, owner), { recursive: true });
            const saveRes = await postJson('/api/chats/save', {
                avatar_url: `${owner}.png`,
                file_name: 'Story',
                chat: [
                    { chat_metadata: {}, user_name: 'U', character_name: owner },
                    { name: owner, mes: 'saved safely' },
                ],
                deferBackup: true,
            });
            expect(saveRes.status).toBe(200);
            const target = createCharacterChatTarget({
                chatsDirectory: directories.chats,
                backupDirectory: directories.backups,
                owner,
                filename: 'Story.jsonl',
            });
            const recoveryPaths = getChatRecoveryPaths(target);
            expect(fs.existsSync(recoveryPaths.latestPath)).toBe(true);

            // Corrupt the primary file and confirm /api/chats/get recovers the saved message.
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            fs.writeFileSync(path.join(directories.chats, owner, 'Story.jsonl'), '{broken json');
            const loadRes = await postJson('/api/chats/get', {
                avatar_url: `${owner}.png`,
                file_name: 'Story',
            });
            warnSpy.mockRestore();
            expect(loadRes.status).toBe(200);
            const loaded = await loadRes.json();
            expect(loaded.some(entry => entry.mes === 'saved safely')).toBe(true);

            // 2. Rename moves recovery state to the new name.
            const renameRes = await postJson('/api/chats/rename', {
                avatar_url: `${owner}.png`,
                original_file: 'Story.jsonl',
                renamed_file: 'Renamed.jsonl',
                is_group: false,
            });
            expect(renameRes.status).toBe(200);
            const renamedTarget = createCharacterChatTarget({
                chatsDirectory: directories.chats,
                backupDirectory: directories.backups,
                owner,
                filename: 'Renamed.jsonl',
            });
            expect(fs.existsSync(recoveryPaths.latestPath)).toBe(false);
            expect(fs.existsSync(getChatRecoveryPaths(renamedTarget).latestPath)).toBe(true);

            // 3. Character deletion clears recovery state; group deletion clears group recovery state.
            fs.writeFileSync(path.join(directories.characters, `${owner}.png`), 'avatar');
            const deleteCharRes = await postJson('/api/characters/delete', {
                avatar_url: `${owner}.png`,
                delete_chats: true,
            });
            expect(deleteCharRes.status).toBe(200);
            expect(fs.existsSync(getChatRecoveryPaths(renamedTarget).latestPath)).toBe(false);

            const groupId = 'g1';
            const groupChatId = 'GroupStory';
            fs.writeFileSync(path.join(directories.groups, `${groupId}.json`), JSON.stringify({ id: groupId, chats: [groupChatId] }));
            const saveGroupRes = await postJson('/api/chats/group/save', {
                id: groupChatId,
                chat: [
                    { chat_metadata: {}, user_name: 'U', character_name: 'G' },
                    { name: 'G', mes: 'group saved' },
                ],
                deferBackup: true,
            });
            expect(saveGroupRes.status).toBe(200);
            const groupTarget = createGroupChatTarget({
                groupChatsDirectory: directories.groupChats,
                backupDirectory: directories.backups,
                filename: `${groupChatId}.jsonl`,
            });
            expect(fs.existsSync(getChatRecoveryPaths(groupTarget).latestPath)).toBe(true);
            const deleteGroupRes = await postJson('/api/groups/delete', { id: groupId });
            expect(deleteGroupRes.status).toBe(200);
            expect(fs.existsSync(getChatRecoveryPaths(groupTarget).latestPath)).toBe(false);
        } finally {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    test('uses the framed list area while browsing backups and previews content inline without nested modals', async () => {
        const styles = readSource('../public/css/chat-backups.css');
        expect(styles).toContain('.chatBackupsList');
        expect(styles).toContain('.chatBackupPreview');
        expect(styles).toContain('position: -webkit-sticky;');

        const env = mountChatHistoryDom();
        const callGenericPopup = jest.fn(async () => null);
        const fetchSpy = jest.spyOn(globalThis, 'fetch');
        try {
            await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
                t: (strings, ...values) => strings.reduce((out, part, idx) => out + part + (values[idx] ?? ''), ''),
                translate: value => value,
            }));
            await jest.unstable_mockModule(pub('scripts/popup.js'), () => ({
                callGenericPopup,
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
                refreshCsrfToken: jest.fn(async () => 'token'),
            }));
            await jest.unstable_mockModule(pub('scripts/group-chats.js'), () => ({
                importGroupChat: jest.fn(async () => []),
            }));
            await jest.unstable_mockModule(pub('scripts/sillybunny-action-menu.js'), () => ({
                openActionMenu: jest.fn(),
                closeActionMenu: jest.fn(),
                positionPopover: jest.fn(() => '0px 0'),
                MOBILE_QUERY: '(max-width: 768px)',
            }));
            await jest.unstable_mockModule(pub('scripts/sillybunny-sheet.js'), () => ({
                blockUpstreamDrawerClose: jest.fn(),
                createSheetController: ({ sheet, backdrop, onClose }) => ({
                    open: () => { sheet.hidden = false; backdrop.hidden = false; },
                    close: () => { sheet.hidden = true; backdrop.hidden = true; onClose?.(); return true; },
                }),
            }));

            const { addChatBackupsBrowser } = await import('../public/scripts/chat-backups.js');
            const { openChatHistoryDialog } = await import('../public/scripts/sillybunny-chat-dialogs.js');

            addChatBackupsBrowser();
            const dialog = openChatHistoryDialog();

            const pageContent = dialog.root.querySelector('.sb-chat-history-list-page');
            const chatList = document.getElementById('select_chat_div');
            const backupsList = document.getElementById('chat_backups_list');
            const backupsButton = document.querySelector('[aria-controls="chat_backups_list"]');

            expect(backupsList.hidden).toBe(true);
            expect(chatList.hidden).toBe(false);

            fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify([
                { file_name: 'chat_sample.jsonl', file_size: '1 KB', mtime: 1000 },
            ]), { status: 200, headers: { 'Content-Type': 'application/json' } }));

            backupsButton.click();
            await new Promise(resolve => setTimeout(resolve, 20));
            expect(pageContent.classList.contains('chatBackupsOpen')).toBe(true);
            expect(backupsList.hidden).toBe(false);
            expect(chatList.hidden).toBe(true);

            // Previewing a backup renders a <section class="chatBackupPreview"> with <pre> messages inline, not a modal or textarea.
            const backupJsonl = [
                JSON.stringify({ chat_metadata: {} }),
                JSON.stringify({ name: 'Alice', send_date: '2026-01-01T00:00:00Z', mes: 'Hello inline preview' }),
            ].join('\n');
            fetchSpy.mockResolvedValueOnce(new Response(backupJsonl, { status: 200 }));

            backupsList.querySelector('[title="View backup"]').click();
            for (let i = 0; i < 20 && !backupsList.querySelector('section.chatBackupPreview'); i++) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }

            const preview = backupsList.querySelector('section.chatBackupPreview');
            expect(preview).not.toBeNull();
            expect(preview.querySelector('pre')?.textContent).toContain('Hello inline preview');
            expect(preview.querySelector('textarea')).toBeNull();
            expect(callGenericPopup).not.toHaveBeenCalled();

            // Closing backups restores the chat list.
            backupsButton.click(); // exit preview back to list
            backupsButton.click(); // close backups
            await new Promise(resolve => setTimeout(resolve, 20));
            expect(pageContent.classList.contains('chatBackupsOpen')).toBe(false);
            expect(backupsList.hidden).toBe(true);
            expect(chatList.hidden).toBe(false);
        } finally {
            fetchSpy.mockRestore();
            env.restore();
        }
    });
});
