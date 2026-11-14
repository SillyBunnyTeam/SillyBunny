/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom tests use synchronous DOM assertions. */
import { jest, describe, expect, test } from '@jest/globals';

import { SETTINGS_COPY } from '../helpers/copy-settings.js';

// The select row draws its picker from modules that need the app's browser globals.
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((out, string, index) => out + string + (index < values.length ? values[index] : ''), ''),
    translate: value => value,
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    animateHeightFrom: jest.fn(),
    animateIn: jest.fn(),
    animateOut: jest.fn((_element, _frames, hide) => hide()),
    play: jest.fn(),
    stopMotion: jest.fn(),
    MOTION_FAST: 200,
    MOTION_SLOW: 250,
    MOTION_POPOVER_CLOSE: 150,
    MOTION_EASE_OUT_CUBIC: 'cubic-bezier(0.33, 1, 0.68, 1)',
    SPRING_SHEET: {},
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    MOBILE_QUERY: '(max-width: 768px)',
    positionPopover: jest.fn(() => '0px 0'),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-sheet.js', () => ({
    blockUpstreamDrawerClose: jest.fn(),
    createSheetController: jest.fn(),
}));

const { createSplashCharacterRow } = await import('../../public/scripts/sillybunny-splash-setting.js');
const { initSplashPreferences } = await import('../../public/scripts/sillybunny-splash-preferences.js');

function createStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        values,
        getItem: key => (values.has(key) ? values.get(key) : null),
        setItem: (key, value) => { values.set(key, String(value)); },
    };
}

/** The real preferences over in-memory storage, so the row is tested with the behavior it sits on. */
function create({ local = {}, account = {} } = {}) {
    const listeners = [];
    const storage = createStorage(local);
    const accountStorage = createStorage(account);
    const preferences = initSplashPreferences({
        eventSource: { on: (name, listener) => listeners.push([name, listener]) },
        eventTypes: { SETTINGS_LOADED: 'loaded', SETTINGS_UPDATED: 'updated', APP_READY: 'ready' },
        accountStorage,
        storage,
        readReducedMotion: () => false,
    });
    const fire = name => listeners.filter(([listened]) => listened === name).forEach(([, listener]) => listener());
    const row = createSplashCharacterRow(preferences);
    const select = row.row.querySelector('select');
    return { row, select, preferences, storage, accountStorage, fire };
}

function choose(select, value) {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('the splash character row', () => {
    test('is titled Splash Character and offers Random, Reisen, Tewi and Both, in that order', () => {
        const { row, select } = create();

        expect(row.row.querySelector('.ds-row-label')?.textContent).toBe('Splash Character');
        expect([...select.options].map(option => [option.value, option.textContent])).toEqual([
            ['random', 'Random'],
            ['reisen', 'Reisen'],
            ['tewi', 'Tewi'],
            ['both', 'Both'],
        ]);
    });

    test('has the written subtitle, with no placeholder mark', () => {
        const subtitle = create().row.row.querySelector('.ds-row-subtitle');

        expect(subtitle?.textContent).toBe(SETTINGS_COPY.splashSubtitle);
        expect(subtitle?.hasAttribute('data-sb-copy-placeholder')).toBe(false);
    });

    test('shows Random until a character is chosen, and the stored one after', () => {
        expect(create().select.value).toBe('random');
        expect(create({ local: { 'sb-splash-character': 'both' } }).select.value).toBe('both');
    });

    test('stores the choice in this browser and the account when it is changed', () => {
        const { select, storage, accountStorage, preferences } = create();

        choose(select, 'tewi');

        expect(preferences.getCharacter()).toBe('tewi');
        expect(storage.values.get('sb-splash-character')).toBe('tewi');
        expect(accountStorage.values.get('WelcomePage_SplashCharacter')).toBe('tewi');
    });

    test('follows the account when the settings load a different character', () => {
        const { select, fire } = create({ local: { 'sb-splash-character': 'tewi' }, account: { WelcomePage_SplashCharacter: 'reisen' } });

        fire('loaded');

        expect(select.value).toBe('reisen');
    });
});
