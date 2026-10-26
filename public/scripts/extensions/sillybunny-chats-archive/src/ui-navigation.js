import { dialog } from './ui/archive.js';
import { NAVIGATION_TIMEOUT_MS } from './ui/constants.js';
import { tr } from './ui/dom.js';

let hostNavigationPending = null;

export function navigateAndConfirm(ctx, fileId, action, { signal, timeout = NAVIGATION_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        let changed = false;
        let settled = false;
        let abortReason = null;
        let timer;
        const controller = new AbortController();
        const cleanup = () => {
            clearTimeout(timer);
            ctx.eventSource.removeListener(ctx.eventTypes.CHAT_CHANGED, onChanged);
            signal?.removeEventListener('abort', onExternalAbort);
            controller.signal.removeEventListener('abort', onAbort);
        };
        const finish = (failed, error) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            if (failed) {
                reject(error);
            } else if (changed || String(ctx.getCurrentChatId?.() ?? '') === String(fileId)) {
                resolve();
            } else {
                reject(new Error('Host did not confirm the requested chat'));
            }
        };
        const onChanged = chatId => {
            if (String(chatId) === String(fileId)) {
                changed = true;
            }
        };
        const onAbort = () => {
            abortReason = controller.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
            finish(true, abortReason);
        };
        const onExternalAbort = () => controller.abort(signal.reason);
        ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, onChanged);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        signal?.addEventListener('abort', onExternalAbort, { once: true });
        if (signal?.aborted) {
            controller.abort(signal.reason);
            return;
        }
        timer = setTimeout(() => controller.abort(new DOMException('Host navigation timed out.', 'TimeoutError')), timeout);
        Promise.resolve()
            .then(() => abortReason ? undefined : action(controller.signal))
            .then(() => {
                finish(!!abortReason, abortReason);
            }, error => {
                finish(true, abortReason ?? error);
            });
    });
}

async function restorePreviousChat(ctx, host, groupChats, previous) {
    try {
        if (previous.groupId != null) {
            if (await groupChats.openGroupById(previous.groupId)) {
                if (previous.chatId) {
                    await ctx.openGroupChat(previous.groupId, previous.chatId);
                }
                host.setActiveGroup(previous.groupId);
            }
        } else {
            const characterIndex = Number(previous.characterIndex);
            if (Number.isInteger(characterIndex) && characterIndex >= 0) {
                if (await ctx.selectCharacterById(characterIndex)) {
                    if (previous.chatId) {
                        await ctx.openCharacterChat(previous.chatId);
                    }
                    host.setActiveCharacter(ctx.characters[characterIndex]?.avatar);
                }
            } else if (groupChats.selected_group != null || (Number.isInteger(Number(host.this_chid)) && Number(host.this_chid) >= 0)) {
                await ctx.closeCurrentChat();
            }
        }
        ctx.saveSettingsDebounced();
    } catch (error) {
        console.warn('[Chat Archive] could not restore the previous chat after navigation failed:', error);
    }
}

