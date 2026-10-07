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
 * Class given to a drawer that has been unwrapped into a static subsection.
 *
 * It keeps the heading element, so search labels and reveal targeting still resolve a name for
 * controls inside it, but it is no longer a `.inline-drawer` and so is skipped by
 * `openAllInlineDrawers`, `getInlineDrawers`, and the drawer persistence scan.
 */
export const SB_FLAT_SECTION_CLASS = 'sb-settings-flat-section';

/** Heading element of a flattened subsection; carries the label the drawer header used to show. */
export const SB_FLAT_SECTION_HEADER_CLASS = 'sb-settings-flat-header';

/**
 * A flattened drawer that was a section in its own right rather than a subsection of one.
 *
 * The two shapes need different metrics: a subsection sits under the card that held it and gets a
 * compact 33px label, while a section is the top of its own hierarchy and keeps the two-line
 * 52-60px header with its description line. The class is what lets the stylesheet tell them apart,
 * since after flattening both are `.sb-settings-flat-section` with a `.sb-settings-flat-header`.
 */
export const SB_FLAT_SECTION_TOP_CLASS = 'sb-settings-flat-section-top';

/** Classes removed from a nested drawer's header when it stops being a toggle. */
const SB_FLAT_SECTION_HEADER_CLASSES = Object.freeze([
    'inline-drawer-toggle',
    'inline-drawer-header',
    'settings-section-header',
    'userSettingsInnerExpandable',
]);

/**
 * Unwraps collapsible drawers into always-visible sections and subsections.
 *
 * Two modes, both keeping the header element so search still resolves a name for the controls
 * inside:
 *
 * - `nested` (default) flattens only a drawer that sits inside another drawer. Layer 4 allows a
 *   sub-category at most one collapsible section (PRODUCT.md, DESIGN.md), so a drawer inside a
 *   drawer is the concrete violation this removes. The outermost drawer of each nest keeps its
 *   toggle, which is why the work is driven by ancestry rather than by depth from the root.
 * - `all` also flattens the outermost drawer. 6F uses this for Backend and Customize, where no
 *   setting may hide behind a click; Extensions opts out because each of its drawers is an
 *   independently-authored block that is a purposeful selection rather than a stray accordion.
 *
 * The transform moves nodes with `insertBefore`/`appendChild` -- never `cloneNode` and never
 * `innerHTML` -- so input bindings, jQuery data, and SillyTavern's own listeners stay attached.
 * The content wrapper is dropped after its children have been lifted out, because the base
 * `.inline-drawer-content` rule is `display: none` and a wrapper that no longer has a toggle to
 * reveal it would hide the settings it holds.
 *
 * Flattening is idempotent: a flattened drawer has no content wrapper, so it is skipped on any
 * later run. That matters because some drawers are authored at runtime (`#sb-openai-output` builds
 * its own subsections after load), so this runs again on each tab activation.
 *
 * @param {HTMLElement|null|undefined} root subtree to flatten
 * @param {{includeTopLevel?: boolean}} [options] flatten outermost drawers as well as nested ones
 * @returns {number} how many drawers were flattened
 */
export function flattenNestedSettingsDrawers(root, options = {}) {
    if (!(root instanceof HTMLElement)) {
        return 0;
    }

    const includeTopLevel = options.includeTopLevel === true;

    // Snapshot before mutating: the ancestry test needs to know which elements were drawers when
    // the walk started, and flattening removes that class from the ones already handled.
    const drawers = Array.from(root.querySelectorAll('.inline-drawer'));
    const drawerSet = new Set(drawers);
    let flattened = 0;

    for (const drawer of drawers) {
        let nested = false;
        for (let ancestor = drawer.parentElement; ancestor; ancestor = ancestor.parentElement) {
            if (drawerSet.has(ancestor)) {
                nested = true;
                break;
            }
        }

        if (!nested && !includeTopLevel) {
            continue;
        }

        if (flattenSettingsDrawer(drawer, !nested)) {
            flattened++;
        }
    }

    return flattened;
}

/**
 * Converts one drawer into `[heading, ...children]` in place.
 *
 * @param {HTMLElement} drawer
 * @param {boolean} isTopLevel whether this drawer was a section rather than a subsection
 * @returns {boolean} whether the drawer was flattened
 */
