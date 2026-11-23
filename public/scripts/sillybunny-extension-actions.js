import { openActionMenu } from './sillybunny-action-menu.js';

const EXTENSION_CONTAINER_SELECTOR = '.extensions_info';
const EXTENSION_ROW_SELECTOR = '.extensions_info .extension_block';
const ACTION_SELECTOR = ':scope > button:not(.sb-extension-actions-menu)';
const NARROW_VIEWPORT = 450;

let rowObserver;
let resizeObserver;
let managerLifecycleBound = false;
let observedContainer = null;

function visibleActions(row) {
    const actionContainer = row.querySelector('.extension_actions');
    if (!actionContainer) return [];
    return [...actionContainer.querySelectorAll(ACTION_SELECTOR)].filter(button => {
        return !button.classList.contains('displayNone');
    });
}

function actionMenuItems(row) {
    return visibleActions(row).map(button => ({
        label: button.title || button.getAttribute('aria-label') || button.dataset.i18n || 'Extension Action',
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

function rowNeedsCollapsedActions(row, actions, isNarrowViewport) {
    if (isNarrowViewport) return true;
    const rowWidth = row.getBoundingClientRect().width;
    if (!rowWidth || !actions.length) return false;
    const icon = row.querySelector('.extension_icon')?.getBoundingClientRect();
    const toggle = row.querySelector('.extension_toggle')?.getBoundingClientRect();
    const actionWidths = actions.reduce((total, action) => total + measureActionWidth(action), 0);
    const actionGap = Math.max(0, actions.length - 1) * 8;
    const titleWidth = rowWidth - (icon?.width ?? 0) - (toggle?.width ?? 0) - actionWidths - actionGap - 32;
    return titleWidth < rowWidth * 0.4;
}

function updateRowBatch(rows) {
    if (!rows.length) return;
    const isNarrowViewport = window.matchMedia(`(max-width: ${NARROW_VIEWPORT}px)`).matches;
    // Batch all geometry reads before DOM writes so multi-row layout causes at most one reflow.
    const plans = [];
    for (const row of rows) {
        if (!(row instanceof Element) || !row.isConnected) continue;
        const actionContainer = row.querySelector('.extension_actions');
        if (!actionContainer) continue;
        const actions = visibleActions(row);
        if (!actions.length) {
            plans.push({ row, actionContainer, actions, collapsed: false });
            continue;
        }
        plans.push({
            row,
            actionContainer,
            actions,
            collapsed: rowNeedsCollapsedActions(row, actions, isNarrowViewport),
        });
    }

    for (const { row, actionContainer, actions, collapsed } of plans) {
        if (!actions.length) {
            if (row.classList.contains('sb-extension-actions-collapsed')) row.classList.remove('sb-extension-actions-collapsed');
            actionContainer.querySelector('.sb-extension-actions-menu')?.remove();
            continue;
        }
        let trigger = actionContainer.querySelector('.sb-extension-actions-menu');
        if (!trigger) {
            trigger = createMenuTrigger(row);
            actionContainer.append(trigger);
        }
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

    // Drop mutations caused by this pass so our own class and trigger writes do not re-enter.
    rowObserver?.takeRecords();
}

function updateRows(root = observedContainer ?? document) {
    if (!(root instanceof Element) && root !== document) return;
    const rows = root.matches?.(EXTENSION_ROW_SELECTOR) ? [root] : [...root.querySelectorAll(EXTENSION_ROW_SELECTOR)];
    updateRowBatch(rows);
    rows.forEach(row => resizeObserver?.observe(row));
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
    observedContainer = null;
}

function initializeExtensionRowActions() {
    const container = document.querySelector(EXTENSION_CONTAINER_SELECTOR);
    if (!(container instanceof Element)) return;
    if (rowObserver && observedContainer === container) {
        updateRows(container);
        return;
    }
    disposeExtensionRowActions();
    observedContainer = container;
    resizeObserver = typeof ResizeObserver === 'function'
        ? new ResizeObserver(entries => updateRowBatch(entries.map(entry => entry.target)))
        : null;
    rowObserver = new MutationObserver(records => {
        const dirtyRows = new Set();
        for (const record of records) {
            record.removedNodes.forEach(unobserveRemovedRows);
            record.addedNodes.forEach(node => {
                if (!(node instanceof Element)) return;
                if (node.matches(EXTENSION_ROW_SELECTOR)) {
                    dirtyRows.add(node);
                } else {
                    node.querySelectorAll(EXTENSION_ROW_SELECTOR).forEach(row => dirtyRows.add(row));
                }
            });
            const row = record.target instanceof Element ? record.target.closest(EXTENSION_ROW_SELECTOR) : null;
            if (row) dirtyRows.add(row);
        }
        if (dirtyRows.size) {
            const rows = [...dirtyRows];
            updateRowBatch(rows);
            rows.forEach(row => resizeObserver?.observe(row));
        }
    });
    updateRows(container);
    rowObserver.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}

function bindExtensionManagerLifecycle() {
    if (managerLifecycleBound) return;
    document.addEventListener('sillybunny:extensions-manager-open', initializeExtensionRowActions);
    document.addEventListener('sillybunny:extensions-manager-close', disposeExtensionRowActions);
    managerLifecycleBound = true;
    // Only attach immediately if an extensions manager dialog is already mounted.
    if (document.querySelector(EXTENSION_CONTAINER_SELECTOR)) {
        initializeExtensionRowActions();
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindExtensionManagerLifecycle, { once: true });
} else {
    bindExtensionManagerLifecycle();
}
