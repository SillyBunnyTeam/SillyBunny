import { displayVersion } from '../../script.js';
import { eventSource, event_types } from '../events.js';
import { accountStorage } from '../util/AccountStorage.js';
import { createWelcomeStartup } from '../sillybunny-welcome-startup.js';
import { showWelcome } from './windows.js';

/** @type {ReturnType<typeof createWelcomeStartup> | null} */
let startup = null;

/** localStorage can throw when the browser blocks it. Welcome then behaves as if the marker were absent. */
const markerStore = {
    getItem: key => { try { return localStorage.getItem(key); } catch { return null; } },
    setItem: (key, value) => { try { localStorage.setItem(key, value); } catch { /* the marker only suppresses Welcome after an import */ } },
    removeItem: key => { try { localStorage.removeItem(key); } catch { /* see setItem */ } },
};

/**
 * The one decision of this boot. The first run asks it before the app is ready, and APP_READY asks it for every
 * other boot, so both must reach the same instance. It is built on first use, because the account storage and the
 * version are not ready when this module loads.
 */
export function getWelcomeStartup() {
    startup ??= createWelcomeStartup({ account: accountStorage, local: markerStore, version: displayVersion });
    return startup;
}

/**
 * Opens Welcome after APP_READY when the account asks for it. A first run has been handled by then, in place of the
 * onboarding popup, and the decision says so.
 */
eventSource.on(event_types.APP_READY, () => {
    if (getWelcomeStartup().decide({ firstRun: false }).open) {
        showWelcome();
    }
});
