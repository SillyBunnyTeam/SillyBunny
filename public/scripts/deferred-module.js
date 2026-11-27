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

/**
 * A controller that a lazily imported module builds from the shell's dependencies. `load()` imports the module
 * through createDeferredModule, so a failed import is retried on a new URL, and builds the controller once.
 * `current` is the controller after it has been built and null before, for code that may use it only when it is there.
 * @template T
 * @param {URL} url
 * @param {(module: any) => T} create Builds the controller from the loaded module.
 * @param {(specifier: string) => Promise<object>} [importModule]
 * @returns {{ readonly current: T|null, load: () => Promise<T> }}
 */
export function createLazyController(url, create, importModule) {
    const loadModule = createDeferredModule(url, importModule);
    let controller = null;
    let pending = null;

    return {
        get current() {
            return controller;
        },
        load() {
            pending ??= loadModule()
                .then(module => {
                    controller = create(module);
                    return controller;
                })
                .catch(error => {
                    pending = null;
                    throw error;
                });
            return pending;
        },
    };
}
