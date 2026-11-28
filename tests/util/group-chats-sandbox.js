import { jest } from '@jest/globals';

import { event_types } from '../../public/scripts/events.js';
import { importGroupChatsModule } from './group-chats-module-harness.js';

function mountGroupChatChrome() {
    document.body.innerHTML = `
        <div id="chat"></div>
        <textarea id="send_textarea"></textarea>
        <div id="group_speaker_controls" class="group_speaker_controls displayNone">
            <div id="group_typing_indicator" class="group_typing_indicator displayNone"></div>
            <div class="group_speaker_list"></div>
            <button id="group_add_greeting" type="button">Add New Greeting</button>
            <button id="group_speaker_now" type="button">Speak Now</button>
            <button id="group_speaker_hide" type="button">Hide</button>
        </div>
        <div id="extensionsMenu">
            <button id="wand_group_speaker_controls" type="button"></button>
        </div>
        <div id="rm_group_chats_block">
            <select id="rm_group_activation_strategy">
                <option value="0" selected>Natural</option>
                <option value="1">List</option>
                <option value="2">Manual</option>
            </select>
            <div id="rm_group_members"></div>
            <div id="rm_group_add_members"></div>
        </div>
    `;
}

/**
 * Loads the real `public/scripts/group-chats.js` module into jsdom with an open group,
 * speaker controls bar, and composer. Bob wrote the last message.
 *
 * @param {object} [options]
 * @param {Record<string, object[]>} [options.chats] Optional group chat histories keyed by chat id.
 * @param {object[]} [options.groups] Optional initial group list.
 * @param {boolean} [options.openInitialGroup=true] Whether to open `'group-1'` immediately.
 */
export async function createGroupChatsRuntime({
    chats = null,
    groups: initialGroups = null,
    openInitialGroup = true,
} = {}) {
    mountGroupChatChrome();

    const groupList = structuredClone(initialGroups ?? [{
        id: 'group-1',
        name: 'Test Group',
        chat_id: 'chat-1',
        chats: chats ? Object.keys(chats) : ['chat-1'],
        members: ['alice.png', 'bob.png', 'carol.png', 'ghost.png'],
        disabled_members: ['carol.png'],
        activation_strategy: 0,
        allow_self_responses: false,
    }]);

    const chatStore = chats
        ? chats
        : {
            'chat-1': [
                { user_name: 'User', character_name: 'Test Group', chat_metadata: { tainted: true } },
                { name: 'Bob', original_avatar: 'bob.png', mes: 'Hello there.', is_user: false },
            ],
        };

    const saves = [];
    const fetchMock = jest.fn(async (url, request = {}) => {
        if (url === '/api/groups/all') {
            return { ok: true, json: async () => structuredClone(groupList) };
        }
        if (url === '/api/groups/edit') {
            return { ok: true, json: async () => ({ ok: true }) };
        }
        if (url === '/api/chats/group/get') {
            const { id } = JSON.parse(request.body ?? '{}');
            const history = chatStore[id] ?? [];
            return { ok: true, json: async () => history };
        }
        if (url === '/api/chats/group/save') {
            const payload = JSON.parse(request.body ?? '{}');
            saves.push(payload);
            chatStore[payload.id] = payload.chat;
            return { ok: true, json: async () => ({ result: 'ok' }) };
        }
        return { ok: true, json: async () => ({}) };
    });

    const changes = [];
    const generations = [];
    const generationOptions = [];
    const log = [];

    const loaded = await importGroupChatsModule({
        fetch: fetchMock,
        script: {
            Generate: jest.fn(async (type, options = {}) => {
                const character = loaded.state.characters[loaded.state.this_chid];
                generations.push({ type, avatar: character?.avatar });
                generationOptions.push(options);
                log.push(`${type} reply by ${character?.avatar}`);
                if (type === 'normal') {
                    loaded.state.chat.push({
                        name: character.name,
                        original_avatar: character.avatar,
                        mes: `${character.name} reply`,
                        is_user: false,
                    });
                }
            }),
            sendMessageAsUser: jest.fn(async text => {
                loaded.state.chat.push({ name: 'User', mes: text, is_user: true });
                log.push(`user message: ${text}`);
            }),
        },
    });

    const { groupChats, runReady, eventSource, state, mocks, $ } = loaded;
    await runReady();
    await groupChats.getGroups();

    if (openInitialGroup) {
        await groupChats.openGroupById('group-1', { switchMenu: false });
        // Ensure Bob's last message is present in chat and speaker bar is rendered.
        if (!state.chat.length) {
            state.chat.push({ name: 'Bob', original_avatar: 'bob.png', mes: 'Hello there.', is_user: false });
        }
    }

    // Listen to speaker changes AFTER initial boot so tests only observe test-driven changes.
    eventSource.on(event_types.GROUP_SPEAKER_SELECTION_CHANGED, avatar => changes.push(avatar));
    changes.length = 0;
    saves.length = 0;

    const bar = {
        highlighted: () => [...document.querySelectorAll('#group_speaker_controls .group_speaker_avatar.selected')]
            .map(el => el.getAttribute('data-avatar')),
        pressed: () => [...document.querySelectorAll('#group_speaker_controls .group_speaker_avatar[aria-pressed="true"]')]
            .map(el => el.getAttribute('data-avatar')),
        clickAvatar: avatar => {
            const el = document.querySelector(`#group_speaker_controls .group_speaker_avatar[data-avatar="${avatar}"]`);
            if (!el) throw new Error(`Missing speaker chip for ${avatar}`);
            $(el).trigger($.Event('click', { shiftKey: false }));
        },
    };

    const composer = {
        get value() { return String($('#send_textarea').val() ?? ''); },
        set value(next) { $('#send_textarea').val(String(next ?? '')); },
    };

    return {
        groupChats,
        state,
        mocks,
        eventSource,
        $,
        fetchMock,
        changes,
        generations,
        generationOptions,
        log,
        saves,
        composer,
        bar,
    };
}
