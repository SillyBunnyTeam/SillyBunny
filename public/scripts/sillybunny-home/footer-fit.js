const CARD_SELECTOR = '.sbHomeCard';
const FOOTER_SELECTOR = '.sbHomeCardFooter';
const COMPACT = 'data-sb-footer-compact';
const MEASURING = 'data-sb-footer-measure';

/** @type {(() => void) | null} */
let stopPrevious = null;

/**
 * Whether the buttons need more room than the footer's content box has. `scrollWidth` cannot tell: buttons that
 * spill into the end padding leave it equal to `clientWidth`, yet the flex shrink works on the content box and
 * cuts the labels. The widths are fractional, so a spare pixel keeps a fit from being a coin toss.
 * @param {HTMLElement} footer
 */
function needsMoreRoom(footer) {
    const style = getComputedStyle(footer);
    const room = footer.getBoundingClientRect().width
        - (Number.parseFloat(style.paddingInlineStart) || 0)
        - (Number.parseFloat(style.paddingInlineEnd) || 0);
    const boxes = [...footer.children].map(child => child.getBoundingClientRect());
    const span = Math.max(...boxes.map(box => box.right)) - Math.min(...boxes.map(box => box.left));
    return span + 1 > room;
}

/**
 * Hides both footer labels on every card whose footer cannot hold them. How wide the labels are depends on the
 * font size and on the translation, so a width breakpoint cannot decide it. Cards without a box, such as those
 * in a hidden display mode, keep their last state until they show again.
 * @param {HTMLElement[]} cards
 */
export function updateFooterLabels(cards) {
    const visible = cards.filter(card => card.getClientRects().length > 0);
    for (const card of visible) {
        card.setAttribute(MEASURING, '');
        card.removeAttribute(COMPACT);
    }
    // Every read happens before any write is undone, so the browser lays out once for all cards.
    const overflows = visible.map(card => needsMoreRoom(card.querySelector(FOOTER_SELECTOR)));
    visible.forEach((card, index) => {
        card.toggleAttribute(COMPACT, overflows[index]);
        card.removeAttribute(MEASURING);
    });
}

/**
 * Keeps the footer labels of the cards in a Home panel in step with the room they have. Only one Home panel
 * exists at a time, so the observer of the previous panel is stopped here; it would keep that panel alive.
 * @param {HTMLElement} panel
 */
export function fitCardFooters(panel) {
    stopPrevious?.();
    stopPrevious = null;
    const cards = [...panel.querySelectorAll(CARD_SELECTOR)].filter(card => card.querySelector(FOOTER_SELECTOR));
    if (cards.length === 0) {
        return;
    }

    let stopped = false;
    let queued = false;
    // The write changes the card, and a resize observed inside its own callback raises a loop error. A frame
    // of its own also merges a burst of resizes into one measure.
    const schedule = () => {
        if (stopped || queued) {
            return;
        }
        queued = true;
        requestAnimationFrame(() => {
            queued = false;
            if (!stopped) {
                updateFooterLabels(cards);
            }
        });
    };

    const observer = new ResizeObserver(schedule);
    cards.forEach(card => observer.observe(card));
    // A web font that arrives late changes the label widths without resizing the card.
    document.fonts?.ready.then(schedule);
    document.fonts?.addEventListener?.('loadingdone', schedule);
    schedule();

    stopPrevious = () => {
        stopped = true;
        observer.disconnect();
        document.fonts?.removeEventListener?.('loadingdone', schedule);
    };
}
