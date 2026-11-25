import { expect, test } from '@playwright/test';
import {
    ITEM,
    LIST,
    ROW,
    SECTION,
    bootConversationPage,
    centreOf,
    expectNames,
    headingLabels,
    headingOf,
    newFolderId,
    openConversationList,
    patchConversation,
    readStoredConversation,
    readStoredFolders,
    rowNamed,
    seedConversationList,
    seedFolders,
} from './helpers/conversation-list-steps.js';

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 120000 });

const ALL_NAMES = ['Assistant Reisen', 'Seraphina', 'Weekend plans', 'Assistant Tewi', 'Study group'];

/** Boots the page, seeds the five conversations and the folders that a case asks for, and opens the list. */
async function openFoldersList(page, baseURL, { folders = [], members = {}, closedFavorites = false } = {}) {
    const persona = await bootConversationPage(page, baseURL);
    const made = await seedConversationList(page);
    const ids = folders.map(() => newFolderId());
    const ops = [
        ...folders.map((folder, index) => ({ op: 'createFolder', id: ids[index], name: folder.name, color: folder.color ?? '', expanded: folder.expanded ?? true })),
        ...Object.entries(members).map(([key, folderIndex]) => ({ op: 'setMembers', ids: [made[key].conversationId], folderId: ids[folderIndex] })),
        ...(closedFavorites ? [{ op: 'setFavoritesExpanded', expanded: false }] : []),
    ];
    if (ops.length) {
        expect((await seedFolders(page, persona, ops)).status).toBe(200);
    }
    await openConversationList(page);
    // The rows of a closed folder are not in the list.
    const hidden = Object.values(members).filter(folderIndex => folders[folderIndex].expanded === false).length;
    await expect(page.locator(`${LIST} ${ROW}`)).toHaveCount(ALL_NAMES.length - hidden);
    return { persona, made, ids };
}

const section = (page, key) => page.locator(`${LIST} ${SECTION}[data-section="${key}"]`);

