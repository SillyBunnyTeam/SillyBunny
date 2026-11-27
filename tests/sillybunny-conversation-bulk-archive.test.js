import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';

import {
    createArchive,
    fetchArchiveEntries,
    fileNameFromUrl,
    formatFailedFiles,
    isFetchableAttachmentUrl,
    planArchiveNames,
    sanitiseFileName,
} from '../public/scripts/sillybunny-conversation/details/bulk-archive.js';

// The library as the page ships it: a script that exports itself when it finds a `module`, which a module of this package does not have.
const shipped = { exports: {} };
new Function('module', 'exports', readFileSync(new URL('../public/lib/jszip.min.js', import.meta.url), 'utf8'))(shipped, shipped.exports);
const JSZip = shipped.exports;

async function readArchive(blob) {
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const entries = {};
    for (const [name, file] of Object.entries(zip.files)) {
        entries[name] = await file.async('string');
    }
    return entries;
}

describe('bulk actions: names inside an archive', () => {
    test('takes the characters out that a file name cannot hold on every system', () => {
        expect(sanitiseFileName('a/b\\c:d*e?f"g<h>i|j', 'File')).toBe('a_b_c_d_e_f_g_h_i_j');
        expect(sanitiseFileName('line\nbreak\u0000', 'File')).toBe('line break');
    });

    test('never gives a path, a hidden file, or a name that ends in a dot or a space', () => {
        expect(sanitiseFileName('../../etc/passwd', 'File')).toBe('_.._etc_passwd');
        expect(sanitiseFileName('  .hidden. ', 'File')).toBe('hidden');
        expect(sanitiseFileName('..', 'File')).toBe('File');
    });

    test('falls back when nothing is left, and sets aside the names that Windows reserves', () => {
        expect(sanitiseFileName('', 'Chat')).toBe('Chat');
        expect(sanitiseFileName('   ', 'Chat')).toBe('Chat');
        expect(sanitiseFileName('CON', 'Chat')).toBe('CON_');
        expect(sanitiseFileName('nul', 'Chat')).toBe('nul_');
    });

    test('cuts a long name and keeps room for the extension', () => {
        const name = sanitiseFileName('x'.repeat(400), 'File');
        expect(name.length).toBeLessThanOrEqual(120);
    });

    test('gives each file the name of its chat, with the extension', () => {
        expect(planArchiveNames([{ name: 'Weekend Plans', fallback: 'Chat' }, { name: 'Chat 2', fallback: 'Chat' }], '.jsonl')).toEqual(['Weekend Plans.jsonl', 'Chat 2.jsonl']);
    });

    test('numbers a name that is taken, before the extension, ignoring the case', () => {
        const names = planArchiveNames([
            { name: 'notes.txt', fallback: 'File' },
            { name: 'Notes.TXT', fallback: 'File' },
            { name: 'notes.txt', fallback: 'File' },
            { name: 'notes (2).txt', fallback: 'File' },
        ]);
        expect(names).toEqual(['notes.txt', 'Notes (2).TXT', 'notes (3).txt', 'notes (2) (2).txt']);
        expect(new Set(names.map(name => name.toLowerCase())).size).toBe(names.length);
    });

    test('numbers chats of the same name and keeps the extension last', () => {
        expect(planArchiveNames([{ name: 'Chat', fallback: 'Chat' }, { name: 'Chat', fallback: 'Chat' }], '.jsonl')).toEqual(['Chat.jsonl', 'Chat (2).jsonl']);
    });

    test('uses the fallback for an item with no name', () => {
        expect(planArchiveNames([{ name: '', fallback: 'Picture 1' }, { name: undefined, fallback: 'Picture 2' }])).toEqual(['Picture 1', 'Picture 2']);
    });

    test('reads a file name from the end of an address', () => {
        expect(fileNameFromUrl('/user/files/My%20Report.pdf?x=1#top')).toBe('My Report.pdf');
        expect(fileNameFromUrl('https://example.test/a/b/photo.png')).toBe('photo.png');
        expect(fileNameFromUrl('/user/files/')).toBe('');
        expect(fileNameFromUrl('data:image/png;base64,AAAA')).toBe('');
        expect(fileNameFromUrl('/bad/%E0%A4%A.png')).toBe('%E0%A4%A.png');
    });
});

