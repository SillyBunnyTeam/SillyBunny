/* eslint-disable playwright/no-standalone-expect -- Jest contracts for plain functions. */
import { describe, expect, jest, test } from '@jest/globals';

import { SPLASH_CHARACTER_CHOICES, initSplashPreferences, parseSplashCharacter } from '../../public/scripts/sillybunny-splash-preferences.js';

/** A `localStorage` that keeps its values in a map, and can be told to refuse. */
function createStorage(initial = {}, { blocked = false } = {}) {
    const values = new Map(Object.entries(initial));
    return {
        values,
        getItem: jest.fn((key) => {
            if (blocked) throw new Error('storage blocked');
            return values.has(key) ? values.get(key) : null;
        }),
        setItem: jest.fn((key, value) => {
            if (blocked) throw new Error('storage blocked');
            values.set(key, String(value));
        }),
    };
}

function createEvents() {
    const listeners = [];
    return {
        eventSource: { on: jest.fn((name, listener) => listeners.push([name, listener])) },
        eventTypes: { SETTINGS_LOADED: 'settings_loaded', SETTINGS_UPDATED: 'settings_updated', APP_READY: 'app_ready' },
        fire: name => listeners.filter(([listened]) => listened === name).forEach(([, listener]) => listener()),
    };
}

/** The preferences with the app replaced by plain doubles. */
function create({ local = {}, account = {}, reducedMotion = false, localBlocked = false } = {}) {
    const storage = createStorage(local, { blocked: localBlocked });
    const accountStorage = createStorage(account);
    const events = createEvents();
    const state = { reducedMotion };
    const preferences = initSplashPreferences({ ...events, accountStorage, storage, readReducedMotion: () => state.reducedMotion });
    return { preferences, storage, accountStorage, events, state };
}

describe('the splash character choices', () => {
    test('are Random first, then the three variants the splash can show', () => {
        expect(SPLASH_CHARACTER_CHOICES).toEqual(['random', 'reisen', 'tewi', 'both']);
    });

    test.each(['random', 'reisen', 'tewi', 'both'])('parse %s as itself', (choice) => {
        expect(parseSplashCharacter(choice)).toBe(choice);
    });

    test.each([null, undefined, '', 'Reisen', 'nahida', 'true', 5, {}])('parse %j as Random', (value) => {
        expect(parseSplashCharacter(value)).toBe('random');
    });
});

describe('the splash character', () => {
    test('is Random until it is chosen', () => {
        expect(create().preferences.getCharacter()).toBe('random');
    });

    test('is the one stored in this browser', () => {
        expect(create({ local: { 'sb-splash-character': 'tewi' } }).preferences.getCharacter()).toBe('tewi');
    });

    test('is Random when this browser holds something else, or refuses to be read', () => {
        expect(create({ local: { 'sb-splash-character': 'nahida' } }).preferences.getCharacter()).toBe('random');
        expect(create({ localBlocked: true }).preferences.getCharacter()).toBe('random');
    });

    test('is stored in this browser for the next start, and in the account for the other browsers', () => {
        const { preferences, storage, accountStorage } = create();

        preferences.setCharacter('both');

        expect(storage.values.get('sb-splash-character')).toBe('both');
        expect(accountStorage.values.get('WelcomePage_SplashCharacter')).toBe('both');
        expect(preferences.getCharacter()).toBe('both');
    });

    test('stores Random as a choice, so it can replace an earlier one', () => {
        const { preferences, storage, accountStorage } = create({ local: { 'sb-splash-character': 'tewi' }, account: { WelcomePage_SplashCharacter: 'tewi' } });

        preferences.setCharacter('random');

        expect(storage.values.get('sb-splash-character')).toBe('random');
        expect(accountStorage.values.get('WelcomePage_SplashCharacter')).toBe('random');
    });

    test('refuses a choice that is not one of the four, and stores nothing', () => {
        const { preferences, storage, accountStorage } = create();

        expect(() => preferences.setCharacter('nahida')).toThrow(TypeError);

        expect(storage.setItem).not.toHaveBeenCalled();
        expect(accountStorage.setItem).not.toHaveBeenCalled();
    });

    test('still reaches the account when this browser refuses to store it', () => {
        const { preferences, accountStorage } = create({ localBlocked: true });

        expect(() => preferences.setCharacter('reisen')).not.toThrow();

        expect(accountStorage.values.get('WelcomePage_SplashCharacter')).toBe('reisen');
    });

    test('tells a listener when it changes, and not when it is chosen again', () => {
        const { preferences } = create();
        const listener = jest.fn();
        preferences.onCharacterChange(listener);

        preferences.setCharacter('tewi');
        preferences.setCharacter('tewi');

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith('tewi');
    });
});

