/**
 * Page-side steps of the capture spec: the fixed clock, the reset of pointer, focus and scroll that the open steps leave
 * behind, the wait for fonts and pictures, a screenshot that is taken until two in a row are the same, the measure of the
 * roots, masks and scroller of a surface, and the comparison of two screenshots in the part of the window that counts.
 * The time zone and locale come from the audit config.
 * Nothing here imports Playwright; the functions take the page.
 */

import { chooseScroller, maskDropReason } from './capture-plan.js';

/** The time that the clock of every capture starts at: after the dates of the seeded data (January 2026), so that no date reads as future. */
export const FIXED_TIME = new Date('2026-02-02T12:00:00.000Z');

/** The time between the two screenshots that must match. */
const SHOT_GAP_MS = 300;
/** How long a wait of the preparation lasts at most; a wait that reaches it is recorded in the notes of the capture. */
const WAIT_LIMIT_MS = 5000;
const IDLE_LIMIT_MS = 4000;
const DECODE_LIMIT_MS = 3000;

/** @typedef {{ x: number, y: number, width: number, height: number }} Box */
/** @typedef {{ box: Box, excluded: number[] } | null} Region The part of the window that counts: a box without the pixels at its rounded corners; null: all of it. */

/**
 * Starts `Date` at `FIXED_TIME` in every page of the context, from before the first script of each document runs, and lets
 * it run on from there. A clock that stands still (`context.clock.setFixedTime()`) stops the app, because jQuery's `fadeIn`
 * and the other animations that it times with `Date.now()` never finish; `clock.install()` replaces the timers and the frame
 * callbacks that the waits of the open steps use. So only `Date` is shifted: a date shown from `new Date()` is the same on
 * every run, and the dates that the app prints from the seeded data read as in the past.
 * @param {import('@playwright/test').BrowserContext} context
 */
export async function startClockAtFixedTime(context) {
    await context.addInitScript((fixed) => {
        const RealDate = Date;
        const offset = fixed - RealDate.now();
        const now = () => RealDate.now() + offset;
        function ShiftedDate(...args) {
            if (!new.target) {
                return new RealDate(now()).toString();
            }
            return args.length ? new RealDate(...args) : new RealDate(now());
        }
        ShiftedDate.prototype = RealDate.prototype;
        ShiftedDate.now = now;
        ShiftedDate.parse = RealDate.parse;
        ShiftedDate.UTC = RealDate.UTC;
        Object.setPrototypeOf(ShiftedDate, RealDate);
        window.Date = ShiftedDate;
    }, FIXED_TIME.getTime());
}

/**
 * Whether a state is about hover or focus, and so keeps what its open step left: the id has the word `hover` or `focus`
 * (`hover-row`, `focus-ring`, `keyboard-focus`), or is a `submenu`, which opens on hover and folds when the pointer leaves.
 * @param {string | null} stateId
 */
export const keepsPointerAndFocus = stateId => stateId !== null && /(^|-)(hover|hovered|focus|focused|submenu)(-|$)/.test(stateId);

/**
 * Puts the page in the state that a capture compares: no pointer over the page, nothing focused, the window not scrolled,
 * the layers repainted, the fonts loaded and the pictures that are on show decoded. Returns `restore`, which undoes what can be
 * undone (the focus goes back to the element that had it: the next step of a surface may rely on it, such as an Escape key
 * press that goes to the focused menu; pictures made eager are lazy again), and `notes`, the waits that stopped at their limit.
 * Fails when taking the focus away closes the surface (a menu that closes on `focusout`), which no capture of it could show.
 * @param {import('@playwright/test').Page} page
 * @param {{ root: string, keepPointerAndFocus?: boolean }} options
 * @returns {Promise<{ blurred: string | null, restore: () => Promise<void>, notes: string[] }>}
 */
