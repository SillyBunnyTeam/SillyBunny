/**
 * The four `performance` marks of a start. Two classic scripts make the first ones before any module loads
 * (`sillybunny-splash.js` and `sillybunny-boot-guard.js`), `script.js` makes the init mark, and this module makes the
 * last one. The module has no imports, so the performance script of the repository can load it too.
 */
export const BOOT_MARK_NAMES = Object.freeze(['sb-boot-inline', 'sb-boot-init-start', 'sb-boot-dismiss', 'sb-app-ready']);

/**
 * The marks of this start that were made, in boot order. A mark that was not made is left out.
 * @param {Pick<Performance, 'getEntriesByName'> | undefined} [performanceLike]
 * @returns {{ name: string, startTime: number }[]}
 */
export function readBootMarks(performanceLike = globalThis.performance) {
    if (typeof performanceLike?.getEntriesByName !== 'function') {
        return [];
    }
    return BOOT_MARK_NAMES.flatMap((name) => {
        const [first] = performanceLike.getEntriesByName(name);
        return first ? [{ name, startTime: first.startTime }] : [];
    });
}

/**
 * Makes the `sb-app-ready` mark when the app is ready.
 * @param {object} options
 * @param {{ on: (name: string, listener: () => void) => void }} options.eventSource
 * @param {{ APP_READY: string }} options.eventTypes
 * @param {Pick<Performance, 'mark'> | undefined} [options.performanceLike]
 */
export function initBootMarks({ eventSource, eventTypes, performanceLike = globalThis.performance }) {
    let marked = false;
    eventSource.on(eventTypes.APP_READY, () => {
        if (marked || typeof performanceLike?.mark !== 'function') {
            return;
        }
        marked = true;
        performanceLike.mark('sb-app-ready');
    });
}
