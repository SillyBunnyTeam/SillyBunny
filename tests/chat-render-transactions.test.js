/** @jest-environment jsdom */
/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importScriptModule } from './util/script-harness.js';

let activeRuntime = null;

afterEach(() => {
    activeRuntime?.cleanup();
    activeRuntime = null;
    document.body.innerHTML = '';
    jest.restoreAllMocks();
});

const RENDER_TX_DOM = `
    <div id="chat"></div>
    <div id="message_template" hidden>
        <div class="mes">
            <div class="mes_block">
                <div class="ch_name"><span class="name_text"></span></div>
                <div class="mes_text"></div>
            </div>
        </div>
    </div>
`;

async function createTransactionRuntime() {
    let elapsed = 0;
    const frames = [];
    const origRaf = window.requestAnimationFrame;
    const origCaf = window.cancelAnimationFrame;

    // Advance performance.now by more than 8ms on each call so renderMessagesInBatches yields after one message.
    const nowSpy = jest.spyOn(performance, 'now').mockImplementation(() => {
        elapsed += 9;
        return elapsed;
    });

    const raf = jest.fn((callback) => {
        frames.push(callback);
        return frames.length;
    });
    const caf = jest.fn();
    window.requestAnimationFrame = raf;
    window.cancelAnimationFrame = caf;
    globalThis.requestAnimationFrame = raf;
    globalThis.cancelAnimationFrame = caf;

    const loaded = await importScriptModule({
        dom: RENDER_TX_DOM,
        power_user: {
            chat_truncation: 100,
        },
    });
    activeRuntime = {
        cleanup() {
            nowSpy.mockRestore();
            window.requestAnimationFrame = origRaf;
            window.cancelAnimationFrame = origCaf;
            globalThis.requestAnimationFrame = origRaf;
            globalThis.cancelAnimationFrame = origCaf;
            loaded.cleanup();
        },
    };

    const { script, eventSource } = loaded;
    script.characters.push({ name: 'Bunny', avatar: 'bunny.png', chat: 'tx-chat' });
    script.setCharacterId(0);
    script.setCharacterName('Bunny');
    script.chat.push(
        { name: 'User', is_user: true, is_system: false, mes: 'A', extra: {} },
        { name: 'Bunny', is_user: false, is_system: false, mes: 'B', extra: {} },
        { name: 'User', is_user: true, is_system: false, mes: 'C', extra: {} },
    );

    const emittedEvents = [];
    for (const type of [script.event_types.MESSAGE_DELETED, script.event_types.MORE_MESSAGES_LOADED]) {
        eventSource.on(type, () => emittedEvents.push(type));
    }

    const waitForFrame = async () => {
        for (let turn = 0; frames.length === 0 && turn < 100; turn++) {
            await Promise.resolve();
        }
        if (frames.length === 0) {
            throw new Error('Render did not schedule a frame');
        }
    };

    const finish = async (pending) => {
        let done = false;
        const completion = Promise.all(pending).finally(() => { done = true; });
        for (let turn = 0; !done && turn < 200; turn++) {
            const cb = frames.shift();
            if (cb) {
                cb(elapsed);
            }
            await Promise.resolve();
        }
        if (!done) {
            throw new Error('Render did not complete');
        }
        await completion;
    };

    const rows = () => Array.from(document.querySelectorAll('#chat > .mes')).map((el) => {
        const mesId = el.getAttribute('mesid');
        const text = el.querySelector('.mes_text')?.textContent?.trim() ?? '';
        return `${text}@${mesId}`;
    });

    const insertMessageDom = (messageId) => {
        const el = script.updateMessageElement(script.chat[messageId], { messageId })[0];
        document.getElementById('chat').appendChild(el);
        return el;
    };

    const decorateAll = () => {
        document.querySelectorAll('#chat > .mes').forEach((el) => {
            el.dataset.decorated = 'true';
        });
    };

    const decorations = () => Array.from(document.querySelectorAll('#chat > .mes'))
        .map((el) => el.dataset.decorated === 'true');

    return {
        script,
        eventSource,
        mocks: loaded.mocks,
        frames,
        emittedEvents,
        waitForFrame,
        finish,
        rows,
        insertMessageDom,
        decorateAll,
        decorations,
    };
}