export async function prepareForCapture(page, { root, keepPointerAndFocus = false }) {
    let blurred = null;
    let focused = null;
    const notes = [];
    if (!keepPointerAndFocus) {
        // A position outside the window: a click leaves the pointer over its target, and a hover fill would show.
        await page.mouse.move(-10, -10);
        // A text field keeps its focus (a menu may hang on it, and its focus is part of what the state shows; the caret is hidden), and
        // so does anything inside an open menu. A button or link that a click left focused is blurred.
        const active = await page.evaluateHandle(() => {
            const element = document.activeElement;
            if (!element || element === document.body || element === document.documentElement) {
                return null;
            }
            const keeps = element.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
                || element.closest('[role="menu"], [role="listbox"], [popover], .sb-action-menu, .sb-action-popover, .ui-autocomplete, .autoComplete-wrap, .ctx-menu, .ctx-sub-menu');
            return keeps ? null : element;
        });
        focused = active.asElement();
        if (focused) {
            blurred = await focused.evaluate((element) => {
                const label = `${element.localName}${element.id ? `#${element.id}` : ''}`;
                element.blur();
                return label;
            });
        } else {
            await active.dispose();
        }
    }
    // An animation on an element above the root (the page transition of the settings shell) is not covered by the settle step of
    // the open steps, and the screenshot would finish it by itself at a time that depends on the machine: wait for the ones that end.
    const animationsLeft = await page.evaluate(limit => new Promise((resolve) => {
        const started = performance.now();
        const running = () => document.getAnimations().filter((animation) => {
            const timing = animation.effect?.getComputedTiming?.();
            return timing && Number.isFinite(timing.endTime) && (animation.playState === 'running' || animation.playState === 'pending');
        }).length;
        const check = () => {
            const count = running();
            if (count === 0 || performance.now() - started > limit) {
                resolve(count);
            } else {
                requestAnimationFrame(check);
            }
        };
        check();
    }), WAIT_LIMIT_MS);
    if (animationsLeft > 0) {
        notes.push(`${animationsLeft} animation(s) still running after ${WAIT_LIMIT_MS} ms`);
    }
    // A layer that the page keeps promoted with `will-change` (the settings page does, for its open animation) is rastered at the scale that it had
    // when it was first painted, which is a step of the open animation on a slow run: the text in it then sits a fraction of a pixel
    // from where it sits on a fast run, and stays there. Taking the promotion off and putting it back (the inline value and its priority, if
    // the app set one) paints it again at the final scale.
    await page.locator(root).first().evaluate(async (start) => {
        const layers = [];
        for (let element = start; element; element = element.parentElement) {
            const willChange = getComputedStyle(element).willChange;
            if (willChange !== 'auto' && /transform|opacity/.test(willChange)) {
                layers.push({ element, value: element.style.getPropertyValue('will-change'), priority: element.style.getPropertyPriority('will-change') });
            }
        }
        if (layers.length === 0) {
            return;
        }
        const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        layers.forEach(({ element }) => element.style.setProperty('will-change', 'auto', 'important'));
        await frames();
        layers.forEach(({ element, value, priority }) => (value ? element.style.setProperty('will-change', value, priority) : element.style.removeProperty('will-change')));
        await frames();
    }).catch(() => {});
    // A lazy picture that has no height yet loads when the page scrolls to it, and the height under the pages that follow changes by
    // then: every picture is loaded before the first page, so that the heights are the final ones.
    const imagesLeft = await page.evaluate(async (limit) => {
        const made = [];
        const pending = [...document.images].filter((image) => {
            if (image.loading === 'lazy') {
                made.push(image);
                image.loading = 'eager';
            }
            return !image.complete && image.src;
        });
        window.__sbCaptureEager = made;
        let left = pending.length;
        await Promise.race([
            Promise.all(pending.map(image => new Promise((resolve) => {
                const done = () => {
                    left--;
                    resolve();
                };
                image.addEventListener('load', done, { once: true });
                image.addEventListener('error', done, { once: true });
            }))),
            new Promise(resolve => setTimeout(resolve, limit)),
        ]);
        return left;
    }, WAIT_LIMIT_MS);
    if (imagesLeft > 0) {
        notes.push(`${imagesLeft} picture(s) still loading after ${WAIT_LIMIT_MS} ms`);
    }
    // Pictures that the page asks for late (avatars, thumbnails) are on screen before the screenshot; a page that polls never goes idle.
    await page.waitForLoadState('networkidle', { timeout: IDLE_LIMIT_MS }).catch(() => notes.push(`the network was not idle after ${IDLE_LIMIT_MS} ms`));
    const decodesLeft = await page.evaluate(async (limit) => {
        window.scrollTo(0, 0);
        document.scrollingElement?.scrollTo(0, 0);
        await document.fonts.ready;
        let left = 0;
        const give = promise => Promise.race([
            promise.catch(() => {}),
            new Promise((resolve) => {
                setTimeout(() => {
                    left++;
                    resolve();
                }, limit);
            }),
        ]);
        // A picture that has not loaded and sits off screen (lazy) is not waited for: it is not in the capture.
        const onShow = (element) => {
            const box = element.getBoundingClientRect();
            return box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth;
        };
        const waits = [...document.images].filter(image => image.currentSrc && onShow(image)).map(image => give(image.decode()));
        const urls = new Set();
        for (const element of document.body.querySelectorAll('*')) {
            if (!onShow(element)) {
                continue;
            }
            for (const match of getComputedStyle(element).backgroundImage.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
                urls.add(match[1]);
            }
        }
        for (const url of urls) {
            const image = new Image();
            image.src = url;
            waits.push(give(image.decode()));
        }
        await Promise.all(waits);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return left;
    }, DECODE_LIMIT_MS);
    if (decodesLeft > 0) {
        notes.push(`${decodesLeft} picture(s) not decoded after ${DECODE_LIMIT_MS} ms`);
    }
    const restore = async () => {
        await page.evaluate(() => {
            for (const image of window.__sbCaptureEager ?? []) {
                image.loading = 'lazy';
            }
            window.__sbCaptureEager = [];
        }).catch(() => {});
        if (focused) {
            await focused.evaluate(element => element.isConnected && element.focus({ preventScroll: true })).catch(() => {});
            await focused.dispose().catch(() => {});
        }
    };
    if (blurred) {
        const stillThere = await page.locator(root).first().isVisible();
        if (!stillThere) {
            await restore();
            throw Object.assign(new Error(`Taking the focus away from ${blurred} closed ${root}.`), { sbFocusClosed: true });
        }
    }
    return { blurred, restore, notes };
}

