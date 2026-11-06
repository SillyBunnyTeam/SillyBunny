/* eslint-disable playwright/no-standalone-expect -- Jest contracts for pure functions. */
import { describe, expect, jest, test } from '@jest/globals';
import {
    ASSISTANT_POINTER_MIGRATED_KEY,
    migrateAssistantPointer,
} from '../../public/scripts/sillybunny-home/assistant-pointer-migration.js';

const REISEN = 'default_AssistantReisen.png';
const POINTER = 'assistant';

/** Account storage over a map, with a log of what was written and in which order. */
function createStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    const writes = [];
    return {
        values,
        writes,
        getItem: jest.fn(key => (values.has(key) ? values.get(key) : null)),
        setItem: jest.fn((key, value) => { writes.push(key); values.set(key, value); }),
    };
}

describe('moving the assistant pointer to Reisen', () => {
    test('waits while Reisen has no card, and changes nothing', () => {
        const storage = createStorage({ [POINTER]: 'default_SillyBunnyGuide.png' });

        const result = migrateAssistantPointer({ storage, findAvatar: () => null });

        expect(result).toBe('waiting');
        expect(storage.writes).toEqual([]);
        expect(storage.values.get(POINTER)).toBe('default_SillyBunnyGuide.png');
        expect(storage.values.has(ASSISTANT_POINTER_MIGRATED_KEY)).toBe(false);
    });

    test('points the account at the card of Reisen once it resolves, and records that it did', () => {
        const storage = createStorage();

        const result = migrateAssistantPointer({ storage, findAvatar: () => REISEN });

        expect(result).toBe('migrated');
        expect(storage.values.get(POINTER)).toBe(REISEN);
        expect(storage.values.get(ASSISTANT_POINTER_MIGRATED_KEY)).toBe('true');
    });

    test.each([
        ['none', {}],
        ['the Bunny Guide', { [POINTER]: 'default_SillyBunnyGuide.png' }],
        ['a card of the user', { [POINTER]: 'Alice.png' }],
        ['Tewi', { [POINTER]: 'default_AssistantTewi.png' }],
        ['an empty value', { [POINTER]: '' }],
    ])('repoints a pointer that names %s', (_name, initial) => {
        const storage = createStorage(initial);

        migrateAssistantPointer({ storage, findAvatar: () => REISEN });

        expect(storage.values.get(POINTER)).toBe(REISEN);
    });

    test('uses the avatar that the card of Reisen resolved to, such as one the user renamed', () => {
        const storage = createStorage({ [POINTER]: 'default_SillyBunnyGuide.png' });

        migrateAssistantPointer({ storage, findAvatar: () => 'My Reisen.png' });

        expect(storage.values.get(POINTER)).toBe('My Reisen.png');
    });

    test('asks for the card of Reisen, by the entry of the registry', () => {
        const findAvatar = jest.fn(() => REISEN);

        migrateAssistantPointer({ storage: createStorage(), findAvatar });

        expect(findAvatar).toHaveBeenCalledTimes(1);
        expect(findAvatar.mock.calls[0][0]).toMatchObject({ id: 'reisen', defaultAvatar: REISEN });
    });

    test('runs once: a later start leaves the choice of the user, and does not look for the card', () => {
        const storage = createStorage();
        migrateAssistantPointer({ storage, findAvatar: () => REISEN });
        storage.values.set(POINTER, 'default_AssistantTewi.png');
        storage.writes.length = 0;
        const findAvatar = jest.fn(() => REISEN);

        const result = migrateAssistantPointer({ storage, findAvatar });

        expect(result).toBe('already-done');
        expect(findAvatar).not.toHaveBeenCalled();
        expect(storage.writes).toEqual([]);
        expect(storage.values.get(POINTER)).toBe('default_AssistantTewi.png');
    });

    test('is done for an account that carries the record, whatever it says', () => {
        const storage = createStorage({ [ASSISTANT_POINTER_MIGRATED_KEY]: 'false', [POINTER]: 'Alice.png' });

        expect(migrateAssistantPointer({ storage, findAvatar: () => REISEN })).toBe('already-done');
        expect(storage.values.get(POINTER)).toBe('Alice.png');
    });

    test('writes the pointer before the record, so a start that stops between them tries again', () => {
        const storage = createStorage();

        migrateAssistantPointer({ storage, findAvatar: () => REISEN });

        expect(storage.writes).toEqual([POINTER, ASSISTANT_POINTER_MIGRATED_KEY]);
    });

    test('records nothing when the pointer cannot be written', () => {
        const storage = createStorage();
        storage.setItem.mockImplementationOnce(() => { throw new Error('storage is full'); });

        expect(() => migrateAssistantPointer({ storage, findAvatar: () => REISEN })).toThrow('storage is full');
        expect(storage.values.has(ASSISTANT_POINTER_MIGRATED_KEY)).toBe(false);
    });

    test('waits again on the next start when Reisen has still no card', () => {
        const storage = createStorage();
        migrateAssistantPointer({ storage, findAvatar: () => undefined });

        expect(migrateAssistantPointer({ storage, findAvatar: () => '' })).toBe('waiting');
        expect(migrateAssistantPointer({ storage, findAvatar: () => REISEN })).toBe('migrated');
    });
});
