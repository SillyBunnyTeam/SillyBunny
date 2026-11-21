/**
 * What the next start's splash needs from the settings. The splash is a classic script that runs before any
 * module and before the account settings load, so it can only read `localStorage`. This module keeps that copy
 * current: the chosen character, and the Reduced Motion setting.
 */

/** @typedef {'random' | 'reisen' | 'tewi' | 'both'} SplashCharacter */

export const SPLASH_CHARACTER_CHOICES = Object.freeze(['random', 'reisen', 'tewi', 'both']);

const CHARACTER_STORAGE_KEY = 'sb-splash-character';
const CHARACTER_ACCOUNT_KEY = 'WelcomePage_SplashCharacter';
const REDUCED_MOTION_STORAGE_KEY = 'sb-reduced-motion';

/**
 * @param {unknown} value
 * @returns {value is SplashCharacter}
 */
function isSplashCharacter(value) {
    return typeof value === 'string' && SPLASH_CHARACTER_CHOICES.includes(value);
}

/**
 * @param {unknown} value
 * @returns {SplashCharacter}
 */
export function parseSplashCharacter(value) {
    return isSplashCharacter(value) ? value : 'random';
}

/**
 * @param {Pick<Storage, 'getItem'>} storage
 * @param {string} key
 * @returns {string | null}
 */
function readItem(storage, key) {
    try {
        return storage.getItem(key);
    } catch {
        // Storage can be blocked; the splash then falls back to its defaults.
        return null;
    }
}

/**
 * @param {Pick<Storage, 'setItem'>} storage
 * @param {string} key
 * @param {string} value
 * @returns {boolean} Whether the value was stored.
 */
function writeItem(storage, key, value) {
    try {
        storage.setItem(key, value);
        return true;
    } catch {
        return false;
    }
}

/**
 * @param {object} options
 * @param {{ on: (name: string, listener: () => void) => void }} options.eventSource
 * @param {{ SETTINGS_LOADED: string, SETTINGS_UPDATED: string, APP_READY: string }} options.eventTypes
 * @param {Pick<Storage, 'getItem' | 'setItem'>} options.accountStorage The settings shared by every browser of the account.
 * @param {Pick<Storage, 'getItem' | 'setItem'>} options.storage The storage of this browser, which the splash reads.
 * @param {() => unknown} options.readReducedMotion
 */
export function initSplashPreferences({ eventSource, eventTypes, accountStorage, storage, readReducedMotion }) {
    /** @type {SplashCharacter} */
    let character = parseSplashCharacter(readItem(storage, CHARACTER_STORAGE_KEY));
    let mirroredReducedMotion = readItem(storage, REDUCED_MOTION_STORAGE_KEY);
    /** @type {Array<(character: SplashCharacter) => void>} */
    const listeners = [];

    /** @param {SplashCharacter} next */
    function remember(next) {
        if (next === character) {
            return;
        }
        character = next;
        listeners.forEach(listener => listener(next));
    }

    /** @param {unknown} choice */
    function setCharacter(choice) {
        if (!isSplashCharacter(choice)) {
            throw new TypeError(`Unknown splash character: ${String(choice)}`);
        }
        writeItem(storage, CHARACTER_STORAGE_KEY, choice);
        writeItem(accountStorage, CHARACTER_ACCOUNT_KEY, choice);
        remember(choice);
    }

    // The account is shared by every browser, so it wins over what this browser held. That is how a new
    // browser shows the chosen character from its second start.
    function copyCharacterFromAccount() {
        const stored = readItem(accountStorage, CHARACTER_ACCOUNT_KEY);
        if (!isSplashCharacter(stored)) {
            return;
        }
        writeItem(storage, CHARACTER_STORAGE_KEY, stored);
        remember(stored);
    }

    function mirrorReducedMotion() {
        const reduced = readReducedMotion();
        if (typeof reduced !== 'boolean') {
            return;
        }
        const value = String(reduced);
        if (value === mirroredReducedMotion) {
            return;
        }
        if (writeItem(storage, REDUCED_MOTION_STORAGE_KEY, value)) {
            mirroredReducedMotion = value;
        }
    }

    function syncFromSettings() {
        copyCharacterFromAccount();
        mirrorReducedMotion();
    }

    eventSource.on(eventTypes.SETTINGS_LOADED, syncFromSettings);
    eventSource.on(eventTypes.APP_READY, syncFromSettings);
    eventSource.on(eventTypes.SETTINGS_UPDATED, mirrorReducedMotion);

    return {
        getCharacter: () => character,
        setCharacter,
        /** @param {(character: SplashCharacter) => void} listener */
        onCharacterChange: (listener) => { listeners.push(listener); },
    };
}
