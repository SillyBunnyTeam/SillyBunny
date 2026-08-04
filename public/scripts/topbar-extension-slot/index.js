export const TOPBAR_EXTENSION_SLOT_ID = 'sb-topbar-extension-slot';

export const TOPBAR_ADOPTION_ATTRIBUTE = 'data-sb-topbar-adopt';

export const TOPBAR_ADOPTED_MARKER_ATTRIBUTE = 'data-sb-topbar-adopted';

/**
 * The nine upstream drawers that live in #top-settings-holder. SillyBunny relocates or
 * ghost-hides each of them, so they must never be treated as third-party markup. The same
 * nine ids are enumerated in the hide/inert rules in sillybunny-tabs.css; keep both in sync.
 */
export const TOPBAR_NATIVE_DRAWER_IDS = Object.freeze([
    'ai-config-button',
    'sys-settings-button',
    'advanced-formatting-button',
    'WI-SP-button',
    'user-settings-button',
    'backgrounds-button',
    'extensions-settings-button',
    'persona-management-button',
    'rightNavHolder',
]);

/** Tags that are never buttons, so adopting them into the bar would only break layout. */
export const TOPBAR_ADOPTION_EXCLUDED_TAGS = Object.freeze([
    'SCRIPT',
    'STYLE',
    'TEMPLATE',
    'LINK',
    'META',
    'DIALOG',
]);

/**
 * Panels an extension parked in the top strip rather than a control. These are positioned
 * against the strip and would be mangled by the slot's flex layout.
 */
export const TOPBAR_ADOPTION_EXCLUDED_CLASSES = Object.freeze([
    'drawer-content',
    'popup',
    'popup-holder',
]);

export const TOPBAR_ADOPTION_SKIP_REASON = Object.freeze({
    NOT_ELEMENT: 'not-element',
    NATIVE_DRAWER: 'native-drawer',
    SILLYBUNNY_OWNED: 'sillybunny-owned',
    OPTED_OUT: 'opted-out',
    EXCLUDED_TAG: 'excluded-tag',
    EXCLUDED_CLASS: 'excluded-class',
});

function normalizeClassNames(classNames) {
    if (Array.isArray(classNames)) {
        return classNames.map(name => String(name));
    }

    return String(classNames || '').split(/\s+/).filter(Boolean);
}

/**
 * Checks whether an element id belongs to one of the upstream top-bar drawers.
 * @param {unknown} id Element id.
 * @returns {boolean} True when the id is a native drawer.
 */
export function isNativeTopbarDrawerId(id) {
    return TOPBAR_NATIVE_DRAWER_IDS.includes(String(id || ''));
}

/**
 * Decides whether a node found in #top-bar or #top-settings-holder should be adopted into
 * the SillyBunny top bar's extension slot.
 * @param {object} descriptor Descriptor produced by describeTopbarNode().
 * @param {boolean} [descriptor.isElement=false] Whether the node is an Element.
 * @param {string} [descriptor.id=''] Element id.
 * @param {string} [descriptor.tagName=''] Uppercase tag name.
 * @param {string|string[]} [descriptor.classNames=[]] Class list.
 * @param {string|null} [descriptor.adoptAttribute=null] Value of data-sb-topbar-adopt.
 * @param {boolean} [descriptor.isSillyBunnyOwned=false] Whether SillyBunny created the node.
 * @returns {{shouldAdopt: boolean, reason: string}} Verdict and, when skipped, why.
 */
