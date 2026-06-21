import { describe, expect, test } from '@jest/globals';

import {
    createPresetApiSyncLifecycle,
    PRESET_API_SYNC_CONNECT_BUTTON_SELECTORS,
    PRESET_API_SYNC_CONNECTION_SOURCE_STATE,
    normalizePresetApiId,
    resolveConnectionProfileMirrorState,
    resolveConnectionProfileSelectionSync,
    resolvePresetApiConnectButtonSelector,
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

    test('maps active API ids to their connect button selectors', () => {
        expect(resolvePresetApiConnectButtonSelector('kobold')).toBe('#api_button');
        expect(resolvePresetApiConnectButtonSelector('koboldhorde')).toBe('#api_button');
        expect(resolvePresetApiConnectButtonSelector('horde')).toBe('#api_button');
        expect(resolvePresetApiConnectButtonSelector('novel')).toBe('#api_button_novel');
        expect(resolvePresetApiConnectButtonSelector('openai')).toBe('#api_button_openai');
        expect(resolvePresetApiConnectButtonSelector('textgenerationwebui')).toBe('#api_button_textgenerationwebui');
        expect(resolvePresetApiConnectButtonSelector('unknown')).toBeNull();
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
            isConnectionStripOpen: true,
            hasActiveConnectButton: true,
        })).toEqual({
            sourceState: PRESET_API_SYNC_CONNECTION_SOURCE_STATE.MISSING,
            shouldShowToggle: false,
            shouldShowDesktopStrip: false,
            shouldCloseDesktopStrip: true,
            shouldClearMirrors: true,
            shouldShowMobileSection: false,
            shouldDisableConnectButton: true,
        });
    });

    test('resolves mirror state when connection profiles are ready', () => {
        expect(resolveConnectionProfileMirrorState({
            hasConnectionProfiles: true,
            isConnectionStripOpen: true,
            hasActiveConnectButton: false,
        })).toEqual({
            sourceState: PRESET_API_SYNC_CONNECTION_SOURCE_STATE.READY,
            shouldShowToggle: true,
            shouldShowDesktopStrip: true,
            shouldCloseDesktopStrip: false,
            shouldClearMirrors: false,
            shouldShowMobileSection: true,
            shouldDisableConnectButton: true,
        });

        expect(resolveConnectionProfileMirrorState({
            hasConnectionProfiles: true,
            isConnectionStripOpen: false,
            hasActiveConnectButton: true,
        })).toMatchObject({
            shouldShowDesktopStrip: false,
            shouldDisableConnectButton: false,
        });
    });

    test('creates a stable lifecycle seam for future runtime wiring', () => {
        const lifecycle = createPresetApiSyncLifecycle();

        expect(lifecycle.api.connectButtonSelectors).toBe(PRESET_API_SYNC_CONNECT_BUTTON_SELECTORS);
        expect(lifecycle.api.normalizeId).toBe(normalizePresetApiId);
        expect(lifecycle.api.resolveMainValue).toBe(resolvePresetMainApiValue);
        expect(lifecycle.api.resolveConnectButtonSelector).toBe(resolvePresetApiConnectButtonSelector);
        expect(lifecycle.connectionProfiles.sourceState).toBe(PRESET_API_SYNC_CONNECTION_SOURCE_STATE);
        expect(lifecycle.connectionProfiles.resolveSelectionSync).toBe(resolveConnectionProfileSelectionSync);
        expect(lifecycle.connectionProfiles.resolveMirrorState).toBe(resolveConnectionProfileMirrorState);
    });
});