/**
 * Takes a screenshot of the window until two in a row are the same, so that a transition that a reset set off, or a picture
 * that arrived late, is not in the capture. Two screenshots are the same when no pixel in the compared part differs by more than
 * `threshold` (see `COLOUR_THRESHOLD`): text over translucent layers is rasterised with a difference of one level that nothing can mask.
 * `animations: 'disabled'` finishes the animations that end, and `caret: 'hide'` hides the text cursor. `maskProvider` is asked for
 * the masks right before each shot (and released after it), so that an element that the app builds again between two shots is masked
 * all the same. When it never settles, `unstableRegion` says where the last two differ.
 * @param {import('@playwright/test').Page} page
 * @param {{ maskProvider?: (() => Promise<{ locators: import('@playwright/test').Locator[], report: object, release: () => Promise<void> }>) | null, region?: Region, tries?: number, threshold: number }} options
 * @returns {Promise<{ buffer: Buffer, stable: boolean, shots: number, unstableRegion: string | null, maskReport: object | null }>}
 */
export async function stableScreenshot(page, { maskProvider = null, region = null, tries = 5, threshold }) {
    let maskReport = null;
    const shoot = async () => {
        const masks = maskProvider ? await maskProvider() : null;
        maskReport ??= masks?.report ?? null;
        try {
            return await page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css', type: 'png', mask: masks?.locators ?? [] });
        } finally {
            await masks?.release();
        }
    };
    let previous = await shoot();
    let before = previous;
    let difference = null;
    for (let shot = 2; shot <= tries; shot++) {
        // A gap between the two shots, so that an animation that the browser cannot disable (jQuery's fades) or a list that is
        // still arriving shows up as a difference instead of being the same in two shots taken in one frame.
        await new Promise(resolve => setTimeout(resolve, SHOT_GAP_MS));
        const next = await shoot();
        difference = next.equals(previous) ? { count: 0, description: '' } : await compareScreenshots(page, previous, next, { threshold, region });
        if (difference.count === 0) {
            return { buffer: next, stable: true, shots: shot, unstableRegion: null, maskReport };
        }
        before = previous;
        previous = next;
    }
    return { buffer: previous, stable: false, shots: tries, unstableRegion: before === previous ? null : difference.description, maskReport };
}

