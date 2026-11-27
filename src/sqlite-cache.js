import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { isBunRuntime, isNativeTermuxEnvironment } from './runtime.js';

const require = createRequire(import.meta.url);

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;
export const DESKTOP_SQLITE_MMAP_SIZE = 64 * 1024 * 1024;
export const ANDROID_SQLITE_MMAP_SIZE = 16 * 1024 * 1024;
export const SQLITE_CACHE_SIZE_KIB = -8192;
export const SQLITE_INCREMENTAL_VACUUM_PAGES = 200;

/**
 * Builds the SQLite connection PRAGMA list tuned for Android/Termux vs desktop hosts.
 * @param {{ isAndroid?: boolean }} [options]
 * @returns {string}
 */
export function getSqliteCachePragmas({
    isAndroid = isNativeTermuxEnvironment()
        || process.platform === 'android'
        || Boolean(process.env.ANDROID_ROOT)
        || process.env.SILLYBUNNY_ANDROID_APP === '1',
} = {}) {
    const mmapSize = isAndroid ? ANDROID_SQLITE_MMAP_SIZE : DESKTOP_SQLITE_MMAP_SIZE;
    return [
        'PRAGMA busy_timeout = 1000',
        'PRAGMA auto_vacuum = INCREMENTAL',
        'PRAGMA journal_mode = WAL',
        'PRAGMA synchronous = NORMAL',
        'PRAGMA temp_store = MEMORY',
        `PRAGMA cache_size = ${SQLITE_CACHE_SIZE_KIB}`,
        `PRAGMA mmap_size = ${mmapSize}`,
    ].join('; ');
}

/**
 * @typedef {object} SqliteCacheOptions
 * @property {string} fileName Name of the database file inside the cache folder, for example `characters.sqlite`
 * @property {boolean} enabled False keeps the cache off: no file is created and every call returns its fallback
 * @property {number} schemaVersion Whole number from 1 up, stored in `PRAGMA user_version`. A file with another version
 * is deleted and built again, so raise it when the stored data for an unchanged source file changes.
 * @property {string} schema SQL that creates the tables and indexes in a new, empty file
 * @property {Record<string, string>} statements SQL of the prepared statements, by the name that `use()` hands them under
 * @property {SqliteCacheMessages} messages The warnings that the cache writes to the console
 */

/**
 * @typedef {object} SqliteCacheMessages
 * @property {string} nodeTooOld One line for Node.js older than 22.13, which has no node:sqlite. It says what the server does instead.
 * @property {string} failed First argument of the warning that comes with the error that turned the cache off
 * @property {string} closeFailed First argument of the warning that comes with an error from closing the database
 */

/**
 * @returns {string} The folder for derived data that the server can build again, under the data root and outside any user's folder
 */
export function getCacheDirectory() {
    return path.join(globalThis.DATA_ROOT, '_cache');
}

/**
 * A value with a NUL character must not be stored in a TEXT column.
 * Node.js 22 returns a stored TEXT value only up to its first NUL character, so the cache would return a cut-off value.
 * @param {string} text Text that would go into a TEXT column
 * @returns {boolean}
 */
export function hasNulCharacter(text) {
    return text.includes('\0');
}

/**
 * @param {string} filePath Path of the source file
 * @returns {[string, string]} Absolute folder and file name, the key of a row for that file
 */
export function getFileKey(filePath) {
    const resolvedPath = path.resolve(filePath);
    return [path.dirname(resolvedPath), path.basename(resolvedPath)];
}

/**
 * The size and modification time that decide whether a row still describes its file.
 * Read the metadata before the file: metadata read after the file can belong to a newer version of it than the data
 * that is stored, and the cache would then return the old data for the newer file.
 * @param {{ size: number, mtimeMs: number }} fileStat File metadata
 * @returns {[number, number]} Size and modification time in milliseconds
 */
