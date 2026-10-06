/**
 * SillyBunny settings content split (feat/v1.9.0-ui-overhaul, Phases 6A, 6B and 6C).
 *
 * The Customize section hosts three sidebar tabs — Appearance, Interface, and Messages — that
 * previously shared the single `#user-settings-block` markup, moved between panels on every tab
 * switch. Each phase extracts one tab's content into its own permanent container; 6C moves the
 * last share, so after the split the legacy block holds no settings and is left unpainted.
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
 * Container for content that is lifted out of the settings block but belongs to the Data &
 * Security tab rather than to one of the three Customize tabs.
 *
 * It is owned by the same split so the move happens in one place with the rest of the relocation,
 * but its panel is built on demand by `sillybunny-server-tools.js`, which adopts the container
 * instead of being handed it. Import and restore write to the account's data paths and replace
 * saved files, so it belongs with the other data-management controls, not with Appearance.
 */
export const SB_DATA_SECURITY_CONTAINER_ID = 'sb-data-security-content';

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
 * 6A populated Appearance: the first column is taken whole, which carries `#AppearanceSection`
 * with it, and the two code editors are pulled out of the power-user column separately because
 * they are authored far from the rest of the appearance stack. `#SillyTavernImportSection` is
 * authored in that same first column and is moved out to Data & Security first, so it is not
 * carried into Appearance by the column move.
 *
 * 6B populates Messages. `[name="CharacterHandlingToggles"]` and `#ChatMessageHandlingSection` move
 * whole, but `[name="MiscellaneousToggles"]` cannot: it interleaves message and stream controls
 * with Interface-only toggles in one group, so it is dismantled and only the message-related
 * children are taken. What is left behind stays for 6C to claim.
 *
 * 6C populates Interface with everything remaining, so the order of the keys matters: Appearance and
 * Messages both reach inside subtrees that Interface takes whole (`#CustomCSS-block` and
 * `#GoogleFont-block` live under `#power-user-options-block`), so they have to run first.
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
    interface: Object.freeze([
        '[name="MiscellaneousToggles"]',
        '#power-user-options-block',
    ]),
});

/**
 * Header-adjacent controls that describe the server or the account rather than the UI shell.
 *
 * They are authored in `#user-settings-block`'s header rows because that is where the markup
 * happened to sit, but Language, Account, Version, and the cache controls all act on saved data or
 * the backend, so they read as Data & Security content. They move in this order, ahead of Import &
 * Restore, so that tab opens on Language -> Account -> Version -> Clear cache -> Import.
 */
const SB_DATA_SECURITY_SECTIONS = Object.freeze([
    '#UI-language-block',
    '#account_controls',
    '#version_display',
    '#user-settings-utility-actions',
]);

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
    interface: Object.freeze([
        'MiscellaneousToggles',
        'power-user-options-block',
    ]),
});

/** Sections that must end up on Data & Security; see `SB_DATA_SECURITY_SECTIONS`. */
const SB_DATA_SECURITY_REQUIRED_SECTIONS = Object.freeze([
    'UI-language-block',
    'account_controls',
    'version_display',
    'user-settings-utility-actions',
]);

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
 * @param {HTMLElement} scope element searched for the selector
 * @param {string} selector
 * @returns {HTMLElement|null}
 */
function resolveSectionTarget(scope, selector) {
    const found = scope.querySelector(selector);
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
 * Resolution happens against the whole original column, not just `#user-settings-block-content`:
 * the language, version and account controls live in the header rows and the cache controls are a
 * sibling of the block, so the narrower scope cannot see them. The block is still required to be
 * present, which keeps the wider scope honest when the markup it expects is missing.
 *
 * Everything is detached before it is appended, so a section is out of its old parent before its
 * new container is placed. Once every tab has run the block holds no settings; the caller is
 * responsible for leaving it in the document but unpainted.
 *
 * One section does not belong to any Customize tab: Import & Restore is authored inside the
 * Appearance column but manages saved data, so it is detached first and handed to the Data &
 * Security panel in its own container.
 *
 * @param {HTMLElement} originalContent wrapper holding the original settings markup
 * @returns {{appearance: HTMLElement, interface: HTMLElement, messages: HTMLElement, dataSecurity: HTMLElement, missing: string[]}|null}
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

    // Import & Restore is authored inside the Appearance column but writes to the account's data
    // paths, so it belongs with the other data-management controls on the Data & Security tab. It
    // is moved out of the column before the column itself moves, which keeps the relocation in one
    // place instead of giving the split a fourth destination in SB_USER_SETTINGS_CONTAINER_IDS.
    // The Data & Security panel adopts this container when it is built on demand.
    const dataSecurity = document.createElement('div');
    dataSecurity.id = SB_DATA_SECURITY_CONTAINER_ID;
    dataSecurity.className = 'sb-settings-tab-content sb-data-security-content';
    const importSection = detach(resolveSectionTarget(originalContent, '#SillyTavernImportSection'));
    for (const selector of SB_DATA_SECURITY_SECTIONS) {
        const section = detach(resolveSectionTarget(originalContent, selector));
        if (section) {
            dataSecurity.appendChild(section);
        }
    }
    if (importSection) {
        dataSecurity.appendChild(importSection);
    }

    for (const [tabId, selectors] of Object.entries(SB_SETTINGS_TAB_SECTIONS)) {
        for (const selector of selectors) {
            const section = detach(resolveSectionTarget(originalContent, selector));
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

    for (const sectionId of SB_DATA_SECURITY_REQUIRED_SECTIONS) {
        const found = dataSecurity.querySelector(`#${CSS.escape(sectionId)}`);
        if (!found) {
            missing.push(`data-security:${sectionId}`);
        }
    }

    if (!importSection) {
        missing.push('data-security:SillyTavernImportSection');
    }

    if (missing.length > 0) {
        console.error('[SillyBunny] Settings split did not place every section:', missing.join(', '));
    }

    return {
        appearance: containers.appearance,
        interface: containers.interface,
        messages: containers.messages,
        dataSecurity,
        missing,
    };
}
