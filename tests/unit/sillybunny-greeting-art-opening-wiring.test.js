/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importScriptModule } from '../util/script-harness.js';

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
});

function setChatScrollGeometry(chatEl, { scrollHeight = 2000, clientHeight = 500, scrollTop = 0 } = {}) {
    let top = scrollTop;
    Object.defineProperties(chatEl, {
        scrollHeight: { configurable: true, get: () => scrollHeight },
        clientHeight: { configurable: true, get: () => clientHeight },
        scrollTop: { configurable: true, get: () => top, set: value => { top = value; } },
    });
    return {
        getScrollTop: () => top,
        setScrollTop: value => { top = value; },
    };
}

describe('greeting art opening scroll sink wiring in script.js', () => {
    test('forced scrollChatToBottom and printMessages settle pins respect an active opening hold until release', async () => {
        loaded = await importScriptModule({
            keepReal: ['scripts/sillybunny-home/greeting-art-opening.js'],
        });
        const { OPENING_HOLD_MS, createOpeningHold, shouldHoldChatAtTop } = await import('../../public/scripts/sillybunny-home/greeting-art-opening.js');
        jest.useFakeTimers();

        const chatEl = document.getElementById('chat');
        const geom = setChatScrollGeometry(chatEl, { scrollHeight: 2000, clientHeight: 500, scrollTop: 0 });
        let clock = 0;
        const hold = createOpeningHold({
            chatElement: chatEl,
            isGreetingOnly: () => true,
            win: window,
            now: () => clock,
            isPerson: () => true,
        });

        loaded.script.characters.push({ name: 'Bunny', avatar: 'bunny.png', chat: 'bunny-chat', data: { extensions: {} } });
        loaded.script.setCharacterId(0);
        loaded.script.setCharacterName('Bunny');
        loaded.script.chat.push({ name: 'Bunny', is_user: false, is_system: false, mes: 'Greeting with picture', extra: {} });

        hold.beginOpening();
        hold.offer();
        expect(shouldHoldChatAtTop()).toBe(true);

        // Forced bottom scroll and printMessages load pins must leave scrollTop at 0 while held.
        loaded.script.scrollChatToBottom({ force: true });
        expect(geom.getScrollTop()).toBe(0);

        const printing = loaded.script.printMessages();
        await jest.advanceTimersByTimeAsync(100);
        await printing;
        expect(geom.getScrollTop()).toBe(0);

        // Advance through every chat-load settle delay timer: the opening hold must outlast them all.
        for (const stepMs of [50, 150, 300, 600, 1000]) {
            clock += stepMs;
            await jest.advanceTimersByTimeAsync(stepMs);
            expect(geom.getScrollTop()).toBe(0);
        }
        expect(clock).toBeLessThan(OPENING_HOLD_MS);
        expect(shouldHoldChatAtTop()).toBe(true);

        // Once released, scrollChatToBottom pins the chat to the bottom normally.
        hold.release();
        expect(shouldHoldChatAtTop()).toBe(false);
        loaded.script.scrollChatToBottom({ force: true });
        expect(geom.getScrollTop()).toBe(2000);
    });
});
