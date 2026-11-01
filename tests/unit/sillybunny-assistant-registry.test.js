/* eslint-disable playwright/no-standalone-expect -- Jest contracts for pure functions. */
import { describe, expect, jest, test } from '@jest/globals';
import * as registry from '../../public/scripts/sillybunny-home/assistant-registry.js';

const {
    ASSISTANTS,
    getAssistant,
    getAssistantAvatars,
    getCreationMethod,
    getHomeAssistants,
    resolveDefaultAssistant,
} = registry;

const ids = () => ASSISTANTS.map(assistant => assistant.id);

describe('the assistant registry', () => {
    test('lists Reisen, Tewi and the Bunny Guide, each once, in that order', () => {
        expect(ids()).toEqual(['reisen', 'tewi', 'guide']);
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

    test('gives each assistant its own storage keys, apart from the pointer that Reisen takes over from the Guide', () => {
        const pointers = ASSISTANTS.map(assistant => assistant.avatarStorageKey);
        const identities = ASSISTANTS.map(assistant => assistant.identityStorageKey);
        const deleted = ASSISTANTS.map(assistant => assistant.deletedStorageKey);

        expect(new Set(identities).size).toBe(identities.length);
        expect(new Set(deleted).size).toBe(deleted.length);
        expect(pointers.filter(key => key === 'assistant')).toHaveLength(2);
        expect(new Set(pointers).size).toBe(pointers.length - 1);
        expect(getAssistant('reisen').avatarStorageKey).toBe('assistant');
        expect(getAssistant('guide').avatarStorageKey).toBe('assistant');
    });

    test.each([
        ['reisen', 'default_AssistantReisen.png', 'default_AssistantReisen', 'assistant', 'bundledAssistantReisenIdentityAvatar', 'bundledAssistantReisenDeleted'],
        ['tewi', 'default_AssistantTewi.png', 'default_AssistantTewi', 'bundledAssistantTewiAvatar', 'bundledAssistantTewiIdentityAvatar', 'bundledAssistantTewiDeleted'],
        ['guide', 'default_SillyBunnyGuide.png', 'default_SillyBunnyGuide', 'assistant', 'bundledAssistantGuideAvatar', 'bundledAssistantGuideDeleted'],
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

        expect(getCreationMethod(assistant)).toBeNull();
        expect(assistant).not.toHaveProperty('portrait');
        expect(assistant).not.toHaveProperty('description');
        expect(assistant).not.toHaveProperty('firstMessage');
    });

    test('the Bunny Guide still has the card that the app creates for it', () => {
        const guide = getAssistant('guide');

        expect(getCreationMethod(guide)).toBe('fallback');
    });

    test('an entry with a portrait is created by the app, and one without is left to the server', () => {
        expect(getCreationMethod({ portrait: 'img/b.png' })).toBe('fallback');
        expect(getCreationMethod({})).toBeNull();
    });
});

describe('what Home and Getting Started read', () => {
    test('Home lists Reisen and Tewi with the names, subtitle slots and art they had as placeholders', () => {
        expect(getHomeAssistants().map(({ id, name, slot, art }) => ({ id, name, slot, art }))).toEqual([
            { id: 'reisen', name: 'Reisen', slot: 'AS-REISEN-SUB', art: 'row-reisen' },
            { id: 'tewi', name: 'Tewi', slot: 'AS-TEWI-SUB', art: 'row-tewi' },
        ]);
    });

    test('the avatars of an assistant are its default file', () => {
        expect(getAssistantAvatars('reisen')).toEqual(['default_AssistantReisen.png']);
        expect(getAssistantAvatars('tewi')).toEqual(['default_AssistantTewi.png']);
    });
});

describe('the default assistant', () => {
    test('is Reisen once her card exists', () => {
        const hasCard = jest.fn(() => true);

        expect(resolveDefaultAssistant({ hasCard }).id).toBe('reisen');
        expect(hasCard).toHaveBeenCalledTimes(1);
        expect(hasCard.mock.calls[0][0].id).toBe('reisen');
    });

    test('is the Bunny Guide while her card does not exist', () => {
        expect(resolveDefaultAssistant({ hasCard: () => false }).id).toBe('guide');
    });

    test('does not depend on the card of Tewi', () => {
        expect(resolveDefaultAssistant({ hasCard: assistant => assistant.id !== 'reisen' }).id).toBe('guide');
    });

    test('is the entry of the registry, so its keys and avatar are the ones listed there', () => {
        expect(resolveDefaultAssistant({ hasCard: () => true })).toBe(getAssistant('reisen'));
        expect(resolveDefaultAssistant({ hasCard: () => false })).toBe(getAssistant('guide'));
    });
});
