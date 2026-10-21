import { characters, this_chid, selectCharacterById } from '../script.js';
import {
    groupEditorTargetExists,
    canPeekGroupMember,
    openGroupMemberDefinition,
    openGroupEditor,
    captureGroupEditorListState,
    restoreGroupEditorListState,
    selected_group,
} from './group-chats.js';
import { t } from './i18n.js';
import { objectNavigation } from './sillybunny-editor/object-navigation.js';
import { rememberOpenedEntity } from './sillybunny-auto-load.js';
import {
    world_names, openWorldInfoEditor, getWorldInfoEditorState,
    captureWorldInfoEditorListState, restoreWorldInfoEditorListState,
} from './world-info.js';
import { power_user } from './power-user.js';

const EDITOR_READY_TIMEOUT = 5000;
const EDITOR_READY_INTERVAL = 50;
let createOrigin = 'characters';
let createNavigationRevision = 0;

export function recordCharacterCreateOrigin(view = 'characters') {
    createOrigin = view === 'groups' ? 'groups' : 'characters';
    createNavigationRevision++;
}

function characterEditorScroller() {
    return document.querySelector('#form_create .sb-editor-sheet__content');
}

function isCharacterEditorReady(avatar) {
    if (characters[this_chid]?.avatar !== avatar) return false;
    const panel = document.getElementById('right-nav-panel');
    const editor = document.getElementById('rm_ch_create_block');
    if (!panel?.classList.contains('openDrawer') || panel.dataset.menuType !== 'character_edit') return false;
    if (!(editor instanceof HTMLElement) || editor.hidden || !editor.getClientRects().length) return false;
    const style = getComputedStyle(editor);
    if (style.display === 'none' || style.visibility === 'hidden') return false;

    // syncCharacterShellTabs mirrors the Editor selection into both shell layouts.
    return Boolean(document.querySelector(
        '#right-nav-panel [data-sb-character-tab="editor"][aria-selected="true"], '
        + '#sb-settings-tab-list [data-sb-settings-tab="editor"][aria-selected="true"]',
    ));
}

function waitForCharacterEditor(avatar, isCurrent) {
    const deadline = Date.now() + EDITOR_READY_TIMEOUT;
    return new Promise(resolve => {
        const check = () => {
            if (!isCurrent()) return resolve(false);
            if (isCharacterEditorReady(avatar)) return resolve(true);
            if (Date.now() >= deadline) return resolve(false);
            setTimeout(check, EDITOR_READY_INTERVAL);
        };
        check();
    });
}

objectNavigation.register('character-editor', {
    exists: avatar => characters.some(character => character?.avatar === avatar),
    async open(target, { restore = null, isCurrent }) {
        if (!isCurrent()) return false;
        const index = characters.findIndex(character => character?.avatar === target.id);
        if (index < 0) return false;

        const peek = target.via === 'group-member' && canPeekGroupMember(target.id);
        if (restore && !peek && characters[this_chid]?.avatar !== target.id) {
            return listDestination('characters', 'character-list').open({ focusAvatar: target.id }, { isCurrent });
        }
        const opened = peek
            ? await openGroupMemberDefinition(target.id, { isCurrent })
            : await selectCharacterById(index, { switchMenu: true });
        // Only a forward open switches chats: Back stays on the selected character and a peek keeps the group chat.
        if (opened && !peek && !restore) rememberOpenedEntity('character', target.id);
        if (!isCurrent() || !opened) return false;
        const ready = await waitForCharacterEditor(target.id, isCurrent);
        if (!isCurrent() || !ready) return false;

        const scroller = characterEditorScroller();
        if (scroller && restore) scroller.scrollTop = restore.scrollTop;
        return true;
    },
    captureState: () => ({ scrollTop: characterEditorScroller()?.scrollTop ?? 0 }),
});

objectNavigation.register('group-editor', {
    exists: id => groupEditorTargetExists(id),
    async open(target, { restore = null, isCurrent }) {
        if (!isCurrent()) return false;
        const switchChat = target.via === 'group-list';
        const opened = await openGroupEditor(target.id, { switchChat, isCurrent });
        // Without switchChat the editor opens over whichever chat is already open. With it, the chat can
        // switch even when the editor never shows or a newer navigation supersedes this one.
        if (switchChat && selected_group === target.id) rememberOpenedEntity('group', target.id);
        if (!isCurrent() || !opened) return false;
        if (restore) await restoreGroupEditorListState(restore);
        return isCurrent();
    },
    captureState: () => captureGroupEditorListState(),
});

objectNavigation.setNotify((reason, target) => {
    if (reason === 'missing') {
        toastr.warning(t`This item is no longer available.`);
    } else if (reason === 'failed') {
        toastr.error(t`This item could not be opened.`);
    }
});

