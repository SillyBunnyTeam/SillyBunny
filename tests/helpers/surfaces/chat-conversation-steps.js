/**
 * Open and wait steps of the chat family for Conversation mode. A step that follows a spec says so on the function. No
 * Playwright import, so the registry loads in Jest.
 *
 * The thread is built in the page, as `foundation/conversation-mode.e2e.js` does, so that the timeline has every shape
 * that the design describes: a grouped run of messages, a gap of more than 20 minutes, a day boundary, own messages, a
 * reaction, a pin, an image. A state runs on top of its surface's `open`, and a state is opened after the surface has been
 * opened again, so `openConversation()` puts the workspace back to its resting page whatever the last state opened.
 */

import { FIXTURES } from './fixture-data.js';
import { AVATAR_IMAGE_URL, sentences } from './need-kit.js';
import { closeOverlays, dismissDialogs } from './menu-steps.js';
import { setExpandMessageActions, stopGeneration, waitForStill } from './chat-steps.js';
import { settle } from './steps.js';

const START = Date.UTC(2026, 0, 1, 12, 0, 0);
const MINUTE = 60_000;

/** The shapes of the thread, in order; `at` is the minute after `START`, and `tag` names a message that a surface works on. */
const THREAD = Object.freeze([
    { role: 'character', at: 0, text: 'Good morning. The lamp is lit.' },
    { role: 'character', at: 1, text: 'Did you sleep well?' },
    { role: 'user', at: 3, text: 'Yes, thank you. Could you describe the room?' },
    { role: 'user', at: 4, text: 'I would like to draw it.' },
    { role: 'character', at: 26, tag: 'reacted', text: `A quiet room with a lamp, a desk and a window. ${sentences(2, 3)}`, extra: { conversation_reactions: { heart: 1 } } },
    { role: 'user', at: 28, tag: 'own-long', text: `That is lovely. ${sentences(3, 6)}` },
    { role: 'character', at: 24 * 60 + 5, text: 'Good morning again. A new day in the forest.', extra: { conversation_pinned: true } },
    { role: 'character', at: 24 * 60 + 6, text: 'This is the view from the window.', extra: { image_url: AVATAR_IMAGE_URL, image_prompt: 'The view from a window' } },
    { role: 'user', at: 24 * 60 + 9, text: 'Thank you. I will be back this evening.' },
]);

/** The id of the Nth message of the thread. */
export const conversationMessageId = number => `audit-${number}`;

/** The message of the thread with the given id, in the timeline. */
export const conversationMessage = number => `#sb_conversation_timeline .sb-conversation-message[data-message-id="${conversationMessageId(number)}"]`;

/**
 * The positions in the thread that the surfaces work on: `reacted` is a character message with a reaction, `ownLong` a long
 * message of the user, `last` the message that the timeline rests on.
 */
export const THREAD_INDEX = Object.freeze({
    reacted: THREAD.findIndex(entry => entry.tag === 'reacted'),
    ownLong: THREAD.findIndex(entry => entry.tag === 'own-long'),
    last: THREAD.length - 1,
});

const BRANCH_NAMES = Object.freeze(['Rainy evening', 'Another ending']);

/** The id of the Nth message of a branch that `addConversationBranches` makes, counting the branches and the messages from 0. */
export const branchMessageId = (branch, number) => `branch-${branch}-${number}`;

/** The message of a branch, in the timeline. */
export const branchMessage = (branch, number) => `#sb_conversation_timeline .sb-conversation-message[data-message-id="${branchMessageId(branch, number)}"]`;

/**
 * Shows one page of the Conversation workspace. A desktop window shows the rail and the chat together; the pages layout
 * (`(max-width: 768px)`) shows one at a time. Going back to the chat picks the conversation of the audit character by its avatar.
 * @param {import('@playwright/test').Page} page
 * @param {'chat' | 'pals'} wanted `pals` is the rail of conversations, with the status and new-conversation buttons.
 */
export async function showConversationPage(page, wanted) {
    const sheld = page.locator('#sheld');
    if (await sheld.getAttribute('data-sb-conversation-layout') !== 'pages' || await sheld.getAttribute('data-sb-conversation-page') === wanted) {
        return;
    }
    if (wanted === 'pals') {
        await page.locator('#sb_conversation_pals_toggle').click();
    } else {
        await page.locator(`.sb-conversation-pal[data-avatar="${FIXTURES.character.avatar}"]`).click();
    }
    await page.waitForFunction(value => document.getElementById('sheld')?.getAttribute('data-sb-conversation-page') === value, wanted);
    await settle(page);
}

