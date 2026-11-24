const warnedSuffixKeys = new Set();
const entityKinds = new Set(['character', 'group', 'tag', 'persona', 'background', 'conversation', 'agent', 'agent-template']);
const rowSlotOrder = ['grip', 'avatar', 'text', 'badge', 'suffix', 'chevron'];
const textSlotOrder = ['title', 'subtitle', 'preview', 'tags'];
const tagStrips = new WeakMap();
const stripWeakRefs = new WeakMap();
const observedStripRefs = new Set();
const stripFinalizers = typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry(ref => observedStripRefs.delete(ref))
    : null;
const overflowWidthCache = new Map();
let tagStripObserver = null;
let tagStripObserverConstructor = null;
let fontRefitFrame = 0;
let fontListenerBound = false;
const slotClasses = {
    row: ['ds-entity-row'],
    grip: ['ds-entity-row__grip'],
    avatar: ['ds-entity-row__avatar'],
    text: ['ds-entity-row__text'],
    title: ['ds-entity-row__title'],
    subtitle: ['ds-entity-row__subtitle'],
    preview: ['ds-entity-row__preview'],
    tags: ['ds-entity-row__tags', 'ds-tag-chips'],
    badge: ['ds-entity-row__badge'],
    suffix: ['ds-entity-row__suffix'],
    chevron: ['ds-entity-row__chevron', 'fa-solid', 'fa-chevron-right'],
};

/** @typedef {'row'|'avatar'|'text'|'title'|'subtitle'|'preview'|'tags'|'badge'|'suffix'} CompatSlot */
/**
 * @typedef {object} EntityRowOptions
 * @property {string} key Stable namespaced entity key.
 * @property {string} label Accessible name and default title.
 * @property {string|Node|null} [title] Defaults to label when omitted.
 * @property {string|Node|Node[]|null} [subtitle]
 * @property {string|Node|Node[]|null} [preview] Body excerpt under the subtitle; callers clamp its height in CSS.
 * @property {{ src: string, alt?: string }|Node|null} [avatar]
 * @property {boolean} [grip=false]
 * @property {boolean} [tags=false]
 * @property {Node[]} [badges=[]]
 * @property {Node[]} [suffix=[]]
 * @property {'none'|'activate'|'navigate'} [activation='none'] Use 'navigate' (chevron) only when leaving the current view; opening a detail pane in the same view uses 'activate'.
 * @property {Partial<Record<CompatSlot, string[]>>} [compatClasses]
 * @property {Record<string, string|null>} [attributes]
 */
/**
 * @typedef {object} EntityRow
 * @property {HTMLDivElement} row
 * @property {{ grip: HTMLElement|null, avatar: HTMLElement|null, img: HTMLImageElement|null,
 *   text: HTMLElement, title: HTMLElement, subtitle: HTMLElement|null, preview: HTMLElement|null, tags: HTMLElement|null,
 *   badge: HTMLElement|null, suffix: HTMLElement|null, chevron: HTMLElement|null }} slots
 * @property {(partial: Partial<Omit<EntityRowOptions, 'key'|'activation'>>) => void} update
 */

function setAttribute(element, name, value) {
    if (element.getAttribute(name) === value) return;
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
}

function setContent(element, content) {
    if (typeof content === 'string') {
        if (element.childNodes.length === 1 && element.firstChild.nodeType === Node.TEXT_NODE) {
            if (element.firstChild.nodeValue !== content) element.firstChild.nodeValue = content;
        } else {
            element.textContent = content;
        }
        return;
    }
    const nodes = content == null ? [] : Array.isArray(content) ? content : [content];
    let cursor = element.firstChild;
    for (const node of nodes) {
        if (node === cursor) cursor = cursor.nextSibling;
        else element.insertBefore(node, cursor);
    }
    while (cursor) {
        const next = cursor.nextSibling;
        cursor.remove();
        cursor = next;
    }
}

/** Shared selector for entity rows. @type {string} */
export const ENTITY_ROW_SELECTOR = '.ds-entity-row';

/**
 * Returns the stable entity key used by list motion.
 * @param {HTMLElement} element
 * @returns {string|undefined}
 */
export const entityRowMotionKey = element => element.dataset.sbListKey;

/**
 * Builds a namespaced key for a supported entity kind.
 * @param {'character'|'group'|'tag'|'persona'|'background'|'conversation'|'agent'|'agent-template'} kind
 * @param {string|number} id
 * @returns {string}
 */
