import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { isBunRuntime } from './runtime.js';

const require = createRequire(import.meta.url);

// Raise the version when the stored data for an unchanged card file changes, for example after a parser fix.
// An index file with another version is deleted and built again.
const SCHEMA_VERSION = 1;
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

const SCHEMA = `CREATE TABLE characters (
    directory TEXT NOT NULL,
    file_name TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime REAL NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (directory, file_name)
)`;

const STATEMENTS = {
    get: 'SELECT data FROM characters WHERE directory = ? AND file_name = ? AND size = ? AND mtime = ?',
    set: 'INSERT OR REPLACE INTO characters (directory, file_name, size, mtime, data) VALUES (?, ?, ?, ?, ?)',
    delete: 'DELETE FROM characters WHERE directory = ? AND file_name = ?',
    listDirectory: 'SELECT file_name FROM characters WHERE directory = ?',
    listAll: 'SELECT directory, file_name FROM characters',
};

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
 * @param {string} filePath Card file path
 * @returns {[string, string]} Directory and file name of the card
 */
function getEntryKey(filePath) {
    const resolvedPath = path.resolve(filePath);
    return [path.dirname(resolvedPath), path.basename(resolvedPath)];
}

/**
 * @param {string} directory Characters directory
 * @returns {Set<string>} Names of the card files in the directory
 */
function listCardFiles(directory) {
    try {
        return new Set(fs.readdirSync(directory).filter(file => file.endsWith('.png')));
    } catch {
        return new Set();
    }
}

/**
 * Keeps parsed character cards in a SQLite file, so a restart does not parse every card PNG again.
 * The card files stay the source of truth: an entry is used only while its file has the same size and
 * modification time as when the card was parsed, and the database file can be deleted at any time.
 */
export class CharacterIndex {
    /** @type {boolean} */
    #enabled;

    /** @type {any} */
    #database = null;

    /** @type {Record<string, any>|null} */
    #statements = null;

    /**
     * @param {object} options Index options
     * @param {boolean} options.enabled Keep parsed cards on disk
     */
    constructor({ enabled }) {
        this.#enabled = enabled;
    }

    /**
     * @returns {string}
     */
    get filePath() {
        return path.join(globalThis.DATA_ROOT, '_cache', 'characters.sqlite');
    }

    /**
     * @param {string} filePath Card file path
     * @param {fs.Stats} fileStat Card file metadata
     * @returns {string|undefined} Card data, or undefined if the index is off or has no entry for this size and modification time
     */
    get(filePath, fileStat) {
        const statements = this.#getStatements();
        if (!statements) {
            return undefined;
        }

        try {
            return statements.get.get(...getEntryKey(filePath), fileStat.size, fileStat.mtimeMs)?.data;
        } catch (error) {
            this.#handleError(error);
            return undefined;
        }
    }

    /**
     * @param {string} filePath Card file path
     * @param {fs.Stats} fileStat Card file metadata, read before the card was parsed. Metadata read after parsing can
     * belong to a newer version of the file than the data, and the index would then return the old data for it.
     * @param {string} data Card data
     */
    set(filePath, fileStat, data) {
        const statements = this.#getStatements();
        if (!statements) {
            return;
        }

        try {
            statements.set.run(...getEntryKey(filePath), fileStat.size, fileStat.mtimeMs, data);
        } catch (error) {
            this.#handleError(error);
        }
    }

    /**
     * @param {string} filePath Card file path
     */
    delete(filePath) {
        const statements = this.#getStatements();
        if (!statements) {
            return;
        }

        try {
            statements.delete.run(...getEntryKey(filePath));
        } catch (error) {
            this.#handleError(error);
        }
    }

    /**
     * @param {string} directory Characters directory
     * @param {string[]} fileNames Names of the card files in the directory
     */
    pruneDirectory(directory, fileNames) {
        const statements = this.#getStatements();
        if (!statements) {
            return;
        }

        try {
            const resolvedDirectory = path.resolve(directory);
            const existingFiles = new Set(fileNames);
            for (const { file_name: fileName } of statements.listDirectory.all(resolvedDirectory)) {
                if (!existingFiles.has(fileName)) {
                    statements.delete.run(resolvedDirectory, fileName);
                }
            }
        } catch (error) {
            this.#handleError(error);
        }
    }

    /**
     * Removes the cards whose files are not in any user's characters directory, and deletes the
     * node-persist cache directory that this index replaces.
     * @param {import('./users.js').UserDirectoryList[]} directoriesList Directories of all users
     * @returns {Promise<void>}
     */
    async prune(directoriesList) {
        try {
            await fsPromises.rm(path.join(globalThis.DATA_ROOT, '_cache', 'characters'), { recursive: true, force: true });
        } catch (error) {
            console.warn('Could not delete the old character disk cache:', error);
        }

        const statements = this.#getStatements();
        if (!statements) {
            return;
        }

        try {
            const cardFiles = new Map(directoriesList.map(directories => {
                const directory = path.resolve(directories.characters);
                return [directory, listCardFiles(directory)];
            }));
            for (const { directory, file_name: fileName } of statements.listAll.all()) {
                if (!cardFiles.get(directory)?.has(fileName)) {
                    statements.delete.run(directory, fileName);
                }
            }
            this.#database.exec('PRAGMA incremental_vacuum');
        } catch (error) {
            this.#handleError(error);
        }
    }

    /**
     * While the index is on, the next call that uses it opens the database file again.
     */
    close() {
        try {
            for (const statement of Object.values(this.#statements ?? {})) {
                // bun:sqlite keeps the database file open until every statement is finalized.
                statement.finalize?.();
            }
            this.#database?.close();
        } catch (error) {
            console.warn('Could not close the character index:', error);
        } finally {
            this.#statements = null;
            this.#database = null;
        }
    }

    /**
     * Opens the database file if it is closed.
     * @returns {Record<string, any>|null} Prepared statements, or null if the index is off
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
            if (this.#readUserVersion() === SCHEMA_VERSION) {
                this.#prepareStatements();
                return;
            }
        } catch (error) {
            if (!isCorruptionError(error)) {
                throw error;
            }
        }

        // The file is new, damaged, or has another schema version, so the index starts again empty.
        this.close();
        this.#deleteFiles();
        this.#connect();
        this.#database.exec(SCHEMA);
        this.#database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        this.#prepareStatements();
    }

    #connect() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        this.#database = openDatabase(this.filePath);
        // WAL with synchronous=NORMAL does not flush the file on every write. A power loss can drop the newest
        // entries, but cannot corrupt the database. auto_vacuum works only if it is set before the table is created.
        this.#database.exec('PRAGMA busy_timeout = 1000; PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL');
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
        for (const [name, sql] of Object.entries(STATEMENTS)) {
            this.#statements[name] = this.#database.prepare(sql);
        }
    }

    #deleteFiles() {
        for (const suffix of ['', '-wal', '-shm']) {
            fs.rmSync(`${this.filePath}${suffix}`, { force: true });
        }
    }

    /**
     * Turns the index off until the server restarts, so a broken database file cannot fail card reads.
     * @param {any} error Error from the SQLite driver or the file system
     */
    #handleError(error) {
        console.warn('Character index error. Cards are read from their files until the server restarts:', error);
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
