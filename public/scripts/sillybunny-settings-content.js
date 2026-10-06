/**
 * SillyBunny settings content split (feat/v1.9.0-ui-overhaul, Phases 6A and 6B).
 *
 * The Customize section hosts three sidebar tabs — Appearance, Interface, and Messages — that
 * previously shared the single `#user-settings-block` markup, moved between panels on every tab
 * switch. Each phase extracts one tab's content into its own permanent container, leaving what
 * remains in a shared block that the not-yet-split tabs still route.
 *
 * Sections are relocated with `appendChild`, which preserves node identity, so event handlers,
 * jQuery data, and SillyTavern's own settings bindings survive the move. Nothing is cloned and no
 * markup is authored here.
 */

export const SB_USER_SETTINGS_CONTAINER_IDS = Object.freeze({
    appearance: 'sb-appearance-content',
    interface: 'sb-interface-content',
    messages: 'sb-messages-content',
});

/**
 * Streaming and sound controls lifted out of `[name="MiscellaneousToggles"]`.
 *
 * They are listed individually rather than as one group because the group also holds Interface
 * toggles, and they stay in this order because `toggle-dependent.css` hides the speed and no-think
 * controls with sibling combinators off `#smooth_streaming_control` -- moving them apart would
 * silently stop that progressive disclosure from working.
 */
const SB_STREAMING_CONTROL_IDS = Object.freeze([
    'smooth_streaming_control',
    'smooth_streaming_no_think_control',
    'smooth_streaming_speed_control',
    'stream_fade_in',
]);

/**
 * Sections owned by each tab, applied in the order listed.
 *
 * 6A populated Appearance: the first column is taken whole, which carries
 * `#SillyTavernImportSection` and `#AppearanceSection` with it, and the two code editors are pulled
 * out of the power-user column separately because they are authored far from the rest of the
 * appearance stack.
 *
 * 6B populates Messages. `[name="CharacterHandlingToggles"]` and `#ChatMessageHandlingSection` move
 * whole, but `[name="MiscellaneousToggles"]` cannot: it interleaves message and stream controls
 * with Interface-only toggles in one group, so it is dismantled and only the message-related
 * children are taken. What is left behind stays for 6C to claim.
 */
const SB_SETTINGS_TAB_SECTIONS = Object.freeze({
    appearance: Object.freeze([
        '[name="UserSettingsFirstColumn"]',
        '#CustomCSS-block',
        '#GoogleFont-block',
    ]),
    messages: Object.freeze([
        '[name="CharacterHandlingToggles"]',
        '#ChatMessageHandlingSection',
        ...SB_STREAMING_CONTROL_IDS.map(id => `#${id}`),
        '[name="IOSWebKitStreamingToggles"]',
        '[name="AndroidStreamingToggles"]',
        '[name="AggressiveDomUnloadToggles"]',
        '#play_message_sound',
        '#play_sound_unfocused',
    ]),
});

/** Selectors that resolve to a checkbox but whose row is the element worth moving. */
const SB_CONTROL_ROW_SELECTORS = Object.freeze([
    '#stream_fade_in',
    '#play_message_sound',
    '#play_sound_unfocused',
]);

/** Sections that must end up in their tab; a failed move is reported rather than silent. */
const SB_REQUIRED_SECTIONS = Object.freeze({
    appearance: Object.freeze(['AppearanceSection', 'CustomCSS-block', 'GoogleFont-block']),
    messages: Object.freeze([
        'CharacterHandlingToggles',
        'ChatMessageHandlingSection',
        'smooth_streaming_control',
        'smooth_streaming_speed_control',
        'smooth_streaming_no_think_control',
        'IOSWebKitStreamingToggles',
        'AndroidStreamingToggles',
        'AggressiveDomUnloadToggles',
        'play_message_sound',
        'play_sound_unfocused',
    ]),
});

/**
 * Detaches an element from its current parent so it can be placed without being duplicated and
 * without disturbing the order of what it was nested in.
 * @param {Element|null|undefined} element
 * @returns {HTMLElement|null}
 */
function detach(element) {
    if (!(element instanceof HTMLElement)) {
        return null;
    }
    element.remove();
    return element;
}

/**
 * Resolves a section selector to the element that should actually move.
 *
 * Most selectors name the section directly. The streaming and sound controls resolve to a checkbox
 * inside a `<label class="checkbox_label">`, and it is the label that reads as a settings row, so
 * the closest one is returned instead -- moving the bare input would strand its label text.
 *
 * @param {HTMLElement} contentBlock
 * @param {string} selector
 * @returns {HTMLElement|null}
 */
function resolveSectionTarget(contentBlock, selector) {
    const found = contentBlock.querySelector(selector);
    if (!found) {
        return null;
    }

    if (SB_CONTROL_ROW_SELECTORS.includes(selector)) {
        return found.closest('.checkbox_label') ?? found;
    }

    return found;
}

/**
 * Creates the tab containers and moves each tab's sections into its own.
 *
 * Resolution happens against the original content block before anything is appended, so a section
 * is detached before its container moves and the two stay independent. The remaining sections are
 * left exactly where they were authored; the caller keeps mounting that shared block for the tabs
 * that still rely on it.
 *
 * @param {HTMLElement} originalContent wrapper holding the original settings markup
 * @returns {{appearance: HTMLElement, interface: HTMLElement, messages: HTMLElement, missing: string[]}|null}
 */
export function splitUserSettingsContent(originalContent) {
    const contentBlock = originalContent?.querySelector?.('#user-settings-block-content');
    if (!(contentBlock instanceof HTMLElement)) {
        return null;
    }

    const containers = {};
    for (const [tabId, containerId] of Object.entries(SB_USER_SETTINGS_CONTAINER_IDS)) {
        const container = document.createElement('div');
        container.id = containerId;
        container.className = 'sb-settings-tab-content';
        container.dataset.sbSettingsTab = tabId;
        containers[tabId] = container;
    }

    for (const [tabId, selectors] of Object.entries(SB_SETTINGS_TAB_SECTIONS)) {
        for (const selector of selectors) {
            const section = detach(resolveSectionTarget(contentBlock, selector));
            if (section) {
                containers[tabId].appendChild(section);
            }
        }
    }

    const missing = [];
    for (const [tabId, sectionIds] of Object.entries(SB_REQUIRED_SECTIONS)) {
        const container = containers[tabId];
        for (const sectionId of sectionIds) {
            const found = container.querySelector(`#${CSS.escape(sectionId)}`)
                ?? container.querySelector(`[name="${sectionId}"]`);
            if (!found) {
                missing.push(`${tabId}:${sectionId}`);
            }
        }
    }

    if (missing.length > 0) {
        console.error('[SillyBunny] Settings split did not place every section:', missing.join(', '));
    }

    return {
        appearance: containers.appearance,
        interface: containers.interface,
        messages: containers.messages,
        missing,
    };
}
