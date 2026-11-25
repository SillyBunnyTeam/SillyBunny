import { expect, test } from '@playwright/test';
import { callRoute, DETAILS_HOST, DETAILS_SURFACE, openDetails, openDetailsApp, openPreferences, readChatMemory, readCharacterState, readOpenConversation, readStored, seedAndOpen, shownPage, solidPng, withExtras } from './helpers/conversation-details.js';
import { showToasts } from './helpers/maintainer-server.js';

// The details window of a conversation: each page at the Dialog tier on a desktop, with every row saving as it changes. The
// phone's bottom sheet has its own describe below. The data that a page changes is read back from the server, not from the page.
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 120_000 });

const TALK = [
    { id: 'm-1', role: 'character', name: 'Character', mes: 'Good morning!' },
    { id: 'm-2', role: 'user', name: 'Tester', mes: 'Morning. Look at this.' },
    { id: 'm-3', role: 'character', name: 'Character', mes: 'Noon on Saturday, at the old oak.' },
];

const alertHost = page => page.locator('dialog.sb-dialog-host[open][data-tier="alert"]');

/** Waits for a setting of a conversation to reach the server, which a patch does after a short delay. */
async function expectSetting(page, conversationId, key, value) {
    await expect.poll(async () => (await readStored(page, conversationId))?.settings?.[key], { timeout: 10_000 }).toEqual(value);
}

test.describe('General and the people of a conversation', () => {
    test('General lists a group of three with its members and counts, and saves the Notifications choice per row', async ({ page }) => {
        const { avatars, names } = await openDetailsApp(page);
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0], members: [avatars[1], avatars[2]], name: 'Weekend plans', chats: [{ name: 'Main', messages: TALK }, { name: 'Second' }] });
        await openDetails(page, conversationId);

        const general = shownPage(page);
        await expect(general.locator('.sb-details-hero__name', { hasText: 'Weekend plans' })).toBeVisible();
        await expect(general.locator('.sb-details-avatar--tiled')).toHaveAttribute('data-count', '3');
        for (const avatar of avatars.slice(0, 3)) {
            await expect(general.getByRole('listitem', { name: names[avatar] })).toBeVisible();
            await expect(general.getByRole('button', { name: `Remove ${names[avatar]}` })).toBeVisible();
        }
        await expect(general.getByRole('button', { name: 'Add Member' })).toBeVisible();
        await expect(general.locator('[data-sb-editor-field="chats"] [data-sb-details-count]')).toHaveText('2');

        await general.getByRole('radio', { name: 'Muted' }).check();
        await expectSetting(page, conversationId, 'notifications_muted', true);
        await general.getByRole('radio', { name: 'All' }).check();
        await expectSetting(page, conversationId, 'notifications_muted', undefined);
    });

    test('a member is removed at once and comes back with Undo; the second-to-last member asks first and converts the group', async ({ page }) => {
        const { avatars, names } = await openDetailsApp(page);
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0], members: [avatars[1], avatars[2]], name: 'Weekend plans', chats: [{ name: 'Main', messages: TALK }] });
        await showToasts(page);
        await openDetails(page, conversationId);
        const general = shownPage(page);

        await general.getByRole('button', { name: `Remove ${names[avatars[2]]}` }).click();
        await expect(general.getByRole('listitem')).toHaveCount(2);
        expect((await readStored(page, conversationId)).characters, 'the member is out of the group').toEqual([avatars[0], avatars[1]]);
        await page.getByRole('button', { name: 'Undo' }).click();
        await expect(general.getByRole('listitem')).toHaveCount(3);
        expect((await readStored(page, conversationId)).characters).toEqual([avatars[0], avatars[1], avatars[2]]);

        await general.getByRole('button', { name: `Remove ${names[avatars[2]]}` }).click();
        await expect(general.getByRole('listitem')).toHaveCount(2);
        await general.getByRole('button', { name: `Remove ${names[avatars[1]]}` }).click();
        await expect(alertHost(page).locator('[data-sb-copy-placeholder="true"]')).toHaveCount(1);
        await alertHost(page).getByRole('button', { name: 'Cancel' }).click();
        expect((await readStored(page, conversationId)).kind, 'cancelling leaves the group').toBe('group');

        await general.getByRole('button', { name: `Remove ${names[avatars[1]]}` }).click();
        await alertHost(page).getByRole('button', { name: 'Remove', exact: true }).click();

        await expect(shownPage(page).locator('.sb-details-hero__name', { hasText: names[avatars[0]] })).toBeVisible();
        expect((await callRoute(page, '/get', { id: conversationId })).status, 'the group is gone').toBe(404);
        await expect.poll(async () => (await readOpenConversation(page))?.kind).toBe('direct');
        const open = await readOpenConversation(page);
        expect(open.characters).toEqual([avatars[0]]);
        const stored = await readStored(page, open.id);
        expect(stored.chats.map(chat => chat.name), 'the chats of the group come over, named after it').toContain('Weekend plans');
    });

    test('a bigger group lists its members on the Members page, and the people of a direct conversation are its extras', async ({ page }) => {
        const { avatars, names } = await openDetailsApp(page);
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0], members: [avatars[1], avatars[2]], name: 'Weekend plans' });
        await openDetails(page, conversationId, { page: 'members' });

        const members = shownPage(page);
        await expect(members.locator('.sb-dialog__title, h2').first()).toContainText('Members');
        await expect(members.getByRole('list', { name: 'Members' }).getByRole('listitem')).toHaveCount(3);
        await expect(members.getByRole('button', { name: 'Add Member' })).toBeVisible();
        await members.getByRole('listitem', { name: names[avatars[1]] }).click();
        await expect(shownPage(page).locator('.sb-details-hero__name', { hasText: names[avatars[1]] })).toBeVisible();
    });

    test('Extras are listed on their own page, removable only, and the removal is confirmed', async ({ page }) => {
        const { avatars, names } = await openDetailsApp(page);
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0], name: '' });
        const removed = [];
        let direct = null;
        // The conversation routes cannot make extras (only the migration does), so the page is given a direct conversation that has one.
        const withExtra = conversation => withExtras(conversation, conversationId, removed.length ? [] : [avatars[1]]);
        await page.route('**/api/sillybunny-conversation/**', async (route) => {
            const path = new URL(route.request().url()).pathname.replace('/api/sillybunny-conversation', '');
            if (path === '/extras/remove') {
                removed.push(route.request().postDataJSON().avatar);
                return route.fulfill({ json: { conversation: withExtra(direct) } });
            }
            if (path === '/list' || path === '/get') {
                const response = await route.fetch();
                const json = await response.json();
                direct = json.conversations?.find(item => item.id === conversationId) ?? (json.conversation?.id === conversationId ? json.conversation : direct);
                return route.fulfill({ response, json: json.conversations ? { ...json, conversations: json.conversations.map(withExtra) } : { ...json, conversation: withExtra(json.conversation) } });
            }
            return route.fallback();
        });
        await page.evaluate(async () => (await import('/scripts/sillybunny-conversation/conversation-data-browser.js')).conversationData.refresh());
        await openDetails(page, conversationId);

        const general = shownPage(page);
        await expect(general.getByRole('button', { name: /^Extras/ })).toContainText('1');
        await general.getByRole('button', { name: /^Extras/ }).click();
        const extras = shownPage(page);
        await expect(extras.getByRole('list', { name: 'Extras' }).getByRole('listitem')).toHaveCount(1);
        await expect(extras.getByRole('button', { name: 'Add Member' })).toHaveCount(0);
        await expect(extras.locator('[data-sb-copy-placeholder="true"]')).toHaveCount(1);

        await extras.getByRole('button', { name: `Remove ${names[avatars[1]]}` }).click();
        await alertHost(page).getByRole('button', { name: 'Cancel' }).click();
        expect(removed, 'cancelling removes nothing').toEqual([]);
        await extras.getByRole('button', { name: `Remove ${names[avatars[1]]}` }).click();
        await alertHost(page).getByRole('button', { name: 'Remove', exact: true }).click();
        await expect.poll(() => removed).toEqual([avatars[1]]);
        await expect(shownPage(page).locator('.sb-details-hero__name', { hasText: names[avatars[0]] })).toBeVisible();
    });
});

