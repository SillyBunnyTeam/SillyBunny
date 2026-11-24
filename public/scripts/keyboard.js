/* All selectors that should act as interactables / keyboard buttons by default */
const interactableSelectors = [
    '.interactable', // Main interactable class for ALL interactable controls (can also be manually added in code, so that's why its listed here)
    '.custom_interactable', // Manually made interactable controls via code (see 'makeKeyboardInteractable()')
    '.menu_button', // General menu button in ST
    '.right_menu_button', // Button-likes in many menus
    '.drawer-icon', // Main "menu bar" icons
    // SillyBunny: a chevron inside its drawer header is decoration of the header, which is the control; the header takes the Tab stop instead.
    // A header that already names itself a button with `aria-expanded`, or that is a row (the Connections page binds Enter and Space itself), is left out, so Enter does not click it twice.
    // SillyBunny: the legacy Prompt Manager's drawer header sits in a group the prompt editor replaces and hides, so it takes no Tab stop.
    // SillyBunny: a header marked `sb-drawer-child-toggle` holds its own toggle button beside other buttons, which is the Tab stop; a click on that button still reaches the header's handler.
    '.inline-drawer-toggle:not(.ds-row, [aria-expanded], .sb-drawer-child-toggle, #sb-openai-prompt-manager .inline-drawer-toggle)',
    '.inline-drawer-icon:not(:is(.inline-drawer-toggle, .inline-drawer-header) *)', // Buttons/icons inside the drawer menus
    '.paginationjs-pages li a', // Pagination buttons
    '.group_select, .character_select, .bogus_folder_select', // Cards to select char, group or folder in character list and other places
    '.swipe_picker_block', // Swipe picker entries in the swipe history popup
    '.avatar-container', // Persona list blocks
    '.tag .tag_remove', // Remove button in removable tags
    '.bg_example', // Background elements in the background menu
    '.bg_example .jg-button, .bg_example .mobile-only-menu-toggle', // The inline buttons on the backgrounds
    '#options a', // Option entries in the popup options menu
    '.mes_buttons .mes_button', // Small inline buttons on the chat messages
    '.extraMesButtons>div:not(.mes_button)', // The extra/extension buttons inline on the chat messages
    '.swipe_left, .swipe_right', // Swipe buttons on the last message
    '.stscript_btn', // STscript buttons in the chat bar
    '.select2_choice_clickable+span.select2-container .select2-selection__choice__display', // select2 control elements if they are meant to be clickable
    '.avatar_load_preview', // Char display avatar selection
    '.bg_tabs_list .bg_tab_button', // Background tabs
    '.select_chat_block', // The blocks to select a past chat in the past chats menu
    '.select_chat_block .exportRawChatButton', // Export raw chat button in the past chats menu
    '.select_chat_block .exportChatButton', // Export chat button in the past chats menu
    '.select_chat_block .PastChat_cross', // Delete chat button in the past chats menu
    '.select_chat_block .renameChatButton', // The button to rename a past chat in the past chats menu
];

if (CSS.supports('selector(:has(*))')) {
    // Option entries in the extension menu popup that are coming from extensions
    // SillyBunny: an extension's `.extension_container` wrapper only holds its rows; it is not a row, so it takes no tab stop and no role.
    interactableSelectors.push('#extensionsMenu div:has(.extensionsMenuExtensionButton):not(.extension_container)');
}

/** Number of built-in selectors; anything pushed after this index came from registerInteractableType. */
const builtInSelectorCount = interactableSelectors.length;

// SillyBunny: streaming rewrites message prose many times a second. The chrome selectors above never match
// inside prose, so prose only needs the generic markers (code-copy buttons carry `.interactable`) plus any
// selector an extension registered, which may target controls it injects into a message.
const PROSE_SELECTOR = '.mes_text, .mes_reasoning';
const proseCoreSelectors = ['.interactable', '.custom_interactable', '.menu_button'];
let proseInteractableSelector = null;

