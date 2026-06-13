import { describe, expect, test } from '@jest/globals';

import {
    createPresetApiSyncLifecycle,
    PRESET_API_SYNC_CONNECT_BUTTON_SELECTORS,
    PRESET_API_SYNC_CONNECTION_SOURCE_STATE,
    normalizePresetApiId,
    resolveConnectionProfileMirrorState,
    resolveConnectionProfileMirrorUpdate,
    resolveConnectionProfileSelectionSync,
    resolveConnectionProfileSourceBinding,
    resolveConnectionProfileStatusText,
    resolveConnectionStripOpenState,
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

    test('skips connection profile source binding when the source is already observed', () => {
        expect(resolveConnectionProfileSourceBinding({
            isSameSource: true,
            hasCurrentSource: true,
            hasNextSource: true,
            hasChangeHandler: true,
        })).toEqual({
            shouldSkip: true,
            shouldUnbindCurrent: false,
            shouldDisconnectObserver: false,
            shouldStoreNextSource: false,
            shouldClearChangeHandler: false,
            shouldBindNext: false,
        });
    });

    test('resolves connection profile source rebinding operations', () => {
        expect(resolveConnectionProfileSourceBinding({
            hasCurrentSource: true,
            hasNextSource: true,
            hasChangeHandler: true,
        })).toEqual({
            shouldSkip: false,
            shouldUnbindCurrent: true,
            shouldDisconnectObserver: true,
            shouldStoreNextSource: true,
            shouldClearChangeHandler: true,
            shouldBindNext: true,
        });
    });

    test('resolves connection profile source clearing without a next source', () => {
        expect(resolveConnectionProfileSourceBinding({
            hasCurrentSource: true,
            hasNextSource: false,
            hasChangeHandler: false,
        })).toEqual({
            shouldSkip: false,
            shouldUnbindCurrent: false,
            shouldDisconnectObserver: true,
            shouldStoreNextSource: true,
            shouldClearChangeHandler: true,
            shouldBindNext: false,
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

    test('resolves connection profile mirror clearing without source values', () => {
        expect(resolveConnectionProfileMirrorUpdate({
            shouldClearMirrors: true,
            shouldShowMobileSection: false,
            shouldDisableConnectButton: true,
            sourceOptionsMarkup: '<option value="profile-a">A</option>',
            sourceValue: 'profile-a',
            connectionStatusText: 'OpenAI - model',
        })).toEqual({
            shouldClearMirrors: true,
            shouldShowMobileSection: false,
            shouldDisableConnectButton: true,
            optionsMarkup: '',
            selectedValue: '',
            statusText: '',
        });
    });

    test('resolves connection profile mirror option and value updates', () => {
        expect(resolveConnectionProfileMirrorUpdate({
            shouldClearMirrors: false,
            shouldShowMobileSection: true,
            shouldDisableConnectButton: false,
            sourceOptionsMarkup: '<option value="profile-a">A</option>',
            sourceValue: 'profile-a',
            connectionStatusText: 'OpenAI - model',
        })).toEqual({
            shouldClearMirrors: false,
            shouldShowMobileSection: true,
            shouldDisableConnectButton: false,
            optionsMarkup: '<option value="profile-a">A</option>',
            selectedValue: 'profile-a',
            statusText: 'OpenAI - model',
        });
    });

    test('resolves connection profile status fallback states', () => {
        expect(resolveConnectionProfileStatusText({
            hasContext: false,
            apiValue: 'openai',
            modelValue: 'gpt-5',
        })).toBe('');

        expect(resolveConnectionProfileStatusText({
            hasContext: true,
            isNoConnection: true,
            apiValue: 'openai',
            modelValue: 'gpt-5',
        })).toBe('No connection...');
    });

    test('resolves connection profile status labels from raw and decorated values', () => {
        expect(resolveConnectionProfileStatusText({
            hasContext: true,
            apiValue: 'openai',
            modelValue: 'gpt-5',
            apiOptionText: 'OpenAI [Responses]',
            modelOptionText: 'GPT-5 (fast)',
        })).toBe('OpenAI - GPT-5');

        expect(resolveConnectionProfileStatusText({
            hasContext: true,
            apiValue: 'Claude',
            modelValue: '',
        })).toBe('Claude');
    });

    test('resolves connection strip open state plans', () => {
        expect(resolveConnectionStripOpenState({
            shouldOpen: true,
            hasDesktopStrip: true,
        })).toEqual({
            shouldApply: true,
            nextState: true,
            shouldApplySurfaceExclusivity: true,
        });

        expect(resolveConnectionStripOpenState({
            shouldOpen: false,
            hasDesktopStrip: true,
        })).toEqual({
            shouldApply: true,
            nextState: false,
            shouldApplySurfaceExclusivity: false,
        });

        expect(resolveConnectionStripOpenState({
            shouldOpen: true,
            hasDesktopStrip: false,
        })).toEqual({
            shouldApply: false,
            nextState: true,
            shouldApplySurfaceExclusivity: false,
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
        expect(lifecycle.connectionProfiles.resolveSourceBinding).toBe(resolveConnectionProfileSourceBinding);
        expect(lifecycle.connectionProfiles.resolveMirrorState).toBe(resolveConnectionProfileMirrorState);
        expect(lifecycle.connectionProfiles.resolveMirrorUpdate).toBe(resolveConnectionProfileMirrorUpdate);
        expect(lifecycle.connectionProfiles.resolveStatusText).toBe(resolveConnectionProfileStatusText);
        expect(lifecycle.connectionProfiles.resolveStripOpenState).toBe(resolveConnectionStripOpenState);
    });
});
