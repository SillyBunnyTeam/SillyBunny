/**
 * Shares successful imports and in-flight requests. A new URL after failure lets
 * an explicit retry bypass the browser's cached module-load rejection.
 * @param {URL} url
 * @param {(specifier: string) => Promise<object>} importModule
 * @returns {() => Promise<object>}
 */
export function createDeferredModule(url, importModule = specifier => import(specifier)) {
    let pending;
    let failures = 0;

    return () => {
        if (!pending) {
            const specifier = new URL(url);
            if (failures) specifier.searchParams.set('sb-retry', String(failures));
            pending = Promise.resolve().then(() => importModule(specifier.href)).catch(error => {
                pending = undefined;
                failures += 1;
                throw error;
            });
        }
        return pending;
    };
}
