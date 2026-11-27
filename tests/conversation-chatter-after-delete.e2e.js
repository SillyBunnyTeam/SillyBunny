import { expect, test } from '@playwright/test';
import { waitForAppReady } from './helpers/app-ready.js';
import { shownPage } from './helpers/conversation-details.js';
import { resetConversations, seedConversation, uniquePersona } from './helpers/conversation-seed.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { MockServer } from './util/mock-server.js';

// A group must not keep talking after the user deletes its chat or the conversation, a new group must stay silent until
// the user writes, and Add Member must keep the group. Messaging first is off by default: with it off a group stays silent
// whatever the silence, and with it on a group writes once after the patience and no more than its maximum. The guards
// against a chat that was emptied or deleted are tested with the switch on, because with it off nothing is sent. The
// controls prove that the harness can see what the other tests say must not happen.
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 120_000 });

const NEW_MENU = '[data-sb-conversation-action="open-new-menu"]';
const CONVERSATION_MENU = '#sb_conversation_header [data-sb-conversation-action="open-conversation-menu"]';
const COMPOSER = '#sb_conversation_input';
const COMPOSER_MENU = '#sb_conversation_form [data-sb-conversation-action="open-composer-menu"]';
const MEMBER_MESSAGES = '#sb_conversation_timeline .sb-conversation-message:not([data-role="user"]):not([data-role="system"])';
const ALL_MESSAGES = '#sb_conversation_timeline .sb-conversation-message';
const GROUP_ROWS = '.sb-conversation-list-item:not([data-group-id=""])';
const DIRECT_ROWS = '.sb-conversation-list-item[data-group-id=""]';
const MINUTE = 60_000;

/** An OpenAI-compatible model that answers every request with a short line and keeps the prompts it was sent. */
class FakeModel extends MockServer {
    constructor() {
        super({ port: 0 });
        this.prompts = [];
    }

    handleChatCompletions(body) {
        this.prompts.push(JSON.stringify(body?.messages ?? []));
        return {
            choices: [{ finish_reason: 'stop', index: 0, message: { role: 'assistant', content: `Fake reply ${this.prompts.length}.` } }],
            created: 0,
            model: body?.model,
        };
    }
}

/** @type {FakeModel} */
let model;

test.beforeEach(async () => {
    model = new FakeModel();
    await model.start();
});

test.afterEach(async () => {
    await model.stop();
});

/**
 * Real time passes in small gaps between the steps of the fake clock, because the replies come over the network and are
 * not on the clock. A step is one worker interval, and `fastForward` fires each due timer once, so it is one worker tick.
 * @param {import('@playwright/test').Page} page
 * @param {number} totalMs Fake time to advance
 * @param {number} [stepMs]
 */
async function advance(page, totalMs, stepMs = 30_000) {
    for (let done = 0; done < totalMs; done += stepMs) {
        await page.clock.fastForward(Math.min(stepMs, totalMs - done));
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string[]>} Names of the first three characters of the library
 */
async function openApp(page) {
    await protectMaintainerServer(page);
    // The server's user is shared with the specs that run beside this one, so this page has a persona of its own.
    const persona = uniquePersona();
    await page.route('**/api/settings/get', async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        const settings = JSON.parse(data.settings);
        settings.user_avatar = persona;
        await route.fulfill({ response, json: { ...data, settings: JSON.stringify(settings) } });
    });
    await page.clock.install({ time: new Date() });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('preloader') === null, null, { timeout: 60_000 });
    await waitForAppReady(page);
    const names = await page.evaluate(async (base) => {
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
        const script = await import('/script.js');
        const { oai_settings } = await import('/scripts/openai.js');
        $('#main_api').val('openai').trigger('change');
        oai_settings.chat_completion_source = 'custom';
        oai_settings.custom_url = `${base}/v1`;
        oai_settings.custom_model = 'fake-model';
        oai_settings.stream_openai = false;
        script.setOnlineStatus('Valid');

        const context = window.SillyTavern.getContext();
        if (!context.characters.length) {
            await context.getCharacters();
        }
        return context.characters.filter(character => character.avatar).slice(0, 3).map(character => character.name);
    }, `http://127.0.0.1:${model.port}`);
    expect(names, 'the library has three characters for a group').toHaveLength(3);
    // A data root that other runs have used can hold conversations; the test starts from none.
    await resetConversations(page);
    return names;
}

/**
 * Turns messaging first on for the open group, with the shortest patience that the setting allows (15 minutes; a card's
 * talkativeness scales it from 7.5 to 22.5).
 * @param {import('@playwright/test').Page} page
 * @param {Record<string, unknown>} [settings] More settings of the conversation, such as `max_followups`
 */