test.describe('Edit Details and Add Member', () => {
    test('Edit Details saves the name, the description and the picture of a group on Save, and nothing on Cancel', async ({ page }) => {
        const { avatars } = await openDetailsApp(page);
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0], members: [avatars[1], avatars[2]], name: 'Weekend plans' });
        await openDetails(page, conversationId);

        await shownPage(page).getByRole('button', { name: 'Edit Details' }).click();
        await shownPage(page).getByRole('textbox', { name: 'Name' }).fill('Not saved');
        await shownPage(page).getByRole('button', { name: 'Cancel' }).click();
        await expect(shownPage(page).locator('.sb-details-hero__name', { hasText: 'Weekend plans' })).toBeVisible();
        expect((await readStored(page, conversationId)).name).toBe('Weekend plans');

        await shownPage(page).getByRole('button', { name: 'Edit Details' }).click();
        await shownPage(page).getByRole('textbox', { name: 'Name' }).fill('Picnic crew');
        await shownPage(page).getByRole('textbox', { name: 'Description' }).fill('Planning the picnic');
        const [chooser] = await Promise.all([
            page.waitForEvent('filechooser'),
            shownPage(page).getByRole('button', { name: 'Select New Picture' }).click(),
        ]);
        await chooser.setFiles({ name: 'crew.png', mimeType: 'image/png', buffer: solidPng() });
        await expect(shownPage(page).locator('.sb-details-editable-avatar img'), 'the chosen picture replaces the tiles').toHaveCount(1);
        await shownPage(page).getByRole('button', { name: 'Save' }).click();

        await expect(shownPage(page).locator('.sb-details-hero__name', { hasText: 'Picnic crew' })).toBeVisible();
        await expect(shownPage(page).locator('.sb-details-hero__subtitle')).toHaveText('Planning the picnic');
        await expect.poll(async () => (await readStored(page, conversationId)).avatar).not.toBe('');
        const stored = await readStored(page, conversationId);
        expect([stored.name, stored.description]).toEqual(['Picnic crew', 'Planning the picnic']);
        await expect(shownPage(page).locator('.sb-details-hero img[src*="/api/sillybunny-conversation/avatar"]')).toBeVisible();

        await shownPage(page).getByRole('button', { name: 'Edit Details' }).click();
        await shownPage(page).getByRole('button', { name: 'Remove Picture' }).click();
        await shownPage(page).getByRole('button', { name: 'Save' }).click();
        await expect.poll(async () => (await readStored(page, conversationId)).avatar).toBe('');
        await expect(shownPage(page).locator('.sb-details-avatar--tiled')).toBeVisible();
    });

    test('Add Member puts the characters that are ticked in the group, and starts a group from a direct conversation', async ({ page }) => {
        const { avatars, names } = await openDetailsApp(page);
        const group = await seedAndOpen(page, { avatar: avatars[0], members: [avatars[2]], name: 'Study group' });
        await openDetails(page, group.conversationId);

        await shownPage(page).getByRole('button', { name: 'Add Member' }).click();
        const picker = shownPage(page);
        await expect(picker.getByRole('checkbox')).toHaveCount(avatars.length - 2);
        await expect(picker.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
        await picker.getByRole('searchbox', { name: 'Search Characters' }).fill('zzz');
        await expect(picker.getByText('No Results Found')).toBeVisible();
        await picker.getByRole('searchbox', { name: 'Search Characters' }).fill('');
        await picker.getByRole('checkbox', { name: names[avatars[1]] }).check();
        await picker.getByRole('button', { name: 'Add', exact: true }).click();
        await expect.poll(async () => (await readStored(page, group.conversationId)).characters).toEqual([avatars[0], avatars[2], avatars[1]]);
        await expect(shownPage(page).getByRole('listitem')).toHaveCount(3);
        await page.keyboard.press('Escape');

        const direct = await seedAndOpen(page, { avatar: avatars[1] });
        await openDetails(page, direct.conversationId, { page: 'add-member' });
        const startPicker = shownPage(page);
        await startPicker.getByRole('checkbox', { name: names[avatars[2]] }).check();
        await startPicker.getByRole('button', { name: 'Add', exact: true }).click();
        await expect(page.locator(DETAILS_HOST)).toHaveCount(0);
        await expect.poll(async () => (await readOpenConversation(page))?.kind).toBe('group');
        expect((await readOpenConversation(page)).characters).toEqual([avatars[1], avatars[2]]);
        expect((await readStored(page, direct.conversationId)).kind, 'the direct conversation stays').toBe('direct');
    });
});