objectNavigation.bindTopLevelClear('[data-sb-character-tab], [data-sb-settings-tab]');

async function revealCharacterListRow(list, avatar, isCurrent) {
    const snapshot = {
        query: characters.find(character => character?.avatar === avatar)?.name ?? '',
        page: 1, focusKey: `character:${avatar}`,
    };
    document.querySelector('#rm_characters_block .clearAllFilters')?.click();
    while (isCurrent()) {
        await list.restoreCharacterListState(snapshot, isCurrent);
        if (!isCurrent()) return false;
        const row = [...document.querySelectorAll('.sb-character-list [data-sb-list-key]')]
            .find(row => row.dataset.sbListKey === snapshot.focusKey);
        if (row) {
            row.scrollIntoView?.({ block: 'nearest' });
            row.focus({ preventScroll: true });
            return true;
        }
        const next = document.querySelector('.sb-character-list .sb-list-pagination__next');
        if (!next || next.disabled || snapshot.page >= characters.length) return false;
        snapshot.page++;
    }
    return false;
}

function listDestination(view, kind) {
    return {
        exists: () => true,
        async open(target, { restore = null, isCurrent }) {
            if (!isCurrent()) return false;
            const shell = globalThis.SillyBunnyShell;
            if (typeof shell?.openTab !== 'function') return false;
            const list = await import('./sillybunny-character-list.js');
            if (!isCurrent()) return false;
            const cancelRestore = restore ? list.prepareCharacterListRestore(view, restore, isCurrent) : () => {};
            try {
                const opened = await shell.openTab('characters', view);
                if (opened === false || !isCurrent()) return false;
                const controller = await list.mountCharacterList();
                if (!isCurrent()) return false;
                if (target.revealKey) {
                    return controller.revealByKey(target.revealKey, { highlight: true, isCurrent });
                }
                if (target.focusAvatar) return revealCharacterListRow(list, target.focusAvatar, isCurrent);
                return isCurrent();
            } finally {
                cancelRestore();
            }
        },
        captureState: () => globalThis.SillyBunnyCharacterListController?.captureState?.() ?? null,
        current: () => ({ kind }),
    };
}

objectNavigation.register('character-list', listDestination('characters', 'character-list'));
objectNavigation.register('group-list', listDestination('groups', 'group-list'));

export async function returnToCreatedEntity(type, key) {
    if (typeof key !== 'string' || !key) return false;
    const view = type === 'group_create' ? 'groups' : type === 'char_create' ? createOrigin : 'characters';
    const kind = view === 'groups' ? 'group-list' : 'character-list';
    const revision = ++createNavigationRevision;
    createOrigin = 'characters';
    objectNavigation.clear();
    return listDestination(view, kind).open({ revealKey: key }, { isCurrent: () => revision === createNavigationRevision });
}

globalThis.SillyBunnyCharactersNavigation = {
    recordCreateOrigin: recordCharacterCreateOrigin,
    returnToCreatedEntity,
};

objectNavigation.register('world-info', {
    exists: name => world_names.includes(name),
    async open(target, { restore = null, isCurrent }) {
        if (!isCurrent()) return false;
        const opened = await openWorldInfoEditor(target.id, { isCurrent });
        if (!opened || !isCurrent()) return false;
        if (restore && !await restoreWorldInfoEditorListState(restore, isCurrent)) return false;
        return isCurrent();
    },
    captureState: () => captureWorldInfoEditorListState(),
    current: () => {
        const { name } = getWorldInfoEditorState();
        return name ? { kind: 'world-info', id: name } : null;
    },
});

function personaDetailScroller() {
    return document.querySelector('#PersonaManagement .sb-persona-entry-body');
}

objectNavigation.register('persona-editor', {
    exists: avatarId => Object.hasOwn(power_user.personas ?? {}, avatarId),
    async open(target, { restore = null, isCurrent }) {
        if (!isCurrent()) return false;
        const { openPersonaEditor } = await import('./sillybunny-persona-editor.js');
        if (!isCurrent()) return false;
        const opened = await openPersonaEditor({ avatarId: target.id, section: target.section, isCurrent });
        if (!opened || !isCurrent()) return false;
        const scroller = personaDetailScroller();
        if (restore && scroller) scroller.scrollTop = restore.scrollTop;
        return isCurrent();
    },
    captureState: () => ({ scrollTop: personaDetailScroller()?.scrollTop ?? 0 }),
    current: () => {
        const id = document.querySelector('#PersonaManagement .sb-persona-editor')?.getAttribute('data-persona-avatar-id');
        return id ? { kind: 'persona-editor', id } : null;
    },
});