async function turnMessagingFirstOn(page, settings = {}) {
    await page.evaluate(async (extra) => {
        const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
        const view = conversationData.list().find(item => item.kind === 'group');
        conversationData.patchConversation(view.id, { settings: { proactive_messaging: true, inactivity_threshold: 15, ...extra } });
        await conversationData.flush();
    }, settings);
}

/**
 * Creates a group through the New Group picker and opens it.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} members Character names
 */
async function createGroup(page, members) {
    await openWorkspace(page);
    await page.locator(NEW_MENU).click();
    await page.getByRole('menuitem', { name: 'New Group', exact: true }).click();
    const picker = page.locator('.sb-picker--multiple');
    await expect(picker).toBeVisible();
    for (const name of members) {
        await picker.getByRole('option', { name }).click();
    }
    await picker.getByRole('button', { name: 'Create Group' }).click();
    await expect(page.locator(COMPOSER)).toBeVisible();
    await expect(page.locator(GROUP_ROWS)).toHaveCount(1);
}

/**
 * Opens the Conversations workspace with no conversation chosen.
 * @param {import('@playwright/test').Page} page
 */
async function openWorkspace(page) {
    await page.evaluate(async () => {
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        openConversationWorkspaceForAvatar(null, { showToast: false });
    });
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-mode', 'on');
}

/**
 * Sends a message from the composer and moves the clock until a member has answered.
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 */
async function sendAndWaitForAnswer(page, text) {
    await page.locator(COMPOSER).fill(text);
    await page.locator(COMPOSER).press('Enter');
    await expect.poll(async () => {
        await page.clock.fastForward(3_000);
        return page.locator(MEMBER_MESSAGES).count();
    }, { message: 'a member answers the message', timeout: 60_000, intervals: [150] }).toBeGreaterThan(0);
    // A second member may be about to answer; let the replies finish before the test takes its baseline.
    await advance(page, 20_000, 5_000);
}

/**
 * Deletes the open chat through the header menu and its alert. The user stays in the conversation, in a new empty chat.
 * @param {import('@playwright/test').Page} page
 */
/** Forces a reply through the "+" menu of the composer. */
async function forceReply(page) {
    await page.locator(COMPOSER_MENU).click();
    await page.getByRole('menuitem', { name: 'Force a Reply' }).click();
}

async function deleteChat(page) {
    await page.locator(CONVERSATION_MENU).click();
    await page.getByRole('menuitem', { name: 'Delete Chat' }).click();
    const confirm = page.locator('dialog.sb-conversation-dialog[open]');
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.locator(ALL_MESSAGES)).toHaveCount(0);
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-mode', 'on');
    await expect(page.locator(COMPOSER)).toBeEnabled();
}

/**
 * Deletes the open conversation through the header menu and its alert. The user goes to the list, not Home.
 * @param {import('@playwright/test').Page} page
 */
async function deleteConversation(page) {
    await page.locator(CONVERSATION_MENU).click();
    await page.getByRole('menuitem', { name: /Delete Conversation/ }).click();
    const confirm = page.locator('dialog.sb-conversation-dialog[open]');
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-mode', 'on');
    await expect(page.locator(GROUP_ROWS)).toHaveCount(0);
    await expect(page.locator(ALL_MESSAGES)).toHaveCount(0);
}

/**
 * Opens the first group of the list the way a user does after the workspace closed: the Conversations workspace, then the
 * row.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<boolean>} Whether the list has a group to open
 */
async function openFirstGroup(page) {
    await openWorkspace(page);
    await advance(page, 2_000, 1_000);
    const row = page.locator(GROUP_ROWS).first();
    if (!await row.count()) {
        return false;
    }
    await row.click();
    await expect(row).toHaveAttribute('aria-current', 'true');
    await advance(page, 2_000, 1_000);
    return true;
}

/**
 * What the user finds when they come back to the group after waiting.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<number>} Messages from members in the group's chat, 0 when the list has no group
 */
async function memberMessagesWaitingInGroup(page) {
    return await openFirstGroup(page) ? page.locator(MEMBER_MESSAGES).count() : 0;
}

/**
 * Holds every generation request in the browser until `release()` is called, so that a test can act while a reply is
 * being generated.
 * @param {import('@playwright/test').Page} page
 */
async function holdGenerations(page) {
    const held = [];
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route('**/api/backends/chat-completions/generate', async (route) => {
        held.push(route.request().url());
        await gate;
        await route.continue().catch(() => {});
    });
    return { held, release };
}