test.describe('the folders in the list', () => {
    test('read the file only when the workspace opens, and not before', async ({ page, baseURL }) => {
        const requests = [];
        page.on('request', request => requests.push(new URL(request.url()).pathname));
        const persona = await bootConversationPage(page, baseURL);
        await seedConversationList(page);

        expect(requests.filter(path => path.includes('/folders/'))).toEqual([]);
        await seedFolders(page, persona, [{ op: 'createFolder', id: newFolderId(), name: 'Work' }]);
        requests.length = 0;
        await openConversationList(page);

        await expect.poll(() => requests.filter(path => path.endsWith('/folders/get')).length).toBe(1);
        await expect(headingOf(page, 'conversations')).toHaveCount(0);
        expect(await headingLabels(page)).toEqual(['Favorites', 'Work', 'Conversations']);
    });

    test('are sections between Favorites and Conversations, in their stored order, with a colour dot and the number of rows; an empty one keeps its heading', async ({ page, baseURL }) => {
        const { ids } = await openFoldersList(page, baseURL, {
            folders: [{ name: 'Work', color: 'rgb(200, 30, 30)' }, { name: 'Friends' }, { name: 'Empty' }],
            members: { seraphina: 0, tewi: 0, study: 1 },
        });

        expect(await headingLabels(page)).toEqual(['Favorites', 'Work', 'Friends', 'Empty', 'Conversations']);
        await expectNames(page, `folder:${ids[0]}`, ['Seraphina', 'Assistant Tewi']);
        await expectNames(page, `folder:${ids[1]}`, ['Study group']);
        await expectNames(page, `folder:${ids[2]}`, []);
        await expectNames(page, 'conversations', ['Assistant Reisen', 'Weekend plans']);
        await expect(section(page, 'favorites')).toBeHidden();
        await expect(section(page, `folder:${ids[2]}`)).toBeVisible();
        await expect(section(page, `folder:${ids[0]}`).locator('.sb-conversation-list-heading-count')).toHaveText('2');
        await expect(section(page, `folder:${ids[2]}`).locator('.sb-conversation-list-heading-count')).toHaveText('0');
        await expect(section(page, `folder:${ids[0]}`).locator('.sb-conversation-list-folder-dot')).toHaveCSS('background-color', 'rgb(200, 30, 30)');
        await expect(headingOf(page, `folder:${ids[0]}`)).toHaveAccessibleName(/^Work\s*2$/);
    });

    test('a favourite that is filed in a folder shows only in Favorites, and returns to its folder when it is not a favourite any more', async ({ page, baseURL }) => {
        const { ids, made, persona } = await openFoldersList(page, baseURL, { folders: [{ name: 'Work' }], members: { seraphina: 0, tewi: 0 } });
        const folderKey = `folder:${ids[0]}`;

        await patchConversation(page, made.seraphina.conversationId, { favorite: true });
        await expectNames(page, 'favorites', ['Seraphina']);
        await expectNames(page, folderKey, ['Assistant Tewi']);
        await expect(section(page, folderKey).locator('.sb-conversation-list-heading-count')).toHaveText('1');

        await patchConversation(page, made.seraphina.conversationId, { favorite: false });
        await expectNames(page, 'favorites', []);
        await expectNames(page, folderKey, ['Seraphina', 'Assistant Tewi']);
        expect((await readStoredFolders(page, persona)).members).toEqual({ [made.seraphina.conversationId]: ids[0], [made.tewi.conversationId]: ids[0] });
    });

    test('a closed folder holds its rows out of the list and shows the unread count of its rows, and its heading opens it', async ({ page, baseURL }) => {
        const { ids } = await openFoldersList(page, baseURL, { folders: [{ name: 'Work', expanded: false }], members: { reisen: 0, seraphina: 0 } });
        const key = `folder:${ids[0]}`;
        const heading = headingOf(page, key);

        await expect(heading).toHaveAttribute('aria-expanded', 'false');
        await expect(section(page, key).locator(ROW)).toHaveCount(0);
        await expect(heading.locator('.sb-conversation-list-heading-badge')).toHaveText(/^2/);
        await expect(heading.locator('.sb-conversation-list-heading-count')).toHaveText('2');

        await heading.click();
        await expect(heading).toHaveAttribute('aria-expanded', 'true');
        await expectNames(page, key, ['Assistant Reisen', 'Seraphina']);
        await expect(heading.locator('.sb-conversation-list-heading-badge')).toBeHidden();
    });

    test('remember which folders are open and whether Favorites is open, after a reload', async ({ page, baseURL }) => {
        const { persona, ids } = await openFoldersList(page, baseURL, { folders: [{ name: 'Work' }, { name: 'Friends' }], members: { seraphina: 0 } });
        const [work, friends] = ids.map(id => `folder:${id}`);
        await expect(section(page, work).locator(ROW)).toHaveCount(1);

        await headingOf(page, work).click();
        await headingOf(page, friends).click();
        await expect(headingOf(page, work)).toHaveAttribute('aria-expanded', 'false');
        await expect(headingOf(page, friends)).toHaveAttribute('aria-expanded', 'false');
        await expect.poll(async () => (await readStoredFolders(page, persona))?.folders.map(folder => folder.expanded)).toEqual([false, false]);

        // Quick Image Gen asks about the browser-only settings of the first load on a second one, as it does not in a fresh test.
        await page.addInitScript(() => window.localStorage.clear());
        await page.reload({ waitUntil: 'domcontentloaded' });
        await openConversationList(page);
        await expect(headingOf(page, work)).toHaveAttribute('aria-expanded', 'false');
        await expect(headingOf(page, friends)).toHaveAttribute('aria-expanded', 'false');
        await headingOf(page, friends).click();
        await expect(headingOf(page, friends)).toHaveAttribute('aria-expanded', 'true');
    });

    test('Favorites keeps its closed state across a reload', async ({ page, baseURL }) => {
        const { persona, made } = await openFoldersList(page, baseURL, { folders: [{ name: 'Work' }] });
        await patchConversation(page, made.tewi.conversationId, { favorite: true });
        await expectNames(page, 'favorites', ['Assistant Tewi']);

        await headingOf(page, 'favorites').click();
        await expect(headingOf(page, 'favorites')).toHaveAttribute('aria-expanded', 'false');
        await expect.poll(async () => (await readStoredFolders(page, persona))?.favoritesExpanded).toBe(false);

        await page.addInitScript(() => window.localStorage.clear());
        await page.reload({ waitUntil: 'domcontentloaded' });
        await openConversationList(page);
        await expect(headingOf(page, 'favorites')).toHaveAttribute('aria-expanded', 'false');
        await expect(section(page, 'favorites').locator(ROW)).toHaveCount(0);
    });

    test('keep the folders of each persona apart', async ({ page, baseURL, browser }) => {
        const first = await openFoldersList(page, baseURL, { folders: [{ name: 'Mine' }] });
        const other = await browser.newPage();
        try {
            const second = await openFoldersList(other, baseURL, { folders: [{ name: 'Theirs' }, { name: 'Also theirs' }] });

            expect(first.persona).not.toBe(second.persona);
            expect(await headingLabels(page)).toEqual(['Favorites', 'Mine', 'Conversations']);
            expect(await headingLabels(other)).toEqual(['Favorites', 'Theirs', 'Also theirs', 'Conversations']);
        } finally {
            await other.close();
        }
    });
});