export function getFileStamp(fileStat) {
    return [fileStat.size, fileStat.mtimeMs];
}

/**
 * @param {string} filePath Database file path
 * @returns {any} bun:sqlite or node:sqlite database
 */
function openDatabase(filePath) {
    if (isBunRuntime()) {
        const { Database } = require('bun:sqlite');
        return new Database(filePath);
    }

    // Node.js 26 renamed DatabaseSync to Database and deprecated the old name.
    const { Database, DatabaseSync } = require('node:sqlite');
    return new (Database ?? DatabaseSync)(filePath);
}

/**
 * @param {any} database bun:sqlite or node:sqlite database
 * @param {string} sql SQL statements to run
 */
function runSql(database, sql) {
    // bun:sqlite marks exec as a deprecated alias of run, and node:sqlite has no run.
    if (isBunRuntime()) {
        database.run(sql);
    } else {
        database.exec(sql);
    }
}

/**
 * @param {any} error Error from the SQLite driver
 * @returns {boolean}
 */
function isCorruptionError(error) {
    // node:sqlite puts the SQLite result code in errcode, and bun:sqlite puts it in errno.
    const resultCode = error?.code === 'ERR_SQLITE_ERROR' ? error.errcode : error?.name === 'SQLiteError' ? error.errno : 0;
    // An extended result code keeps the primary result code in its low byte.
    const primaryCode = resultCode & 0xff;
    return primaryCode === SQLITE_CORRUPT || primaryCode === SQLITE_NOTADB;
}

/**
 * @param {SqliteCacheOptions} options Options of a cache
 */
function assertOptions({ fileName, schemaVersion, schema, statements, messages }) {
    // The name goes into a path under the cache folder, and the version goes into SQL text.
    if (typeof fileName !== 'string' || !fileName || fileName === '.' || fileName === '..' || path.basename(fileName) !== fileName) {
        throw new TypeError('A SQLite cache needs a file name without a folder');
    }
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
        throw new TypeError('A SQLite cache needs a schema version that is a whole number from 1 up');
    }
    if (typeof schema !== 'string' || !schema) {
        throw new TypeError('A SQLite cache needs the SQL of its schema');
    }
    if (!statements || typeof statements !== 'object' || !Object.values(statements).every(sql => typeof sql === 'string' && sql)) {
        throw new TypeError('A SQLite cache needs its statements as an object of SQL text');
    }
    for (const key of ['nodeTooOld', 'failed', 'closeFailed']) {
        if (typeof messages?.[key] !== 'string' || !messages[key]) {
            throw new TypeError(`A SQLite cache needs the message "${key}"`);
        }
    }
}

/**
 * One SQLite file under `DATA_ROOT/_cache` that holds data derived from other files.
 * The source files stay the source of truth and the database file can be deleted at any time, so nothing may live
 * only in the cache. Each index brings its own schema, statements and staleness rule, and gets from here the driver
 * switch between bun:sqlite and node:sqlite, the open and rebuild flow, and the rule that any error turns the cache off.
 *
 * The file is opened on the first `use()`, and again on the first `use()` after `close()`. A file that is new, damaged,
 * or has another schema version is deleted and built again empty. After any other error the cache stays off until the
 * server restarts, so a broken database file cannot fail the reads that the cache only speeds up.
 */
export class SqliteCache {
    /** @type {boolean} */
    #enabled;

    /** @type {any} */
    #database = null;

    /** @type {Record<string, any>|null} */
    #statements = null;

    #fileName;
    #schemaVersion;
    #schema;
    #statementSql;
    #messages;

    /**
     * @param {SqliteCacheOptions} options Cache options
     */
    constructor(options) {
        assertOptions(options);
        this.#enabled = options.enabled;
        this.#fileName = options.fileName;
        this.#schemaVersion = options.schemaVersion;
        this.#schema = options.schema;
        this.#statementSql = { ...options.statements };
        this.#messages = { ...options.messages };
    }

