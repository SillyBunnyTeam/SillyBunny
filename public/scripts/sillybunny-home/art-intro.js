import { createArtPlaceholder } from './art.js';
import { markCopyPlaceholder } from './copy.js';

/**
 * The opening of a window or a page: the art of a character at the inline start, at its own size, and the line
 * that the character says beside it. The pair stacks, with the text below the art, when the text column gets too
 * narrow; the rule is `.sbArtIntro` in `css/sillybunny-windows.css`. The art is `aria-hidden`, so a screen reader
 * reads the line alone.
 *
 * `show` swaps the art and the line for another pair, for a window that follows a state. A swap that names the
 * art or the slot it already has leaves that element alone.
 * @param {object} options
 * @param {string} options.art Name of the art placeholder, which is its size key.
 * @param {string} options.slot Copy slot of the line.
 * @returns {{ intro: HTMLElement, show: (next: { art: string, slot: string }) => void }}
 */
export function createArtIntro({ art, slot }) {
    const intro = document.createElement('div');
    intro.className = 'sbArtIntro';
    let artNode = createArtPlaceholder(art);
    let lineNode = markCopyPlaceholder(document.createElement('p'), slot);
    intro.append(artNode, lineNode);

    function show(next) {
        if (artNode.dataset.sbArtPlaceholder !== next.art) {
            const replacement = createArtPlaceholder(next.art);
            artNode.replaceWith(replacement);
            artNode = replacement;
        }
        if (lineNode.dataset.sbCopySlot !== next.slot) {
            const replacement = markCopyPlaceholder(document.createElement('p'), next.slot);
            lineNode.replaceWith(replacement);
            lineNode = replacement;
        }
    }
    return { intro, show };
}