test.describe('a search among the folders', () => {
    test('groups the matches under their sections, opens a closed folder that has one and hides the sections that have none', async ({ page, baseURL }) => {
        const { ids, made } = await openFoldersList(page, baseURL, {
            folders: [{ name: 'Work', expanded: false }, { name: 'Friends' }],
            members: { tewi: 0, study: 0, seraphina: 1 },
        });
        await patchConversation(page, made.weekend.conversationId, { favorite: true });
        const [work, friends] = ids.map(id => `folder:${id}`);

        await page.locator('#sb_conversation_list_search').fill('study');
        await expect(page.locator(LIST)).toHaveAttribute('data-searching', 'true');
        await expect(page.locator(`${LIST} ${ROW}`)).toHaveCount(1);
        await expectNames(page, work, ['Study group']);
        await expect(headingOf(page, work)).toHaveAttribute('aria-expanded', 'true');
        await expect(section(page, friends)).toBeHidden();
        await expect(section(page, 'favorites')).toBeHidden();
        await expect(section(page, 'conversations')).toBeHidden();

        await headingOf(page, work).click();
        await expect(headingOf(page, work)).toHaveAttribute('aria-expanded', 'true');

        await page.locator('#sb_conversation_list_search').fill('weekend');
        await expectNames(page, 'favorites', ['Weekend plans']);
        await expect(section(page, work)).toBeHidden();

        await page.locator('#sb_conversation_list_search').fill('');
        await expect(headingOf(page, work)).toHaveAttribute('aria-expanded', 'false');
        await expect(section(page, friends)).toBeVisible();
        await expect(page.locator(`${LIST} ${ROW}`)).toHaveCount(ALL_NAMES.length - 2);
    });

    test('says so when nothing matches and shows no folder', async ({ page, baseURL }) => {
        await openFoldersList(page, baseURL, { folders: [{ name: 'Work' }], members: { tewi: 0 } });

        await page.locator('#sb_conversation_list_search').fill('zzzz');

        await expect(page.getByText('No Conversations Found')).toBeVisible();
        await expect(page.locator(`${LIST} .sb-conversation-list-heading-button:visible`)).toHaveCount(0);
        await expect(rowNamed(page, 'Assistant Tewi')).toHaveCount(0);
    });
});

const STATUS = '.sb-conversation-list-status';
const chooseMenuItem = (page, name) => page.getByRole('menuitem', { name, exact: true }).click();
const folderKeys = ids => ids.map(id => `folder:${id}`);

/** Presses on a row, moves past the drag distance, and returns once the drag is running. */
async function beginMouseDrag(page, name) {
    const { x, y } = await centreOf(rowNamed(page, name));
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 12, { steps: 3 });
    await expect(page.locator(LIST)).toHaveAttribute('data-dragging', 'true');
}

async function moveMouseOver(page, locator) {
    const { x, y } = await centreOf(locator);
    await page.mouse.move(x, y, { steps: 8 });
}

async function openRowMenu(page, name) {
    await rowNamed(page, name).click({ button: 'right' });
    await expect(page.getByRole('menuitem').first()).toBeVisible();
}

async function filedIn(page, persona, conversationId) {
    return (await readStoredFolders(page, persona))?.members?.[conversationId] ?? '';
}

