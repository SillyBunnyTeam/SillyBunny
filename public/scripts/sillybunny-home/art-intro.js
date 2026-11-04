import { createArtPanel } from './art-layout.js';
import { markCopyPlaceholder } from './copy.js';

/** A written line is a plain paragraph; a line that is not written yet is the placeholder of its slot. */
function createLine({ slot, text }) {
    const line = document.createElement('p');
    if (text === undefined) {
        markCopyPlaceholder(line, slot);
    } else {
        line.textContent = text;
    }
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
 * art, and the text or the slot, that it already has leaves that element alone.
 *
 * The line is either written (`text`, already translated) or a placeholder for a copy `slot`; `text` wins.
 * @typedef {{ art: string, slot?: string, text?: string }} ArtIntroPose
 * @param {ArtIntroPose} options
 * @returns {{ intro: DocumentFragment, panel: HTMLElement, show: (next: ArtIntroPose) => void }}
 */
export function createArtIntro({ art, slot, text }) {
    const { panel, setArts } = createArtPanel([art]);
    let shown = { slot, text };
    let lineNode = createLine(shown);
    const intro = document.createDocumentFragment();
    intro.append(panel, lineNode);

    function show(next) {
        setArts([next.art]);
        if (shown.slot === next.slot && shown.text === next.text) {
            return;
        }
        shown = { slot: next.slot, text: next.text };
        const replacement = createLine(shown);
        lineNode.replaceWith(replacement);
        lineNode = replacement;
    }
    return { intro, panel, show };
}
