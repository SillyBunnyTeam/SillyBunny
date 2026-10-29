export function organizationFocusKey(...parts) {
    return JSON.stringify(parts);
}

export function markOrganizationControl(node, focusKey = '', fallbackKey = '') {
    node.dataset.sbcaOrganizationControl = '';
    if (focusKey) {
        node.dataset.sbcaFocusKey = focusKey;
    }
    if (fallbackKey) {
        node.dataset.sbcaFocusFallback = fallbackKey;
    }
    return node;
}

export function focusByKey(ui, key) {
    [...ui.root.querySelectorAll('[data-sbca-focus-key]')]
        .find(control => control.dataset.sbcaFocusKey === key)
        ?.focus({ preventScroll: true });
}

export function preserveArchiveFocus(ui, update) {
    const active = document.activeElement;
    const snapshot = active && ui.root.contains(active) ? {
        key: active.dataset.sbcaFocusKey,
        fallback: active.dataset.sbcaFocusFallback,
        list: ui.list.contains(active),
        viewer: ui.viewerContent.contains(active),
    } : null;
    update();
    if (!snapshot || active.isConnected) {
        return;
    }
    const controls = [...ui.root.querySelectorAll('[data-sbca-focus-key]')];
    const target = controls.find(control => control.dataset.sbcaFocusKey === snapshot.key)
        ?? controls.find(control => control.dataset.sbcaFocusKey === snapshot.fallback)
        ?? (snapshot.viewer ? ui.viewerContent : snapshot.list ? ui.listHeading : null);
    target?.focus({ preventScroll: true });
}
