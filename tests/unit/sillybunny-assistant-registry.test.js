/* eslint-disable playwright/no-standalone-expect -- Jest contracts for pure functions. */
import { describe, expect, jest, test } from '@jest/globals';
import {
    ASSISTANTS,
    getAssistant,
    getAssistantAvatars,
    getCreationMethod,
    getHomeAssistants,
    getOptionalAssistants,
    resolveDefaultAssistant,
} from '../../public/scripts/sillybunny-home/assistant-registry.js';
import { BUNDLED_EXTRAS } from '../../public/scripts/sillybunny-bundled-extras.js';

const ids = () => ASSISTANTS.map(assistant => assistant.id);

describe('the assistant registry', () => {
    test('lists Reisen, Tewi, Nahida and the Bunny Guide, each once, in that order', () => {
        expect(ids()).toEqual(['reisen', 'tewi', 'nahida', 'guide']);
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
        ['nahida', 'default_AssistantNahida.png', 'default_AssistantNahida', 'bundledAssistantNahidaAvatar', 'bundledAssistantNahidaIdentityAvatar', 'bundledAssistantNahidaDeleted'],
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
    test.each(['reisen', 'tewi'])('%s is resolve-only: no card asset and no card of her own to create', (id) => {
        const assistant = getAssistant(id);

        expect(getCreationMethod(assistant)).toBeNull();
        expect(assistant).not.toHaveProperty('cardAsset');
        expect(assistant).not.toHaveProperty('portrait');
        expect(assistant).not.toHaveProperty('description');
        expect(assistant).not.toHaveProperty('firstMessage');
    });

    test('Nahida is imported from her card asset, and only when the user asks', () => {
        const nahida = getAssistant('nahida');

        expect(getCreationMethod(nahida)).toBe('asset');
        expect(nahida.cardAsset).toBe('img/assistant-nahida-portrait.png');
        expect(nahida.autoEnsure).toBe(false);
    });

    test('the Bunny Guide still has the card that the app creates for it', () => {
        const guide = getAssistant('guide');

        expect(getCreationMethod(guide)).toBe('fallback');
        expect(guide.autoEnsure).not.toBe(false);
    });

    test.each(['reisen', 'tewi', 'guide'])('%s is looked for at startup', (id) => {
        expect(getAssistant(id).autoEnsure).not.toBe(false);
    });

    test('an entry with a card asset wins over one with a fallback card', () => {
        expect(getCreationMethod({ cardAsset: 'img/a.png', portrait: 'img/b.png' })).toBe('asset');
        expect(getCreationMethod({ portrait: 'img/b.png' })).toBe('fallback');
        expect(getCreationMethod({})).toBeNull();
    });

    test('every assistant that Bundled Extras offers is one that the app can import, and none of them is looked for at startup', () => {
        const offered = BUNDLED_EXTRAS.filter(item => item.kind === 'assistant');

        expect(offered.length).toBeGreaterThan(0);
        for (const item of offered) {
            expect(getCreationMethod(getAssistant(item.id))).toBe('asset');
            expect(getAssistant(item.id).autoEnsure).toBe(false);
        }
    });
});

describe('what Home and Getting Started read', () => {
    test('Home lists Reisen and Tewi with the names, subtitle slots and art they had as placeholders', () => {
        expect(getHomeAssistants().map(({ id, name, slot, art }) => ({ id, name, slot, art }))).toEqual([
            { id: 'reisen', name: 'Reisen', slot: 'AS-REISEN-SUB', art: 'row-reisen' },
            { id: 'tewi', name: 'Tewi', slot: 'AS-TEWI-SUB', art: 'row-tewi' },
        ]);
    });

    test('Home lists an optional assistant only once she is installed, with the slot and art she has in Bundled Extras', () => {
        expect(getOptionalAssistants().map(({ id, name, slot, art }) => ({ id, name, slot, art }))).toEqual([
            { id: 'nahida', name: 'Nahida', slot: 'AS-NAHIDA-SUB', art: 'row-nahida' },
        ]);
        expect(getHomeAssistants().some(assistant => assistant.autoEnsure === false)).toBe(false);
    });

    test('an optional assistant is exactly one that is not looked for at startup', () => {
        expect(getOptionalAssistants().every(assistant => assistant.autoEnsure === false)).toBe(true);
        expect(ASSISTANTS.filter(assistant => assistant.autoEnsure === false)).toEqual(getOptionalAssistants());
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

    test('does not depend on the cards of Tewi or Nahida', () => {
        expect(resolveDefaultAssistant({ hasCard: assistant => assistant.id !== 'reisen' }).id).toBe('guide');
    });

    test('is the entry of the registry, so its keys and avatar are the ones listed there', () => {
        expect(resolveDefaultAssistant({ hasCard: () => true })).toBe(getAssistant('reisen'));
        expect(resolveDefaultAssistant({ hasCard: () => false })).toBe(getAssistant('guide'));
    });
});