/**
 * Compares two screenshots in the part of the window that counts, with the colour distance and the limit that Playwright's
 * comparison uses (see `COLOUR_THRESHOLD`), or, with `any`, counting every pixel that differs at all. Says how many pixels differ in
 * the region, the largest difference of a colour channel among them in levels, where they are (the box around them, the element at
 * its middle and the elements at the pixels), and how many differ outside the region. Decoded in the page, with the decoder of the browser.
 * @param {import('@playwright/test').Page} page
 * @param {Buffer} first
 * @param {Buffer} second
 * @param {{ threshold?: number, region?: Region, any?: boolean }} options
 * @returns {Promise<{ count: number, maxLevel: number, outside: number, description: string }>}
 */
export async function compareScreenshots(page, first, second, { threshold = 0, region = null, any = false }) {
    try {
        return await page.evaluate(async ({ first, second, threshold, region, any }) => {
            const read = async (encoded) => {
                const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${encoded}`)).blob());
                const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', { willReadFrequently: true });
                context.drawImage(bitmap, 0, 0);
                return context.getImageData(0, 0, bitmap.width, bitmap.height);
            };
            const [a, b] = await Promise.all([read(first), read(second)]);
            if (a.width !== b.width || a.height !== b.height) {
                return { count: 1, maxLevel: 0, outside: 0, description: `the size changed from ${a.width}x${a.height} to ${b.width}x${b.height}` };
            }
            const limit = 35215 * threshold * threshold;
            const y = (r, g, bl) => r * 0.29889531 + g * 0.58662247 + bl * 0.11448223;
            const i = (r, g, bl) => r * 0.59597799 - g * 0.2741761 - bl * 0.32180189;
            const q = (r, g, bl) => r * 0.21147017 - g * 0.52261711 + bl * 0.31114694;
            const excluded = new Set();
            for (let at = 0; region && at < region.excluded.length; at += 2) {
                excluded.add(region.excluded[at + 1] * a.width + region.excluded[at]);
            }
            let count = 0;
            let outside = 0;
            let maxLevel = 0;
            const points = [];
            let left = a.width;
            let top = a.height;
            let right = -1;
            let bottom = -1;
            for (let index = 0; index < a.data.length; index += 4) {
                const [r1, g1, b1, r2, g2, b2] = [a.data[index], a.data[index + 1], a.data[index + 2], b.data[index], b.data[index + 1], b.data[index + 2]];
                if (r1 === r2 && g1 === g2 && b1 === b2 && a.data[index + 3] === b.data[index + 3]) {
                    continue;
                }
                if (!any) {
                    const dy = y(r1, g1, b1) - y(r2, g2, b2);
                    const di = i(r1, g1, b1) - i(r2, g2, b2);
                    const dq = q(r1, g1, b1) - q(r2, g2, b2);
                    if (0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq <= limit) {
                        continue;
                    }
                }
                const pixel = index / 4;
                const x = pixel % a.width;
                const row = Math.floor(pixel / a.width);
                const inside = !region || (x >= region.box.x && x < region.box.x + region.box.width && row >= region.box.y && row < region.box.y + region.box.height && !excluded.has(pixel));
                if (!inside) {
                    outside++;
                    continue;
                }
                count++;
                maxLevel = Math.max(maxLevel, Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2));
                if (points.length < 3000) {
                    points.push([x, row]);
                }
                left = Math.min(left, x);
                right = Math.max(right, x);
                top = Math.min(top, row);
                bottom = Math.max(bottom, row);
            }
            if (count === 0) {
                return { count, maxLevel, outside, description: '' };
            }
            const scale = a.width / innerWidth;
            const name = element => `${element.localName}${element.id ? `#${element.id}` : ''}${typeof element.className === 'string' && element.className.trim() ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`;
            const centre = document.elementFromPoint((left + right) / 2 / scale, (top + bottom) / 2 / scale);
            const label = centre ? name(centre) : 'nothing';
            // The elements at the differing pixels themselves (an even sample), with their parents: the box can be much wider than the cause.
            const found = new Set();
            const step = Math.max(1, Math.floor(points.length / 60));
            for (let at = 0; at < points.length && found.size < 4; at += step) {
                const element = document.elementFromPoint(points[at][0] / scale, points[at][1] / scale);
                if (element) {
                    found.add(`${element.parentElement ? `${name(element.parentElement)} > ` : ''}${name(element)}`);
                }
            }
            return { count, maxLevel, outside, description: `${count} px differ in the box x ${left}-${right}, y ${top}-${bottom}, around ${label}; at the pixels: ${[...found].join(' | ')}` };
        }, { first: first.toString('base64'), second: second.toString('base64'), threshold, region, any });
    } catch (error) {
        return { count: 1, maxLevel: 0, outside: 0, description: `the difference could not be read: ${error.message}` };
    }
}

/**
 * A copy of the baseline with the actual capture's pixels in the region: what a comparison of the region alone is, handed to the
 * whole-image snapshot comparison. The sizes must match, or the actual is returned as it is (the size change is then reported).
 * @param {import('@playwright/test').Page} page
 * @param {Buffer} baseline
 * @param {Buffer} actual
 * @param {NonNullable<Region>} region
 * @returns {Promise<Buffer>}
 */
export async function pasteRegion(page, baseline, actual, region) {
    const encoded = await page.evaluate(async ({ baseline, actual, region }) => {
        const read = async (encodedImage) => {
            const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${encodedImage}`)).blob());
            const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', { willReadFrequently: true });
            context.drawImage(bitmap, 0, 0);
            return { width: bitmap.width, height: bitmap.height, data: context.getImageData(0, 0, bitmap.width, bitmap.height) };
        };
        const [a, b] = await Promise.all([read(baseline), read(actual)]);
        if (a.width !== b.width || a.height !== b.height) {
            return null;
        }
        const excluded = new Set();
        for (let at = 0; at < region.excluded.length; at += 2) {
            excluded.add(region.excluded[at + 1] * a.width + region.excluded[at]);
        }
        for (let row = region.box.y; row < region.box.y + region.box.height; row++) {
            for (let column = region.box.x; column < region.box.x + region.box.width; column++) {
                const pixel = row * a.width + column;
                if (excluded.has(pixel)) {
                    continue;
                }
                for (let channel = 0; channel < 4; channel++) {
                    a.data.data[pixel * 4 + channel] = b.data.data[pixel * 4 + channel];
                }
            }
        }
        const canvas = new OffscreenCanvas(a.width, a.height);
        canvas.getContext('2d').putImageData(a.data, 0, 0);
        const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
        let text = '';
        for (let index = 0; index < bytes.length; index += 0x8000) {
            text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        }
        return btoa(text);
    }, { baseline: baseline.toString('base64'), actual: actual.toString('base64'), region });
    return encoded ? Buffer.from(encoded, 'base64') : actual;
}

