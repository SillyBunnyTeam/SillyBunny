import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { callRoute, DETAILS_HOST, openDetails, openDetailsApp, readStored, seedAndOpen, shownPage } from './helpers/conversation-details.js';
import { showToasts } from './helpers/maintainer-server.js';

// Bulk actions on the Chats, Media, Files and Pinned pages of the details window: selection mode on the window's own header,
// an action bar under the page, Select All over every item, and what each action does to the stored conversation. What a page
// changes is read back from the server, not from the page.
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 120_000 });

const DAY = Date.UTC(2026, 8, 30, 12, 0, 0);
const HOUR = 3_600_000;

/** A chat whose newest message is `hours` after noon, so that the Chats page lists the chats in the order that a spec expects. */
const chatAt = (name, hours, extraMessages = []) => ({
    name,
    messages: [{ id: `${name.toLowerCase()}-1`, role: 'character', name: 'Character', mes: `Hello from ${name}`, created_at: DAY + hours * HOUR }, ...extraMessages],
});

/** Five chats; the page lists them Echo, Delta, Charlie, Bravo, Alpha, and Alpha is the open one. */
const FIVE_CHATS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].map((name, index) => chatAt(name, index));

const alertHost = page => page.locator('dialog.sb-conversation-dialog[open]');
const selectionHeader = page => shownPage(page).locator('.sb-dialog__header.is-selection-mode');
const selectionTitle = page => selectionHeader(page).locator('.sb-dialog__selection-title');
const actionBar = page => shownPage(page).getByRole('toolbar', { name: 'Selection Actions' });

/** The files of a downloaded ZIP, each with its size in bytes and its text, read by the library that the page ships. */
async function readZip(page, download) {
    const bytes = [...readFileSync(await download.path())];
    return page.evaluate(async (data) => {
        if (!window.JSZip) {
            await import('/lib/jszip.min.js');
        }
        const zip = await window.JSZip.loadAsync(Uint8Array.from(data));
        const files = {};
        for (const [name, file] of Object.entries(zip.files)) {
            const content = await file.async('uint8array');
            files[name] = { size: content.length, text: new TextDecoder().decode(content) };
        }
        return files;
    }, bytes);
}

/** The size in bytes that the server gives a file of the app, to compare with the file in a ZIP. */
const sizeOf = (page, path) => page.evaluate(async url => (await (await fetch(url)).arrayBuffer()).byteLength, path);

async function openChatsPage(page, options = {}) {
    const { avatars } = await openDetailsApp(page);
    const seeded = await seedAndOpen(page, { avatar: avatars[0], chats: FIVE_CHATS, ...options });
    await openDetails(page, seeded.conversationId, { page: 'chats' });
    return { ...seeded, avatars };
}

