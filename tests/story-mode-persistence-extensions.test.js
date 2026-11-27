/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importExtensionsModule } from './util/extensions-module-harness.js';

afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
});

async function setupExtensionFieldRuntime() {
    document.body.innerHTML = '<input id="character_json_data" value="" />';
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200, statusText: 'OK' }));
    const loaded = await importExtensionsModule({
        fetch: fetchMock,
        utils: {
            setValueByPath(obj, path, value) {
                const parts = path.split('.');
                let cur = obj;
                for (let i = 0; i < parts.length - 1; i++) {
                    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
                    cur = cur[parts[i]];
                }
                cur[parts[parts.length - 1]] = value;
            },
            deleteValueByPath(obj, path) {
                const parts = path.split('.');
                let cur = obj;
                for (let i = 0; i < parts.length - 1; i++) {
                    if (!cur || typeof cur !== 'object') return;
                    cur = cur[parts[i]];
                }
                if (cur && typeof cur === 'object') delete cur[parts[parts.length - 1]];
            },
        },
    });

    const character = { avatar: 'story.png', data: { extensions: { story: { enabled: false }, other: 1 } } };
    character.json_data = JSON.stringify({ data: structuredClone(character.data) });
    const state = { characters: [character], characterId: 0 };
    loaded.extensions.setExtensionContextGetter(() => state);

    const jsonInput = document.getElementById('character_json_data');
    return { ...loaded, fetchMock, state, character, jsonInput };
}

describe('strict host extension field writes', () => {
    test.each(['http', 'network'])('does not mutate the card, JSON or form on %s failure', async (failure) => {
        const { extensions, fetchMock, character, jsonInput } = await setupExtensionFieldRuntime();
        const original = structuredClone(character);
        fetchMock.mockImplementation(async () => {
            character.data.extensions.other = 2;
            if (failure === 'network') throw new Error('network failure');
            return { ok: false, status: 500, statusText: 'failure' };
        });

        await expect(extensions.writeExtensionField(0, 'story', { enabled: true }, { throwOnError: true })).rejects.toThrow();
        expect(character.data.extensions).toEqual({ story: { enabled: false }, other: 2 });
        expect(character.json_data).toBe(original.json_data);
        expect(jsonInput.value).toBe('');
    });

    test('commits the sent value only after success and keeps unrelated concurrent changes', async () => {
        const { extensions, fetchMock, state, character, jsonInput } = await setupExtensionFieldRuntime();
        let respond;
        fetchMock.mockReturnValue(new Promise(resolve => { respond = resolve; }));
        const value = { enabled: true };
        const pending = extensions.writeExtensionField(0, 'story', value, { throwOnError: true });

        expect(character.data.extensions.story.enabled).toBe(false);
        expect(jsonInput.value).toBe('');

        value.enabled = false;
        character.data.extensions.other = 2;
        character.json_data = JSON.stringify({ data: { extensions: { ...character.data.extensions, newer: 3 } } });
        state.characters.unshift({ avatar: 'other.png' });
        state.characterId = 0;

        respond({ ok: true, status: 200, statusText: 'OK' });
        await expect(pending).resolves.toBe(true);
        expect(character.data.extensions).toEqual({ story: { enabled: true }, other: 2 });
        expect(JSON.parse(character.json_data).data.extensions).toEqual({ story: { enabled: true }, other: 2, newer: 3 });
        expect(jsonInput.value).toBe('');
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
            avatar: 'story.png',
            data: { extensions: { story: { enabled: true } } },
        });
    });

    test('updates the active form after strict success and keeps the UNSET request shape', async () => {
        const { extensions, fetchMock, character, jsonInput } = await setupExtensionFieldRuntime();
        await expect(extensions.writeExtensionField('0', 'story', extensions.UNSET_VALUE, { throwOnError: true })).resolves.toBe(true);
        expect(character.data.extensions).toEqual({ other: 1 });
        expect(JSON.parse(character.json_data).data.extensions).toEqual({ other: 1 });
        expect(jsonInput.value).toBe(character.json_data);
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).data.extensions.story).toBe(extensions.UNSET_VALUE);
    });

    test('retains optimistic mutation and undefined return for default HTTP failures', async () => {
        const { extensions, fetchMock, character, jsonInput } = await setupExtensionFieldRuntime();
        fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'failure' });
        await expect(extensions.writeExtensionField(0, 'story', true)).resolves.toBeUndefined();
        expect(character.data.extensions.story).toBe(true);
        expect(jsonInput.value).toBe(character.json_data);
    });

    test('rejects a missing card or identity before sending a strict request', async () => {
        const { extensions, fetchMock, character } = await setupExtensionFieldRuntime();
        await expect(extensions.writeExtensionField(5, 'story', true, { throwOnError: true })).rejects.toThrow('Character not found');
        delete character.avatar;
        await expect(extensions.writeExtensionField(0, 'story', true, { throwOnError: true })).rejects.toThrow('identity');
        expect(fetchMock).not.toHaveBeenCalled();
        await expect(extensions.writeExtensionField(5, 'story', true)).resolves.toBeUndefined();
    });

    test('does not commit to a different card if the target disappears during the request', async () => {
        const { extensions, fetchMock, state, character, jsonInput } = await setupExtensionFieldRuntime();
        fetchMock.mockImplementation(async () => {
            state.characters = [{ avatar: 'replacement.png', data: { extensions: {} } }];
            return { ok: true, status: 200, statusText: 'OK' };
        });
        await expect(extensions.writeExtensionField(0, 'story', true, { throwOnError: true })).rejects.toThrow('no longer available');
        expect(character.data.extensions.story.enabled).toBe(false);
        expect(state.characters[0].data.extensions).toEqual({});
        expect(jsonInput.value).not.toContain('story');
    });
});
