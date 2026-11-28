/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';

import { event_types } from '../public/scripts/events.js';
import { createGroupChatsRuntime as createSpeakerRuntime } from './util/group-chats-sandbox.js';

afterEach(() => {
    jest.restoreAllMocks();
    document.body.replaceChildren();
});

describe('group speaker bar selection API', () => {
    test('picks an enabled member of the open group and announces the change', async () => {
        const { groupChats, changes, bar } = await createSpeakerRuntime();

        expect(groupChats.setSelectedGroupSpeakerAvatar('bob.png')).toBe(true);
        expect(groupChats.getSelectedGroupSpeakerAvatar()).toBe('bob.png');
        expect(bar.highlighted()).toEqual(['bob.png']);
        expect(bar.pressed()).toEqual(['bob.png']);
        expect(changes).toEqual(['bob.png']);
    });

    test('refuses muted members, outsiders and malformed input without touching the pick', async () => {
        const { groupChats, changes } = await createSpeakerRuntime();
        groupChats.setSelectedGroupSpeakerAvatar('alice.png');

        for (const avatar of ['carol.png', 'dave.png', 'ghost.png', 'ALICE.PNG', 7, null, undefined, {}]) {
            expect(groupChats.setSelectedGroupSpeakerAvatar(avatar)).toBe(false);
        }

        expect(groupChats.getSelectedGroupSpeakerAvatar()).toBe('alice.png');
        expect(changes).toEqual(['alice.png']);
    });

    test('refuses a pick outside a group chat', async () => {
        const { groupChats, changes } = await createSpeakerRuntime({ openInitialGroup: false });

        expect(groupChats.setSelectedGroupSpeakerAvatar('alice.png')).toBe(false);
        expect(groupChats.getSelectedGroupSpeakerAvatar()).toBe('');
        expect(changes).toEqual([]);
    });

    test('clears the pick with an empty string', async () => {
        const { groupChats, changes, bar } = await createSpeakerRuntime();
        groupChats.setSelectedGroupSpeakerAvatar('alice.png');

        expect(groupChats.setSelectedGroupSpeakerAvatar('')).toBe(true);
        expect(groupChats.getSelectedGroupSpeakerAvatar()).toBe('');
        expect(bar.highlighted()).toEqual([]);
        expect(bar.pressed()).toEqual([]);
        expect(changes).toEqual(['alice.png', '']);
    });

    test('announces picks made in the bar and the clear after a reply', async () => {
        const { groupChats, changes, bar } = await createSpeakerRuntime();

        bar.clickAvatar('bob.png');
        expect(groupChats.getSelectedGroupSpeakerAvatar()).toBe('bob.png');
        bar.clickAvatar('bob.png');
        expect(groupChats.getSelectedGroupSpeakerAvatar()).toBe('');
        bar.clickAvatar('alice.png');
        await groupChats.generateGroupWrapper(false, 'normal', {});

        expect(groupChats.getSelectedGroupSpeakerAvatar()).toBe('');
        expect(changes).toEqual(['bob.png', '', 'alice.png', '']);
    });
});