/**
 * The scroller of a surface: among the root, its descendants and its ancestors (the page itself counts), the elements that
 * scroll (more content than they show, and an overflow that scrolls), and of those the one with the largest visible area, the
 * first in document order among equals. Returns the element, which the caller disposes, and what it is, or null when nothing scrolls.
 * @param {import('@playwright/test').Page} page
 * @param {string} root A selector.
 * @returns {Promise<{ element: import('@playwright/test').ElementHandle, descriptor: { label: string, scrollHeight: number, clientHeight: number, area: number } } | null>}
 */
export async function findScroller(page, root) {
    // The root is a Playwright selector (it may use `:visible` or `:has-text`), so it is resolved here and not in the page.
    const rootHandle = await page.locator(root).first().elementHandle({ timeout: 5000 }).catch(() => null);
    if (!rootHandle) {
        return null;
    }
    try {
        const candidates = await rootHandle.evaluate((start) => {
            const found = new Set([start, ...start.querySelectorAll('*')]);
            for (let ancestor = start.parentElement; ancestor; ancestor = ancestor.parentElement) {
                found.add(ancestor);
            }
            const ordered = [...found].sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
            const list = [];
            for (const element of ordered) {
                const hidden = element.scrollHeight - element.clientHeight;
                const page = element === document.documentElement;
                if (hidden <= 1 || element.clientHeight === 0 || (!page && !/(auto|scroll|overlay)/.test(getComputedStyle(element).overflowY))) {
                    continue;
                }
                const box = page ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight } : element.getBoundingClientRect();
                const width = Math.max(0, Math.min(box.right, innerWidth) - Math.max(box.left, 0));
                const height = Math.max(0, Math.min(box.bottom, innerHeight) - Math.max(box.top, 0));
                const label = `${element.localName}${element.id ? `#${element.id}` : ''}${typeof element.className === 'string' && element.className.trim() ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`;
                element.setAttribute('data-sb-scroller-candidate', String(list.length));
                list.push({ area: Math.round(width * height), order: list.length, label, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight });
            }
            return list;
        });
        const index = chooseScroller(candidates);
        const chosen = index < 0 ? null : await page.locator(`[data-sb-scroller-candidate="${index}"]`).first().elementHandle({ timeout: 2000 }).catch(() => null);
        await page.evaluate(() => document.querySelectorAll('[data-sb-scroller-candidate]').forEach(element => element.removeAttribute('data-sb-scroller-candidate')));
        if (!chosen) {
            return null;
        }
        const element = (await chosen.evaluateHandle(node => (node === document.documentElement ? document.scrollingElement : node))).asElement();
        await chosen.dispose();
        const { label, scrollHeight, clientHeight, area } = candidates[index];
        return element ? { element, descriptor: { label, scrollHeight, clientHeight, area } } : null;
    } finally {
        await rootHandle.dispose();
    }
}

