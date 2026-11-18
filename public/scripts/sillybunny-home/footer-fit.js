const CARD_SELECTOR = '.sbHomeCard';
const FOOTER_SELECTOR = '.sbHomeCardFooter';
const COMPACT = 'data-sb-footer-compact';
const MEASURING = 'data-sb-footer-measure';
const LABEL_SELECTOR = '.sbHomeFootLabel';
const CARD_NEED = '--sb-home-card-need';

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

const pixels = value => Number.parseFloat(value) || 0;

/**
 * The card width at which the stacked footer shows its longest label whole beside the menu button. Every part comes from
 * computed style, so a change to the padding or the gap in the sheet needs no change here. The labels are read in their
 * natural width, so the result does not depend on the card's own width and cannot feed back into the layout it sets.
 * @param {HTMLElement} card A card whose footer is stacked and measuring.
 * @returns {number} Zero for a footer with no labelled button.
 */
function stackedCardNeed(card) {
    const footer = card.querySelector(FOOTER_SELECTOR);
    const footerStyle = getComputedStyle(footer);
    const cardStyle = getComputedStyle(card);
    const widest = [...footer.querySelectorAll(LABEL_SELECTOR)].map((label) => {
        const style = getComputedStyle(label.parentElement);
        return Math.ceil(label.scrollWidth) + pixels(style.paddingInlineStart) + pixels(style.paddingInlineEnd)
            + pixels(style.borderInlineStartWidth) + pixels(style.borderInlineEndWidth);
    });
    if (widest.length === 0) {
        return 0;
    }
    const beside = [...footer.children]
        .filter(child => !child.querySelector(LABEL_SELECTOR))
        .reduce((sum, child) => sum + child.getBoundingClientRect().width + pixels(footerStyle.columnGap), 0);
    // The footer spans the card's padding box, so the card's own borders come on top. A spare pixel keeps a fractional width from being a coin toss.
    return Math.max(...widest) + beside + pixels(footerStyle.paddingInlineStart) + pixels(footerStyle.paddingInlineEnd)
        + pixels(cardStyle.borderInlineStartWidth) + pixels(cardStyle.borderInlineEndWidth) + 1;
}

/**
 * Stacks the footer buttons on every card whose footer cannot hold them in one row. How wide the labels are depends on the
 * font size and on the translation, so a width breakpoint cannot decide it. Cards without a box, such as those
 * in a hidden display mode, keep their last state until they show again. The widest stacked footer of a grid also sets
 * `--sb-home-card-need` on it, so the grid drops a column when its cards would be too narrow for a whole label.
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
    visible.forEach(card => card.setAttribute(COMPACT, ''));
    const needs = visible.map(stackedCardNeed);
    const grids = new Map();
    visible.forEach((card, index) => {
        card.toggleAttribute(COMPACT, overflows[index]);
        card.removeAttribute(MEASURING);
        const grid = card.parentElement;
        if (grid && needs[index] > 0) {
            grids.set(grid, Math.max(grids.get(grid) ?? 0, needs[index]));
        }
    });
    grids.forEach((need, grid) => grid.style.setProperty(CARD_NEED, `${need}px`));
}

/**
 * Keeps the footer labels of the cards in a Home panel in step with the room they have. The observer and the font
 * listener keep the panel alive, so the caller has to run the returned stop when it drops the panel.
 * @param {HTMLElement} panel
 * @returns {() => void} Stops the fit.
 */
export function fitCardFooters(panel) {
    const cards = [...panel.querySelectorAll(CARD_SELECTOR)].filter(card => card.querySelector(FOOTER_SELECTOR));
    if (cards.length === 0) {
        return () => {};
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

    return () => {
        stopped = true;
        observer.disconnect();
        document.fonts?.removeEventListener?.('loadingdone', schedule);
    };
}
