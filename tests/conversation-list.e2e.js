import { expect, test } from '@playwright/test';
import {
    ITEM,
    LIST,
    MAIN_MENU,
    NEW_MENU,
    ROW,
    SECTION,
    activeElementDescription,
    bootConversationPage,
    centreOf,
    conversationIdOf,
    expectNames,
    namesIn,
    openConversationList,
    readStoredConversation,
    rowNamed,
    sectionOfRow,
    seedConversationList,
} from './helpers/conversation-list-steps.js';
import { DETAILS_HOST } from './helpers/conversation-details.js';

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 120000 });

const FAVORITES = `${SECTION}[data-section="favorites"]`;
const CONVERSATIONS = `${SECTION}[data-section="conversations"]`;
const ALL_NAMES = ['Assistant Reisen', 'Seraphina', 'Weekend plans', 'Assistant Tewi', 'Study group'];

/** Boots the page, seeds the five conversations and opens the list. */
async function openSeededList(page, baseURL) {
    await bootConversationPage(page, baseURL);
    const made = await seedConversationList(page);
    await openConversationList(page);
    await expect(page.locator(`${LIST} ${ROW}`)).toHaveCount(ALL_NAMES.length);
    return made;
}

async function chooseMenuItem(page, name) {
    await page.getByRole('menuitem', { name, exact: true }).click();
}

async function openRowMenuByRightClick(page, name) {
    await rowNamed(page, name).click({ button: 'right' });
    await expect(page.getByRole('menuitem').first()).toBeVisible();
}

/** Presses on a row, moves past the drag distance, and returns once the drag is running. */
async function beginMouseDrag(page, name) {
    const { x, y } = await centreOf(rowNamed(page, name));
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 12, { steps: 3 });
    await expect(page.locator(LIST)).toHaveAttribute('data-dragging', 'true');
    return { x, y };
}

async function moveMouseOverSection(page, selector) {
    const { x, y } = await centreOf(page.locator(selector));
    await page.mouse.move(x, y, { steps: 8 });
}

async function dragRowToFavorites(page, name) {
    await beginMouseDrag(page, name);
    await moveMouseOverSection(page, FAVORITES);
    await expect(page.locator(FAVORITES)).toHaveClass(/is-drop-target/);
    await page.mouse.up();
}