export function resolveTopbarNodeAdoption({
    isElement = false,
    id = '',
    tagName = '',
    classNames = [],
    adoptAttribute = null,
    isSillyBunnyOwned = false,
} = {}) {
    if (!isElement) {
        return { shouldAdopt: false, reason: TOPBAR_ADOPTION_SKIP_REASON.NOT_ELEMENT };
    }

    const normalizedAdoptAttribute = adoptAttribute === null || adoptAttribute === undefined
        ? null
        : String(adoptAttribute).trim().toLowerCase();

    if (normalizedAdoptAttribute === 'false') {
        return { shouldAdopt: false, reason: TOPBAR_ADOPTION_SKIP_REASON.OPTED_OUT };
    }

    if (isNativeTopbarDrawerId(id)) {
        return { shouldAdopt: false, reason: TOPBAR_ADOPTION_SKIP_REASON.NATIVE_DRAWER };
    }

    if (isSillyBunnyOwned) {
        return { shouldAdopt: false, reason: TOPBAR_ADOPTION_SKIP_REASON.SILLYBUNNY_OWNED };
    }

    // An explicit opt-in overrides only the heuristic exclusions below; an extension cannot
    // claim a native drawer or one of our own elements.
    if (normalizedAdoptAttribute === 'true') {
        return { shouldAdopt: true, reason: '' };
    }

    if (TOPBAR_ADOPTION_EXCLUDED_TAGS.includes(String(tagName || '').toUpperCase())) {
        return { shouldAdopt: false, reason: TOPBAR_ADOPTION_SKIP_REASON.EXCLUDED_TAG };
    }

    const names = normalizeClassNames(classNames);

    if (names.some(name => TOPBAR_ADOPTION_EXCLUDED_CLASSES.includes(name))) {
        return { shouldAdopt: false, reason: TOPBAR_ADOPTION_SKIP_REASON.EXCLUDED_CLASS };
    }

    return { shouldAdopt: true, reason: '' };
}

/**
 * Builds the adoption plan for one pass. Nodes already parented by the slot are omitted, which
 * is what makes repeated passes terminate instead of re-appending their own work forever.
 * @param {object} options Options.
 * @param {Array<object>} [options.nodes=[]] Descriptors, each carrying a stable `key`.
 * @param {Iterable<string>} [options.slotChildKeys=[]] Keys already parented by the slot.
 * @returns {{adoptKeys: string[], skipped: Array<{key: string, reason: string}>}} Plan.
 */
export function resolveTopbarAdoptionPlan({ nodes = [], slotChildKeys = [] } = {}) {
    const presentKeys = new Set(Array.from(slotChildKeys, key => String(key)));
    const adoptKeys = [];
    const skipped = [];

    for (const node of nodes) {
        const key = String(node?.key ?? '');
        const verdict = resolveTopbarNodeAdoption(node);

        if (!verdict.shouldAdopt) {
            skipped.push({ key, reason: verdict.reason });
            continue;
        }

        if (presentKeys.has(key)) {
            continue;
        }

        presentKeys.add(key);
        adoptKeys.push(key);
    }

    return { adoptKeys, skipped };
}

/**
 * Plans the mirror of extension badges from the ghosted native Characters icon onto the visible
 * proxy button. Extensions append their badge unconditionally on every setup pass, so older
 * copies with the same signature are dropped rather than stacking.
 * @param {object} options Options.
 * @param {Array<object>} [options.iconBadges=[]] Descriptors of children of #rightNavDrawerIcon.
 * @param {Array<object>} [options.hostBadges=[]] Descriptors of already mirrored badges.
 * @returns {{moveKeys: string[], removeKeys: string[]}} Keys to move and stale keys to drop.
 */
export function resolveCharacterBadgeMirrorPlan({ iconBadges = [], hostBadges = [] } = {}) {
    const moveKeys = [];
    const newest = new Map();
    const removeKeys = [];

    for (const badge of hostBadges) {
        const signature = String(badge?.signature ?? '');
        const key = String(badge?.key ?? '');

        if (newest.has(signature)) {
            removeKeys.push(newest.get(signature));
        }

        newest.set(signature, key);
    }

    for (const badge of iconBadges) {
        if (!resolveTopbarNodeAdoption(badge).shouldAdopt) {
            continue;
        }

        const signature = String(badge?.signature ?? '');
        const key = String(badge?.key ?? '');

        if (newest.has(signature)) {
            removeKeys.push(newest.get(signature));
        }

        newest.set(signature, key);
        moveKeys.push(key);
    }

    return { moveKeys, removeKeys };
}
