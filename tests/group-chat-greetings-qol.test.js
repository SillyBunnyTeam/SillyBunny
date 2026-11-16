import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

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
        // Desktop: the bar wraps, and its three buttons drop their labels (keeping the tooltip) once the bar is narrower than 900px.
        expect(styleSource).toMatch(/@container \(max-width: 900px\) \{[^@]*#group_add_greeting, #group_speaker_now, #group_speaker_hide\) > span \{\s*display:\s*none;/);
        expect(mobileStyleSource).toContain('grid-template-areas: "avatars greeting speak hide" !important;');
        expect(mobileStyleSource).toContain('#group_add_greeting span,');
        expect(mobileStyleSource).toMatch(/#group_add_greeting\s*\{[\s\S]*?grid-area:\s*greeting\s*!important;\s*}/);
    });

    test('hides the speaker controls from the bar and restores them from the wand menu', async () => {
        const indexSource = await fs.readFile(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
        const wandMenuSource = await fs.readFile(fileURLToPath(new URL('../public/scripts/templates/wandMenu.html', import.meta.url)), 'utf8');
        const styleSource = await fs.readFile(fileURLToPath(new URL('../public/style.css', import.meta.url)), 'utf8');
        const mobileStyleSource = await fs.readFile(fileURLToPath(new URL('../public/css/mobile-styles.css', import.meta.url)), 'utf8');
        const groupChatSource = await fs.readFile(fileURLToPath(new URL('../public/scripts/group-chats.js', import.meta.url)), 'utf8');

        expect(indexSource).toContain('id="group_speaker_hide"');
        expect(wandMenuSource).toContain('id="wand_group_speaker_controls"');

        // Hiding persists per account, and both directions run through the same setter.
        expect(groupChatSource).toContain('const GROUP_SPEAKER_CONTROLS_HIDDEN_KEY = \'GroupSpeakerControlsHidden\';');
        expect(groupChatSource).toContain('container.on(\'click\', \'#group_speaker_hide\', () => setGroupSpeakerControlsHidden(true));');
        expect(groupChatSource).toContain('$(document).on(\'click\', \'#wand_group_speaker_controls\', () => setGroupSpeakerControlsHidden(false));');
        expect(groupChatSource).toContain('container.toggleClass(\'displayNone\', !isAvailable || isHidden);');
        expect(groupChatSource).toContain('document.body.classList.toggle(\'groupSpeakerControlsHidden\', isHidden);');

        // The wand entry only exists while a hidden bar is waiting to come back.
        expect(styleSource).toMatch(/#extensionsMenu>#wand_group_speaker_controls\s*\{\s*display:\s*none;\s*}/);
        expect(styleSource).toMatch(/body\.groupSpeakerControlsHidden\s+#extensionsMenu>#wand_group_speaker_controls\s*\{\s*display:\s*flex;\s*}/);

        // The phone grid (mobile-styles.css) reserves a column for each button instead of overlapping the avatars.
        expect(mobileStyleSource).toMatch(/\.group_speaker_controls\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) var\(--sb-mobile-touch-target, 44px\) var\(--sb-mobile-touch-target, 44px\) var\(--sb-mobile-touch-target, 44px\)\s*!important;/);
        expect(mobileStyleSource).toMatch(/#group_speaker_hide\s*\{[\s\S]*?grid-area:\s*hide\s*!important;\s*}/);
    });

    test('the typing line is a row of its own on a phone and never hides the speaker chips', async () => {
        const mobileStyleSource = await fs.readFile(fileURLToPath(new URL('../public/css/mobile-styles.css', import.meta.url)), 'utf8');

        expect(mobileStyleSource).toMatch(/\.group_speaker_controls\.is-typing\s*\{[^}]*grid-template-areas:\s*"typing typing typing typing" "avatars greeting speak hide"\s*!important;/);
        expect(mobileStyleSource).toMatch(/\.group_typing_indicator\s*\{[^}]*grid-area:\s*typing\s*!important;/);
        expect(mobileStyleSource).not.toMatch(/\.is-typing \.group_speaker_list\s*\{[^}]*visibility:\s*hidden/);
    });

    test('speaker chips report the chosen speaker as a pressed state', async () => {
        const groupChatSource = await fs.readFile(fileURLToPath(new URL('../public/scripts/group-chats.js', import.meta.url)), 'utf8');

        expect(groupChatSource).toContain('item.attr(\'aria-pressed\', String(avatarId === selectedGroupSpeakerAvatar));');
        expect(groupChatSource).toContain('$(this).attr(\'aria-pressed\', String(avatarId === selectedGroupSpeakerAvatar));');
        expect(groupChatSource).toContain('.removeClass(\'selected\').attr(\'aria-pressed\', \'false\');');
    });

    test('clears a stale typing indicator when generation finishes', async () => {
        const groupChatSource = await fs.readFile(fileURLToPath(new URL('../public/scripts/group-chats.js', import.meta.url)), 'utf8');
        const setterStart = groupChatSource.indexOf('function setGroupTypingIndicator');
        const setterEnd = groupChatSource.indexOf('\n}\n\nfunction isGroupSpeakerControlsHidden', setterStart) + 2;
        const setterSource = groupChatSource.slice(setterStart, setterEnd);
        const state = { text: 'Character is typing...', displayNone: false, isTyping: true };
        const elements = {
            '#group_typing_indicator': {
                length: 1,
                text: value => state.text = value,
                toggleClass: (_className, enabled) => state.displayNone = enabled,
            },
            '#group_speaker_controls': {
                toggleClass: (_className, enabled) => state.isTyping = enabled,
            },
        };

        expect(setterStart).toBeGreaterThanOrEqual(0);
        expect(setterEnd).toBeGreaterThan(setterStart);
        vm.runInNewContext(`let activeGroupTypingName = '';\n${setterSource}\nsetGroupTypingIndicator('');`, {
            $: selector => elements[selector],
        });

        expect(state).toEqual({ text: '', displayNone: true, isTyping: false });
    });
});
