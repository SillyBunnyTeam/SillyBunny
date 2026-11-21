import { describe, expect, test } from '@jest/globals';

import {
    createPresetApiSyncLifecycle,
    PRESET_API_SYNC_CONNECTION_SOURCE_STATE,
    normalizePresetApiId,
    resolveConnectionProfileMirrorState,
    resolveConnectionProfileSelectionSync,
    resolvePresetMainApiValue,
} from '../public/scripts/preset-api-sync-lifecycle/index.js';

describe('preset/API sync lifecycle helper', () => {
    test('normalizes main API ids for DOM and context lookups', () => {
        expect(normalizePresetApiId(' OpenAI ')).toBe('openai');
        expect(normalizePresetApiId('textGenerationWebUI')).toBe('textgenerationwebui');
        expect(normalizePresetApiId(null)).toBe('');
    });

    test('prefers the main API select value before context fallback', () => {
        expect(resolvePresetMainApiValue({
            selectValue: 'Novel',
            contextMainApi: 'openai',
        })).toBe('novel');

        expect(resolvePresetMainApiValue({
            selectValue: '',
            contextMainApi: 'koboldhorde',
        })).toBe('koboldhorde');
    });

    test('resolves connection profile selection sync without DOM mutation', () => {
        expect(resolveConnectionProfileSelectionSync({
            requestedValue: ' profile-a ',
            currentValue: 'profile-b',
        })).toEqual({
            nextValue: 'profile-a',
            shouldSync: true,
        });

        expect(resolveConnectionProfileSelectionSync({
            requestedValue: 'profile-a',
            currentValue: ' profile-a ',
        })).toEqual({
            nextValue: 'profile-a',
            shouldSync: false,
        });

        expect(resolveConnectionProfileSelectionSync({
            requestedValue: '',
            currentValue: 'profile-a',
        })).toEqual({
            nextValue: '',
            shouldSync: false,
        });
    });

    test('resolves mirror state when connection profiles are unavailable', () => {
        expect(resolveConnectionProfileMirrorState({
            hasConnectionProfiles: false,
        })).toEqual({
            sourceState: PRESET_API_SYNC_CONNECTION_SOURCE_STATE.MISSING,
            shouldClearMirrors: true,
            shouldShowMobileSection: false,
        });
    });

    test('resolves mirror state when connection profiles are ready', () => {
        expect(resolveConnectionProfileMirrorState({
            hasConnectionProfiles: true,
        })).toEqual({
            sourceState: PRESET_API_SYNC_CONNECTION_SOURCE_STATE.READY,
            shouldClearMirrors: false,
            shouldShowMobileSection: true,
        });
    });

    test('creates a stable lifecycle seam for future runtime wiring', () => {
        const lifecycle = createPresetApiSyncLifecycle();

        expect(lifecycle.api.normalizeId).toBe(normalizePresetApiId);
        expect(lifecycle.api.resolveMainValue).toBe(resolvePresetMainApiValue);
        expect(lifecycle.connectionProfiles.sourceState).toBe(PRESET_API_SYNC_CONNECTION_SOURCE_STATE);
        expect(lifecycle.connectionProfiles.resolveSelectionSync).toBe(resolveConnectionProfileSelectionSync);
        expect(lifecycle.connectionProfiles.resolveMirrorState).toBe(resolveConnectionProfileMirrorState);
    });
});
