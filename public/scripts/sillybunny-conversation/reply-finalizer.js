/**
 * Turns the replies that the server wrote into a chat into bubbles. When no page takes a reply that was being
 * generated, the server appends it as one pending message with the raw text (`pending-reply.js`). Any page that has
 * the chat loaded replaces that message with the bubbles that the live path would have written (`reply-steps.js`),
 * runs the effects of an incoming message for them, and acknowledges the generation. The page that did not start the
 * reply does this too, which is the point: the reply is in the chat whichever page is open when it is read.
 *
 * Two tabs can hold the same chat, so the work runs under a Web Lock named after the chat, and every bubble has an id
 * that is derived from the pending message. Where there is no Web Lock (an insecure origin, an old browser) two tabs
 * can both replace the message; they build identical bubbles with identical ids, so the merge by id of the data
 * module leaves one copy of each. What the lock adds is that the commands of the reply (reminders, schedule updates,
 * selfies) run in one tab only.
 *
 * Everything that belongs to the page comes in through `page`, so that tests run two finalizers on one server.
 *
 * @typedef {import('./pending-reply.js').PendingReply} PendingReply
 * @typedef {import('./reply-steps.js').ReplySpeaker} ReplySpeaker
 * @typedef {{ conversationId: string, chatId: string }} ChatAddress
 * @typedef {object} ChatContext What the page knows about the conversation of a reply, in the shapes of the old calls.
 * @property {string} anchorAvatar
 * @property {string} groupId
 * @property {string} personaId
 * @property {(fallbackSpeaker: ReplySpeaker) => ReplySpeaker[]} speakersFor The speakers whose name may start a line. Empty in a direct conversation.
 * @property {(speakerAvatar: string) => Record<string, any>} settingsFor The settings that decide which commands the text may carry, and whether its characters react (`characters_react`).
 * @typedef {object} FinalizerPage
 * @property {(view: Record<string, any>, reply: PendingReply) => ChatContext} context
 * @property {(route: 'profile'|'raw', text: string) => string} cleanUpText The clean-up that the request route would have applied.
 * @property {(message: Record<string, any>) => Record<string, any>|null} buildReference The reply card for a message.
 * @property {(avatar: string, message: Record<string, any>, options: object) => void} afterIncoming `afterIncomingMessage()`.
 * @property {(commandParts: object, speakerAvatar: string, options: object) => void} runCommands `commitCharacterReplyCommands()`.
 * @property {(request: object, context: object) => Promise<boolean>} makeSelfie
 * @property {(generationIds: string[]) => void} acknowledge
 * @property {(conversationId: string, reminderId: string) => void} [markReminderDelivered] Records that a reminder reached the chat.
 * @typedef {object} LandedReply
 * @property {PendingReply} reply The marker of the message that was replaced.
 * @property {string[]} bubbleIds
 */

import { isPendingServerReply, readPendingReply } from './pending-reply.js';
import { addCharacterReaction, readReactions, writeReactions } from './reaction-model.js';
import { buildPendingBubbles, buildReplySteps, collectReplyReactions } from './reply-steps.js';

const LOCK_PREFIX = 'sb-conversation-finalize';
const DEFAULT_LOCK_TIMEOUT_MS = 20_000;
const MAX_PASSES = 3;

const keyOf = address => `${address.conversationId}/${address.chatId}`;

/** Whether bubbles of the reply are in the chat already: any message that is not the pending one and carries its token. */
const hasLandedBubbles = (messages, reply) => Boolean(reply.token) && messages.some(item => !isPendingServerReply(item) && item.extra?.reply_token === reply.token);

/**
 * @param {object} parts
 * @param {ReturnType<typeof import('./conversation-data.js').createConversationData>} parts.data
 * @param {FinalizerPage} parts.page
 * @param {() => ({ request: Function }|undefined)} [parts.getLocks] `navigator.locks`, read at each use.
 * @param {number} [parts.lockTimeoutMs] How long a call waits for another tab. A reply that stays pending is landed by the next call.
 */