describe('bulk actions: which addresses an archive fetches', () => {
    const base = 'http://localhost:5700/';

    test('fetches addresses of the page itself, relative ones included', () => {
        expect(isFetchableAttachmentUrl('/user/files/a.png', base)).toBe(true);
        expect(isFetchableAttachmentUrl('user/files/a.png', base)).toBe(true);
        expect(isFetchableAttachmentUrl('http://localhost:5700/user/files/a.png', base)).toBe(true);
        expect(isFetchableAttachmentUrl('blob:http://localhost:5700/550e8400', base)).toBe(true);
    });

    test('fetches a picture that carries its own data', () => {
        expect(isFetchableAttachmentUrl('data:image/png;base64,AAAA', base)).toBe(true);
        expect(isFetchableAttachmentUrl('data:text/html;base64,AAAA', base)).toBe(false);
    });

    test('leaves addresses of other sites, and every other scheme', () => {
        expect(isFetchableAttachmentUrl('https://example.test/a.png', base)).toBe(false);
        expect(isFetchableAttachmentUrl('http://localhost:5701/a.png', base)).toBe(false);
        expect(isFetchableAttachmentUrl('blob:https://example.test/550e8400', base)).toBe(false);
        expect(isFetchableAttachmentUrl('javascript:alert(1)', base)).toBe(false);
        expect(isFetchableAttachmentUrl('', base)).toBe(false);
        expect(isFetchableAttachmentUrl(undefined, base)).toBe(false);
    });
});

describe('bulk actions: fetching the files of an archive', () => {
    test('fetches every file and keeps the order of the list', async () => {
        const result = await fetchArchiveEntries(
            [{ name: 'a.png', url: '/a' }, { name: 'b.png', url: '/b' }, { name: 'c.png', url: '/c' }],
            async url => new TextEncoder().encode(`bytes of ${url}`),
        );
        expect(result.failed).toEqual([]);
        expect(result.entries.map(entry => entry.name)).toEqual(['a.png', 'b.png', 'c.png']);
        expect(new TextDecoder().decode(result.entries[1].data)).toBe('bytes of /b');
    });

    test('names a file that fails and still returns the others', async () => {
        const result = await fetchArchiveEntries(
            [{ name: 'a.png', url: '/a' }, { name: 'broken.png', url: '/broken' }, { name: 'c.png', url: '/c' }],
            async (url) => {
                if (url === '/broken') {
                    throw new Error('404');
                }
                return new Uint8Array([1, 2, 3]);
            },
        );
        expect(result.entries.map(entry => entry.name)).toEqual(['a.png', 'c.png']);
        expect(result.failed.map(item => item.name)).toEqual(['broken.png']);
    });

    test('counts a file that gives no bytes as failed', async () => {
        const result = await fetchArchiveEntries([{ name: 'a.png', url: '/a' }], async () => null);
        expect(result.failed.map(item => item.name)).toEqual(['a.png']);
    });

    test('runs a few requests at a time and no more', async () => {
        let running = 0;
        let peak = 0;
        const candidates = Array.from({ length: 12 }, (_, index) => ({ name: `f${index}`, url: `/f${index}` }));
        const result = await fetchArchiveEntries(candidates, async () => {
            running += 1;
            peak = Math.max(peak, running);
            await new Promise(resolve => setTimeout(resolve, 5));
            running -= 1;
            return new Uint8Array([0]);
        }, { concurrency: 3 });
        expect(result.entries).toHaveLength(12);
        expect(peak).toBeGreaterThan(1);
        expect(peak).toBeLessThanOrEqual(3);
    });

    test('says which files failed in a line for a toast', () => {
        expect(formatFailedFiles(['a.png'])).toBe('a.png');
        expect(formatFailedFiles(['a.png', 'b.png', 'c.png'])).toBe('a.png, b.png, c.png');
        expect(formatFailedFiles(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
    });
});

describe('bulk actions: assembling the archive', () => {
    test('writes every entry under its name, with its bytes', async () => {
        const blob = await createArchive(JSZip, [
            { name: 'Weekend Plans.jsonl', data: '{"a":1}\n{"b":2}\n' },
            { name: 'photo.png', data: new Uint8Array([104, 105]) },
        ]);
        expect(blob.type).toBe('application/zip');
        expect(await readArchive(blob)).toEqual({ 'Weekend Plans.jsonl': '{"a":1}\n{"b":2}\n', 'photo.png': 'hi' });
    });

    test('keeps unicode names', async () => {
        const blob = await createArchive(JSZip, [{ name: 'Café – 日本.jsonl', data: 'x' }]);
        expect(Object.keys(await readArchive(blob))).toEqual(['Café – 日本.jsonl']);
    });

    test('makes an archive with no entries, so that a download of nothing is the caller\'s to refuse', async () => {
        const blob = await createArchive(JSZip, []);
        expect(Object.keys(await readArchive(blob))).toEqual([]);
    });
});
