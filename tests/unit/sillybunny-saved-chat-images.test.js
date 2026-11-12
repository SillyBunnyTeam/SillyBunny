/* eslint-disable playwright/no-standalone-expect -- Jest contracts for shipped files. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from '@jest/globals';

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

    test('are named in no removal list: not in the obsolete content items, and not in the keys and files the app retires', () => {
        const lists = ['src/endpoints/content-manager.js', 'public/scripts/sillybunny-retired-keys.js'].map(file => [file, read(file).toString('utf8')]);

        for (const [file, text] of lists) {
            for (const image of Object.keys(SAVED_CHAT_IMAGES)) {
                expect([file, text.includes(path.basename(image))]).toEqual([file, false]);
            }
        }
    });
});
