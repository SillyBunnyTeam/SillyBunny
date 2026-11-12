import { openDialog } from '../sillybunny-editor/dialog.js';
import { createGreetingImage } from './greeting-art.js';
import { pickPixelStep, sourceFor } from './greeting-art-rules.js';

/** The height that the window keeps for its header and the space around it. */
const VIEWER_VERTICAL_ROOM = 160;

/**
 * Shows a greeting picture larger in a window. The viewer of message images only opens pictures that a message holds
 * in its `extra.media`, which is where this one must not be, so the window of the dialog API shows it instead.
 *
 * The picture is sized by the same rule as in the chat, against the body of the window. That is measured once the window
 * is open, because the window sets its own width, and again when the screen turns or is resized.
 * @param {import('./greeting-art-rules.js').GreetingArtTarget} art
 * @param {Window} [win]
 */
export function openGreetingArtViewer(art, win = window) {
    const image = createGreetingImage(art, 'sbGreetingArtLarge', win.document);
    const dialog = openDialog({ tier: 'window', size: 'content', title: art.name, className: 'sbGreetingArtDialog', content: image });

    function measure() {
        const padding = win.getComputedStyle(dialog.body);
        const scale = pickPixelStep({
            artWidth: art.width,
            artHeight: art.height,
            maxCssWidth: dialog.body.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight),
            maxCssHeight: win.innerHeight - VIEWER_VERTICAL_ROOM,
            dpr: win.devicePixelRatio || 1,
        });
        if (!scale) {
            if (!image.hasAttribute('src')) image.setAttribute('src', art.src);
            return;
        }
        image.setAttribute('src', sourceFor(art, scale));
        image.style.width = `${scale.cssWidth}px`;
        image.dataset.sbScale = scale.mode;
    }

    measure();
    win.addEventListener('resize', measure);
    dialog.closed.then(() => win.removeEventListener('resize', measure));
    return dialog;
}