/**
 * The height that a sticky or fixed header and footer inside a scroller (for the page: anywhere in it) cover at its top and bottom:
 * the rows under them are hidden on a page, so the next page must repeat them (see `pageOverlap`).
 * @param {import('@playwright/test').ElementHandle} scroller
 * @returns {Promise<{ top: number, bottom: number }>}
 */
export const measureCovered = scroller => scroller.evaluate((element) => {
    const area = element === document.scrollingElement ? { top: 0, bottom: innerHeight, left: 0, right: innerWidth } : element.getBoundingClientRect();
    let top = 0;
    let bottom = 0;
    // Only what is part of the scroller can cover its rows: its sticky or fixed descendants, or, for the page, anything fixed or sticky.
    const parts = element === document.scrollingElement ? document.querySelectorAll('body *') : element.querySelectorAll('*');
    for (const candidate of parts) {
        const position = getComputedStyle(candidate).position;
        if (position !== 'sticky' && position !== 'fixed') {
            continue;
        }
        const box = candidate.getBoundingClientRect();
        if (box.width === 0 || box.height === 0 || box.right <= area.left || box.left >= area.right || box.bottom <= area.top || box.top >= area.bottom) {
            continue;
        }
        if (box.top <= area.top + 2) {
            top = Math.max(top, box.bottom - area.top);
        } else if (box.bottom >= area.bottom - 2) {
            bottom = Math.max(bottom, area.bottom - box.top);
        }
    }
    return { top: Math.round(top), bottom: Math.round(bottom) };
});

/**
 * Scrolls every scroller that the surface sits in or holds back to the top: the root, its descendants and its ancestors (the page
 * behind it). Opening a surface leaves them where what was focused or opened before put them (an input that scrolls itself into
 * view, a section that was expanded): the same surface was seen 28 to 180 px apart on two runs, so a surface as found is captured
 * from the top. Any scroll position counts, a fraction of a pixel too. Returns `restore`, which puts them back where they were.
 * @param {import('@playwright/test').Page} page
 * @param {string} root
 * @returns {Promise<() => Promise<void>>}
 */
export async function resetScrollerTop(page, root) {
    const rootHandle = await page.locator(root).first().elementHandle({ timeout: 5000 }).catch(() => null);
    if (!rootHandle) {
        return async () => {};
    }
    let moved;
    try {
        moved = await rootHandle.evaluateHandle((start) => {
            const was = [];
            const reset = (element) => {
                if (element.scrollTop !== 0) {
                    was.push([element, element.scrollTop]);
                    element.scrollTop = 0;
                }
            };
            reset(start);
            start.querySelectorAll('*').forEach(reset);
            for (let ancestor = start.parentElement; ancestor; ancestor = ancestor.parentElement) {
                reset(ancestor);
            }
            return was;
        });
        const count = await moved.evaluate(was => was.length);
        if (count > 0) {
            const scroller = await findScroller(page, root);
            if (scroller) {
                await waitForScrollerStable(scroller.element);
                await scroller.element.dispose();
            }
        }
    } finally {
        await rootHandle.dispose();
    }
    return async () => {
        await moved.evaluate(was => was.forEach(([element, top]) => {
            if (element.isConnected) {
                element.scrollTop = top;
            }
        })).catch(() => {});
        await moved.dispose().catch(() => {});
    };
}