export function entityKey(kind, id) {
    if (!entityKinds.has(kind)) throw new TypeError(`Unsupported entity kind: ${kind}`);
    return `${kind}:${id}`;
}

function createTagOverflow(count) {
    const overflow = document.createElement('span');
    overflow.className = 'tag sb-tag-overflow';
    overflow.textContent = `+${count}`;
    return overflow;
}

function applyTagLimit(container, { chips, names, overflow }, visibleCount) {
    visibleCount = Math.min(visibleCount, chips.length);
    for (const [index, chip] of chips.entries()) chip.hidden = index >= visibleCount;
    const hiddenNames = names.slice(visibleCount);
    if (!hiddenNames.length) {
        overflow.remove();
        return;
    }
    overflow.textContent = `+${hiddenNames.length}`;
    const label = hiddenNames.join(', ');
    overflow.title = label;
    overflow.setAttribute('aria-label', label);
    container.append(overflow);
}

function unobserveStrip(container) {
    tagStripObserver?.unobserve(container);
    const ref = stripWeakRefs.get(container);
    if (ref) {
        observedStripRefs.delete(ref);
        stripWeakRefs.delete(container);
        stripFinalizers?.unregister(container);
    }
    tagStrips.delete(container);
}

function pruneDisconnectedStrips() {
    for (const ref of observedStripRefs) {
        const container = ref.deref();
        if (!container) {
            observedStripRefs.delete(ref);
            continue;
        }
        const strip = tagStrips.get(container);
        if (!strip || (strip.wasConnected && !container.isConnected)) {
            unobserveStrip(container);
        }
    }
}

/**
 * Releases ResizeObserver tracking for a tag strip or every tag strip inside a row.
 * @param {Element|null|undefined} root
 */
export function releaseTagChips(root) {
    if (!(root instanceof Element)) return;
    if (root instanceof HTMLElement && tagStrips.has(root)) {
        unobserveStrip(root);
    }
    for (const child of root.querySelectorAll('.ds-entity-row__tags')) {
        if (child instanceof HTMLElement && tagStrips.has(child)) unobserveStrip(child);
    }
}

/**
 * Prunes disconnected strips and returns the active observed strip count.
 * @returns {number}
 */
export function getObservedTagStripCount() {
    pruneDisconnectedStrips();
    let count = 0;
    for (const ref of observedStripRefs) {
        if (ref.deref()) count++;
        else observedStripRefs.delete(ref);
    }
    return count;
}

function fitTagStrips(entries) {
    const pending = [];
    const uncachedDigits = new Map();
    for (const { target: container, contentRect } of entries) {
        const strip = tagStrips.get(container);
        if (!strip || !container.isConnected) {
            unobserveStrip(container);
            continue;
        }
        strip.wasConnected = true;
        const width = contentRect.width;
        if (width <= 0 || strip.width === width) continue;
        strip.width = width;
        const candidates = strip.chips.slice(0, strip.max);
        if (strip.chipWidths === null) {
            for (const chip of candidates) chip.hidden = false;
        }
        // Cache overflow badge widths by digit count across strips, including +10 → +9 boundaries.
        for (let visible = 0; visible <= candidates.length; visible++) {
            const hidden = strip.names.length - visible;
            if (!hidden) continue;
            const digits = String(hidden).length;
            if (overflowWidthCache.has(digits) || uncachedDigits.has(digits)) continue;
            const probe = createTagOverflow(hidden);
            probe.classList.add('sb-tag-overflow--measure');
            probe.setAttribute('aria-hidden', 'true');
            container.append(probe);
            uncachedDigits.set(digits, probe);
        }
        pending.push({ container, strip, width, candidates });
    }

    // All strips are prepared before any layout reads, and all reads precede final hiding.
    for (const { container, strip, candidates } of pending) {
        if (strip.chipWidths === null) {
            strip.gap = parseFloat(getComputedStyle(container).columnGap) || 0;
            strip.chipWidths = candidates.map(chip => chip.getBoundingClientRect().width);
        }
    }
    for (const [digits, probe] of uncachedDigits) {
        overflowWidthCache.set(digits, probe.getBoundingClientRect().width);
    }
    for (const probe of uncachedDigits.values()) probe.remove();

    for (const { container, strip, width } of pending) {
        const { chipWidths, gap } = strip;
        let visibleCount = 0;
        let usedWidth = 0;
        for (let visible = 1; visible <= chipWidths.length; visible++) {
            usedWidth += chipWidths[visible - 1] + (visible > 1 ? gap : 0);
            const hidden = strip.names.length - visible;
            const overflowWidth = hidden > 0 ? (overflowWidthCache.get(String(hidden).length) ?? 0) : 0;
            const requiredWidth = usedWidth + (hidden > 0 ? gap + overflowWidth : 0);
            if (requiredWidth <= width) visibleCount = visible;
        }
        applyTagLimit(container, strip, visibleCount);
    }
}

