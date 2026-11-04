import { createArtPanel } from './art-layout.js';
import { markCopyPlaceholder } from './copy.js';

function createLine(slot) {
    const line = markCopyPlaceholder(document.createElement('p'), slot);
    line.className = 'sbArtLine';
    return line;
}

/**
 * The opening of a window or a page: the art of a character, and the line that the character says. The art is a
 * panel beside the content of the window when there is room, and a banner above it when there is not. The art is
 * `aria-hidden`, so a screen reader reads the line alone.
 *
 * `intro` is a fragment: its two nodes become direct children of whatever it is appended to, because the panel sits
 * beside the whole body of the window and not beside the line. The window's own rules for its children keep working.
 *
 * `show` swaps the art and the line for another pair, for a window that follows a state. A swap that names the
 * art or the slot it already has leaves that element alone.
 * @param {object} options
 * @param {string} options.art Name of the art in the export spec.
 * @param {string} options.slot Copy slot of the line.
 * @returns {{ intro: DocumentFragment, panel: HTMLElement, show: (next: { art: string, slot: string }) => void }}
 */
export function createArtIntro({ art, slot }) {
    const { panel, setArts } = createArtPanel([art]);
    let lineNode = createLine(slot);
    const intro = document.createDocumentFragment();
    intro.append(panel, lineNode);

    function show(next) {
        setArts([next.art]);
        if (lineNode.dataset.sbCopySlot !== next.slot) {
            const replacement = createLine(next.slot);
            lineNode.replaceWith(replacement);
            lineNode = replacement;
        }
    }
    return { intro, panel, show };
}
