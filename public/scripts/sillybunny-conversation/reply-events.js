/**
 * What the server tells this page about the replies of every conversation of the user, over one event stream
 * (`GET /api/resumable-generations/events?owner=conversations`). The server writes a reply into a chat when no page
 * took it, and loses one when it restarts; this is how a page that has the chat open learns of both.
 *
 * - `committed`: the reply is a pending message in the chat. A page that has the chat loaded reads it again, so that
 *   the finalizer lands it. For a chat that is not loaded the list is read again once, for the badge and the preview;
 *   the reply is landed when that chat is opened.
 * - `failed`: shown only for a failure of the model or the provider. The refusals of the server's validity rule are the
 *   queue's own silent drop, and any other reason is a text that the server worded and may hold a path, so it is
 *   never shown.
 * - `lost`: a restart took the reply. A notice, with Regenerate when the chat still ends in the message that it answered.
 *
 * Whatever belongs to the page comes in through the arguments, so that a test drives it with a fake stream.
 */

const COMMITTED_REFRESH_DELAY_MS = 500;
/** The reasons of a failed commit that say the model or the provider failed, and so are worth showing. */
const FAILURE_REASON = /^(?:error-reply|empty-reply|no-reply|error|status-\d{3})$/;

const addressOf = item => ({ conversationId: item.conversation, chatId: item.chat });

/**
 * @param {object} parts
 * @param {ReturnType<typeof import('./conversation-data.js').createConversationData>} parts.data
 * @param {string} parts.pageId The id of this page load, which the server uses to tell its replies from a closed page's.
 * @param {(url: string) => { addEventListener: Function, close: () => void }} [parts.createSource] `new EventSource(url)`.
 * @param {() => string[]} parts.getActiveGenerationIds The generations that this page is reading.
 * @param {() => boolean} parts.isVisible
 * @param {() => boolean} parts.hasUsage Whether the user has used the mode. A user who never did opens no stream.
 * @param {object} parts.page What the page does with what it hears.
 * @param {(address: { conversationId: string, chatId: string }) => Promise<void>} parts.page.reloadChat Reads the chat again and lands the reply.
 * @param {(generationId: string) => boolean} parts.page.wasLanded
 * @param {(generationIds: string[]) => void} parts.page.acknowledge
 * @param {(notice: { item: Record<string, any>, regenerate: (() => void)|null }) => void} parts.page.showLost
 * @param {(item: Record<string, any>) => void} parts.page.showFailed
 * @param {(address: { conversationId: string, chatId: string }, round: { remaining: string[], started: number }|null) => void} parts.page.regenerate Queues a forced reply.
 * @param {() => number} [parts.now]
 */
export function createReplyEvents({
    data,
    pageId,
    createSource = url => new EventSource(url),
    getActiveGenerationIds,
    isVisible,
    hasUsage,
    page,
    now = Date.now,
}) {
    let source = null;
    let refreshTimer = null;
    /** Generations that this page already acted on, so that a repeat before the acknowledgement lands does nothing. */
    const handled = new Set();
    /** Committed replies that are being read for now, and those of unloaded chats that the list was already read again for. */
    const working = new Set();
    const refreshed = new Set();

    /**
     * Over HTTP/1.1 a browser opens about six connections per server for all its tabs, so a hidden tab lets go of its
     * stream, as roleplay's does. A page keeps it while it reads a reply of its own: the server must see that page
     * follow the chat, or another page has the reply written before this one claims it.
     */
    function sync() {
        const wanted = hasUsage() && (isVisible() || getActiveGenerationIds().length > 0);
        if (!wanted) {
            close();
            return;
        }
        if (source) {
            return;
        }
        source = createSource(`/api/resumable-generations/events?${new URLSearchParams({ owner: 'conversations', page: pageId })}`);
        const mine = source;
        source.addEventListener('message', (event) => {
            if (source !== mine) {
                return;
            }
            try {
                void handle(JSON.parse(event.data).pending);
            } catch (error) {
                console.warn('Conversation Mode: the replies that the server follows could not be read', error);
            }
        });
    }

    function close() {
        source?.close();
        source = null;
        clearTimeout(refreshTimer);
        refreshTimer = null;
    }

    function scheduleRefresh() {
        if (refreshTimer) {
            return;
        }
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            void data.refresh();
        }, COMMITTED_REFRESH_DELAY_MS);
    }

    /** Whether the user can ask again for a reply that a restart lost: the chat still ends in what it answered, and the reply did not land. */
    async function getRegenerate(item) {
        const address = addressOf(item);
        let chat = data.chat(address);
        if (!chat) {
            try {
                chat = await data.loadChat(address);
            } catch {
                return null;
            }
        }
        const messages = chat?.messages ?? [];
        const lastUser = [...messages].reverse().find(message => message?.role === 'user');
        const triggers = Array.isArray(item.triggers) ? item.triggers : [];
        if (!lastUser || !triggers.includes(lastUser.id) || messages.some(message => message?.extra?.reply_token === item.token)) {
            return null;
        }
        const isGroup = data.get(item.conversation)?.kind === 'group';
        const remaining = [item.member, ...(Array.isArray(item.round) ? item.round : [])].filter(avatar => typeof avatar === 'string' && avatar);
        return () => page.regenerate(address, isGroup && remaining.length ? { remaining, started: now() } : null);
    }

    /** @returns {Promise<boolean>} Whether the reply is done with here. False for a chat that is not loaded: it is landed when it is opened. */
    async function handleCommitted(item) {
        if (page.wasLanded(item.id)) {
            page.acknowledge([item.id]);
            return true;
        }
        if (data.chat(addressOf(item))) {
            await page.reloadChat(addressOf(item));
            // The finalizer acknowledges what it lands; a reply that another tab landed first leaves nothing to land, and the server repeats it until somebody says that it was seen.
            page.acknowledge([item.id]);
            return true;
        }
        if (!refreshed.has(item.id)) {
            refreshed.add(item.id);
            scheduleRefresh();
        }
        return false;
    }

    /** @param {Record<string, any>[]} pending */
    async function handle(pending) {
        if (!Array.isArray(pending)) {
            return;
        }
        const active = new Set(getActiveGenerationIds());
        const items = pending.filter(item => item && item.kind === 'reply' && typeof item.conversation === 'string' && !active.has(item.id));
        const toAcknowledge = [];
        for (const item of items) {
            if (item.state === 'committed') {
                if (handled.has(item.id) || working.has(item.id)) {
                    continue;
                }
                working.add(item.id);
                try {
                    if (await handleCommitted(item)) {
                        handled.add(item.id);
                    }
                } catch (error) {
                    console.warn('Conversation Mode: a reply that the server wrote could not be read', error);
                } finally {
                    working.delete(item.id);
                }
            } else if (item.state === 'failed') {
                if (!handled.has(item.id)) {
                    handled.add(item.id);
                    if (item.page !== pageId && FAILURE_REASON.test(String(item.reason ?? ''))) {
                        page.showFailed(item);
                    }
                }
                toAcknowledge.push(item.id);
            } else if (item.state === 'lost' && !handled.has(item.id)) {
                handled.add(item.id);
                page.showLost({ item, regenerate: await getRegenerate(item) });
                toAcknowledge.push(item.id);
            }
        }
        if (toAcknowledge.length) {
            page.acknowledge(toAcknowledge);
        }
    }

    return Object.freeze({ sync, close, handle });
}