/**
 * Chips are fitted with the font that is loaded when the strip is measured. A web font that arrives later changes their
 * widths without changing the strip's, so every observed strip is measured again once fonts finish loading.
 */
function refitStripsAfterFontLoad() {
    if (fontRefitFrame) return;
    fontRefitFrame = requestAnimationFrame(() => {
        fontRefitFrame = 0;
        overflowWidthCache.clear();
        for (const ref of observedStripRefs) {
            const container = ref.deref();
            if (!container) {
                observedStripRefs.delete(ref);
                continue;
            }
            const strip = tagStrips.get(container);
            if (!strip || !container.isConnected) {
                unobserveStrip(container);
                continue;
            }
            strip.width = null;
            strip.chipWidths = null;
            strip.gap = 0;
            tagStripObserver.unobserve(container);
            tagStripObserver.observe(container);
        }
    });
}

/**
 * Shows at most `max` tag chips and one "+N" chip naming the hidden tags.
 * Fits whole chips lazily on layout/resize; without ResizeObserver, uses the fixed maximum.
 * Calling it again after the chips change recomputes and replaces the previous observation.
 * Full tag names in display order include tags omitted by the upstream render limit.
 * @param {HTMLElement} container The entity row's `.ds-entity-row__tags` slot.
 * @param {{ max?: number, fit?: boolean, allNames?: string[] }} [options] Defaults to three chips, fitted to the strip.
 */
export function limitTagChips(container, { max = 3, fit = true, allNames } = {}) {
    if (!(container instanceof HTMLElement)) throw new TypeError('Tag chips require an HTMLElement container.');
    if (!Number.isInteger(max) || max < 0) throw new RangeError('The visible tag limit must be a non-negative integer.');
    if (allNames !== undefined && (!Array.isArray(allNames) || !allNames.every(name => typeof name === 'string'))) {
        throw new TypeError('Full tag names must be an array of strings.');
    }

    pruneDisconnectedStrips();
    if (tagStrips.has(container)) {
        unobserveStrip(container);
    }
    const chips = [];
    for (const child of [...container.children]) {
        if (child.matches('.sb-tag-overflow')) child.remove();
        else if (child.matches('.placeholder-expander')) child.hidden = true;
        else if (child.matches('.tag')) chips.push(child);
    }
    const names = allNames ? [...allNames] : chips.map(chip => (chip.querySelector('.tag_name')?.textContent ?? chip.textContent).trim());
    const strip = {
        chips,
        names,
        max,
        overflow: createTagOverflow(0),
        width: null,
        chipWidths: null,
        gap: 0,
        wasConnected: container.isConnected,
    };
    applyTagLimit(container, strip, max);
    if (!fit || !chips.length || max === 0 || typeof ResizeObserver !== 'function') return;
    if (!tagStripObserver || tagStripObserverConstructor !== ResizeObserver) {
        tagStripObserver = new ResizeObserver(fitTagStrips);
        tagStripObserverConstructor = ResizeObserver;
        overflowWidthCache.clear();
    }
    if (!fontListenerBound && document.fonts?.addEventListener) {
        fontListenerBound = true;
        document.fonts.addEventListener('loadingdone', refitStripsAfterFontLoad);
    }
    const ref = new WeakRef(container);
    tagStrips.set(container, strip);
    stripWeakRefs.set(container, ref);
    observedStripRefs.add(ref);
    stripFinalizers?.register(container, ref, container);
    tagStripObserver.observe(container);
}

/**
 * Creates an entity row without binding activation or sorting events.
 * @param {EntityRowOptions} options
 * @returns {EntityRow}
 */
