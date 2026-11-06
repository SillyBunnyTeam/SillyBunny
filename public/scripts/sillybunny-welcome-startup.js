export const SHOW_AT_STARTUP_KEY = 'WelcomePage_ShowAtStartup';
export const SEEN_VERSION_KEY = 'WelcomePage_WelcomeSeenVersion';
/** In localStorage, not the account: an import replaces the account settings, and the browser keeps the marker across the reload. */
export const IMPORT_PENDING_KEY = 'sb-welcome-import-pending';

/**
 * @typedef {{ getItem: (key: string) => string | null, setItem: (key: string, value: string) => void }} ReadWriteStore
 * @typedef {ReadWriteStore & { removeItem: (key: string) => void }} RemovableStore
 * @typedef {{ open: true, reason: 'first-run' | 'show-at-startup' | 'new-to-welcome' }
 *     | { open: false, reason: 'import' | 'not-needed' | 'decided' }} WelcomeStartupPlan
 */

/**
 * Decides when the Welcome dialog opens on its own, and keeps what that decision rests on in the account:
 * whether the user wants it at every startup, and which version of the app showed it last.
 *
 * It decides once per boot. The first run decides before the app is ready, in place of the onboarding popup, and the
 * decision at APP_READY must then find that Welcome has been handled.
 * @param {object} deps
 * @param {ReadWriteStore} deps.account The account storage.
 * @param {RemovableStore} deps.local The browser storage that holds the import marker.
 * @param {string} deps.version The version of the app that shows Welcome.
 */
export function createWelcomeStartup({ account, local, version }) {
    let decided = false;

    const recordSeen = () => account.setItem(SEEN_VERSION_KEY, version);

    return {
        /**
         * @param {{ firstRun: boolean }} boot
         * @returns {WelcomeStartupPlan}
         */
        decide({ firstRun }) {
            if (decided) {
                return { open: false, reason: 'decided' };
            }
            decided = true;
            // An import marker means the imported account counts as already onboarded, so it neither opens Welcome
            // nor asks for a persona, even when the imported files say firstRun or Show at Startup.
            if (local.getItem(IMPORT_PENDING_KEY) !== null) {
                recordSeen();
                account.setItem(SHOW_AT_STARTUP_KEY, 'false');
                local.removeItem(IMPORT_PENDING_KEY);
                return { open: false, reason: 'import' };
            }
            if (firstRun) {
                return { open: true, reason: 'first-run' };
            }
            if (account.getItem(SHOW_AT_STARTUP_KEY) === 'true') {
                recordSeen();
                return { open: true, reason: 'show-at-startup' };
            }
            if (account.getItem(SEEN_VERSION_KEY) === null) {
                recordSeen();
                account.setItem(SHOW_AT_STARTUP_KEY, 'false');
                return { open: true, reason: 'new-to-welcome' };
            }
            return { open: false, reason: 'not-needed' };
        },

        /** A first run ends once the persona has a name. From then on Welcome shows at every startup until the user turns it off. */
        completeFirstRun() {
            account.setItem(SHOW_AT_STARTUP_KEY, 'true');
            recordSeen();
        },

        /** Called before an import request. The boot after the import consumes it in `decide`. */
        markImportPending() {
            local.setItem(IMPORT_PENDING_KEY, '1');
        },

        /** Called when the import request failed. The page stays open, so no reload would consume the marker and an unrelated later boot would be mistaken for the import. */
        clearImportPending() {
            local.removeItem(IMPORT_PENDING_KEY);
        },

        isShownAtStartup() {
            return account.getItem(SHOW_AT_STARTUP_KEY) === 'true';
        },

        /** @param {boolean} shown */
        setShownAtStartup(shown) {
            account.setItem(SHOW_AT_STARTUP_KEY, shown ? 'true' : 'false');
        },
    };
}