test.describe('the list at a desktop width', () => {
    test('has the persona, New and the main menu in its header, no title, and one section until a row is a favourite', async ({ page, baseURL }) => {
        await openSeededList(page, baseURL);

        const header = page.locator('#sb_conversation_list .sb-conversation-rail-header');
        await expect(header.locator('.sb-conversation-persona-button')).toBeVisible();
        await expect(header.locator(NEW_MENU)).toHaveAccessibleName('New');
        await expect(header.locator(MAIN_MENU)).toHaveAccessibleName('Main Menu');
        await expect(header.getByRole('heading')).toHaveCount(0);
        await expect(page.locator('#sb_conversation_list_search')).toBeVisible();

        await expect(page.locator('.sb-conversation-list-heading-label')).toHaveText(['Favorites', 'Conversations']);
        await expect(page.locator(FAVORITES)).toBeHidden();
        await expect(page.locator(CONVERSATIONS)).toBeVisible();
        await expectNames(page, 'conversations', ALL_NAMES);
        await expectNames(page, 'favorites', []);
    });

    test('shows the name, the preview and the unread badge of a row and no mark for a group', async ({ page, baseURL }) => {
        await openSeededList(page, baseURL);

        const reisen = rowNamed(page, 'Assistant Reisen');
        await expect(reisen.locator('.sb-conversation-list-item-preview')).toHaveText('Ten more minutes.');
        await expect(reisen.locator('.sb-conversation-list-item-unread')).toHaveText('2');
        await expect(reisen.locator(ITEM)).toHaveAccessibleName('Assistant Reisen, 2 Unread');
        const weekend = rowNamed(page, 'Weekend plans');
        await expect(weekend.locator('.sb-conversation-list-item-avatar .sb-conversation-participant-avatar')).toHaveCount(3);
        await expect(weekend.locator('.sb-conversation-list-item-unread')).toBeHidden();
        await expect(page.getByText('Group', { exact: true })).toHaveCount(0);
    });

    test('opens a conversation on a click and marks its row as the current one', async ({ page, baseURL }) => {
        await openSeededList(page, baseURL);

        await rowNamed(page, 'Seraphina').locator(ITEM).click();

        await expect(rowNamed(page, 'Seraphina').locator(ITEM)).toHaveAttribute('aria-current', 'true');
        await expect(page.locator('#sb_conversation_input')).toBeEnabled();
    });

    test('the New menu offers New Conversation, New Group and Mark All as Read, and the first two open their pickers', async ({ page, baseURL }) => {
        await openSeededList(page, baseURL);

        await page.locator(NEW_MENU).click();
        await expect(page.getByRole('menuitem')).toHaveText(['New Conversation', 'New Group', 'Mark All as Read']);
        await chooseMenuItem(page, 'New Conversation');
        await expect(page.locator('.sb-picker')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('.sb-picker')).toHaveCount(0);

        await page.locator(NEW_MENU).click();
        await chooseMenuItem(page, 'New Group');
        await expect(page.getByRole('button', { name: 'Create Group', exact: true })).toBeVisible();
    });

    test('the Main Menu holds Preferences and Help, and Help opens the help window', async ({ page, baseURL }) => {
        await openSeededList(page, baseURL);

        await page.locator(MAIN_MENU).click();
        await expect(page.getByRole('menuitem')).toHaveText(['Preferences', 'Help']);
        await chooseMenuItem(page, 'Help');

        await expect(page.getByRole('dialog', { name: 'Help' })).toBeVisible();
    });

    test('Details opens the details window of the row, even for a conversation that is not open, and Preferences opens its page', async ({ page, baseURL }) => {
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await openSeededList(page, baseURL);

        await openRowMenuByRightClick(page, 'Study group');
        await chooseMenuItem(page, 'Details');
        await expect(page.locator(DETAILS_HOST)).toContainText('Study group');
        await expect(page.locator(`${ITEM}[aria-current="true"]`)).toHaveCount(0);
        await page.keyboard.press('Escape');
        await expect(page.locator(DETAILS_HOST)).toHaveCount(0);

        await page.locator(MAIN_MENU).click();
        await chooseMenuItem(page, 'Preferences');
        await expect(page.locator(DETAILS_HOST)).toContainText('Preferences');
        await page.keyboard.press('Escape');
        await expect(page.locator(DETAILS_HOST)).toHaveCount(0);

        await expect(page.locator(`${LIST} ${ROW}`)).toHaveCount(ALL_NAMES.length);
        expect(errors).toEqual([]);
    });
});