describe('group replies and the speaker bar pick', () => {
    test('the picked member answers the next reply, which uses up the pick', async () => {
        const { groupChats, changes, generations } = await createSpeakerRuntime();
        groupChats.setSelectedGroupSpeakerAvatar('alice.png');

        await groupChats.generateGroupWrapper(false, 'normal', {});

        expect(generations).toEqual([{ type: 'normal', avatar: 'alice.png' }]);
        expect(groupChats.getSelectedGroupSpeakerAvatar()).toBe('');
        expect(changes).toEqual(['alice.png', '']);
    });

    test('a background quiet generation leaves the pick for the next reply', async () => {
        const { groupChats, changes, generations } = await createSpeakerRuntime();
        groupChats.setSelectedGroupSpeakerAvatar('alice.png');

        await groupChats.generateGroupWrapper(false, 'quiet', { quiet_prompt: 'Summarize the chat so far.' });

        expect(generations).toEqual([{ type: 'quiet', avatar: 'bob.png' }]);
        expect(groupChats.getSelectedGroupSpeakerAvatar()).toBe('alice.png');
        expect(changes).toEqual(['alice.png']);
    });

    for (const type of ['swipe', 'continue']) {
        test(`a ${type} stays with the author of the last message and keeps the pick`, async () => {
            const { groupChats, changes, generations } = await createSpeakerRuntime();
            groupChats.setSelectedGroupSpeakerAvatar('alice.png');

            await groupChats.generateGroupWrapper(false, type, {});

            expect(generations).toEqual([{ type, avatar: 'bob.png' }]);
            expect(groupChats.getSelectedGroupSpeakerAvatar()).toBe('alice.png');
            expect(changes).toEqual(['alice.png']);
        });
    }

    test('impersonating the user borrows the picked member\'s card and leaves the pick for the reply after it', async () => {
        const { groupChats, changes, generations } = await createSpeakerRuntime();
        groupChats.setSelectedGroupSpeakerAvatar('bob.png');
        // Without a pick, impersonation borrows a random member's card; a fixed draw would pick the first member.
        jest.spyOn(Math, 'random').mockReturnValue(0);

        await groupChats.generateGroupWrapper(false, 'impersonate', {});

        expect(generations).toEqual([{ type: 'impersonate', avatar: 'bob.png' }]);
        expect(groupChats.getSelectedGroupSpeakerAvatar()).toBe('bob.png');
        expect(changes).toEqual(['bob.png']);
    });

    test('impersonating the user without a pick borrows a random member\'s card', async () => {
        const { groupChats, changes, generations } = await createSpeakerRuntime();
        jest.spyOn(Math, 'random').mockReturnValue(0);

        await groupChats.generateGroupWrapper(false, 'impersonate', {});

        expect(generations).toEqual([{ type: 'impersonate', avatar: 'alice.png' }]);
        expect(groupChats.getSelectedGroupSpeakerAvatar()).toBe('');
        expect(changes).toEqual([]);
    });

    test('a regenerated reply is answered by the picked member', async () => {
        const { groupChats, changes, generations } = await createSpeakerRuntime();
        groupChats.setSelectedGroupSpeakerAvatar('alice.png');

        await groupChats.generateGroupWrapper(false, 'regenerate', {});

        expect(generations).toEqual([{ type: 'normal', avatar: 'alice.png' }]);
        expect(groupChats.getSelectedGroupSpeakerAvatar()).toBe('');
        expect(changes).toEqual(['alice.png', '']);
    });
});

describe('keeping the speaker bar pick valid', () => {
    test('drops a pick that is not a member of the newly opened group', async () => {
        const { groupChats, changes } = await createSpeakerRuntime({
            groups: [
                {
                    id: 'group-1', name: 'One', chat_id: 'chat-1', chats: ['chat-1'],
                    members: ['alice.png', 'bob.png', 'carol.png', 'ghost.png'], disabled_members: ['carol.png'],
                },
                {
                    id: 'group-2', name: 'Two', chat_id: 'chat-2', chats: ['chat-2'],
                    members: ['bob.png'], disabled_members: [],
                },
            ],
        });
        groupChats.setSelectedGroupSpeakerAvatar('alice.png');

        await groupChats.openGroupById('group-2', { switchMenu: false });

        expect(groupChats.getSelectedGroupSpeakerAvatar()).toBe('');
        expect(changes).toEqual(['alice.png', '']);
    });

    test('drops a pick of a member who was muted after being picked', async () => {
        const { groupChats, changes } = await createSpeakerRuntime();
        groupChats.setSelectedGroupSpeakerAvatar('bob.png');
        groupChats.groups[0].disabled_members.push('bob.png');

        groupChats.updateGroupSpeakerControls();

        expect(groupChats.getSelectedGroupSpeakerAvatar()).toBe('');
        expect(changes).toEqual(['bob.png', '']);
    });

    test('keeps a pick made while the previous reply was still being written', async () => {
        const { groupChats, mocks, changes, generations } = await createSpeakerRuntime();
        groupChats.setSelectedGroupSpeakerAvatar('alice.png');
        const originalGenerate = mocks.script.Generate.getMockImplementation();
        mocks.script.Generate.mockImplementation(async (...args) => {
            await originalGenerate(...args);
            groupChats.setSelectedGroupSpeakerAvatar('bob.png');
        });

        await groupChats.generateGroupWrapper(false, 'normal', {});

        expect(generations).toEqual([{ type: 'normal', avatar: 'alice.png' }]);
        expect(groupChats.getSelectedGroupSpeakerAvatar()).toBe('bob.png');
        expect(changes).toEqual(['alice.png', 'bob.png']);
    });

    test('keeps the bar in step with a pick made by the first listener as the old pick clears', async () => {
        const { groupChats, eventSource, bar } = await createSpeakerRuntime();
        groupChats.setSelectedGroupSpeakerAvatar('alice.png');
        eventSource.makeFirst(event_types.GROUP_SPEAKER_SELECTION_CHANGED, avatar => {
            if (avatar === '') groupChats.setSelectedGroupSpeakerAvatar('bob.png');
        });

        groupChats.setSelectedGroupSpeakerAvatar('');

        expect(groupChats.getSelectedGroupSpeakerAvatar()).toBe('bob.png');
        expect(bar.highlighted()).toEqual(['bob.png']);
    });
});
