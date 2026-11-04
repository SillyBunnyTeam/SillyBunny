import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import multer from 'multer';

import '../../src/fetch-patch.js';
import { createUploadStorage } from '../../src/middleware/uploadStorage.js';
import multerMonkeyPatch from '../../src/middleware/multerMonkeyPatch.js';
import { setConfigFilePath } from '../../src/util.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const diskCacheEnvironmentKey = 'SILLYTAVERN_PERFORMANCE_USEDISKCACHE';

async function readAnswer(response) {
    const text = await response.text();
    return {
        status: response.status,
        body: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text,
    };
}

/**
 * Serves the characters and sprites routers on a local port for one user whose folders are in a temp folder.
 * The characters router reads its config when it loads and finds the default avatar from the working folder,
 * so this sets both before it loads the routers, and close() restores them.
 * @param {string} prefix Start of each temp folder name
 */
export async function startCharacterRouter(prefix) {
    const originalWorkingDirectory = process.cwd();
    const originalDiskCacheSetting = process.env[diskCacheEnvironmentKey];
    process.env[diskCacheEnvironmentKey] = 'false';
    process.chdir(repoRoot);
    setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));
    const { router } = await import('../../src/endpoints/characters.js');
    const { router: spritesRouter } = await import('../../src/endpoints/sprites.js');

    let tempRoot;
    let directories;
    let uploadMiddleware;

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((request, _response, next) => {
        request.user = { profile: { handle: 'character-router-test-user' }, directories };
        next();
    });
    app.use((request, response, next) => uploadMiddleware(request, response, next));
    app.use(multerMonkeyPatch);
    app.use('/api/characters', router);
    app.use('/api/sprites', spritesRouter);
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    return {
        get root() {
            return tempRoot;
        },
        get directories() {
            return directories;
        },

        reset() {
            tempRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), prefix));
            directories = {
                root: tempRoot,
                backups: path.join(tempRoot, 'backups'),
                characters: path.join(tempRoot, 'characters'),
                chats: path.join(tempRoot, 'chats'),
                groupChats: path.join(tempRoot, 'group chats'),
                groups: path.join(tempRoot, 'groups'),
                thumbnailsAvatar: path.join(tempRoot, 'thumbnails', 'avatar'),
                thumbnailsAvatarMobile: path.join(tempRoot, 'thumbnails', 'avatar', 'mobile'),
                userImages: path.join(tempRoot, 'user', 'images'),
                worlds: path.join(tempRoot, 'worlds'),
            };
            for (const directory of Object.values(directories)) {
                fs.mkdirSync(directory, { recursive: true });
            }
            uploadMiddleware = multer({ storage: createUploadStorage(path.join(tempRoot, '_uploads')) }).single('avatar');
        },

        remove() {
            fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5 });
        },

        async close() {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            if (originalDiskCacheSetting === undefined) {
                delete process.env[diskCacheEnvironmentKey];
            } else {
                process.env[diskCacheEnvironmentKey] = originalDiskCacheSetting;
            }
            process.chdir(originalWorkingDirectory);
        },

        /**
         * Lists every file and folder under the temp folder, with `/` separators and a trailing `/` on folders.
         * @returns {string[]} Sorted entries
         */
        entries() {
            return fs.readdirSync(tempRoot, { recursive: true })
                .map(entry => entry.split(path.sep).join('/') + (fs.statSync(path.join(tempRoot, entry)).isDirectory() ? '/' : ''))
                .sort();
        },

        async upload(resource, bytes, fileName, fields = {}) {
            const form = new FormData();
            form.append('avatar', new Blob([bytes]), fileName);
            for (const [key, value] of Object.entries(fields)) {
                form.append(key, value);
            }
            return readAnswer(await fetch(`${baseUrl}${resource}`, { method: 'POST', body: form }));
        },

        importCard(bytes, fileType, fields = {}) {
            return this.upload('/api/characters/import', bytes, `upload.${fileType}`, { file_type: fileType, user_name: 'Tester', ...fields });
        },

        async postJson(resource, body) {
            return readAnswer(await fetch(`${baseUrl}${resource}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }));
        },
    };
}