test.describe('moving a row into a folder by the mouse', () => {
    test('a drag onto an open folder shows the ring on the whole section, drops into it, keeps focus, highlights the row, announces it and saves the folder', async ({ page, baseURL }) => {
        const { ids, made, persona } = await openFoldersList(page, baseURL, { folders: [{ name: 'Work' }, { name: 'Friends' }] });
        const [work] = folderKeys(ids);

        await beginMouseDrag(page, 'Seraphina');
        await moveMouseOver(page, section(page, work));
        await expect(section(page, work)).toHaveClass(/is-drop-target/);
        await page.mouse.up();

        await expectNames(page, work, ['Seraphina']);
        await expect(rowNamed(page, 'Seraphina').locator(ITEM)).toBeFocused();
        await expect(rowNamed(page, 'Seraphina')).toHaveClass(/is-just-moved/);
        await expect(page.locator(STATUS)).toHaveText('Seraphina moved to Work');
        await expect(section(page, work).locator('.sb-conversation-list-heading-count')).toHaveText('1');
        await expect.poll(() => filedIn(page, persona, made.seraphina.conversationId)).toBe(ids[0]);
        expect((await readStoredConversation(page, made.seraphina.conversationId)).favorite).toBe(false);
    });

    test('a drop on a closed folder opens it and stores that, so that the row stays in sight', async ({ page, baseURL }) => {
        const { ids, persona } = await openFoldersList(page, baseURL, { folders: [{ name: 'Work', expanded: false }] });
        const [work] = folderKeys(ids);

        await beginMouseDrag(page, 'Assistant Tewi');
        await moveMouseOver(page, section(page, work));
        await expect(section(page, work)).toHaveClass(/is-drop-target/);
        await page.mouse.up();

        await expect(headingOf(page, work)).toHaveAttribute('aria-expanded', 'true');
        await expectNames(page, work, ['Assistant Tewi']);
        await expect(rowNamed(page, 'Assistant Tewi').locator(ITEM)).toBeFocused();
        await expect.poll(async () => (await readStoredFolders(page, persona)).folders[0].expanded).toBe(true);
    });

    test('resting on a closed folder shows it open for the drag, and a drop somewhere else leaves it closed in the file', async ({ page, baseURL }) => {
        const { ids, persona } = await openFoldersList(page, baseURL, { folders: [{ name: 'Work', expanded: false }, { name: 'Friends' }] });
        const [work, friends] = folderKeys(ids);

        await beginMouseDrag(page, 'Seraphina');
        await moveMouseOver(page, section(page, work));
        await expect(headingOf(page, work)).toHaveAttribute('aria-expanded', 'true');
        await moveMouseOver(page, section(page, friends));
        await page.mouse.up();

        await expectNames(page, friends, ['Seraphina']);
        await expect(headingOf(page, work)).toHaveAttribute('aria-expanded', 'false');
        expect((await readStoredFolders(page, persona)).folders[0].expanded).toBe(false);
    });

    test('Escape during a drag over a folder cancels it: nothing moves, the folder that opened for the drag closes again, and nothing is stored', async ({ page, baseURL }) => {
        const { ids, made, persona } = await openFoldersList(page, baseURL, { folders: [{ name: 'Work', expanded: false }] });
        const [work] = folderKeys(ids);

        await beginMouseDrag(page, 'Seraphina');
        await moveMouseOver(page, section(page, work));
        await expect(headingOf(page, work)).toHaveAttribute('aria-expanded', 'true');
        await page.keyboard.press('Escape');
        await page.mouse.up();

        await expect(page.locator(LIST)).not.toHaveAttribute('data-dragging', 'true');
        await expect(headingOf(page, work)).toHaveAttribute('aria-expanded', 'false');
        await expectNames(page, 'conversations', ALL_NAMES);
        expect(await filedIn(page, persona, made.seraphina.conversationId)).toBe('');
        expect((await readStoredFolders(page, persona)).folders[0].expanded).toBe(false);
    });

    test('a drag from a folder to Conversations takes the row out of its folder, and a drag back to the section it came from changes nothing', async ({ page, baseURL }) => {
        const { ids, made, persona } = await openFoldersList(page, baseURL, { folders: [{ name: 'Work' }], members: { seraphina: 0 } });
        const [work] = folderKeys(ids);

        await beginMouseDrag(page, 'Seraphina');
        await moveMouseOver(page, section(page, work));
        await page.mouse.up();
        await expectNames(page, work, ['Seraphina']);

        await beginMouseDrag(page, 'Seraphina');
        await moveMouseOver(page, section(page, 'conversations'));
        await expect(section(page, 'conversations')).toHaveClass(/is-drop-target/);
        await page.mouse.up();

        await expectNames(page, work, []);
        await expect(page.locator(STATUS)).toHaveText('Seraphina moved to Conversations');
        await expect.poll(() => filedIn(page, persona, made.seraphina.conversationId)).toBe('');
    });

    test('a drag to Favorites keeps the folder, and a drag of the favourite to a folder takes it out of Favorites and files it there', async ({ page, baseURL }) => {
        const { ids, made, persona } = await openFoldersList(page, baseURL, { folders: [{ name: 'Work' }, { name: 'Friends' }], members: { seraphina: 0 } });
        const [work, friends] = folderKeys(ids);

        await beginMouseDrag(page, 'Seraphina');
        await moveMouseOver(page, section(page, 'conversations'));
        await moveMouseOver(page, page.locator(`${LIST} ${SECTION}[data-section="favorites"]`));
        await page.mouse.up();
        await expectNames(page, 'favorites', ['Seraphina']);
        await expectNames(page, work, []);
        expect(await filedIn(page, persona, made.seraphina.conversationId)).toBe(ids[0]);
        await expect(page.locator(STATUS)).toHaveText('Seraphina added to Favorites');

        await beginMouseDrag(page, 'Seraphina');
        await moveMouseOver(page, section(page, friends));
        await page.mouse.up();
        await expectNames(page, 'favorites', []);
        await expectNames(page, friends, ['Seraphina']);
        await expect.poll(() => filedIn(page, persona, made.seraphina.conversationId)).toBe(ids[1]);
        expect((await readStoredConversation(page, made.seraphina.conversationId)).favorite).toBe(false);
    });

    test('an empty folder is a drop zone with a hint while a row is dragged', async ({ page, baseURL }) => {
        const { ids } = await openFoldersList(page, baseURL, { folders: [{ name: 'Work' }] });
        const hint = section(page, folderKeys(ids)[0]).locator('.sb-conversation-list-zone-hint');

        await expect(hint).toBeHidden();
        await beginMouseDrag(page, 'Seraphina');

        await expect(hint).toBeVisible();
        await expect(hint).toHaveText('Drop here to add to Work');
        await page.keyboard.press('Escape');
        await page.mouse.up();
    });
});

