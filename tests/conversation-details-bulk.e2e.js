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

/** The files of a downloaded ZIP and their text, read by the library that the page ships. */
async function readZip(page, download) {
    const bytes = [...readFileSync(await download.path())];
    return page.evaluate(async (data) => {
        if (!window.JSZip) {
            await import('/lib/jszip.min.js');
        }
        const zip = await window.JSZip.loadAsync(Uint8Array.from(data));
        const files = {};
        for (const [name, file] of Object.entries(zip.files)) {
            files[name] = await file.async('string');
        }
        return files;
    }, bytes);
}

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
        await expect(selectionTitle(page)).toHaveText('0 selected');
        await expect(selectionHeader(page).getByRole('button', { name: 'Cancel' })).toBeFocused();
        await expect(actionBar(page).getByRole('button', { name: 'Export' })).toBeDisabled();

        await chats.getByRole('listitem', { name: 'Echo' }).click();
        await expect(selectionTitle(page)).toHaveText('1 selected');
        await chats.getByRole('listitem', { name: 'Charlie' }).click({ modifiers: ['Shift'] });
        await expect(selectionTitle(page)).toHaveText('3 selected');
        await expect(chats.getByRole('checkbox', { name: 'Select Delta' })).toBeChecked();
        await expect(actionBar(page).getByRole('button', { name: 'Delete' })).toBeEnabled();

        await selectionHeader(page).getByRole('button', { name: 'Select All' }).click();
        await expect(selectionTitle(page)).toHaveText('5 selected');
        await selectionHeader(page).getByRole('button', { name: 'Select All' }).click();
        await expect(selectionTitle(page)).toHaveText('0 selected');

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
        await expect(selectionTitle(page)).toHaveText('1 selected');
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
        expect(files['Echo.jsonl']).toContain('Hello from Echo');
        expect(files['Bravo.jsonl']).not.toContain('Hello from Echo');
        const lines = files['Echo.jsonl'].trim().split('\n').map(line => JSON.parse(line));
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
        await expect(selectionTitle(page)).toHaveText('2 selected');
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
        await expect(selectionTitle(page)).toHaveText('56 selected');
        await expect(chats.getByRole('checkbox', { name: 'Select Chat 56' })).toBeChecked();

        await chats.getByRole('button', { name: 'Show More' }).click();
        await expect(chats.getByRole('list', { name: 'Chats' }).getByRole('listitem')).toHaveCount(56);
        await expect(chats.getByRole('button', { name: 'Show More' })).toBeHidden();
        await expect(chats.getByRole('checkbox', { name: 'Select Chat 01' })).toBeChecked();
        await expect(selectionTitle(page)).toHaveText('56 selected');
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
});

// Used by the specs of the pages below; kept here so that one run of this file covers the helpers.
export { callRoute, showToasts };
