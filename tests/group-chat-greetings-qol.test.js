import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

describe('group chat greetings QoL', () => {
    test('seeds fresh group chats with a member greeting before the first save', async () => {
        const groupChatSource = await fs.readFile(fileURLToPath(new URL('../public/scripts/group-chats.js', import.meta.url)), 'utf8');
        const getGroupChatBody = groupChatSource.slice(
            groupChatSource.indexOf('export async function getGroupChat'),
            groupChatSource.indexOf('/**\n * Retrieves the members of a group'),
        );

        expect(groupChatSource).toContain('import { getRegexedString, regex_placement } from \'./extensions/regex/engine.js\';');
        expect(groupChatSource).toContain('function buildGroupGreetingMessage(avatarId)');
        expect(groupChatSource).toContain('force_avatar: getThumbnailUrl(\'avatar\', character.avatar),');
        expect(groupChatSource).toContain('original_avatar: character.avatar,');
        expect(groupChatSource).toContain('const greeting = getGroupGreetingMember(group, selectedGroupSpeakerAvatar);');
        expect(getGroupChatBody).toContain('freshGroupGreetingMessageId = addFreshGroupGreeting(group);');
        expect(getGroupChatBody.indexOf('freshGroupGreetingMessageId = addFreshGroupGreeting(group);'))
            .toBeLessThan(getGroupChatBody.indexOf('const savedFreshGroupChat = await saveGroupChat(groupId, false);'));
        expect(getGroupChatBody).toContain('metadata.integrity = chat_metadata.integrity;');
        expect(getGroupChatBody.indexOf('metadata.integrity = chat_metadata.integrity;'))
            .toBeLessThan(getGroupChatBody.lastIndexOf('updateChatMetadata(metadata, true);'));
        expect(getGroupChatBody).toContain('if (freshGroupGreetingMessageId !== -1) await emitGroupGreetingMessageEvents(freshGroupGreetingMessageId);');
    });

    test('starts new group branches with fresh integrity metadata', async () => {
        const groupChatSource = await fs.readFile(fileURLToPath(new URL('../public/scripts/group-chats.js', import.meta.url)), 'utf8');
        const createNewGroupChatBody = groupChatSource.slice(
            groupChatSource.indexOf('export async function createNewGroupChat'),
            groupChatSource.indexOf('/**\n * Retrieves past chats for a specified group'),
        );

        expect(createNewGroupChatBody).toContain('group.chat_id = newChatName;');
        expect(createNewGroupChatBody).toContain('updateChatMetadata({ integrity: uuidv4() }, true);');
        expect(createNewGroupChatBody.indexOf('updateChatMetadata({ integrity: uuidv4() }, true);'))
            .toBeLessThan(createNewGroupChatBody.indexOf('await getGroupChat(group.id, false, { newlyCreated: true });'));
    });

    test('wires the Add New Greeting button into desktop and mobile speaker controls', async () => {
        const indexSource = await fs.readFile(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
        const styleSource = await fs.readFile(fileURLToPath(new URL('../public/style.css', import.meta.url)), 'utf8');
        const mobileStyleSource = await fs.readFile(fileURLToPath(new URL('../public/css/mobile-styles.css', import.meta.url)), 'utf8');
        const groupChatSource = await fs.readFile(fileURLToPath(new URL('../public/scripts/group-chats.js', import.meta.url)), 'utf8');

        expect(indexSource).toContain('id="group_add_greeting"');
        expect(indexSource).toContain('class="fa-solid fa-hand-sparkles"');
        expect(indexSource).toContain('Add New Greeting');
        expect(groupChatSource).toContain('container.on(\'click\', \'#group_add_greeting\', addSelectedGroupGreeting);');
        expect(styleSource).toContain('grid-template-areas: "typing typing typing" "avatars greeting speak";');
        expect(styleSource).toContain('#group_add_greeting span,');
        expect(styleSource).toContain('#group_add_greeting {\n        grid-area: greeting;\n    }');
        expect(mobileStyleSource).toContain('grid-template-areas: "avatars greeting speak" !important;');
        expect(mobileStyleSource).toContain('#group_add_greeting span,');
        expect(mobileStyleSource).toContain('#group_add_greeting {\n        grid-area: greeting !important;\n    }');
    });
});
