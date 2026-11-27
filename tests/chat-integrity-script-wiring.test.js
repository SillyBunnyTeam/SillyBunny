/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importScriptModule } from './util/script-harness.js';

let activeRuntime = null;

afterEach(() => {
    activeRuntime?.cleanup();
    activeRuntime = null;
    document.body.innerHTML = '';
    jest.restoreAllMocks();
});

async function createIntegrityScriptRuntime({ fetchImpl, mocks = {}, dom } = {}) {
    const fetchMock = fetchImpl ?? jest.fn(async (url) => {
        const target = String(url);
        if (target === '/api/chats/save') {
            return { ok: true, status: 200, json: async () => ({ integrity: 'next-integrity' }), text: async () => '' };
        }
        if (target === '/api/chats/get') {
            return { ok: true, status: 200, json: async () => [{ chat_metadata: { integrity: 'loaded' } }], text: async () => '' };
        }
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    });

    const loaded = await importScriptModule({
        dom,
        fetch: fetchMock,
        keepReal: ['scripts/chat-save-guard.js', 'scripts/chat-backup-sequence.js'],
        mocks,
    });
    activeRuntime = loaded;

    const { script } = loaded;
    script.characters.push(
        { name: 'Bunny', avatar: 'bunny.png', chat: 'active-chat', first_mes: 'Hello', data: { extensions: {} } },
        { name: 'Fox', avatar: 'fox.png', chat: 'fox-chat', first_mes: 'Hi', data: { extensions: {} } },
    );
    script.setCharacterId(0);
    script.setCharacterName('Bunny');
    script.chat.push({
        name: 'Bunny',
        is_user: false,
        is_system: false,
        mes: 'Swipe zero',
        swipe_id: 0,
        swipes: ['Swipe zero', 'Swipe one'],
        swipe_info: [{}, {}],
        extra: {},
    });
    script.updateChatMetadata({ integrity: 'initial-integrity', chat_id_hash: 42 }, true);

    return {
        ...loaded,
        fetchMock,
        saveBodies() {
            return fetchMock.mock.calls
                .filter(([url]) => String(url) === '/api/chats/save')
                .map(([, init]) => JSON.parse(init.body));
        },
    };
}