/**
 * Moves the clock until a member starts a message on its own, which the held request shows.
 * @param {import('@playwright/test').Page} page
 * @param {{ held: string[] }} generations
 */
async function waitForMemberToStartTalking(page, generations) {
    await expect.poll(async () => {
        await page.clock.fastForward(30_000);
        return generations.held.length;
    }, { message: 'a member starts a message on its own', timeout: 60_000, intervals: [100] }).toBeGreaterThan(0);
}

test('the members answer a message from the user', async ({ page }) => {
    const members = await openApp(page);
    await createGroup(page, members);
    await sendAndWaitForAnswer(page, 'Anyone free this weekend?');
    await expect(page.locator(ALL_MESSAGES).first()).toContainText('Anyone free this weekend?');
    expect(model.prompts.length, 'the fake model was asked for the answer').toBeGreaterThan(0);
});

test('a reminder fires into its chat when the chat is left alone', async ({ page }) => {
    const members = await openApp(page);
    await createGroup(page, members);
    await sendAndWaitForAnswer(page, 'Anyone free this weekend?');
    await page.locator(COMPOSER).fill('/remind 10m | water the plants');
    await page.locator(COMPOSER).press('Enter');

    await expect.poll(async () => {
        await advance(page, MINUTE);
        return model.prompts.some(prompt => prompt.includes('water the plants'));
    }, { message: 'the reminder reaches the model', timeout: 60_000, intervals: [100] }).toBe(true);
});

test('a forced reply queued behind a user message is dropped by Delete Chat', async ({ page }) => {
    const members = await openApp(page);
    await createGroup(page, members);
    await sendAndWaitForAnswer(page, 'Anyone free this weekend?');
    const generations = await holdGenerations(page);
    try {
        await forceReply(page);
        await expect.poll(() => generations.held.length, { message: 'the forced reply is being generated', timeout: 20_000 }).toBeGreaterThan(0);
        await deleteChat(page);
        generations.release();
        await advance(page, 30_000, 5_000);

        expect(await memberMessagesWaitingInGroup(page), 'messages from members after the delete').toBe(0);
    } finally {
        generations.release();
    }
});

test('after Delete Chat the members stay silent until the user writes again, with messaging first on', async ({ page }) => {
    const members = await openApp(page);
    await createGroup(page, members);
    await turnMessagingFirstOn(page);
    await sendAndWaitForAnswer(page, 'Anyone free this weekend?');
    await deleteChat(page);

    const requestsBeforeDelay = model.prompts.length;
    await advance(page, 16 * MINUTE);

    expect(model.prompts.length - requestsBeforeDelay, 'requests to the model after the delete').toBe(0);
    expect(await memberMessagesWaitingInGroup(page), 'messages from members after the delete').toBe(0);
});

test('after Delete Conversation the list has no group and nothing asks the model, with messaging first on', async ({ page }) => {
    const members = await openApp(page);
    await createGroup(page, members);
    await turnMessagingFirstOn(page);
    await sendAndWaitForAnswer(page, 'Anyone free this weekend?');
    await deleteConversation(page);

    const requestsBeforeDelay = model.prompts.length;
    await advance(page, 16 * MINUTE);

    expect(model.prompts.length - requestsBeforeDelay, 'requests to the model after the delete').toBe(0);
    await expect(page.locator(GROUP_ROWS), 'groups in the list').toHaveCount(0);
});

test('a new group stays silent until the user writes the first message, with messaging first on', async ({ page }) => {
    const members = await openApp(page);
    await createGroup(page, members);
    await turnMessagingFirstOn(page);

    await advance(page, 16 * MINUTE);

    expect(model.prompts.length, 'requests to the model before the user wrote').toBe(0);
    expect(await memberMessagesWaitingInGroup(page), 'messages from members before the user wrote').toBe(0);
});

test('with messaging first off, which is the default, a group that the user wrote in stays silent after any silence', async ({ page }) => {
    const members = await openApp(page);
    await createGroup(page, members);
    await sendAndWaitForAnswer(page, 'Anyone free this weekend?');
    const requestsBefore = model.prompts.length;

    await advance(page, 12 * 60 * MINUTE, 15 * MINUTE);

    expect(model.prompts.length - requestsBefore, 'requests to the model while messaging first was off').toBe(0);
    expect(await memberMessagesWaitingInGroup(page), 'messages from members that the model did not write for the user').toBeLessThanOrEqual(requestsBefore);
});

