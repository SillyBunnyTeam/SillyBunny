import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';

const IPHONE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const PROFILES = [
    { name: 'desktop', use: { viewport: { width: 1280, height: 720 } } },
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: IPHONE_USER_AGENT } },
];
const CURRENT_CHAT_CONTROLS = [
    '#char_connections_button',
    '#creators_note_styles_button',
    '.rm_stats_button',
    '.form_create_bottom_buttons_block .chat_lorebook_button',
    '#character_open_media_overrides',
];

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @returns {Promise<string>} The avatar of the new card
 */
async function createCard(page, name) {
    return await page.evaluate(async name => {
        const { getRequestHeaders } = await import('/script.js');
        const response = await fetch('/api/characters/create', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ ch_name: name, description: `${name} description` }),
        });
        if (!response.ok) {
            throw new Error(`Could not create the fixture character ${name}: ${response.status}`);
        }
        return await response.text();
    }, name);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} bookName
 */
async function createLorebook(page, bookName) {
    await page.evaluate(async bookName => {
        const { saveWorldInfo, updateWorldInfoList } = await import('/scripts/world-info.js');
        if (!await saveWorldInfo(bookName, { entries: {} }, true)) {
            throw new Error('Could not save the fixture lorebook');
        }
        await updateWorldInfoList();
    }, bookName);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function openChat(page, avatar) {
    await page.evaluate(async avatar => {
        const { characters, getCharacters, selectCharacterById } = await import('/script.js');
        await getCharacters();
        await selectCharacterById(characters.findIndex(character => character.avatar === avatar));
    }, avatar);
}

/** @param {import('@playwright/test').Page} page */
async function readActiveChat(page) {
    return await page.evaluate(async () => {
        const { characters, getCurrentChatId, this_chid } = await import('/script.js');
        return { avatar: characters[this_chid]?.avatar, chatId: getCurrentChatId() };
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} optionId
 */
async function chooseDropdownEntry(page, optionId) {
    const dropdown = page.locator('#char-management-dropdown');
    const index = await dropdown.locator('option').evaluateAll((options, id) => options.findIndex(option => option.id === id), optionId);
    await dropdown.selectOption({ index });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} tagName
 * @param {{ activeAvatar: string, otherAvatar: string }} fixtures
 */
async function readTagOwners(page, tagName, { activeAvatar, otherAvatar }) {
    return await page.evaluate(async ({ tagName, activeAvatar, otherAvatar }) => {
        const { tags, tag_map } = await import('/scripts/tags.js');
        const tagId = tags.find(tag => tag.name === tagName)?.id;
        const hasTag = avatar => Boolean(tagId && tag_map[avatar]?.includes(tagId));
        return { other: hasTag(otherAvatar), active: hasTag(activeAvatar) };
    }, { tagName, activeAvatar, otherAvatar });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ activeAvatar: string, otherAvatar: string }} fixtures
 */
async function readAuxiliaryBooks(page, { activeAvatar, otherAvatar }) {
    return await page.evaluate(async ({ activeAvatar, otherAvatar }) => {
        const { world_info } = await import('/scripts/world-info.js');
        const books = avatar => world_info.charLore?.find(item => item.name === avatar.replace(/\.[^/.]+$/, ''))?.extraBooks ?? [];
        return { other: books(otherAvatar), active: books(activeAvatar) };
    }, { activeAvatar, otherAvatar });
}

/**
 * Reads the descriptions that the server stores for the two cards.
 * @param {import('@playwright/test').Page} page
 * @param {{ activeAvatar: string, otherAvatar: string }} fixtures
 */
async function readDescriptions(page, { activeAvatar, otherAvatar }) {
    return await page.evaluate(async ({ activeAvatar, otherAvatar }) => {
        const { getRequestHeaders } = await import('/script.js');
        const read = async avatar => {
            const response = await fetch('/api/characters/get', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar }),
            });
            return (await response.json()).description;
        };
        return { other: await read(otherAvatar), active: await read(activeAvatar) };
    }, { activeAvatar, otherAvatar });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string[]} selectors
 */
async function readInlineHidden(page, selectors) {
    return await page.evaluate(selectors => selectors.map(selector => document.querySelector(selector)?.style.display === 'none'), selectors);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ activeAvatar: string, otherAvatar: string, bookName: string }} fixtures
 */
