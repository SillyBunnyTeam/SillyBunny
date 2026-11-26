import { expect, test } from '@playwright/test';
import { NEW_MENU, bootConversationPage, getCharacterAvatars, rowNamed } from './helpers/conversation-list-steps.js';
import { seedConversation } from './helpers/conversation-seed.js';

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 120000 });

const COMPOSER = '#sb_conversation_input';
const SEND = '#sb_conversation_send';
const FORM = '#sb_conversation_form';
const HEADER_NAME = '#sb_conversation_header [data-sb-conversation-name]';
const FILE_INPUT = '#sb_conversation_file_input';
const ATTACHMENT_PREVIEW = '#sb_conversation_attachment_preview';
const PICKER = '.sb-picker';
const DRAFT = 'typed in the conversation that was open';

/** A route that waits for `open()`, so that a request of the switch takes as long as a test needs. */
function gate() {
    let open;
    const promise = new Promise((resolve) => {
        open = resolve;
    });
    return { promise, open };
}

async function holdRoute(page, path, held) {
    await page.route(`**/api/sillybunny-conversation/${path}`, async (route) => {
        await held.promise;
        await route.fallback();
    });
}

/** Opens a conversation as connected, with its chat read and the worker that writes by itself stopped. */
async function openConnected(page, avatar) {
    await page.evaluate(async (avatar) => {
        const { setOnlineStatus } = await import('/script.js');
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        const { stopConversationAutoWorker } = await import('/scripts/sillybunny-conversation/auto-engine.js');
        const { ensureConversationChatLoaded } = await import('/scripts/sillybunny-conversation/conversation-store.js');
        setOnlineStatus('Connected');
        await openConversationWorkspaceForAvatar(avatar, { showToast: false });
        await ensureConversationChatLoaded(avatar);
        stopConversationAutoWorker();
    }, avatar);
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-mode', 'on');
    await expect(page.locator(COMPOSER)).toBeEnabled();
}

/** The texts of the messages that the server holds for the conversation of the page's persona with these characters, or null when there is none. */
async function storedTexts(page, avatars) {
    return page.evaluate(async (avatars) => {
        const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
        await conversationData.flush();
        const { getRequestHeaders } = await import('/script.js');
        const { user_avatar: personaId } = await import('/scripts/personas.js');
        const post = async (path, body) => (await fetch(`/api/sillybunny-conversation${path}`, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) })).json();
        const { conversations } = await post('/list', {});
        const found = conversations.find(conversation => conversation.personaId === personaId && JSON.stringify(conversation.characters) === JSON.stringify(avatars));
        if (!found) {
            return null;
        }
        const { chat } = await post('/chat/get', { id: found.id, chatId: found.activeChatId });
        return chat.slice(1).map(record => record.mes);
    }, avatars);
}

/** Puts text in the composer as typing does, and sends the form as Enter and the Send button do. */
async function typeIntoComposer(page, text) {
    await page.locator(COMPOSER).fill(text);
}

async function submitForm(page) {
    await page.evaluate((selector) => document.querySelector(selector).requestSubmit(), FORM);
}

async function expectDrawn(page, name) {
    await expect(page.locator(HEADER_NAME)).toContainText(name);
    await expect(page.locator(COMPOSER)).toBeEnabled();
}

/** Selects a conversation as the list, the details window and a notification do. */
async function selectCharacter(page, namePattern) {
    await page.evaluate(async (source) => {
        const { selectConversation } = await import('/scripts/sillybunny-conversation/chrome.js');
        const character = window.SillyTavern.getContext().characters.find(entry => new RegExp(source).test(entry?.name ?? ''));
        await selectConversation(character.avatar, { showToast: false });
    }, namePattern);
}

async function bootWith(page, baseURL, seeds) {
    await bootConversationPage(page, baseURL);
    const avatars = await getCharacterAvatars(page);
    for (const key of seeds) {
        await seedConversation(page, { avatar: avatars[key], chats: [{ messages: [{ role: 'character', mes: `Hello from ${key}` }] }] });
    }
    return avatars;
}

