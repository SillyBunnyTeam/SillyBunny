/** The attribute of the document element that says where the API connection stands. A stylesheet reads it, so no panel has to listen. */
export const CONNECTION_ATTRIBUTE = 'data-sb-connection';

export const CONNECTION_STATES = Object.freeze({
    connecting: 'connecting',
    offline: 'offline',
    online: 'online',
});

/**
 * `online_status` is `no_connection` from the start of every boot until the saved connection answers, so the status alone
 * cannot tell a user who is offline from one whose check has not finished.
 * @param {object} input
 * @param {string | undefined} input.status The `online_status` of the app, or `undefined` before the app has set one.
 * @param {boolean} input.pending Whether a status check is in flight.
 * @returns {string | null} One of {@link CONNECTION_STATES}, or `null` while nothing is known.
 */
export function getConnectionState({ status, pending }) {
    if (pending) {
        return CONNECTION_STATES.connecting;
    }
    if (status === undefined) {
        return null;
    }
    return status === 'no_connection' ? CONNECTION_STATES.offline : CONNECTION_STATES.online;
}

/**
 * @param {() => HTMLElement} [getRoot] Read when a value is set, so this module needs no document when it loads.
 */
export function createConnectionReflection(getRoot = () => document.documentElement) {
    /** @type {string | undefined} */
    let status;
    let pending = false;

    function reflect() {
        const root = getRoot();
        const state = getConnectionState({ status, pending });
        if (state === null) {
            if (root.hasAttribute(CONNECTION_ATTRIBUTE)) {
                root.removeAttribute(CONNECTION_ATTRIBUTE);
            }
        } else if (root.getAttribute(CONNECTION_ATTRIBUTE) !== state) {
            root.setAttribute(CONNECTION_ATTRIBUTE, state);
        }
    }

    return {
        /** @param {string | undefined} value The `online_status` of the app. Call it on every set, not only on a change. */
        setStatus(value) {
            status = value;
            reflect();
        },
        /** @param {boolean} value Whether a status check is in flight. */
        setPending(value) {
            pending = Boolean(value);
            reflect();
        },
    };
}

const reflection = createConnectionReflection();

export const setConnectionStatus = reflection.setStatus;
export const setStatusCheckPending = reflection.setPending;
