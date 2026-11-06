/* eslint-disable playwright/no-standalone-expect -- Jest contracts for plain functions. */
import { describe, expect, jest, test } from '@jest/globals';

import { RETIRED_ACCOUNT_KEYS, RETIRED_LOCAL_KEYS, initRetiredKeys, removeRetiredKeys } from '../../public/scripts/sillybunny-retired-keys.js';

/** A store that keeps its values in a map, can be told to refuse, and counts the removals that took something away. */
function createStore(initial = {}, { blocked = false } = {}) {
    const values = new Map(Object.entries(initial));
    return {
        values,
        removed: [],
        removeItem(key) {
            if (blocked) throw new Error('storage blocked');
            if (values.delete(key)) this.removed.push(key);
        },
    };
}

const KEPT = {
    WelcomePage_PanelMode: 'compact',
    WelcomePage_LastMode: 'roleplay',
    assistant: 'default_AssistantReisen.png',
    bundledAssistantNahidaDeleted: 'true',
    bundledAssistantReisenDeleted: 'true',
};

describe('the retired keys', () => {
    test('name the deck view, the tutorial and the Bunny Guide marks in the account', () => {
        expect(RETIRED_ACCOUNT_KEYS).toEqual([
            'WelcomePage_DeckView',
            'WelcomePage_TutorialStatus',
            'WelcomePage_TutorialIndex',
            'bundledAssistantGuideAvatar',
            'bundledAssistantGuideDeleted',
        ]);
    });

    test('add the Frontend Icon choice to the account keys in the browser', () => {
        expect(RETIRED_LOCAL_KEYS).toEqual([...RETIRED_ACCOUNT_KEYS, 'sb-frontend-icon']);
    });

    test('name no key that the app still reads', () => {
        for (const key of Object.keys(KEPT)) {
            expect(RETIRED_LOCAL_KEYS).not.toContain(key);
        }
    });
});

describe('removing the retired keys', () => {
    test('deletes them from the account and from the browser, and leaves every other key', () => {
        const account = createStore({ ...KEPT, WelcomePage_DeckView: 'wide', WelcomePage_TutorialStatus: 'done', WelcomePage_TutorialIndex: '3', bundledAssistantGuideAvatar: 'renamed.png', bundledAssistantGuideDeleted: 'true' });
        const local = createStore({ ...KEPT, 'sb-frontend-icon': 'badge', WelcomePage_DeckView: 'wide', WelcomePage_TutorialIndex: '3', 'sb-splash-character': 'tewi' });

        removeRetiredKeys({ account, local });

        expect([...account.values.keys()]).toEqual(Object.keys(KEPT));
        expect([...local.values.keys()]).toEqual([...Object.keys(KEPT), 'sb-splash-character']);
    });

    test('does nothing when the keys are already gone, so a second run is free', () => {
        const account = createStore({ ...KEPT, bundledAssistantGuideAvatar: 'renamed.png' });
        const local = createStore({ 'sb-frontend-icon': 'pixel' });

        removeRetiredKeys({ account, local });
        account.removed.length = 0;
        local.removed.length = 0;
        removeRetiredKeys({ account, local });

        expect(account.removed).toEqual([]);
        expect(local.removed).toEqual([]);
    });

    test('still clears the account when the browser storage is blocked', () => {
        const account = createStore({ WelcomePage_TutorialStatus: 'done' });

        expect(() => removeRetiredKeys({ account, local: createStore({}, { blocked: true }) })).not.toThrow();
        expect(account.values.size).toBe(0);
    });
});

describe('starting the removal', () => {
    test('runs when the settings have loaded and again at APP_READY', () => {
        const listeners = [];
        const eventSource = { on: jest.fn((name, listener) => listeners.push([name, listener])) };
        const account = createStore({ WelcomePage_DeckView: 'wide' });
        const local = createStore({ 'sb-frontend-icon': 'badge' });

        initRetiredKeys({ eventSource, eventTypes: { SETTINGS_LOADED: 'settings_loaded', APP_READY: 'app_ready' }, accountStorage: account, storage: local });

        expect(listeners.map(([name]) => name)).toEqual(['settings_loaded', 'app_ready']);
        expect(account.values.size).toBe(1);

        listeners[0][1]();

        expect(account.values.size).toBe(0);
        expect(local.values.size).toBe(0);
    });
});