/**
 * Makes the app report a connection, or none, and waits until the composer of the workspace shows it: the entry's prompt
 * text changes and Send is enabled. From `conversation-composer-connection.e2e.js`.
 * @param {import('@playwright/test').Page} page
 * @param {boolean} connected
 */
export async function setConversationConnection(page, connected) {
    await page.evaluate(async (connected) => {
        const { setOnlineStatus } = await import('/script.js');
        setOnlineStatus(connected ? 'Connected' : 'no_connection');
    }, connected);
    await page.waitForFunction(connected => document.getElementById('sb_conversation_input').placeholder === (connected ? 'Type your message...' : 'Not connected to API!')
        && document.getElementById('sb_conversation_send').disabled === !connected, connected);
}

/** Closes the settings column or page if it is open. */
export async function closeConversationSettingsPane(page) {
    if (await page.locator('#sb_conversation_settings_drawer').isVisible()) {
        await page.locator('[data-sb-conversation-action="close-settings"]').first().click();
        await page.locator('#sb_conversation_settings_drawer').waitFor({ state: 'hidden' });
    }
}

/** Puts the workspace back to the page of the chat with nothing open: no editor, search, reply, picker, text or attachment. */
async function resetConversation(page) {
    await closeOverlays(page);
    await setExpandMessageActions(page, false);
    await page.evaluate(async () => {
        window.toastr?.clear?.();
        const pickers = await import('/scripts/sillybunny-conversation/pickers.js');
        pickers.hideConversationPickers({ animate: false });
        const timeline = await import('/scripts/sillybunny-conversation/timeline-render.js');
        timeline.toggleConversationSearchBar(false);
        timeline.clearConversationReplyTarget();
        const attachments = await import('/scripts/sillybunny-conversation/attachments.js');
        attachments.clearConversationAttachmentInput();
        document.querySelector('#sb_conversation_timeline .sb-conversation-message.is-editing .sb-conversation-message-edit-cancel')?.click();
        const input = document.getElementById('sb_conversation_input');
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.activeElement?.blur?.();
    });
    await closeConversationSettingsPane(page);
    await showConversationPage(page, 'chat');
    await page.mouse.move(0, 0);
}

/**
 * Opens the Conversation workspace for the audit character with the thread above, and rests it on the page of the chat.
 * From `foundation/conversation-mode.e2e.js` (`seedConversation`).
 * @param {import('@playwright/test').Page} page
 */
export async function openConversation(page) {
    await stopGeneration(page);
    const open = await page.locator('#sheld[data-sb-conversation-mode="on"] #sb_conversation_timeline .sb-conversation-message').count();
    if (!open) {
        await dismissDialogs(page);
        const thread = THREAD.map((entry, number) => ({
            id: conversationMessageId(number),
            role: entry.role,
            name: entry.role === 'user' ? FIXTURES.chat.userName : FIXTURES.character.name,
            mes: entry.text,
            send_date: new Date(START + entry.at * MINUTE).toISOString(),
            created_at: START + entry.at * MINUTE,
            extra: entry.extra ?? {},
        }));
        await page.evaluate(async ({ avatar, thread }) => {
            const context = window.SillyTavern.getContext();
            if (!context.characters.length) {
                await context.getCharacters();
            }
            const index = context.characters.findIndex(character => character.avatar === avatar);
            if (index < 0) {
                throw new Error(`The audit character ${avatar} is not on the server.`);
            }
            await context.selectCharacterById(index, { switchMenu: false });
            document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
            const { saveConversationThread } = await import('/scripts/sillybunny-conversation/thread-store.js');
            saveConversationThread(avatar, thread);
            const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
            if (!openConversationWorkspaceForAvatar(avatar, { showToast: false, enable: true })) {
                throw new Error(`Could not open the Conversation workspace for ${avatar}.`);
            }
        }, { avatar: FIXTURES.character.avatar, thread });
        await page.locator('#sheld[data-sb-conversation-mode="on"]').waitFor({ state: 'visible' });
        await page.locator('#sb_conversation_timeline .sb-conversation-message').first().waitFor({ state: 'visible' });
        await dismissDialogs(page);
    }
    await showMainThread(page);
    await resetConversation(page);
    await setConversationConnection(page, false);
    await settle(page);
}

