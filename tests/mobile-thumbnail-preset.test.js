import { beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';
import zlib from 'node:zlib';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const { Jimp } = await import('../src/jimp.js');
const {
    getThumbnailDimensions,
    getThumbnailMobileDimensions,
    getThumbnailMobileResolution,
    getThumbnailResolution,
} = await import('../src/endpoints/image-metadata.js');
const {
    generateThumbnail,
    getThumbnailFolder,
    invalidateThumbnail,
} = await import('../src/endpoints/thumbnails.js');

describe('mobile thumbnail preset', () => {
    test('desktop and mobile dimensions are independent', () => {
        const desktop = getThumbnailDimensions();
        const mobile = getThumbnailMobileDimensions();

        expect(desktop.avatar).toEqual([864, 1280]);
        expect(desktop.persona).toEqual([864, 1280]);
        expect(mobile.avatar).toEqual([320, 480]);
        expect(mobile.persona).toEqual([320, 480]);

        expect(getThumbnailResolution('avatar')).toBe(864 * 1280);
        expect(getThumbnailMobileResolution('avatar')).toBe(320 * 480);
    });

    describe('folder routing', () => {
        const directories = Object.freeze({
            thumbnailsAvatar: 'thumbnails/avatar',
            thumbnailsPersona: 'thumbnails/persona',
            thumbnailsAvatarMobile: 'thumbnails/avatar/mobile',
            thumbnailsPersonaMobile: 'thumbnails/persona/mobile',
            thumbnailsBg: 'thumbnails/bg',
        });

        test('routes desktop avatars to the desktop folder', () => {
            expect(getThumbnailFolder(directories, 'avatar', 'desktop')).toBe('thumbnails/avatar');
            expect(getThumbnailFolder(directories, 'persona', 'desktop')).toBe('thumbnails/persona');
        });

        test('routes mobile avatars to the mobile subfolder', () => {
            expect(getThumbnailFolder(directories, 'avatar', 'mobile')).toBe('thumbnails/avatar/mobile');
            expect(getThumbnailFolder(directories, 'persona', 'mobile')).toBe('thumbnails/persona/mobile');
        });

        test('backgrounds share a single folder across presets', () => {
            expect(getThumbnailFolder(directories, 'bg', 'desktop')).toBe('thumbnails/bg');
            expect(getThumbnailFolder(directories, 'bg', 'mobile')).toBe('thumbnails/bg');
        });
    });

    describe('cache invalidation', () => {
        let tempRoot;
        let directories;

        beforeEach(() => {
            tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-thumb-test-'));
            directories = {
                thumbnailsAvatar: path.join(tempRoot, 'thumbnails', 'avatar'),
                thumbnailsAvatarMobile: path.join(tempRoot, 'thumbnails', 'avatar', 'mobile'),
                thumbnailsPersona: path.join(tempRoot, 'thumbnails', 'persona'),
                thumbnailsPersonaMobile: path.join(tempRoot, 'thumbnails', 'persona', 'mobile'),
            };

            for (const folder of Object.values(directories)) {
                fs.mkdirSync(folder, { recursive: true });
            }
        });

        test('invalidateThumbnail removes both desktop and mobile cached copies', () => {
            const desktopPath = path.join(directories.thumbnailsAvatar, 'test.png');
            const mobilePath = path.join(directories.thumbnailsAvatarMobile, 'test.png');
            fs.writeFileSync(desktopPath, 'desktop');
            fs.writeFileSync(mobilePath, 'mobile');

            expect(fs.existsSync(desktopPath)).toBe(true);
            expect(fs.existsSync(mobilePath)).toBe(true);

            invalidateThumbnail(directories, 'avatar', 'test.png');

            expect(fs.existsSync(desktopPath)).toBe(false);
            expect(fs.existsSync(mobilePath)).toBe(false);
        });

        test('invalidateThumbnail only removes the requested type', () => {
            const avatarDesktopPath = path.join(directories.thumbnailsAvatar, 'test.png');
            const personaDesktopPath = path.join(directories.thumbnailsPersona, 'test.png');
            fs.writeFileSync(avatarDesktopPath, 'avatar');
            fs.writeFileSync(personaDesktopPath, 'persona');

            invalidateThumbnail(directories, 'avatar', 'test.png');

            expect(fs.existsSync(avatarDesktopPath)).toBe(false);
            expect(fs.existsSync(personaDesktopPath)).toBe(true);
        });
    });

    describe('thumbnail generation routing', () => {
        let tempRoot;
        let directories;

        beforeEach(() => {
            tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-thumb-gen-test-'));
            directories = {
                characters: path.join(tempRoot, 'characters'),
                thumbnailsAvatar: path.join(tempRoot, 'thumbnails', 'avatar'),
                thumbnailsAvatarMobile: path.join(tempRoot, 'thumbnails', 'avatar', 'mobile'),
            };

            for (const folder of Object.values(directories)) {
                fs.mkdirSync(folder, { recursive: true });
            }

            fs.writeFileSync(path.join(directories.characters, 'test.png'), createMinimalPng(100, 100));
            fs.writeFileSync(path.join(directories.thumbnailsAvatar, 'test.png'), createMinimalPng(10, 10));
            fs.writeFileSync(path.join(directories.thumbnailsAvatarMobile, 'test.png'), createMinimalPng(5, 5));
        });

        test('generateThumbnail resolves desktop and mobile paths independently', async () => {
            const desktop = await generateThumbnail(directories, 'avatar', 'test.png', false, false, 'desktop');
            const mobile = await generateThumbnail(directories, 'avatar', 'test.png', false, false, 'mobile');

            expect(desktop.path).toBe(path.join(directories.thumbnailsAvatar, 'test.png'));
            expect(mobile.path).toBe(path.join(directories.thumbnailsAvatarMobile, 'test.png'));
            expect(desktop.resolution).toBe(getThumbnailResolution('avatar'));
            expect(mobile.resolution).toBe(getThumbnailMobileResolution('avatar'));
        });
    });
});

function createMinimalPng(width, height) {
    const chunks = [];
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // color type RGB
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter method
    ihdr[12] = 0; // interlace
    chunks.push(pngChunk('IHDR', ihdr));

    const rowSize = 1 + width * 3;
    const imageData = Buffer.alloc(rowSize * height);
    for (let y = 0; y < height; y++) {
        imageData[y * rowSize] = 0; // filter byte
        for (let x = 0; x < width; x++) {
            const offset = y * rowSize + 1 + x * 3;
            imageData[offset] = 0xff; // R
            imageData[offset + 1] = 0x00; // G
            imageData[offset + 2] = 0x00; // B
        }
    }

    const compressed = zlib.deflateSync(imageData);
    chunks.push(pngChunk('IDAT', compressed));
    chunks.push(pngChunk('IEND', Buffer.alloc(0)));

    return Buffer.concat([signature, ...chunks]);
}

function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuffer = Buffer.from(type, 'ascii');
    const crc = zlib.crc32(Buffer.concat([typeBuffer, data]));
    const crcBuffer = Buffer.alloc(4);
    crcBuffer.writeUInt32BE(crc >>> 0, 0);
    return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}