test.describe('Chats', () => {
    test('Select turns the header into the selection header, a row press and Shift-press choose rows, and Select All covers every chat', async ({ page }) => {
        await openChatsPage(page);
        const chats = shownPage(page);

        await chats.getByRole('button', { name: 'Select', exact: true }).click();
        await expect(selectionHeader(page)).toBeVisible();
        await expect(selectionTitle(page)).toHaveText('0 Selected');
        await expect(selectionHeader(page).getByRole('button', { name: 'Cancel' })).toBeFocused();
        await expect(actionBar(page).getByRole('button', { name: 'Export' })).toBeDisabled();

        await chats.getByRole('listitem', { name: 'Echo' }).click();
        await expect(selectionTitle(page)).toHaveText('1 Selected');
        await chats.getByRole('listitem', { name: 'Charlie' }).click({ modifiers: ['Shift'] });
        await expect(selectionTitle(page)).toHaveText('3 Selected');
        await expect(chats.getByRole('checkbox', { name: 'Select Delta' })).toBeChecked();
        await expect(actionBar(page).getByRole('button', { name: 'Delete' })).toBeEnabled();

        await selectionHeader(page).getByRole('button', { name: 'Select All' }).click();
        await expect(selectionTitle(page)).toHaveText('5 Selected');
        await selectionHeader(page).getByRole('button', { name: 'Select All' }).click();
        await expect(selectionTitle(page)).toHaveText('0 Selected');

        await selectionHeader(page).getByRole('button', { name: 'Cancel' }).click();
        await expect(selectionHeader(page)).toHaveCount(0);
        await expect(chats.getByRole('button', { name: 'Select', exact: true })).toBeVisible();
    });

    test('the Select item of a row menu starts selection with that row chosen, and a secondary click opens the menu and selects nothing', async ({ page }) => {
        await openChatsPage(page);
        const chats = shownPage(page);

        await chats.getByRole('listitem', { name: 'Charlie' }).click({ button: 'right' });
        await expect(page.getByRole('menuitem', { name: 'Select' })).toBeVisible();
        await expect(selectionHeader(page)).toHaveCount(0);
        await page.getByRole('menuitem', { name: 'Select' }).click();
        await expect(selectionTitle(page)).toHaveText('1 Selected');
        await expect(chats.getByRole('checkbox', { name: 'Select Charlie' })).toBeChecked();
    });

    test('Escape leaves selection mode first and pops the page second', async ({ page }) => {
        await openChatsPage(page);
        const chats = shownPage(page);
        await chats.getByRole('button', { name: 'Select', exact: true }).click();
        await chats.getByRole('listitem', { name: 'Echo' }).click();

        await page.keyboard.press('Escape');
        await expect(selectionHeader(page)).toHaveCount(0);
        await expect(chats.getByRole('list', { name: 'Chats' })).toBeVisible();
        await expect(page.locator(DETAILS_HOST)).toHaveCount(1);

        await page.keyboard.press('Escape');
        await expect(shownPage(page).locator('.sb-details-hero, [data-sb-editor-field="chats"]').first()).toBeVisible();
        await expect(shownPage(page).getByRole('list', { name: 'Chats' })).toHaveCount(0);
    });

    test('the keyboard starts selection from the Select button, chooses rows with Space, selects all with Ctrl+A, and Escape returns focus to the button', async ({ page }) => {
        await openChatsPage(page);
        const chats = shownPage(page);
        const select = chats.getByRole('button', { name: 'Select', exact: true });
        await select.focus();
        await page.keyboard.press('Enter');
        await expect(selectionHeader(page).getByRole('button', { name: 'Cancel' })).toBeFocused();
        await page.keyboard.press('Control+A');
        await expect(selectionTitle(page)).toHaveText('5 Selected');
        await selectionHeader(page).getByRole('button', { name: 'Select All' }).click();
        await expect(selectionTitle(page)).toHaveText('0 Selected');

        await chats.getByRole('listitem', { name: 'Delta' }).focus();
        await page.keyboard.press('Space');
        await expect(selectionTitle(page)).toHaveText('1 Selected');
        await page.keyboard.press('Space');
        await expect(selectionTitle(page)).toHaveText('0 Selected');
        await page.keyboard.press('Enter');
        await expect(selectionTitle(page)).toHaveText('1 Selected');
        await page.keyboard.press('Control+A');
        await expect(selectionTitle(page)).toHaveText('5 Selected');

        await page.keyboard.press('Escape');
        await expect(selectionHeader(page)).toHaveCount(0);
        await expect(select).toBeFocused();
    });

    test('a change while selecting keeps the chosen chats, and drops a chat that is gone from the selection', async ({ page }) => {
        const { conversationId, chatIds } = await openChatsPage(page);
        const chats = shownPage(page);
        await chats.getByRole('button', { name: 'Select', exact: true }).click();
        await chats.getByRole('listitem', { name: 'Echo' }).click();
        await chats.getByRole('listitem', { name: 'Bravo' }).click();
        await expect(selectionTitle(page)).toHaveText('2 Selected');

        // Another tab renames one chat and deletes a chosen one; this page reads the list again.
        await callRoute(page, '/chat/rename', { id: conversationId, chatId: chatIds[3], name: 'Delta renamed' });
        await callRoute(page, '/chat/delete', { id: conversationId, chatId: chatIds[1] });
        await page.evaluate(async () => {
            const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
            await conversationData.refresh();
        });
        await expect(chats.getByRole('listitem', { name: 'Delta renamed' })).toBeVisible();
        await expect(selectionTitle(page)).toHaveText('1 Selected');
        await expect(chats.getByRole('checkbox', { name: 'Select Echo' })).toBeChecked();
        await expect(chats.getByRole('checkbox', { name: 'Select Delta renamed' })).not.toBeChecked();
        await expect(chats.getByRole('listitem', { name: 'Bravo' })).toHaveCount(0);
    });

    test('Close in selection mode closes the window', async ({ page }) => {
        await openChatsPage(page);
        const chats = shownPage(page);
        await chats.getByRole('button', { name: 'Select', exact: true }).click();
        await selectionHeader(page).getByRole('button', { name: 'Close' }).click();
        await expect(page.locator(DETAILS_HOST)).toHaveCount(0);
    });

    test('Export downloads one ZIP of JSONL files named after the chats, and loads the ZIP library only then', async ({ page }) => {
        const loaded = [];
        page.on('request', request => {
            if (request.url().includes('/lib/jszip')) {
                loaded.push(request.url());
            }
        });
        const { chatIds } = await openChatsPage(page);
        const chats = shownPage(page);
        expect(loaded, 'nothing of the library loads with the window').toEqual([]);

        await chats.getByRole('button', { name: 'Select', exact: true }).click();
        await chats.getByRole('listitem', { name: 'Bravo' }).click();
        await chats.getByRole('listitem', { name: 'Echo' }).click();
        const [download] = await Promise.all([page.waitForEvent('download'), actionBar(page).getByRole('button', { name: 'Export' }).click()]);
        expect(download.suggestedFilename()).toMatch(/\.zip$/);
        expect(loaded).toHaveLength(1);

        const files = await readZip(page, download);
        expect(Object.keys(files).sort()).toEqual(['Bravo.jsonl', 'Echo.jsonl']);
        expect(files['Echo.jsonl'].text).toContain('Hello from Echo');
        expect(files['Bravo.jsonl'].text).not.toContain('Hello from Echo');
        const lines = files['Echo.jsonl'].text.trim().split('\n').map(line => JSON.parse(line));
        expect(lines.at(-1).mes).toBe('Hello from Echo');
        expect(chatIds).toHaveLength(5);
        await expect(selectionHeader(page)).toHaveCount(0);
    });

    test('Export numbers chats that share a name', async ({ page }) => {
        const { avatars } = await openDetailsApp(page);
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0], chats: [chatAt('Same', 0), chatAt('Same', 1), chatAt('Other', 2)] });
        await openDetails(page, conversationId, { page: 'chats' });
        const chats = shownPage(page);
        await chats.getByRole('button', { name: 'Select', exact: true }).click();
        await selectionHeader(page).getByRole('button', { name: 'Select All' }).click();
        const [download] = await Promise.all([page.waitForEvent('download'), actionBar(page).getByRole('button', { name: 'Export' }).click()]);
        expect(Object.keys(await readZip(page, download)).sort()).toEqual(['Other.jsonl', 'Same (2).jsonl', 'Same.jsonl']);
    });

    test('Delete asks with the count, keeps Cancel first, and deletes the chosen chats with the open chat last', async ({ page }) => {
        const { conversationId, chatIds } = await openChatsPage(page);
        const chats = shownPage(page);
        await chats.getByRole('button', { name: 'Select', exact: true }).click();
        await chats.getByRole('listitem', { name: 'Alpha' }).click();
        await chats.getByRole('listitem', { name: 'Delta' }).click();
        await actionBar(page).getByRole('button', { name: 'Delete' }).click();

        const alert = alertHost(page);
        await expect(alert.getByRole('heading', { name: 'Delete 2 Chats?' })).toBeVisible();
        await expect(alert.getByRole('button', { name: 'Cancel' })).toBeFocused();
        await alert.getByRole('button', { name: 'Cancel' }).click();
        await expect(alert).toHaveCount(0);
        await expect(selectionTitle(page)).toHaveText('2 Selected');
        expect((await readStored(page, conversationId)).chats).toHaveLength(5);

        await actionBar(page).getByRole('button', { name: 'Delete' }).click();
        await alertHost(page).getByRole('button', { name: 'Delete', exact: true }).click();

        await expect(chats.getByRole('listitem')).toHaveCount(3);
        await expect(selectionHeader(page)).toHaveCount(0);
        const stored = await readStored(page, conversationId);
        expect(stored.chats.map(chat => chat.id).sort()).toEqual([chatIds[1], chatIds[2], chatIds[4]].sort());
        // The server shows the newest chat that is left, as Delete Chat does.
        expect(stored.activeChatId).toBe(chatIds[4]);
    });

    test('Delete with every chat chosen leaves one empty chat', async ({ page }) => {
        const { conversationId, chatIds } = await openChatsPage(page);
        const chats = shownPage(page);
        await chats.getByRole('button', { name: 'Select', exact: true }).click();
        await selectionHeader(page).getByRole('button', { name: 'Select All' }).click();
        await actionBar(page).getByRole('button', { name: 'Delete' }).click();
        await expect(alertHost(page).getByRole('heading', { name: 'Delete 5 Chats?' })).toBeVisible();
        await alertHost(page).getByRole('button', { name: 'Delete', exact: true }).click();

        await expect(chats.getByRole('listitem')).toHaveCount(1);
        const stored = await readStored(page, conversationId);
        expect(stored.chats).toHaveLength(1);
        expect(chatIds).not.toContain(stored.chats[0].id);
        expect(stored.chats[0].messageCount ?? 0).toBe(0);
        expect(stored.activeChatId).toBe(stored.chats[0].id);
    });

    test('the conversation shows the chat that Delete Chat would show when the open chat is deleted in bulk', async ({ page }) => {
        const { conversationId, chatIds } = await openChatsPage(page, { activeChat: 4 });
        await expect(page.locator('#sb_conversation_timeline')).toContainText('Hello from Echo');
        const chats = shownPage(page);
        await chats.getByRole('button', { name: 'Select', exact: true }).click();
        await chats.getByRole('listitem', { name: 'Echo' }).click();
        await chats.getByRole('listitem', { name: 'Bravo' }).click();
        await actionBar(page).getByRole('button', { name: 'Delete' }).click();
        await alertHost(page).getByRole('button', { name: 'Delete', exact: true }).click();
        await expect(chats.getByRole('listitem')).toHaveCount(3);

        expect((await readStored(page, conversationId)).activeChatId).toBe(chatIds[3]);
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await expect(page.locator(DETAILS_HOST)).toHaveCount(0);
        await expect(page.locator('#sb_conversation_timeline')).toContainText('Hello from Delta');
        await expect(page.locator('#sb_conversation_timeline')).not.toContainText('Hello from Echo');
    });
});