test.describe('the menu of a row', () => {
    test('opens on a right-click with the items of a read row, and Escape closes it and returns focus to the row', async ({ page, baseURL }) => {
        await openSeededList(page, baseURL);

        await openRowMenuByRightClick(page, 'Seraphina');
        await expect(page.getByRole('menuitem')).toHaveText(['Mark as Unread', 'Add to Favorites', 'Mute', 'Details', 'Delete']);
        await page.keyboard.press('Escape');

        await expect(page.getByRole('menuitem')).toHaveCount(0);
        await expect(rowNamed(page, 'Seraphina').locator(ITEM)).toBeFocused();
    });

    test('a row with unread messages offers Mark as Read, which clears the badge and writes the read marker', async ({ page, baseURL }) => {
        const made = await openSeededList(page, baseURL);

        await openRowMenuByRightClick(page, 'Assistant Reisen');
        await expect(page.getByRole('menuitem').first()).toHaveText('Mark as Read');
        await chooseMenuItem(page, 'Mark as Read');

        await expect(rowNamed(page, 'Assistant Reisen').locator('.sb-conversation-list-item-unread')).toBeHidden();
        const stored = await readStoredConversation(page, made.reisen.conversationId);
        expect(stored.chats[0].readThrough).toBe('seed-0-3');
    });

    test('Mark as Unread leaves the last message unread and shows the badge', async ({ page, baseURL }) => {
        const made = await openSeededList(page, baseURL);

        await openRowMenuByRightClick(page, 'Seraphina');
        await chooseMenuItem(page, 'Mark as Unread');

        await expect(rowNamed(page, 'Seraphina').locator('.sb-conversation-list-item-unread')).toHaveText('1');
        const stored = await readStoredConversation(page, made.seraphina.conversationId);
        expect(stored.chats[0].readThrough).toBe('seed-0-1');
        await openRowMenuByRightClick(page, 'Seraphina');
        await expect(page.getByRole('menuitem').first()).toHaveText('Mark as Read');
    });

    test('Add to Favorites moves the row into a Favorites section that appears, keeps focus on it, highlights it and saves `favorite`', async ({ page, baseURL }) => {
        const made = await openSeededList(page, baseURL);

        await openRowMenuByRightClick(page, 'Assistant Tewi');
        await chooseMenuItem(page, 'Add to Favorites');

        await expect(page.locator(FAVORITES)).toBeVisible();
        await expectNames(page, 'favorites', ['Assistant Tewi']);
        await expectNames(page, 'conversations', ['Assistant Reisen', 'Seraphina', 'Weekend plans', 'Study group']);
        await expect(rowNamed(page, 'Assistant Tewi').locator(ITEM)).toBeFocused();
        await expect(rowNamed(page, 'Assistant Tewi')).toHaveClass(/is-just-moved/);
        await expect(page.locator('.sb-conversation-list-status')).toHaveText('Assistant Tewi added to Favorites');
        expect((await readStoredConversation(page, made.tewi.conversationId)).favorite).toBe(true);

        await openRowMenuByRightClick(page, 'Assistant Tewi');
        await expect(page.getByRole('menuitem', { name: 'Remove From Favorites' })).toBeVisible();
        await chooseMenuItem(page, 'Remove From Favorites');
        await expect(page.locator(FAVORITES)).toBeHidden();
        await expectNames(page, 'conversations', ALL_NAMES);
        expect((await readStoredConversation(page, made.tewi.conversationId)).favorite).toBe(false);
    });

    test('Mute shows a bell and writes `notifications_muted`, and Unmute takes both away', async ({ page, baseURL }) => {
        const made = await openSeededList(page, baseURL);

        await openRowMenuByRightClick(page, 'Weekend plans');
        await chooseMenuItem(page, 'Mute');

        await expect(rowNamed(page, 'Weekend plans').locator('.sb-conversation-list-item-muted')).toBeVisible();
        await expect(rowNamed(page, 'Weekend plans').locator(ITEM)).toHaveAccessibleName('Weekend plans, Muted');
        expect((await readStoredConversation(page, made.weekend.conversationId)).settings.notifications_muted).toBe(true);

        await openRowMenuByRightClick(page, 'Weekend plans');
        await chooseMenuItem(page, 'Unmute');
        await expect(rowNamed(page, 'Weekend plans').locator('.sb-conversation-list-item-muted')).toBeHidden();
        expect((await readStoredConversation(page, made.weekend.conversationId)).settings).not.toHaveProperty('notifications_muted');
    });

    test('Delete asks first, keeps the conversation on Cancel and removes it on Delete', async ({ page, baseURL }) => {
        const made = await openSeededList(page, baseURL);

        await openRowMenuByRightClick(page, 'Study group');
        await chooseMenuItem(page, 'Delete');
        await expect(page.getByRole('alertdialog')).toBeVisible();
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(rowNamed(page, 'Study group')).toBeVisible();

        await openRowMenuByRightClick(page, 'Study group');
        await chooseMenuItem(page, 'Delete');
        await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();

        await expect(rowNamed(page, 'Study group')).toHaveCount(0);
        await expectNames(page, 'conversations', ['Assistant Reisen', 'Seraphina', 'Weekend plans', 'Assistant Tewi']);
        expect(await readStoredConversation(page, made.study.conversationId)).toBeNull();
    });

    test('after a Delete that the keyboard made, focus goes to the next row, or to the one before it when the last row went', async ({ page, baseURL }) => {
        await openSeededList(page, baseURL);

        await rowNamed(page, 'Assistant Tewi').locator(ITEM).focus();
        await page.keyboard.press('Shift+F10');
        await page.getByRole('menuitem', { name: 'Delete', exact: true }).press('Enter');
        await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).press('Enter');
        await expect(rowNamed(page, 'Assistant Tewi')).toHaveCount(0);
        await expect(rowNamed(page, 'Study group').locator(ITEM)).toBeFocused();

        await page.keyboard.press('Shift+F10');
        await page.getByRole('menuitem', { name: 'Delete', exact: true }).press('Enter');
        await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).press('Enter');
        await expect(rowNamed(page, 'Study group')).toHaveCount(0);
        await expect(rowNamed(page, 'Weekend plans').locator(ITEM)).toBeFocused();
    });

    test('Cancel in the Delete alert leaves focus where the menu left it, on the row', async ({ page, baseURL }) => {
        await openSeededList(page, baseURL);

        await rowNamed(page, 'Seraphina').locator(ITEM).focus();
        await page.keyboard.press('Shift+F10');
        await page.getByRole('menuitem', { name: 'Delete', exact: true }).press('Enter');
        await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).press('Enter');

        await expect(page.getByRole('alertdialog')).toHaveCount(0);
        await expect(rowNamed(page, 'Seraphina')).toBeVisible();
        await expect(rowNamed(page, 'Seraphina').locator(ITEM)).toBeFocused();
    });

    test('Shift+F10 and the Menu key open it on the focused row with the first item focused', async ({ page, baseURL }) => {
        await openSeededList(page, baseURL);

        await rowNamed(page, 'Seraphina').locator(ITEM).focus();
        await page.keyboard.press('Shift+F10');
        await expect(page.getByRole('menuitem').first()).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(rowNamed(page, 'Seraphina').locator(ITEM)).toBeFocused();

        await page.keyboard.press('ContextMenu');
        await expect(page.getByRole('menuitem')).toHaveText(['Mark as Unread', 'Add to Favorites', 'Mute', 'Details', 'Delete']);
        await expect(page.getByRole('menuitem').first()).toBeFocused();
    });

    test('a secondary click opens the menu and never opens the conversation', async ({ page, baseURL }) => {
        await openSeededList(page, baseURL);

        await openRowMenuByRightClick(page, 'Assistant Tewi');

        await expect(page.locator(`${ITEM}[aria-current="true"]`)).toHaveCount(0);
    });
});

