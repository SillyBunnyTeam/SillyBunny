/* global globalThis */
import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isBunRuntime } from '../src/runtime.js';
import { SqliteCache, getCacheDirectory, getFileKey, getFileStamp, hasNulCharacter } from '../src/sqlite-cache.js';

const originalDataRoot = globalThis.DATA_ROOT;
const describeOnBun = isBunRuntime() ? describe : describe.skip;
// Bun loads bun:sqlite, so the node:sqlite load that fails on Node.js older than 22.13 never runs there.
const describeOnNode = isBunRuntime() ? describe.skip : describe;

// The shape of a real index: one table, a file as the key, the file's size and modification time as the stamp.
const SCHEMA = `CREATE TABLE notes (
    directory TEXT NOT NULL,
    file_name TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime REAL NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (directory, file_name)
);
CREATE INDEX notes_size ON notes (size)`;

const STATEMENTS = {
    get: 'SELECT body FROM notes WHERE directory = ? AND file_name = ? AND size = ? AND mtime = ?',
    set: 'INSERT OR REPLACE INTO notes (directory, file_name, size, mtime, body) VALUES (?, ?, ?, ?, ?)',
    count: 'SELECT COUNT(*) AS count FROM notes',
    journalMode: 'PRAGMA journal_mode',
    autoVacuum: 'PRAGMA auto_vacuum',
};

const MESSAGES = {
    nodeTooOld: 'The notes cache needs Node.js 22.13 or newer.',
    failed: 'Notes cache error:',
    closeFailed: 'Could not close the notes cache:',
};

const FIRST_FILE = path.join(path.sep, 'notes', 'first.txt');
const STAT = { size: 5, mtimeMs: 1700000000123.5 };

afterAll(() => {
    globalThis.DATA_ROOT = originalDataRoot;
});