function getProseInteractableSelector() {
    if (proseInteractableSelector === null) {
        proseInteractableSelector = [...proseCoreSelectors, ...interactableSelectors.slice(builtInSelectorCount)].join(', ');
    }
    return proseInteractableSelector;
}

export const INTERACTABLE_CONTROL_CLASS = 'interactable';
export const CUSTOM_INTERACTABLE_CONTROL_CLASS = 'custom_interactable';

export const NOT_FOCUSABLE_CONTROL_CLASS = 'not_focusable';
export const DISABLED_CONTROL_CLASS = 'disabled';

const PROSE_FORMATTING_TAGS = new Set([
    'SPAN', 'P', 'EM', 'STRONG', 'B', 'I', 'U', 'Q', 'BR',
    'SMALL', 'SUB', 'SUP', 'DEL', 'S', 'MARK', 'CODE', 'LI', 'BLOCKQUOTE',
]);

function isProseInteractiveCandidate(node) {
    if (node.classList.contains(INTERACTABLE_CONTROL_CLASS)
        || node.classList.contains(CUSTOM_INTERACTABLE_CONTROL_CLASS)
        || node.classList.contains('menu_button')
        || node.classList.contains('scroll-reset-container')) {
        return true;
    }
    return interactableSelectors.length > builtInSelectorCount && node.matches(getProseInteractableSelector());
}

/**
 * An observer that will check if any new interactables or scroll reset containers are added to the body
 * @type {MutationObserver}
 */
const observer = new MutationObserver(mutations => {
    // One batch can carry thousands of records for the same subtree (a page swap adds a node and then
    // toggles classes inside it). Rescanning each one repeats full-subtree queries, so collapse the
    // batch to its unique outermost elements first.
    const changed = new Set();
    for (const mutation of mutations) {
        const target = mutation.target;
        const inProse = target instanceof Element && target.closest(PROSE_SELECTOR) !== null;
        if (mutation.type === 'childList') {
            for (const node of mutation.addedNodes) {
                if (!(node instanceof Element)) continue;
                if (inProse) {
                    // SillyBunny: skip streaming text/span churn inside .mes_text/.mes_reasoning while still
                    // initializing explicitly interactive nodes (e.g. .code-copy.interactable) and container widgets.
                    if (isProseInteractiveCandidate(node)) {
                        changed.add(node);
                    } else if (node.childElementCount > 0 && !PROSE_FORMATTING_TAGS.has(node.tagName)) {
                        changed.add(node);
                    }
                    continue;
                }
                if (node.matches(PROSE_SELECTOR) && node.childElementCount === 0) continue;
                changed.add(node);
            }
        } else if (mutation.type === 'attributes' && mutation.attributeName === 'class' && target instanceof Element) {
            if (inProse
                && !isProseInteractiveCandidate(target)
                && !target.classList.contains(DISABLED_CONTROL_CLASS)
                && !target.classList.contains(NOT_FOCUSABLE_CONTROL_CLASS)) {
                continue;
            }
            changed.add(target);
        }
    }
    for (const node of changed) {
        if (!node.isConnected) continue;
        let ancestor = node.parentElement;
        while (ancestor && !changed.has(ancestor)) ancestor = ancestor.parentElement;
        if (!ancestor) handleNodeChange(node);
    }
});

/**
 * Function to handle node changes (added or modified nodes)
 * @param {Element} node
 */
function handleNodeChange(node) {
    if (node.nodeType === Node.ELEMENT_NODE && node instanceof Element) {
        if (node.closest(PROSE_SELECTOR)) {
            handleProseNodeChange(node);
            return;
        }

        // Handle keyboard interactables
        if (isKeyboardInteractable(node)) {
            makeKeyboardInteractable(node);
        }
        initializeInteractables(node);

        // Handle scroll reset containers
        if (node.classList.contains('scroll-reset-container')) {
            applyScrollResetBehavior(node);
        }
        initializeScrollResetBehaviors(node);
    }
}

/**
 * Cheap path for nodes inside message prose: avoids scanning leaf nodes and uses one combined query for subtrees.
 * @param {Element} node
 */