test.describe('Chats in batches', () => {
    test('shows fifty chats, then more with Show More, and Select All covers the chats behind it', async ({ page }) => {
        const { avatars } = await openDetailsApp(page);
        const many = Array.from({ length: 56 }, (_, index) => chatAt(`Chat ${String(index + 1).padStart(2, '0')}`, index));
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0], chats: many });
        await openDetails(page, conversationId, { page: 'chats' });
        const chats = shownPage(page);

        await expect(chats.getByRole('list', { name: 'Chats' }).getByRole('listitem')).toHaveCount(50);
        await chats.getByRole('button', { name: 'Select', exact: true }).click();
        await selectionHeader(page).getByRole('button', { name: 'Select All' }).click();
        await expect(selectionTitle(page)).toHaveText('56 Selected');
        await expect(chats.getByRole('checkbox', { name: 'Select Chat 56' })).toBeChecked();

        await chats.getByRole('button', { name: 'Show More' }).click();
        await expect(chats.getByRole('list', { name: 'Chats' }).getByRole('listitem')).toHaveCount(56);
        await expect(chats.getByRole('button', { name: 'Show More' })).toBeHidden();
        await expect(chats.getByRole('checkbox', { name: 'Select Chat 01' })).toBeChecked();
        await expect(selectionTitle(page)).toHaveText('56 Selected');
    });

    test('Show More from the keyboard focuses the first row it added', async ({ page }) => {
        const { avatars } = await openDetailsApp(page);
        const many = Array.from({ length: 52 }, (_, index) => chatAt(`Chat ${String(index + 1).padStart(2, '0')}`, index));
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0], chats: many });
        await openDetails(page, conversationId, { page: 'chats' });
        const chats = shownPage(page);
        const more = chats.getByRole('button', { name: 'Show More' });
        await more.focus();
        await page.keyboard.press('Enter');
        await expect(chats.getByRole('list', { name: 'Chats' }).getByRole('listitem')).toHaveCount(52);
        await expect(chats.getByRole('listitem', { name: 'Chat 02' })).toBeFocused();
    });

    test('arrow keys move through Chats and reach Show More from the last row', async ({ page }) => {
        const { avatars } = await openDetailsApp(page);
        const many = Array.from({ length: 52 }, (_, index) => chatAt(`Chat ${String(index + 1).padStart(2, '0')}`, index));
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0], chats: many });
        await openDetails(page, conversationId, { page: 'chats' });
        const chats = shownPage(page);

        await chats.getByRole('listitem', { name: 'Chat 52' }).focus();
        await page.keyboard.press('ArrowDown');
        await expect(chats.getByRole('listitem', { name: 'Chat 51' })).toBeFocused();
        await page.keyboard.press('End');
        await expect(chats.getByRole('listitem', { name: 'Chat 03' })).toBeFocused();
        await page.keyboard.press('ArrowDown');
        await expect(chats.getByRole('button', { name: 'Show More' })).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(chats.getByRole('listitem', { name: 'Chat 02' })).toBeFocused();
    });
});


