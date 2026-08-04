export const DEFAULT_THROTTLE_MS = 4000;

const SEVERITIES = ["success", "info", "warning", "error"];

/**
 * Wraps SillyTavern's global `toastr` so notifications have one guard, one
 * escaping policy, and one place to suppress repeats.
 *
 * `toastr` is a bare global supplied by SillyTavern, not an import. Reading an
 * undeclared binding throws a ReferenceError, and optional chaining does not
 * help — `toastr?.warning?.()` still throws when `toastr` was never declared.
 * The reader passed in here does that check with `typeof` once, so call sites
 * do not have to.
 *
 * The call signature deliberately mirrors toastr's own
 * `(message, title, options)` so migrating existing sites is a rename rather
 * than a rewrite. Two extra options are understood and stripped before the
 * call reaches toastr:
 *
 *   throttleKey  suppress repeats of this key inside `throttleMs`
 *   logMessage   also send the text to the QIG log, even when the toast is suppressed
 *
 * `escapeHtml` defaults to true. Toast bodies routinely carry provider error
 * text and user-typed names, and toastr renders HTML unless told otherwise.
 */
export function createNotifier({
    getToastr = null,
    log = null,
    now = () => Date.now(),
    throttleMs = DEFAULT_THROTTLE_MS,
} = {}) {
    const lastShownAt = new Map();

    function resolveToastr() {
        if (typeof getToastr !== "function") return null;
        try {
            const candidate = getToastr();
            return candidate && typeof candidate === "object" ? candidate : null;
        } catch {
            // A throwing accessor means the global is not usable; stay silent rather
            // than turning a notification into a crash.
            return null;
        }
    }

    function record(message) {
        if (typeof log === "function") log(message);
    }

    function withinThrottle(key, windowMs) {
        if (!key) return false;
        const at = now();
        const previous = lastShownAt.get(key);
        if (previous != null && at - previous < windowMs) return true;
        lastShownAt.set(key, at);
        return false;
    }

    /**
     * @param {"success"|"info"|"warning"|"error"} severity
     * @param {string} message
     * @param {string} [title]
     * @param {object} [options] toastr options, plus `throttleKey` / `logMessage` / `throttleMs`
     * @returns {boolean} whether a toast was actually shown
     */
    function notify(severity, message, title = "", options = {}) {
        const {
            throttleKey = "",
            throttleMs: windowMs = throttleMs,
            logMessage = false,
            ...toastrOptions
        } = options || {};

        const text = message == null ? "" : String(message);
        if (logMessage) record(text);
        if (!SEVERITIES.includes(severity)) return false;
        if (withinThrottle(throttleKey, windowMs)) return false;

        const target = resolveToastr();
        const emit = target?.[severity];
        if (typeof emit !== "function") return false;
        try {
            emit.call(target, text, title ?? "", { escapeHtml: true, ...toastrOptions });
            return true;
        } catch (error) {
            record(`Notification failed: ${error?.message || error}`);
            return false;
        }
    }

    const success = (message, title, options) => notify("success", message, title, options);
    const info = (message, title, options) => notify("info", message, title, options);
    const warning = (message, title, options) => notify("warning", message, title, options);
    const error = (message, title, options) => notify("error", message, title, options);

    /**
     * Emits at most one toast per key inside the throttle window. Use this inside
     * loops and retry paths, where the same failure would otherwise stack one
     * toast per iteration.
     */
    function notifyOnce(key, severity, message, title = "", options = {}) {
        return notify(severity, message, title, { ...options, throttleKey: key || String(message ?? "") });
    }

    /** Drops throttle history so a new user-initiated run can notify again. */
    function reset() {
        lastShownAt.clear();
    }

    return { notify, notifyOnce, success, info, warning, error, reset, isAvailable: () => Boolean(resolveToastr()) };
}
