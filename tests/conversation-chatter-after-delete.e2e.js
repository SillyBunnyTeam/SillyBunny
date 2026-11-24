import { expect, test } from '@playwright/test';
import { waitForAppReady } from './helpers/app-ready.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { MockServer } from './util/mock-server.js';

// A `test.fail` below pins a defect that is not fixed yet. It passes while the defect exists and fails once the defect is
// fixed, which is the signal to delete the mark. The tests without a mark are controls: they prove that the harness can
// see the thing the pinned tests say must not happen, and they stay valid after the fix.
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 120_000 });

const NEW_MENU = '[data-sb-conversation-action="open-new-menu"]';
const CONVERSATION_MENU = '#sb_conversation_header [data-sb-conversation-action="open-conversation-menu"]';
const COMPOSER = '#sb_conversation_input';
const MEMBER_MESSAGES = '#sb_conversation_timeline .sb-conversation-message:not([data-role="user"]):not([data-role="system"])';
const ALL_MESSAGES = '#sb_conversation_timeline .sb-conversation-message';
const GROUP_ROWS = '.sb-conversation-list-item:not([data-group-id=""])';
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
        // A data root that other runs have used can hold conversations; the test starts from none.
        context.extensionSettings.sillybunny_conversation = {};
        return context.characters.filter(character => character.avatar).slice(0, 3).map(character => character.name);
    }, `http://127.0.0.1:${model.port}`);
    expect(names, 'the library has three characters for a group').toHaveLength(3);
    return names;
}

/**
 * Creates a group through the New Group picker and opens it.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} members Character names
 */
async function createGroup(page, members) {
    await page.evaluate(async () => {
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        openConversationWorkspaceForAvatar(null, { showToast: false });
    });
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-mode', 'on');
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

async function deleteHistory(page) {
    await page.locator(CONVERSATION_MENU).click();
    await page.getByRole('menuitem', { name: /Delete Conversation History/ }).click();
    const confirm = page.locator('dialog.sb-conversation-dialog[open]');
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.locator(ALL_MESSAGES)).toHaveCount(0);
}

/**
 * Opens the first group of the list the way a user does after the workspace closed: the Conversations workspace, then the
 * row. Deleting the history of the only conversation closes the workspace.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<boolean>} Whether the list has a group to open
 */
async function openFirstGroup(page) {
    await page.evaluate(async () => {
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        openConversationWorkspaceForAvatar(null, { showToast: false });
    });
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-mode', 'on');
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

test('a forced reply queued behind a user message is dropped by a deletion', async ({ page }) => {
    const members = await openApp(page);
    await createGroup(page, members);
    await sendAndWaitForAnswer(page, 'Anyone free this weekend?');
    const generations = await holdGenerations(page);
    try {
        await page.locator('#sb_conversation_form [data-sb-conversation-action="force-response"]').click();
        await expect.poll(() => generations.held.length, { message: 'the forced reply is being generated', timeout: 20_000 }).toBeGreaterThan(0);
        await deleteHistory(page);
        generations.release();
        await advance(page, 30_000, 5_000);

        expect(await memberMessagesWaitingInGroup(page), 'messages from members after the delete').toBe(0);
    } finally {
        generations.release();
    }
});

test.fail('after the history is deleted the members stay silent until the user writes again', async ({ page }) => {
    const members = await openApp(page);
    await createGroup(page, members);
    await sendAndWaitForAnswer(page, 'Anyone free this weekend?');
    await deleteHistory(page);

    const requestsBeforeDelay = model.prompts.length;
    await advance(page, 16 * MINUTE);

    expect(model.prompts.length - requestsBeforeDelay, 'requests to the model after the delete').toBe(0);
    expect(await memberMessagesWaitingInGroup(page), 'messages from members after the delete').toBe(0);
});

test.fail('a new group stays silent until the user writes the first message', async ({ page }) => {
    const members = await openApp(page);
    await createGroup(page, members);

    await advance(page, 16 * MINUTE);

    expect(model.prompts.length, 'requests to the model before the user wrote').toBe(0);
    expect(await memberMessagesWaitingInGroup(page), 'messages from members before the user wrote').toBe(0);
});

test.fail('Add Member keeps the group and its history instead of starting a second group', async ({ page }) => {
    const names = await openApp(page);
    await createGroup(page, names.slice(0, 2));
    await sendAndWaitForAnswer(page, 'Anyone free this weekend?');

    await page.locator(CONVERSATION_MENU).click();
    await page.getByRole('menuitem', { name: /Add Member/ }).click();
    const picker = page.locator('.sb-picker--multiple');
    await picker.getByRole('option', { name: names[2] }).click();
    await picker.getByRole('button', { name: 'Create Group' }).click();
    await expect(picker).toHaveCount(0);
    // The list and the open chat are redrawn on the clock's next frames.
    await advance(page, 5_000, 1_000);

    await expect(page.locator(GROUP_ROWS), 'groups in the list').toHaveCount(1);
    await expect(page.locator(ALL_MESSAGES).first(), 'the open group keeps its history').toContainText('Anyone free this weekend?');
});

test.fail('a reply that was being generated when the history was deleted is dropped', async ({ page }) => {
    const members = await openApp(page);
    await createGroup(page, members);
    await sendAndWaitForAnswer(page, 'Anyone free this weekend?');
    const generations = await holdGenerations(page);
    try {
        // The members start talking on their own after a pause; that request is held.
        await expect.poll(async () => {
            await page.clock.fastForward(30_000);
            return generations.held.length;
        }, { message: 'a member starts a message on its own', timeout: 60_000, intervals: [100] }).toBeGreaterThan(0);

        await deleteHistory(page);
        generations.release();
        await advance(page, 20_000, 5_000);

        expect(await memberMessagesWaitingInGroup(page), 'messages from members after the delete').toBe(0);
    } finally {
        generations.release();
    }
});

test.fail('a reminder set before the history was deleted does not fire into the emptied chat', async ({ page }) => {
    const members = await openApp(page);
    await createGroup(page, members);
    await sendAndWaitForAnswer(page, 'Anyone free this weekend?');
    await page.locator(COMPOSER).fill('/remind 10m | water the plants');
    await page.locator(COMPOSER).press('Enter');
    await deleteHistory(page);

    await advance(page, 12 * MINUTE);

    expect(model.prompts.some(prompt => prompt.includes('water the plants')), 'the reminder reached the model').toBe(false);
});

test.fail('a forced reply queued in an empty chat does not survive a deletion', async ({ page }) => {
    const members = await openApp(page);
    await createGroup(page, members);
    await sendAndWaitForAnswer(page, 'Anyone free this weekend?');
    // The empty chat has no user message for the queued reply to depend on.
    await deleteHistory(page);
    expect(await openFirstGroup(page), 'the emptied group can be opened again').toBe(true);
    const generations = await holdGenerations(page);
    try {
        await page.locator('#sb_conversation_form [data-sb-conversation-action="force-response"]').click();
        await expect.poll(() => generations.held.length, { message: 'the forced reply is being generated', timeout: 20_000 }).toBeGreaterThan(0);
        await deleteHistory(page);
        generations.release();
        await advance(page, 30_000, 5_000);

        expect(await memberMessagesWaitingInGroup(page), 'messages from members after the second delete').toBe(0);
    } finally {
        generations.release();
    }
});
