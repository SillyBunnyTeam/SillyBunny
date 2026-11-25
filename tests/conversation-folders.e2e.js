import { expect, test } from '@playwright/test';
import {
    LIST,
    ROW,
    SECTION,
    bootConversationPage,
    expectNames,
    headingLabels,
    headingOf,
    newFolderId,
    openConversationList,
    patchConversation,
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