describe('sqlite cache', () => {
    let cache;
    let tempRoot;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-sqlite-cache-'));
        globalThis.DATA_ROOT = tempRoot;
        cache = createCache();
    });

    afterEach(() => {
        cache.close();
        jest.restoreAllMocks();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('stores a value and reads it back', () => {
        write(cache, FIRST_FILE, STAT, 'first body');

        expect(read(cache, FIRST_FILE, STAT)).toBe('first body');
        expect(read(cache, path.join(path.sep, 'notes', 'second.txt'), STAT)).toBeUndefined();
    });

    test('keeps its values when it is opened again', () => {
        write(cache, FIRST_FILE, STAT, 'first body');
        cache.close();

        const reopened = createCache();
        try {
            expect(read(reopened, FIRST_FILE, STAT)).toBe('first body');
        } finally {
            reopened.close();
        }
    });

    test('opens the database file again for the next call after close', () => {
        write(cache, FIRST_FILE, STAT, 'first body');

        cache.close();
        cache.close();

        expect(read(cache, FIRST_FILE, STAT)).toBe('first body');
    });

    test('returns a value only while the file has the stored size and modification time', () => {
        write(cache, FIRST_FILE, STAT, 'first body');

        expect(read(cache, FIRST_FILE, { ...STAT, size: STAT.size + 1 })).toBeUndefined();
        expect(read(cache, FIRST_FILE, { ...STAT, mtimeMs: STAT.mtimeMs + 0.5 })).toBeUndefined();
        expect(read(cache, FIRST_FILE, STAT)).toBe('first body');
    });

    test('puts its file under the _cache folder of the data root that is set when it opens', () => {
        expect(cache.filePath).toBe(path.join(tempRoot, '_cache', 'notes.sqlite'));
        expect(getCacheDirectory()).toBe(path.join(tempRoot, '_cache'));
        expect(fs.existsSync(cache.filePath)).toBe(false);

        const laterRoot = path.join(tempRoot, 'later-root');
        globalThis.DATA_ROOT = laterRoot;
        write(cache, FIRST_FILE, STAT, 'first body');

        expect(fs.existsSync(path.join(laterRoot, '_cache', 'notes.sqlite'))).toBe(true);
    });

    test('writes through a WAL journal and reclaims space with incremental auto-vacuum', () => {
        const journalMode = cache.use(statements => statements.journalMode.get()?.journal_mode);
        const autoVacuum = cache.use(statements => statements.autoVacuum.get()?.auto_vacuum);

        expect(journalMode).toBe('wal');
        // 2 is SQLITE_AUTO_VACUUM_INCREMENTAL.
        expect(autoVacuum).toBe(2);
    });

    test('runs the SQL that the callback sends through run', () => {
        write(cache, FIRST_FILE, STAT, 'first body');

        cache.use((_statements, run) => run('DELETE FROM notes; PRAGMA incremental_vacuum'));

        expect(count(cache)).toBe(0);
    });

    test('returns the fallback without calling the callback or creating a file while it is disabled', () => {
        const disabled = createCache({ enabled: false });
        const callback = jest.fn(() => 'called');

        expect(disabled.use(callback, 'fallback')).toBe('fallback');
        expect(callback).not.toHaveBeenCalled();
        expect(fs.existsSync(disabled.filePath)).toBe(false);
    });

    describe('when the file cannot be used', () => {
        test('replaces a file that is not a database', () => {
            writeText(cache.filePath, 'not a database');

            write(cache, FIRST_FILE, STAT, 'first body');
            cache.close();

            const reopened = createCache();
            try {
                expect(read(reopened, FIRST_FILE, STAT)).toBe('first body');
            } finally {
                reopened.close();
            }
        });

        test('replaces a file with another schema version and starts empty', () => {
            write(cache, FIRST_FILE, STAT, 'first body');
            cache.close();

            const newer = createCache({ schemaVersion: 2 });
            try {
                expect(count(newer)).toBe(0);
                write(newer, FIRST_FILE, STAT, 'newer body');
            } finally {
                newer.close();
            }

            const reopened = createCache({ schemaVersion: 2 });
            try {
                expect(read(reopened, FIRST_FILE, STAT)).toBe('newer body');
                expect(count(reopened)).toBe(1);
            } finally {
                reopened.close();
            }
        });

        test('turns off with one warning when the database cannot be opened', () => {
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
            globalThis.DATA_ROOT = writeText(path.join(tempRoot, 'not-a-directory'), '');

            const result = cache.use(statements => statements.set.run('first', 'first.txt', 5, 1, 'first body'), 'fallback');

            expect(result).toBe('fallback');
            expect(cache.use(() => 'called', 'fallback')).toBe('fallback');
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledWith(MESSAGES.failed, expect.objectContaining({ stack: expect.any(String) }));
        });

        test('turns off with one warning after a failing statement and does not open the file again', () => {
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
            write(cache, FIRST_FILE, STAT, 'first body');

            const result = cache.use((_statements, run) => run('INSERT INTO table_that_is_missing VALUES (1)'), 'fallback');

            expect(result).toBe('fallback');
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledWith(MESSAGES.failed, expect.objectContaining({ stack: expect.any(String) }));

            const callback = jest.fn(() => 'called');
            expect(cache.use(callback, 'fallback')).toBe('fallback');
            expect(callback).not.toHaveBeenCalled();
            expect(warn).toHaveBeenCalledTimes(1);
        });

        test('keeps the database file after an error that is not corruption', () => {
            jest.spyOn(console, 'warn').mockImplementation(() => {});
            write(cache, FIRST_FILE, STAT, 'first body');

            cache.use(() => {
                throw new Error('Something else broke');
            });

            expect(fs.existsSync(cache.filePath)).toBe(true);
        });

        test.each([
            ['node:sqlite', { code: 'ERR_SQLITE_ERROR', errcode: 11 }],
            ['node:sqlite with an extended result code', { code: 'ERR_SQLITE_ERROR', errcode: 11 | (3 << 8) }],
            ['node:sqlite for a file that is not a database', { code: 'ERR_SQLITE_ERROR', errcode: 26 }],
            ['bun:sqlite', { name: 'SQLiteError', errno: 11 }],
            ['bun:sqlite for a file that is not a database', { name: 'SQLiteError', errno: 26 }],
        ])('deletes the database files and turns off after a corruption error from %s', (_driver, shape) => {
            jest.spyOn(console, 'warn').mockImplementation(() => {});
            write(cache, FIRST_FILE, STAT, 'first body');

            cache.use(() => {
                throw Object.assign(new Error('database disk image is malformed'), shape);
            });

            expect(fs.existsSync(cache.filePath)).toBe(false);
            expect(fs.existsSync(`${cache.filePath}-wal`)).toBe(false);
            expect(fs.existsSync(`${cache.filePath}-shm`)).toBe(false);
            expect(cache.use(() => 'called', 'fallback')).toBe('fallback');
        });
    });

    describeOnBun('under Bun', () => {
        test('runs its SQL without the exec method that bun:sqlite deprecates', async () => {
            const { Database } = await import('bun:sqlite');
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
            jest.spyOn(Database.prototype, 'exec').mockImplementation(() => {
                throw new Error('exec is not available');
            });

            write(cache, FIRST_FILE, STAT, 'first body');

            expect(read(cache, FIRST_FILE, STAT)).toBe('first body');
            expect(warn).not.toHaveBeenCalled();
        });
    });

    describeOnNode('on Node.js', () => {
        test('names the Node.js minimum without a stack when node:sqlite cannot be loaded', () => {
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const loadSqlite = jest.fn(() => {
                throw Object.assign(new Error('No such built-in module: node:sqlite'), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' });
            });
            jest.mock('node:sqlite', loadSqlite);
            try {
                write(cache, FIRST_FILE, STAT, 'first body');

                expect(warn.mock.calls).toEqual([[MESSAGES.nodeTooOld]]);

                write(cache, FIRST_FILE, STAT, 'first body');

                expect(read(cache, FIRST_FILE, STAT)).toBeUndefined();
                expect(warn).toHaveBeenCalledTimes(1);
                expect(loadSqlite).toHaveBeenCalledTimes(1);
                expect(fs.existsSync(cache.filePath)).toBe(false);
            } finally {
                jest.unmock('node:sqlite');
            }
        });
    });
});

describe('sqlite cache options', () => {
    test.each([
        ['an empty file name', { fileName: '' }],
        ['a file name with a folder', { fileName: path.join('nested', 'notes.sqlite') }],
        ['a file name that leaves the cache folder', { fileName: '..' }],
        ['a schema version of 0', { schemaVersion: 0 }],
        ['a schema version that is not a whole number', { schemaVersion: 1.5 }],
        ['a schema version that is text', { schemaVersion: '1; DROP TABLE notes' }],
        ['no schema', { schema: '' }],
        ['no statements', { statements: undefined }],
        ['a statement that is not text', { statements: { get: 5 } }],
        ['a missing message', { messages: { ...MESSAGES, closeFailed: undefined } }],
    ])('refuses %s', (_name, override) => {
        expect(() => createCache(override)).toThrow(TypeError);
    });
});

describe('sqlite cache helpers', () => {
    test('hasNulCharacter finds a NUL character anywhere in the text', () => {
        expect(hasNulCharacter('with\0nul')).toBe(true);
        expect(hasNulCharacter('\0')).toBe(true);
        expect(hasNulCharacter('trailing\0')).toBe(true);
        expect(hasNulCharacter('')).toBe(false);
        expect(hasNulCharacter('plain text\n\t')).toBe(false);
        expect(hasNulCharacter('\\0 is not a NUL character')).toBe(false);
    });

    test('getFileKey gives the absolute folder and the file name', () => {
        expect(getFileKey(path.join('relative', 'folder', '..', 'chat.jsonl'))).toEqual([path.resolve('relative'), 'chat.jsonl']);
        expect(getFileKey(path.join(path.sep, 'data', 'chats', 'chat.jsonl'))).toEqual([path.join(path.sep, 'data', 'chats'), 'chat.jsonl']);
    });

    test('getFileStamp gives the size and the modification time in milliseconds', () => {
        expect(getFileStamp({ size: 12, mtimeMs: 1700000000123.5, ctimeMs: 1 })).toEqual([12, 1700000000123.5]);
    });
});

function createCache(override = {}) {
    return new SqliteCache({
        fileName: 'notes.sqlite',
        enabled: true,
        schemaVersion: 1,
        schema: SCHEMA,
        statements: STATEMENTS,
        messages: MESSAGES,
        ...override,
    });
}

function write(cache, filePath, fileStat, body) {
    cache.use(statements => statements.set.run(...getFileKey(filePath), ...getFileStamp(fileStat), body));
}

function read(cache, filePath, fileStat) {
    return cache.use(statements => statements.get.get(...getFileKey(filePath), ...getFileStamp(fileStat))?.body);
}

function count(cache) {
    return cache.use(statements => statements.count.get()?.count);
}

function writeText(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return filePath;
}
