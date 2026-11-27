/**
 * A stand-in for `navigator.locks` that several pages of one test share, the way tabs of one browser share the real one:
 * exclusive locks by name, granted in the order of the requests, `ifAvailable` and `signal` as the specification has them.
 */
export function createFakeLocks() {
    const queues = new Map();
    const held = new Set();

    function grantNext(name) {
        const queue = queues.get(name);
        if (held.has(name) || !queue?.length) {
            return;
        }
        const next = queue.shift();
        held.add(name);
        Promise.resolve()
            .then(() => next.callback({ name }))
            .then(next.resolve, next.reject)
            .finally(() => {
                held.delete(name);
                grantNext(name);
            });
    }

    return {
        held,
        request(name, optionsOrCallback, maybeCallback) {
            const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
            const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
            if (options.ifAvailable && held.has(name)) {
                return Promise.resolve(callback(null));
            }
            return new Promise((resolve, reject) => {
                const entry = { callback, resolve, reject };
                if (!queues.has(name)) {
                    queues.set(name, []);
                }
                queues.get(name).push(entry);
                options.signal?.addEventListener('abort', () => {
                    const queue = queues.get(name);
                    const index = queue.indexOf(entry);
                    if (index >= 0) {
                        queue.splice(index, 1);
                        reject(Object.assign(new Error('The lock request was aborted.'), { name: 'AbortError' }));
                    }
                }, { once: true });
                grantNext(name);
            });
        },
    };
}