// ---------------------------------------------------------------------------------------------------------------------
// Media

const PICTURE_CHAT = [
    { id: 'p-1', role: 'character', name: 'Character', mes: 'The logo and the other one.', created_at: DAY + 60_000, extra: { media: [{ url: '/img/logo.png', type: 'image', title: 'logo.png' }, { url: '/img/ai4.png', type: 'image', title: '' }] } },
    { id: 'p-2', role: 'user', name: 'Tester', mes: '', created_at: DAY + 120_000, extra: { media: [{ url: '/img/addbg3.png', type: 'image', title: '' }] } },
    { id: 'p-3', role: 'character', name: 'Character', mes: 'This one is gone from the disk.', created_at: DAY + 180_000, extra: { media: [{ url: '/img/no-such-picture-404.png', type: 'image', title: '' }] } },
];

async function openSharedPage(page, pageName, messages, options = {}) {
    const { avatars } = await openDetailsApp(page);
    const seeded = await seedAndOpen(page, { avatar: avatars[0], chats: [{ name: 'Main', messages }], ...options });
    await openDetails(page, seeded.conversationId, { page: pageName });
    return seeded;
}

/** The records of a chat as the server stores them, without the header. */
async function readRecords(page, conversationId, chatId) {
    return (await callRoute(page, '/chat/get', { id: conversationId, chatId })).json.chat.slice(1);
}

const cellOf = (page, key) => shownPage(page).locator(`[data-sb-list-key="${key}"]`);
const itemOf = (page, key) => shownPage(page).locator(`[data-sb-select-key="${key}"]`);

