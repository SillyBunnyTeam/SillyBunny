/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Playwright does not recognize Jest test callbacks. */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

/** The files that the composer's file input holds, which jsdom cannot hold for the module. */
let pendingFiles = [];
const setConversationPendingFiles = jest.fn((files) => {
    pendingFiles = [...files];
});

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/attachments.js', () => ({
    getConversationPendingFiles: () => [...pendingFiles],
    setConversationPendingFiles,
}));

const { CHROME_IDS } = await import('../public/scripts/sillybunny-conversation/constants.js');
const { buildConversationRenderKey } = await import('../public/scripts/sillybunny-conversation/render-key.js');

const key = (avatar, chatId = 'main', personaId = 'p.png') => buildConversationRenderKey(avatar, '', chatId, personaId);
const A = key('a.png');
const B = key('b.png');

let swapComposerDraft;
let stashComposerDraft;
let input;
let inputEvents;

const file = name => ({ name });

beforeEach(async () => {
    // The drafts live in the module, so each test starts with a fresh one.
    jest.resetModules();
    ({ stashComposerDraft, swapComposerDraft } = await import('../public/scripts/sillybunny-conversation/composer-draft.js'));
    document.body.innerHTML = `<textarea id="${CHROME_IDS.input}"></textarea>`;
    input = document.getElementById(CHROME_IDS.input);
    inputEvents = 0;
    input.addEventListener('input', () => inputEvents++);
    pendingFiles = [];
    setConversationPendingFiles.mockClear();
});

describe('the draft of a conversation', () => {
    test('stays with its conversation: the box is empty in another one, and the draft is back on return', () => {
        input.value = 'for a';

        swapComposerDraft(A, B);
        expect(input.value).toBe('');

        swapComposerDraft(B, A);
        expect(input.value).toBe('for a');
    });

    test('is kept for each conversation on its own', () => {
        input.value = 'for a';
        swapComposerDraft(A, B);
        input.value = 'for b';
        swapComposerDraft(B, A);

        expect(input.value).toBe('for a');
        swapComposerDraft(A, B);
        expect(input.value).toBe('for b');
    });

    test('keeps its attachments with it, and leaves none behind in the other conversation', () => {
        input.value = 'look';
        pendingFiles = [file('cat.png'), file('dog.png')];

        swapComposerDraft(A, B);
        expect(pendingFiles).toEqual([]);

        swapComposerDraft(B, A);
        expect(input.value).toBe('look');
        expect(pendingFiles).toEqual([file('cat.png'), file('dog.png')]);
    });

    test('is kept when only attachments were added', () => {
        pendingFiles = [file('cat.png')];

        swapComposerDraft(A, B);
        swapComposerDraft(B, A);

        expect(pendingFiles).toEqual([file('cat.png')]);
    });

    test('does not come back once it was sent, because an empty box keeps nothing', () => {
        input.value = 'for a';
        swapComposerDraft(A, B);
        swapComposerDraft(B, A);
        input.value = '';

        swapComposerDraft(A, B);
        swapComposerDraft(B, A);

        expect(input.value).toBe('');
    });

    test('tells the box that it changed, so that it resizes to what it holds', () => {
        input.value = 'for a';
        swapComposerDraft(A, B);
        const afterClearing = inputEvents;
        swapComposerDraft(B, A);

        expect(afterClearing).toBeGreaterThan(0);
        expect(inputEvents).toBeGreaterThan(afterClearing);
    });
});

describe('a change of the drawn conversation that is not a switch', () => {
    test('another chat of the same conversation keeps the box as it is', () => {
        input.value = 'for a';
        pendingFiles = [file('cat.png')];

        swapComposerDraft(key('a.png', 'chat-1'), key('a.png', 'chat-2'));

        expect(input.value).toBe('for a');
        expect(pendingFiles).toEqual([file('cat.png')]);
    });

    test('the chat of a conversation that did not have one yet keeps the box as it is', () => {
        input.value = 'the first message';

        swapComposerDraft(key('a.png', ''), key('a.png', 'new-chat'));

        expect(input.value).toBe('the first message');
    });

    test('the same key changes nothing', () => {
        input.value = 'for a';

        swapComposerDraft(A, A);

        expect(input.value).toBe('for a');
    });

    test('another persona is another conversation', () => {
        input.value = 'as p';

        swapComposerDraft(key('a.png', 'main', 'p.png'), key('a.png', 'main', 'q.png'));

        expect(input.value).toBe('');
    });
});

describe('the first draw and the empty state', () => {
    test('a first draw takes nothing out of the box, since nothing was drawn before', () => {
        input.value = 'typed before the first draw';

        swapComposerDraft('', A);

        expect(input.value).toBe('typed before the first draw');
    });

    test('a first draw gives back what the workspace kept when it closed', () => {
        input.value = 'for a';
        stashComposerDraft(A);
        expect(input.value).toBe('');

        swapComposerDraft('', A);

        expect(input.value).toBe('for a');
    });

    test('a workspace that closes empties the box, so that its draft cannot go to the conversation that opens next', () => {
        input.value = 'for a';

        stashComposerDraft(A);
        swapComposerDraft('', B);

        expect(input.value).toBe('');
    });

    test('the empty state keeps the draft of the conversation that was drawn, and shows an empty box', () => {
        input.value = 'for a';

        swapComposerDraft(A, '');
        expect(input.value).toBe('');

        swapComposerDraft('', A);
        expect(input.value).toBe('for a');
    });

    test('stashing again, as every refresh of a closed workspace does, keeps what the first stash kept', () => {
        input.value = 'for a';

        stashComposerDraft(A);
        stashComposerDraft(A);
        swapComposerDraft('', A);

        expect(input.value).toBe('for a');
    });

    test('stashing with no conversation drawn does nothing', () => {
        input.value = 'kept';

        stashComposerDraft('');

        expect(input.value).toBe('kept');
    });
});
