import { confirmActiveEditorLeave } from './navigation.js';

/**
 * @typedef {object} Location
 * @property {string} kind
 * @property {string|null} [id]
 * @property {string|null} [section]
 * @property {string} [via]
 */

/**
 * @typedef {object} Destination
 * @property {(location: Location, options: { restore?: object|null, isCurrent: () => boolean }) => Promise<boolean>} open
 * @property {(id?: string|null) => boolean} [exists]
 * @property {() => Location|null} [current]
 * @property {() => object|null} [captureState]
 */

/**
 * @typedef {object} Result
 * @property {boolean} ok
 * @property {'cancelled'|'missing'|'failed'|'superseded'|'empty'} [reason]
 */

/**
 * @typedef {object} ObjectNavigation
 * @property {(kind: string, destination: Destination) => () => void} register
 * @property {(target: Location, options: { from: Location|(() => Location) }) => Promise<Result>} navigate
 * @property {(options: { current: Location, fallback: () => Promise<void>|void }) => Promise<Result>} back
 * @property {(current: Location) => boolean} canGoBack
 * @property {() => void} clear
 * @property {(notify: (reason: 'missing'|'failed', target: Location) => void) => void} setNotify
 * @property {number} depth
 * @property {boolean} isRouting
 * @property {(selector: string) => () => void} bindTopLevelClear
 */

/**
 * Creates awaited object navigation with a bounded origin stack.
 * @param {object} deps
 * @param {() => Promise<boolean>} deps.confirmLeave
 * @param {(reason: 'missing'|'failed', target: Location) => void} [deps.notify]
 * @param {number} [deps.maxDepth=8]
 * @returns {ObjectNavigation}
 */
export function createObjectNavigation({ confirmLeave, notify = () => {}, maxDepth = 8 }) {
    if (typeof confirmLeave !== 'function') throw new TypeError('confirmLeave must be a function.');
    if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new RangeError('maxDepth must be a non-negative integer.');

    const registry = new Map();
    const stack = [];
    let revision = 0;
    let routing = false;

    const matches = (left, right) => left.kind === right.kind && left.id === right.id;
    const canGoBack = current => stack.length > 0 && matches(stack[stack.length - 1].target, current);

    function register(kind, destination) {
        if (typeof kind !== 'string' || !kind || typeof destination?.open !== 'function') {
            throw new TypeError('register requires a kind and a destination with an open function.');
        }
        const registration = { destination };
        registry.set(kind, registration);
        return () => {
            if (registry.get(kind) === registration) registry.delete(kind);
        };
    }

    /**
     * @param {Location} target
     * @param {object} [options]
     * @param {Location|(() => Location)} [options.from]
     * @param {object|null} [options.restore]
     * @param {{ origin: Location & { state: object|null }, target: Location }} [options.entry]
     * @param {() => Promise<void>|void} [options.fallback]
     * @returns {Promise<Result>}
     */
    async function route(target, { from, restore = null, entry, fallback } = {}) {
        const token = ++revision;
        const isCurrent = () => token === revision;
        routing = true;
        try {
            const approved = await confirmLeave();
            if (token !== revision) return { ok: false, reason: 'superseded' };
            if (!approved) return { ok: false, reason: 'cancelled' };

            const destination = registry.get(target.kind)?.destination;
            if (!destination || destination.exists?.(target.id) === false) {
                notify('missing', target);
                if (entry) {
                    stack.pop();
                    await fallback();
                    if (token !== revision) return { ok: false, reason: 'superseded' };
                }
                return { ok: false, reason: 'missing' };
            }

            const origin = typeof from === 'function' ? { ...from() } : from;
            const state = origin ? registry.get(origin.kind)?.destination.captureState?.() ?? null : null;
            const opened = await destination.open(target, { restore, isCurrent });
            if (token !== revision) return { ok: false, reason: 'superseded' };
            if (!opened) {
                notify('failed', target);
                return { ok: false, reason: 'failed' };
            }

            if (entry) {
                stack.pop();
            } else {
                stack.push({ origin: { ...origin, state }, target: { ...target } });
                if (stack.length > maxDepth) stack.splice(0, stack.length - maxDepth);
            }
            return { ok: true };
        } catch (error) {
            console.error('Object navigation failed', error);
            if (token !== revision) return { ok: false, reason: 'superseded' };
            notify('failed', target);
            return { ok: false, reason: 'failed' };
        } finally {
            if (token === revision) routing = false;
        }
    }

    function navigate(target, { from }) {
        return route({ ...target }, { from: typeof from === 'function' ? from : { ...from } });
    }

    /** @returns {Promise<Result>} */
    async function back({ current, fallback }) {
        if (!canGoBack(current)) {
            clear();
            await fallback();
            return { ok: false, reason: 'empty' };
        }
        const entry = stack[stack.length - 1];
        const { state, ...origin } = entry.origin;
        return route(origin, { restore: state, entry, fallback });
    }

    function clear() {
        revision++;
        routing = false;
        stack.length = 0;
    }

    /**
     * Replaces the notification handler without replacing the navigation singleton.
     * @param {(reason: 'missing'|'failed', target: Location) => void} handler
     */
    function setNotify(handler) {
        if (typeof handler !== 'function') throw new TypeError('setNotify requires a function.');
        notify = handler;
    }

    function bindTopLevelClear(selector) {
        const onClick = event => {
            if (routing || !(event.target instanceof Element) || !event.target.closest(selector)) return;
            clear();
        };
        document.addEventListener('click', onClick);
        return () => document.removeEventListener('click', onClick);
    }

    return {
        register,
        navigate,
        back,
        canGoBack,
        clear,
        setNotify,
        get depth() { return stack.length; },
        get isRouting() { return routing; },
        bindTopLevelClear,
    };
}

/** Default instance wired to the active editor guard with no-op notifications. */
export const objectNavigation = createObjectNavigation({ confirmLeave: confirmActiveEditorLeave });