describe('the splash character in a new browser', () => {
    test.each(['settings_loaded', 'app_ready'])('is copied from the account to this browser on %s, so the second start shows it', (eventName) => {
        const { storage, events, preferences } = create({ account: { WelcomePage_SplashCharacter: 'reisen' } });

        events.fire(eventName);

        expect(storage.values.get('sb-splash-character')).toBe('reisen');
        expect(preferences.getCharacter()).toBe('reisen');
    });

    test('replaces what this browser held, because the account is shared by every browser', () => {
        const { storage, events } = create({ local: { 'sb-splash-character': 'tewi' }, account: { WelcomePage_SplashCharacter: 'both' } });

        events.fire('settings_loaded');

        expect(storage.values.get('sb-splash-character')).toBe('both');
    });

    test('leaves this browser alone when the account holds nothing, or something that is not a choice', () => {
        const empty = create({ local: { 'sb-splash-character': 'tewi' } });
        const invalid = create({ local: { 'sb-splash-character': 'tewi' }, account: { WelcomePage_SplashCharacter: 'nahida' } });

        empty.events.fire('settings_loaded');
        invalid.events.fire('settings_loaded');

        expect(empty.storage.values.get('sb-splash-character')).toBe('tewi');
        expect(invalid.storage.values.get('sb-splash-character')).toBe('tewi');
    });

    test('tells a listener when the copy changed the character, and not when it did not', () => {
        const changed = create({ local: { 'sb-splash-character': 'tewi' }, account: { WelcomePage_SplashCharacter: 'both' } });
        const same = create({ local: { 'sb-splash-character': 'both' }, account: { WelcomePage_SplashCharacter: 'both' } });
        const changedListener = jest.fn();
        const sameListener = jest.fn();
        changed.preferences.onCharacterChange(changedListener);
        same.preferences.onCharacterChange(sameListener);

        changed.events.fire('settings_loaded');
        same.events.fire('settings_loaded');

        expect(changedListener).toHaveBeenCalledWith('both');
        expect(sameListener).not.toHaveBeenCalled();
    });
});

describe('the Reduced Motion mirror', () => {
    test.each([
        ['on', true, 'true'],
        ['off', false, 'false'],
    ])('stores %s for the splash of the next start, when the settings load', (_label, reduced, stored) => {
        const { storage, events } = create({ reducedMotion: reduced });

        events.fire('settings_loaded');

        expect(storage.values.get('sb-reduced-motion')).toBe(stored);
    });

    test('follows the setting on every settings save', () => {
        const { storage, events, state } = create();

        events.fire('settings_loaded');
        state.reducedMotion = true;
        events.fire('settings_updated');
        expect(storage.values.get('sb-reduced-motion')).toBe('true');

        state.reducedMotion = false;
        events.fire('settings_updated');
        expect(storage.values.get('sb-reduced-motion')).toBe('false');
    });

    test('is stored again only when it changed', () => {
        const { storage, events } = create({ reducedMotion: true });

        events.fire('settings_loaded');
        events.fire('settings_updated');
        events.fire('settings_updated');

        expect(storage.setItem.mock.calls.filter(([key]) => key === 'sb-reduced-motion')).toHaveLength(1);
    });

    test('is skipped without a failure when this browser refuses to store it', () => {
        const { events } = create({ localBlocked: true, reducedMotion: true });

        expect(() => events.fire('settings_loaded')).not.toThrow();
    });

    test('stores nothing for a setting that is not a plain boolean, rather than guess', () => {
        const { storage, events, state } = create();
        state.reducedMotion = undefined;

        events.fire('settings_loaded');

        expect(storage.values.has('sb-reduced-motion')).toBe(false);
    });
});