    /**
     * @returns {string}
     */
    get filePath() {
        return path.join(getCacheDirectory(), this.#fileName);
    }

    /**
     * Runs a callback against the prepared statements, and turns the cache off if the callback or the open throws.
     * @template T
     * @param {(statements: Record<string, any>, run: (sql: string) => void) => T} callback Receives the prepared statements by
     * name, and `run`, which runs SQL text (several statements allowed) without bound values
     * @param {T} [fallback] Returned instead of the callback's result when the cache is off or has just failed
     * @returns {T|undefined}
     */
    use(callback, fallback) {
        const statements = this.#getStatements();
        if (!statements) {
            return fallback;
        }

        try {
            return callback(statements, sql => runSql(this.#database, sql));
        } catch (error) {
            this.#handleError(error);
            return fallback;
        }
    }

    /**
     * While the cache is on, the next call that uses it opens the database file again.
     */
    close() {
        try {
            for (const statement of Object.values(this.#statements ?? {})) {
                // bun:sqlite keeps the database file open until every statement is finalized.
                statement.finalize?.();
            }
            this.#database?.close();
        } catch (error) {
            console.warn(this.#messages.closeFailed, error);
        } finally {
            this.#statements = null;
            this.#database = null;
        }
    }

    /**
     * Opens the database file if it is closed.
     * @returns {Record<string, any>|null} Prepared statements, or null if the cache is off
     */
    #getStatements() {
        if (!this.#statements && this.#enabled) {
            try {
                this.#open();
            } catch (error) {
                this.#handleError(error);
            }
        }

        return this.#statements;
    }

    #open() {
        try {
            this.#connect();
            if (this.#readUserVersion() === this.#schemaVersion) {
                this.#prepareStatements();
                return;
            }
        } catch (error) {
            if (!isCorruptionError(error)) {
                throw error;
            }
        }

        // The file is new, damaged, or has another schema version, so the cache starts again empty.
        this.close();
        this.#deleteFiles();
        this.#connect();
        runSql(this.#database, this.#schema);
        runSql(this.#database, `PRAGMA user_version = ${this.#schemaVersion}`);
        this.#prepareStatements();
    }

    #connect() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        this.#database = openDatabase(this.filePath);
        // WAL with synchronous=NORMAL does not flush the file on every write. A power loss can drop the newest
        // entries, but cannot corrupt the database. auto_vacuum works only if it is set before the table is created.
        runSql(this.#database, getSqliteCachePragmas());
    }

    /**
     * @returns {number} Schema version of the open database file
     */
    #readUserVersion() {
        const statement = this.#database.prepare('PRAGMA user_version');
        try {
            return statement.get()?.user_version;
        } finally {
            statement.finalize?.();
        }
    }

    #prepareStatements() {
        // Assigned before the loop, so the statements that are already prepared are finalized if a later one fails.
        this.#statements = {};
        for (const [name, sql] of Object.entries(this.#statementSql)) {
            this.#statements[name] = this.#database.prepare(sql);
        }
    }

    #deleteFiles() {
        for (const suffix of ['', '-wal', '-shm']) {
            fs.rmSync(`${this.filePath}${suffix}`, { force: true });
        }
    }

    /**
     * Turns the cache off until the server restarts, so a broken database file cannot fail the reads that it speeds up.
     * @param {any} error Error from the SQLite driver or the file system
     */
    #handleError(error) {
        // Node.js older than 22.13 throws this code when openDatabase() loads node:sqlite.
        if (error?.code === 'ERR_UNKNOWN_BUILTIN_MODULE') {
            console.warn(this.#messages.nodeTooOld);
        } else {
            console.warn(this.#messages.failed, error);
        }
        this.close();
        this.#enabled = false;
        if (isCorruptionError(error)) {
            try {
                this.#deleteFiles();
            } catch {
                // A damaged file is replaced when the server starts again.
            }
        }
    }
}
