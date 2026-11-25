/**
 * The parts of Conversation Mode that load after the page has started, and the functions through which the modules of
 * the startup reach them. A page fetches a part only when it needs it, and the startup resource limit of
 * `tests/frontend-performance.e2e.js` counts every module that a start fetches.
 *
 * - The runtime (`runtime.js`): the worker, the asides, the replies that the server wrote and their event stream. A page
 *   needs it when the persona has a conversation, or when the workspace opens.
 * - The workspace (`chrome.js`): the interface. A page needs it when the user opens the workspace.
 */

import { getConversationPersonaId } from './context.js';

/**
 * Makes a part that loads on first use.
 * @template T
 * @param {() => Promise<T>} importPart Imports the part. Called once, until it fails.
 * @returns {{ load: () => Promise<T>, loaded: T|null }}
 */
export function createLazyPart(importPart) {
    let loaded = null;
    let loading = null;
    return {
        /** A failed load is forgotten, so that the next call tries again. */
        load() {
            loading ??= importPart().then((part) => {
                loaded = part;
                return part;
            }, (error) => {
                loading = null;
                throw error;
            });
            return loading;
        },
        get loaded() {
            return loaded;
        },
    };
}

/** The worker, the asides and the reply stream. */
export const conversationRuntime = createLazyPart(() => import('./runtime.js'));

/**
 * The interface: the list, the header, the timeline, the composer, the pickers, the selection mode and the details window.
 * It lands the replies of the server whenever it reads a chat, so the stream that does it is installed before it opens.
 */
export const conversationWorkspace = createLazyPart(async () => {
    const [workspace] = await Promise.all([
        import('./chrome.js'),
        conversationRuntime.load().then(runtime => runtime.installConversationReplyStream()),
    ]);
    return workspace;
});

// A close that arrives while the workspace loads ends the open that waits for it, as it would have ended an open that had finished.
let closeRequests = 0;

/**
 * Runs a function of the workspace, now when it is loaded and after it has loaded when it is not.
 * @template T
 * @param {(workspace: typeof import('./chrome.js')) => T} run
 * @returns {T|Promise<T|false>} False when a close came in while the workspace loaded.
 */
function withWorkspace(run) {
    const workspace = conversationWorkspace.loaded;
    if (workspace) {
        return run(workspace);
    }
    const closesBefore = closeRequests;
    return conversationWorkspace.load().then(loaded => (closesBefore === closeRequests ? run(loaded) : false));
}

export function selectConversation(avatar, options) {
    return withWorkspace(workspace => workspace.selectConversation(avatar, options));
}

export function openConversationWorkspaceForAvatar(avatar, options) {
    return withWorkspace(workspace => workspace.openConversationWorkspaceForAvatar(avatar, options));
}

export function openConversationWorkspaceFromWelcome() {
    return withWorkspace(workspace => workspace.openConversationWorkspaceFromWelcome());
}

/**
 * Opens the workspace for the `sb:open-conversation-workspace` event, which names the conversation or leaves it to the
 * default, and carries the persona and the chat that were current when the event was sent.
 * @param {{ avatar?: string, chatId?: string, groupId?: string|null, personaId?: string, showToast?: boolean }|null} detail
 */
export function openConversationWorkspaceFromRequest(detail) {
    return withWorkspace(workspace => workspace.selectConversation(detail?.avatar || workspace.getDefaultConversationAvatar(), {
        chatId: detail?.chatId || '',
        groupId: detail?.groupId || null,
        personaId: detail?.personaId || getConversationPersonaId(),
        showToast: detail?.showToast !== false,
    }));
}

export function disableConversationModeForCurrentCharacter(options) {
    closeRequests += 1;
    const workspace = conversationWorkspace.loaded;
    if (workspace) {
        workspace.disableConversationModeForCurrentCharacter(options);
        return;
    }
    // Nothing was drawn, so nothing is left to close: the state of the workspace is still the closed one.
    if (options?.focusRoleplay ?? true) {
        document.getElementById('send_textarea')?.focus?.({ preventScroll: false });
    }
}

/**
 * Runs a function of the runtime, now when it is loaded and after it has loaded when it is not.
 * @param {(runtime: typeof import('./runtime.js')) => void} run
 */
function withRuntime(run) {
    const runtime = conversationRuntime.loaded;
    if (runtime) {
        run(runtime);
        return;
    }
    conversationRuntime.load().then(run, error => console.error('Conversation Mode: the runtime could not be loaded', error));
}

export function installConversationReplyStream() {
    withRuntime(runtime => runtime.installConversationReplyStream());
}

/** Starts the worker, and with it the reply stream. */
export function startConversationWorker() {
    withRuntime((runtime) => {
        runtime.installConversationReplyStream();
        runtime.startConversationWorker();
    });
}

/** Stops the worker. A page that did not load the runtime has none. */
export function stopConversationWorker() {
    conversationRuntime.loaded?.stopConversationAutoWorker();
}

export function handleRoleplayUserMessage(messageId) {
    withRuntime(runtime => runtime.handleRoleplayUserMessage(messageId));
}

export function handleRoleplayCharacterMessage(messageId) {
    withRuntime(runtime => runtime.handleRoleplayCharacterMessage(messageId));
}