function flattenSettingsDrawer(drawer, isTopLevel) {
    const header = drawer.querySelector(':scope > .inline-drawer-toggle, :scope > .inline-drawer-header');
    const content = drawer.querySelector(':scope > .inline-drawer-content');

    if (!(header instanceof HTMLElement) || !(content instanceof HTMLElement)) {
        return false;
    }

    // The chevron is an affordance for a control this element no longer is.
    header.querySelector(':scope > .inline-drawer-icon')?.remove();
    header.classList.remove(...SB_FLAT_SECTION_HEADER_CLASSES);
    header.classList.add(SB_FLAT_SECTION_HEADER_CLASS);

    // Lifted out unchanged, in order, so the heading is followed by exactly what the drawer held.
    while (content.firstChild) {
        drawer.insertBefore(content.firstChild, content);
    }
    content.remove();

    drawer.classList.remove('inline-drawer');
    drawer.classList.add(SB_FLAT_SECTION_CLASS);
    if (isTopLevel) {
        drawer.classList.add(SB_FLAT_SECTION_TOP_CLASS);
    }
    drawer.dataset.sbDrawerPersistence = 'off';

    return true;
}

/**
 * A named sub-category built by the 6F section order: a heading with a description line, then
 * one boxed list holding its rows.
 *
 * It carries the flat-section class so search labels and reveal targeting resolve the category
 * name for the controls inside it, exactly as they did for the drawer the rows came from.
 */
export const SB_SETTINGS_CATEGORY_CLASS = 'sb-settings-category';

/**
 * Reading order for each Backend and Customize tab (6F.3).
 *
 * Upstream, SillyBunny, and extension-authored settings arrived in the order their authors
 * appended them, so related controls sat apart: Messages ran streaming, sending, swipes, prompt
 * building, and diagnostics through one 2000px section. Each tab is regrouped by meaning into
 * named sub-categories, regardless of who authored a control.
 *
 * `root` names the element whose children are reordered. Entries come in three shapes:
 *
 * - `section`: an existing section that already reads as one sub-category, moved into place whole.
 * - `adopt`: an existing group that carries its own heading (an `h4`, and optionally the `small`
 *   right after it). The heading becomes the category heading and the group becomes its boxed
 *   list, so its copy and translations are kept. `boxed: false` keeps a group that draws its own
 *   internal layout out of the boxed-list treatment.
 * - `rows`: a new category. Each selector names one row; a checkbox resolves to its label.
 *   `body` instead names an existing group that becomes the boxed list as is.
 *
 * Selectors must not depend on where a row currently sits: the order is reapplied on every tab
 * activation to place content authored after the split, and a row found only in its original
 * parent would be missed once it had moved.
 *
 * Connections, Sampling, and Prompting are not listed. Connections reads as one top-to-bottom
 * setup flow, Sampling is assembled in priority order by `buildSamplingPanel`, and Prompting's
 * groups are built in reading order by `groupOpenAISettingsIntoDrawers`.
 */
