/**
 * Switches the emoji font of the mode between the bundled face and the device's own emoji. The CSS does the switch:
 * `:root[data-sb-emoji-font='device']` makes the leading family of every surface the text font again, so no emoji family
 * is named and the face is never requested. This file only sets that attribute, for three reasons: the preference
 * `use_device_emoji`, a browser that draws the face blank (Safari and iOS 17.0 and 17.1, WebKit bug 262223), and a face
 * that has loaded and draws nothing.
 */

export const EMOJI_FONT_ATTRIBUTE = 'data-sb-emoji-font';
export const BLANK_FLAG_KEY = 'sb_emoji_font_blank';
const FAMILY = 'SB Emoji';
const PROBE = '😀';

// Safari 17.0 and 17.1 on macOS, and every browser on iOS and iPadOS 17.0 and 17.1 (they all run WebKit).
const BLANK_SAFARI = /Version\/17\.[01](?:\.\d+)?\s.*Safari\//;
const BLANK_IOS = /(?:iPhone OS|CPU OS) 17_[01](?:_\d+)?\b/;

/** Whether the browser is one that draws a COLRv0 font blank. A shortcut, so that there is no blank flash; the canvas check is the net. */
export function isBlankFontBrowser(userAgent) {
    return BLANK_SAFARI.test(userAgent ?? '') || BLANK_IOS.test(userAgent ?? '');
}

/**
 * Whether the face leaves a mark. A canvas that cannot be read (a privacy setting that blanks it) counts as a face that
 * works, because the other answer would turn the font off for a user whose font is fine.
 * @param {() => number} measureInk The sum of the alpha values of the probe drawn with the face.
 */
export function drawsInk(measureInk) {
    try {
        return measureInk() > 0;
    } catch {
        return true;
    }
}

function measureEmojiInk() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.textBaseline = 'top';
    context.font = `40px "${FAMILY}"`;
    context.fillStyle = '#f00';
    context.fillText(PROBE, 4, 4);
    let ink = 0;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 3; index < data.length; index += 4) {
        ink += data[index];
    }
    return ink;
}

function getStorage() {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

function readFlag(storage) {
    try {
        return storage?.getItem(BLANK_FLAG_KEY) ?? null;
    } catch {
        return null;
    }
}

function writeFlag(storage, userAgent) {
    try {
        storage?.setItem(BLANK_FLAG_KEY, userAgent);
    } catch {
        // A browser that refuses storage checks again on the next page.
    }
}

function setDevice(root, device) {
    if (device) {
        root.setAttribute(EMOJI_FONT_ATTRIBUTE, 'device');
    } else {
        root.removeAttribute(EMOJI_FONT_ATTRIBUTE);
    }
}

const isOurFace = face => String(face?.family ?? '').replace(/^["']|["']$/g, '') === FAMILY && face.status === 'loaded';

let stopWatching = null;

/**
 * Sets or removes the attribute for the current settings, and while the face is in use waits for it to load and checks
 * that it draws. It never starts a load: a page that shows no emoji never requests the file.
 * @param {object} [options]
 * @param {boolean} options.useDeviceEmoji The preference `use_device_emoji`.
 */
export function applyEmojiFont({
    useDeviceEmoji,
    root = document.documentElement,
    userAgent = globalThis.navigator?.userAgent ?? '',
    storage = getStorage(),
    fonts = globalThis.document?.fonts ?? null,
    canvasInk = measureEmojiInk,
} = {}) {
    stopWatching?.();
    stopWatching = null;

    const device = Boolean(useDeviceEmoji) || isBlankFontBrowser(userAgent) || readFlag(storage) === userAgent;
    setDevice(root, device);
    if (device || typeof fonts?.addEventListener !== 'function') {
        return;
    }

    const onLoaded = (event) => {
        if (![...(event.fontfaces ?? [])].some(isOurFace)) {
            return;
        }
        stopWatching?.();
        stopWatching = null;
        if (!drawsInk(canvasInk)) {
            setDevice(root, true);
            writeFlag(storage, userAgent);
        }
    };
    fonts.addEventListener('loadingdone', onLoaded);
    stopWatching = () => fonts.removeEventListener('loadingdone', onLoaded);
}
