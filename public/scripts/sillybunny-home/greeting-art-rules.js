import { ASSISTANTS } from './assistant-registry.js';

export const GREETING_ART_HEIGHT_SHARE = 0.7;

/**
 * How much of the room a stepped picture must fill to be drawn at whole steps. A step that leaves more room than this
 * empty is too small for a picture that sets the mood, so the picture fills the room smoothly instead.
 */
export const GREETING_ART_MIN_FILL = 0.75;

/** Absorbs the rounding of a division, so a column of exactly three steps is not read as two and a bit. */
const TOLERANCE = 1e-9;

/**
 * @typedef {object} GreetingArtTarget
 * @property {string} assistantId
 * @property {string} name The display name of the assistant.
 * @property {string} src The picture at its own size, one file pixel per art pixel.
 * @property {string} src2x The same picture with every art pixel drawn as 2 by 2 file pixels, so that a smooth
 *     downscale of it stays crisp.
 * @property {number} width The width of the art in art pixels.
 * @property {number} height
 */

/**
 * The picture that belongs above one message, if any. It is the main greeting of a bundled assistant in a Roleplay
 * chat: message 0, from the character, showing its first swipe. The card is matched by its avatar file, because a
 * name is something the user can give to any card.
 *
 * A group chat has no answer here. A member's greeting is a message like her replies, and nothing in the message says
 * which one it is, so the picture would land on replies too.
 *
 * @param {object} context
 * @param {string | undefined} context.avatar The avatar file of the chat's character.
 * @param {number} context.messageId The index of the message in the chat.
 * @param {{ is_user?: boolean, is_system?: boolean, swipe_id?: number } | null | undefined} context.message
 * @param {boolean} [context.inGroup]
 * @param {boolean} [context.inConversation]
 * @param {readonly import('./assistant-registry.js').AssistantEntry[]} [assistants]
 * @returns {GreetingArtTarget | null}
 */
export function findGreetingArt({ avatar, messageId, message, inGroup = false, inConversation = false }, assistants = ASSISTANTS) {
    if (inGroup || inConversation) return null;
    if (messageId !== 0 || !message) return null;
    if (message.is_user || message.is_system) return null;
    if ((message.swipe_id ?? 0) !== 0) return null;

    const assistant = assistants.find(entry => entry.greetingArt && entry.defaultAvatar === avatar);
    return assistant?.greetingArt ? { assistantId: assistant.id, name: assistant.name, ...assistant.greetingArt } : null;
}

/**
 * @typedef {object} PixelScale
 * @property {'pixel' | 'smooth'} mode `pixel` draws every art pixel as a whole number of device pixels. `smooth`
 *     fills the room.
 * @property {number | null} step Device pixels per art pixel, or null when `mode` is `smooth`.
 * @property {'1x' | '2x'} source The file that the mode needs: the picture at its own size for `pixel`, and the
 *     2x picture for `smooth`.
 * @property {number} cssWidth
 * @property {number} cssHeight
 */

/**
 * Picks the size and the file of a pixel-art picture for a room.
 *
 * The picture is first fitted to the room with its aspect kept. Its stepped size is the largest whole number of device
 * pixels per art pixel that fits there. When that is at least one, and the stepped picture is at least
 * `GREETING_ART_MIN_FILL` of the fitted width, it is drawn at that step: the CSS size is `art * step / dpr`, a whole
 * number of device pixels, so every art pixel is the same size on screen. In every other case the picture fills the
 * fitted room smoothly.
 *
 * @param {object} input
 * @param {number} input.artWidth The width of the picture in art pixels.
 * @param {number} input.artHeight The height of the picture in art pixels.
 * @param {number} input.maxCssWidth The width of the room, in CSS pixels.
 * @param {number} input.maxCssHeight The height of the room, in CSS pixels.
 * @param {number} input.dpr Device pixels per CSS pixel.
 * @returns {PixelScale | null} Null when the room has no size yet, for example because it is hidden.
 * @throws {RangeError} When the picture or the pixel ratio has no usable size.
 */
export function pickPixelStep({ artWidth, artHeight, maxCssWidth, maxCssHeight, dpr }) {
    for (const [name, value] of Object.entries({ artWidth, artHeight, dpr })) {
        if (!Number.isFinite(value) || value <= 0) {
            throw new RangeError(`pickPixelStep needs a positive ${name}, got ${value}.`);
        }
    }
    if (!(maxCssWidth > 0) || !(maxCssHeight > 0)) return null;

    const aspect = artWidth / artHeight;
    const fittedWidth = Math.min(maxCssWidth, maxCssHeight * aspect);
    const step = Math.floor((fittedWidth / artWidth) * dpr + TOLERANCE);

    const steppedWidth = (artWidth * step) / dpr;
    if (step >= 1 && steppedWidth + TOLERANCE >= fittedWidth * GREETING_ART_MIN_FILL) {
        return { mode: 'pixel', step, source: '1x', cssWidth: steppedWidth, cssHeight: (artHeight * step) / dpr };
    }

    return { mode: 'smooth', step: null, source: '2x', cssWidth: fittedWidth, cssHeight: fittedWidth / aspect };
}

export function sourceFor(art, scale) {
    return scale.source === '2x' ? art.src2x : art.src;
}