export async function jumpToChat(ctx, state, row, control) {
    if (state.navigationPending || state.closed || hostNavigationPending) {
        return;
    }
    const controller = new AbortController();
    state.navigationPending = true;
    hostNavigationPending = controller;
    state.navigationAbort = controller;
    state.navigationControl = control;
    const copy = control.querySelector('.sbca-button-copy');
    const original = copy.textContent;
    control.setAttribute('aria-disabled', 'true');
    copy.textContent = tr(ctx, 'Opening...');
    let host;
    let groupChats;
    let previous;
    let navigationStarted = false;
    let navigationConfirmed = false;
    let navigationFinished = false;
    let hostActionRunning = false;
    const releaseHostNavigation = () => {
        if (navigationFinished && !hostActionRunning && hostNavigationPending === controller) {
            hostNavigationPending = null;
        }
    };
    const runHostAction = async action => {
        hostActionRunning = true;
        try {
            return await action();
        } finally {
            hostActionRunning = false;
            releaseHostNavigation();
        }
    };
    try {
        [host, groupChats] = await Promise.all([
            import('../../../../script.js'),
            import('../../../group-chats.js'),
        ]);
        controller.signal.throwIfAborted();
        previous = {
            groupId: groupChats.selected_group,
            characterIndex: host.this_chid,
            chatId: ctx.getCurrentChatId(),
        };
        if (row.kind === 'group') {
            const alreadyOpen = String(groupChats.selected_group) === String(row.groupId)
                && String(ctx.getCurrentChatId()) === String(row.file_id);
            if (!alreadyOpen) {
                navigationStarted = true;
                await navigateAndConfirm(ctx, row.file_id, signal => runHostAction(async () => {
                    const selected = await groupChats.openGroupById(row.groupId);
                    signal.throwIfAborted();
                    if (!selected) {
                        throw new Error('Failed to select group');
                    }
                    if (String(ctx.getCurrentChatId()) !== String(row.file_id)) {
                        await ctx.openGroupChat(row.groupId, row.file_id);
                        signal.throwIfAborted();
                    }
                }), { signal: controller.signal });
            }
            controller.signal.throwIfAborted();
            host.setActiveGroup(row.groupId);
        } else {
            const index = ctx.characters.findIndex(character => character.avatar === row.avatar);
            if (index === -1) {
                throw new Error(`Character not found for avatar: ${row.avatar}`);
            }
            const alreadyOpen = String(host.this_chid) === String(index) && String(ctx.getCurrentChatId()) === String(row.file_id);
            if (!alreadyOpen) {
                navigationStarted = true;
                await navigateAndConfirm(ctx, row.file_id, signal => runHostAction(async () => {
                    const selected = await ctx.selectCharacterById(index);
                    signal.throwIfAborted();
                    if (!selected) {
                        throw new Error('Failed to select character');
                    }
                    if (String(ctx.getCurrentChatId()) !== String(row.file_id)) {
                        await ctx.openCharacterChat(row.file_id);
                        signal.throwIfAborted();
                    }
                }), { signal: controller.signal });
            }
            controller.signal.throwIfAborted();
            host.setActiveCharacter(row.avatar);
        }
        if (String(ctx.getCurrentChatId()) !== String(row.file_id)) {
            throw new Error('Host did not open the requested chat');
        }
        navigationConfirmed = true;
        ctx.saveSettingsDebounced();
        if (!state.closed && dialog === state.dialog) {
            state.restoreFocus = false;
            state.dialog.forceClose();
            await state.dialog.closed;
            document.getElementById('send_textarea')?.focus();
        }
    } catch (error) {
        const cancelled = error?.name === 'AbortError' || error?.name === 'TimeoutError';
        // ponytail: host navigation cannot be canceled; do not race rollback against a timed-out call.
        if (!cancelled && navigationStarted && !navigationConfirmed && host && groupChats && previous) {
            await restorePreviousChat(ctx, host, groupChats, previous);
        }
        if (error?.name !== 'AbortError') {
            console.error('[Chat Archive] failed to open chat:', error);
            globalThis.toastr?.error(tr(ctx, 'Could not open this chat. The archive is still available.'));
        }
    } finally {
        // ponytail: keep the lock until uncancellable timed-out host work settles.
        navigationFinished = true;
        releaseHostNavigation();
        if (state.navigationAbort === controller) {
            state.navigationPending = false;
            state.navigationAbort = null;
            const currentControl = state.navigationControl;
            state.navigationControl = null;
            for (const target of new Set([control, currentControl])) {
                if (target?.isConnected) {
                    target.removeAttribute('aria-disabled');
                    target.querySelector('.sbca-button-copy').textContent = target === control ? original : tr(ctx, 'Open chat');
                }
            }
        }
    }
}
