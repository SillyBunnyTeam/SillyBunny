import { describe, expect, test } from '@jest/globals';

import { getMessageIndexes, getOwnerIndex, getTailStart } from '../../public/scripts/sillybunny-message-selection-utils.js';

const user = mes => ({ is_user: true, is_system: false, mes });
const assistant = mes => ({ is_user: false, is_system: false, mes });
const toolCall = mes => ({ is_user: false, is_system: true, mes, extra: { tool_invocations: [{ id: mes }] } });
const narrator = mes => ({ is_user: false, is_system: true, mes });

// 0 user, 1 assistant, 2 and 3 tool calls of 4, 4 assistant, 5 user, 6 tool call of 7, 7 assistant, 8 tool call with a user message after it, 9 user
const chat = [user('u0'), assistant('a1'), toolCall('t2'), toolCall('t3'), assistant('a4'), user('u5'), toolCall('t6'), assistant('a7'), toolCall('t8'), user('u9')];

describe('getOwnerIndex', () => {
    test('a tool call belongs to the assistant message that follows its block, and every other message to itself', () => {
        expect(getOwnerIndex(chat, 2, true)).toBe(4);
        expect(getOwnerIndex(chat, 3, true)).toBe(4);
        expect(getOwnerIndex(chat, 6, true)).toBe(7);
        expect(getOwnerIndex(chat, 4, true)).toBe(4);
        expect(getOwnerIndex(chat, 0, true)).toBe(0);
    });

    test('a tool call before a user message, or at the end of the chat, has no owner', () => {
        expect(getOwnerIndex(chat, 8, true)).toBe(8);
        expect(getOwnerIndex([assistant('a'), toolCall('t')], 1, true)).toBe(1);
    });

    test('with tool calls left out of the deletion every row is its own', () => {
        expect(getOwnerIndex(chat, 2, false)).toBe(2);
    });
});

describe('getMessageIndexes', () => {
    test('an assistant message brings its tool calls, highest index first', () => {
        expect(getMessageIndexes(chat, ['4'], true)).toEqual([4, 3, 2]);
        expect(getMessageIndexes(chat, ['4', '0', '7'], true)).toEqual([7, 6, 4, 3, 2, 0]);
    });

    test('a user message or a narrator line brings nothing', () => {
        expect(getMessageIndexes([user('u'), toolCall('t'), narrator('n')], ['2'], true)).toEqual([2]);
        expect(getMessageIndexes(chat, ['5'], true)).toEqual([5]);
    });

    test('with tool calls left out only the keys are deleted', () => {
        expect(getMessageIndexes(chat, ['4'], false)).toEqual([4]);
    });
});

describe('getTailStart', () => {
    test('is the first index of a run that reaches the last message', () => {
        expect(getTailStart([7, 8, 9], 10)).toBe(7);
        expect(getTailStart([9, 8, 7], 10)).toBe(7);
        expect(getTailStart([9], 10)).toBe(9);
    });

    test('is 0 when every message is chosen', () => {
        expect(getTailStart([2, 1, 0], 3)).toBe(0);
    });

    test('is -1 for a run that stops short of the last message, a run with a gap, and nothing', () => {
        expect(getTailStart([4, 5, 6], 10)).toBe(-1);
        expect(getTailStart([9, 8, 6], 10)).toBe(-1);
        expect(getTailStart([], 10)).toBe(-1);
    });
});
