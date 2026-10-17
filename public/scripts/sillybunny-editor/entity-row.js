const warnedSuffixKeys = new Set();
const entityKinds = new Set(['character', 'group', 'tag', 'persona']);
const rowSlotOrder = ['grip', 'avatar', 'text', 'badge', 'suffix', 'chevron'];
const textSlotOrder = ['title', 'subtitle', 'tags'];
const slotClasses = {
    row: ['ds-entity-row'],
    grip: ['ds-entity-row__grip'],
    avatar: ['ds-entity-row__avatar'],
    text: ['ds-entity-row__text'],
    title: ['ds-entity-row__title'],
    subtitle: ['ds-entity-row__subtitle'],
    tags: ['ds-entity-row__tags', 'ds-tag-chips'],
    badge: ['ds-entity-row__badge'],
    suffix: ['ds-entity-row__suffix'],
    chevron: ['ds-entity-row__chevron', 'fa-solid', 'fa-chevron-right'],
};

/** @typedef {'row'|'avatar'|'text'|'title'|'subtitle'|'tags'|'badge'|'suffix'} CompatSlot */
/**
 * @typedef {object} EntityRowOptions
 * @property {string} key Stable namespaced entity key.
 * @property {string} label Accessible name and default title.
 * @property {string|Node|null} [title] Defaults to label when omitted.
 * @property {string|Node|Node[]|null} [subtitle]
 * @property {{ src: string, alt?: string }|Node|null} [avatar]
 * @property {boolean} [grip=false]
 * @property {boolean} [tags=false]
 * @property {Node[]} [badges=[]]
 * @property {Node[]} [suffix=[]]
 * @property {'none'|'activate'|'navigate'} [activation='none']
 * @property {Partial<Record<CompatSlot, string[]>>} [compatClasses]
 * @property {Record<string, string|null>} [attributes]
 */
/**
 * @typedef {object} EntityRow
 * @property {HTMLDivElement} row
 * @property {{ grip: HTMLElement|null, avatar: HTMLElement|null, img: HTMLImageElement|null,
 *   text: HTMLElement, title: HTMLElement, subtitle: HTMLElement|null, tags: HTMLElement|null,
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
 * @param {'character'|'group'|'tag'|'persona'} kind
 * @param {string|number} id
 * @returns {string}
 */
export function entityKey(kind, id) {
    if (!entityKinds.has(kind)) throw new TypeError(`Unsupported entity kind: ${kind}`);
    return `${kind}:${id}`;
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
