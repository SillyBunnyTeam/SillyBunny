import { openActionMenu } from './sillybunny-action-menu.js';

const EXTENSION_ROW_SELECTOR = '.extensions_info .extension_block';
const ACTION_SELECTOR = ':scope > button:not(.sb-extension-actions-menu)';
const NARROW_VIEWPORT = 450;

let rowObserver;
let resizeObserver;
let managerLifecycleBound = false;

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

function measureActionWidth(action) {
    const width = action.getBoundingClientRect().width;
    if (width > 0) action.dataset.sbExtensionActionWidth = String(width);
    return width || Number(action.dataset.sbExtensionActionWidth) || parseFloat(getComputedStyle(action).width) || 0;
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
    const actionWidths = actions.reduce((total, action) => total + measureActionWidth(action), 0);
    const actionGap = Math.max(0, actions.length - 1) * 8;
    const titleWidth = rowWidth - (icon?.width ?? 0) - (toggle?.width ?? 0) - actionWidths - actionGap - 32;
    return titleWidth < rowWidth * 0.4;
}

function updateRow(row) {
    const actionContainer = row.querySelector('.extension_actions');
    if (!actionContainer) return;
    const actions = visibleActions(row);
    if (!actions.length) {
        if (row.classList.contains('sb-extension-actions-collapsed')) row.classList.remove('sb-extension-actions-collapsed');
        actionContainer.querySelector('.sb-extension-actions-menu')?.remove();
        return;
    }
    let trigger = actionContainer.querySelector('.sb-extension-actions-menu');
    if (!trigger) {
        trigger = createMenuTrigger(row);
        actionContainer.append(trigger);
    }
    const collapsed = rowNeedsCollapsedActions(row, actions);
    if (row.classList.contains('sb-extension-actions-collapsed') !== collapsed) {
        row.classList.toggle('sb-extension-actions-collapsed', collapsed);
    }
    const actionDisplay = collapsed ? 'none' : '';
    actions.forEach(action => {
        if (action.style.display !== actionDisplay) action.style.display = actionDisplay;
    });
    const triggerDisplay = collapsed ? 'inline-flex' : 'none';
    if (trigger.style.display !== triggerDisplay) trigger.style.display = triggerDisplay;
}

function updateRows(root = document) {
    if (!(root instanceof Element) && root !== document) return;
    const rows = root.matches?.(EXTENSION_ROW_SELECTOR) ? [root] : [...root.querySelectorAll(EXTENSION_ROW_SELECTOR)];
    rows.forEach(row => {
        updateRow(row);
        resizeObserver?.observe(row);
    });
}

export function unobserveRemovedRows(node, observer = resizeObserver) {
    if (!(node instanceof Element)) return;
    if (node.matches(EXTENSION_ROW_SELECTOR)) observer?.unobserve(node);
    node.querySelectorAll(EXTENSION_ROW_SELECTOR).forEach(row => observer?.unobserve(row));
}

function disposeExtensionRowActions() {
    rowObserver?.disconnect();
    resizeObserver?.disconnect();
    rowObserver = null;
    resizeObserver = null;
}

function initializeExtensionRowActions() {
    if (rowObserver) return;
    resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => entries.forEach(entry => updateRow(entry.target))) : null;
    updateRows();
    rowObserver = new MutationObserver(records => {
        for (const record of records) {
            record.removedNodes.forEach(unobserveRemovedRows);
            record.addedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE) updateRows(node);
            });
            if (record.target instanceof Element && record.target.closest(EXTENSION_ROW_SELECTOR)) {
                updateRows(record.target.closest(EXTENSION_ROW_SELECTOR));
            }
        }
    });
    rowObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    if (!managerLifecycleBound) {
        document.addEventListener('sillybunny:extensions-manager-open', initializeExtensionRowActions);
        document.addEventListener('sillybunny:extensions-manager-close', disposeExtensionRowActions);
        managerLifecycleBound = true;
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeExtensionRowActions, { once: true });
} else {
    initializeExtensionRowActions();
}
