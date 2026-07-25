import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalWorkingDirectory = process.cwd();
process.chdir(repoRoot);
setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));

const { generateThumbnail, publicRouter } = await import('../src/endpoints/thumbnails.js');

// A real 8x8 PNG. The cached-thumbnail branch of generateThumbnail measures the file with
// image-size, so those cases need parseable bytes rather than an arbitrary marker.
const PNG_FIXTURE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=', 'base64');
const THUMBNAIL_MARKER = 'cached-thumbnail-bytes';
const SECRET_MARKER = 'secret-outside-the-folder';

describe('thumbnail file name resolution', () => {
    let baseUrl;
    let directories;
    let server;
    let tempRoot;

    beforeAll(async () => {
        const app = express();
        app.use((request, _response, next) => {
            request.user = {
                profile: { handle: 'thumbnails-test-user' },
                directories,
            };
            next();
        });
        app.use('/thumbnail', publicRouter);

        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-thumbnails-'));
        directories = {
            root: tempRoot,
            avatars: path.join(tempRoot, 'User Avatars'),
            backgrounds: path.join(tempRoot, 'backgrounds'),
            characters: path.join(tempRoot, 'characters'),
            thumbnailsAvatar: path.join(tempRoot, 'thumbnails', 'avatar'),
            thumbnailsBg: path.join(tempRoot, 'thumbnails', 'bg'),
            thumbnailsPersona: path.join(tempRoot, 'thumbnails', 'persona'),
        };
        for (const directory of Object.values(directories)) {
            fs.mkdirSync(directory, { recursive: true });
        }
        // Lives one level above the characters folder, so a successful traversal would expose it.
        fs.writeFileSync(path.join(tempRoot, 'secret.png'), SECRET_MARKER);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    afterAll(async () => {
        if (server) {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
        process.chdir(originalWorkingDirectory);
    });

    function writeCharacter(name) {
        fs.writeFileSync(path.join(directories.characters, name), PNG_FIXTURE);
    }

    /**
     * Writes a cached thumbnail whose timestamps are newer than the original, so the freshness
     * check in generateThumbnail treats it as up to date instead of regenerating it.
     * @param {string} name File name
     * @param {Buffer|string} contents File contents
     */
    function writeCachedThumbnail(name, contents = THUMBNAIL_MARKER) {
        const target = path.join(directories.thumbnailsAvatar, name);
        fs.writeFileSync(target, contents);
        const past = new Date(Date.now() - 60_000);
        fs.utimesSync(path.join(directories.characters, name), past, past);
    }

    async function requestThumbnail(query) {
        return await fetch(`${baseUrl}/thumbnail?${query}`);
    }

    test('serves the real thumbnail when the file name arrives percent-encoded twice', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        writeCharacter('Mara Rodriguez.png');
        writeCachedThumbnail('Mara Rodriguez.png');

        // Express decodes the query once, so the handler sees the literal "Mara%20Rodriguez.png".
        const response = await requestThumbnail('type=avatar&file=Mara%2520Rodriguez.png');

        expect(response.status).toBe(200);
        expect(await response.text()).toBe(THUMBNAIL_MARKER);
        expect(errorSpy).not.toHaveBeenCalled();
    });

    test('still serves correctly encoded names containing a space', async () => {
        writeCharacter('Mara Rodriguez.png');
        writeCachedThumbnail('Mara Rodriguez.png');

        const response = await requestThumbnail('type=avatar&file=Mara%20Rodriguez.png');

        expect(response.status).toBe(200);
        expect(await response.text()).toBe(THUMBNAIL_MARKER);
    });

    test('still serves plain names', async () => {
        writeCharacter('Alice.png');
        writeCachedThumbnail('Alice.png');

        const response = await requestThumbnail('type=avatar&file=Alice.png');

        expect(response.status).toBe(200);
        expect(await response.text()).toBe(THUMBNAIL_MARKER);
    });

    test('rejects a traversal hidden behind double percent-encoding', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});

        // Express decodes these to "%2E%2E%2Fsecret.png" and "..%2Fsecret.png", which survive
        // sanitize() untouched and therefore reach the decode fallback.
        for (const query of ['type=avatar&file=%252E%252E%252Fsecret.png', 'type=avatar&file=..%252Fsecret.png', 'type=avatar&file=%2500.png']) {
            const response = await requestThumbnail(query);
            expect(response.status).toBe(404);
            expect(await response.text()).not.toContain(SECRET_MARKER);
        }
    });

    test('keeps rejecting a traversal that survives the query decode', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const response = await requestThumbnail('type=avatar&file=../secret.png');

        expect(response.status).toBe(403);
    });

    test('does not fail when the name contains a malformed escape sequence', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const response = await requestThumbnail('type=avatar&file=missing%25.png');

        expect(response.status).toBe(404);
    });

    test('serves a name whose literal percent sign is not an escape sequence', async () => {
        writeCharacter('50% Off.png');
        writeCachedThumbnail('50% Off.png');

        const response = await requestThumbnail('type=avatar&file=50%25%20Off.png');

        expect(response.status).toBe(200);
        expect(await response.text()).toBe(THUMBNAIL_MARKER);
    });

    test('generateThumbnail resolves an over-encoded name to the file on disk', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        writeCharacter('Mara Rodriguez.png');
        writeCachedThumbnail('Mara Rodriguez.png', PNG_FIXTURE);

        const result = await generateThumbnail(directories, 'avatar', 'Mara%20Rodriguez.png');

        expect(result.path).toBe(path.join(directories.thumbnailsAvatar, 'Mara Rodriguez.png'));
        expect(errorSpy).not.toHaveBeenCalled();
    });

    test('generateThumbnail prefers a literal percent name over its decoded form', async () => {
        writeCharacter('100%25.png');
        writeCharacter('100%.png');
        writeCachedThumbnail('100%25.png', PNG_FIXTURE);
        writeCachedThumbnail('100%.png', PNG_FIXTURE);

        const result = await generateThumbnail(directories, 'avatar', '100%25.png');

        expect(result.path).toBe(path.join(directories.thumbnailsAvatar, '100%25.png'));
    });

    test('generateThumbnail leaves a bare percent name untouched', async () => {
        writeCharacter('50%.png');
        writeCachedThumbnail('50%.png', PNG_FIXTURE);

        const result = await generateThumbnail(directories, 'avatar', '50%.png');

        expect(result.path).toBe(path.join(directories.thumbnailsAvatar, '50%.png'));
    });

    test('generateThumbnail refuses to resolve outside the originals folder', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const result = await generateThumbnail(directories, 'avatar', '%2E%2E%2Fsecret.png');

        expect(result.path).toBeNull();
        expect(fs.readdirSync(directories.thumbnailsAvatar)).toEqual([]);
    });
});