test.describe('Move to Folder in the menu of a row', () => {
    test('offers No Folder and the folders as radio choices with the folder of the row checked, and files the row in the folder that is chosen', async ({ page, baseURL }) => {
        const { ids, made, persona } = await openFoldersList(page, baseURL, { folders: [{ name: 'Work' }, { name: 'Friends' }], members: { seraphina: 1 } });
        const [work, friends] = folderKeys(ids);

        await openRowMenu(page, 'Seraphina');
        await chooseMenuItem(page, 'Move to Folder…');
        await expect(page.getByRole('menuitemradio')).toHaveText(['No Folder', 'Work', 'Friends']);
        await expect(page.getByRole('menuitemradio', { name: 'Friends' })).toHaveAttribute('aria-checked', 'true');
        await expect(page.getByRole('menuitemradio', { name: 'Work' })).toHaveAttribute('aria-checked', 'false');
        await expect(page.getByRole('menuitem', { name: 'New Folder…' })).toBeVisible();
        await page.getByRole('menuitemradio', { name: 'Work' }).click();

        await expectNames(page, work, ['Seraphina']);
        await expectNames(page, friends, []);
        await expect(rowNamed(page, 'Seraphina').locator(ITEM)).toBeFocused();
        await expect(page.locator(STATUS)).toHaveText('Seraphina moved to Work');
        await expect.poll(() => filedIn(page, persona, made.seraphina.conversationId)).toBe(ids[0]);

        await openRowMenu(page, 'Seraphina');
        await chooseMenuItem(page, 'Move to Folder…');
        await page.getByRole('menuitemradio', { name: 'No Folder' }).click();
        await expectNames(page, work, []);
        await expectNames(page, 'conversations', ALL_NAMES.filter(name => name !== 'Seraphina').concat('Seraphina').sort((first, second) => ALL_NAMES.indexOf(first) - ALL_NAMES.indexOf(second)));
        await expect.poll(() => filedIn(page, persona, made.seraphina.conversationId)).toBe('');
    });

    test('opens a closed folder that receives the row, and stores that', async ({ page, baseURL }) => {
        const { ids, persona } = await openFoldersList(page, baseURL, { folders: [{ name: 'Work', expanded: false }] });
        const [work] = folderKeys(ids);

        await openRowMenu(page, 'Assistant Tewi');
        await chooseMenuItem(page, 'Move to Folder…');
        await page.getByRole('menuitemradio', { name: 'Work' }).click();

        await expect(headingOf(page, work)).toHaveAttribute('aria-expanded', 'true');
        await expectNames(page, work, ['Assistant Tewi']);
        await expect.poll(async () => (await readStoredFolders(page, persona)).folders[0].expanded).toBe(true);
    });

    test('New Folder asks for a name, makes the folder and files the row in it, and refuses a blank name', async ({ page, baseURL }) => {
        const { made, persona } = await openFoldersList(page, baseURL, {});

        await openRowMenu(page, 'Study group');
        await chooseMenuItem(page, 'Move to Folder…');
        await chooseMenuItem(page, 'New Folder…');
        const input = page.locator('.sb-manager-name-popover__input');
        await expect(input).toBeFocused();
        await input.fill('   ');
        await expect(page.locator('.sb-manager-name-popover__create')).toBeDisabled();
        await input.fill('Trips');
        await page.keyboard.press('Enter');

        await expect(rowNamed(page, 'Study group').locator(ITEM)).toBeFocused();
        expect(await headingLabels(page)).toEqual(['Favorites', 'Trips', 'Conversations']);
        await expect(page.locator(STATUS)).toHaveText('Study group moved to Trips');
        const stored = await readStoredFolders(page, persona);
        expect(stored.folders.map(folder => folder.name)).toEqual(['Trips']);
        expect(stored.members).toEqual({ [made.study.conversationId]: stored.folders[0].id });
        await expectNames(page, `folder:${stored.folders[0].id}`, ['Study group']);
    });

    test('changes the folder of a favourite only: it stays in Favorites, shows the folder it will return to, and the text says why it did not move', async ({ page, baseURL }) => {
        const { ids, made, persona } = await openFoldersList(page, baseURL, { folders: [{ name: 'Work' }, { name: 'Friends' }] });
        const [work] = folderKeys(ids);
        await patchConversation(page, made.tewi.conversationId, { favorite: true });
        await expectNames(page, 'favorites', ['Assistant Tewi']);

        await openRowMenu(page, 'Assistant Tewi');
        await chooseMenuItem(page, 'Move to Folder…');
        await expect(page.getByRole('menuitemradio', { name: 'No Folder' })).toHaveAttribute('aria-checked', 'true');
        await page.getByRole('menuitemradio', { name: 'Friends' }).click();

        await expect(page.locator(STATUS)).toHaveText('Assistant Tewi moved to Friends, and stays in Favorites');
        await expectNames(page, 'favorites', ['Assistant Tewi']);
        await expectNames(page, work, []);
        await expect.poll(() => filedIn(page, persona, made.tewi.conversationId)).toBe(ids[1]);

        await openRowMenu(page, 'Assistant Tewi');
        await chooseMenuItem(page, 'Move to Folder…');
        await expect(page.getByRole('menuitemradio', { name: 'Friends' })).toHaveAttribute('aria-checked', 'true');
        await page.keyboard.press('Escape');

        await openRowMenu(page, 'Assistant Tewi');
        await chooseMenuItem(page, 'Remove From Favorites');
        await expectNames(page, 'favorites', []);
        await expectNames(page, folderKeys(ids)[1], ['Assistant Tewi']);
        await expect(page.locator(STATUS)).toHaveText('Assistant Tewi moved to Friends');
    });

    test('is reachable from the keyboard: Shift+F10 opens the menu, and the folder menu opens with its first item focused', async ({ page, baseURL }) => {
        const { ids } = await openFoldersList(page, baseURL, { folders: [{ name: 'Work' }] });

        await rowNamed(page, 'Seraphina').locator(ITEM).focus();
        await page.keyboard.press('Shift+F10');
        await page.getByRole('menuitem', { name: 'Move to Folder…' }).focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('menuitemradio', { name: 'No Folder' })).toBeFocused();
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');

        await expectNames(page, folderKeys(ids)[0], ['Seraphina']);
        await expect(rowNamed(page, 'Seraphina').locator(ITEM)).toBeFocused();
    });

    test('is still in the menu while a search filters, and files the row', async ({ page, baseURL }) => {
        const { ids } = await openFoldersList(page, baseURL, { folders: [{ name: 'Work' }] });

        await page.locator('#sb_conversation_list_search').fill('tewi');
        await expect(page.locator(`${LIST} ${ROW}`)).toHaveCount(1);
        await openRowMenu(page, 'Assistant Tewi');
        await chooseMenuItem(page, 'Move to Folder…');
        await page.getByRole('menuitemradio', { name: 'Work' }).click();

        await expectNames(page, folderKeys(ids)[0], ['Assistant Tewi']);
        await page.locator('#sb_conversation_list_search').fill('');
        await expectNames(page, folderKeys(ids)[0], ['Assistant Tewi']);
    });
});