async function deleteFixtures(page, { activeAvatar, otherAvatar, bookName }) {
    await page.evaluate(async ({ avatars, bookName }) => {
        const { getRequestHeaders } = await import('/script.js');
        const { deleteWorldInfo, world_names } = await import('/scripts/world-info.js');
        for (const avatar of avatars) {
            await fetch('/api/characters/delete', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar, delete_chats: true }),
            });
        }
        if (world_names?.includes(bookName)) {
            await deleteWorldInfo(bookName);
        }
    }, { avatars: [activeAvatar, otherAvatar].filter(Boolean), bookName });
}

for (const profile of PROFILES) {
    test.describe(`classic editor for a card that is not active, on ${profile.name}`, () => {
        // A service worker that controls the page would answer requests before page.route sees them.
        test.use({ serviceWorkers: 'block', ...profile.use });

        test.beforeEach(async ({ page }) => {
            // Settings saves stay in this page, so the tag and the lorebook link of the test never reach the server.
            let settingsVersion = Date.now();
            await page.route('**/api/settings/save', route => route.fulfill({ status: 200, json: { version: ++settingsVersion } }));
            await testSetup.awaitST({ page });
        });

        test('opens a card that is not active from the Creator and edits it', async ({ page }) => {
            test.setTimeout(120_000);
            const suffix = Date.now();
            const tagName = `editor-tag-${suffix}`;
            const fixtures = { activeAvatar: '', otherAvatar: '', bookName: `EDITOR_LORE_${suffix}` };

            try {
                await createLorebook(page, fixtures.bookName);
                fixtures.activeAvatar = await createCard(page, `Editor Active ${suffix}`);
                fixtures.otherAvatar = await createCard(page, `Editor Other ${suffix}`);
                await openChat(page, fixtures.activeAvatar);
                const activeChat = await readActiveChat(page);
                expect(activeChat.avatar).toBe(fixtures.activeAvatar);

                await page.evaluate(avatar => window.dispatchEvent(new CustomEvent('sb:open-creator-workspace', { detail: { avatar } })), fixtures.otherAvatar);
                const creator = page.locator('#sb_character_creator_workspace');
                await creator.locator('#sb_creator_tab_review').click();
                await creator.getByRole('button', { name: 'Open in editor', exact: true }).click();

                await expect(page.locator('#form_create')).toHaveAttribute('actiontype', 'editcharacter');
                await expect(page.locator('#avatar_url_pole')).toHaveValue(fixtures.otherAvatar);
                expect(await readActiveChat(page)).toEqual(activeChat);
                for (const selector of CURRENT_CHAT_CONTROLS) {
                    await expect(page.locator(selector)).toBeHidden();
                }

                await page.locator('#tagInput').pressSequentially(tagName);
                await page.locator('.ui-autocomplete .ui-menu-item', { hasText: tagName }).first().click();
                await expect(page.locator('#tagList .tag', { hasText: tagName })).toBeVisible();
                expect(await readTagOwners(page, tagName, fixtures)).toEqual({ other: true, active: false });

                await chooseDropdownEntry(page, 'set_character_world');
                const worldPopup = page.locator('dialog[open]').filter({ has: page.locator('.character_extra_world_info_selector') });
                const bookIndex = await page.evaluate(async bookName => (await import('/scripts/world-info.js')).world_names.indexOf(bookName), fixtures.bookName);
                expect(bookIndex).toBeGreaterThanOrEqual(0);
                // On desktop, select2 covers the native select. The popup reads the native select in its change handler.
                await worldPopup.locator('.character_extra_world_info_selector').evaluate((select, value) => {
                    $(select).val([value]).trigger('change');
                }, String(bookIndex));
                await worldPopup.locator('.popup-button-ok').click();
                expect(await readAuxiliaryBooks(page, fixtures)).toEqual({ other: [fixtures.bookName], active: [] });

                // The editor opens on the Information tab, and the description field belongs to the Definitions tab.
                await page.locator('#sb_character_editor_tab_definitions').click();
                await page.locator('#description_textarea').fill(`Edited ${suffix}`);
                await page.evaluate(async () => (await import('/script.js')).flushCharacterSaveDebounced());
                expect(await readDescriptions(page, fixtures)).toEqual({ other: `Edited ${suffix}`, active: `Editor Active ${suffix} description` });
                expect(await readActiveChat(page)).toEqual(activeChat);

                await page.evaluate(avatar => window.SillyBunnyShell.openTab('characters', 'editor', { avatar }), fixtures.activeAvatar);
                await expect(page.locator('#avatar_url_pole')).toHaveValue(fixtures.activeAvatar);
                expect(await readInlineHidden(page, CURRENT_CHAT_CONTROLS)).toEqual(CURRENT_CHAT_CONTROLS.map(() => false));
            } finally {
                await deleteFixtures(page, fixtures);
            }
        });
    });
}
