import { openActionMenu } from './sillybunny-action-menu.js';

const EXTENSION_ROW_SELECTOR = '.extensions_info .extension_block';
const ACTION_SELECTOR = ':scope > button:not(.sb-extension-actions-menu)';
const NARROW_VIEWPORT = 450;

let rowObserver;
let resizeObserver;

function visibleActions(row) {
    const actionContainer = row.querySelector('.extension_actions');
    if (!actionContainer) return [];
    return [...actionContainer.querySelectorAll(ACTION_SELECTOR)].filter(button => {
        return !button.classList.contains('displayNone');
    });
}

function actionMenuItems(row) {
    return visibleActions(row).map(button => ({
        label: button.title || button.getAttribute('aria-label') || button.dataset.i18n || 'Extension action',
        title: button.title || undefined,
        icon: button.querySelector('i, svg') || undefined,
        onSelect: () => button.click(),
    }));
}

function createMenuTrigger(row) {
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'menu_button menu_button_icon sb-header-icon-button sb-extension-actions-menu';
    trigger.setAttribute('aria-label', 'Extension Actions');
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.title = 'Extension Actions';
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-ellipsis-vertical';
    icon.setAttribute('aria-hidden', 'true');
    trigger.append(icon);
    trigger.addEventListener('click', () => {
        const items = actionMenuItems(row);
        if (!items.length) return;
        openActionMenu({
            trigger,
            title: 'Extension Actions',
            sections: [{ items }],
            onClose: () => trigger.setAttribute('aria-expanded', 'false'),
        });
        trigger.setAttribute('aria-expanded', 'true');
    });
    return trigger;
}

function rowNeedsCollapsedActions(row, actions) {
    if (window.matchMedia(`(max-width: ${NARROW_VIEWPORT}px)`).matches) return true;
    const rowWidth = row.getBoundingClientRect().width;
    if (!rowWidth || !actions.length) return false;
    const icon = row.querySelector('.extension_icon')?.getBoundingClientRect();
    const toggle = row.querySelector('.extension_toggle')?.getBoundingClientRect();
    const actionWidths = actions.reduce((total, action) => total + (action.getBoundingClientRect().width || parseFloat(getComputedStyle(action).width) || 0), 0);
    const actionGap = Math.max(0, actions.length - 1) * 8;
    const titleWidth = rowWidth - (icon?.width ?? 0) - (toggle?.width ?? 0) - actionWidths - actionGap - 32;
    return titleWidth < rowWidth * 0.4;
}

function updateRow(row) {
    const actionContainer = row.querySelector('.extension_actions');
    if (!actionContainer) return;
    const actions = visibleActions(row);
    if (!actions.length) {
        row.classList.remove('sb-extension-actions-collapsed');
        actionContainer.querySelector('.sb-extension-actions-menu')?.remove();
        return;
    }
    let trigger = actionContainer.querySelector('.sb-extension-actions-menu');
    if (!trigger) {
        trigger = createMenuTrigger(row);
        actionContainer.append(trigger);
    }
    const collapsed = rowNeedsCollapsedActions(row, actions);
    row.classList.toggle('sb-extension-actions-collapsed', collapsed);
    actions.forEach(action => { action.style.display = collapsed ? 'none' : ''; });
    trigger.style.display = collapsed ? 'inline-flex' : 'none';
}

function updateRows(root = document) {
    if (!(root instanceof Element) && root !== document) return;
    const rows = root.matches?.(EXTENSION_ROW_SELECTOR) ? [root] : [...root.querySelectorAll(EXTENSION_ROW_SELECTOR)];
    rows.forEach(row => {
        updateRow(row);
        resizeObserver?.observe(row);
    });
}

function initializeExtensionRowActions() {
    if (rowObserver) return;
    updateRows();
    rowObserver = new MutationObserver(records => {
        for (const record of records) {
            record.addedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE) updateRows(node);
            });
            if (record.target instanceof Element && record.target.closest(EXTENSION_ROW_SELECTOR)) {
                updateRows(record.target.closest(EXTENSION_ROW_SELECTOR));
            }
        }
    });
    rowObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => entries.forEach(entry => updateRow(entry.target))) : null;
    document.querySelectorAll(EXTENSION_ROW_SELECTOR).forEach(row => resizeObserver?.observe(row));
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeExtensionRowActions, { once: true });
} else {
    initializeExtensionRowActions();
}
