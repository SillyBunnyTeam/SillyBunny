import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import { SqliteCache, getCacheDirectory, getFileKey, getFileStamp, hasNulCharacter } from './sqlite-cache.js';

// Raise the version when the stored data for an unchanged card file changes, for example after a parser fix.
// An index file with another version is deleted and built again.
const SCHEMA_VERSION = 1;

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

const MESSAGES = {
    nodeTooOld: 'The character cache needs Node.js 22.13 or newer, so cards are read from their files.',
    failed: 'Character index error. Cards are read from their files until the server restarts:',
    closeFailed: 'Could not close the character index:',
};

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
    #cache;

    /**
     * @param {object} options Index options
     * @param {boolean} options.enabled Keep parsed cards on disk
     */
    constructor({ enabled }) {
        this.#cache = new SqliteCache({
            fileName: 'characters.sqlite',
            enabled,
            schemaVersion: SCHEMA_VERSION,
            schema: SCHEMA,
            statements: STATEMENTS,
            messages: MESSAGES,
        });
    }

    /**
     * @returns {string}
     */
    get filePath() {
        return this.#cache.filePath;
    }

    /**
     * @param {string} filePath Card file path
     * @param {fs.Stats} fileStat Card file metadata
     * @returns {string|undefined} Card data, or undefined if the index is off or has no entry for this size and modification time
     */
    get(filePath, fileStat) {
        return this.#cache.use(statements => statements.get.get(...getFileKey(filePath), ...getFileStamp(fileStat))?.data);
    }

    /**
     * @param {string} filePath Card file path
     * @param {fs.Stats} fileStat Card file metadata, read before the card was parsed. Metadata read after parsing can
     * belong to a newer version of the file than the data, and the index would then return the old data for it.
     * @param {string} data Card data
     */
    set(filePath, fileStat, data) {
        // Node.js 22 returns a stored TEXT value only up to its first NUL character, so the index would return a cut-off card.
        if (hasNulCharacter(data)) {
            return;
        }

        this.#cache.use(statements => {
            statements.set.run(...getFileKey(filePath), ...getFileStamp(fileStat), data);
        });
    }

    /**
     * @param {string} filePath Card file path
     */
    delete(filePath) {
        this.#cache.use(statements => {
            statements.delete.run(...getFileKey(filePath));
        });
    }

    /**
     * @param {string} directory Characters directory
     * @param {string[]} fileNames Names of the card files in the directory
     */
    pruneDirectory(directory, fileNames) {
        this.#cache.use(statements => {
            const resolvedDirectory = path.resolve(directory);
            const existingFiles = new Set(fileNames);
            for (const { file_name: fileName } of statements.listDirectory.all(resolvedDirectory)) {
                if (!existingFiles.has(fileName)) {
                    statements.delete.run(resolvedDirectory, fileName);
                }
            }
        });
    }

    /**
     * Removes the cards whose files are not in any user's characters directory, and deletes the
     * node-persist cache directory that this index replaces.
     * @param {import('./users.js').UserDirectoryList[]} directoriesList Directories of all users
     * @returns {Promise<void>}
     */
    async prune(directoriesList) {
        try {
            await fsPromises.rm(path.join(getCacheDirectory(), 'characters'), { recursive: true, force: true });
        } catch (error) {
            console.warn('Could not delete the old character disk cache:', error);
        }

        this.#cache.use((statements, run) => {
            const cardFiles = new Map(directoriesList.map(directories => {
                const directory = path.resolve(directories.characters);
                return [directory, listCardFiles(directory)];
            }));
            for (const { directory, file_name: fileName } of statements.listAll.all()) {
                if (!cardFiles.get(directory)?.has(fileName)) {
                    statements.delete.run(directory, fileName);
                }
            }
            run('PRAGMA incremental_vacuum');
        });
    }

    /**
     * While the index is on, the next call that uses it opens the database file again.
     */
    close() {
        this.#cache.close();
    }
}
