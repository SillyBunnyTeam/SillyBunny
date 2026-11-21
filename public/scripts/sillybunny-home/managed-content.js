/**
 * What Home knows of the managed content of the server: which bundled files a user may Restore or Update, and the
 * requests that do it. The server decides what a file is (current, modified, deleted); this module only reads that
 * answer, so a response it does not understand offers nothing.
 */

/** The account storage key of the versions that the user kept their own card against, as `{ filename: version }`. */
export const DISMISSED_KEY = 'WelcomePage_ManagedDismissed';

const BASE_URL = '/api/sillybunny/managed-content';
const ITEM_TYPES = new Set(['character', 'sprites', 'world']);

/**
 * @typedef {object} ManagedItem One entry of the status that the server answers with.
 * @property {string} filename
 * @property {'character' | 'sprites' | 'world'} type
 * @property {number} version The version of the bundled file.
 * @property {string} status `current`, `updated`, `modified`, `deleted` or `not-installed`.
 * @property {boolean} updateAvailable Whether the server would offer the user an update of this file.
 *
 * @typedef {object} ManagedOffers What a card may offer for its bundled file.
 * @property {string | null} filename The bundled file the offers act on.
 * @property {boolean} restore Whether the bundled file is gone and can be put back.
 * @property {{ version: number } | null} update The newer bundled version, when the user's edited card can be updated to it.
 */

/** @type {Readonly<ManagedOffers>} */
export const NO_OFFERS = Object.freeze({ filename: null, restore: false, update: null });

/** A refused request. `code` is the code of the server, or null when the response had none. */
export class ManagedContentRequestError extends Error {
    /**
     * @param {string} action
     * @param {number} httpStatus
     * @param {string | null} code
     */
    constructor(action, httpStatus, code) {
        super(`Managed content ${action} was refused with ${httpStatus}${code ? ` (${code})` : ''}.`);
        this.name = 'ManagedContentRequestError';
        this.httpStatus = httpStatus;
        this.code = code;
    }
}

/**
 * @param {unknown} raw
 * @returns {ManagedItem[]} The entry as an array of one, or of none when it is not an entry of the status.
 */
function parseItem(raw) {
    if (raw === null || typeof raw !== 'object') {
        return [];
    }
    const { filename, type, version, status, updateAvailable } = /** @type {Record<string, unknown>} */ (raw);
    const valid = typeof filename === 'string' && filename.length > 0
        && typeof type === 'string' && ITEM_TYPES.has(type)
        && typeof version === 'number' && Number.isFinite(version)
        && typeof status === 'string';
    return valid ? [{ filename, type, version, status, updateAvailable: updateAvailable === true }] : [];
}

/**
 * @param {unknown} body The parsed response of the status route.
 * @returns {ManagedItem[]} The entries that make sense. A body that is not a status has none.
 */
export function parseManagedStatus(body) {
    const items = body !== null && typeof body === 'object' ? /** @type {{ items?: unknown }} */ (body).items : undefined;
    return Array.isArray(items) ? items.flatMap(parseItem) : [];
}

/**
 * @param {unknown} stored The account storage value: the JSON text, or null when nothing was stored.
 * @returns {Map<string, number>} The kept versions by filename. A value that is not a record of versions keeps none.
 */
export function parseDismissed(stored) {
    let record = null;
    try {
        record = typeof stored === 'string' ? JSON.parse(stored) : stored;
    } catch {
        return new Map();
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        return new Map();
    }
    return new Map(Object.entries(record).filter(([, version]) => typeof version === 'number' && Number.isFinite(version)));
}

/**
 * A kept version never goes down: keeping an older one later must not bring back a prompt for a newer one.
 * @param {Map<string, number>} dismissed
 * @param {string} filename
 * @param {number} version
 * @returns {Map<string, number>} A new map that also holds the kept version.
 */
export function withKeptVersion(dismissed, filename, version) {
    return new Map(dismissed).set(filename, Math.max(version, dismissed.get(filename) ?? 0));
}

/**
 * @param {Map<string, number>} dismissed
 * @returns {string}
 */
export function serializeDismissed(dismissed) {
    return JSON.stringify(Object.fromEntries(dismissed));
}

/**
 * What a card offers. Only a character card has offers: a sprite set or a world the user changed is left alone, and
 * Home shows nothing for it. A status that is not known offers nothing either.
 *
 * A card that has no file is restored when the server reports the bundled file as deleted, whether the user deleted
 * the card in SillyBunny or the file went away outside it. The server answers `deleted` for any file that was
 * installed once and is gone, so the card state does not need to tell the two apart.
 * @param {object} options
 * @param {string} options.filename The bundled file of the card.
 * @param {import('./assistant-cards.js').AssistantCardState} options.cardState
 * @param {ManagedItem[] | null} options.items The status, or null while it is not known.
 * @param {Map<string, number>} options.dismissed
 * @returns {ManagedOffers}
 */
export function findOffers({ filename, cardState, items, dismissed }) {
    const item = items?.find(candidate => candidate.type === 'character' && candidate.filename === filename);
    if (!item) {
        return NO_OFFERS;
    }
    if (cardState !== 'available') {
        return item.status === 'deleted' ? { filename, restore: true, update: null } : NO_OFFERS;
    }
    // An edited card is only ever offered an update to a version it has not been told about and has not kept itself against.
    const wanted = item.status === 'modified' && item.updateAvailable && item.version > (dismissed.get(filename) ?? 0);
    return wanted ? { filename, restore: false, update: { version: item.version } } : NO_OFFERS;
}

/**
 * What a status can make Home offer, in a form that two statuses share when they offer the same. A status that is not
 * known, one with no entries and one whose files all need nothing give the same answer, and so do two statuses that
 * differ only in a file that Home never acts on, such as a sprite folder. Home uses this to tell whether the cards it
 * made are still right, so a change that shows nothing does not make them again.
 * @param {ManagedItem[] | null} items
 * @returns {Array<[string, number | null, boolean]>} Per file that can be offered: its name, the version that an update
 *   would be to, and whether it can be restored.
 */
export function describeOffers(items) {
    const offerFor = (item, cardState) => findOffers({ filename: item.filename, cardState, items: [item], dismissed: new Map() });
    return (items ?? [])
        .map(item => [item.filename, offerFor(item, 'available').update?.version ?? null, offerFor(item, 'missing').restore])
        .filter(([, version, restorable]) => version !== null || restorable);
}

/**
 * @param {object} options
 * @param {typeof fetch} options.fetch
 * @param {() => Record<string, string>} options.getHeaders The headers of a request to the server, with its token.
 */
export function createManagedContentClient({ fetch: send, getHeaders }) {
    async function call(action, init) {
        const response = await send(`${BASE_URL}/${action}`, { ...init, headers: getHeaders() });
        if (!response.ok) {
            const body = await response.json().catch(() => null);
            throw new ManagedContentRequestError(action, response.status, typeof body?.error === 'string' ? body.error : null);
        }
        return response.json();
    }

    const post = (action, filename) => call(action, { method: 'POST', body: JSON.stringify({ filename }) });

    return {
        /**
         * @param {{ signal?: AbortSignal }} [options]
         * @returns {Promise<ManagedItem[]>}
         */
        async loadStatus({ signal } = {}) {
            return parseManagedStatus(await call('status', { method: 'GET', signal }));
        },
        /** Updates the card and keeps the user's file as a backup. */
        apply: filename => post('apply', filename),
        /** Puts the bundled file back. */
        restore: filename => post('restore', filename),
    };
}
