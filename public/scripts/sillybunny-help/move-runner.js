/**
 * Makes the function that runs the moves of the Help window. A move to a page waits for what the page needs to
 * load. A move that a later move has overtaken, or that outlives the window, never runs: its page would land
 * over the page the user asked for last, or over a window that is gone.
 * @template Target
 * @param {object} options
 * @param {() => boolean} options.isOpen Whether the window is open.
 * @param {(target: Target) => Promise<unknown> | null} options.load Starts the load of a page, or returns null when it has nothing to load.
 * @returns {(target: Target, move: () => void) => void}
 */
export function createMoveRunner({ isOpen, load }) {
    let latestMove = 0;
    return (target, move) => {
        const thisMove = ++latestMove;
        const loading = load(target);
        if (!loading) {
            move();
            return;
        }
        void loading.then(() => {
            if (thisMove === latestMove && isOpen()) {
                move();
            }
        });
    };
}
