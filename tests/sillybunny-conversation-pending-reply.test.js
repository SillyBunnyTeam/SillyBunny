import { describe, expect, test } from '@jest/globals';

import { isPendingServerReply, readPendingReply } from '../public/scripts/sillybunny-conversation/pending-reply.js';
import { pendingReply } from './util/conversation-pending-reply.js';

describe('a message that the server wrote and no page has landed yet', () => {
    test('is recognised by the marker of the server, and no other message is', () => {
        expect(isPendingServerReply(pendingReply())).toBe(true);
        expect(isPendingServerReply({ id: 'a', mes: 'x', extra: {} })).toBe(false);
        expect(isPendingServerReply({ id: 'a', mes: 'x', extra: { server_generation: { pending: false } } })).toBe(false);
        expect(isPendingServerReply({ id: 'a', mes: 'x', extra: { server_generation: { pending: 'yes' } } })).toBe(false);
        expect(isPendingServerReply(null)).toBe(false);
        expect(isPendingServerReply(undefined)).toBe(false);
    });

    test('is read into the fields that the finalizer needs', () => {
        const message = pendingReply({ speaker: 'Tewi.png', anchor: 'Nova.png', name: 'Tewi', route: 'raw', round: ['Kaguya.png'], triggers: ['u1', 'u2'], target: 'c9', generationId: 'g7' });

        expect(readPendingReply(message)).toEqual({
            generationId: 'g7',
            token: 'abcdef0123456789',
            origin: 'reply',
            route: 'raw',
            speaker: 'Tewi.png',
            anchor: 'Nova.png',
            round: ['Kaguya.png'],
            roundStarted: message.extra.server_generation.round_started,
            triggers: ['u1', 'u2'],
            target: 'c9',
        });
    });

    test('answers null for a message that is not pending', () => {
        expect(readPendingReply({ id: 'a', mes: 'x', extra: {} })).toBeNull();
    });

    test('is read with defaults where the server left a field out, and keeps only strings in its lists', () => {
        const message = { id: 'p', mes: 'x', extra: { reply_token: 'tok', server_generation: { pending: true, round: ['a.png', 7, null], triggers: [1, 'u1'], route: 'something else' } } };

        expect(readPendingReply(message)).toMatchObject({ token: 'tok', route: 'profile', speaker: '', anchor: '', round: ['a.png'], triggers: ['u1'], roundStarted: 0, target: null });
    });
});
