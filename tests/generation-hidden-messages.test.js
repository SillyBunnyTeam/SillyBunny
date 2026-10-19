import { describe, expect, jest, test } from '@jest/globals';
import { EventEmitter } from '../public/lib/eventemitter.js';
import { event_types } from '../public/scripts/events.js';
import { COMPANION_RESULTS_EXTRA_KEY, consolidateCompanionChatHistory, selectCompanionChatHistory } from '../public/scripts/extensions/in-chat-agents/companion/companion-shared.js';
import { collectHiddenGenerationMessages, createGenerationHideRequest } from '../public/scripts/generation-hidden-messages.js';

const line = (name, mes, extra = {}) => ({ name, mes, is_user: false, send_date: '2026-10-08T01:00:00.000Z', extra });
const retained = (content, options = {}) => ({
    [COMPANION_RESULTS_EXTRA_KEY]: {
        scribe: { status: 'done', includeInChatHistory: true, includeAllChatHistory: true, content, agentName: 'Scribe', ...options },
    },
});

describe('generation hide request', () => {
    test('hands handlers frozen copies and hides the stored lines by index', () => {
        const messages = [line('Alice', 'one'), line('Bob', 'two'), { name: 'User', mes: 'three', is_user: true }];
        const { request, hidden } = createGenerationHideRequest(messages, 'normal');

        expect(request.type).toBe('normal');
        expect(request.messages).toHaveLength(3);
        expect(Object.isFrozen(request.messages)).toBe(true);
        request.messages.forEach((copy, index) => {
            expect(copy).not.toBe(messages[index]);
            expect(copy).toEqual(messages[index]);
        });
        expect(request.messages[0].extra).toBe(messages[0].extra);
        expect(request.messages).toBe(request.messages);

        expect(request.hide(1)).toBe(true);
        expect([0, 1, 2].map(index => request.isHidden(index))).toEqual([false, true, false]);
        expect([...hidden]).toEqual([messages[1]]);
        const outside = [-1, 3, 1.5, '1', null, undefined];
        expect(outside.map(index => request.hide(index))).toEqual(outside.map(() => false));
        expect(outside.map(index => request.isHidden(index))).toEqual(outside.map(() => false));
        expect(hidden.size).toBe(1);
        expect(messages[1].mes).toBe('two');
    });

    test('collects what every handler hid, past a handler that throws, and tolerates a failing emit', async () => {
        const messages = [line('Alice', 'one'), line('Bob', 'two'), line('Carol', 'three')];
        const events = new EventEmitter();
        events.on(event_types.GENERATION_HIDE_MESSAGES, request => { request.hide(0); });
        events.on(event_types.GENERATION_HIDE_MESSAGES, () => { throw new Error('broken handler'); });
        events.on(event_types.GENERATION_HIDE_MESSAGES, async request => { request.hide(2); });
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        const trace = jest.spyOn(console, 'trace').mockImplementation(() => {});
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const hidden = await collectHiddenGenerationMessages(messages, 'normal', request => events.emit(event_types.GENERATION_HIDE_MESSAGES, request));
            expect([...hidden]).toEqual([messages[0], messages[2]]);

            const failing = await collectHiddenGenerationMessages(messages, 'normal', request => { request.hide(1); throw new Error('emit failed'); });
            expect([...failing]).toEqual([messages[1]]);
            expect(warn).toHaveBeenCalledTimes(1);

            const silent = await collectHiddenGenerationMessages(messages, 'normal', () => {});
            expect(silent.size).toBe(0);
        } finally {
            error.mockRestore();
            trace.mockRestore();
            warn.mockRestore();
        }
    });

    test('keeps a hidden line\'s retained notes out of the merge and off the host', () => {
        const seen = line('Alice', 'Alice looks around.', retained('Alice note'));
        const missed = line('Bob', 'Bob whispers to Alice.', retained('Bob note'));
        const latest = line('Carol', 'Carol waits.', retained('Carol note'));
        const chat = [seen, missed, latest];

        const candidatesFor = hidden => chat.filter(message => !hidden.has(message));
        const merge = candidates => {
            const selections = selectCompanionChatHistory(candidates, { policyMessages: chat });
            const { host, entries } = consolidateCompanionChatHistory(candidates, selections);
            return { host, notes: entries.map(entry => entry.contribution.content) };
        };

        // Nothing hidden: every note is merged onto the newest line, as before.
        expect(merge(candidatesFor(new Set()))).toEqual({ host: latest, notes: ['Alice note', 'Bob note', 'Carol note'] });

        // The speaker missed Bob's line: its note is left out and the host stays the newest visible line.
        const { request, hidden } = createGenerationHideRequest(chat, 'normal');
        request.hide(1);
        expect(merge(candidatesFor(hidden))).toEqual({ host: latest, notes: ['Alice note', 'Carol note'] });

        // The speaker missed the newest line too: the merge moves to a line they saw.
        request.hide(2);
        expect(merge(candidatesFor(hidden))).toEqual({ host: seen, notes: ['Alice note'] });
    });

    test('a hidden host that keeps its notes when hidden still loses them once a handler hides it', () => {
        const shard = { ...line('Memory', 'story above', retained('Shard note', { keepInChatHistoryWhenHostHidden: true })), is_system: true };
        const later = line('Alice', 'Alice nods.', retained('Alice note'));
        const chat = [shard, later];
        const { request, hidden } = createGenerationHideRequest(chat, 'normal');
        expect(request.messages[0].extra).toBe(shard.extra);

        const notesOf = candidates => [...consolidateCompanionChatHistory(candidates, selectCompanionChatHistory(candidates, { policyMessages: chat })).entries]
            .map(entry => entry.contribution.content);
        expect(notesOf(chat)).toEqual(['Shard note', 'Alice note']);
        request.hide(0);
        expect(notesOf(chat.filter(message => !hidden.has(message)))).toEqual(['Alice note']);
    });
});
