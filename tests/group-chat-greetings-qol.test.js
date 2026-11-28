/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { event_types } from '../public/scripts/events.js';
import { createGroupChatsRuntime } from './util/group-chats-sandbox.js';

afterEach(() => {
    jest.restoreAllMocks();
    document.body.replaceChildren();
});

describe('group chat greetings QoL', () => {
    test('seeds fresh group chats with a member greeting before the first save', async () => {
        const timeline = [];
        const sandbox = await createGroupChatsRuntime({
            chats: { 'chat-1': [] },
            openInitialGroup: false,
        });
        sandbox.mocks.regex.getRegexedString.mockImplementation(text => `[regex] ${text}`);
        const origFetch = sandbox.fetchMock.getMockImplementation();
        sandbox.fetchMock.mockImplementation(async (url, request) => {
            if (url === '/api/chats/group/save') {
                timeline.push('save');
                // Server mints an integrity token on the first save; simulate that through chat_metadata.
                sandbox.state.chat_metadata.integrity = 'fresh-integrity-1';
            }
            return origFetch(url, request);
        });
        sandbox.eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => timeline.push('rendered'));
        sandbox.eventSource.on(event_types.MESSAGE_RECEIVED, () => timeline.push('received'));

        await sandbox.groupChats.openGroupById('group-1', { switchMenu: false });

        expect(sandbox.saves).toHaveLength(1);
        const savedMessages = sandbox.saves[0].chat;
        expect(savedMessages[1]).toMatchObject({
            name: 'Alice',
            original_avatar: 'alice.png',
            force_avatar: '/thumbnail?type=avatar&file=alice.png',
            mes: '[regex] Hello from Alice.',
        });
        expect(sandbox.state.chat_metadata.integrity).toBe('fresh-integrity-1');
        expect(timeline[0]).toBe('save');
        expect(timeline).toContain('received');
        expect(timeline.indexOf('save')).toBeLessThan(timeline.indexOf('received'));
    });

    test('starts new group branches with fresh integrity metadata', async () => {
        const sandbox = await createGroupChatsRuntime();
        const callOrder = [];
        const origUpdateMetadata = sandbox.mocks.script.updateChatMetadata.getMockImplementation();
        sandbox.mocks.script.updateChatMetadata.mockImplementation((meta, reset) => {
            if (meta?.integrity && reset) {
                callOrder.push(`integrity:${meta.integrity}`);
            }
            return origUpdateMetadata(meta, reset);
        });
        const origFetch = sandbox.fetchMock.getMockImplementation();
        sandbox.fetchMock.mockImplementation(async (url, request) => {
            if (url === '/api/chats/group/get') {
                callOrder.push('getGroupChat');
            }
            return origFetch(url, request);
        });

        await sandbox.groupChats.createNewGroupChat('group-1');

        const integrityStep = callOrder.findIndex(step => step.startsWith('integrity:'));
        const loadStep = callOrder.indexOf('getGroupChat');
        expect(integrityStep).toBeGreaterThanOrEqual(0);
        expect(loadStep).toBeGreaterThan(integrityStep);
        expect(sandbox.groupChats.groups[0].chat_id).not.toBe('chat-1');
    });

    test('wires the Add New Greeting button into desktop and mobile speaker controls', async () => {
        const indexSource = await fs.readFile(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
        const styleSource = await fs.readFile(fileURLToPath(new URL('../public/style.css', import.meta.url)), 'utf8');
        const mobileStyleSource = await fs.readFile(fileURLToPath(new URL('../public/css/mobile-styles.css', import.meta.url)), 'utf8');

        expect(indexSource).toContain('id="group_add_greeting"');
        expect(indexSource).toContain('Add New Greeting');
        // The three buttons are label-only: no icon in the markup, and no rule that hides their labels at any width.
        expect(indexSource).not.toContain('fa-hand-sparkles');
        expect(styleSource).not.toMatch(/#group_add_greeting, #group_speaker_now, #group_speaker_hide\) > span/);
        // Phone: the chips take a row, and the three label-only buttons share the row under them.
        expect(mobileStyleSource).toContain('grid-template-areas: "avatars avatars avatars" "greeting speak hide" !important;');
        expect(mobileStyleSource).not.toContain('#group_add_greeting span,');
        expect(mobileStyleSource).toMatch(/#group_add_greeting\s*\{[\s\S]*?grid-area:\s*greeting\s*!important;\s*}/);

        // Behavioural verification: clicking #group_add_greeting appends the chosen member's greeting.
        const sandbox = await createGroupChatsRuntime();
        sandbox.groupChats.setSelectedGroupSpeakerAvatar('bob.png');
        const beforeLength = sandbox.state.chat.length;
        sandbox.$('#group_add_greeting').trigger('click');
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(sandbox.state.chat).toHaveLength(beforeLength + 1);
        expect(sandbox.state.chat.at(-1)).toMatchObject({
            name: 'Bob',
            original_avatar: 'bob.png',
            mes: 'Hello from Bob.',
        });
    });

    test('hides the speaker controls from the bar and restores them from the wand menu', async () => {
        const indexSource = await fs.readFile(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
        const wandMenuSource = await fs.readFile(fileURLToPath(new URL('../public/scripts/templates/wandMenu.html', import.meta.url)), 'utf8');
        const styleSource = await fs.readFile(fileURLToPath(new URL('../public/style.css', import.meta.url)), 'utf8');
        const mobileStyleSource = await fs.readFile(fileURLToPath(new URL('../public/css/mobile-styles.css', import.meta.url)), 'utf8');

        expect(indexSource).toContain('id="group_speaker_hide"');
        expect(wandMenuSource).toContain('id="wand_group_speaker_controls"');
        // The wand entry only exists while a hidden bar is waiting to come back.
        expect(styleSource).toMatch(/#extensionsMenu>#wand_group_speaker_controls\s*\{\s*display:\s*none;\s*}/);
        expect(styleSource).toMatch(/body\.groupSpeakerControlsHidden\s+#extensionsMenu>#wand_group_speaker_controls\s*\{\s*display:\s*flex;\s*}/);
        // The phone grid (mobile-styles.css) reserves a column for each button instead of overlapping the avatars.
        expect(mobileStyleSource).toMatch(/\.group_speaker_controls\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)\s*!important;/);
        expect(mobileStyleSource).toMatch(/#group_speaker_hide\s*\{[\s\S]*?grid-area:\s*hide\s*!important;\s*}/);

        // Behavioural verification: hide and restore toggle the bar, body class, and accountStorage key.
        const sandbox = await createGroupChatsRuntime();
        const container = document.getElementById('group_speaker_controls');
        expect(container.classList.contains('displayNone')).toBe(false);
        expect(document.body.classList.contains('groupSpeakerControlsHidden')).toBe(false);

        sandbox.$('#group_speaker_hide').trigger('click');
        expect(sandbox.mocks.accountStorage.setItem).toHaveBeenCalledWith('GroupSpeakerControlsHidden', 'true');
        expect(container.classList.contains('displayNone')).toBe(true);
        expect(document.body.classList.contains('groupSpeakerControlsHidden')).toBe(true);

        sandbox.$('#wand_group_speaker_controls').trigger('click');
        expect(sandbox.mocks.accountStorage.setItem).toHaveBeenCalledWith('GroupSpeakerControlsHidden', 'false');
        expect(container.classList.contains('displayNone')).toBe(false);
        expect(document.body.classList.contains('groupSpeakerControlsHidden')).toBe(false);
    });

    test('the typing line is a row of its own on a phone and never hides the speaker chips', async () => {
        const mobileStyleSource = await fs.readFile(fileURLToPath(new URL('../public/css/mobile-styles.css', import.meta.url)), 'utf8');

        expect(mobileStyleSource).toMatch(/\.group_speaker_controls\.is-typing\s*\{[^}]*grid-template-areas:\s*"typing typing typing" "avatars avatars avatars" "greeting speak hide"\s*!important;/);
        expect(mobileStyleSource).toMatch(/\.group_typing_indicator\s*\{[^}]*grid-area:\s*typing\s*!important;/);
        expect(mobileStyleSource).not.toMatch(/\.is-typing \.group_speaker_list\s*\{[^}]*visibility:\s*hidden/);
    });

    test('speaker chips report the chosen speaker as a pressed state', async () => {
        const sandbox = await createGroupChatsRuntime();
        expect(sandbox.bar.pressed()).toEqual([]);

        sandbox.groupChats.setSelectedGroupSpeakerAvatar('bob.png');
        expect(sandbox.bar.pressed()).toEqual(['bob.png']);

        sandbox.bar.clickAvatar('alice.png');
        expect(sandbox.bar.pressed()).toEqual(['alice.png']);

        sandbox.groupChats.setSelectedGroupSpeakerAvatar('');
        expect(sandbox.bar.pressed()).toEqual([]);
    });

    test('clears a stale typing indicator when generation finishes', async () => {
        const sandbox = await createGroupChatsRuntime();
        const indicator = document.getElementById('group_typing_indicator');
        const controls = document.getElementById('group_speaker_controls');
        let observedDuringGenerate = null;
        const originalGenerate = sandbox.mocks.script.Generate.getMockImplementation();
        sandbox.mocks.script.Generate.mockImplementation(async (...args) => {
            observedDuringGenerate = {
                text: indicator.textContent,
                displayNone: indicator.classList.contains('displayNone'),
                isTyping: controls.classList.contains('is-typing'),
            };
            return originalGenerate(...args);
        });

        sandbox.groupChats.setSelectedGroupSpeakerAvatar('alice.png');
        await sandbox.groupChats.generateGroupWrapper(false, 'normal', {});

        expect(observedDuringGenerate).toEqual({
            text: 'Alice is typing...',
            displayNone: false,
            isTyping: true,
        });
        expect({
            text: indicator.textContent,
            displayNone: indicator.classList.contains('displayNone'),
            isTyping: controls.classList.contains('is-typing'),
        }).toEqual({
            text: '',
            displayNone: true,
            isTyping: false,
        });
    });
});
