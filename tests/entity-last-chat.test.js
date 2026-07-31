import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    ENTITY_LAST_CHAT_FILE,
    getEntityLastChat,
    importEntityLastChat,
    prepareEntityLastChatMove,
    readEntityLastChats,
    removeEntityLastChat,
    setEntityLastChat,
} from '../src/entity-last-chat.js';

const tempDirectories = [];

function createUserRoot() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-last-chat-'));
    tempDirectories.push(directory);
    return directory;
}

afterEach(() => {
    jest.restoreAllMocks();
    for (const directory of tempDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('entity last chat metadata', () => {
    test('records and reads back a character\'s last opened chat', () => {
        const userRoot = createUserRoot();

        expect(getEntityLastChat(userRoot, 'Alice.png')).toBeUndefined();
        expect(readEntityLastChats(userRoot).size).toBe(0);

        setEntityLastChat(userRoot, 'Alice.png', 'Alice - 2026-07-31');

        expect(getEntityLastChat(userRoot, 'Alice.png')).toBe('Alice - 2026-07-31');
        expect(readEntityLastChats(userRoot).get('Alice.png')).toBe('Alice - 2026-07-31');
    });

    test('reading never creates the store file', () => {
        const userRoot = createUserRoot();
        const filePath = path.join(userRoot, ENTITY_LAST_CHAT_FILE);

        readEntityLastChats(userRoot);
        getEntityLastChat(userRoot, 'Alice.png');

        expect(fs.existsSync(filePath)).toBe(false);
    });

    test('re-recording the same chat leaves the store file untouched', () => {
        const userRoot = createUserRoot();
        const filePath = path.join(userRoot, ENTITY_LAST_CHAT_FILE);
        setEntityLastChat(userRoot, 'Alice.png', 'Alice - 2026-07-31');
        const firstWrite = fs.statSync(filePath).mtimeMs;

        setEntityLastChat(userRoot, 'Alice.png', 'Alice - 2026-07-31');

        expect(fs.statSync(filePath).mtimeMs).toBe(firstWrite);
    });

    test('an empty chat name drops the entry so the card can take over again', () => {
        const userRoot = createUserRoot();
        setEntityLastChat(userRoot, 'Alice.png', 'Alice - 2026-07-31');

        setEntityLastChat(userRoot, 'Alice.png', '   ');

        expect(getEntityLastChat(userRoot, 'Alice.png')).toBeUndefined();
    });

    test('a rename carries the entry over, falling back to the card value', () => {
        const userRoot = createUserRoot();
        setEntityLastChat(userRoot, 'Alice.png', 'Alice - 2026-07-31');

        expect(prepareEntityLastChatMove(userRoot, 'Alice.png', 'Alicia.png')).toBe('Alice - 2026-07-31');
        expect(getEntityLastChat(userRoot, 'Alice.png')).toBeUndefined();
        expect(getEntityLastChat(userRoot, 'Alicia.png')).toBe('Alice - 2026-07-31');

        // A card that predates the sidecar has no entry to move, so the value
        // embedded in the card is adopted instead.
        expect(prepareEntityLastChatMove(userRoot, 'Bob.png', 'Bobby.png', 'Bob - 2026-07-30')).toBe('Bob - 2026-07-30');
        expect(getEntityLastChat(userRoot, 'Bobby.png')).toBe('Bob - 2026-07-30');
    });

    test('removal clears the entry', () => {
        const userRoot = createUserRoot();
        setEntityLastChat(userRoot, 'Alice.png', 'Alice - 2026-07-31');

        expect(removeEntityLastChat(userRoot, 'Alice.png')).toBe('Alice - 2026-07-31');
        expect(getEntityLastChat(userRoot, 'Alice.png')).toBeUndefined();
    });

    test('a corrupt store is preserved and replaced rather than throwing', () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const userRoot = createUserRoot();
        const filePath = path.join(userRoot, ENTITY_LAST_CHAT_FILE);
        fs.writeFileSync(filePath, '{ not json', 'utf8');

        expect(readEntityLastChats(userRoot).size).toBe(0);
        expect(fs.readdirSync(userRoot).some(file => file.includes('.corrupt-'))).toBe(true);
    });

    test('an import keeps local entries the imported store does not carry', () => {
        const userRoot = createUserRoot();
        setEntityLastChat(userRoot, 'Local.png', 'Local - 2026-07-31');

        importEntityLastChat(userRoot, {
            version: 1,
            characters: { entries: { 'Imported.png': 'Imported - 2026-07-20' } },
        });

        const entries = readEntityLastChats(userRoot);
        expect(entries.get('Imported.png')).toBe('Imported - 2026-07-20');
        expect(entries.get('Local.png')).toBe('Local - 2026-07-31');
    });

    test('non-string IDs are rejected', () => {
        const userRoot = createUserRoot();

        expect(() => getEntityLastChat(userRoot, '')).toThrow(TypeError);
        expect(() => setEntityLastChat(userRoot, null, 'chat')).toThrow(TypeError);
        expect(() => removeEntityLastChat(userRoot, undefined)).toThrow(TypeError);
        expect(() => prepareEntityLastChatMove(userRoot, 'Alice.png', '')).toThrow(TypeError);
    });
});
