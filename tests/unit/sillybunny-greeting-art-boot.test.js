/** @jest-environment jsdom */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const handlers = new Map();
const sync = jest.fn();

function emit(event, ...args) {
    for (const handler of handlers.get(event) ?? []) {
        handler(...args);
    }
}

async function boot() {
    jest.resetModules();
    handlers.clear();
    sync.mockClear();
    document.body.innerHTML = '<div id="chat"></div>';
    await jest.unstable_mockModule('../../public/script.js', () => ({ characters: [], chat: [], this_chid: undefined }));
    await jest.unstable_mockModule('../../public/scripts/group-chats.js', () => ({ selected_group: null }));
    await jest.unstable_mockModule('../../public/scripts/events.js', () => ({
        event_types: {
            CHAT_CHANGED: 'chat_changed',
            MESSAGE_SWIPED: 'message_swiped',
            MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
            MESSAGE_DELETED: 'message_deleted',
            MESSAGE_EDITED: 'message_edited',
            MESSAGE_UPDATED: 'message_updated',
            CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
            MORE_MESSAGES_LOADED: 'more_messages_loaded',
        },
        eventSource: {
            on: (event, handler) => {
                handlers.set(event, [...(handlers.get(event) ?? []), handler]);
            },
        },
    }));
    await jest.unstable_mockModule('../../public/scripts/sillybunny-home/greeting-art.js', () => ({
        createGreetingArt: () => ({ chatOpened: jest.fn(), sync, start: jest.fn() }),
    }));
    await jest.unstable_mockModule('../../public/scripts/sillybunny-home/greeting-art-viewer.js', () => ({ openGreetingArtViewer: jest.fn() }));
    await import('../../public/scripts/sillybunny-home/greeting-art-boot.js');
}

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
});

describe('the greeting picture and a burst of deletions', () => {
    test('a burst of MESSAGE_DELETED syncs the picture once, after the burst', async () => {
        await boot();

        for (let count = 0; count < 100; count++) {
            emit('message_deleted', 100 - count);
        }
        expect(sync).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1000);
        expect(sync).toHaveBeenCalledTimes(1);
    });

    test('a single deletion still syncs, and the other events sync at once', async () => {
        await boot();

        emit('message_deleted', 3);
        jest.advanceTimersByTime(1000);
        expect(sync).toHaveBeenCalledTimes(1);

        emit('message_edited', 0);
        emit('message_swiped', 0);
        expect(sync).toHaveBeenCalledTimes(3);
    });
});
