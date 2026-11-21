export function pushPage(ui, spec) {
    const page = ui.dialog.push(spec);
    ui.pages.push(page);
    void page.closed.then(() => {
        const index = ui.pages.indexOf(page);
        if (index >= 0) {
            ui.pages.splice(index, 1);
        }
        ui.onPageClosed?.(page);
    });
    return page;
}

export function syncLocationPane(ui) {
    const { listEditor } = ui;
    if (!listEditor) {
        return;
    }
    const { current } = ui.data.locations;
    // Selection mode owns the page title while it runs.
    if (!ui.selection?.isActive) {
        ui.listPage?.setTitle(current.label);
    }
    if (!listEditor.collapsed && (!listEditor.isOpen || listEditor.selectedKey !== current.key)) {
        return listEditor.selectItem(current, { guard: false, transition: false });
    }
    return undefined;
}

export function focusChatRow(ui, key) {
    [...ui.list.querySelectorAll('[data-sbca-key]')]
        .find(row => row.dataset.sbcaKey === key)
        ?.focus({ preventScroll: true });
}

/** The open chat's row when the list shows it, otherwise the selected location in the sidebar. */
export function focusSelection(ui, key) {
    const row = key ? [...ui.list.querySelectorAll('[data-sbca-key]')].find(item => item.dataset.sbcaKey === key) : null;
    (row ?? ui.sidebar?.querySelector('.sbca-location[aria-pressed="true"]'))?.focus({ preventScroll: true });
}
