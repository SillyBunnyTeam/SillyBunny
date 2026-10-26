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
        void listEditor.selectItem(current, { guard: false, transition: false });
    }
}

export function focusChatRow(ui, key) {
    [...ui.list.querySelectorAll('[data-sbca-key]')]
        .find(row => row.dataset.sbcaKey === key)
        ?.focus({ preventScroll: true });
}
