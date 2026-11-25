/**
 * Fixtures for the client data module (`public/scripts/sillybunny-conversation/conversation-data.js`).
 *
 * The module talks to the server through one adapter, `fetchJson(path, body, options)`. Tests give it either the
 * real routes of `src/endpoints/sillybunny-conversation.js` on a throwaway user (`startConversationServer`), or a
 * scripted answer for a single path (`scriptedAdapter`), and a clock that only moves when the test says so
 * (`createManualClock`).
 */

import express from 'express';

// The sandbox sets the config path that `src/endpoints/chats.js` reads when it loads, so it comes before the store.
import { createSandboxUser, header, line, PERSONA } from './conversation-store-sandbox.js';
import { createConversation } from '../../src/conversation-store.js';

export { chat, header, line, PERSONA } from './conversation-store-sandbox.js';

const PREFIX = '/api/sillybunny-conversation';

/**
 * The real routes on a throwaway user, served on a local port.
 * @returns {Promise<{ baseUrl: string, user: object, root: string, stop: () => Promise<void>, adapter: (overrides?: object) => object }>}
 */
export async function startConversationServer() {
    const { router } = await import('../../src/endpoints/sillybunny-conversation.js');
    const sandbox = createSandboxUser();
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    // Each request gets its own handle: the regular chat backup is throttled per handle and chat, and a second save
    // inside the window would leave a timer that fires after the test.
    let requests = 0;
    app.use((request, _response, next) => {
        request.user = { ...sandbox.user, profile: { handle: `${sandbox.user.profile.handle}-request-${++requests}` } };
        next();
    });
    app.use(PREFIX, router);
    const server = await new Promise((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return {
        baseUrl,
        user: sandbox.user,
        root: sandbox.root,
        async stop() {
            await new Promise(resolve => server.close(resolve));
            sandbox.cleanup();
        },
        adapter: (overrides = {}) => createRouteAdapter(baseUrl, overrides),
    };
}

/**
 * @param {string} baseUrl
 * @param {object} [overrides] Replaces members of the adapter.
 * @returns {object} The adapter of the data module, over `fetch`, with a clock that the test moves.
 */
export function createRouteAdapter(baseUrl, overrides = {}) {
    const clock = overrides.clock ?? createManualClock();
    return {
        async fetchJson(path, body, options = {}) {
            const response = await fetch(`${baseUrl}${PREFIX}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body ?? {}),
            });
            const text = await response.text();
            let json = null;
            try {
                json = JSON.parse(text);
            } catch {
                // Not JSON; the module reads `status`.
            }
            return { status: response.status, json, keepalive: options.keepalive === true };
        },
        async fetchText(path, body) {
            const response = await fetch(`${baseUrl}${PREFIX}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body ?? {}),
            });
            const disposition = response.headers.get('content-disposition') ?? '';
            return { status: response.status, text: await response.text(), fileName: /filename="([^"]+)"/.exec(disposition)?.[1] ?? '' };
        },
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        random: () => 'abc123',
        isSettingsStale: () => false,
        reloadPage: () => {},
        ...overrides,
        clock,
    };
}

/**
 * A clock whose timers fire only in `advance()`. `now()` starts at a fixed time.
 * @param {number} [start]
 */
export function createManualClock(start = Date.UTC(2026, 5, 1, 12, 0, 0)) {
    let time = start;
    let nextId = 1;
    const timers = new Map();
    return {
        now: () => time,
        setTimer(callback, delay) {
            const id = nextId++;
            timers.set(id, { callback, at: time + delay });
            return id;
        },
        clearTimer(id) {
            timers.delete(id);
        },
        /** Moves the clock and runs the timers that fall due, in time order, including the ones they add. */
        async advance(milliseconds) {
            const end = time + milliseconds;
            for (;;) {
                const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
                if (!due) {
                    break;
                }
                timers.delete(due[0]);
                time = Math.max(time, due[1].at);
                due[1].callback();
                await settle();
            }
            time = end;
        },
        get pending() {
            return timers.size;
        },
    };
}

/** Lets the promises that are ready run, including the ones that they start. */
export async function settle(rounds = 20) {
    for (let index = 0; index < rounds; index++) {
        await new Promise(resolve => setImmediate(resolve));
    }
}

/**
 * Wraps an adapter and records its calls.
 * @param {object} adapter
 * @returns {object} The adapter with `calls`: `{ path, body, options }` in the order of the requests.
 */
export function recordCalls(adapter) {
    const calls = [];
    return {
        ...adapter,
        calls,
        fetchJson: async (path, body, options) => {
            calls.push({ path, body: structuredClone(body ?? {}), options });
            return adapter.fetchJson(path, body, options);
        },
        ...(typeof adapter.fetchText === 'function'
            ? {
                fetchText: async (path, body) => {
                    calls.push({ path, body: structuredClone(body ?? {}), options: {} });
                    return adapter.fetchText(path, body);
                },
            }
            : {}),
        paths: () => calls.map(call => call.path),
        callsTo: path => calls.filter(call => call.path === path),
    };
}

/**
 * An adapter that answers with the given function and never touches a server.
 * @param {(path: string, body: object, options: object) => ({ status: number, json: any }|Promise<{ status: number, json: any }>)} answer
 * @param {object} [overrides]
 */
export function scriptedAdapter(answer, overrides = {}) {
    const clock = overrides.clock ?? createManualClock();
    return recordCalls({
        fetchJson: async (path, body, options) => answer(path, body ?? {}, options ?? {}),
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        random: () => 'abc123',
        isSettingsStale: () => false,
        reloadPage: () => {},
        ...overrides,
        clock,
    });
}

/**
 * Puts conversations on the disk of a started server, through the store, and returns them with their ids.
 * @param {{ user: object }} server
 * @param {object[]} descriptors `{ id?, kind?, personaId?, characters, name?, chats?: [{ id?, name?, messages?: [text or { id, text, user, system, minute }], readThrough? }], settings?, reminders? }`
 * @returns {object[]} The stored conversations.
 */
export function seedConversations(server, descriptors) {
    return descriptors.map((descriptor, index) => {
        const characters = descriptor.characters ?? ['Nova.png'];
        const chatInputs = (descriptor.chats ?? [{ id: 'main' }]).map((chat) => {
            const messages = (chat.messages ?? []).map((item, number) => (typeof item === 'string'
                ? line(`${chat.id ?? 'main'}-${number}`, item, { minute: number, user: number % 2 === 1 })
                : line(item.id ?? `${chat.id ?? 'main'}-${number}`, item.text, { minute: item.minute ?? number, user: item.user, system: item.system })));
            return {
                id: chat.id ?? 'main',
                name: chat.name ?? 'Main',
                ...(chat.readThrough === undefined ? {} : { readThrough: chat.readThrough }),
                records: [header(), ...messages],
            };
        });
        return createConversation(server.user, {
            id: descriptor.id ?? `conv_${1000 + index}_seeded${index}`,
            kind: descriptor.kind ?? (characters.length > 1 ? 'group' : 'direct'),
            personaId: descriptor.personaId ?? PERSONA,
            characters,
            extras: descriptor.extras ?? [],
            name: descriptor.name ?? '',
            settings: descriptor.settings ?? {},
            reminders: descriptor.reminders ?? [],
            chats: chatInputs,
            activeChatId: descriptor.activeChatId ?? chatInputs[0].id,
            createdAt: descriptor.createdAt ?? Date.UTC(2026, 0, 1) + index,
        }).conversation;
    });
}
