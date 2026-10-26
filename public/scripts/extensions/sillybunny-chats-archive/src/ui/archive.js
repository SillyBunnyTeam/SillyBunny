import { LIST_PAGE_SIZE } from './constants.js';
import { tr } from './dom.js';
import { loadRows, releaseArchiveReadSession } from './inventory.js';
import { flushOrganization } from './organization-save.js';
import { loadOrganization } from './organization.js';
import { buildRoot } from './root.js';

export let popup = null;

export async function closeArchive() {
    await popup?.completeCancelled();
}

export async function openArchive(ctx, opener = null) {
    if (popup) {
        popup.dlg?.focus();
        return;
    }

    const state = {
        rows: [],
        orphanRows: [],
        deepRows: null,
        deepQuery: '',
        listState: 'loading',
        listAbort: null,
        viewerAbort: null,
        searchAbort: null,
        scanAbort: null,
        orphanScanComplete: false,
        inventoryFailures: 0,
        archiveReadToken: null,
        orphanScanReadToken: null,
        navigationPending: false,
        navigationAbort: null,
        navigationControl: null,
        restoreFocus: true,
        selectedKey: null,
        selectedRow: null,
        selectedButton: null,
        selectedBatchKeys: new Set(),
        selectionMode: false,
        collapsedGroups: new Set(),
        visibleLimit: LIST_PAGE_SIZE,
        matchingRows: [],
        charactersByAvatar: new Map((ctx.characters ?? []).filter(character => character?.avatar).map(character => [character.avatar, character])),
        groupsById: new Map((ctx.groups ?? []).filter(group => group?.id !== undefined && group?.id !== null).map(group => [String(group.id), group])),
        organization: null,
        organizationLoadState: 'loading',
        organizationLoadAbort: null,
        organizationLoadError: null,
        organizationWritable: false,
        organizationRevision: 0,
        organizationRequestedRevision: 0,
        organizationSavedRevision: 0,
        organizationSaveError: null,
        organizationSaveRunning: false,
        organizationSavePromise: Promise.resolve(),
        lastViewSaveTimer: null,
        viewTouched: false,
        selectedViewId: null,
        closed: false,
    };
    const ui = buildRoot(ctx, state);
    const instance = new ctx.Popup(ui.root, ctx.POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        tier: 'window',
        allowVerticalScrolling: false,
        okButton: tr(ctx, 'Close'),
    });
    popup = instance;
    state.popup = instance;
    instance.dlg?.classList.add('sbca-dialog');
    instance.dlg?.setAttribute('aria-labelledby', 'sbca_heading');
    instance.okButton?.addEventListener('keydown', event => {
        if (event.key === ' ') {
            event.preventDefault();
            instance.okButton.click();
        }
    });

    try {
        const shown = instance.show();
        ui.observeLayout();
        void loadRows(ctx, state, ui);
        void loadOrganization(ctx, state, ui);
        await shown;
    } finally {
        state.closed = true;
        state.listAbort?.abort();
        state.viewerAbort?.abort();
        state.searchAbort?.abort();
        state.navigationAbort?.abort();
        state.scanAbort?.abort();
        state.organizationLoadAbort?.abort();
        state.cleanup?.();
        await flushOrganization(ctx, state, ui);
        const releasing = releaseArchiveReadSession(ctx, state);
        if (popup === instance) {
            popup = null;
        }
        if (state.restoreFocus) {
            const returnTarget = opener?.isConnected ? opener : document.getElementById('sbca_drawer_button');
            returnTarget?.focus({ preventScroll: true });
        }
        void releasing;
    }
}