export function createReplyFinalizer({ data, page, getLocks = () => globalThis.navigator?.locks, lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS }) {
    /** @type {Map<string, Promise<LandedReply[]>>} */
    const running = new Map();
    /** @type {Set<Promise<void>>} */
    const selfieTasks = new Set();
    const landedGenerationIds = new Set();

    const hasPending = address => Boolean(data.chat(address)?.messages.some(isPendingServerReply));

    /**
     * Runs `task` while this tab holds the lock of the chat. Answers null when another tab held it for longer than the timeout.
     * @template T
     * @param {ChatAddress} address
     * @param {(state: { waited: boolean }) => Promise<T>} task `waited` says that another tab held the lock first.
     * @returns {Promise<T|null>}
     */
    async function withLock(address, task) {
        const locks = getLocks();
        if (typeof locks?.request !== 'function') {
            return task({ waited: false });
        }

        const name = `${LOCK_PREFIX}:${address.conversationId}:${address.chatId}`;
        let result = null;
        let ran = false;
        try {
            await locks.request(name, { ifAvailable: true }, async (lock) => {
                if (lock) {
                    ran = true;
                    result = await task({ waited: false });
                }
            });
        } catch (error) {
            // A page with an opaque origin has the API and is refused every lock. A refusal comes before the task, so nothing ran.
            if (!ran && error?.name === 'SecurityError') {
                return task({ waited: false });
            }
            throw error;
        }
        if (ran) {
            return result;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), lockTimeoutMs);
        try {
            return await locks.request(name, { signal: controller.signal }, async () => {
                clearTimeout(timer);
                return task({ waited: true });
            });
        } catch (error) {
            if (error?.name === 'AbortError') {
                return null;
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    /** A reminder that a landed reply delivers is done: the worker of a page that was closed could not write it. */
    function reportReminderDelivered(address, reply) {
        if (reply.origin === 'reminder' && reply.reminder) {
            page.markReminderDelivered?.(address.conversationId, reply.reminder);
        }
    }

    /**
     * A page that was alive when the reply was ready wrote it itself, and the server's copy of the same reply then
     * arrived as well (the claim failed and the server committed, or an earlier attempt at the same reminder was
     * written late). The chat holds the reply already, so the pending message goes and nothing is written twice.
     */
    async function dropDuplicate(address, message, reply) {
        try {
            data.commitChat(address, (draft) => {
                const index = draft.messages.findIndex(item => item.id === message.id);
                if (index >= 0) {
                    draft.messages.splice(index, 1);
                }
            }, { shrink: true });
        } catch (error) {
            if (error?.name === 'ChatNotLoadedError') {
                return null;
            }
            throw error;
        }
        await data.saveChat(address);
        reportReminderDelivered(address, reply);
        page.acknowledge([reply.generationId]);
        landedGenerationIds.add(reply.generationId);
        return { landed: { reply, bubbleIds: [] }, selfies: [], context: null };
    }

    /**
     * Replaces one pending message with its bubbles. Called with the lock held.
     * @returns {Promise<{ landed: LandedReply, selfies: object[], context: object }|null>} Null when the chat went away.
     */
    async function landOne(address, message) {
        const view = data.get(address.conversationId);
        const reply = readPendingReply(message);
        if (!view || !reply) {
            return null;
        }

        if (hasLandedBubbles(data.chat(address)?.messages ?? [], reply)) {
            return dropDuplicate(address, message, reply);
        }

        const chatContext = page.context(view, reply);
        const { anchorAvatar, groupId, personaId } = chatContext;
        const speakerAvatar = reply.speaker || anchorAvatar;
        const fallbackSpeaker = { avatar: speakerAvatar, name: message.name || 'Character' };
        const settings = chatContext.settingsFor(speakerAvatar);
        const text = String(page.cleanUpText(reply.route, String(message.mes ?? '')) ?? '').trim();
        const groups = buildReplySteps(text, {
            speaker: fallbackSpeaker,
            mode: speakerAvatar === anchorAvatar ? 'character' : 'member',
            speakers: chatContext.speakersFor(fallbackSpeaker),
            settings,
        });
        const messages = data.chat(address)?.messages ?? [];
        const triggerMessage = [...reply.triggers].reverse().map(id => messages.find(item => item.id === id)).find(item => item?.role === 'user');
        const { bubbles, selfieRequests, sideEffects } = buildPendingBubbles(message, reply, groups, {
            anchorAvatar,
            reference: triggerMessage ? page.buildReference(triggerMessage) : null,
        });

        // Only a reply to a message of the user reacts to it, and only when the conversation lets its characters react.
        const reactions = reply.origin === 'reply' && settings.characters_react && triggerMessage ? collectReplyReactions(groups) : [];

        try {
            // One commit, so that the reaction and the reply land together or not at all, and so that a page that finds the
            // pending message gone (another page landed it) writes neither a second time.
            data.commitChat(address, (draft) => {
                const index = draft.messages.findIndex(item => item.id === message.id);
                if (index < 0) {
                    return;
                }
                draft.messages.splice(index, 1, ...bubbles);
                const target = reactions.length ? draft.messages.find(item => item.id === triggerMessage.id) : null;
                if (target) {
                    writeReactions(target, reactions.reduce((entries, { speakerAvatar: reactor, emoji }) => addCharacterReaction(entries, emoji, reactor, message.created_at), readReactions(target)));
                }
            }, { shrink: bubbles.length === 0 });
        } catch (error) {
            if (error?.name === 'ChatNotLoadedError') {
                return null;
            }
            throw error;
        }

        const lastIndex = bubbles.length - 1;
        bubbles.forEach((bubble, index) => {
            page.afterIncoming(anchorAvatar, bubble, { address, chatId: address.chatId, groupId, personaId, notify: index === lastIndex, scheduleMemory: index === lastIndex });
        });
        // The lock is held until the replacement is on the server, so that the next tab to take it reads the chat without the pending message.
        await data.saveChat(address);

        for (const effect of sideEffects) {
            page.runCommands(effect.commandParts, effect.speakerAvatar, { chatId: address.chatId, groupId, personaId, reminderAvatar: anchorAvatar, reminderIdPrefix: effect.idPrefix });
        }
        if (bubbles.length) {
            reportReminderDelivered(address, reply);
        }
        page.acknowledge([reply.generationId]);
        landedGenerationIds.add(reply.generationId);

        return {
            landed: { reply, bubbleIds: bubbles.map(bubble => bubble.id) },
            selfies: selfieRequests.map(request => ({ ...request, settings: chatContext.settingsFor(request.speakerAvatar) })),
            context: { address, anchorAvatar, groupId, personaId },
        };
    }

    /**
     * Makes the pictures that a landed reply asked for, one after another, after the landing is over. The landing does
     * not wait for them: a picture takes as long as an image model needs, and the callers of `finalize()` (a prompt that
     * is about to be built) must not. The picture of a reply is a message of the chat, so its own call to
     * `ensureConversationChatLoaded()` may land another reply, which it could not if the run that it came from were
     * still open.
     */
    function startSelfies({ selfies, context }) {
        if (!selfies.length) {
            return;
        }
        const task = (async () => {
            for (const request of selfies) {
                try {
                    await page.makeSelfie(request, { ...context, settings: request.settings });
                } catch (error) {
                    console.warn('Conversation Mode: the selfie of a reply that the server wrote failed', error);
                }
            }
        })();
        selfieTasks.add(task);
        void task.finally(() => selfieTasks.delete(task));
    }

    async function runOnce(address) {
        const results = await withLock(address, async ({ waited }) => {
            if (waited) {
                // The tab that held the lock has probably replaced the message; reading the chat again shows whether it did.
                try {
                    await data.reloadChat(address);
                } catch (error) {
                    console.warn('Conversation Mode: a reply that the server wrote could not be landed, the chat could not be read again', error);
                    return [];
                }
            }
            const done = [];
            for (const message of data.chat(address)?.messages.filter(isPendingServerReply) ?? []) {
                const result = await landOne(address, message);
                if (result) {
                    done.push(result);
                }
            }
            return done;
        });

        return { landed: (results ?? []).map(result => result.landed), jobs: results ?? [] };
    }

    /**
     * Lands the pending replies of a loaded chat. Calls that arrive while a run is going share it. Does not load the
     * chat: a page that wants the replies of a chat loads it first.
     * @param {ChatAddress} address
     * @returns {Promise<LandedReply[]>} The replies that landed, here or in the run that this call joined.
     */
    async function finalize(address) {
        const key = keyOf(address);
        const landed = [];
        for (let pass = 0; pass < MAX_PASSES; pass++) {
            let run = running.get(key);
            let jobs = null;
            if (!run) {
                if (!hasPending(address)) {
                    break;
                }
                run = runOnce(address)
                    .then((outcome) => {
                        jobs = outcome.jobs;
                        return outcome.landed;
                    })
                    .finally(() => running.delete(key));
                running.set(key, run);
            }
            const done = await run;
            // Started here, after the run is closed: see startSelfies().
            jobs?.forEach(startSelfies);
            landed.push(...done);
            if (!done.length) {
                break;
            }
        }
        return landed;
    }

    return Object.freeze({
        finalize,
        /** Whether this page landed the reply of the generation: the event stream can then skip it. */
        wasLanded: generationId => landedGenerationIds.has(generationId),
        /** Resolves when the pictures that landed replies asked for are made. */
        idle: () => Promise.allSettled([...selfieTasks]).then(() => undefined),
    });
}