/** Selects the main conversation again when a branch is open, as the branch list of the header does. */
async function showMainThread(page) {
    if (await page.locator(conversationMessage(0)).count()) {
        return;
    }
    await page.evaluate(async (avatar) => {
        const { selectConversationThread } = await import('/scripts/sillybunny-conversation/chrome.js');
        await selectConversationThread(avatar, { branchId: '' });
    }, FIXTURES.character.avatar);
    await page.locator(conversationMessage(0)).waitFor({ state: 'attached' });
}

/**
 * Shows the settings of the workspace: a column beside the chat from 1200px up, a drawer over it below that, and on a phone
 * (`(max-width: 768px)`) a page of its own, where the Conversation menu holds the entry.
 */
export async function openConversationSettings(page) {
    const layout = await page.locator('#sheld').getAttribute('data-sb-conversation-layout');
    if (layout === 'pages') {
        await page.locator('[data-sb-conversation-action="open-conversation-menu"]').click();
        await page.locator('.sb-action-menu-item', { hasText: 'Conversation settings' }).click();
    } else {
        await page.locator('[data-sb-conversation-action="open-settings"]').click();
    }
    await page.locator('#sb_conversation_settings_drawer').waitFor({ state: 'visible' });
    await settle(page);
}

/** Opens the inline editor of a message. From `foundation/conversation-mode.e2e.js` ("inline message editor"). */
export async function editConversationMessageById(page, number) {
    // The timeline rests on its last message, so a message higher up is scrolled to before its editor is opened.
    await waitForStill(page, conversationMessage(number));
    await page.locator(conversationMessage(number)).scrollIntoViewIfNeeded();
    await waitForStill(page, conversationMessage(number));
    await page.evaluate(async (id) => {
        const { editConversationMessage } = await import('/scripts/sillybunny-conversation/generation.js');
        await editConversationMessage(id);
    }, conversationMessageId(number));
    const textarea = '.sb-conversation-message.is-editing .sb-conversation-message-edit-textarea';
    await page.locator(textarea).waitFor({ state: 'visible' });
    await waitForStill(page, textarea);
    await settle(page);
}

/** Shows a picker of the workspace by calling the function that the rail's buttons call, from the page of the rail where its anchor is. */
export async function openConversationPicker(page, { toggle, root }) {
    await showConversationPage(page, 'pals');
    await page.evaluate(async ({ toggle }) => {
        const pickers = await import('/scripts/sillybunny-conversation/pickers.js');
        pickers[toggle]();
    }, { toggle });
    await page.locator(root).waitFor({ state: 'visible' });
    await settle(page, { root });
}

/** Adds two conversations to the thread of the character, so that the workspace has branches, and opens the first of them. */
export async function addConversationBranches(page) {
    await page.evaluate(async ({ avatar, texts, names, characterName, userName }) => {
        const context = await import('/scripts/sillybunny-conversation/context.js');
        const { saveConversationThread } = await import('/scripts/sillybunny-conversation/thread-store.js');
        const { selectConversationThread } = await import('/scripts/sillybunny-conversation/chrome.js');
        const created = names.map((name, index) => {
            const branch = context.createConversationBranchForAvatar(avatar, name);
            const start = Date.UTC(2026, 0, 2 + index, 18, 0, 0);
            saveConversationThread(avatar, texts.map((text, number) => ({
                id: `branch-${index}-${number}`, role: number % 2 === 0 ? 'character' : 'user', name: number % 2 === 0 ? characterName : userName,
                mes: text, send_date: new Date(start + number * 60_000).toISOString(), created_at: start + number * 60_000, extra: {},
            })), { branchId: branch.id });
            return branch;
        });
        await selectConversationThread(avatar, { branchId: created[0].id });
    }, {
        avatar: FIXTURES.character.avatar,
        characterName: FIXTURES.character.name,
        userName: FIXTURES.chat.userName,
        names: BRANCH_NAMES,
        texts: ['It is raining on the window.', 'I like the sound of it.', 'Then we shall leave the lamp low.'],
    });
    await page.locator(branchMessage(0, 0)).waitFor({ state: 'visible' });
    await settle(page);
}