describe('public/script.js chat integrity, save queue, and navigation wiring', () => {
    test('adopts returned integrity only for the active chat file and scopes chat_id_hash on rename to active targets', async () => {
        let counter = 0;
        const renameBodies = [];
        const runtime = await createIntegrityScriptRuntime({
            fetchImpl: jest.fn(async (url, init) => {
                const target = String(url);
                if (target === '/api/chats/save') {
                    counter++;
                    return { ok: true, status: 200, json: async () => ({ integrity: `integrity-${counter}` }), text: async () => '' };
                }
                if (target === '/api/chats/rename') {
                    const parsed = JSON.parse(init.body);
                    renameBodies.push(parsed);
                    return { ok: true, status: 200, json: async () => ({ sanitizedFileName: parsed.renamed_file }), text: async () => '' };
                }
                return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
            }),
        });

        // Saving a non-active chat file must not adopt its returned integrity onto active chat_metadata.
        await expect(runtime.script.saveChat({ chatName: 'other-chat' })).resolves.toBe(true);
        expect(runtime.script.chat_metadata.integrity).toBe('initial-integrity');

        // Saving the active chat adopts the returned integrity.
        await expect(runtime.script.saveChat()).resolves.toBe(true);
        expect(runtime.script.chat_metadata.integrity).toBe('integrity-2');

        // Renaming a non-active chat derives a hash instead of reusing active chat_metadata.chat_id_hash;
        // renaming the active chat passes active chat_metadata.chat_id_hash directly.
        await runtime.script.renameChat('other-chat.jsonl', 'other-renamed.jsonl');
        await runtime.script.renameChat('active-chat.jsonl', 'active-renamed.jsonl');
        expect(renameBodies[0].chat_id_hash).not.toBe(42);
        expect(renameBodies[1].chat_id_hash).toBe(42);
    });

    test('queues saves, carries queued integrity forward, and runs 412 forced overwrite inside the active queue task', async () => {
        const events = [];
        let releaseFirstAttempt = null;
        let saveAttempt = 0;

        const runtime = await createIntegrityScriptRuntime({
            fetchImpl: jest.fn(async (url, init) => {
                if (String(url) !== '/api/chats/save') {
                    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
                }
                const body = JSON.parse(init.body);
                saveAttempt++;
                events.push({ attempt: saveAttempt, force: Boolean(body.force), mes: body.chat[1]?.mes, integrity: body.chat[0]?.chat_metadata?.integrity });

                if (saveAttempt === 1) {
                    await new Promise(resolve => { releaseFirstAttempt = resolve; });
                    return { ok: false, status: 412, json: async () => ({ error: 'integrity' }), text: async () => '' };
                }
                if (saveAttempt === 2) {
                    return { ok: true, status: 200, json: async () => ({ integrity: 'after-forced-overwrite' }), text: async () => '' };
                }
                return { ok: true, status: 200, json: async () => ({ integrity: 'after-second-save' }), text: async () => '' };
            }),
            mocks: {
                'scripts/popup.js': {
                    Popup: {
                        show: {
                            confirm: jest.fn(async () => 1),
                            input: jest.fn(async () => 'OVERWRITE'),
                        },
                    },
                    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
                    callGenericPopup: jest.fn(async () => 1),
                },
            },
        });

        runtime.script.chat[0].mes = 'first save content';
        const firstSave = runtime.script.saveChat({ deferBackup: true });
        for (let i = 0; i < 30 && !releaseFirstAttempt; i++) {
            await Promise.resolve();
        }
        expect(runtime.script.isChatSaving).toBe(true);

        // Queue second save while first is in-flight; mutate chat before releasing.
        runtime.script.chat[0].mes = 'second save content';
        const secondSave = runtime.script.saveChat();

        releaseFirstAttempt();
        await expect(firstSave).resolves.toBe(true);
        await expect(secondSave).resolves.toBe(true);
        expect(runtime.script.isChatSaving).toBe(false);

        // Attempt 1 (412) -> Attempt 2 (forced overwrite inside active task) -> Attempt 3 (queued second save using forced overwrite integrity).
        expect(events).toEqual([
            { attempt: 1, force: false, mes: 'first save content', integrity: 'initial-integrity' },
            { attempt: 2, force: true, mes: 'first save content', integrity: 'initial-integrity' },
            { attempt: 3, force: false, mes: 'second save content', integrity: 'after-forced-overwrite' },
        ]);
        expect(runtime.script.chat_metadata.integrity).toBe('after-second-save');
    });

    test('swipes increment chat generation and invalidate queued and debounced saves', async () => {
        let releaseBlocker = null;
        let saveCount = 0;
        const runtime = await createIntegrityScriptRuntime({
            dom: `
                <div id="chat">
                    <div class="mes last_mes" mesid="0" swipeid="0">
                        <div class="mes_block">
                            <div class="ch_name"><span class="name_text">Bunny</span></div>
                            <div class="mes_text">Swipe zero</div>
                        </div>
                        <div class="swipe_left"></div>
                        <div class="swipe_right"></div>
                        <div class="swipes-counter">1/2</div>
                    </div>
                </div>
                <div id="message_template" hidden>
                    <div class="mes">
                        <div class="mes_block">
                            <div class="ch_name"><span class="name_text"></span></div>
                            <div class="mes_text"></div>
                        </div>
                        <div class="swipe_left"></div>
                        <div class="swipe_right"></div>
                        <div class="swipes-counter"></div>
                    </div>
                </div>
            `,
            fetchImpl: jest.fn(async (url) => {
                if (String(url) === '/api/chats/save') {
                    saveCount++;
                    if (saveCount === 1) {
                        await new Promise(resolve => { releaseBlocker = resolve; });
                    }
                    return { ok: true, status: 200, json: async () => ({ integrity: `int-${saveCount}` }), text: async () => '' };
                }
                return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
            }),
        });

        const blocker = runtime.script.saveChat({ chatName: 'blocker' });
        for (let i = 0; i < 30 && !releaseBlocker; i++) {
            await Promise.resolve();
        }
        const staleQueued = runtime.script.saveChat();
        const generationBeforeSwipe = runtime.script.getChatGeneration();

        // Standard swipe to existing swipe 1 bumps chat generation.
        await runtime.script.swipe(null, 'right', { forceMesId: 0 });
        expect(runtime.script.getChatGeneration()).toBeGreaterThan(generationBeforeSwipe);

        releaseBlocker();
        await blocker;
        await expect(staleQueued).resolves.toBe(false);
    });

    test('debounced chat saves abort after active chat generation changes', async () => {
        const runtime = await createIntegrityScriptRuntime();
        jest.useFakeTimers();
        try {
            runtime.script.saveChatDebounced();
            runtime.script.incrementChatGeneration();
            await jest.advanceTimersByTimeAsync(2000);
        } finally {
            jest.useRealTimers();
        }

        expect(runtime.saveBodies()).toHaveLength(0);
    });

    test('saveChatConditional serializes slow saves through the queue instead of dropping them', async () => {
        let releaseFirst = null;
        let saveCount = 0;
        const runtime = await createIntegrityScriptRuntime({
            fetchImpl: jest.fn(async (url) => {
                if (String(url) === '/api/chats/save') {
                    saveCount++;
                    if (saveCount === 1) {
                        await new Promise(resolve => { releaseFirst = resolve; });
                    }
                    return { ok: true, status: 200, json: async () => ({ integrity: `int-${saveCount}` }), text: async () => '' };
                }
                return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
            }),
        });

        const first = runtime.script.saveChatConditional();
        for (let i = 0; i < 30 && !releaseFirst; i++) {
            await Promise.resolve();
        }
        runtime.script.chat[0].mes = 'updated while slow save runs';
        const second = runtime.script.saveChatConditional();

        releaseFirst();
        await Promise.all([first, second]);

        expect(runtime.saveBodies()).toHaveLength(2);
        expect(runtime.saveBodies()[1].chat[1].mes).toBe('updated while slow save runs');
    });

    test('navigation flushes pending saves and awaits in-flight solo and group queues instead of refusing', async () => {
        let releaseSoloSave = null;
        let releaseGroupWait = null;
        const waitForQueuedGroupChatSaves = jest.fn(() => new Promise(resolve => { releaseGroupWait = resolve; }));

        const runtime = await createIntegrityScriptRuntime({
            fetchImpl: jest.fn(async (url) => {
                const target = String(url);
                if (target === '/api/chats/save') {
                    await new Promise(resolve => { releaseSoloSave = resolve; });
                    return { ok: true, status: 200, json: async () => ({ integrity: 'flushed' }), text: async () => '' };
                }
                if (target === '/api/chats/get') {
                    return { ok: true, status: 200, json: async () => [{ chat_metadata: { integrity: 'fox-int' } }, { name: 'Fox', is_user: false, mes: 'Hi' }], text: async () => '' };
                }
                return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
            }),
            mocks: {
                'scripts/group-chats.js': {
                    waitForQueuedGroupChatSaves,
                },
            },
        });

        const inFlight = runtime.script.saveChat();
        for (let i = 0; i < 30 && !releaseSoloSave; i++) {
            await Promise.resolve();
        }

        let navDone = false;
        const switching = runtime.script.selectCharacterById(1).then(() => { navDone = true; });
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(navDone).toBe(false);

        releaseSoloSave();
        await inFlight;
        for (let i = 0; i < 30 && !releaseGroupWait; i++) {
            await Promise.resolve();
        }
        expect(waitForQueuedGroupChatSaves).toHaveBeenCalled();

        releaseGroupWait();
        await switching;
        expect(navDone).toBe(true);
        expect(String(runtime.script.this_chid)).toBe('1');
    });
});