test.describe('moving a row between the sections', () => {
    test('a mouse drag to Favorites shows the ring on the whole section, drops into it, keeps focus and saves', async ({ page, baseURL }) => {
        const made = await openSeededList(page, baseURL);

        await beginMouseDrag(page, 'Assistant Tewi');
        // Favorites is empty and hidden, so the drag shows it as a drop zone with a hint.
        await expect(page.locator(FAVORITES)).toBeVisible();
        await expect(page.locator(`${FAVORITES} .sb-conversation-list-zone-hint`)).toHaveText('Drop here to add to Favorites');
        await expect(page.locator('.sb-conversation-list-ghost')).toBeVisible();
        await expect(rowNamed(page, 'Assistant Tewi')).toHaveClass(/is-drag-source/);
        await moveMouseOverSection(page, FAVORITES);
        await expect(page.locator(FAVORITES)).toHaveClass(/is-drop-target/);
        await expect(page.locator(CONVERSATIONS)).not.toHaveClass(/is-drop-target/);
        const ring = await page.locator(FAVORITES).evaluate(element => getComputedStyle(element).boxShadow);
        expect(ring).toContain('inset');
        expect(ring).toContain('2px');
        await page.mouse.up();

        await expect(page.locator(LIST)).not.toHaveAttribute('data-dragging', 'true');
        await expect(page.locator('.sb-conversation-list-ghost')).toHaveCount(0);
        await expectNames(page, 'favorites', ['Assistant Tewi']);
        await expect(rowNamed(page, 'Assistant Tewi').locator(ITEM)).toBeFocused();
        await expect(rowNamed(page, 'Assistant Tewi')).toHaveClass(/is-just-moved/);
        await expect(page.locator(`${ITEM}[aria-current="true"]`)).toHaveCount(0);
        expect((await readStoredConversation(page, made.tewi.conversationId)).favorite).toBe(true);
    });

    test('a drag back to Conversations takes the row out of Favorites, and the row lands in the order of its section', async ({ page, baseURL }) => {
        await openSeededList(page, baseURL);
        await dragRowToFavorites(page, 'Assistant Tewi');
        await expect(page.locator(FAVORITES)).toBeVisible();

        await beginMouseDrag(page, 'Assistant Tewi');
        await moveMouseOverSection(page, CONVERSATIONS);
        await expect(page.locator(CONVERSATIONS)).toHaveClass(/is-drop-target/);
        await page.mouse.up();

        await expect(page.locator(FAVORITES)).toBeHidden();
        await expectNames(page, 'conversations', ALL_NAMES);
    });

    test('Escape during a drag cancels it: nothing moves, the ring and the ghost go, and the release opens nothing', async ({ page, baseURL }) => {
        const made = await openSeededList(page, baseURL);

        await beginMouseDrag(page, 'Assistant Tewi');
        await moveMouseOverSection(page, FAVORITES);
        await expect(page.locator(FAVORITES)).toHaveClass(/is-drop-target/);
        await page.keyboard.press('Escape');

        await expect(page.locator(LIST)).not.toHaveAttribute('data-dragging', 'true');
        await expect(page.locator('.sb-conversation-list-ghost')).toHaveCount(0);
        await expect(page.locator('.is-drop-target')).toHaveCount(0);
        await expect(page.locator('.sb-conversation-list-status')).toHaveText('Move cancelled.');
        await page.mouse.up();
        await expectNames(page, 'favorites', []);
        await expectNames(page, 'conversations', ALL_NAMES);
        await expect(page.locator(`${ITEM}[aria-current="true"]`)).toHaveCount(0);
        expect((await readStoredConversation(page, made.tewi.conversationId)).favorite).toBe(false);
    });

    test('a drop on the section the row came from, or outside both, changes nothing', async ({ page, baseURL }) => {
        await openSeededList(page, baseURL);

        await beginMouseDrag(page, 'Seraphina');
        await moveMouseOverSection(page, CONVERSATIONS);
        await expect(page.locator('.is-drop-target')).toHaveCount(0);
        await page.mouse.up();
        await expectNames(page, 'conversations', ALL_NAMES);

        await beginMouseDrag(page, 'Seraphina');
        await page.mouse.move(1300, 800, { steps: 6 });
        await page.mouse.up();
        await expectNames(page, 'favorites', []);
        await expect(page.locator(`${ITEM}[aria-current="true"]`)).toHaveCount(0);
    });

    test('a plain click, with a small move of the mouse, is still a click that opens the conversation', async ({ page, baseURL }) => {
        await openSeededList(page, baseURL);

        const { x, y } = await centreOf(rowNamed(page, 'Seraphina'));
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 2, y + 1);
        await page.mouse.up();

        await expect(rowNamed(page, 'Seraphina').locator(ITEM)).toHaveAttribute('aria-current', 'true');
    });

    test('resting on a collapsed Favorites opens it, and the drop lands in it', async ({ page, baseURL }) => {
        await openSeededList(page, baseURL);
        await dragRowToFavorites(page, 'Seraphina');
        await page.locator('.sb-conversation-list-heading-button').click();
        await expect(page.locator('.sb-conversation-list-heading-button')).toHaveAttribute('aria-expanded', 'false');
        await expect(rowNamed(page, 'Seraphina')).toBeHidden();

        await beginMouseDrag(page, 'Weekend plans');
        await moveMouseOverSection(page, FAVORITES);
        await expect(page.locator('.sb-conversation-list-heading-button')).toHaveAttribute('aria-expanded', 'true');
        await page.mouse.up();

        await expectNames(page, 'favorites', ['Seraphina', 'Weekend plans']);
    });

    test('the heading of Favorites collapses it, shows the unread count while it is collapsed, and opens it again', async ({ page, baseURL }) => {
        await openSeededList(page, baseURL);
        await openRowMenuByRightClick(page, 'Assistant Reisen');
        await chooseMenuItem(page, 'Add to Favorites');
        const heading = page.locator('.sb-conversation-list-heading-button');
        const badge = page.locator('.sb-conversation-list-heading-badge');

        await expect(badge).toBeHidden();
        await heading.click();
        await expect(heading).toHaveAttribute('aria-expanded', 'false');
        await expect(rowNamed(page, 'Assistant Reisen')).toBeHidden();
        await expect(badge).toHaveText('2');

        await heading.focus();
        await page.keyboard.press('Enter');
        await expect(heading).toHaveAttribute('aria-expanded', 'true');
        await expect(rowNamed(page, 'Assistant Reisen')).toBeVisible();
        await expect(badge).toBeHidden();
    });

    test('Alt+Up and Alt+Down move the focused row to the section above or below, keep focus on it and announce the move', async ({ page, baseURL }) => {
        const made = await openSeededList(page, baseURL);

        await rowNamed(page, 'Seraphina').locator(ITEM).focus();
        await page.keyboard.press('Alt+ArrowUp');
        await expectNames(page, 'favorites', ['Seraphina']);
        await expect(rowNamed(page, 'Seraphina').locator(ITEM)).toBeFocused();
        await expect(page.locator('.sb-conversation-list-status')).toHaveText('Seraphina added to Favorites');
        expect((await readStoredConversation(page, made.seraphina.conversationId)).favorite).toBe(true);

        await page.keyboard.press('Alt+ArrowUp');
        await expectNames(page, 'favorites', ['Seraphina']);

        await page.keyboard.press('Alt+ArrowDown');
        await expectNames(page, 'favorites', []);
        await expect(rowNamed(page, 'Seraphina').locator(ITEM)).toBeFocused();
        await expect(page.locator('.sb-conversation-list-status')).toHaveText('Seraphina removed from Favorites');

        await page.keyboard.press('Alt+Home');
        await expectNames(page, 'favorites', ['Seraphina']);
        await page.keyboard.press('Alt+End');
        await expectNames(page, 'favorites', []);
    });

    test('while a search filters, a drag does not start and Alt+Up declines, but the menu still moves the row', async ({ page, baseURL }) => {
        await openSeededList(page, baseURL);
        await page.locator('#sb_conversation_list_search').fill('tewi');
        await expect(page.locator(`${LIST} ${ROW}`)).toHaveCount(1);
        await expect(page.locator(LIST)).toHaveAttribute('data-searching', 'true');
        await expect(page.locator('.sb-conversation-list-heading-label')).toHaveText(['Favorites', 'Conversations']);
        await expect(page.locator(FAVORITES)).toBeHidden();

        const { x, y } = await centreOf(rowNamed(page, 'Assistant Tewi'));
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x, y + 30, { steps: 5 });
        await expect(page.locator(LIST)).not.toHaveAttribute('data-dragging', 'true');
        await page.mouse.up();
        await rowNamed(page, 'Assistant Tewi').locator(ITEM).focus();
        await page.keyboard.press('Alt+ArrowUp');
        await expectNames(page, 'favorites', []);

        await openRowMenuByRightClick(page, 'Assistant Tewi');
        await chooseMenuItem(page, 'Add to Favorites');
        await page.locator('#sb_conversation_list_search').fill('');
        await expect(page.locator(FAVORITES)).toBeVisible();
        await expectNames(page, 'favorites', ['Assistant Tewi']);
    });

    test('a search that matches nothing says so, and clearing it brings the sections back', async ({ page, baseURL }) => {
        await openSeededList(page, baseURL);

        await page.locator('#sb_conversation_list_search').fill('zzzz');
        await expect(page.getByText('No Conversations Found')).toBeVisible();
        await expect(page.locator(`${LIST} ${ROW}`)).toHaveCount(0);
        await page.locator('#sb_conversation_list_search').fill('');

        await expect(page.locator(`${LIST} ${ROW}`)).toHaveCount(ALL_NAMES.length);
        await expect(page.getByText('No Conversations Found')).toBeHidden();
    });
});

