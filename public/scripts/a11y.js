/**
 * Shared module between login and main app.
 * Be careful what you import!
 */

const buttonSelectors = [
    '.menu_button',
    '.right_menu_button',
    '.mes_button',
    '.drawer-icon',
    // SillyBunny: a chevron inside its drawer header is decoration of the header, so the header takes the button role instead.
    // SillyBunny: the legacy Prompt Manager's drawer header sits in a group the prompt editor replaces and hides, so it takes no role and no Tab stop.
    // SillyBunny: a header marked `sb-drawer-child-toggle` holds its own toggle button beside other buttons, so it takes no role: a button inside a button is nested-interactive.
    '.inline-drawer-toggle:not(.ds-row, [aria-expanded], .sb-drawer-child-toggle, #sb-openai-prompt-manager .inline-drawer-toggle)',
    '.inline-drawer-icon:not(:is(.inline-drawer-toggle, .inline-drawer-header) *)',
    '.swipe_left',
    '.swipe_right',
    '.character_select',
    '.tags .tag',
    '.jg-menu .jg-button',
    '.bg_example .mobile-only-menu-toggle',
    '.paginationjs-pages li a',
    '#show_more_messages',
    '#show_newer_messages',
].join(', ');

// SillyBunny: the composer's icon controls are bare divs. Without a role their tooltip names nothing for assistive technology, and a
// glyph drawn by `::before` is read as their content, which keeps the tooltip from becoming the name, so the tooltip is also the label.
const composerControlSelectors = [
    '#extensionsMenuButton',
    '#send_but',
    '#mes_impersonate',
    '#mes_continue',
    '#mes_stop',
    '#sb_prose_polisher_but',
    '#leftSendForm > .interactable',
    '#rightSendForm > :is(.interactable, .stscript_btn)',
].join(', ');

// SillyBunny: the top bar's icon controls are bare divs as well: upstream's drawer icons, and the extension controls that the bar
// adopts into its slot. They take the same role and the same tooltip label as the composer's.
const topBarControlSelectors = [
    '#top-settings-holder .drawer-icon',
    '#sb-topbar-extension-slot :is(.drawer-icon, .menu_button, .right_menu_button, .interactable):not(:is(button, a, input, select, textarea))',
].join(', ');

// SillyBunny: the login page's #userList and its cards are not listed here, because each card is a button (login.js).
const listSelectors = [
    '.options-content',
    '.list-group',
    '#rm_print_characters_block',
    '#rm_group_members',
    '#rm_group_add_members',
    '.tag_view_list_tags',
    '.secretKeyManagerList',
    '.recentChatList',
    '.dataMaidCategoryContent',
    '.bg_list',
].join(', ');

const listItemSelectors = [
    '.options-content .list-group-item',
    '.list-group .list-group-item',
    '#rm_print_characters_block .entity_block',
    '#rm_group_members .group_member',
    '#rm_group_add_members .group_member',
    '.tag_view_list_tags .tag_view_item',
    '.secretKeyManagerList .secretKeyManagerItem',
    '.recentChatList .recentChat',
    '.dataMaidCategoryContent .dataMaidItem',
    '.bg_list .bg_example',
].join(', ');

const toolbarSelectors = [
    '.jg-menu',
].join(', ');

const tabListSelectors = [
    '#bg_tabs .bg_tabs_list',
].join(', ');

const tabItemSelectors = [
    '#bg_tabs .bg_tabs_list .bg_tab_button',
].join(', ');

/** @type {Record<string, (element: Element) => void>} */
const a11yRules = {
    [buttonSelectors]: (element) => {
        // SillyBunny: entity metadata is not a separate action. It gets no role: "generic" is not an assignable ARIA role, so axe reports it as invalid.
        if (element.matches('.ds-entity-row__tags .tag:not(.actionable, .clickable-action)') && !element.querySelector('button, .tag_remove:not([style*="display: none"])')) {
            element.removeAttribute('role');
            return;
        }
        element.setAttribute('role', 'button');
    },
    [`${composerControlSelectors}, ${topBarControlSelectors}`]: (element) => {
        element.setAttribute('role', 'button');
        const tooltip = element.getAttribute('title')?.trim();
        if (tooltip && !element.hasAttribute('aria-label')) element.setAttribute('aria-label', tooltip);
    },
    [listSelectors]: (element) => {
        element.setAttribute('role', 'list');
    },
    [listItemSelectors]: (element) => {
        element.setAttribute('role', 'listitem');
    },
    [toolbarSelectors]: (element) => {
        element.setAttribute('role', 'toolbar');
    },
    [tabListSelectors]: (element) => {
        element.setAttribute('role', 'tablist');
    },
    [tabItemSelectors]: (element) => {
        element.setAttribute('role', 'tab');
    },
    // SillyBunny: in-app notifications sit in #toast-container and toasts in #sb-toast-overlay. A caller's toastClass can
    // replace the toast class, so every child of either container counts, except the hidden clone that measures a toast.
    '#toast-container > :not(.sb-toast-measure), #sb-toast-overlay > :not(.sb-toast-measure)': (element) => {
        element.setAttribute('role', 'status');
    },
};
const a11yRuleEntries = Object.entries(a11yRules);
const a11ySelector = a11yRuleEntries.map(([selector]) => selector).join(', ');
// SillyBunny: streaming rewrites message prose many times a second.
const PROSE_SELECTOR = '.mes_text, .mes_reasoning';
let accessibilityObserver = null;

/**
 * Apply accessibility rules to an element.
 * @param {Element} element Element to process.
 */
function applyA11yRules(element) {
    try {
        // SillyBunny: scan each added subtree once, including controls supplied by extensions.
        const descendants = element.querySelectorAll(a11ySelector);
        const candidates = element.matches(a11ySelector) ? [element, ...descendants] : descendants;
        for (const candidate of candidates) {
            for (const [selector, rule] of a11yRuleEntries) {
                if (candidate.matches(selector)) {
                    rule(candidate);
                }
            }
        }
    } catch (error) {
        console.error('Error applying accessibility rules to element:', element, error);
    }
}

function setAccessibilityObserver() {
    if (accessibilityObserver) return;
    // Apply for existing elements
    applyA11yRules(document.body);

    // Setup observer for dynamic content
    const observer = new MutationObserver((mutationsList) => {
        const addedElements = new Set();
        for (const mutation of mutationsList) {
            if (mutation.type === 'childList') {
                // SillyBunny: skip streaming prose churn inside .mes_text / .mes_reasoning;
                // .mes chrome additions (.mes_button, .swipe_left, .swipe_right, etc.) sit outside prose.
                if (mutation.target instanceof Element && mutation.target.closest(PROSE_SELECTOR)) {
                    continue;
                }
                for (const addedNode of mutation.addedNodes) {
                    if (addedNode instanceof Element && addedNode.nodeType === Node.ELEMENT_NODE) {
                        if (addedNode.matches(PROSE_SELECTOR)) continue;
                        addedElements.add(addedNode);
                    }
                }
            }
        }

        for (const element of addedElements) {
            let parent = element.parentElement;
            while (parent && !addedElements.has(parent)) {
                parent = parent.parentElement;
            }
            if (!parent && element.isConnected) {
                applyA11yRules(element);
            }
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
    });
    accessibilityObserver = observer;
}

export function initAccessibility() {
    setAccessibilityObserver();
}