test('with messaging first on, a group writes once after the patience and no more than its maximum', async ({ page }) => {
    const members = await openApp(page);
    await createGroup(page, members);
    await turnMessagingFirstOn(page, { max_followups: 2 });
    await sendAndWaitForAnswer(page, 'Anyone free this weekend?');
    const requestsBefore = model.prompts.length;

    // 7.5 minutes is the shortest patience that a card can give to the setting of 15.
    await advance(page, 6 * MINUTE);
    expect(model.prompts.length - requestsBefore, 'requests before any patience can have run out').toBe(0);

    let waited = 6 * MINUTE;
    await expect.poll(async () => {
        await advance(page, 2 * MINUTE, 2 * MINUTE);
        waited += 2 * MINUTE;
        return model.prompts.length - requestsBefore;
    }, { message: 'a message once the patience ran out', timeout: 60_000, intervals: [50] }).toBeGreaterThan(0);
    // The longest patience that a card can give is 22.5 minutes, and the next message waits twice as long as the first.
    expect(waited, 'minutes of silence before the first message').toBeLessThanOrEqual(24 * MINUTE);
    expect(model.prompts.length - requestsBefore, 'messages at that moment').toBe(1);

    await advance(page, 12 * 60 * MINUTE, 15 * MINUTE);
    expect(model.prompts.length - requestsBefore, 'messages after the user wrote: the maximum, and no more').toBe(2);
});

test('with messaging first on, the user writing again starts the count over', async ({ page }) => {
    const members = await openApp(page);
    await createGroup(page, members);
    await turnMessagingFirstOn(page, { max_followups: 1 });
    await sendAndWaitForAnswer(page, 'Anyone free this weekend?');
    const requestsBefore = model.prompts.length;
    await advance(page, 6 * 60 * MINUTE, 15 * MINUTE);
    expect(model.prompts.length - requestsBefore, 'one message of the maximum of one').toBe(1);

    await sendAndWaitForAnswer(page, 'Sorry, I was away. Saturday works.');
    const requestsAfterAnswer = model.prompts.length;
    await advance(page, 6 * 60 * MINUTE, 15 * MINUTE);

    expect(model.prompts.length - requestsAfterAnswer, 'one more message after the user wrote again').toBe(1);
});

test('a chat that has no message from the user stays silent although its record says that the user was active long ago', async ({ page }) => {
    const members = await openApp(page);
    await createGroup(page, members);
    await turnMessagingFirstOn(page);
    // What deleting the messages of a chat leaves behind: the time of the user's last activity and no message of the user.
    await page.evaluate(async () => {
        const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
        const view = conversationData.list().find(item => item.kind === 'group');
        conversationData.patchConversation(view.id, { chats: { [view.activeChatId]: { lastActivity: Date.now() - 10 * 60 * 60_000 } } });
        await conversationData.flush();
    });

    await advance(page, 2 * 60 * MINUTE, 15 * MINUTE);

    expect(model.prompts.length, 'requests to the model for a chat with no message from the user').toBe(0);
    expect(await memberMessagesWaitingInGroup(page), 'messages from members').toBe(0);
});

test('Add Member keeps the group and its history instead of starting a second group', async ({ page }) => {
    const names = await openApp(page);
    await createGroup(page, names.slice(0, 2));
    await sendAndWaitForAnswer(page, 'Anyone free this weekend?');

    await page.locator(CONVERSATION_MENU).click();
    await page.getByRole('menuitem', { name: 'Add Member' }).click();
    const picker = shownPage(page);
    await picker.getByRole('combobox', { name: 'Search Characters' }).fill(names[2]);
    await picker.getByRole('option', { name: names[2] }).click();
    await picker.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(shownPage(page).getByRole('listitem')).toHaveCount(3);
    await page.keyboard.press('Escape');
    // The list and the open chat are redrawn on the clock's next frames.
    await advance(page, 5_000, 1_000);

    await expect(page.locator(GROUP_ROWS), 'groups in the list').toHaveCount(1);
    await expect(page.locator(ALL_MESSAGES).first(), 'the open group keeps its history').toContainText('Anyone free this weekend?');
    const members = await page.evaluate(async () => {
        const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
        return conversationData.list().find(view => view.kind === 'group')?.characters.length;
    });
    expect(members, 'members of the group').toBe(3);
});

