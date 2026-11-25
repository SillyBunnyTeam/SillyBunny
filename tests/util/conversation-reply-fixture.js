/**
 * Plans, chats and a running generation for the tests of the server-owned conversation replies:
 * the plan that a page builds for a reply, the chat it answers, and the request that carries it.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { encodeCommitPlan, hashCommitText, normalizeCommitPlan } from '../../public/scripts/generation-commit-plan.js';
import { getConversationMessageRevision } from '../../public/scripts/sillybunny-conversation/message-identity-utils.js';
import { header } from './conversation-store-sandbox.js';

export const CONVERSATION = 'conv_1700000000000_abcdef0123';
export const TOKEN = 'a1b2c3d4e5f60718';
export const FINISHED = new Date('2026-10-03T10:00:30.000Z');
export const CONTEXT = { id: 'gen-1', finishedAt: FINISHED };
export const RAW_TEXT = '  Hello there.\n\nNova: a second line, left raw.  ';
export const REPLY = { text: RAW_TEXT, reasoning: 'Think first.', error: false, swipes: ['An extra completion.'] };

export const revisionOf = message => hashCommitText(getConversationMessageRevision(message));

export function message(id, role, text, minute, extra = {}) {
    const at = Date.UTC(2026, 9, 3, 9, minute, 0);
    return {
        id,
        role,
        name: role === 'user' ? 'You' : 'Nova',
        is_user: role === 'user',
        is_system: role === 'system',
        mes: text,
        send_date: new Date(at).toISOString(),
        created_at: at,
        extra,
    };
}

/** A greeting, a user message and the user message that the reply answers. */
export function chatMessages() {
    return [
        message('m1', 'character', 'Greetings.', 1),
        message('m2', 'user', 'Hello there.', 2),
        message('m3', 'user', 'Are you there?', 3),
    ];
}

export function chatRecords(messages = chatMessages()) {
    return [header({ integrity: 'slug-1' }), ...messages];
}

export function stampOf(item) {
    return { id: item.id, rev: revisionOf(item) };
}

/** A normalized plan for the reply to m2 and m3, from Nova, with Orion still to speak. */
export function plan({ reply = {}, ...overrides } = {}) {
    const messages = chatMessages();
    const normalized = normalizeCommitPlan({
        v: 1,
        chat: { conversation: CONVERSATION },
        file: 'main',
        kind: 'reply',
        index: 4,
        started: '2026-10-03T10:00:00.000Z',
        page: 'page-a',
        round: ['Orion.png'],
        message: { name: 'Nova' },
        reply: {
            token: TOKEN,
            speaker: 'Nova.png',
            anchor: 'Nova.png',
            origin: 'reply',
            route: 'profile',
            triggers: [stampOf(messages[1]), stampOf(messages[2])],
            target: null,
            needs_user: false,
            round_started: 1760000000000,
            ...reply,
        },
        ...overrides,
    });
    if (!normalized) {
        throw new Error('The test plan is not valid');
    }
    return normalized;
}

/**
 * Registers a generation that carries a commit plan, as the request middleware does.
 * @param {typeof import('../../src/resumable-generations.js')} registry
 * @param {object} user Owner of the generation
 * @param {object} planned Plan
 * @param {string} id Generation id
 * @param {string} [path] Request path
 * @returns {{ generation: any, finish: () => void }}
 */
export function startGeneration(registry, user, planned, id, path = '/api/backends/chat-completions/generate') {
    const headers = { 'x-generation-id': id, 'x-generation-commit': encodeCommitPlan(planned) };
    const request = {
        method: 'POST',
        path,
        headers,
        socket: new EventEmitter(),
        user,
        get: name => headers[String(name).toLowerCase()],
    };
    const response = new PassThrough();
    Object.assign(response, { statusCode: 200, statusMessage: '', socket: {} });
    Object.assign(response, { getHeader: name => (String(name).toLowerCase() === 'content-type' ? 'text/event-stream' : undefined) });
    registry.resumableGenerationMiddleware(request, response, () => undefined);
    response.resume();
    return {
        generation: request.resumableGeneration,
        finish() {
            response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: RAW_TEXT } }] })}\n\n`);
            response.end('data: [DONE]\n\n');
        },
    };
}

/** Lets the commit that `detach()` or a stream started run to its end. */
export async function settled(generation) {
    await new Promise(resolve => setImmediate(resolve));
    await generation.commit.work;
}