test.describe('Media', () => {
    test('a hover check, a secondary click, a press and Shift-press choose pictures, and Select All covers every one', async ({ page }) => {
        await openSharedPage(page, 'media', PICTURE_CHAT);
        const media = shownPage(page);

        await cellOf(page, 'p-1:media:0').hover();
        const check = itemOf(page, 'p-1:media:0').locator('.sb-details-media-check');
        await expect(check).toBeVisible();
        await check.click();
        await expect(selectionTitle(page)).toHaveText('1 Selected');
        await expect(itemOf(page, 'p-1:media:0')).toHaveClass(/is-selection-selected/);
        await expect(media.locator('.sb-details-media-check').first()).toBeHidden();

        await cellOf(page, 'p-2:media:0').click();
        await expect(selectionTitle(page)).toHaveText('2 Selected');
        await expect(itemOf(page, 'p-2:media:0').getByRole('checkbox', { name: /^Select Picture by Tester/ })).toBeChecked();
        await expect(page.locator('.sb-details-picture')).toHaveCount(0);
        await cellOf(page, 'p-2:media:0').click();
        await expect(selectionTitle(page)).toHaveText('1 Selected');

        await selectionHeader(page).getByRole('button', { name: 'Cancel' }).click();
        await cellOf(page, 'p-3:media:0').click({ button: 'right' });
        await expect(selectionTitle(page)).toHaveText('1 Selected');
        await expect(page.getByRole('menuitem')).toHaveCount(0);
        await cellOf(page, 'p-1:media:1').click({ modifiers: ['Shift'] });
        // The list is 404, addbg3, logo, ai4, so the range from the first pressed cell to this one is all four.
        await expect(selectionTitle(page)).toHaveText('4 Selected');
        await selectionHeader(page).getByRole('button', { name: 'Select All' }).click();
        await expect(selectionTitle(page)).toHaveText('0 Selected');
        await selectionHeader(page).getByRole('button', { name: 'Select All' }).click();
        await expect(selectionTitle(page)).toHaveText('4 Selected');
    });

    test('the keyboard chooses a picture with Space, extends a range with Shift+Space, and leaves selection mode with Escape', async ({ page }) => {
        await openSharedPage(page, 'media', PICTURE_CHAT);
        const media = shownPage(page);
        await media.getByRole('button', { name: 'Select', exact: true }).click();
        await cellOf(page, 'p-3:media:0').focus();
        await page.keyboard.press('Space');
        await expect(selectionTitle(page)).toHaveText('1 Selected');
        await page.keyboard.press('ArrowRight');
        await expect(cellOf(page, 'p-2:media:0')).toBeFocused();
        await page.keyboard.press('ArrowRight');
        await expect(cellOf(page, 'p-1:media:0')).toBeFocused();
        await page.keyboard.press('Shift+Space');
        await expect(selectionTitle(page)).toHaveText('3 Selected');
        await page.keyboard.press('Enter');
        await expect(selectionTitle(page)).toHaveText('2 Selected');
        await expect(page.locator('.sb-details-picture')).toHaveCount(0);

        await page.keyboard.press('Escape');
        await expect(selectionHeader(page)).toHaveCount(0);
        await expect(media.locator('.sb-details-media-grid')).toBeVisible();
        await expect(page.locator(DETAILS_HOST)).toHaveCount(1);
    });

    test('Download makes one ZIP of the pictures, and names a picture that cannot be fetched while the others still download', async ({ page }) => {
        await openSharedPage(page, 'media', PICTURE_CHAT);
        await showToasts(page);
        const media = shownPage(page);
        await media.getByRole('button', { name: 'Select', exact: true }).click();
        await selectionHeader(page).getByRole('button', { name: 'Select All' }).click();
        const [download] = await Promise.all([page.waitForEvent('download'), actionBar(page).getByRole('button', { name: 'Download' }).click()]);
        expect(download.suggestedFilename()).toMatch(/Media\.zip$/);

        const files = await readZip(page, download);
        expect(Object.keys(files).sort()).toEqual(['addbg3.png', 'ai4.png', 'logo.png']);
        expect(files['logo.png'].size).toBe(await sizeOf(page, '/img/logo.png'));
        expect(files['ai4.png'].size).toBe(await sizeOf(page, '/img/ai4.png'));
        await expect(page.locator('.toast', { hasText: 'Could not download: no-such-picture-404.png' })).toBeVisible();
        await expect(selectionHeader(page)).toHaveCount(0);
    });

    test('Download of pictures that all fail keeps the selection, so that the user can try again', async ({ page }) => {
        await openSharedPage(page, 'media', PICTURE_CHAT);
        await showToasts(page);
        const media = shownPage(page);
        await media.getByRole('button', { name: 'Select', exact: true }).click();
        await cellOf(page, 'p-3:media:0').click();
        let downloads = 0;
        page.on('download', () => { downloads += 1; });
        await actionBar(page).getByRole('button', { name: 'Download' }).click();
        await expect(page.locator('.toast', { hasText: 'Could not download: no-such-picture-404.png' })).toBeVisible();
        await expect(selectionTitle(page)).toHaveText('1 Selected');
        expect(downloads).toBe(0);
    });

    test('Remove From Chat counts the message that goes with its last picture, keeps the text of the others, and saves once', async ({ page }) => {
        const { conversationId, chatIds } = await openSharedPage(page, 'media', PICTURE_CHAT);
        const media = shownPage(page);
        await media.getByRole('button', { name: 'Select', exact: true }).click();
        await cellOf(page, 'p-1:media:0').click();
        await cellOf(page, 'p-2:media:0').click();
        await actionBar(page).getByRole('button', { name: 'Remove From Chat' }).click();

        const alert = alertHost(page);
        await expect(alert.getByRole('heading', { name: 'Remove 2 Items and Delete 1 Message?' })).toBeVisible();
        await expect(alert.getByRole('button', { name: 'Cancel' })).toBeFocused();
        await alert.getByRole('button', { name: 'Cancel' }).click();
        await expect(selectionTitle(page)).toHaveText('2 Selected');
        expect((await readRecords(page, conversationId, chatIds[0])).map(record => record.id)).toEqual(['p-1', 'p-2', 'p-3']);

        const saves = [];
        page.on('request', request => {
            if (request.url().endsWith('/chat/save')) {
                saves.push(request.url());
            }
        });
        await actionBar(page).getByRole('button', { name: 'Remove From Chat' }).click();
        await alertHost(page).getByRole('button', { name: 'Remove', exact: true }).click();

        await expect(selectionHeader(page)).toHaveCount(0);
        await expect(media.locator('.sb-details-media-item')).toHaveCount(2);
        await expect.poll(async () => (await readRecords(page, conversationId, chatIds[0])).map(record => record.id)).toEqual(['p-1', 'p-3']);
        const [kept] = await readRecords(page, conversationId, chatIds[0]);
        expect(kept.mes).toBe('The logo and the other one.');
        expect(kept.extra.media.map(item => item.url)).toEqual(['/img/ai4.png']);
        expect(saves, 'the edit and the deletion are one save').toHaveLength(1);
        await expect(page.locator('#sb_conversation_timeline .sb-conversation-message[data-message-id="p-2"]')).toHaveCount(0);
        await expect(page.locator('#sb_conversation_timeline .sb-conversation-message[data-message-id="p-1"]')).toBeVisible();
    });

    test('the picture viewer has Remove From Chat in its menu, and closes once the picture is gone', async ({ page }) => {
        const { conversationId, chatIds } = await openSharedPage(page, 'media', PICTURE_CHAT);
        await cellOf(page, 'p-2:media:0').click();
        await expect(page.locator('.sb-details-picture img')).toBeVisible();
        await shownPage(page).getByRole('button', { name: 'Picture Menu' }).click();
        await page.getByRole('menuitem', { name: 'Remove From Chat' }).click();
        await expect(alertHost(page).getByRole('heading', { name: 'Remove 1 Item and Delete 1 Message?' })).toBeVisible();
        await alertHost(page).getByRole('button', { name: 'Remove', exact: true }).click();

        await expect(page.locator('.sb-details-picture')).toHaveCount(0);
        await expect(shownPage(page).locator('.sb-details-media-item')).toHaveCount(3);
        await expect.poll(async () => (await readRecords(page, conversationId, chatIds[0])).map(record => record.id)).toEqual(['p-1', 'p-3']);
    });

    test('shows fifty pictures, then the rest with Show More, and Select All covers the ones behind it', async ({ page }) => {
        const many = [{ id: 'many-1', role: 'character', name: 'Character', mes: 'Many.', created_at: DAY, extra: { media: Array.from({ length: 53 }, () => ({ url: '/img/logo.png', type: 'image', title: '' })) } }];
        await openSharedPage(page, 'media', many);
        const media = shownPage(page);
        await expect(media.locator('.sb-details-media-item')).toHaveCount(50);
        await media.getByRole('button', { name: 'Select', exact: true }).click();
        await selectionHeader(page).getByRole('button', { name: 'Select All' }).click();
        await expect(selectionTitle(page)).toHaveText('53 Selected');
        await media.getByRole('button', { name: 'Show More' }).click();
        await expect(media.locator('.sb-details-media-item')).toHaveCount(53);
        await expect(media.locator('.sb-details-media-item.is-selection-selected')).toHaveCount(53);
    });

    test('a chat with no pictures has no Select button', async ({ page }) => {
        await openSharedPage(page, 'media', [{ id: 'x-1', role: 'character', name: 'Character', mes: 'Only text.', created_at: DAY }]);
        await expect(shownPage(page).getByText('No Media')).toBeVisible();
        await expect(shownPage(page).getByRole('button', { name: 'Select', exact: true })).toBeHidden();
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// Files

const FILE_CHAT = [
    { id: 'f-1', role: 'character', name: 'Character', mes: 'The notes.', created_at: DAY + 60_000, extra: { files: [{ url: '/robots.txt', name: 'notes.txt', size: 1200 }, { url: '/manifest.json', name: 'notes.txt', size: 300 }] } },
    { id: 'f-2', role: 'user', name: 'Tester', mes: '', created_at: DAY + 120_000, extra: { media: [{ url: '/sounds/message.mp3', type: 'audio', title: 'voice.mp3' }] } },
];

const rowOf = (page, key) => shownPage(page).locator(`[data-sb-list-key="${key}"]`);

test.describe('Files', () => {
    test('the Select item of a row menu starts selection, and Download makes one ZIP with the names of the files, numbered where they repeat', async ({ page }) => {
        await openSharedPage(page, 'files', FILE_CHAT);
        const files = shownPage(page);
        await rowOf(page, 'file:f-1:file:0').getByRole('button', { name: 'Actions for notes.txt' }).click();
        await expect(page.getByRole('menuitem')).toHaveText(['Download', 'Show in Chat', 'Select', 'Remove From Chat']);
        await page.getByRole('menuitem', { name: 'Select' }).click();
        await expect(selectionTitle(page)).toHaveText('1 Selected');

        await selectionHeader(page).getByRole('button', { name: 'Select All' }).click();
        await expect(selectionTitle(page)).toHaveText('3 Selected');
        const [download] = await Promise.all([page.waitForEvent('download'), actionBar(page).getByRole('button', { name: 'Download' }).click()]);
        expect(download.suggestedFilename()).toMatch(/Files\.zip$/);
        const archive = await readZip(page, download);
        expect(Object.keys(archive).sort()).toEqual(['notes (2).txt', 'notes.txt', 'voice.mp3']);
        expect(archive['notes.txt'].size).toBe(await sizeOf(page, '/robots.txt'));
        expect(archive['voice.mp3'].size).toBe(await sizeOf(page, '/sounds/message.mp3'));
        await expect(files.getByRole('button', { name: 'Select', exact: true })).toBeVisible();
    });

    test('Remove From Chat in a row menu asks, removes one file, and keeps the text of its message', async ({ page }) => {
        const { conversationId, chatIds } = await openSharedPage(page, 'files', FILE_CHAT);
        await rowOf(page, 'file:f-1:file:0').getByRole('button', { name: 'Actions for notes.txt' }).click();
        await page.getByRole('menuitem', { name: 'Remove From Chat' }).click();
        await expect(alertHost(page).getByRole('heading', { name: 'Remove 1 File From Chat?' })).toBeVisible();
        await alertHost(page).getByRole('button', { name: 'Remove', exact: true }).click();

        await expect(shownPage(page).getByRole('list', { name: 'Files' }).getByRole('listitem')).toHaveCount(2);
        await expect.poll(async () => (await readRecords(page, conversationId, chatIds[0]))[0].extra.files?.length).toBe(1);
        const records = await readRecords(page, conversationId, chatIds[0]);
        expect(records[0].mes).toBe('The notes.');
        expect(records[0].extra.files[0].url).toBe('/manifest.json');
        expect(records).toHaveLength(2);
    });

    test('removing the only attachment of a message without text deletes the message, and the alert says so', async ({ page }) => {
        const { conversationId, chatIds } = await openSharedPage(page, 'files', FILE_CHAT);
        await rowOf(page, 'file:f-2:media:0').getByRole('button', { name: 'Actions for voice.mp3' }).click();
        await page.getByRole('menuitem', { name: 'Remove From Chat' }).click();
        await expect(alertHost(page).getByRole('heading', { name: 'Remove 1 File and Delete 1 Message?' })).toBeVisible();
        await alertHost(page).getByRole('button', { name: 'Remove', exact: true }).click();
        await expect.poll(async () => (await readRecords(page, conversationId, chatIds[0])).map(record => record.id)).toEqual(['f-1']);
    });

    test('Remove From Chat in the action bar removes every chosen file in one go', async ({ page }) => {
        const { conversationId, chatIds } = await openSharedPage(page, 'files', FILE_CHAT);
        const files = shownPage(page);
        await files.getByRole('button', { name: 'Select', exact: true }).click();
        await selectionHeader(page).getByRole('button', { name: 'Select All' }).click();
        await actionBar(page).getByRole('button', { name: 'Remove From Chat' }).click();
        await expect(alertHost(page).getByRole('heading', { name: 'Remove 3 Files and Delete 1 Message?' })).toBeVisible();
        await alertHost(page).getByRole('button', { name: 'Remove', exact: true }).click();
        await expect(files.getByText('No Files')).toBeVisible();
        await expect.poll(async () => (await readRecords(page, conversationId, chatIds[0])).map(record => record.id)).toEqual(['f-1']);
        const [kept] = await readRecords(page, conversationId, chatIds[0]);
        expect(kept.extra.files ?? []).toEqual([]);
        expect(kept.mes).toBe('The notes.');
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// Pinned

const PIN_TIMES = [DAY + 10_000, DAY + 20_000, DAY + 30_000];
const PIN_CHAT = [
    { id: 'n-1', role: 'character', name: 'Character', mes: 'First pinned.', created_at: DAY + 60_000, extra: { conversation_pinned: true, conversation_pinned_at: PIN_TIMES[0] } },
    { id: 'n-2', role: 'user', name: 'Tester', mes: 'Second pinned.', created_at: DAY + 120_000, extra: { conversation_pinned: true, conversation_pinned_at: PIN_TIMES[1] } },
    { id: 'n-3', role: 'character', name: 'Character', mes: 'Third pinned.', created_at: DAY + 180_000, extra: { conversation_pinned: true, conversation_pinned_at: PIN_TIMES[2] } },
    { id: 'n-4', role: 'user', name: 'Tester', mes: 'Not pinned.', created_at: DAY + 240_000 },
];

test.describe('Files and Pinned in batches', () => {
    test('Files shows fifty files, then the rest with Show More, and Select All covers the ones behind it', async ({ page }) => {
        const files = Array.from({ length: 52 }, (_, index) => ({ url: '/robots.txt', name: `file-${String(index + 1).padStart(2, '0')}.txt`, size: 100 }));
        await openSharedPage(page, 'files', [{ id: 'many-f', role: 'character', name: 'Character', mes: 'Many files.', created_at: DAY, extra: { files } }]);
        const page_ = shownPage(page);
        await expect(page_.getByRole('list', { name: 'Files' }).getByRole('listitem')).toHaveCount(50);
        await page_.getByRole('button', { name: 'Select', exact: true }).click();
        await selectionHeader(page).getByRole('button', { name: 'Select All' }).click();
        await expect(selectionTitle(page)).toHaveText('52 Selected');
        await page_.getByRole('button', { name: 'Show More' }).click();
        await expect(page_.getByRole('list', { name: 'Files' }).getByRole('listitem')).toHaveCount(52);
        await expect(page_.getByRole('checkbox', { name: 'Select file-01.txt' })).toBeChecked();
    });

    test('Pinned shows fifty messages, then the rest with Show More, and Unpin works on a message behind it', async ({ page }) => {
        const pins = Array.from({ length: 52 }, (_, index) => ({ id: `pin-${index}`, role: 'character', name: 'Character', mes: `Pin ${String(index + 1).padStart(2, '0')}`, created_at: DAY + index * 60_000, extra: { conversation_pinned: true, conversation_pinned_at: DAY + index * 60_000 + 5 } }));
        const { conversationId, chatIds } = await openSharedPage(page, 'pinned', pins);
        const pinned = shownPage(page);
        await expect(pinned.getByRole('list', { name: 'Pinned Messages' }).getByRole('listitem')).toHaveCount(50);
        await pinned.getByRole('button', { name: 'Select', exact: true }).click();
        await selectionHeader(page).getByRole('button', { name: 'Select All' }).click();
        await expect(selectionTitle(page)).toHaveText('52 Selected');
        await actionBar(page).getByRole('button', { name: 'Unpin' }).click();
        await expect(pinned.getByText('No Pinned Messages')).toBeVisible();
        await expect(pinned.getByRole('button', { name: 'Back' })).toBeFocused();
        await expect.poll(async () => (await readRecords(page, conversationId, chatIds[0])).filter(record => record.extra?.conversation_pinned).length).toBe(0);
    });
});

test.describe('Pinned', () => {
    test('Unpin in the action bar unpins every chosen message, and one Undo gives them all back with their times', async ({ page }) => {
        const { conversationId, chatIds } = await openSharedPage(page, 'pinned', PIN_CHAT);
        await showToasts(page);
        const pinned = shownPage(page);
        await pinned.getByRole('list', { name: 'Pinned Messages' }).getByRole('button', { name: /^Pinned Message Actions/ }).first().click();
        await page.getByRole('menuitem', { name: 'Select' }).click();
        await expect(selectionTitle(page)).toHaveText('1 Selected');
        await pinned.getByRole('listitem').filter({ hasText: 'First pinned.' }).click();
        await expect(selectionTitle(page)).toHaveText('2 Selected');
        await expect(actionBar(page).getByRole('button')).toHaveText(['Unpin']);

        await actionBar(page).getByRole('button', { name: 'Unpin' }).click();
        await expect(pinned.getByRole('listitem')).toHaveCount(1);
        await expect(pinned.getByRole('listitem')).toContainText('Second pinned.');
        await expect(selectionHeader(page)).toHaveCount(0);
        await expect(page.locator('.toast', { hasText: '2 messages unpinned' })).toBeVisible();
        await expect.poll(async () => (await readRecords(page, conversationId, chatIds[0])).filter(record => record.extra?.conversation_pinned).map(record => record.id)).toEqual(['n-2']);

        await page.getByRole('button', { name: 'Undo' }).click();
        await expect(pinned.getByRole('listitem')).toHaveCount(3);
        await expect.poll(async () => (await readRecords(page, conversationId, chatIds[0])).filter(record => record.extra?.conversation_pinned).map(record => [record.id, record.extra.conversation_pinned_at])).toEqual([['n-1', PIN_TIMES[0]], ['n-2', PIN_TIMES[1]], ['n-3', PIN_TIMES[2]]]);
    });

    test('Select All covers every pinned message, and Cancel keeps them pinned', async ({ page }) => {
        await openSharedPage(page, 'pinned', PIN_CHAT);
        const pinned = shownPage(page);
        await pinned.getByRole('button', { name: 'Select', exact: true }).click();
        await selectionHeader(page).getByRole('button', { name: 'Select All' }).click();
        await expect(selectionTitle(page)).toHaveText('3 Selected');
        await selectionHeader(page).getByRole('button', { name: 'Cancel' }).click();
        await expect(pinned.getByRole('listitem')).toHaveCount(3);
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// A phone: the window is a bottom sheet, and a touch screen has the long press and the buttons, not Shift

test.describe('On a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test('Chats choose rows by touch, keep the action names on icon-only buttons, and Escape leaves selection mode before the page', async ({ page }) => {
        const { avatars } = await openDetailsApp(page);
        const { conversationId } = await seedAndOpen(page, { avatar: avatars[0], chats: FIVE_CHATS });
        await openDetails(page, conversationId, { page: 'chats' });
        const chats = shownPage(page);

        await chats.getByRole('button', { name: 'Select', exact: true }).tap();
        await chats.getByRole('listitem', { name: 'Echo' }).tap();
        await chats.getByRole('listitem', { name: 'Delta' }).tap();
        await expect(selectionTitle(page)).toHaveText('2 Selected');
        await expect(actionBar(page).getByRole('button', { name: 'Export' })).toBeVisible();
        await expect(actionBar(page).getByRole('button', { name: 'Delete' })).toBeVisible();
        for (const name of ['Export', 'Delete']) {
            await expect(actionBar(page).getByRole('button', { name })).toHaveAttribute('title', name);
        }
        // The window shows no label beside the icon under the overlay breakpoint, and no control leaves the viewport.
        const box = await actionBar(page).boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(390);
        expect(box.y + box.height).toBeLessThanOrEqual(844);

        await page.keyboard.press('Escape');
        await expect(selectionHeader(page)).toHaveCount(0);
        await expect(page.locator(DETAILS_HOST)).toHaveCount(1);
        await expect(chats.getByRole('list', { name: 'Chats' })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(shownPage(page).getByRole('list', { name: 'Chats' })).toHaveCount(0);
    });

    test('Media start selection with a long press and choose more with a tap', async ({ page }) => {
        await openSharedPage(page, 'media', PICTURE_CHAT);
        const target = cellOf(page, 'p-2:media:0');
        await target.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 11, isPrimary: true, clientX: 100, clientY: 400, bubbles: true });
        // The press starts selection once it has been held for half a second, which the retry of the assertion waits for.
        await expect(selectionTitle(page)).toHaveText('1 Selected');
        await target.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 11, isPrimary: true, clientX: 100, clientY: 400, bubbles: true });
        await expect(itemOf(page, 'p-2:media:0')).toHaveClass(/is-selection-selected/);
        await cellOf(page, 'p-1:media:0').tap();
        await expect(selectionTitle(page)).toHaveText('2 Selected');
        await expect(page.locator('.sb-details-picture')).toHaveCount(0);
    });

    test('Pinned choose rows by touch and Unpin removes them', async ({ page }) => {
        await openSharedPage(page, 'pinned', PIN_CHAT);
        const pinned = shownPage(page);
        await pinned.getByRole('button', { name: 'Select', exact: true }).tap();
        await selectionHeader(page).getByRole('button', { name: 'Select All' }).tap();
        await expect(selectionTitle(page)).toHaveText('3 Selected');
        await actionBar(page).getByRole('button', { name: 'Unpin' }).tap();
        await expect(pinned.getByText('No Pinned Messages')).toBeVisible();
    });
});
