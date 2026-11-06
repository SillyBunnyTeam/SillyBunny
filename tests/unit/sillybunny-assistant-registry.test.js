/* eslint-disable playwright/no-standalone-expect -- Jest contracts for pure functions. */
import { describe, expect, test } from '@jest/globals';
import * as registry from '../../public/scripts/sillybunny-home/assistant-registry.js';

const {
    ASSISTANTS,
    getAssistant,
    getAssistantAvatars,
    getHomeAssistants,
} = registry;

const ids = () => ASSISTANTS.map(assistant => assistant.id);

describe('the assistant registry', () => {
    test('lists Reisen and Tewi, each once, in that order', () => {
        expect(ids()).toEqual(['reisen', 'tewi']);
    });

    test('does not list the Bunny Guide, and names none of the account keys that earlier versions kept for it', () => {
        const keys = ASSISTANTS.flatMap(assistant => [assistant.avatarStorageKey, assistant.identityStorageKey, assistant.deletedStorageKey, assistant.defaultAvatar, assistant.fileName]);

        expect(ids()).not.toContain('guide');
        expect(keys.filter(key => /guide/i.test(key))).toEqual([]);
        expect(() => getAssistant('guide')).toThrow(/guide/);
    });

    test('does not list Nahida, and names none of the account keys that earlier versions kept for her', () => {
        const keys = ASSISTANTS.flatMap(assistant => [assistant.avatarStorageKey, assistant.identityStorageKey, assistant.deletedStorageKey]);

        expect(ids()).not.toContain('nahida');
        expect(keys.filter(key => /nahida/i.test(key))).toEqual([]);
        expect(() => getAssistant('nahida')).toThrow(/nahida/);
    });

    test('has no mechanism for an assistant that is imported on request', () => {
        expect(registry).not.toHaveProperty('getOptionalAssistants');
        expect(ASSISTANTS.filter(assistant => 'autoEnsure' in assistant || 'cardAsset' in assistant)).toEqual([]);
    });

    test('is frozen, entries included', () => {
        expect(Object.isFrozen(ASSISTANTS)).toBe(true);
        expect(ASSISTANTS.every(assistant => Object.isFrozen(assistant))).toBe(true);
    });

    test('gives each assistant its own storage keys, apart from the pointer that only Reisen uses', () => {
        const pointers = ASSISTANTS.map(assistant => assistant.avatarStorageKey);
        const identities = ASSISTANTS.map(assistant => assistant.identityStorageKey);
        const deleted = ASSISTANTS.map(assistant => assistant.deletedStorageKey);

        expect(new Set(identities).size).toBe(identities.length);
        expect(new Set(deleted).size).toBe(deleted.length);
        expect(pointers.filter(key => key === 'assistant')).toHaveLength(1);
        expect(new Set(pointers).size).toBe(pointers.length);
        expect(getAssistant('reisen').avatarStorageKey).toBe('assistant');
    });

    test.each([
        ['reisen', 'default_AssistantReisen.png', 'default_AssistantReisen', 'assistant', 'bundledAssistantReisenIdentityAvatar', 'bundledAssistantReisenDeleted'],
        ['tewi', 'default_AssistantTewi.png', 'default_AssistantTewi', 'bundledAssistantTewiAvatar', 'bundledAssistantTewiIdentityAvatar', 'bundledAssistantTewiDeleted'],
    ])('keeps the files and keys of %s that accounts already hold', (id, defaultAvatar, fileName, avatarKey, identityKey, deletedKey) => {
        expect(getAssistant(id)).toMatchObject({
            defaultAvatar,
            fileName,
            avatarStorageKey: avatarKey,
            identityStorageKey: identityKey,
            deletedStorageKey: deletedKey,
        });
    });

    test('throws for an assistant that it does not list', () => {
        expect(() => getAssistant('seraphina')).toThrow(/seraphina/);
        expect(() => getAssistant('__proto__')).toThrow();
    });
});

describe('how an assistant is brought into the library', () => {
    test.each(['reisen', 'tewi'])('%s is resolve-only: no portrait and no card of her own to create', (id) => {
        const assistant = getAssistant(id);

        expect(assistant).not.toHaveProperty('portrait');
        expect(assistant).not.toHaveProperty('description');
        expect(assistant).not.toHaveProperty('firstMessage');
        expect(registry).not.toHaveProperty('getCreationMethod');
    });
});

describe('what Home and Getting Started read', () => {
    test('Home lists Reisen and Tewi with the names and art they had as placeholders', () => {
        expect(getHomeAssistants().map(({ id, name, art }) => ({ id, name, art }))).toEqual([
            { id: 'reisen', name: 'Reisen', art: 'row-reisen' },
            { id: 'tewi', name: 'Tewi', art: 'row-tewi' },
        ]);
    });

    test('the avatars of an assistant are its default file', () => {
        expect(getAssistantAvatars('reisen')).toEqual(['default_AssistantReisen.png']);
        expect(getAssistantAvatars('tewi')).toEqual(['default_AssistantTewi.png']);
    });
});