test.describe('the keyboard in the list', () => {
    test('is one Tab stop: Tab enters on a row, passes no other row, leaves, and Shift+Tab returns to the row that was last visited', async ({ page, baseURL }) => {
        await openSeededList(page, baseURL);
        await openRowMenuByRightClick(page, 'Seraphina');
        await chooseMenuItem(page, 'Add to Favorites');
        await page.locator('#sb_conversation_list_search').focus();

        await page.keyboard.press('Tab');
        expect(await activeElementDescription(page)).toMatchObject({ inList: true });
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        const visited = (await activeElementDescription(page)).row;
        expect(visited).not.toBe('');

        await page.keyboard.press('Tab');
        expect((await activeElementDescription(page)).inList).toBe(false);
        await page.keyboard.press('Shift+Tab');
        expect(await activeElementDescription(page)).toMatchObject({ inList: true, row: visited });
        await page.keyboard.press('Shift+Tab');
        expect((await activeElementDescription(page)).inList).toBe(false);
    });

    test('the arrow keys, Home and End move between the rows, across the Favorites heading', async ({ page, baseURL }) => {
        await openSeededList(page, baseURL);
        await openRowMenuByRightClick(page, 'Seraphina');
        await chooseMenuItem(page, 'Add to Favorites');
        await rowNamed(page, 'Seraphina').locator(ITEM).focus();

        await page.keyboard.press('ArrowUp');
        expect(await activeElementDescription(page)).toMatchObject({ heading: true });
        await page.keyboard.press('ArrowDown');
        expect(await activeElementDescription(page)).toMatchObject({ row: 'Seraphina' });
        await page.keyboard.press('ArrowDown');
        expect(await activeElementDescription(page)).toMatchObject({ row: 'Assistant Reisen' });
        await page.keyboard.press('End');
        expect(await activeElementDescription(page)).toMatchObject({ row: 'Study group' });
        await page.keyboard.press('Home');
        expect(await activeElementDescription(page)).toMatchObject({ heading: true });
        await page.keyboard.press('Enter');
        await expect(page.locator('.sb-conversation-list-heading-button')).toHaveAttribute('aria-expanded', 'false');
    });

    test('Enter on a row opens the conversation', async ({ page, baseURL }) => {
        await openSeededList(page, baseURL);

        await rowNamed(page, 'Assistant Tewi').locator(ITEM).focus();
        await page.keyboard.press('Enter');

        await expect(rowNamed(page, 'Assistant Tewi').locator(ITEM)).toHaveAttribute('aria-current', 'true');
    });
});