test.describe('Alt with an arrow key across the sections', () => {
    async function altKey(page, name, key) {
        await rowNamed(page, name).locator(ITEM).focus();
        await page.keyboard.press(`Alt+${key}`);
    }

    test('walks a row down from Favorites through the folders to Conversations and back up, keeping focus and announcing each move', async ({ page, baseURL }) => {
        const { ids, made, persona } = await openFoldersList(page, baseURL, { folders: [{ name: 'Work' }, { name: 'Friends' }] });
        const [work, friends] = folderKeys(ids);
        await patchConversation(page, made.seraphina.conversationId, { favorite: true });
        await expectNames(page, 'favorites', ['Seraphina']);

        await altKey(page, 'Seraphina', 'ArrowDown');
        await expectNames(page, work, ['Seraphina']);
        await expectNames(page, 'favorites', []);
        await expect(rowNamed(page, 'Seraphina').locator(ITEM)).toBeFocused();
        await expect(page.locator(STATUS)).toHaveText('Seraphina moved to Work');
        expect((await readStoredConversation(page, made.seraphina.conversationId)).favorite).toBe(false);

        await page.keyboard.press('Alt+ArrowDown');
        await expectNames(page, friends, ['Seraphina']);
        await page.keyboard.press('Alt+ArrowDown');
        await expectNames(page, 'conversations', ALL_NAMES);
        await expect(page.locator(STATUS)).toHaveText('Seraphina moved to Conversations');
        await page.keyboard.press('Alt+ArrowDown');
        await expectNames(page, 'conversations', ALL_NAMES);

        await page.keyboard.press('Alt+ArrowUp');
        await expectNames(page, friends, ['Seraphina']);
        await page.keyboard.press('Alt+Home');
        await expectNames(page, 'favorites', ['Seraphina']);
        await expect(page.locator(STATUS)).toHaveText('Seraphina added to Favorites');
        // Moving into Favorites keeps the folder that the row was last in.
        await expect.poll(() => filedIn(page, persona, made.seraphina.conversationId)).toBe(ids[1]);
        await page.keyboard.press('Alt+ArrowUp');
        await expectNames(page, 'favorites', ['Seraphina']);
        await page.keyboard.press('Alt+End');
        await expectNames(page, 'conversations', ALL_NAMES);
        await expect.poll(() => filedIn(page, persona, made.seraphina.conversationId)).toBe('');
    });

    test('from Conversations, Up goes to the last folder and Down from the last folder comes back', async ({ page, baseURL }) => {
        const { ids } = await openFoldersList(page, baseURL, { folders: [{ name: 'Work' }, { name: 'Friends' }] });

        await altKey(page, 'Seraphina', 'ArrowUp');
        await expectNames(page, folderKeys(ids)[1], ['Seraphina']);
        await page.keyboard.press('Alt+ArrowDown');
        await expectNames(page, 'conversations', ALL_NAMES);
        await expect(rowNamed(page, 'Seraphina').locator(ITEM)).toBeFocused();
    });

    test('with no folder, up and down are Favorites and Conversations as they always were', async ({ page, baseURL }) => {
        await openFoldersList(page, baseURL, {});

        await altKey(page, 'Seraphina', 'ArrowUp');
        await expectNames(page, 'favorites', ['Seraphina']);
        await page.keyboard.press('Alt+ArrowDown');
        await expectNames(page, 'favorites', []);
        await expect(rowNamed(page, 'Seraphina').locator(ITEM)).toBeFocused();
    });

    test('a row stepped through closed folders leaves each of them closed as it was, and the folder that it stays in keeps its open', async ({ page, baseURL }) => {
        const { ids, persona } = await openFoldersList(page, baseURL, { folders: [{ name: 'One', expanded: false }, { name: 'Two', expanded: false }, { name: 'Three', expanded: false }] });
        const [one, two, three] = folderKeys(ids);

        // From Conversations, Up goes to the last folder and Home to Favorites.
        await altKey(page, 'Seraphina', 'Home');
        await expectNames(page, 'favorites', ['Seraphina']);
        await page.keyboard.press('Alt+ArrowDown');
        await expectNames(page, one, ['Seraphina']);
        await expect(headingOf(page, one)).toHaveAttribute('aria-expanded', 'true');
        await page.keyboard.press('Alt+ArrowDown');
        await expectNames(page, two, ['Seraphina']);
        await expect(headingOf(page, one)).toHaveAttribute('aria-expanded', 'false');
        await expect(headingOf(page, two)).toHaveAttribute('aria-expanded', 'true');
        await expect(rowNamed(page, 'Seraphina').locator(ITEM)).toBeFocused();
        expect((await readStoredFolders(page, persona)).folders.map(folder => folder.expanded)).toEqual([false, false, false]);

        // The row stays when the focus goes to another row, and the folder that it is in keeps its open.
        await rowNamed(page, 'Assistant Tewi').locator(ITEM).focus();
        await expect.poll(async () => (await readStoredFolders(page, persona)).folders.map(folder => folder.expanded)).toEqual([false, true, false]);
        await expect(headingOf(page, two)).toHaveAttribute('aria-expanded', 'true');
        await expect(headingOf(page, three)).toHaveAttribute('aria-expanded', 'false');
    });

    test('is off while a search filters, and declines at the ends', async ({ page, baseURL }) => {
        await openFoldersList(page, baseURL, { folders: [{ name: 'Work' }] });
        await altKey(page, 'Seraphina', 'ArrowDown');
        await expectNames(page, 'conversations', ALL_NAMES);

        await page.locator('#sb_conversation_list_search').fill('tewi');
        await expect(page.locator(`${LIST} ${ROW}`)).toHaveCount(1);
        await altKey(page, 'Assistant Tewi', 'ArrowUp');
        await expectNames(page, 'favorites', []);
    });
});