describe('yielded chat render transactions', () => {
    test('restarts from current indices when a visible message is deleted during redisplay', async () => {
        const host = await createTransactionRuntime();
        const pending = host.script.redisplayChat();
        await host.waitForFrame();
        expect(host.rows()).toEqual(['A@0']);

        await host.script.deleteMessage(0, undefined, false, false);
        await host.finish([pending]);
        expect(host.rows()).toEqual(['B@0', 'C@1']);
    });

    test('restarts history insertion when deletion changes its selected indices', async () => {
        const host = await createTransactionRuntime();
        host.insertMessageDom(2);
        const pending = host.script.showMoreMessages();
        await host.waitForFrame();
        expect(host.rows()).toEqual(['A@0', 'C@2']);

        await host.script.deleteMessage(0, undefined, false, false);
        await host.finish([pending]);
        expect(host.rows()).toEqual(['B@0', 'C@1']);
        expect(host.emittedEvents).toEqual([
            host.script.event_types.MESSAGE_DELETED,
            host.script.event_types.MORE_MESSAGES_LOADED,
        ]);
    });

    test.each(['older', 'newer'])('reapplies extension decorations after %s history recovery completes', async (direction) => {
        const host = await createTransactionRuntime();
        host.eventSource.on(host.script.event_types.MORE_MESSAGES_LOADED, () => host.decorateAll());
        const initialId = direction === 'older' ? 2 : 0;
        host.insertMessageDom(initialId);

        const pending = direction === 'older'
            ? host.script.showMoreMessages()
            : host.script.showNewerMessages();
        await host.waitForFrame();
        await host.script.deleteMessage(0, undefined, false, false);
        await host.finish([pending]);

        expect(host.rows()).toEqual(['B@0', 'C@1']);
        expect(host.decorations()).toEqual([true, true]);
        expect(host.emittedEvents).toEqual([
            host.script.event_types.MESSAGE_DELETED,
            host.script.event_types.MORE_MESSAGES_LOADED,
        ]);
    });

    test.each(['replacement render', 'chat switch'])('does not emit a stale history event when recovery is superseded by %s', async (supersession) => {
        const host = await createTransactionRuntime();
        host.insertMessageDom(2);
        const pending = host.script.showMoreMessages();
        await host.waitForFrame();
        await host.script.deleteMessage(0, undefined, false, false);
        host.frames.shift()?.(0);
        await host.waitForFrame();

        const replacement = supersession === 'replacement render'
            ? host.script.redisplayChat()
            : Promise.resolve();
        if (supersession === 'chat switch') {
            host.script.incrementChatGeneration();
        }
        await host.finish([pending, replacement]);
        expect(host.emittedEvents).toEqual([host.script.event_types.MESSAGE_DELETED]);
    });

    test.each(['older first', 'newer first'])('only the replacement render finishes when frames resume %s', async (order) => {
        const host = await createTransactionRuntime();
        const applyTagsMock = host.mocks['scripts/tags.js'].applyCharacterTagsToMessageDivs;
        applyTagsMock.mockClear();

        const first = host.script.redisplayChat();
        await host.waitForFrame();
        const second = host.script.redisplayChat();
        for (let turn = 0; host.frames.length < 2 && turn < 100; turn++) {
            await Promise.resolve();
        }
        expect(host.frames).toHaveLength(2);
        if (order === 'newer first') {
            host.frames.reverse();
        }
        await host.finish([first, second]);
        expect(host.rows()).toEqual(['A@0', 'B@1', 'C@2']);
        expect(applyTagsMock).toHaveBeenCalledTimes(1);
    });

    test('detects same-length reordering rather than only changes to chat length', async () => {
        const host = await createTransactionRuntime();
        const pending = host.script.redisplayChat();
        await host.waitForFrame();
        [host.script.chat[1], host.script.chat[2]] = [host.script.chat[2], host.script.chat[1]];
        await host.finish([pending]);
        expect(host.rows()).toEqual(['A@0', 'C@1', 'B@2']);
    });
});