/** The scroll position, visible height and content height of a scroller. */
export const readScroller = scroller => scroller.evaluate(element => ({ scrollTop: Math.round(element.scrollTop), clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));

/** Scrolls a scroller and returns the position that it reached. */
export const scrollScrollerTo = (scroller, top) => scroller.evaluate((element, wanted) => {
    element.scrollTop = wanted;
    return Math.round(element.scrollTop);
}, top);

/**
 * Waits until the scroll position and the content height of a scroller have not changed for 300 ms. A section that is built
 * or measured when it scrolls into view (a lazy list, `content-visibility`) changes the height under the page that was
 * planned, and on a loaded machine that takes longer than a few frames, so each page is taken once the scroller has stopped.
 * Gives up after 5 s and says so by returning false.
 */
export const waitForScrollerStable = scroller => scroller.evaluate(element => new Promise((resolve) => {
    const started = performance.now();
    let last = '';
    let changed = started;
    const frame = () => {
        const now = `${Math.round(element.scrollTop)}/${element.scrollHeight}/${element.clientHeight}`;
        const time = performance.now();
        if (now !== last) {
            last = now;
            changed = time;
        }
        if (time - changed >= 300) {
            resolve(true);
        } else if (time - started > 5000) {
            resolve(false);
        } else {
            requestAnimationFrame(frame);
        }
    };
    requestAnimationFrame(frame);
}));

/**
 * Holds the pictures that play in script (the Home figures blink at random times) still for a capture, the way the app holds
 * them for a person who asked for less motion: `reduced-motion` on the body, which `prefersReducedMotion()` reads, so every figure
 * puts its neutral picture back. That class also stops every animation and transition of the page (`sillybunny-theme.css`), which
 * removes the end state of one that fills forwards, so it is applied only where it is needed: when a figure of the art player is
 * in the window and nothing covers it, and never for an overlay (the window behind it is not compared), nor when the capture
 * is of the reduced-motion variant (the page holds it already). `mode` is `auto` (that rule), `always` (every capture) or `off`
 * (never), the last two for finding out what the hold changes.
 * Waits until no figure plays. Returns whether it held, a note if the wait stopped at its limit, and `release`, which takes the class off again.
 * @param {import('@playwright/test').Page} page
 * @param {{ overlay?: boolean, reducedMotionVariant?: boolean, mode?: 'auto' | 'always' | 'off' }} [options]
 * @returns {Promise<{ held: boolean, note: string | null, release: () => Promise<void> }>}
 */
export async function holdArtStill(page, { overlay = false, reducedMotionVariant = false, mode = 'auto' } = {}) {
    const none = { held: false, note: null, release: async () => {} };
    if (mode === 'off' || reducedMotionVariant || (mode === 'auto' && overlay)) {
        return none;
    }
    const hold = await page.evaluate(({ always }) => {
        if (document.body.classList.contains('reduced-motion')) {
            return false;
        }
        const shown = [...document.querySelectorAll('[data-sb-art-motion]')].some((figure) => {
            const box = figure.getBoundingClientRect();
            if (box.width === 0 || box.height === 0 || box.bottom <= 0 || box.right <= 0 || box.top >= innerHeight || box.left >= innerWidth) {
                return false;
            }
            const top = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, box.left + box.width / 2)), Math.min(innerHeight - 1, Math.max(0, box.top + box.height / 2)));
            return Boolean(top) && figure.contains(top);
        });
        if (!shown && !always) {
            return false;
        }
        document.body.classList.add('reduced-motion');
        return true;
    }, { always: mode === 'always' });
    if (!hold) {
        return none;
    }
    let note = null;
    await page.waitForFunction(() => !document.querySelector('[data-sb-art-motion="playing"]'), null, { timeout: WAIT_LIMIT_MS }).catch(() => {
        note = `an art figure was still playing after ${WAIT_LIMIT_MS} ms`;
    });
    return { held: true, note, release: async () => { await page.evaluate(() => document.body.classList.remove('reduced-motion')).catch(() => {}); } };
}

/**
 * The masks of a surface that apply to what is on show, decided for each element that a mask selector matches: the sample points
 * (centre and corners, inside the window) are tested with `elementFromPoint`, and `maskDropReason` decides. The elements that stay
 * get an attribute for the length of one screenshot and are masked by it, so a second match that is covered does not blank what
 * is on top of it. Returns the locator to mask, what was applied and dropped (selector, number of elements, reason), and `release`.
 * @param {import('@playwright/test').Page} page
 * @param {readonly string[]} selectors
 * @returns {Promise<{ locators: import('@playwright/test').Locator[], report: { applied: { selector: string, count: number }[], dropped: { selector: string, count: number, reason: string }[] }, release: () => Promise<void> }>}
 */