test.describe('The profile of a character', () => {
    test('the profile sets the status override, and edits and switches the routine, each saved at once', async ({ page }) => {
        const { avatars, names } = await openDetailsApp(page);
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0], members: [avatars[1], avatars[2]], name: 'Weekend plans' });
        const target = avatars[1];
        const routine = JSON.stringify({ days: { 1: [{ time: '09:00-17:00', activity: 'working at the shop', status: 'dnd' }], 0: [], 2: [], 3: [], 4: [], 5: [], 6: [] } });
        expect((await callRoute(page, '/characters/update', { avatar: target, patch: { routine: { enabled: true, text: routine, generatedAt: 1 } } })).status).toBe(200);
        await page.evaluate(async () => (await import('/scripts/sillybunny-conversation/conversation-data-browser.js')).conversationData.refresh());
        await openDetails(page, conversationId);

        await shownPage(page).getByRole('listitem', { name: names[target] }).click();
        const profile = shownPage(page);
        await expect(profile.locator('.sb-details-hero__name', { hasText: names[target] })).toBeVisible();
        await expect(profile.getByRole('button', { name: 'Open Conversation' })).toBeVisible();

        await profile.getByRole('combobox', { name: 'Status' }).selectOption('idle');
        await expect.poll(async () => (await readCharacterState(page, target)).statusOverride).toBe('idle');
        await expect(profile.locator('.sb-details-hero__subtitle')).toContainText('Idle');
        await profile.getByRole('combobox', { name: 'Status' }).selectOption('auto');
        await expect.poll(async () => (await readCharacterState(page, target)).statusOverride).toBeUndefined();

        const text = profile.getByRole('textbox', { name: 'Routine' });
        await expect(text).toHaveValue('Monday\n09:00-17:00 working at the shop (dnd)');
        await text.fill('Monday\n10:00-12:00 painting (online)\n\nTuesday\n08:00-09:00 jogging');
        await text.blur();
        await expect.poll(async () => JSON.parse((await readCharacterState(page, target)).routine.text).days[1]).toEqual([{ time: '10:00-12:00', activity: 'painting', status: 'online' }]);
        await text.fill('work all day');
        await text.blur();
        await expect(profile.getByText(/Line 1 is not a block/)).toBeVisible();
        expect(JSON.parse((await readCharacterState(page, target)).routine.text).days[1][0].activity, 'a text that is no schedule is not saved').toBe('painting');

        await profile.getByRole('switch', { name: 'Daily Routine' }).uncheck();
        await expect.poll(async () => (await readCharacterState(page, target)).routine.enabled).toBe(false);
        await expect(profile.getByRole('textbox', { name: 'Routine' })).toBeHidden();
    });

    test('the picture opens as a page of the window, and Open Conversation opens the direct conversation of the member', async ({ page }) => {
        const { avatars, names } = await openDetailsApp(page);
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0], members: [avatars[1], avatars[2]], name: 'Weekend plans' });
        await openDetails(page, conversationId, { page: 'profile', avatar: avatars[1] });

        await shownPage(page).getByRole('button', { name: `Show Full Picture for ${names[avatars[1]]}` }).click();
        await expect(shownPage(page).locator('.sb-details-picture img')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(shownPage(page).locator('.sb-details-hero__name', { hasText: names[avatars[1]] })).toBeVisible();

        await shownPage(page).getByRole('button', { name: 'Open Conversation' }).click();
        await expect(page.locator(DETAILS_HOST)).toHaveCount(0);
        await expect.poll(async () => (await readOpenConversation(page))?.characters).toEqual([avatars[1]]);
        expect((await readOpenConversation(page)).kind).toBe('direct');
    });

    test('Edit Talkativeness in the Character opens the editor at the slider of the card', async ({ page }) => {
        const { avatars } = await openDetailsApp(page);
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0] });
        await openDetails(page, conversationId, { page: 'profile', avatar: avatars[0] });

        await expect(shownPage(page).locator('[data-sb-editor-field="character-talkativeness"]')).toContainText('0.50');
        await shownPage(page).getByRole('button', { name: 'Edit Talkativeness in the Character' }).click();
        await expect(page.locator(DETAILS_HOST)).toHaveCount(0);
        await expect(page.locator('#talkativeness_slider')).toBeVisible({ timeout: 15_000 });
    });
});

