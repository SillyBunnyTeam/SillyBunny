/**
 * The details window: a modal window at the Dialog tier, a bottom sheet on a phone, whose pages push and pop in the
 * dialog frame's navigation stack. A page is built when it is pushed and dropped when it pops; every row saves its
 * own setting as it changes, so a page holds no state that the window has to write back.
 *
 * A page builder is `(context, args) => { title, subtitle?, content, responses?, onResponse?, onMount?, dispose? }`, where
 * `responses` is the explicit-action form (Cancel at the start, the affirmative at the end) that `openDialog` takes.
 */

import { openDialog } from '../../sillybunny-editor/dialog.js';
import { CONVERSATION_DETAILS_CLOSE_EVENT } from '../constants.js';
import { releaseRowIds } from '../../sillybunny-editor/rows.js';
import { getView } from './access.js';
import { el } from './page-kit.js';
import { buildPage, isKnownPage } from './pages/index.js';
import { ensureDetailsStyles } from './styles.js';

/**
 * @typedef {object} OpenSession
 * @property {ReturnType<typeof openDialog>} dialog
 * @property {string} conversationId Empty for Preferences, which belongs to no conversation.
 * @property {{ handle: any, spec: any }[]} pages The pushed pages, bottom first.
 * @property {any} rootSpec
 * @property {string} rootId
 * @property {ReturnType<typeof createNavigation>} nav
 * @property {boolean} replacing True while another conversation is about to take the place of the one that is shown.
 */

/** The pages that belong to a conversation; Preferences and its rules editor belong to the mode. */
const CONVERSATION_PAGES = new Set(['general', 'edit', 'members', 'add-member', 'profile', 'chats', 'media', 'files', 'pinned', 'behaviour', 'advanced']);

/** @type {OpenSession|null} */
let session = null;
let openToken = 0;

function createNavigation(current) {
    return {
        push: (id, args = {}) => pushPage(current, id, args),
        pop: () => void current.pages.at(-1)?.handle.close(),
        close: () => current.dialog.close(),
        // The conversation that the window shows is gone. A page calls this, and the window closes unless another conversation
        // is about to take its place (a group that became a direct conversation).
        gone: () => {
            if (!current.replacing) {
                void current.dialog.close();
            }
        },
        replacing: (on) => {
            current.replacing = on;
        },
        toast: message => globalThis.toastr?.info?.(message),
        viewPicture: picture => pushPicture(current, picture),
        reroot: (conversationId, pageId = 'general') => reroot(current, conversationId, pageId),
    };
}

function buildInto(current, id, args) {
    return buildPage(id, { conversationId: current.conversationId, nav: current.nav }, args);
}

function pushPage(current, id, args = {}) {
    if (!current.dialog.isOpen || !isKnownPage(id)) {
        return null;
    }
    let spec;
    try {
        spec = buildInto(current, id, args);
    } catch (error) {
        console.error(`Conversation Mode: the ${id} page could not be built`, error);
        globalThis.toastr?.error?.('This page could not be opened');
        return null;
    }
    const handle = current.dialog.push({
        title: spec.title,
        subtitle: spec.subtitle,
        content: spec.content,
        responses: spec.responses ?? null,
        className: `sb-details-frame sb-details-frame--${id}`,
    });
    const entry = { handle, spec };
    current.pages.push(entry);
    spec.onMount?.({
        setResponseEnabled: (responseId, enabled) => handle.setResponseEnabled(responseId, enabled),
        setTitle: title => handle.setTitle(title),
    });
    handle.closed.then(({ response }) => {
        const committed = spec.responses && response !== 'cancel' && response !== 'back' && response !== 'close';
        spec.dispose?.();
        releaseRowIds(spec.content);
        current.pages.splice(current.pages.indexOf(entry), 1);
        if (committed) {
            spec.onResponse?.(response);
        }
    });
    return handle;
}

/** A picture opens as a page of the window: the zoomed avatar is a child of `body`, and would sit under the window's inert layer. */
function pushPicture(current, { title, src, kind = 'image', alt = '' }) {
    if (!current.dialog.isOpen || !src) {
        return null;
    }
    const body = el('div', 'sb-details-picture');
    const media = kind === 'video' ? el('video', 'sb-details-picture__media') : el('img', 'sb-details-picture__media');
    media.src = src;
    if (kind === 'video') {
        media.controls = true;
    } else {
        media.alt = alt;
    }
    body.append(media);
    const handle = current.dialog.push({ title, content: body, className: 'sb-details-frame sb-details-frame--picture' });
    const entry = { handle, spec: { content: body } };
    current.pages.push(entry);
    handle.closed.then(() => {
        current.pages.splice(current.pages.indexOf(entry), 1);
    });
    return handle;
}