test.describe('rows that change under the list', () => {
    test('a new message moves a conversation to the top of its section without taking focus from the row that has it', async ({ page, baseURL }) => {
        const made = await openSeededList(page, baseURL);
        await rowNamed(page, 'Assistant Tewi').locator(ITEM).focus();
        const node = await rowNamed(page, 'Assistant Tewi').elementHandle();

        await page.evaluate(async ({ id }) => {
            const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
            const view = conversationData.get(id);
            const address = { conversationId: id, chatId: view.activeChatId };
            await conversationData.loadChat(address);
            conversationData.commitChat(address, (chat) => {
                chat.messages.push({ id: 'late-1', role: 'character', name: 'Tewi', is_user: false, is_system: false, mes: 'A new message', created_at: Date.now(), send_date: new Date().toISOString(), extra: {} });
            });
        }, { id: made.tewi.conversationId });

        await expect.poll(() => namesIn(page, 'conversations')).toEqual(['Assistant Tewi', 'Assistant Reisen', 'Seraphina', 'Weekend plans', 'Study group']);
        await expect(rowNamed(page, 'Assistant Tewi').locator(ITEM)).toBeFocused();
        expect(await node.evaluate((element, id) => element.isConnected && element.dataset.conversationId === id, made.tewi.conversationId)).toBe(true);
        expect(await sectionOfRow(rowNamed(page, 'Assistant Tewi'))).toBe('conversations');
        expect(await conversationIdOf(rowNamed(page, 'Assistant Tewi'))).toBe(made.tewi.conversationId);
    });
});