export function createEntityRow(options) {
    const { key, activation = 'none' } = options;
    let label = options.label;
    let title;
    let compatClasses = {};

    function createSlot(name, tag = 'div') {
        const element = document.createElement(tag);
        element.classList.add(...slotClasses[name], ...(compatClasses[name] ?? []));
        return element;
    }

    const row = createSlot('row');
    row.setAttribute('role', 'listitem');
    row.dataset.sbListKey = key;
    const slots = {
        grip: null,
        avatar: null,
        img: null,
        text: createSlot('text'),
        title: createSlot('title'),
        subtitle: null,
        preview: null,
        tags: null,
        badge: null,
        suffix: null,
        chevron: null,
    };
    slots.text.append(slots.title);
    row.append(slots.text);

    function setSlot(name, present) {
        if (!present) {
            slots[name]?.remove();
            slots[name] = null;
            return null;
        }
        if (slots[name]) return slots[name];
        const element = createSlot(name, name === 'chevron' ? 'i' : 'div');
        const order = textSlotOrder.includes(name) ? textSlotOrder : rowSlotOrder;
        const parent = order === textSlotOrder ? slots.text : row;
        const following = order.slice(order.indexOf(name) + 1).map(slot => slots[slot]).find(Boolean);
        parent.insertBefore(element, following ?? null);
        slots[name] = element;
        return element;
    }

    function setAvatar(avatar) {
        const container = setSlot('avatar', avatar != null);
        if (!container) {
            slots.img = null;
            return;
        }
        if (avatar instanceof Node) {
            setContent(container, avatar);
            slots.img = null;
            return;
        }
        if (!slots.img) {
            slots.img = document.createElement('img');
            slots.img.setAttribute('loading', 'lazy');
            slots.img.setAttribute('decoding', 'async');
            setContent(container, slots.img);
        }
        setAttribute(slots.img, 'src', avatar.src);
        setAttribute(slots.img, 'alt', avatar.alt ?? '');
    }

    function setCompatClasses(next) {
        for (const name of Object.keys(slotClasses)) {
            const element = name === 'row' ? row : slots[name];
            if (!element) continue;
            const previous = compatClasses[name] ?? [];
            const classes = next[name] ?? [];
            for (const className of previous) {
                if (!classes.includes(className) && !slotClasses[name].includes(className)) element.classList.remove(className);
            }
            for (const className of classes) {
                if (!element.classList.contains(className)) element.classList.add(className);
            }
        }
        compatClasses = Object.fromEntries(Object.entries(next).map(([name, classes]) => [name, [...classes]]));
    }

    function update(partial = {}) {
        if ('compatClasses' in partial) setCompatClasses(partial.compatClasses ?? {});
        if ('label' in partial) {
            label = partial.label;
            setAttribute(row, 'aria-label', label);
        }
        if ('title' in partial) title = partial.title;
        if ('label' in partial || 'title' in partial) setContent(slots.title, title === undefined ? label : title);
        if ('grip' in partial) {
            const grip = setSlot('grip', partial.grip);
            if (grip && !grip.hasChildNodes()) {
                grip.setAttribute('aria-hidden', 'true');
                const icon = document.createElement('i');
                icon.className = 'fa-solid fa-grip-vertical';
                grip.append(icon);
            }
        }
        if ('avatar' in partial) setAvatar(partial.avatar);
        if ('subtitle' in partial) {
            const subtitle = setSlot('subtitle', partial.subtitle != null);
            if (subtitle) setContent(subtitle, partial.subtitle);
        }
        if ('preview' in partial) {
            const preview = setSlot('preview', partial.preview != null);
            if (preview) setContent(preview, partial.preview);
        }
        if ('tags' in partial) setSlot('tags', partial.tags);
        if ('badges' in partial) {
            const badge = setSlot('badge', Boolean(partial.badges?.length));
            if (badge) setContent(badge, partial.badges);
        }
        if ('suffix' in partial) {
            const suffix = partial.suffix ?? [];
            if (suffix.length > 2 && !warnedSuffixKeys.has(key)) {
                warnedSuffixKeys.add(key);
                console.warn('Entity row suffix exceeds two controls:', key);
            }
            const container = setSlot('suffix', suffix.length > 0);
            if (container) setContent(container, suffix);
        }
        if ('attributes' in partial) {
            for (const [name, value] of Object.entries(partial.attributes ?? {})) setAttribute(row, name, value);
        }
    }

    if (activation === 'activate' || activation === 'navigate') {
        row.tabIndex = 0;
        row.classList.add('ds-entity-row--activatable');
    }
    if (activation === 'navigate') setSlot('chevron', true).setAttribute('aria-hidden', 'true');
    update(options);
    return { row, slots, update };
}