function popToRoot(current) {
    for (const entry of [...current.pages].reverse()) {
        entry.handle.forceClose();
    }
}

function drawRoot(current, id, args) {
    current.rootSpec?.dispose?.();
    current.rootSpec = buildInto(current, id, args);
    releaseRowIds(current.dialog.body);
    current.dialog.body.replaceChildren(current.rootSpec.content);
    current.dialog.setTitle(current.rootSpec.title);
    current.dialog.setSubtitle(current.rootSpec.subtitle ?? '');
    current.rootId = id;
}

/** Puts another conversation's General page in place of the pages that are open, as after a group became a direct conversation. */
function reroot(current, conversationId, pageId) {
    popToRoot(current);
    current.conversationId = conversationId;
    current.replacing = false;
    current.dialog.surface.dataset.sbDetailsConversation = conversationId;
    drawRoot(current, pageId, {});
}

async function open({ conversationId, path }) {
    const token = ++openToken;
    await ensureDetailsStyles().catch(error => console.warn('Conversation Mode: the details stylesheet failed to load', error));
    if (token !== openToken) {
        return null;
    }
    if (session?.dialog.isOpen) {
        session.dialog.forceClose();
    }
    /** @type {OpenSession} */
    const current = { dialog: /** @type {any} */ (null), conversationId, pages: [], rootSpec: null, rootId: path[0].id, nav: null, replacing: false };
    current.nav = createNavigation(current);
    let rootSpec;
    try {
        rootSpec = buildInto(current, path[0].id, path[0].args ?? {});
    } catch (error) {
        console.error('Conversation Mode: the details could not be built', error);
        globalThis.toastr?.error?.('The details could not be opened');
        return null;
    }
    current.rootSpec = rootSpec;
    current.dialog = openDialog({
        tier: 'dialog',
        title: rootSpec.title,
        subtitle: rootSpec.subtitle,
        content: rootSpec.content,
        className: 'sb-details-window',
        responses: rootSpec.responses ?? null,
    });
    current.dialog.surface.dataset.sbDetailsConversation = conversationId;
    session = current;
    const opened = current.dialog;
    opened.closed.then(() => {
        current.rootSpec?.dispose?.();
        if (current.rootSpec?.content) {
            releaseRowIds(current.rootSpec.content);
        }
        current.pages.length = 0;
        if (session === current) {
            session = null;
        }
    });
    for (const { id, args } of path.slice(1)) {
        pushPage(current, id, args ?? {});
    }
    return opened;
}

/**
 * Opens the details of a conversation, at one of its pages. Any page other than General is one level below it, so Back
 * returns to General.
 * @param {string} conversationId
 * @param {{ page?: string, avatar?: string }} [options] `page` is one of `general`, `edit`, `members`, `add-member`, `profile`
 * (with `avatar`, the character file of the person), `chats`, `media`, `files`, `pinned`, `behaviour` and `advanced`.
 * @returns {Promise<boolean>} Whether the window is open: false for a conversation that is gone or a page that does not exist.
 */
export async function openConversationDetails(conversationId, { page = 'general', avatar = '' } = {}) {
    if (!getView(conversationId) || !CONVERSATION_PAGES.has(page)) {
        return false;
    }
    const path = page === 'general' ? [{ id: 'general' }] : [{ id: 'general' }, { id: page, args: { avatar } }];
    return Boolean(await open({ conversationId, path }));
}

/** Opens the mode-wide Preferences. It belongs to no conversation, so it is the only page of its window. */
export async function openConversationPreferences() {
    return Boolean(await open({ conversationId: '', path: [{ id: 'preferences' }] }));
}

// The app leaving conversation mode, or a change of persona, takes the conversation that the window shows with it.
for (const eventName of ['sb:close-conversation-workspace', CONVERSATION_DETAILS_CLOSE_EVENT]) {
    window.addEventListener(eventName, () => {
        if (session?.dialog.isOpen) {
            session.dialog.forceClose();
        }
    });
}