export const SB_SETTINGS_SECTION_ORDER = Object.freeze({
    context: Object.freeze({
        root: '.sb-af-drawers',
        entries: Object.freeze([
            { section: '#sb-af-context' },
            { section: '#sb-af-instruct' },
            { section: '#sb-af-sysprompt' },
            { id: 'stopping-strings', adopt: 'div:has(> div > #custom_stopping_strings)' },
            { id: 'reasoning', adopt: 'div:has(> div > .sb-reasoning-toggle-grid)' },
            { id: 'reply-formatting', adopt: 'div:has(> [name="startReplyWithBlock"])' },
        ]),
    }),
    appearance: Object.freeze({
        root: `#${SB_USER_SETTINGS_CONTAINER_IDS.appearance}`,
        entries: Object.freeze([
            { id: 'theme', adopt: '#UI-presets-block', boxed: false },
            { section: '.sb-settings-flat-section:has(> .sb-settings-flat-header [data-i18n="Theme Colors"])' },
            { section: '#AppearanceLayoutSection' },
            { section: '#GoogleFont-block' },
            {
                id: 'chat-display',
                title: 'Chat Display',
                description: 'Avatars, message layout, media, and notifications',
                body: '[name="AvatarAndChatDisplay"]',
            },
            { section: '#ThemeTogglesSection' },
            { section: '#sb-interface-drawer' },
            { section: '#sb-topbar-label-drawer' },
            { section: '#sb-quick-access-shortcuts-drawer' },
            { section: '#CustomCSS-block' },
        ]),
    }),
    interface: Object.freeze({
        root: `#${SB_USER_SETTINGS_CONTAINER_IDS.interface}`,
        entries: Object.freeze([
            { section: '#DesktopSection' },
            { section: '#MobileSection' },
            {
                id: 'typing',
                title: 'Typing',
                description: 'Text field selection, markdown shortcuts, and unsent input',
                rows: ['#enable_auto_select_input', '#enable_md_hotkeys', '#restore_user_input'],
            },
            { section: '[name="AutoCompleteToggle"]' },
            { id: 'stscript', adopt: '[name="STscriptToggles"]' },
            {
                id: 'moving-ui',
                title: 'MovingUI',
                description: 'Drag and resize panels on desktop',
                rows: ['div:has(> #movingUIModeCheckBlock)', '#movingUIOffscreenWarning', '#MovingUI-presets-block'],
            },
            { id: 'miscellaneous', adopt: '[name="MiscellaneousToggles"]' },
        ]),
    }),
    messages: Object.freeze({
        root: `#${SB_USER_SETTINGS_CONTAINER_IDS.messages}`,
        entries: Object.freeze([
            {
                id: 'sending',
                title: 'Sending',
                description: 'Enter key, Send button, and quick reply buttons',
                rows: ['div:has(> #send_on_enter)', '#continue_on_send', '#quick_continue', '#quick_impersonate'],
            },
            {
                id: 'chat-history',
                title: 'Chat History',
                description: 'Loading, scrolling, saving, and deleting messages',
                rows: [
                    'div:has(> #chat_truncation)',
                    '#auto-load-chat-checkbox',
                    '#auto_scroll_chat_to_bottom',
                    '#auto_save_msg_edits',
                    '#confirm_message_delete',
                ],
            },
            {
                id: 'message-display',
                title: 'Message Display',
                description: 'Names, tags, markdown, and embedded content in replies',
                rows: [
                    '#allow_name2_display',
                    '#allow_name1_display',
                    '#encode_tags',
                    '#auto_fix_generated_markdown',
                    '#pin_styles',
                    '#show_group_chat_queue',
                    '#forbid_external_media',
                    '#allow_card_scripts',
                ],
            },
            {
                id: 'swipes',
                title: 'Swipes and Continue',
                description: 'Alternative replies and automatic regeneration',
                rows: [
                    '.checkbox-container:has(> .checkbox_label > #swipes-checkbox)',
                    'div:has(> #image_overswipe)',
                    `.${SB_FLAT_SECTION_CLASS}:has(> .checkbox_label > #auto_swipe)`,
                    `.${SB_FLAT_SECTION_CLASS}:has(> .flex-container > .checkbox_label > #auto_continue_enabled)`,
                ],
            },
            {
                id: 'streaming',
                title: 'Streaming',
                description: 'Live text output while a reply generates',
                // One parent and this order: `toggle-dependent.css` hides the speed and no-think
                // rows with `~` combinators off `#smooth_streaming_control`.
                rows: [
                    'div:has(> #streaming_fps)',
                    '#smooth_streaming_control',
                    '#smooth_streaming_no_think_control',
                    '#smooth_streaming_speed_control',
                    '#stream_fade_in',
                ],
            },
            { id: 'ios-streaming', adopt: '[name="IOSWebKitStreamingToggles"]' },
            { id: 'android-streaming', adopt: '[name="AndroidStreamingToggles"]' },
            { id: 'dom-unloading', adopt: '[name="AggressiveDomUnloadToggles"]' },
            {
                id: 'sounds',
                title: 'Sounds',
                description: 'Play a sound when a reply finishes',
                rows: ['#play_message_sound', '#play_sound_unfocused'],
            },
            {
                id: 'prompt-content',
                title: 'Prompt Content',
                description: 'Example messages, OOC and HTML depth, and macros in the prompt',
                rows: [
                    '#examples-behavior-block',
                    'div:has(> #ooc_context_depth)',
                    'div:has(> #html_context_depth)',
                    '#disable_group_trimming',
                    '#experimental_macro_engine',
                ],
            },
            { id: 'character-handling', adopt: '[name="CharacterHandlingToggles"]' },
            {
                id: 'diagnostics',
                title: 'Diagnostics',
                description: 'Prompt logging and token probabilities',
                rows: ['#console_log_prompts', '#request_token_probabilities'],
            },
        ]),
    }),
    'data-security': Object.freeze({
        root: `#${SB_DATA_SECURITY_CONTAINER_ID}`,
        entries: Object.freeze([
            {
                id: 'general',
                title: 'General',
                description: 'Language, account, version, and browser cache',
                rows: ['#UI-language-block', '#account_controls', '#version_display', '#user-settings-utility-actions'],
            },
            { section: '#SillyTavernImportSection' },
        ]),
    }),
});

