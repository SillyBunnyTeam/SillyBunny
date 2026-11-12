import { getGreetingArtAlt } from './assistant-copy.js';
import { createOpeningHold } from './greeting-art-opening.js';
import { GREETING_ART_HEIGHT_SHARE, findGreetingArt, pickPixelStep, sourceFor } from './greeting-art-rules.js';

const FIGURE_CLASS = 'sbGreetingArt';
const GREETING_SELECTOR = ':scope > .mes[mesid="0"]';
const ENLARGE_LABEL = 'Enlarge Picture';

/**
 * @typedef {object} ChatReading
 * @property {string | undefined} avatar The avatar file of the chat's character.
 * @property {Parameters<typeof findGreetingArt>[0]['message']} message Message 0 of the chat.
 * @property {number} messageCount How many messages the chat holds.
 * @property {boolean} inGroup
 * @property {boolean} inConversation
 */

/**
 * The image of a greeting picture, for the chat and for the viewer. Its size attributes are set before the file
 * loads, so the box exists first and the chat does not jump when the file arrives. Its file is set when it is sized.
 * @param {import('./greeting-art-rules.js').GreetingArtTarget} art
 * @param {string} className
 * @param {Document} [doc]
 * @returns {HTMLImageElement}
 */
export function createGreetingImage(art, className, doc = document) {
    const image = doc.createElement('img');
    image.className = className;
    image.alt = getGreetingArtAlt(art.assistantId);
    image.setAttribute('width', String(art.width));
    image.setAttribute('height', String(art.height));
    image.decoding = 'async';
    image.draggable = false;
    return image;
}

/**
 * Keeps the greeting picture above message 0 of the open chat. The picture is an element of its own, beside the text of
 * the message and not inside it, so editing, swiping and re-rendering the text leave it alone. What decides whether it
 * is there is the chat, read on every change of the message list, so each way of printing a chat gets it with no hook
 * of its own.
 *
 * A chat that holds only the greeting also opens at its top, so that the picture is seen whole (see
 * `greeting-art-opening.js`).
 *
 * @param {object} options
 * @param {HTMLElement} options.chatElement The element that holds the `.mes` elements.
 * @param {() => ChatReading} options.readChat What the chat holds now.
 * @param {(art: import('./greeting-art-rules.js').GreetingArtTarget) => unknown} options.openViewer
 * @param {HTMLElement | null} [options.shellElement] The element that says whether the app is in Conversation mode.
 * @param {Window} [options.win]
 */
