import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
    convertImageUrlsToBase64,
    createConversationPinnedLookup,
    fetchImageToBase64,
    isGlobalIPAddress,
    resolveConversationImageRedirect,
    validateConversationPayload,
} from '../src/endpoints/conversation-utils.js';

describe('Conversation REST image safety', () => {
    const tempDirs = [];

    afterEach(() => {
        jest.restoreAllMocks();
        for (const directory of tempDirs.splice(0)) {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('accepts bounded image data URLs and rejects other data types', async () => {
        const image = 'data:image/png;base64,aGVsbG8=';
        await expect(fetchImageToBase64(image)).resolves.toBe(image);
        await expect(fetchImageToBase64('data:text/plain;base64,aGVsbG8=')).resolves.toBe('');
        await expect(fetchImageToBase64(image, { maxBytes: 4 })).resolves.toBe('');
    });

    test('rejects unsupported schemes and private or reserved addresses', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        await expect(fetchImageToBase64('file:///etc/passwd')).resolves.toBe('');
        await expect(fetchImageToBase64('http://127.0.0.1/image.png')).resolves.toBe('');
        await expect(fetchImageToBase64('http://[::1]/image.png')).resolves.toBe('');
        expect(isGlobalIPAddress('8.8.8.8')).toBe(true);
        expect(isGlobalIPAddress('2001:4860:4860::8888')).toBe(true);
        expect(isGlobalIPAddress('192.0.2.1')).toBe(false);
        expect(isGlobalIPAddress('192.31.196.1')).toBe(false);
        expect(isGlobalIPAddress('2001:db8::1')).toBe(false);
        expect(isGlobalIPAddress('64:ff9b:1::1')).toBe(false);
        expect(isGlobalIPAddress('3fff::1')).toBe(false);
        expect(isGlobalIPAddress('fec0::1')).toBe(false);
        expect(isGlobalIPAddress('::8.8.8.8')).toBe(false);
        expect(isGlobalIPAddress('::192.168.1.1')).toBe(false);
        expect(isGlobalIPAddress('fe00::1')).toBe(false);
        expect(isGlobalIPAddress('1000::1')).toBe(false);
        expect(isGlobalIPAddress('4000::1')).toBe(false);
        expect(isGlobalIPAddress('2606:4700:4700::1111')).toBe(true);
    });

    test('reads only contained authenticated user image paths', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-user-image-'));
        tempDirs.push(root);
        const userImages = path.join(root, 'user', 'images');
        const album = path.join(userImages, 'album');
        fs.mkdirSync(album, { recursive: true });
        fs.writeFileSync(path.join(album, 'photo.png'), Buffer.from('image'));
        fs.writeFileSync(path.join(album, 'not-image.txt'), Buffer.from('image'));
        const outsideImage = path.join(root, 'secret.png');
        fs.writeFileSync(outsideImage, Buffer.from('secret'));
        fs.symlinkSync(outsideImage, path.join(album, 'linked.png'));

        const userDirectories = { root, userImages };
        await expect(fetchImageToBase64('/user/images/album/photo.png?cache=1', { userDirectories }))
            .resolves.toBe(`data:image/png;base64,${Buffer.from('image').toString('base64')}`);
        await expect(fetchImageToBase64('user/images/album/photo.png', { userDirectories }))
            .resolves.toContain('data:image/png;base64,');
        await expect(fetchImageToBase64('/user/images/%2e%2e/secret.png', { userDirectories })).resolves.toBe('');
        await expect(fetchImageToBase64('/user/images/album/linked.png', { userDirectories })).resolves.toBe('');
        await expect(fetchImageToBase64('/user/images/album/not-image.txt', { userDirectories })).resolves.toBe('');
        await expect(fetchImageToBase64('/user/images/album/photo.png', { userDirectories, maxBytes: 4 })).resolves.toBe('');
    });

    test('caps image count and aggregate decoded bytes in one conversion pool', async () => {
        const oneByteImage = 'data:image/png;base64,YQ==';
        const urls = Array.from({ length: 40 }, () => oneByteImage);
        const countLimited = await convertImageUrlsToBase64(urls, 3);
        expect(countLimited.filter(Boolean)).toHaveLength(32);

        const aggregateLimited = await convertImageUrlsToBase64([oneByteImage, oneByteImage], 3, { maxAggregateBytes: 1 });
        expect(aggregateLimited).toEqual([oneByteImage, '']);
    });

    test('rejects malformed redirect locations without throwing', () => {
        expect(resolveConversationImageRedirect('http://[invalid', 'https://example.com/image.png')).toBe('');
        expect(resolveConversationImageRedirect('/next.png', 'https://example.com/image.png')).toBe('https://example.com/next.png');
    });

    test('pinned lookup supports local requests, all results, and legacy tuples', async () => {
        const server = http.createServer((_request, response) => response.end('pinned'));
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const lookup = createConversationPinnedLookup('127.0.0.1', 4);
            const body = await new Promise((resolve, reject) => {
                const request = http.get({
                    hostname: 'pinned.invalid',
                    port: server.address().port,
                    lookup,
                }, response => {
                    const chunks = [];
                    response.on('data', chunk => chunks.push(chunk));
                    response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                });
                request.on('error', reject);
            });
            expect(body).toBe('pinned');

            const allResults = await new Promise((resolve, reject) => lookup('ignored', { all: true }, (error, addresses) => (
                error ? reject(error) : resolve(addresses)
            )));
            expect(allResults).toEqual([{ address: '127.0.0.1', family: 4 }]);

            const legacyResult = await new Promise((resolve, reject) => lookup('ignored', { family: 4 }, (error, address, family) => (
                error ? reject(error) : resolve({ address, family })
            )));
            expect(legacyResult).toEqual({ address: '127.0.0.1', family: 4 });

            const callbackOnlyResult = await new Promise((resolve, reject) => lookup('ignored', (error, address, family) => (
                error ? reject(error) : resolve({ address, family })
            )));
            expect(callbackOnlyResult).toEqual({ address: '127.0.0.1', family: 4 });

            const invalidLookup = createConversationPinnedLookup('not-an-ip');
            const invalidError = await new Promise(resolve => invalidLookup('ignored', {}, error => resolve(error)));
            expect(invalidError).toBeInstanceOf(Error);
        } finally {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    test('counts object key bytes while allowing tool schema property names', () => {
        const schemaProperties = JSON.parse('{"__proto__":{"type":"string"},"prototype":{"type":"string"}}');
        schemaProperties.constructor = { type: 'string' };
        schemaProperties.toString = { type: 'string' };
        expect(validateConversationPayload({
            properties: {
                ...schemaProperties,
            },
        })).toEqual({ valid: true });

        const largeKeyObject = Object.fromEntries(Array.from(
            { length: 510 },
            (_, index) => [`${index}-${'x'.repeat(50_000)}`, ''],
        ));
        expect(validateConversationPayload(largeKeyObject)).toEqual({ valid: false, error: 'payload_too_large' });
    });
});