test.describe('Chats', () => {
    test('the Chats page marks the open chat, opens another, renames, exports, deletes, and starts a new one', async ({ page }) => {
        const { avatars } = await openDetailsApp(page);
        const { conversationId, chatIds } = await seedAndOpen(page, { avatar: avatars[0], chats: [{ name: 'Main', messages: TALK }, { name: 'Second', messages: TALK.slice(0, 2) }] });
        await openDetails(page, conversationId, { page: 'chats' });

        const chats = shownPage(page).getByRole('list', { name: 'Chats' });
        await expect(chats.getByRole('listitem')).toHaveCount(2);
        await expect(chats.getByRole('listitem', { name: 'Main' })).toHaveAttribute('aria-current', 'true');
        await expect(chats.getByRole('listitem', { name: 'Second' })).not.toHaveAttribute('aria-current', 'true');

        await chats.getByRole('button', { name: 'Actions for Second' }).click();
        await page.getByRole('menuitem', { name: 'Rename…' }).click();
        await page.getByRole('textbox').last().fill('Weekend');
        await page.getByRole('button', { name: 'Rename', exact: true }).click();
        await expect(chats.getByRole('listitem', { name: 'Weekend' })).toBeVisible();
        await expect.poll(async () => (await readStored(page, conversationId)).chats.map(chat => chat.name)).toEqual(['Main', 'Weekend']);

        await chats.getByRole('button', { name: 'Actions for Weekend' }).click();
        const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export' }).click()]);
        expect(download.suggestedFilename()).toBe('Weekend.jsonl');

        await shownPage(page).getByRole('button', { name: 'New Chat' }).click();
        await expect(chats.getByRole('listitem')).toHaveCount(3);
        await expect.poll(async () => (await readStored(page, conversationId)).chats.length).toBe(3);
        const afterNew = await readStored(page, conversationId);
        expect(afterNew.activeChatId, 'the new chat is the open one').not.toBe(chatIds[0]);
        await expect(chats.locator('[aria-current="true"]')).toHaveCount(1);

        await chats.getByRole('button', { name: 'Actions for Weekend' }).click();
        await page.getByRole('menuitem', { name: 'Delete…' }).click();
        await page.locator('dialog.sb-conversation-dialog[open]').getByRole('button', { name: 'Delete', exact: true }).click();
        await expect(chats.getByRole('listitem')).toHaveCount(2);

        await chats.getByRole('listitem', { name: 'Main' }).click();
        await expect(page.locator(DETAILS_HOST)).toHaveCount(0);
        await expect.poll(async () => (await readStored(page, conversationId)).activeChatId).toBe(chatIds[0]);
        await expect(page.locator('#sb_conversation_timeline .sb-conversation-message')).toHaveCount(TALK.length);
    });
});