export function createGreetingArt({ chatElement, readChat, openViewer, shellElement, win = window }) {
    const doc = chatElement.ownerDocument;
    const shell = shellElement === undefined ? doc.getElementById('sheld') : shellElement;
    /** @type {{ figure: HTMLElement, image: HTMLImageElement, art: import('./greeting-art-rules.js').GreetingArtTarget } | null} */
    let current = null;
    /** @type {{ width: number, height: number, dpr: number }} What the picture was sized for. */
    let room = { width: 0, height: 0, dpr: 1 };
    /** @type {Array<{ disconnect: () => void }>} */
    let observers = [];
    /** @type {MediaQueryList | null} */
    let pixelRatio = null;
    let wasVisualNovel = false;
    let started = false;

    const opening = createOpeningHold({
        chatElement,
        isGreetingOnly: () => {
            const reading = readChat();
            return reading.messageCount === 1 && findGreetingArt({ ...reading, messageId: 0 }) !== null;
        },
        win,
    });

    /**
     * Sizes the picture for the room of the chat and chooses its file, whole steps of the 1x file where they fill the
     * room well enough and the 2x file otherwise.
     */
    function layout() {
        if (!current) return;
        const { figure, image, art } = current;

        // The text column has its own right padding, and it differs between chat styles and screen sizes.
        const text = figure.parentElement?.querySelector(':scope > .mes_text');
        figure.style.paddingRight = `${text ? parseFloat(win.getComputedStyle(text).paddingRight) || 0 : 0}px`;
        const padding = win.getComputedStyle(figure);

        const scale = pickPixelStep({
            artWidth: art.width,
            artHeight: art.height,
            maxCssWidth: figure.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight),
            maxCssHeight: room.height * GREETING_ART_HEIGHT_SHARE,
            dpr: room.dpr,
        });
        if (!scale) return;

        const source = sourceFor(art, scale);
        if (image.getAttribute('src') !== source) image.setAttribute('src', source);
        image.style.width = `${scale.cssWidth}px`;
        figure.dataset.sbScale = scale.mode;
        figure.dataset.sbSource = scale.source;
        figure.dataset.sbPixelStep = scale.step === null ? '' : String(scale.step);
    }

    /**
     * The height of the chat is read here and nowhere else. It also changes when the composer grows while a person
     * types and when a soft keyboard opens, and the picture must not move for either.
     */
    function measureRoom() {
        room = { width: chatElement.offsetWidth, height: chatElement.clientHeight, dpr: win.devicePixelRatio || 1 };
        layout();
    }

    function createFigure(art) {
        const figure = doc.createElement('figure');
        figure.className = FIGURE_CLASS;
        figure.dataset.sbGreetingArt = art.assistantId;

        const open = doc.createElement('button');
        open.type = 'button';
        open.className = `${FIGURE_CLASS}Open`;
        open.setAttribute('aria-label', ENLARGE_LABEL);
        open.setAttribute('aria-haspopup', 'dialog');
        open.addEventListener('click', () => openViewer(art));

        const image = createGreetingImage(art, `${FIGURE_CLASS}Image`, doc);
        open.append(image);
        figure.append(open);
        return { figure, image, art };
    }

    function removeFigure() {
        current?.figure.remove();
        current = null;
    }

    function findGreetingHost() {
        const first = chatElement.firstElementChild;
        if (first?.classList.contains('mes')) return first.getAttribute('mesid') === '0' ? first : null;
        return chatElement.querySelector(GREETING_SELECTOR);
    }

    /** Puts the picture on message 0 when the chat calls for it, and takes it away when it does not. */
    function sync() {
        const host = findGreetingHost();
        const art = host ? findGreetingArt({ ...readChat(), messageId: 0 }) : null;
        const block = host?.querySelector(':scope > .mes_block') ?? null;

        const stays = current && art && block && current.figure.parentElement === block && current.art.assistantId === art.assistantId;
        if (!stays) removeFigure();
        if (!art || !block) return;

        if (!current) {
            current = createFigure(art);
            const header = block.querySelector(':scope > .ch_name');
            if (header) header.after(current.figure);
            else block.prepend(current.figure);
            measureRoom();
        }
        opening.offer();
    }

    /** Leaving Home for a chat empties the chat element, and Home is the panel in it. */
    const isHomePanel = node => node instanceof HTMLElement && node.classList.contains('welcomePanel');

    /** @param {MutationRecord[]} records */
    function onMessageListChange(records) {
        if (records.some(record => Array.from(record.removedNodes).some(isHomePanel))) opening.beginOpening();
        sync();
    }

    function watchPixelRatio() {
        pixelRatio?.removeEventListener('change', onPixelRatioChange);
        pixelRatio = win.matchMedia(`(resolution: ${win.devicePixelRatio}dppx)`);
        pixelRatio.addEventListener('change', onPixelRatioChange);
    }

    function onPixelRatioChange() {
        watchPixelRatio();
        measureRoom();
    }

    // A fractional ratio can be one that the media query of the moment never reports as changed.
    function onWindowResize() {
        if ((win.devicePixelRatio || 1) !== room.dpr) onPixelRatioChange();
    }

    // Visual Novel mode changes the height of the chat and not its width.
    function onBodyClassChange() {
        const isVisualNovel = doc.body.classList.contains('waifuMode');
        if (isVisualNovel === wasVisualNovel) return;
        wasVisualNovel = isVisualNovel;
        measureRoom();
    }

    function observe(Observer, callback, target, options) {
        const observer = new Observer(callback);
        observer.observe(target, options);
        observers.push(observer);
    }

    return {
        sync,
        /**
         * A chat has been opened. Printing it may come before or after this, and either way starts the hold.
         * @param {string} [chatId]
         */
        chatOpened(chatId) {
            opening.chatChanged(chatId);
            sync();
        },
        start() {
            if (started) return;
            started = true;
            // Two observers, because one that sees the children of every message would wake for each streamed token.
            observe(MutationObserver, onMessageListChange, chatElement, { childList: true });
            // Hiding a message turns it into a system message, which has no greeting picture.
            observe(MutationObserver, sync, chatElement, { attributes: true, attributeFilter: ['is_system', 'is_user'], subtree: true });
            if (shell) observe(MutationObserver, sync, shell, { attributes: true, attributeFilter: ['data-sb-conversation-mode'] });
            observe(MutationObserver, onBodyClassChange, doc.body, { attributes: true, attributeFilter: ['class'] });
            observe(ResizeObserver, () => {
                if (chatElement.offsetWidth !== room.width) measureRoom();
            }, chatElement);
            wasVisualNovel = doc.body.classList.contains('waifuMode');
            doc.addEventListener('sb:chat-style-updated', measureRoom);
            win.addEventListener('resize', onWindowResize);
            watchPixelRatio();
            sync();
        },
        stop() {
            if (!started) return;
            started = false;
            for (const observer of observers) observer.disconnect();
            observers = [];
            doc.removeEventListener('sb:chat-style-updated', measureRoom);
            win.removeEventListener('resize', onWindowResize);
            pixelRatio?.removeEventListener('change', onPixelRatioChange);
            pixelRatio = null;
            opening.release();
            removeFigure();
        },
    };
}
