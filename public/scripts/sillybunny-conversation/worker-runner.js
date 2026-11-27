/**
 * Runs the automatic worker's tick on an interval, in the one tab that leads (`worker-lock.js`), and never two ticks at
 * once. A tick can take minutes (it waits for a model), and an interval that fires again meanwhile would start a second
 * tick that sends the same message to the same chat before the first one has written its marker.
 *
 * Everything that belongs to the page comes in through the parameters, so that tests fire the interval by hand.
 */

/** A tick that has run for longer than this is taken to be stuck, so that one lost request cannot stop the worker for good. */
export const DEFAULT_MAX_TICK_MS = 10 * 60 * 1000;

/**
 * @param {object} parts
 * @param {{ start: () => void, stop: () => void, suspend: () => void, resume: () => void, isLeader: () => boolean }} parts.lock
 * @param {(options: { signal: AbortSignal }) => Promise<unknown>} parts.tick
 * @param {number} parts.intervalMs
 * @param {(callback: () => void, delay: number) => any} [parts.schedule]
 * @param {(timer: any) => void} [parts.cancel]
 * @param {() => number} [parts.now]
 * @param {number} [parts.maxTickMs]
 * @param {Pick<Window, 'addEventListener'|'removeEventListener'>|null} [parts.windowTarget] Gets `pagehide` and `pageshow`.
 * @param {Pick<Document, 'addEventListener'|'removeEventListener'>|null} [parts.documentTarget] Gets the Page Lifecycle events `freeze` and `resume`.
 */
export function createWorkerRunner({
    lock,
    tick,
    intervalMs,
    schedule = (callback, delay) => setInterval(callback, delay),
    cancel = timer => clearInterval(timer),
    now = () => Date.now(),
    maxTickMs = DEFAULT_MAX_TICK_MS,
    windowTarget = null,
    documentTarget = null,
}) {
    let timer = null;
    let controller = null;
    let runningSince = 0;
    let running = false;
    let tickCount = 0;
    /** @type {(() => void)[]} */
    let removeListeners = [];

    async function runTick() {
        if (!lock.isLeader()) {
            return;
        }
        if (running && now() - runningSince < maxTickMs) {
            return;
        }
        running = true;
        runningSince = now();
        const thisTick = ++tickCount;
        const signal = controller.signal;
        try {
            await tick({ signal });
        } catch (error) {
            console.warn('Conversation Mode: a tick of the automatic worker failed', error);
        } finally {
            // A tick that was declared stuck may end after a newer one began; only the newest one clears the flag.
            if (thisTick === tickCount) {
                running = false;
            }
        }
    }

    function listen(target, type, handler) {
        target?.addEventListener(type, handler);
        return () => target?.removeEventListener(type, handler);
    }

    return Object.freeze({
        start() {
            if (timer !== null) {
                return;
            }
            controller = new AbortController();
            lock.start();
            timer = schedule(() => void runTick(), intervalMs);
            // A page that is hidden for good (not the back-forward cache) or frozen must not keep the lock, or no other tab could lead.
            removeListeners = [
                listen(windowTarget, 'pagehide', () => lock.suspend()),
                listen(windowTarget, 'pageshow', () => lock.resume()),
                listen(documentTarget, 'freeze', () => lock.suspend()),
                listen(documentTarget, 'resume', () => lock.resume()),
            ];
        },
        stop() {
            if (timer === null) {
                return;
            }
            cancel(timer);
            timer = null;
            removeListeners.forEach(remove => remove());
            removeListeners = [];
            controller?.abort();
            controller = null;
            lock.stop();
            running = false;
        },
    });
}