test.describe('Media, Files and Pinned', () => {
    const SHARED = [
        { id: 's-1', role: 'character', name: 'Character', mes: 'Here is the map.', extra: { media: [{ url: '/img/logo.png', type: 'image', title: 'map.png' }] } },
        { id: 's-2', role: 'user', name: 'Tester', mes: 'Thanks, and the notes.', extra: { files: [{ url: 'data:text/plain;base64,aGVsbG8=', name: 'notes.txt', size: 1200 }] } },
        { id: 's-3', role: 'character', name: 'Character', mes: 'Noon on Saturday, at the old oak.', extra: { conversation_pinned: true } },
    ];

    test('Media opens a picture as a page of the window, and Files downloads a file', async ({ page }) => {
        const { avatars } = await openDetailsApp(page);
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0], chats: [{ name: 'Main', messages: SHARED }] });
        await openDetails(page, conversationId);

        await expect(shownPage(page).locator('[data-sb-editor-field="media"] [data-sb-details-count]')).toHaveText('1');
        await expect(shownPage(page).locator('[data-sb-editor-field="files"] [data-sb-details-count]')).toHaveText('1');
        await expect(shownPage(page).locator('[data-sb-editor-field="pinned"] [data-sb-details-count]')).toHaveText('1');

        await shownPage(page).getByRole('button', { name: /^Media/ }).click();
        const media = shownPage(page);
        await expect(media.getByRole('listitem')).toHaveCount(1);
        await media.getByRole('listitem').click();
        await expect(shownPage(page).locator('.sb-details-picture img')).toBeVisible();
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');

        await shownPage(page).getByRole('button', { name: /^Files/ }).click();
        const [download] = await Promise.all([page.waitForEvent('download'), shownPage(page).getByRole('listitem', { name: 'notes.txt' }).click()]);
        expect(download.suggestedFilename()).toBe('notes.txt');
    });

    test('Pinned shows a message in the chat, and Unpin offers Undo', async ({ page }) => {
        const { avatars } = await openDetailsApp(page);
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0], chats: [{ name: 'Main', messages: SHARED }] });
        await showToasts(page);
        await openDetails(page, conversationId, { page: 'pinned' });

        const pinned = shownPage(page).getByRole('list', { name: 'Pinned Messages' });
        await expect(pinned.getByRole('listitem')).toContainText('Noon on Saturday, at the old oak.');
        await pinned.getByRole('button', { name: /^Pinned Message Actions/ }).click();
        await page.getByRole('menuitem', { name: 'Unpin' }).click();
        await expect(shownPage(page).getByText('No Pinned Messages')).toBeVisible();
        await page.getByRole('button', { name: 'Undo' }).click();
        await expect(pinned.getByRole('listitem')).toHaveCount(1);

        await pinned.getByRole('listitem').click();
        await expect(page.locator(DETAILS_HOST)).toHaveCount(0);
        await expect(page.locator('#sb_conversation_timeline .sb-conversation-message[data-message-id="s-3"]')).toBeInViewport();
    });

    test('a chat that shares nothing shows an empty page for each', async ({ page }) => {
        const { avatars } = await openDetailsApp(page);
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0], chats: [{ name: 'Main', messages: TALK }] });
        for (const [name, title] of [['media', 'No Media'], ['files', 'No Files'], ['pinned', 'No Pinned Messages']]) {
            await openDetails(page, conversationId, { page: name });
            await expect(shownPage(page).getByText(title)).toBeVisible();
            await page.keyboard.press('Escape');
            await page.keyboard.press('Escape');
            await expect(page.locator(DETAILS_HOST)).toHaveCount(0);
        }
    });
});