/**
 * Anything a user can operate; a wrapper with none of these left holds no settings. Theme Colors
 * is built from `toolcool-color-picker` elements, which hold no native control.
 */
const SB_SETTINGS_CONTROL_SELECTOR = 'input, select, textarea, button, .menu_button, toolcool-color-picker';

/**
 * Resolves a row selector to the element that reads as the row. A checkbox resolves to its
 * `.checkbox_label`, since moving the bare input would strand its label text.
 * @param {HTMLElement} root
 * @param {string} selector
 * @returns {HTMLElement|null}
 */
function resolveSettingsRow(root, selector) {
    const found = root.querySelector(selector);
    if (!(found instanceof HTMLElement)) {
        return null;
    }

    if (found instanceof HTMLInputElement && found.type === 'checkbox') {
        const label = found.closest('.checkbox_label');
        if (label instanceof HTMLElement && root.contains(label)) {
            return label;
        }
    }

    return found;
}

/**
 * Whether `nodes` are all children of `parent`, in this relative order. Other children may sit
 * between them; the order pass leaves those alone.
 * @param {HTMLElement} parent
 * @param {HTMLElement[]} nodes
 */
function areChildrenInOrder(parent, nodes) {
    let previous = null;
    for (const node of nodes) {
        if (node.parentElement !== parent) {
            return false;
        }
        if (previous && !(previous.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) {
            return false;
        }
        previous = node;
    }
    return true;
}

/**
 * Moves `node` under `parent`, recording where it came from so an emptied wrapper can be hidden.
 * @param {HTMLElement} parent
 * @param {HTMLElement} node
 * @param {Node|null} before
 * @param {Set<HTMLElement>} sources
 */
function placeSettingsNode(parent, node, before, sources) {
    if (node.parentElement instanceof HTMLElement && node.parentElement !== parent) {
        sources.add(node.parentElement);
    }
    parent.insertBefore(node, before);
}

/**
 * Builds the heading for a category, or returns the one it already has.
 *
 * Built headings use the same two-line markup as the drawer headers the 6F accordion removal
 * kept: a title, then a description on the meta scale.
 *
 * @param {HTMLElement} category
 * @returns {HTMLElement} the column that holds the title and description
 */
function ensureCategoryHeading(category) {
    const existing = category.querySelector(`:scope > .${SB_FLAT_SECTION_HEADER_CLASS} > .sb-settings-category-heading`);
    if (existing instanceof HTMLElement) {
        return existing;
    }

    const header = document.createElement('div');
    header.className = `${SB_FLAT_SECTION_HEADER_CLASS} sb-settings-category-header`;
    const heading = document.createElement('div');
    heading.className = 'flex-container flexFlowColumn sb-settings-category-heading';
    header.appendChild(heading);
    category.prepend(header);
    return heading;
}

/**
 * Creates an empty category element for `entry`.
 * @param {{id: string, title?: string, description?: string}} entry
 * @returns {HTMLElement}
 */
function createSettingsCategory(entry) {
    const category = document.createElement('section');
    category.className = `${SB_FLAT_SECTION_CLASS} ${SB_SETTINGS_CATEGORY_CLASS}`;
    category.dataset.sbCategory = entry.id;

    if (entry.title) {
        const heading = ensureCategoryHeading(category);
        const title = document.createElement('h4');
        title.className = 'sb-settings-category-title';
        title.dataset.i18n = entry.title;
        title.textContent = entry.title;
        heading.appendChild(title);

        if (entry.description) {
            const description = document.createElement('small');
            description.dataset.i18n = entry.description;
            description.textContent = entry.description;
            heading.appendChild(description);
        }

        category.setAttribute('aria-label', entry.title);
    }

    return category;
}

/**
 * Places one `rows` or `body` entry and returns its category, or null when none of its rows exist.
 * @param {HTMLElement} root
 * @param {object} entry
 * @param {Set<HTMLElement>} sources
 * @returns {HTMLElement|null}
 */
function placeRowsCategory(root, entry, sources) {
    let category = root.querySelector(`:scope .${SB_SETTINGS_CATEGORY_CLASS}[data-sb-category="${entry.id}"]`);

    if (entry.body) {
        const body = root.querySelector(entry.body);
        if (!(body instanceof HTMLElement)) {
            return category instanceof HTMLElement ? category : null;
        }
        if (!(category instanceof HTMLElement)) {
            category = createSettingsCategory(entry);
        }
        body.classList.add('ds-pref-group', 'sb-settings-category-body');
        if (body.parentElement !== category) {
            placeSettingsNode(category, body, null, sources);
        }
        return category;
    }

    const rows = entry.rows.map(selector => resolveSettingsRow(root, selector)).filter(Boolean);
    if (rows.length === 0) {
        return category instanceof HTMLElement ? category : null;
    }

    if (!(category instanceof HTMLElement)) {
        category = createSettingsCategory(entry);
    }

    let body = category.querySelector(':scope > .sb-settings-category-body');
    if (!(body instanceof HTMLElement)) {
        body = document.createElement('div');
        body.className = 'ds-pref-group sb-settings-category-body';
        category.appendChild(body);
    }

    if (!areChildrenInOrder(body, rows)) {
        for (const row of rows) {
            placeSettingsNode(body, row, null, sources);
        }
    }

    return category;
}

/**
 * Places one `adopt` entry: the group's own heading becomes the category heading.
 * @param {HTMLElement} root
 * @param {{id: string, adopt: string, boxed?: boolean}} entry
 * @param {Set<HTMLElement>} sources
 * @returns {HTMLElement|null}
 */
function placeAdoptedCategory(root, entry, sources) {
    const existing = root.querySelector(`:scope .${SB_SETTINGS_CATEGORY_CLASS}[data-sb-category="${entry.id}"]`);
    if (existing instanceof HTMLElement) {
        return existing;
    }

    const group = root.querySelector(entry.adopt);
    if (!(group instanceof HTMLElement)) {
        return null;
    }

    const category = createSettingsCategory(entry);
    const headingElement = group.querySelector(':scope > :is(h3, h4, .standoutHeader)');
    if (headingElement instanceof HTMLElement) {
        const heading = ensureCategoryHeading(category);
        const description = headingElement.nextElementSibling;
        heading.appendChild(headingElement);
        headingElement.classList.add('sb-settings-category-title');
        if (description instanceof HTMLElement && description.tagName === 'SMALL') {
            heading.appendChild(description);
        }
        category.setAttribute('aria-label', headingElement.textContent.replace(/\s+/g, ' ').trim());
    }

    group.classList.add('sb-settings-category-body');
    if (entry.boxed !== false) {
        group.classList.add('ds-pref-group');
    }

    // The category takes the group's place first, so a group that is never reordered afterwards
    // still sits where it was rather than at the end of its parent.
    if (group.parentElement instanceof HTMLElement) {
        group.parentElement.insertBefore(category, group);
    }
    category.appendChild(group);
    return category;
}

/**
 * Hides a wrapper that the order pass emptied of every setting.
 *
 * Moving rows into categories leaves their old containers behind, some still carrying a heading
 * (`Chat/Message Handling`) or a separator. A heading over nothing would read as a broken
 * section, so the outermost wrapper below `root` with no control left is hidden. It stays in the
 * document because upstream code still looks some of these up by id.
 *
 * @param {HTMLElement} root
 * @param {Set<HTMLElement>} sources
 */
function hideEmptiedSettingsWrappers(root, sources) {
    for (const source of sources) {
        let emptied = null;
        for (let current = source; current && current !== root && root.contains(current); current = current.parentElement) {
            if (current.classList.contains(SB_SETTINGS_CATEGORY_CLASS) || current.querySelector(SB_SETTINGS_CONTROL_SELECTOR)) {
                break;
            }
            emptied = current;
        }

        if (emptied && !emptied.hidden) {
            emptied.hidden = true;
            emptied.dataset.sbEmptiedByOrder = 'true';
        }
    }
}

/**
 * Regroups one tab's settings into its named sub-categories (see `SB_SETTINGS_SECTION_ORDER`).
 *
 * Nodes are moved with `insertBefore`/`appendChild` only, so ids, names, storage keys, and every
 * listener stay attached. The pass is idempotent and moves nothing once the tab is in order, so
 * it can run on every activation without feeding the drawer persistence observer: some content
 * (the Appearance theme card, Advanced Formatting's sections) is authored after the split.
 *
 * @param {HTMLElement|null|undefined} scope the tab's panel or container
 * @param {string} tabId
 * @returns {boolean} whether the tab has an order and its root was found
 */
export function applySettingsSectionOrder(scope, tabId) {
    const order = SB_SETTINGS_SECTION_ORDER[tabId];
    if (!order || !(scope instanceof HTMLElement)) {
        return false;
    }

    const root = scope.matches(order.root) ? scope : scope.querySelector(order.root);
    if (!(root instanceof HTMLElement)) {
        return false;
    }

    const sources = new Set();
    const placed = [];

    for (const entry of order.entries) {
        let element = null;
        if (entry.section) {
            element = root.querySelector(entry.section);
            // A section moved up from inside another one is now a section in its own right, and
            // takes the top-level header metric like every sibling it now sits beside.
            element?.classList.add(SB_FLAT_SECTION_TOP_CLASS);
        } else if (entry.adopt) {
            element = placeAdoptedCategory(root, entry, sources);
        } else {
            element = placeRowsCategory(root, entry, sources);
        }

        if (element instanceof HTMLElement && !placed.includes(element)) {
            placed.push(element);
        }
    }

    if (!areChildrenInOrder(root, placed)) {
        // Categories lead the tab, in reading order; anything the order does not name (third-party
        // additions included) follows rather than being dropped.
        // A detached marker, not the first child: the first child may be one of the placed nodes,
        // and inserting the rest before it would put them ahead of it.
        const anchor = document.createComment('');
        root.insertBefore(anchor, root.firstChild);
        for (const element of placed) {
            placeSettingsNode(root, element, anchor, sources);
        }
        anchor.remove();
    }

    hideEmptiedSettingsWrappers(root, sources);
    return true;
}

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

    // 6E allowed one collapsible section per sub-category, so any drawer that ended up inside
    // another drawer is unwrapped here. 6F goes further and removes the remaining accordions, so
    // the outermost drawers go too -- all four containers are Backend or Customize content, and
    // Extensions, the one tab that keeps its drawers, is built from `#rm_extensions_block` and is
    // not among them. Flattening happens after placement because the nesting is a property of the
    // finished container, not of the columns the sections came from.
    const flattenOptions = { includeTopLevel: true };
    for (const [tabId, container] of Object.entries(containers)) {
        flattenNestedSettingsDrawers(container, flattenOptions);
        // 6F.3: order runs after the flatten, since it decides what a section reads as and where
        // it sits. Advanced Formatting and the Appearance theme card are still being assembled at
        // this point, so their own tabs are reordered again once their panels exist.
        applySettingsSectionOrder(container, tabId);
    }
    flattenNestedSettingsDrawers(dataSecurity, flattenOptions);
    applySettingsSectionOrder(dataSecurity, 'data-security');

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
