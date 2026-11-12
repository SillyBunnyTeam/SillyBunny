/** @type {(() => void) | null} */
let endCurrent = null;

/**
 * Ties what a mounted Home panel keeps alive outside itself (observers, `document` listeners, subscriptions) to the
 * panel. The lifetime ends when the panel is removed from `#chat` or when the next panel begins its lifetime, and
 * never because of the Home state. Only one Home panel exists at a time.
 * @param {HTMLElement} panel The `.welcomePanel` root. It may not be in `#chat` yet.
 * @returns {{ keep: (name: string, stop: () => void) => void }} `keep` holds a stop under a name. Keeping a name again
 *   runs the stop it held before. Keeping one after the lifetime ended runs it at once.
 */
export function beginPanelLifetime(panel) {
    endCurrent?.();

    /** @type {Map<string, () => void>} */
    const stops = new Map();
    let ended = false;
    const host = document.getElementById('chat');

    // Removal is judged by the records and not by `isConnected` alone, because a panel that is not in the chat yet is
    // not connected either.
    const watcher = host
        ? new MutationObserver((records) => {
            const removed = records.some(record => Array.prototype.includes.call(record.removedNodes, panel));
            if (removed && !panel.isConnected) {
                end();
            }
        })
        : null;
    watcher?.observe(host, { childList: true });

    function run(stop) {
        try {
            stop();
        } catch (error) {
            console.error('A stop of the Home panel failed.', error);
        }
    }

    function end() {
        if (ended) {
            return;
        }
        ended = true;
        watcher?.disconnect();
        const pending = [...stops.values()];
        stops.clear();
        pending.forEach(run);
        if (endCurrent === end) {
            endCurrent = null;
        }
    }

    endCurrent = end;
    return {
        keep(name, stop) {
            const previous = stops.get(name);
            stops.delete(name);
            if (previous) {
                run(previous);
            }
            if (ended) {
                run(stop);
                return;
            }
            stops.set(name, stop);
        },
    };
}
