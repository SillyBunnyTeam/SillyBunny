/**
 * Runs asynchronous tasks one after another, in the order they were added. A task that fails does not stop the ones
 * behind it; its error goes to the caller that added it.
 * @returns {{ run: <T>(task: () => Promise<T>) => Promise<T>, idle: () => Promise<void>, readonly size: number }}
 */
export function createSerialQueue() {
    let tail = Promise.resolve();
    let size = 0;
    return {
        run(task) {
            size++;
            const result = tail.then(task);
            tail = result.then(() => {}, () => {}).then(() => {
                size--;
            });
            return result;
        },
        idle() {
            return tail;
        },
        get size() {
            return size;
        },
    };
}
