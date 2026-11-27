/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';

import { importGroupChatsModule } from './util/group-chats-module-harness.js';

function mountGroupListDom() {
    document.body.innerHTML = `
        <div id="group_avatars_template" hidden>
            <div class="avatar avatar_collage collage_1"><img class="img_1" /></div>
        </div>
        <div id="group_list_template">
            <div class="group_select">
                <div class="avatar" data-sentinel="template"></div>
            </div>
        </div>
        <div id="rm_print_characters_block">
            <div class="group_select" data-grid="g1">
                <div class="avatar" data-sentinel="g1-original"></div>
            </div>
            <div class="group_select" data-grid="g2">
                <div class="avatar" data-sentinel="g2-original"></div>
            </div>
        </div>
        <div id="rm_group_chats_block">
            <div id="group_avatar_preview"></div>
            <div id="rm_group_members"></div>
            <div id="rm_group_add_members"></div>
        </div>
    `;
}

async function loadGroupChatsWithTwoGroups() {
    mountGroupListDom();
    const groups = [
        { id: 'g1', chat_id: 'chat-g1', chats: ['chat-g1'], name: 'Group One', members: ['alice.png'], disabled_members: [] },
        { id: 'g2', chat_id: 'chat-g2', chats: ['chat-g2'], name: 'Group Two', members: ['bob.png'], disabled_members: [] },
    ];
    const loaded = await importGroupChatsModule({
        fetch: jest.fn(async (url) => {
            if (url === '/api/groups/all') {
                return { ok: true, json: async () => structuredClone(groups) };
            }
            return { ok: true, json: async () => ({ ok: true }) };
        }),
    });
    await loaded.runReady();
    await loaded.groupChats.getGroups();
    return loaded;
}

afterEach(() => {
    jest.restoreAllMocks();
    document.body.replaceChildren();
});

describe('updateGroupAvatar', () => {
    test('a create-mode draft without an id leaves the list template and rows alone', async () => {
        const { groupChats } = await loadGroupChatsWithTwoGroups();

        groupChats.select_group_chats(null, false);

        expect(document.querySelector('#group_list_template .group_select > .avatar')?.dataset.sentinel).toBe('template');
        expect(document.querySelector('#rm_print_characters_block .group_select[data-grid="g1"] > .avatar')?.dataset.sentinel).toBe('g1-original');
        expect(document.querySelector('#rm_print_characters_block .group_select[data-grid="g2"] > .avatar')?.dataset.sentinel).toBe('g2-original');
        expect(document.querySelector('#group_avatar_preview')?.children.length).toBeGreaterThan(0);
    });

    test('a saved group only replaces its own list row avatar', async () => {
        const { groupChats } = await loadGroupChatsWithTwoGroups();

        groupChats.select_group_chats('g2', false);

        expect(document.querySelector('#group_list_template .group_select > .avatar')?.dataset.sentinel).toBe('template');
        expect(document.querySelector('#rm_print_characters_block .group_select[data-grid="g1"] > .avatar')?.dataset.sentinel).toBe('g1-original');
        const g2Avatar = document.querySelector('#rm_print_characters_block .group_select[data-grid="g2"]')?.firstElementChild;
        expect(g2Avatar?.dataset.sentinel).toBeUndefined();
        expect(g2Avatar?.classList.contains('avatar_collage') || g2Avatar?.classList.contains('avatar')).toBe(true);
    });
});