test.describe('Behaviour and Advanced', () => {
    test('Behaviour saves messaging first, patience and the images group per row, and clears a key that returns to its default', async ({ page }) => {
        const { avatars } = await openDetailsApp(page);
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0], chats: [{ name: 'Main', messages: TALK }] });
        await openDetails(page, conversationId, { page: 'behaviour' });
        const behaviour = shownPage(page);

        const patience = behaviour.getByRole('spinbutton', { name: 'Patience (Mins)' });
        await expect(patience).toBeDisabled();
        await expect(behaviour.locator('[data-sb-copy-placeholder="true"]')).toHaveCount(1);
        await behaviour.getByRole('switch', { name: 'Messaging First' }).check();
        await expect(patience).toBeEnabled();
        await expectSetting(page, conversationId, 'proactive_messaging', true);

        await patience.fill('30');
        await patience.blur();
        await expectSetting(page, conversationId, 'inactivity_threshold', 30);
        await patience.fill('120');
        await patience.blur();
        await expectSetting(page, conversationId, 'inactivity_threshold', undefined);
        await behaviour.getByRole('spinbutton', { name: 'Max Unanswered' }).fill('2');
        await behaviour.getByRole('spinbutton', { name: 'Max Unanswered' }).blur();
        await expectSetting(page, conversationId, 'max_followups', 2);

        await behaviour.getByRole('switch', { name: 'Generate Images' }).check();
        await expectSetting(page, conversationId, 'image_gen_enabled', true);
        await behaviour.getByRole('textbox', { name: 'Negative Prompt' }).fill('blurry');
        await behaviour.getByRole('textbox', { name: 'Negative Prompt' }).blur();
        await expectSetting(page, conversationId, 'image_gen_negative', 'blurry');
        await behaviour.getByRole('switch', { name: 'Messaging First' }).uncheck();
        await expect(patience).toBeDisabled();
        await expectSetting(page, conversationId, 'proactive_messaging', undefined);
    });

    test('Behaviour lists the reminders that wait and the ones that gave up, and cancels one with Undo', async ({ page }) => {
        const { avatars } = await openDetailsApp(page);
        const { conversationId, chatIds } = await seedAndOpen(page, { avatar: avatars[0], chats: [{ name: 'Main', messages: TALK }] });
        const base = Date.now() + 3_600_000;
        const reminder = (id, text, extra) => ({ id, avatar: avatars[0], chatId: chatIds[0], text, triggerAt: base, createdAt: Date.now(), fired: false, ...extra });
        const patch = { reminders: [reminder('rem_wait', 'Call Ada', {}), reminder('rem_done', 'Already sent', { fired: true, firedAt: 1 }), reminder('rem_fail', 'Water the plants', { attempts: 5, skippedAt: 1, triggerAt: base - 1000 })] };
        expect((await callRoute(page, '/update', { id: conversationId, patch })).status).toBe(200);
        await page.evaluate(async () => (await import('/scripts/sillybunny-conversation/conversation-data-browser.js')).conversationData.refresh());
        await showToasts(page);
        await openDetails(page, conversationId, { page: 'behaviour' });

        const behaviour = shownPage(page);
        const group = behaviour.locator('[data-sb-editor-field="reminders"]');
        await expect(group.getByText('Call Ada')).toBeVisible();
        await expect(group.getByText('Water the plants')).toBeVisible();
        await expect(group.getByText('Could not be delivered')).toBeVisible();
        await expect(group.getByText('Already sent')).toHaveCount(0);

        await behaviour.getByRole('button', { name: 'Cancel Reminder: Call Ada' }).click();
        await expect(group.getByText('Call Ada')).toHaveCount(0);
        await expect.poll(async () => (await readStored(page, conversationId)).reminders.map(item => item.id)).toEqual(['rem_done', 'rem_fail']);
        await page.getByRole('button', { name: 'Undo' }).click();
        await expect(group.getByText('Call Ada')).toBeVisible();
        await expect.poll(async () => (await readStored(page, conversationId)).reminders.map(item => item.id).sort()).toEqual(['rem_done', 'rem_fail', 'rem_wait']);
    });

    test('Advanced saves the prompt under its stored name, resets it, and writes and clears the memory of the open chat', async ({ page }) => {
        const { avatars } = await openDetailsApp(page);
        const { conversationId, chatIds } = await seedAndOpen(page, { avatar: avatars[0], chats: [{ name: 'Main', messages: TALK }] });
        await openDetails(page, conversationId, { page: 'advanced' });
        const advanced = shownPage(page);

        const prompt = advanced.getByRole('textbox', { name: 'System Prompt' });
        await prompt.fill('Answer in one short line.');
        await prompt.blur();
        await expectSetting(page, conversationId, 'system_prompt', 'Answer in one short line.');
        await advanced.getByRole('button', { name: 'Reset to Default' }).click();
        await expectSetting(page, conversationId, 'system_prompt', undefined);
        await expect(prompt).not.toHaveValue('Answer in one short line.');

        await advanced.getByRole('textbox', { name: 'Author’s Note' }).fill('Keep it brief.');
        await advanced.getByRole('textbox', { name: 'Author’s Note' }).blur();
        await expectSetting(page, conversationId, 'authors_note', 'Keep it brief.');
        await advanced.getByRole('switch', { name: 'Prose Polisher' }).check();
        await expectSetting(page, conversationId, 'prose_polisher', true);
        await advanced.getByRole('switch', { name: 'Remember Groups Here' }).check();
        await expectSetting(page, conversationId, 'include_related_memory', true);

        const readMemory = () => readChatMemory(page, conversationId, chatIds[0]);
        await advanced.getByRole('button', { name: 'Create Memory' }).click();
        await page.locator('dialog.sb-conversation-dialog[open]').getByRole('textbox').fill('They plan a picnic.');
        await page.locator('dialog.sb-conversation-dialog[open]').getByRole('button', { name: 'Save', exact: true }).click();
        await expect(advanced.getByRole('textbox', { name: 'Conversation Memory' })).toHaveValue('They plan a picnic.');
        await expect.poll(readMemory).toBe('They plan a picnic.');

        await advanced.getByRole('button', { name: 'Clear Memory' }).click();
        await page.locator('dialog.sb-conversation-dialog[open]').getByRole('button', { name: 'Clear', exact: true }).click();
        await expect(advanced.getByRole('textbox', { name: 'Conversation Memory' })).toHaveValue('');
        await expect.poll(readMemory).toBe('');
    });
});

