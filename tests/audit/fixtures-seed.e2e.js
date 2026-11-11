import { expect, test } from '@playwright/test';
import { variantContextOptions } from '../helpers/surface-matrix.js';
import { bootSurfaceApp } from '../helpers/surfaces/boot.js';
import { FIXTURES, seedServer } from '../helpers/surfaces/fixtures.js';
import { NEEDS } from '../helpers/surfaces/schema.js';

test.use(variantContextOptions());

/** The fixtures that the browser side of this spec reads; the needs of other coders are seeded but not read here. */
const READ = [
    'character', 'chat', 'group', 'lorebook', 'persona', 'tags', 'folders', 'characters-many', 'chat-long', 'group-chat', 'lorebook-entries',
    'personas-many', 'agents', 'quick-replies', 'regex-scripts', 'archived-chats', 'databank', 'connection-profile',
];

test('every need seeds once, reads back through the app, and seeds nothing the second time', async ({ page, baseURL }) => {
    await seedServer(baseURL, NEEDS);
    expect(await seedServer(baseURL, NEEDS), 'a second seeding creates nothing').toEqual([]);

    await bootSurfaceApp(page, baseURL, { needs: NEEDS });
    const fixtures = Object.fromEntries(READ.map(id => [id, FIXTURES[id]]));
    const seen = await page.evaluate(async fixtures => {
        const { getRequestHeaders } = await import('/script.js');
        const send = async (path, body, { ok = false } = {}) => {
            const response = await fetch(path, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
            if (ok) {
                return response.ok;
            }
            if (!response.ok) {
                throw new Error(`${path} answered ${response.status}`);
            }
            return response.json();
        };
        const tags = await import('/scripts/tags.js');
        const { power_user } = await import('/scripts/power-user.js');
        const { extension_settings } = await import('/scripts/extensions.js');
        const { getAgents } = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        const context = window.SillyTavern.getContext();
        const { character, chat, lorebook } = fixtures;
        const many = fixtures['characters-many'].characters;
        const long = fixtures['chat-long'];
        const archived = fixtures['archived-chats'].chats;
        const databank = fixtures.databank;
        const verified = await send('/api/files/verify', { urls: [databank.global.url, databank.character.url] });
        const settingsAnswer = await send('/api/settings/get', {});
        const inventory = await send('/api/chats/archive/inventory', { scope: 'archive', page_size: 500 });
        if (inventory.cursor) {
            await send('/api/chats/archive/release', { cursor: inventory.cursor }, { ok: true });
        }
        const fileOf = avatar => context.characters.find(entry => entry.avatar === avatar);
        return {
            characters: context.characters.map(entry => entry.avatar),
            characterChat: fileOf(character.avatar)?.chat,
            chatRecords: (await send('/api/chats/get', { ch_name: character.name, avatar_url: character.avatar, file_name: chat.file })).length,
            groups: (await send('/api/groups/all', {})).map(group => ({ name: group.name, members: group.members, chat_id: group.chat_id })),
            lorebookEntries: Object.keys((await send('/api/worldinfo/get', { name: lorebook.name })).entries).length,
            avatars: await send('/api/avatars/get', {}),
            personas: power_user.personas,
            personaDescriptions: power_user.persona_descriptions,
            defaultPersona: power_user.default_persona,
            tags: tags.tags.map(tag => tag.id),
            tagMap: tags.tag_map,
            taggedCharacter: tags.tag_map[character.avatar],
            folders: power_user.sb_folders,

            many: many.map(entry => {
                const card = fileOf(entry.avatar);
                return { name: card?.name, favorite: card?.fav === true || card?.data?.extensions?.fav === true };
            }),
            long: await (async () => {
                const records = await send('/api/chats/get', { ch_name: character.name, avatar_url: character.avatar, file_name: long.file });
                const messages = records.slice(1);
                return {
                    count: messages.length,
                    speakers: messages.map(message => message.is_user),
                    reasoning: messages[long.reasoningIndex]?.extra?.reasoning,
                    swipes: messages[long.swipesIndex]?.swipes?.length,
                    narrator: messages[long.narratorIndex]?.extra?.type,
                    code: messages[long.codeIndex]?.mes,
                    longLength: messages[long.longIndex]?.mes.length,
                    image: messages[long.imageIndex]?.extra?.media?.[0]?.url,
                };
            })(),
            groupChat: (await send('/api/chats/group/get', { id: fixtures['group-chat'].chatId })).slice(1).map(message => message.name),
            entryBook: Object.values((await send('/api/worldinfo/get', { name: fixtures['lorebook-entries'].book })).entries).map(entry => ({
                comment: entry.comment, constant: entry.constant, disable: entry.disable, group: entry.group, secondary: entry.keysecondary,
                length: entry.content.length, filter: entry.characterFilter?.names,
            })),
            savedAgents: settingsAnswer.inChatAgents.map(agent => ({ id: agent.id, enabled: agent.enabled, category: agent.category, prompt: agent.prompt.length, tools: agent.tools.length })),
            loadedAgents: getAgents().map(agent => agent.id),
            savedSets: settingsAnswer.quickReplyPresets.map(set => ({ name: set.name, replies: set.qrList.length, menus: set.qrList.filter(reply => reply.contextList.length).map(reply => reply.id) })),
            quickReplies: window.quickReplyApi.listSets(),
            quickRepliesGlobal: window.quickReplyApi.settings.isEnabled ? window.quickReplyApi.settings.config.setList.map(link => link.set.name) : [],
            regex: extension_settings.regex.map(script => ({ id: script.id, disabled: script.disabled })),
            archive: inventory.rows.filter(row => JSON.stringify(row).includes('audit-archive-')).length,
            archiveFiles: archived.map(chat => JSON.stringify(inventory.rows).includes(chat.file)),
            databankVerified: verified,
            databankGlobal: extension_settings.attachments.map(item => item.url),
            databankCharacter: (extension_settings.character_attachments?.[character.avatar] ?? []).map(item => item.url),
            profiles: extension_settings.connectionManager.profiles.map(profile => ({ id: profile.id, name: profile.name, model: profile.model })),
            selectedProfile: extension_settings.connectionManager.selectedProfile,
        };
    }, fixtures);

    // character, chat, group, lorebook, persona, tags, folders
    expect(seen.characters).toContain(FIXTURES.character.avatar);
    expect(seen.characterChat).toBe(FIXTURES.chat.file);
    expect(seen.chatRecords).toBe(FIXTURES.chat.messages.length + 1);
    expect(seen.lorebookEntries).toBe(FIXTURES.lorebook.entries.length);
    expect(seen.avatars).toContain(FIXTURES.persona.avatar);
    expect(seen.personas[FIXTURES.persona.avatar]).toBe(FIXTURES.persona.name);
    expect(seen.tags).toHaveLength(FIXTURES.tags.names.length);
    expect(seen.taggedCharacter).toHaveLength(FIXTURES.tags.assigned);
    expect(seen.folders.characters.folders.map(folder => folder.name)).toEqual(FIXTURES.folders.characters.map(folder => folder.name));
    expect(seen.folders.characters.members[FIXTURES.character.avatar]).toBe(FIXTURES.folders.characters[0].id);

    // group
    const group = seen.groups.find(entry => entry.name === FIXTURES.group.name);
    expect(group?.members).toEqual(FIXTURES.group.members);
    expect(group?.chat_id).toBe(FIXTURES.group.chatId);

    // characters-many
    const many = FIXTURES['characters-many'].characters;
    expect(many).toHaveLength(12);
    expect(seen.many.map(card => card.name)).toEqual(many.map(card => card.name));
    expect(seen.many.filter(card => card.favorite).map(card => card.name)).toEqual(many.filter(card => card.favorite).map(card => card.name));
    expect(many.filter(card => card.favorite)).toHaveLength(2);
    expect(many.filter(card => card.name.length > 50).length).toBeGreaterThanOrEqual(3);
    for (const card of many) {
        expect(seen.tagMap[card.avatar], `${card.avatar} has its two tags`).toHaveLength(2);
        const folder = FIXTURES.folders.characters[card.folderIndex];
        expect(seen.folders.characters.members[card.avatar]).toBe(folder?.id);
    }

    // chat-long
    const long = FIXTURES['chat-long'];
    expect(seen.long.count).toBe(long.count);
    expect(seen.long.speakers.every((user, index) => index === long.narratorIndex || user === (index % 2 === 1)), 'user and character turns alternate').toBe(true);
    expect(seen.long.reasoning).toContain('The question is where the lamp belongs.');
    expect(seen.long.swipes).toBe(long.swipeCount);
    expect(seen.long.narrator).toBe('narrator');
    expect(seen.long.code).toContain('```js');
    expect(seen.long.code).toContain('| Day | Task | Hours |');
    expect(seen.long.longLength).toBe(long.longLength);
    expect(seen.long.image).toBe('/img/ai4.png');

    // group-chat
    const groupChat = FIXTURES['group-chat'];
    expect(seen.groupChat).toHaveLength(groupChat.turns.length);
    expect(new Set(seen.groupChat).size).toBe(4);

    // lorebook-entries
    const kinds = FIXTURES['lorebook-entries'].kinds;
    const entry = title => seen.entryBook.find(candidate => candidate.comment === title);
    expect(seen.entryBook).toHaveLength(6);
    expect(entry(kinds.constant).constant).toBe(true);
    expect(entry(kinds.keyed).secondary).toEqual(FIXTURES['lorebook-entries'].secondaryKeys);
    expect(entry(kinds.disabled).disable).toBe(true);
    expect(entry(kinds.grouped).group).toBe(FIXTURES['lorebook-entries'].groupName);
    expect(entry(kinds.long).length).toBeGreaterThan(2000);
    expect(entry(kinds.filtered).filter).toEqual([FIXTURES.character.name]);

    // personas-many
    const personas = FIXTURES['personas-many'];
    expect(personas.personas).toHaveLength(5);
    for (const persona of personas.personas) {
        expect(seen.avatars).toContain(persona.avatar);
        expect(seen.personas[persona.avatar]).toBe(persona.name);
        expect(seen.personaDescriptions[persona.avatar].description).toBe(persona.description);
    }
    expect(seen.personaDescriptions[personas.titledAvatar].title).toBe('Court Cartographer');
    expect(seen.personaDescriptions[personas.longDescriptionAvatar].description.length).toBeGreaterThan(1500);
    expect(seen.defaultPersona).toBe(personas.defaultAvatar);

    // agents
    const agents = FIXTURES.agents;
    expect(seen.savedAgents.map(agent => agent.id)).toEqual(expect.arrayContaining([agents.tracker.id, agents.tool.id, agents.disabled.id]));
    expect(seen.loadedAgents).toEqual(expect.arrayContaining([agents.tracker.id, agents.tool.id, agents.disabled.id]));
    const saved = id => seen.savedAgents.find(agent => agent.id === id);
    expect(saved(agents.tracker.id)).toMatchObject({ category: 'tracker', enabled: true });
    expect(saved(agents.tracker.id).prompt).toBeGreaterThan(1500);
    expect(saved(agents.tool.id).tools).toBeGreaterThan(0);
    expect(saved(agents.disabled.id).enabled).toBe(false);

    // quick-replies
    const replies = FIXTURES['quick-replies'];
    const set = name => seen.savedSets.find(candidate => candidate.name === name);
    expect(set(replies.main.name)).toEqual({ name: replies.main.name, replies: 3, menus: [replies.menuReplyId] });
    expect(set(replies.extras.name)?.replies).toBe(2);
    expect(seen.quickReplies).toEqual(expect.arrayContaining([replies.main.name, replies.extras.name]));
    expect(seen.quickRepliesGlobal).toContain(replies.main.name);
    expect(seen.quickRepliesGlobal).not.toContain(replies.extras.name);

    // regex-scripts
    expect(seen.regex).toEqual(expect.arrayContaining([
        { id: FIXTURES['regex-scripts'].enabled.id, disabled: false },
        { id: FIXTURES['regex-scripts'].disabled.id, disabled: true },
    ]));

    // archived-chats
    expect(seen.archive).toBeGreaterThanOrEqual(5);
    expect(seen.archiveFiles).toEqual(FIXTURES['archived-chats'].chats.map(() => true));
    expect(new Set(FIXTURES['archived-chats'].chats.map(chat => chat.avatar)).size).toBe(2);

    // databank
    const databank = FIXTURES.databank;
    expect(seen.databankVerified).toEqual({ [databank.global.url]: true, [databank.character.url]: true });
    expect(seen.databankGlobal).toEqual([databank.global.url]);
    expect(seen.databankCharacter).toEqual([databank.character.url]);

    // connection-profile
    const profile = FIXTURES['connection-profile'];
    expect(seen.profiles).toContainEqual({ id: profile.id, name: profile.name, model: profile.model });
    expect(seen.selectedProfile).not.toBe(profile.id);
});
