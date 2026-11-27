import { describe, expect, test } from '@jest/globals';
import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { Zip, unzipSync } from 'fflate';

import {
    BACKUP_DEFLATE_LEVEL,
    NativeDeflateZipEntry,
    crc32,
    crc32Fallback,
} from '../src/zip-native-deflate.js';

function randomBytes(length, seed) {
    let state = seed;
    const bytes = Buffer.alloc(length);
    for (let i = 0; i < length; i++) {
        state = (state * 1664525 + 1013904223) >>> 0;
        bytes[i] = state >>> 24;
    }
    return bytes;
}

describe('running CRC-32', () => {
    test('matches the standard check value, and chunked input gives the CRC of the whole', () => {
        expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
        expect(crc32Fallback(Buffer.from('123456789'))).toBe(0xcbf43926);
        expect(crc32Fallback(Buffer.alloc(0))).toBe(0);

        const data = randomBytes(300_000, 5);
        let chunked = 0;
        let chunkedFallback = 0;
        for (let offset = 0; offset < data.length; offset += 65_536) {
            const chunk = data.subarray(offset, offset + 65_536);
            chunked = crc32(chunk, chunked);
            chunkedFallback = crc32Fallback(chunk, chunkedFallback);
        }

        expect(chunked).toBe(zlib.crc32(data));
        expect(chunkedFallback).toBe(zlib.crc32(data));
    });
});

describe('NativeDeflateZipEntry in an fflate Zip', () => {
    async function zipWith(entries) {
        const chunks = [];
        const zip = new Zip((error, chunk) => {
            if (error) {
                throw error;
            }
            chunks.push(Buffer.from(chunk));
        });

        for (const { entry, source } of entries) {
            zip.add(entry);
            for await (const compressed of entry.start(source)) {
                entry.ondata(null, compressed, false);
            }
            entry.finish();
        }
        zip.end();
        return Buffer.concat(chunks);
    }

    test('deflates at the backup level, with the CRC and size of the uncompressed data', async () => {
        const content = Buffer.concat([randomBytes(50_000, 1), Buffer.from('text '.repeat(40_000))]);
        const entry = new NativeDeflateZipEntry('dir/data.bin', { mtime: new Date(2024, 4, 5, 6, 7, 8) });
        const source = Readable.from([content.subarray(0, 70_000), content.subarray(70_000)]);

        const zipBuffer = await zipWith([{ entry, source }]);

        expect(BACKUP_DEFLATE_LEVEL).toBe(1);
        expect(entry.size).toBe(content.byteLength);
        expect(entry.crc).toBe(zlib.crc32(content));
        expect(Buffer.from(unzipSync(new Uint8Array(zipBuffer))['dir/data.bin']).equals(content)).toBe(true);
    });

    test('an empty source gives a valid empty entry', async () => {
        const entry = new NativeDeflateZipEntry('empty.txt');
        const zipBuffer = await zipWith([{ entry, source: Readable.from([]) }]);

        expect(entry.size).toBe(0);
        expect(entry.crc).toBe(0);
        expect(Buffer.from(unzipSync(new Uint8Array(zipBuffer))['empty.txt']).byteLength).toBe(0);
    });

    test('a source that fails ends the compressed stream with that error, and destroy() stops the chain', async () => {
        const failing = new NativeDeflateZipEntry('broken.txt');
        const source = new Readable({
            read() {
                this.push(Buffer.from('some data'));
                setImmediate(() => this.destroy(new Error('disk read failed')));
            },
        });
        const zip = new Zip(() => {});
        zip.add(failing);
        await expect((async () => {
            for await (const chunk of failing.start(source)) {
                failing.ondata(null, chunk, false);
            }
        })()).rejects.toThrow('disk read failed');

        const stopped = new NativeDeflateZipEntry('stopped.txt');
        const endless = new Readable({ read() { this.push(Buffer.alloc(1024, 0x61)); } });
        const output = stopped.start(endless);
        stopped.destroy();
        expect(output.destroyed).toBe(true);
        expect(endless.destroyed).toBe(true);
    });
});