test.describe('moving a row into a folder by touch on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

    test.beforeEach(({ browserName }) => {
        // eslint-disable-next-line playwright/no-skipped-test -- Only Chromium offers the DevTools protocol that sends the touch events.
        test.skip(browserName !== 'chromium', 'touch events are driven with the DevTools protocol');
    });

    async function touchPoint(client, type, x, y) {
        await client.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    }

    async function moveFinger(client, from, to, steps = 12) {
        for (let step = 1; step <= steps; step++) {
            await touchPoint(client, 'touchMove', from.x + ((to.x - from.x) * step) / steps, from.y + ((to.y - from.y) * step) / steps);
            await wait(16);
        }
    }

    test('a long press and a move drags a row into an open folder and into a closed one, and no menu opens', async ({ page, baseURL }) => {
        const { ids, made, persona } = await openFoldersList(page, baseURL, { folders: [{ name: 'Work' }, { name: 'Friends', expanded: false }] });
        const [work, friends] = folderKeys(ids);
        await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-layout', 'pages');
        const client = await page.context().newCDPSession(page);

        for (const [name, key, id] of [['Assistant Tewi', work, ids[0]], ['Seraphina', friends, ids[1]]]) {
            const start = await centreOf(rowNamed(page, name));
            await touchPoint(client, 'touchStart', start.x, start.y);
            await wait(600);
            await moveFinger(client, start, { x: start.x, y: start.y + 24 }, 4);
            await expect(page.locator(LIST)).toHaveAttribute('data-dragging', 'true');
            const zone = await centreOf(section(page, key));
            await moveFinger(client, { x: start.x, y: start.y + 24 }, zone);
            await expect(section(page, key)).toHaveClass(/is-drop-target/);
            await touchPoint(client, 'touchEnd', 0, 0);
            await expect(headingOf(page, key)).toHaveAttribute('aria-expanded', 'true');
            await expectNames(page, key, [name]);
            expect(await filedIn(page, persona, made[name === 'Seraphina' ? 'seraphina' : 'tewi'].conversationId)).toBe(id);
        }
        await expect(page.getByRole('menuitem')).toHaveCount(0);
        await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-page', 'list');
    });

    test('the headings of the folders are touch targets of 44px', async ({ page, baseURL }) => {
        const { ids } = await openFoldersList(page, baseURL, { folders: [{ name: 'Work' }] });

        const box = await headingOf(page, folderKeys(ids)[0]).boundingBox();

        expect(box.height).toBeGreaterThanOrEqual(44);
    });
});