test.describe('Preferences', () => {
    const readModeSettings = page => page.evaluate(async () => {
        const { getConversationStore } = await import('/scripts/sillybunny-conversation/context.js');
        return { ...getConversationStore().settings, userPersonaStatus: getConversationStore().userPersonaStatus };
    });

    test('Preferences saves the mode-wide rows as they change, refuses a time that is not on the clock, and edits the grounded rules on a page', async ({ page }) => {
        await openDetailsApp(page);
        await openPreferences(page);
        const preferences = shownPage(page);
        await expect(preferences.getByRole('button', { name: 'Back' })).toHaveCount(0);

        await preferences.getByRole('switch', { name: 'Simulate Reply Delay' }).uncheck();
        await expect.poll(async () => (await readModeSettings(page)).simulate_reply_delay).toBe(false);

        await preferences.getByRole('textbox', { name: 'Quiet Hours Start' }).fill('25:00');
        await preferences.getByRole('textbox', { name: 'Quiet Hours Start' }).blur();
        await expect(preferences.getByText(/24-hour clock/)).toBeVisible();
        expect((await readModeSettings(page)).quiet_hours_start ?? '', 'a time that is not on the clock is not saved').toBe('');
        await preferences.getByRole('textbox', { name: 'Quiet Hours Start' }).fill('22:00');
        await preferences.getByRole('textbox', { name: 'Quiet Hours Start' }).blur();
        await preferences.getByRole('textbox', { name: 'Quiet Hours End' }).fill('7:00');
        await preferences.getByRole('textbox', { name: 'Quiet Hours End' }).blur();
        await expect.poll(async () => { const settings = await readModeSettings(page); return [settings.quiet_hours_start, settings.quiet_hours_end]; }).toEqual(['22:00', '07:00']);

        await preferences.getByRole('textbox', { name: 'Status Message' }).fill('Out for a walk');
        await preferences.getByRole('textbox', { name: 'Status Message' }).blur();
        await expect.poll(async () => (await readModeSettings(page)).userPersonaStatus).toBe('Out for a walk');

        const edit = preferences.getByRole('button', { name: 'Edit Grounded Dialogue Rules' });
        await expect(edit).toBeDisabled();
        await preferences.getByRole('switch', { name: 'Grounded Dialogue Rules' }).check();
        await expect(edit).toBeEnabled();
        await edit.click();
        const rules = shownPage(page);
        await rules.getByRole('textbox', { name: 'Grounded Dialogue Rules' }).fill('Never use clichés.');
        await rules.getByRole('button', { name: 'Cancel' }).click();
        expect((await readModeSettings(page)).grounded_dialogue_rules, 'Cancel keeps the rules').not.toBe('Never use clichés.');
        await edit.click();
        await shownPage(page).getByRole('textbox', { name: 'Grounded Dialogue Rules' }).fill('Never use clichés.');
        await shownPage(page).getByRole('button', { name: 'Save' }).click();
        await expect.poll(async () => (await readModeSettings(page)).grounded_dialogue_rules).toBe('Never use clichés.');
    });
});

test.describe('The window as a whole', () => {
    test('Escape pops one page and then closes the window, and focus returns to what had it', async ({ page }) => {
        const { avatars } = await openDetailsApp(page);
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0], members: [avatars[1], avatars[2]], name: 'Weekend plans' });
        await page.locator('#sb_conversation_input').focus();
        await openDetails(page, conversationId);

        await shownPage(page).getByRole('button', { name: /^Chats/ }).click();
        await expect(shownPage(page).getByRole('button', { name: 'New Chat' })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(shownPage(page).locator('.sb-details-hero__name', { hasText: 'Weekend plans' })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator(DETAILS_HOST)).toHaveCount(0);
        await expect(page.locator('#sb_conversation_input')).toBeFocused();
    });

    test('Back returns to the page below and Close ends the whole window', async ({ page }) => {
        const { avatars } = await openDetailsApp(page);
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0], members: [avatars[1], avatars[2]], name: 'Weekend plans' });
        await openDetails(page, conversationId);

        await shownPage(page).getByRole('button', { name: /^Chats/ }).click();
        await expect(shownPage(page).getByRole('button', { name: 'New Chat' })).toBeVisible();
        await shownPage(page).getByRole('button', { name: 'Back' }).click();
        await expect(shownPage(page).locator('.sb-details-hero__name', { hasText: 'Weekend plans' })).toBeVisible();
        await shownPage(page).getByRole('button', { name: 'Advanced' }).click();
        await expect(shownPage(page).getByRole('button', { name: 'Clear Memory' })).toBeVisible();
        await shownPage(page).getByRole('button', { name: 'Close' }).click();
        await expect(page.locator(DETAILS_HOST)).toHaveCount(0);
    });

    test('the details of a conversation that is not open change that conversation, and choosing one of its chats opens it', async ({ page }) => {
        const { avatars } = await openDetailsApp(page);
        const other = await seedAndOpen(page, { avatar: avatars[1], chats: [{ name: 'First', messages: TALK }, { name: 'Second', messages: TALK.slice(0, 2) }] });
        const open = await seedAndOpen(page, { avatar: avatars[0], chats: [{ name: 'Main', messages: TALK }] });
        expect((await readOpenConversation(page)).id).toBe(open.conversationId);

        await openDetails(page, other.conversationId);
        await shownPage(page).getByRole('radio', { name: 'Muted' }).check();
        await expectSetting(page, other.conversationId, 'notifications_muted', true);
        await expectSetting(page, open.conversationId, 'notifications_muted', undefined);

        await shownPage(page).getByRole('button', { name: /^Chats/ }).click();
        await shownPage(page).getByRole('listitem', { name: 'Second' }).click();
        await expect(page.locator(DETAILS_HOST)).toHaveCount(0);
        await expect.poll(async () => (await readOpenConversation(page))?.id).toBe(other.conversationId);
        await expect.poll(async () => (await readStored(page, other.conversationId)).activeChatId).toBe(other.chatIds[1]);
        await expect(page.locator('#sb_conversation_timeline .sb-conversation-message')).toHaveCount(2);
    });

    test('the window closes when the conversation it shows is deleted', async ({ page }) => {
        const { avatars } = await openDetailsApp(page);
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0], members: [avatars[1], avatars[2]], name: 'Weekend plans' });
        await openDetails(page, conversationId, { page: 'chats' });
        await page.evaluate(async (id) => (await import('/scripts/sillybunny-conversation/conversation-data-browser.js')).conversationData.deleteConversation(id), conversationId);
        await expect(page.locator(DETAILS_HOST)).toHaveCount(0);
    });

    test('a conversation that does not exist, and a page that does not exist, open nothing', async ({ page }) => {
        const { avatars } = await openDetailsApp(page);
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0] });
        const answers = await page.evaluate(async (id) => {
            const { openConversationDetails } = await import('/scripts/sillybunny-conversation/chrome.js');
            return [await openConversationDetails('conv_missing'), await openConversationDetails(id, { page: 'nowhere' }), await openConversationDetails(id, { page: 'preferences' })];
        }, conversationId);
        expect(answers).toEqual([false, false, false]);
        await expect(page.locator(DETAILS_HOST)).toHaveCount(0);
    });
});

