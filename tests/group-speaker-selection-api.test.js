import vm from 'node:vm';
import { describe, expect, test } from '@jest/globals';
import { event_types } from '../public/scripts/events.js';
import { createGroupChatsRuntime as createSpeakerRuntime } from './util/group-chats-sandbox.js';

describe('group speaker bar selection API', () => {
    test('picks an enabled member of the open group and announces the change', () => {
        const { runtime, changes, bar } = createSpeakerRuntime();

        expect(runtime.setSelectedGroupSpeakerAvatar('bob.png')).toBe(true);
        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('bob.png');
        expect(bar.highlighted()).toEqual(['bob.png']);
        expect(changes).toEqual(['bob.png']);
    });

    test('refuses muted members, outsiders and malformed input without touching the pick', () => {
        const { runtime, changes } = createSpeakerRuntime();
        runtime.setSelectedGroupSpeakerAvatar('alice.png');

        for (const avatar of ['carol.png', 'dave.png', 'ghost.png', 'ALICE.PNG', 7, null, undefined, {}]) {
            expect(runtime.setSelectedGroupSpeakerAvatar(avatar)).toBe(false);
        }

        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('alice.png');
        expect(changes).toEqual(['alice.png']);
    });

    test('refuses a pick outside a group chat', () => {
        const { runtime, changes } = createSpeakerRuntime();
        runtime.selected_group = null;

        expect(runtime.setSelectedGroupSpeakerAvatar('alice.png')).toBe(false);
        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('');
        expect(changes).toEqual([]);
    });

    test('clears the pick with an empty string', () => {
        const { runtime, changes, bar } = createSpeakerRuntime();
        runtime.setSelectedGroupSpeakerAvatar('alice.png');

        expect(runtime.setSelectedGroupSpeakerAvatar('')).toBe(true);
        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('');
        expect(bar.highlighted()).toEqual([]);
        expect(changes).toEqual(['alice.png', '']);
    });

    test('announces picks made in the bar and the clear after a reply', async () => {
        const { runtime, changes, handlers } = createSpeakerRuntime();
        runtime.initGroupSpeakerControls();
        const clickAvatar = handlers['click .group_speaker_avatar'];

        await clickAvatar.call({ avatar: 'bob.png' }, { shiftKey: false });
        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('bob.png');
        await clickAvatar.call({ avatar: 'bob.png' }, { shiftKey: false });
        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('');
        await clickAvatar.call({ avatar: 'alice.png' }, { shiftKey: false });
        runtime.clearSelectedGroupSpeaker();

        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('');
        expect(changes).toEqual(['bob.png', '', 'alice.png', '']);
    });
});