test('Add Member on a direct conversation starts a group and leaves the direct conversation as it is', async ({ page }) => {
    const names = await openApp(page);
    const avatars = await page.evaluate(wanted => window.SillyTavern.getContext().characters.filter(character => wanted.includes(character.name)).map(character => character.avatar), names.slice(0, 2));
    await seedConversation(page, { avatar: avatars[0], chats: [{ messages: [{ mes: 'Hello', role: 'character' }, { mes: 'Hi there', role: 'user' }] }] });
    await page.evaluate(async (avatar) => {
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        await openConversationWorkspaceForAvatar(avatar, { showToast: false });
    }, avatars[0]);
    await expect(page.locator(ALL_MESSAGES).first()).toContainText('Hello');

    await page.locator(CONVERSATION_MENU).click();
    await page.getByRole('menuitem', { name: 'Add Member' }).click();
    const picker = shownPage(page);
    await picker.getByRole('combobox', { name: 'Search Characters' }).fill(names[1]);
    await picker.getByRole('option', { name: names[1] }).click();
    await picker.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.locator('dialog.sb-dialog-host[open]:has(.sb-details-window)')).toHaveCount(0);
    await advance(page, 5_000, 1_000);

    await expect(page.locator(GROUP_ROWS), 'groups in the list').toHaveCount(1);
    await expect(page.locator(DIRECT_ROWS), 'direct conversations in the list').toHaveCount(1);
    const direct = await page.evaluate(async () => {
        const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
        const view = conversationData.list().find(item => item.kind === 'direct');
        return { characters: view.characters, messages: view.messageCount };
    });
    expect(direct.characters, 'the direct conversation keeps its character only').toHaveLength(1);
    expect(direct.messages, 'the direct conversation keeps its messages').toBe(2);
});

test('a reply that was being generated when the chat was deleted is dropped', async ({ page }) => {
    const members = await openApp(page);
    await createGroup(page, members);
    await turnMessagingFirstOn(page);
    await sendAndWaitForAnswer(page, 'Anyone free this weekend?');
    const generations = await holdGenerations(page);
    try {
        // The members start talking on their own after a pause; that request is held.
        await waitForMemberToStartTalking(page, generations);

        await deleteChat(page);
        generations.release();
        await advance(page, 20_000, 5_000);

        expect(await memberMessagesWaitingInGroup(page), 'messages from members after the delete').toBe(0);
    } finally {
        generations.release();
    }
});

test('a reply that was being generated when the conversation was deleted is dropped', async ({ page }) => {
    const members = await openApp(page);
    await createGroup(page, members);
    await turnMessagingFirstOn(page);
    await sendAndWaitForAnswer(page, 'Anyone free this weekend?');
    const generations = await holdGenerations(page);
    try {
        await waitForMemberToStartTalking(page, generations);

        await deleteConversation(page);
        generations.release();
        await advance(page, 20_000, 5_000);

        await expect(page.locator(GROUP_ROWS), 'groups in the list').toHaveCount(0);
        await expect(page.locator('.toast-error'), 'a reply for the deleted conversation was written and refused').toHaveCount(0);
    } finally {
        generations.release();
    }
});

test('a reminder set before Delete Chat does not fire into the new chat', async ({ page }) => {
    const members = await openApp(page);
    await createGroup(page, members);
    await sendAndWaitForAnswer(page, 'Anyone free this weekend?');
    await page.locator(COMPOSER).fill('/remind 10m | water the plants');
    await page.locator(COMPOSER).press('Enter');
    await deleteChat(page);

    await advance(page, 12 * MINUTE);

    expect(model.prompts.some(prompt => prompt.includes('water the plants')), 'the reminder reached the model').toBe(false);
});

test('a reminder set before Delete Conversation does not fire', async ({ page }) => {
    const members = await openApp(page);
    await createGroup(page, members);
    await sendAndWaitForAnswer(page, 'Anyone free this weekend?');
    await page.locator(COMPOSER).fill('/remind 10m | water the plants');
    await page.locator(COMPOSER).press('Enter');
    await deleteConversation(page);

    await advance(page, 12 * MINUTE);

    expect(model.prompts.some(prompt => prompt.includes('water the plants')), 'the reminder reached the model').toBe(false);
});

test('a forced reply queued in an empty chat does not survive Delete Chat', async ({ page }) => {
    const members = await openApp(page);
    await createGroup(page, members);
    await sendAndWaitForAnswer(page, 'Anyone free this weekend?');
    // The new chat has no user message for the queued reply to depend on.
    await deleteChat(page);
    const generations = await holdGenerations(page);
    try {
        await forceReply(page);
        await expect.poll(() => generations.held.length, { message: 'the forced reply is being generated', timeout: 20_000 }).toBeGreaterThan(0);
        await deleteChat(page);
        generations.release();
        await advance(page, 30_000, 5_000);

        expect(await memberMessagesWaitingInGroup(page), 'messages from members after the second delete').toBe(0);
    } finally {
        generations.release();
    }
});