export async function tagMasks(page, selectors) {
    const viewport = page.viewportSize();
    const report = { applied: [], dropped: [] };
    for (const selector of selectors) {
        const measured = await page.locator(selector).evaluateAll((elements, size) => elements.map((element) => {
            const rect = element.getBoundingClientRect();
            // `elementFromPoint` skips what has `pointer-events: none`, so it cannot say whether such an element is covered.
            const untestable = getComputedStyle(element).pointerEvents === 'none';
            const points = [[0.5, 0.5], [0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [
                Math.min(size.width - 1, Math.max(0, Math.round(rect.left + (rect.width - 1) * u))),
                Math.min(size.height - 1, Math.max(0, Math.round(rect.top + (rect.height - 1) * v))),
            ]);
            const hits = untestable ? [] : points
                .filter(([x, y]) => x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1)
                .map(([x, y]) => {
                    const top = document.elementFromPoint(x, y);
                    return Boolean(top) && (top === element || element.contains(top));
                });
            return { box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, hits };
        }), viewport);
        const reasons = measured.map(info => maskDropReason(info, viewport));
        const keep = reasons.map(reason => reason === null);
        if (keep.some(Boolean)) {
            await page.locator(selector).evaluateAll((elements, flags) => elements.forEach((element, index) => {
                if (flags[index]) {
                    element.setAttribute('data-sb-capture-mask', '');
                }
            }), keep);
            report.applied.push({ selector, count: keep.filter(Boolean).length });
        }
        for (const reason of new Set(reasons.filter(Boolean))) {
            report.dropped.push({ selector, count: reasons.filter(candidate => candidate === reason).length, reason });
        }
        if (measured.length === 0) {
            report.dropped.push({ selector, count: 0, reason: 'nothing matches' });
        }
    }
    return {
        locators: report.applied.length ? [page.locator('[data-sb-capture-mask]')] : [],
        report,
        release: () => page.evaluate(() => document.querySelectorAll('[data-sb-capture-mask]').forEach(element => element.removeAttribute('data-sb-capture-mask'))).catch(() => {}),
    };
}

/**
 * The boxes of every visible match of the root of a surface in the window, with the corner radius of each, from Playwright
 * (which resolves the selector syntax of a root). Empty when nothing matches or nothing has a box.
 * @param {import('@playwright/test').Page} page
 * @param {string} root
 * @returns {Promise<{ x: number, y: number, width: number, height: number, radius: number }[]>}
 */
export function measureRoots(page, root) {
    return page.locator(root).evaluateAll(elements => elements.map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const radiusOf = (node) => {
            const box = node.getBoundingClientRect();
            const nodeStyle = getComputedStyle(node);
            const corner = (value) => {
                const first = String(value).trim().split(/\s+/)[0];
                const number = Number.parseFloat(first);
                return Number.isFinite(number) ? (first.endsWith('%') ? (number / 100) * Math.min(box.width, box.height) : number) : 0;
            };
            return Math.max(corner(nodeStyle.borderTopLeftRadius), corner(nodeStyle.borderTopRightRadius), corner(nodeStyle.borderBottomLeftRadius), corner(nodeStyle.borderBottomRightRadius));
        };
        let radius = radiusOf(element);
        // An ancestor that ends where the root ends (a dialog around the list that fills it) rounds the root's corners too, and
        // the page behind shows in them.
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
            const outer = ancestor.getBoundingClientRect();
            const sharesSide = Math.abs(outer.left - rect.left) <= 2 || Math.abs(outer.right - rect.right) <= 2;
            const sharesEnd = Math.abs(outer.top - rect.top) <= 2 || Math.abs(outer.bottom - rect.bottom) <= 2;
            if (sharesSide && sharesEnd) {
                radius = Math.max(radius, radiusOf(ancestor));
            }
        }
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, radius: Math.round(radius * 10) / 10, visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' };
    }).filter(box => box.visible).map(({ visible, ...box }) => box)); // eslint-disable-line no-unused-vars
}