function handleProseNodeChange(node) {
    if (node.childElementCount === 0) {
        if (node.classList.contains('scroll-reset-container')) {
            applyScrollResetBehavior(node);
        }
        if (isProseInteractiveCandidate(node) && !node.classList.contains('scroll-reset-container')) {
            makeKeyboardInteractable(node);
        } else if (node.matches(getProseInteractableSelector())) {
            makeKeyboardInteractable(node);
        }
        return;
    }

    const selector = getProseInteractableSelector();
    const interactables = Array.from(node.querySelectorAll(selector));
    if (node.matches(selector)) interactables.unshift(node);
    if (interactables.length) makeKeyboardInteractable(...interactables);

    if (node.classList.contains('scroll-reset-container')) {
        applyScrollResetBehavior(node);
    }
    if (node.firstElementChild) initializeScrollResetBehaviors(node);
}

/**
 * Registers an interactable class (for example for an extension) and makes it keyboard interactable.
 * Optionally apply the 'not_focusable' and 'disabled' classes if needed.
 *
 * @param {string} interactableSelector - The CSS selector for the interactable (Supports class combinations, chained via dots like <c>tag.actionable</c>, and sub selectors)
 * @param {object} [options={}] - Optional settings for the interactable
 * @param {boolean} [options.disabledByDefault=false] - Whether interactables of this class should be disabled by default
 * @param {boolean} [options.notFocusableByDefault=false] - Whether interactables of this class should not be focusable by default
 */
export function registerInteractableType(interactableSelector, { disabledByDefault = false, notFocusableByDefault = false } = {}) {
    interactableSelectors.push(interactableSelector);
    proseInteractableSelector = null;

    const interactables = document.querySelectorAll(interactableSelector);

    if (disabledByDefault || notFocusableByDefault) {
        interactables.forEach(interactable => {
            if (disabledByDefault) interactable.classList.add(DISABLED_CONTROL_CLASS);
            if (notFocusableByDefault) interactable.classList.add(NOT_FOCUSABLE_CONTROL_CLASS);
        });
    }

    makeKeyboardInteractable(...interactables);
}

/**
 * Checks if the given control is a keyboard-enabled interactable.
 *
 * @param {Element} control - The control element to check
 * @returns {boolean} Returns true if the control is a keyboard interactable, false otherwise
 */
export function isKeyboardInteractable(control) {
    // Check if this control matches any of the selectors
    return interactableSelectors.some(selector => control.matches(selector));
}

/**
 * Makes all the given controls keyboard interactable and sets their state.
 * If the control doesn't have any of the classes, it will be set to a custom-enabled keyboard interactable.
 *
 * @param {Element[]} interactables - The controls to make interactable and set their state
 */
export function makeKeyboardInteractable(...interactables) {
    interactables.forEach(interactable => {
        // If this control doesn't have any of the classes, lets say the caller knows this and wants this to be a custom-enabled keyboard control.
        if (!isKeyboardInteractable(interactable)) {
            interactable.classList.add(CUSTOM_INTERACTABLE_CONTROL_CLASS);
        }

        // Just for CSS styling and future reference, every keyboard interactable control should have a common class
        if (!interactable.classList.contains(INTERACTABLE_CONTROL_CLASS)) {
            interactable.classList.add(INTERACTABLE_CONTROL_CLASS);
        }

        /**
         * Check if the element or any parent element has 'disabled' or 'not_focusable' class
         * @param {Element} el
         * @returns {boolean}
         */
        const hasDisabledOrNotFocusableAncestor = (el) => {
            while (el) {
                if (el.classList.contains(NOT_FOCUSABLE_CONTROL_CLASS) || el.classList.contains(DISABLED_CONTROL_CLASS)) {
                    return true;
                }
                el = el.parentElement;
            }
            return false;
        };

        // Set/remove the tabindex accordingly to the classes. Remembering if it had a custom value.
        if (!hasDisabledOrNotFocusableAncestor(interactable)) {
            if (!interactable.hasAttribute('tabindex')) {
                const tabIndex = interactable.getAttribute('data-original-tabindex') ?? '0';
                interactable.setAttribute('tabindex', tabIndex);
            }
        } else if (interactable.hasAttribute('tabindex')) {
            // SillyBunny: only stash a tabindex that exists. Controls are revisited on every rescan
            // (and twice per pass, as most match two selectors); stashing a missing one stored the
            // string "null", which re-enabling then restored as an invalid, unfocusable tabindex.
            interactable.setAttribute('data-original-tabindex', interactable.getAttribute('tabindex'));
            interactable.removeAttribute('tabindex');
        }
    });
}

