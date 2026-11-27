/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importTabsModule, DEFAULT_TABS_DOM } from '../util/tabs-harness.js';

const PERSONA_STYLESHEET_IDS = [
    'deferred-editor-shell-css',
    'deferred-editor-chrome-css',
    'deferred-entity-list-css',
    'deferred-persona-editor-css',
    'deferred-persona-detail-css',
];

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
    for (const id of PERSONA_STYLESHEET_IDS) {
        document.getElementById(id)?.remove();
    }
    jest.restoreAllMocks();
});

async function bootPersonaTabShell({ useRealDynamicStyles = false, listAvatarsImpl = null } = {}) {
    const avatarIds = ['avatar-0.png', 'avatar-1.png'];
    const records = Object.fromEntries(avatarIds.map((id, i) => [id, {
        avatarId: id,
        name: `Persona 0${i}`,
        descriptor: { title: '', description: '' },
    }]));
    let adapter = null;
    const setAdapter = jest.fn(next => { adapter = next; });
    const listAvatars = jest.fn(listAvatarsImpl ?? (async () => [...avatarIds]));
    const mountDetail = jest.fn(({ host }) => {
        const input = document.createElement('input');
        host.append(input);
        return {
            isDirty: () => false,
            save: jest.fn(async () => true),
            discard: jest.fn(),
            destroy: jest.fn(),
            refresh: jest.fn(),
            focusTarget: () => input,
            scrollToSection: jest.fn(),
        };
    });

    const domWithPersonaLegacy = DEFAULT_TABS_DOM.replace(
        '<div id="PersonaManagement" class="drawer-content closedDrawer"></div>',
        `<div id="PersonaManagement" class="drawer-content closedDrawer">
            <div id="legacy">
                <button id="personas_backup"></button>
                <button id="personas_restore"></button>
                <button class="user_stats_button"></button>
                <label><input id="persona_show_notifications" type="checkbox"><span>Notifications</span></label>
                <label><input id="persona_allow_multi_connections" type="checkbox"></label>
                <label><input id="persona_auto_lock" type="checkbox"></label>
            </div>
        </div>`,
    );

    const keepReal = [
        'scripts/sillybunny-editor/list-shell.js',
        'scripts/dynamic-styles.js',
    ];

    loaded = await importTabsModule({
        dom: domWithPersonaLegacy,
        keepReal,
        power_user: { persona_sort_order: 'asc' },
        mocks: {
            'script.js': base => ({
                ...base,
                getThumbnailUrlForViewport: jest.fn((_type, id) => `/thumbnail?file=${encodeURIComponent(id)}`),
            }),
            'scripts/browser-fixes.js': { isFirefox: () => false },
            'scripts/personas.js': {
                deletePersonaRecord: jest.fn(),
                duplicatePersonaRecord: jest.fn(),
                getPersonaDisplayAvatars: jest.fn(ids => ids),
                getPersonaEditorStates: () => ({ inUse: false, default: false, locked: { chat: false, character: false } }),
                getPersonaRecord: id => records[id] ?? null,
                listPersonaAvatars: listAvatars,
                setPersonaEditorAdapter: setAdapter,
                usePersona: jest.fn(async () => {}),
            },
            'scripts/sillybunny-delete-confirm.js': { confirmDestructiveAction: jest.fn(async () => false) },
            'scripts/popup.js': {
                Popup: jest.fn(),
                POPUP_TYPE: { CONFIRM: 1 },
                POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
            },
            'scripts/sillybunny-editor/picker.js': {
                isPickerOpen: jest.fn(() => false),
                openPicker: jest.fn(),
                closePicker: jest.fn(),
            },
            'scripts/sillybunny-editor/object-navigation.js': { objectNavigation: { back: jest.fn(({ fallback }) => fallback()) } },
            'scripts/sillybunny-editor/navigation.js': {
                registerEditorNavigation: jest.fn(() => jest.fn()),
                characterTabGuardSelector: tab => `guard-${tab}`,
            },
            'scripts/sillybunny-persona-detail.js': {
                mountPersonaDetail: mountDetail,
                personaDraftKey: id => `sb-persona-editor-draft-${id}`,
            },
        },
    });

    if (useRealDynamicStyles) {
        const { loadStylesheetAsync } = await import('../../public/scripts/dynamic-styles.js');
        loaded.assets.loadStylesheetAsync = loadStylesheetAsync;
    } else {
        loaded.assets.loadStylesheetAsync = jest.fn(async () => {});
    }

    const personaEditor = await import('../../public/scripts/sillybunny-persona-editor.js');
    return {
        loaded,
        personaEditor,
        avatarIds,
        listAvatars,
        mountDetail,
        getAdapter: () => adapter,
    };
}