test.describe('a switch to another conversation', () => {
    test('New Conversation: the composer of the open conversation is off from the pick, a send that reaches the form goes nowhere, and the draft stays with its conversation', async ({ page, baseURL }) => {
        const { seraphina, tewi } = await bootWith(page, baseURL, ['seraphina']);
        await openConnected(page, seraphina);
        const create = gate();
        await holdRoute(page, 'create', create);
        await typeIntoComposer(page, DRAFT);

        await page.locator(NEW_MENU).click();
        await page.getByRole('menuitem', { name: 'New Conversation', exact: true }).click();
        await page.locator(`${PICKER} .sb-picker__option`).filter({ hasText: 'Tewi' }).click();

        await expect(page.locator(COMPOSER)).toBeDisabled();
        await expect(page.locator(SEND)).toBeDisabled();
        await submitForm(page);
        expect(await storedTexts(page, [seraphina])).not.toContain(DRAFT);

        create.open();
        await expectDrawn(page, 'Tewi');
        expect(await storedTexts(page, [seraphina])).not.toContain(DRAFT);
        expect(await storedTexts(page, [tewi])).not.toContain(DRAFT);
        await expect(page.locator(COMPOSER)).toHaveValue('');

        await selectCharacter(page, 'Seraphina');
        await expectDrawn(page, 'Seraphina');
        await expect(page.locator(COMPOSER)).toHaveValue(DRAFT);
    });

    test('New Group: the composer of the open conversation is off from the click on Create Group', async ({ page, baseURL }) => {
        const { seraphina } = await bootWith(page, baseURL, ['seraphina']);
        await openConnected(page, seraphina);
        const create = gate();
        await holdRoute(page, 'create', create);

        await page.locator(NEW_MENU).click();
        await page.getByRole('menuitem', { name: 'New Group', exact: true }).click();
        const options = page.locator(`${PICKER} .sb-picker__option`);
        await options.nth(0).click();
        await options.nth(1).click();
        await page.getByRole('button', { name: 'Create Group', exact: true }).click();

        await expect(page.locator(COMPOSER)).toBeDisabled();
        await expect(page.locator(SEND)).toBeDisabled();
        create.open();
        await expect(page.locator(PICKER)).toHaveCount(0);
        await expect(page.locator(COMPOSER)).toBeEnabled();
    });

    for (const [name, call] of [
        ['Home (Recent Chats)', 'workspace'],
        ['the details window (Message on the profile page)', 'direct'],
    ]) {
        test(`${name}: opening a character that has no conversation yet turns the composer off until the conversation is made`, async ({ page, baseURL }) => {
            const { seraphina, tewi } = await bootWith(page, baseURL, ['seraphina']);
            await openConnected(page, seraphina);
            const create = gate();
            await holdRoute(page, 'create', create);

            await page.evaluate(async ({ call, tewi }) => {
                if (call === 'direct') {
                    const { openDirectConversationWith } = await import('/scripts/sillybunny-conversation/details/actions.js');
                    void openDirectConversationWith(tewi);
                    return;
                }
                const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
                void openConversationWorkspaceForAvatar(tewi, { showToast: false, enable: true });
            }, { call, tewi });
            await expect(page.locator(COMPOSER)).toBeDisabled();
            create.open();
            await expectDrawn(page, 'Tewi');
        });
    }

    for (const [name, kind] of [
        ['a list row', 'row'],
        ['a notification', 'notification'],
        ['Home (Recent Chats)', 'home'],
    ]) {
        test(`${name}: a send in the instant after the selection changed and before the new conversation is drawn goes nowhere, and the draft stays with its conversation`, async ({ page, baseURL }) => {
            const { seraphina, tewi } = await bootWith(page, baseURL, ['seraphina', 'tewi']);
            await openConnected(page, seraphina);
            await expect(rowNamed(page, 'Assistant Tewi')).toBeVisible();
            const chat = gate();
            await holdRoute(page, 'chat/get', chat);
            await typeIntoComposer(page, DRAFT);

            // One task: the selection has changed, and no frame has been drawn yet. Everything is imported first, because an import may yield to a frame.
            const state = await page.evaluate(async ({ kind, seraphina, tewi }) => {
                const { conversationState } = await import('/scripts/sillybunny-conversation/state.js');
                const { openConversationFromNotification } = await import('/scripts/sillybunny-conversation/notifications.js');
                const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
                const row = [...document.querySelectorAll('.sb-conversation-list-item')].find(item => /Tewi/.test(item.textContent));
                if (kind === 'row') {
                    row.click();
                } else if (kind === 'notification') {
                    void openConversationFromNotification(tewi);
                } else {
                    void openConversationWorkspaceForAvatar(tewi, { showToast: false });
                }
                for (let turn = 0; turn < 500 && conversationState.conversationSelectedAvatar !== tewi; turn++) {
                    await Promise.resolve();
                }
                const drawn = conversationState.lastRenderedConversationKey.split('\u001f')[1];
                document.getElementById('sb_conversation_form').requestSubmit();
                return { selected: conversationState.conversationSelectedAvatar === tewi, drawnIsStillTheOldOne: drawn === seraphina };
            }, { kind, seraphina, tewi });
            expect(state).toEqual({ selected: true, drawnIsStillTheOldOne: true });

            chat.open();
            await expectDrawn(page, 'Tewi');
            expect(await storedTexts(page, [seraphina])).not.toContain(DRAFT);
            expect(await storedTexts(page, [tewi])).not.toContain(DRAFT);
            await expect(page.locator(COMPOSER)).toHaveValue('');

            await rowNamed(page, 'Seraphina').click();
            await expectDrawn(page, 'Seraphina');
            await expect(page.locator(COMPOSER)).toHaveValue(DRAFT);
        });
    }

    test('an attachment stays with its conversation like the text of a draft', async ({ page, baseURL }) => {
        const { seraphina } = await bootWith(page, baseURL, ['seraphina', 'tewi']);
        await openConnected(page, seraphina);
        await expect(rowNamed(page, 'Assistant Tewi')).toBeVisible();
        await page.locator(FILE_INPUT).setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('a note') });
        await expect(page.locator(ATTACHMENT_PREVIEW)).toContainText('note.txt');

        await rowNamed(page, 'Assistant Tewi').click();
        await expectDrawn(page, 'Tewi');
        await expect(page.locator(ATTACHMENT_PREVIEW)).toBeHidden();
        expect(await page.locator(FILE_INPUT).evaluate(input => input.files.length)).toBe(0);

        await rowNamed(page, 'Seraphina').click();
        await expectDrawn(page, 'Seraphina');
        await expect(page.locator(ATTACHMENT_PREVIEW)).toContainText('note.txt');
        expect(await page.locator(FILE_INPUT).evaluate(input => input.files.length)).toBe(1);
    });

    test('a draft of a workspace that was closed does not go to the conversation that opens next, and is back when its own opens', async ({ page, baseURL }) => {
        const { seraphina, tewi } = await bootWith(page, baseURL, ['seraphina', 'tewi']);
        await openConnected(page, seraphina);
        await typeIntoComposer(page, DRAFT);

        await page.evaluate(async () => {
            const { disableConversationModeForCurrentCharacter } = await import('/scripts/sillybunny-conversation/chrome.js');
            disableConversationModeForCurrentCharacter({ focusRoleplay: false });
        });
        await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-conversation-mode', 'on');

        await openConnected(page, tewi);
        await expect(page.locator(COMPOSER)).toHaveValue('');

        await selectCharacter(page, 'Seraphina');
        await expectDrawn(page, 'Seraphina');
        await expect(page.locator(COMPOSER)).toHaveValue(DRAFT);
    });
});
