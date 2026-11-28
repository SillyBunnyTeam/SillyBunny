/* global globalThis */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for shipped files. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, jest, test } from '@jest/globals';

import { setConfigFilePath } from '../../src/util.js';
import { RETIRED_ACCOUNT_KEYS, RETIRED_LOCAL_KEYS } from '../../public/scripts/sillybunny-retired-keys.js';

setConfigFilePath(fileURLToPath(new URL('../../default/config.yaml', import.meta.url)));

const { checkForNewContent } = await import('../../src/endpoints/content-manager.js');

const REPO = fileURLToPath(new URL('../../', import.meta.url));

/**
 * `system_avatar` is saved into chat files as `force_avatar` of narrator (`/sys`) and tool-call messages, and a reload uses that path as the
 * `src` of the message avatar. These are the files it pointed at in releases, so every chat saved by those versions still names one of them.
 * (`img/five.png` is the upstream value, which the app also still ships.)
 */
const SAVED_CHAT_IMAGES = Object.freeze({
    'public/img/sillybunny-pixel-logo.png': '371113f7a81db6f06aebb241d6dcddbb5b15b4fe7e1da3525af4d2b6ad81c988',
    'public/img/sillybunny-pixel-logo-og.png': 'a3bb29f82f531181454c79def67d856309edf1adeddaaa6f44e730df21469bfd',
    'public/img/sillybunny-badge.png': 'b6c22eb5de41e6457436f77065994d3cebd9f45cc91cb8d699fb2bbeaac25a2c',
});

const read = (relativePath) => readFileSync(path.join(REPO, relativePath));

describe('the images that saved chats point at', () => {
    test('stay in public/img, unchanged, because system_avatar was saved into chats as force_avatar and old messages load them by path', () => {
        for (const [file, hash] of Object.entries(SAVED_CHAT_IMAGES)) {
            expect(existsSync(path.join(REPO, file))).toBe(true);
            expect(createHash('sha256').update(read(file)).digest('hex')).toBe(hash);
        }
        expect(existsSync(path.join(REPO, 'public/img/five.png'))).toBe(true);
    });

    test('are not retired by client key cleanup or removed by default content reconciliation', async () => {
        const retiredKeys = [...RETIRED_ACCOUNT_KEYS, ...RETIRED_LOCAL_KEYS];
        for (const image of Object.keys(SAVED_CHAT_IMAGES)) {
            const base = path.basename(image);
            expect(retiredKeys.some(key => key.includes(base))).toBe(false);
        }

        const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'sillybunny-saved-chat-images-'));
        const previousDataRoot = globalThis.DATA_ROOT;
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        const consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
        globalThis.DATA_ROOT = tempRoot;
        try {
            const directories = {
                root: tempRoot,
                backups: path.join(tempRoot, 'backups'),
                characters: path.join(tempRoot, 'characters'),
                chats: path.join(tempRoot, 'chats'),
                avatars: path.join(tempRoot, 'User Avatars'),
                backgrounds: path.join(tempRoot, 'backgrounds'),
                worlds: path.join(tempRoot, 'worlds'),
                themes: path.join(tempRoot, 'themes'),
                openAI_Settings: path.join(tempRoot, 'OpenAI Settings'),
                koboldAI_Settings: path.join(tempRoot, 'KoboldAI Settings'),
                novelAI_Settings: path.join(tempRoot, 'NovelAI Settings'),
                textGen_Settings: path.join(tempRoot, 'TextGen Settings'),
                instruct: path.join(tempRoot, 'instruct'),
                context: path.join(tempRoot, 'context'),
                sysprompt: path.join(tempRoot, 'sysprompt'),
                reasoning: path.join(tempRoot, 'reasoning'),
                quickReplies: path.join(tempRoot, 'QuickReplies'),
                movingUI: path.join(tempRoot, 'movingUI'),
                assets: path.join(tempRoot, 'assets'),
                workflows: path.join(tempRoot, 'workflows'),
                userSprites: path.join(tempRoot, 'characters'),
                thumbnailsAvatar: path.join(tempRoot, 'thumbnails', 'avatar'),
                thumbnailsAvatarMobile: path.join(tempRoot, 'thumbnails', 'avatar-mobile'),
                thumbnailsBg: path.join(tempRoot, 'thumbnails', 'bg'),
                thumbnailsBgMobile: path.join(tempRoot, 'thumbnails', 'bg-mobile'),
                thumbnailsPersona: path.join(tempRoot, 'thumbnails', 'persona'),
                thumbnailsPersonaMobile: path.join(tempRoot, 'thumbnails', 'persona-mobile'),
            };
            for (const dir of Object.values(directories)) {
                mkdirSync(dir, { recursive: true });
            }
            const seededFiles = [];
            for (const image of Object.keys(SAVED_CHAT_IMAGES)) {
                const base = path.basename(image);
                for (const dir of [directories.root, directories.avatars, directories.characters, directories.backgrounds]) {
                    const target = path.join(dir, base);
                    writeFileSync(target, 'keep');
                    seededFiles.push(target);
                }
            }

            await checkForNewContent([directories], []);

            expect(consoleErrorSpy).not.toHaveBeenCalled();
            for (const target of seededFiles) {
                expect(existsSync(target)).toBe(true);
            }
        } finally {
            consoleErrorSpy.mockRestore();
            consoleLogSpy.mockRestore();
            consoleInfoSpy.mockRestore();
            globalThis.DATA_ROOT = previousDataRoot;
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});