describe('group replies and the speaker bar pick', () => {
    test('the picked member answers the next reply, which uses up the pick', async () => {
        const { runtime, changes, generations } = createSpeakerRuntime();
        runtime.setSelectedGroupSpeakerAvatar('alice.png');

        await runtime.generateGroupWrapper(false, 'normal', {});

        expect(generations).toEqual([{ type: 'normal', avatar: 'alice.png' }]);
        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('');
        expect(changes).toEqual(['alice.png', '']);
    });

    test('a background quiet generation leaves the pick for the next reply', async () => {
        const { runtime, changes, generations } = createSpeakerRuntime();
        runtime.setSelectedGroupSpeakerAvatar('alice.png');

        await runtime.generateGroupWrapper(false, 'quiet', { quiet_prompt: 'Summarize the chat so far.' });

        expect(generations).toEqual([{ type: 'quiet', avatar: 'bob.png' }]);
        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('alice.png');
        expect(changes).toEqual(['alice.png']);
    });

    for (const type of ['swipe', 'continue']) {
        test(`a ${type} stays with the author of the last message and keeps the pick`, async () => {
            const { runtime, changes, generations } = createSpeakerRuntime();
            runtime.setSelectedGroupSpeakerAvatar('alice.png');

            await runtime.generateGroupWrapper(false, type, {});

            expect(generations).toEqual([{ type, avatar: 'bob.png' }]);
            expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('alice.png');
            expect(changes).toEqual(['alice.png']);
        });
    }

    test('impersonating the user borrows the picked member\'s card and leaves the pick for the reply after it', async () => {
        const { runtime, changes, generations } = createSpeakerRuntime();
        runtime.setSelectedGroupSpeakerAvatar('bob.png');
        // Without a pick, impersonation borrows a random member's card; a fixed draw would pick the first member.
        vm.runInContext('Math.random = () => 0;', runtime);

        await runtime.generateGroupWrapper(false, 'impersonate', {});

        expect(generations).toEqual([{ type: 'impersonate', avatar: 'bob.png' }]);
        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('bob.png');
        expect(changes).toEqual(['bob.png']);
    });

    test('impersonating the user without a pick borrows a random member\'s card', async () => {
        const { runtime, changes, generations } = createSpeakerRuntime();
        vm.runInContext('Math.random = () => 0;', runtime);

        await runtime.generateGroupWrapper(false, 'impersonate', {});

        expect(generations).toEqual([{ type: 'impersonate', avatar: 'alice.png' }]);
        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('');
        expect(changes).toEqual([]);
    });

    test('a regenerated reply is answered by the picked member', async () => {
        const { runtime, changes, generations } = createSpeakerRuntime();
        runtime.setSelectedGroupSpeakerAvatar('alice.png');

        await runtime.generateGroupWrapper(false, 'regenerate', {});

        expect(generations).toEqual([{ type: 'normal', avatar: 'alice.png' }]);
        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('');
        expect(changes).toEqual(['alice.png', '']);
    });
});

describe('keeping the speaker bar pick valid', () => {
    test('drops a pick that is not a member of the newly opened group', () => {
        const { runtime, changes } = createSpeakerRuntime();
        runtime.setSelectedGroupSpeakerAvatar('alice.png');
        runtime.groups.push({ id: 'group-2', members: ['bob.png'], disabled_members: [] });
        runtime.selected_group = 'group-2';

        runtime.updateGroupSpeakerControls();

        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('');
        expect(changes).toEqual(['alice.png', '']);
    });

    test('drops a pick of a member who was muted after being picked', () => {
        const { runtime, changes } = createSpeakerRuntime();
        runtime.setSelectedGroupSpeakerAvatar('bob.png');
        runtime.groups[0].disabled_members.push('bob.png');

        runtime.updateGroupSpeakerControls();

        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('');
        expect(changes).toEqual(['bob.png', '']);
    });

    test('keeps a pick made while the previous reply was still being written', async () => {
        const { runtime, changes, generations } = createSpeakerRuntime();
        runtime.setSelectedGroupSpeakerAvatar('alice.png');
        const generate = runtime.Generate;
        runtime.Generate = async (...args) => {
            await generate(...args);
            runtime.setSelectedGroupSpeakerAvatar('bob.png');
        };

        await runtime.generateGroupWrapper(false, 'normal', {});

        expect(generations).toEqual([{ type: 'normal', avatar: 'alice.png' }]);
        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('bob.png');
        expect(changes).toEqual(['alice.png', 'bob.png']);
    });

    test('keeps the bar in step with a pick made by the first listener as the old pick clears', () => {
        const { runtime, eventSource, bar } = createSpeakerRuntime();
        runtime.setSelectedGroupSpeakerAvatar('alice.png');
        eventSource.makeFirst(event_types.GROUP_SPEAKER_SELECTION_CHANGED, avatar => {
            if (avatar === '') runtime.setSelectedGroupSpeakerAvatar('bob.png');
        });

        runtime.clearSelectedGroupSpeaker();

        expect(runtime.getSelectedGroupSpeakerAvatar()).toBe('bob.png');
        expect(bar.highlighted()).toEqual(['bob.png']);
    });
});
