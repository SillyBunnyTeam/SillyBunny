import { openDialog } from '../../../../sillybunny-editor/dialog.js';
import { loadListEditorStyles } from '../../../../sillybunny-editor/list-shell.js';
import { LIST_PAGE_SIZE } from './constants.js';
import { tr } from './dom.js';
import { loadRows, releaseArchiveReadSession } from './inventory.js';
import { archiveMenuSections } from './menus.js';
import { flushOrganization } from './organization-save.js';
import { loadOrganization } from './organization.js';
import { mountArchive } from './root.js';
import { closeMentionsOnEscape, createSearchField, handleQueryChange } from './search.js';
import { createViewModel } from './view-model.js';

const ENTITY_LIST_STYLESHEET = { href: 'css/sillybunny-entity-list.css?v=20261018a', id: 'deferred-entity-list-css' };

export let dialog = null;

// Closing bumps this, so an open that is still loading its styles finds out it was cancelled.
let openToken = 0;

export async function closeArchive() {
    openToken++;
    const current = dialog;
    if (!current) {
        return;
    }
    current.forceClose();
    await current.closed;
}

function loadArchiveStyles() {
    const loader = globalThis.SillyBunnyAssets?.loadStylesheetAsync;
    return Promise.all([
        loadListEditorStyles(),
        loader ? loader(ENTITY_LIST_STYLESHEET.href, { id: ENTITY_LIST_STYLESHEET.id }) : undefined,
    ]);
}

export async function openArchive(ctx, opener = null) {
    if (dialog) {
        dialog.root.focus({ preventScroll: true });
        return;
    }
    const token = openToken;
    await loadArchiveStyles();
    if (dialog || token !== openToken) {
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
        viewerPage: null,
        visibleLimit: LIST_PAGE_SIZE,
        matchingRows: [],
        model: createViewModel(),
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
    const searchField = createSearchField(ctx);
    const ui = {
        pages: [],
        filterButtons: new Set(),
        listPage: null,
        organizationPage: null,
        queryTimer: null,
        mentionIndex: -1,
        search: searchField.input,
        mentionMenu: searchField.menu,
        characterMentions: searchField.mentions,
    };
    const instance = openDialog({
        tier: 'window',
        size: 'fill',
        className: 'sbca-dialog',
        title: tr(ctx, 'Chat Archive'),
        search: {
            input: ui.search,
            collapsed: true,
            escapeClearsFirst: true,
            onEscape: () => closeMentionsOnEscape(ui),
            onChange: () => handleQueryChange(ctx, state, ui),
        },
        menu: trigger => archiveMenuSections(ctx, state, ui, trigger),
    });
    dialog = instance;
    state.dialog = instance;

    try {
        state.cleanup = mountArchive(ctx, state, ui, instance);
        void loadRows(ctx, state, ui);
        void loadOrganization(ctx, state, ui);
        await instance.closed;
    } finally {
        instance.forceClose();
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
        if (dialog === instance) {
            dialog = null;
        }
        if (state.restoreFocus) {
            const returnTarget = opener?.isConnected ? opener : document.getElementById('sbca_drawer_button');
            returnTarget?.focus({ preventScroll: true });
        }
        void releasing;
    }
}
