import { characters, this_chid, selectCharacterById } from '../script.js';
import {
    groupEditorTargetExists,
    canPeekGroupMember,
    openGroupMemberDefinition,
    openGroupEditor,
    captureGroupEditorListState,
    restoreGroupEditorListState,
} from './group-chats.js';
import { t } from './i18n.js';
import { objectNavigation } from './sillybunny-editor/object-navigation.js';

const EDITOR_READY_TIMEOUT = 5000;
const EDITOR_READY_INTERVAL = 50;

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

        const opened = target.via === 'group-member' && canPeekGroupMember(target.id)
            ? await openGroupMemberDefinition(target.id, { isCurrent })
            : await selectCharacterById(index, { switchMenu: true });
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
        const opened = await openGroupEditor(target.id, { switchChat: false, isCurrent });
        if (!isCurrent() || !opened) return false;
        if (restore) await restoreGroupEditorListState(restore);
        return isCurrent();
    },
    captureState: () => captureGroupEditorListState(),
});

objectNavigation.setNotify((reason, target) => {
    if (reason === 'missing') {
        toastr.warning(t`lorum ipsum`); // HUMAN: replace — missing navigation destination
    } else if (reason === 'failed') {
        toastr.error(t`lorum ipsum`); // HUMAN: replace — failed navigation destination
    }
});

objectNavigation.bindTopLevelClear('[data-sb-character-tab], [data-sb-settings-tab]');