// Playwright's Firefox and WebKit offer only a tap on a touch screen, so a long press and a touch drag are driven in Chromium, with
// the touch events of the DevTools protocol. The mouse, the keyboard and the layout of the phone run in every engine.
test.describe('the list by touch on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    const LONG_PRESS_MS = 600;
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

    async function openTouchList(page, baseURL, options) {
        const made = await openSeededList(page, baseURL, options);
        await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-layout', 'pages');
        await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-page', 'list');
        return made;
    }

    async function touchClient(page) {
        return page.context().newCDPSession(page);
    }

    async function touchPoint(client, type, x, y) {
        await client.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    }

    async function moveFinger(client, from, to, { steps = 12, stepMs = 16 } = {}) {
        for (let step = 1; step <= steps; step++) {
            await touchPoint(client, 'touchMove', from.x + ((to.x - from.x) * step) / steps, from.y + ((to.y - from.y) * step) / steps);
            await wait(stepMs);
        }
    }

    test.beforeEach(({ browserName }) => {
        // eslint-disable-next-line playwright/no-skipped-test -- Only Chromium offers the DevTools protocol that sends the touch events.
        test.skip(browserName !== 'chromium', 'touch events are driven with the DevTools protocol');
    });

    test('a tap opens the conversation and shows its page', async ({ page, baseURL }) => {
        await openTouchList(page, baseURL);

        await rowNamed(page, 'Seraphina').locator(ITEM).tap();

        await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-page', 'chat');
    });

    test('a long press that ends without a move opens the menu as a sheet, and the click that follows picks nothing', async ({ page, baseURL }) => {
        await openTouchList(page, baseURL);
        const client = await touchClient(page);
        const { x, y } = await centreOf(rowNamed(page, 'Seraphina'));

        await touchPoint(client, 'touchStart', x, y);
        await wait(LONG_PRESS_MS);
        await expect(rowNamed(page, 'Seraphina')).toHaveClass(/is-lifted/);
        await touchPoint(client, 'touchEnd', 0, 0);

        await expect(page.getByRole('menuitem')).toHaveText(['Mark as Unread', 'Add to Favorites', 'Mute', 'Details', 'Delete']);
        await expect(rowNamed(page, 'Seraphina')).not.toHaveClass(/is-lifted/);
        // The menu is a bottom sheet on a phone: as wide as the screen and attached to its lower edge.
        const menu = page.getByRole('menu');
        await expect.poll(async () => (await menu.boundingBox())?.width ?? 0).toBeGreaterThan(340);
        await expect.poll(async () => {
            const box = await menu.boundingBox();
            return 844 - (box.y + box.height);
        }).toBeLessThan(24);
        await wait(900);
        await expect(page.getByRole('menuitem')).toHaveCount(5);
        await expectNames(page, 'favorites', []);
        await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-page', 'list');
        await expect(page.getByRole('menuitem').first()).toBeVisible();
        for (const item of await page.getByRole('menuitem').all()) {
            expect((await item.boundingBox()).height).toBeGreaterThanOrEqual(44);
        }
    });

    test('a long press and a move drags the row into Favorites, and no menu opens', async ({ page, baseURL }) => {
        const made = await openTouchList(page, baseURL);
        const client = await touchClient(page);
        const start = await centreOf(rowNamed(page, 'Assistant Tewi'));

        await touchPoint(client, 'touchStart', start.x, start.y);
        await wait(LONG_PRESS_MS);
        await moveFinger(client, start, { x: start.x, y: start.y + 24 }, { steps: 4 });
        await expect(page.locator(LIST)).toHaveAttribute('data-dragging', 'true');
        const zone = await centreOf(page.locator(FAVORITES));
        await moveFinger(client, { x: start.x, y: start.y + 24 }, zone);
        await expect(page.locator(FAVORITES)).toHaveClass(/is-drop-target/);
        await touchPoint(client, 'touchEnd', 0, 0);

        await expectNames(page, 'favorites', ['Assistant Tewi']);
        await expect(page.getByRole('menuitem')).toHaveCount(0);
        await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-page', 'list');
        expect((await readStoredConversation(page, made.tewi.conversationId)).favorite).toBe(true);
    });

    test('a drag released over the section it started in changes nothing and opens no menu', async ({ page, baseURL }) => {
        await openTouchList(page, baseURL);
        const client = await touchClient(page);
        const start = await centreOf(rowNamed(page, 'Seraphina'));

        await touchPoint(client, 'touchStart', start.x, start.y);
        await wait(LONG_PRESS_MS);
        await moveFinger(client, start, { x: start.x, y: start.y + 40 }, { steps: 5 });
        await touchPoint(client, 'touchEnd', 0, 0);
        await wait(300);

        await expectNames(page, 'conversations', ALL_NAMES);
        await expect(page.getByRole('menuitem')).toHaveCount(0);
        await expect(page.locator(LIST)).not.toHaveAttribute('data-dragging', 'true');
    });

    test('a quick swipe on a row scrolls the list: no drag, no menu, nothing opens', async ({ page, baseURL }) => {
        await openTouchList(page, baseURL);
        await page.setViewportSize({ width: 390, height: 400 });
        const client = await touchClient(page);
        const start = await centreOf(rowNamed(page, 'Assistant Tewi'));

        await touchPoint(client, 'touchStart', start.x, start.y);
        await moveFinger(client, start, { x: start.x, y: start.y - 140 }, { steps: 10, stepMs: 10 });
        await touchPoint(client, 'touchEnd', 0, 0);

        await expect.poll(() => page.locator(LIST).evaluate(element => element.scrollTop)).toBeGreaterThan(0);
        await expect(page.getByRole('menuitem')).toHaveCount(0);
        await expect(page.locator(LIST)).not.toHaveAttribute('data-dragging', 'true');
        await expect(page.locator(`${ITEM}[aria-current="true"]`)).toHaveCount(0);
        await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-page', 'list');
    });

    test('the heading of Favorites is a touch target of 44px', async ({ page, baseURL }) => {
        await openTouchList(page, baseURL);
        await rowNamed(page, 'Seraphina').locator(ITEM).focus();
        await page.keyboard.press('Alt+ArrowUp');
        await expectNames(page, 'favorites', ['Seraphina']);

        const box = await page.locator('.sb-conversation-list-heading-button').boundingBox();

        expect(box.height).toBeGreaterThanOrEqual(44);
    });
});

test.describe('the list on a narrow phone', () => {
    test.use({ viewport: { width: 360, height: 640 }, hasTouch: true });

    test('keeps the header, the search and the rows inside the width, with no horizontal scroll', async ({ page, baseURL }) => {
        await openSeededList(page, baseURL);

        const overflow = await page.locator('#sb_conversation_list').evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }));
        expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
        for (const selector of ['.sb-conversation-persona-button', NEW_MENU, MAIN_MENU, '#sb_conversation_list_search']) {
            const box = await page.locator(selector).boundingBox();
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(360);
        }
        for (const selector of [NEW_MENU, MAIN_MENU]) {
            const box = await page.locator(selector).boundingBox();
            expect(box.width).toBeGreaterThanOrEqual(40);
            expect(box.height).toBeGreaterThanOrEqual(40);
        }
    });
});