/**
 * Initializes the focusability of controls on the given element or the document
 *
 * @param {Element|Document} [element=document] - The element on which to initialize the interactable state. Defaults to the document.
 */
function initializeInteractables(element = document) {
    const interactables = getAllInteractables(element);
    makeKeyboardInteractable(...interactables);
}

/**
 * Queries all interactables within the given element based on the given selectors and returns them as an array
 *
 * @param {Element|Document} element - The element within which to query the interactables
 * @returns {HTMLElement[]} An array containing all the interactables that match the given selectors
 */
function getAllInteractables(element) {
    // Query each selector individually and combine all to a big array to return
    return [].concat(...interactableSelectors.map(selector => Array.from(element.querySelectorAll(`${selector}`))));
}

// SillyBunny: containers are found again on every rescan of an ancestor; bind each one only once.
const boundScrollResetContainers = new WeakSet();

/**
 * Function to apply scroll reset behavior to a container
 * @param {Element} container - The container
 */
const applyScrollResetBehavior = (container) => {
    if (boundScrollResetContainers.has(container)) {
        return;
    }
    boundScrollResetContainers.add(container);
    container.addEventListener('focusout', (e) => {
        setTimeout(() => {
            const focusedElement = document.activeElement;
            if (!container.contains(focusedElement)) {
                container.scrollTop = 0;
                container.scrollLeft = 0;
            }
        }, 0);
    });
};

/**
 * Initializes the scroll reset behavior on the given element or the document
 *
 * @param {Element|Document} [element=document] - The element on which to initialize the scroll reset behavior. Defaults to the document.
 */
function initializeScrollResetBehaviors(element = document) {
    const scrollResetContainers = element.querySelectorAll('.scroll-reset-container');
    scrollResetContainers.forEach(container => applyScrollResetBehavior(container));
}

/**
 * Handles keydown events on the document to trigger click on Enter key press for interactables
 *
 * @param {KeyboardEvent} event - The keyboard event
 */
function handleGlobalKeyDown(event) {
    if (event.key === 'Enter') {
        if (!(event.target instanceof HTMLElement))
            return;

        // SillyBunny: a native button, link, summary or button-like input already clicks on Enter, so the
        // synthetic click below would run its handler twice, and the second click lands on whatever took focus
        // after the first. Checkbox and radio stay out of this list because Enter does not toggle them.
        if (event.target.matches('button, summary, a[href], input:is([type="button"], [type="submit"], [type="reset"], [type="image"])'))
            return;

        // Only count enter on this interactable if no modifier key is pressed
        if (event.altKey || event.ctrlKey || event.shiftKey)
            return;

        // Traverse up the DOM tree to find the actual interactable element
        let target = event.target;
        while (target && !isKeyboardInteractable(target)) {
            target = target.parentElement;
        }

        // Trigger click if a valid interactable is found and it's not disabled
        if (target && !target.classList.contains(DISABLED_CONTROL_CLASS)) {
            console.debug('Triggering click on keyboard-focused interactable control via Enter', target);
            target.click();
        }
    }
}

/**
 * Initializes several keyboard functionalities for ST
 */
export function initKeyboard() {
    // Start observing the body for added elements and attribute changes
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
    });

    // Initialize already existing controls
    initializeInteractables();
    initializeScrollResetBehaviors();

    // Add a global keydown listener
    document.addEventListener('keydown', handleGlobalKeyDown);
}