test.describe('On the smallest phone', () => {
    test.use({ viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true });

    test('the pages fit a 360px sheet, and its header keeps Close in reach', async ({ page }) => {
        const { avatars } = await openDetailsApp(page);
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0], members: [avatars[1], avatars[2]], name: 'A group with a long name that has to wrap inside the sheet', chats: [{ name: 'Main', messages: TALK }] });
        for (const pageId of ['general', 'behaviour', 'advanced']) {
            await openDetails(page, conversationId, { page: pageId });
            const overflow = await shownPage(page).locator('.sb-dialog__body').evaluate(body => body.scrollWidth - body.clientWidth);
            expect(overflow, `${pageId} does not scroll sideways`).toBeLessThanOrEqual(1);
            const close = await shownPage(page).getByRole('button', { name: 'Close' }).boundingBox();
            expect(close.x + close.width, 'Close is inside the sheet').toBeLessThanOrEqual(360);
            expect(Math.round(close.height)).toBeGreaterThanOrEqual(44);
        }
    });
});

test.describe('On a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('the flows of the pages work by touch: Remove with Undo, a chat renamed from the sheet menu, and a Behaviour row saved', async ({ page }) => {
        const { avatars, names } = await openDetailsApp(page);
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0], members: [avatars[1], avatars[2]], name: 'Weekend plans', chats: [{ name: 'Main', messages: TALK }, { name: 'Second' }] });
        await showToasts(page);
        await openDetails(page, conversationId);

        await shownPage(page).getByRole('button', { name: `Remove ${names[avatars[2]]}` }).tap();
        await expect(shownPage(page).getByRole('listitem')).toHaveCount(2);
        await page.getByRole('button', { name: 'Undo' }).tap();
        await expect(shownPage(page).getByRole('listitem')).toHaveCount(3);

        await shownPage(page).getByRole('button', { name: /^Chats/ }).tap();
        await shownPage(page).getByRole('button', { name: 'Actions for Second' }).tap();
        await page.getByRole('menuitem', { name: 'Rename…' }).tap();
        await page.getByRole('textbox').last().fill('Weekend');
        await page.getByRole('button', { name: 'Rename', exact: true }).tap();
        await expect(shownPage(page).getByRole('listitem', { name: 'Weekend' })).toBeVisible();
        await expect.poll(async () => (await readStored(page, conversationId)).chats.map(chat => chat.name)).toEqual(['Main', 'Weekend']);

        await shownPage(page).getByRole('button', { name: 'Back' }).tap();
        await shownPage(page).getByRole('button', { name: 'Behaviour' }).tap();
        await shownPage(page).getByRole('switch', { name: 'Messaging First' }).tap();
        await expectSetting(page, conversationId, 'proactive_messaging', true);
    });

    test('the window is a bottom sheet with the same pages, large targets, and no sideways scroll', async ({ page }) => {
        const { avatars, names } = await openDetailsApp(page);
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0], members: [avatars[1], avatars[2]], name: 'Weekend plans', chats: [{ name: 'Main', messages: TALK }] });
        await openDetails(page, conversationId);

        await expect(page.locator(DETAILS_HOST)).toHaveAttribute('data-presentation', 'sheet');
        await expect(page.locator(`${DETAILS_SURFACE} .sb-dialog__handle`)).toBeVisible();
        const remove = shownPage(page).getByRole('button', { name: `Remove ${names[avatars[1]]}` });
        const box = await remove.boundingBox();
        // A layout box is a fraction of a pixel short of its size in Firefox, so the size is rounded.
        expect(Math.round(box.width)).toBeGreaterThanOrEqual(44);
        expect(Math.round(box.height)).toBeGreaterThanOrEqual(44);

        for (const pageId of ['general', 'members', 'chats', 'behaviour', 'advanced', 'profile']) {
            // Opening the window again replaces the one that is open, so each page starts from a window of its own.
            await openDetails(page, conversationId, { page: pageId, avatar: avatars[1] });
            const overflow = await shownPage(page).locator('.sb-dialog__body').evaluate(body => body.scrollWidth - body.clientWidth);
            expect(overflow, `${pageId} does not scroll sideways`).toBeLessThanOrEqual(1);
        }
        await openPreferences(page);
        expect(await shownPage(page).locator('.sb-dialog__body').evaluate(body => body.scrollWidth - body.clientWidth)).toBeLessThanOrEqual(1);
    });
});