describe('Persona tab lazy mount and stylesheet retry in sillybunny-tabs.js', () => {
    test('rejects readiness failures, warns, clears its cached promise, and mounts cleanly on retry', async () => {
        const failure = new Error('Persona readiness failed');
        const { loaded: env, listAvatars, getAdapter } = await bootPersonaTabShell();
        listAvatars.mockRejectedValueOnce(failure);
        const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const failedReveal = env.shell.openTab('characters', 'persona');
        await expect(failedReveal).rejects.toBe(failure);
        expect(warning).toHaveBeenCalledWith('[SillyBunny] Could not reveal the character panel.', failure);
        expect(getAdapter()).toBeNull();

        // Closing or switching away then revisiting retries cleanly with a fresh mount.
        env.shell.openTab('characters', 'characters');
        const controller = await env.shell.openTab('characters', 'persona');
        expect(controller).toBeTruthy();
        const container = document.getElementById('PersonaManagement');
        expect(container.querySelectorAll('.sb-persona-editor')).toHaveLength(1);
        expect(container.querySelector('.sb-persona-editor').hidden).toBe(false);
    });

    test.each(PERSONA_STYLESHEET_IDS)('a failed stylesheet load of %s is replaced before the tab retries', async failedId => {
        const { loaded: env } = await bootPersonaTabShell({ useRealDynamicStyles: true });
        jest.spyOn(console, 'warn').mockImplementation(() => {});

        const firstAttempt = env.shell.openTab('characters', 'persona');
        await env.flush();

        const originalLinks = new Map(PERSONA_STYLESHEET_IDS.map(id => [id, document.getElementById(id)]));
        for (const id of PERSONA_STYLESHEET_IDS) {
            expect(originalLinks.get(id)).not.toBeNull();
        }
        const failure = new Event('error');
        for (const [id, link] of originalLinks) {
            link.dispatchEvent(id === failedId ? failure : new Event('load'));
        }
        await expect(firstAttempt).rejects.toBe(failure);
        expect(originalLinks.get(failedId).isConnected).toBe(false);

        // Retrying after a failed stylesheet replaces only the failed <link> and keeps succeeded ones.
        env.shell.openTab('characters', 'characters');
        const retryAttempt = env.shell.openTab('characters', 'persona');
        await env.flush();

        const retryLink = document.getElementById(failedId);
        expect(retryLink).not.toBeNull();
        expect(retryLink).not.toBe(originalLinks.get(failedId));
        for (const [id, link] of [...originalLinks].filter(([id]) => id !== failedId)) {
            expect(document.getElementById(id)).toBe(link);
        }
        retryLink.dispatchEvent(new Event('load'));
        await retryAttempt;
        expect(document.querySelector('#PersonaManagement .sb-persona-editor').hidden).toBe(false);
    });

    test('openPersonaEditor rejects a tab stylesheet failure and opens detail on retry with a fresh request', async () => {
        const { loaded: env, personaEditor, avatarIds, mountDetail } = await bootPersonaTabShell({ useRealDynamicStyles: true });
        jest.spyOn(console, 'warn').mockImplementation(() => {});

        const opening = personaEditor.openPersonaEditor({ avatarId: avatarIds[0] });
        await env.flush();

        const failedId = 'deferred-persona-detail-css';
        const failedLink = document.getElementById(failedId);
        const failure = new Event('error');
        for (const id of PERSONA_STYLESHEET_IDS) {
            document.getElementById(id).dispatchEvent(id === failedId ? failure : new Event('load'));
        }
        await expect(opening).rejects.toBe(failure);
        expect(document.querySelector('#PersonaManagement .sb-persona-editor')).toBeNull();

        env.shell.openTab('characters', 'characters');
        const retrying = personaEditor.openPersonaEditor({ avatarId: avatarIds[0] });
        await env.flush();

        const retryLink = document.getElementById(failedId);
        expect(retryLink).not.toBeNull();
        expect(retryLink).not.toBe(failedLink);
        retryLink.dispatchEvent(new Event('load'));
        await expect(retrying).resolves.toBe(true);
        expect(mountDetail).toHaveBeenCalledTimes(1);
    });

    test('openPersonaEditor rejects a failed tab readiness mount rather than returning a hidden controller', async () => {
        const failure = new Error('Persona readiness failed');
        const { personaEditor, avatarIds, listAvatars, mountDetail } = await bootPersonaTabShell();
        listAvatars.mockRejectedValueOnce(failure);
        jest.spyOn(console, 'warn').mockImplementation(() => {});

        await expect(personaEditor.openPersonaEditor({ avatarId: avatarIds[0] })).rejects.toBe(failure);
        expect(mountDetail).not.toHaveBeenCalled();
        expect(document.querySelector('#PersonaManagement .sb-persona-editor')).toBeNull();
    });
});
