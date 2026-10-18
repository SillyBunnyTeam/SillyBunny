import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

const CHARACTER = 'qa-related-character.png';
const PERSONA = 'qa-related-persona.png';
const GROUP = 'qa-related-group';

test.setTimeout(60000);

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    await page.route(/\/api\/avatars\/(?:upload|delete)$/, route => route.abort());
    await page.route(/\/api\/worldinfo\/(?:edit|delete|rename|import)$/, route => route.abort());
    await page.route('**/api/avatars/get', async route => {
        const response = await route.fetch();
        const avatars = await response.json();
        await route.fulfill({ json: [...avatars, PERSONA] });
    });
    await page.route('**/api/chats/get', route => route.fulfill({ json: [
        { chat_metadata: {} },
        { name: 'QA related character', is_user: false, is_system: false, send_date: '2026-10-18', mes: 'QA in-memory chat' },
    ] }));
    await page.route('**/api/chats/info', route => route.fulfill({ json: { file_name: 'qa-related-chat.jsonl', chat_items: 1 } }));
    await page.route('**/api/characters/chats', route => route.fulfill({ json: { 0: { file_name: 'qa-related-chat.jsonl' } } }));
    await page.goto('/');
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'));
    await page.evaluate(async ({ characterAvatar, personaAvatar, groupId }) => {
        const app = await import('/script.js');
        const { power_user, setCharacterEditorQuickEdit } = await import('/scripts/power-user.js');
        const { groups } = await import('/scripts/group-chats.js');
        const { objectNavigation } = await import('/scripts/sillybunny-editor/object-navigation.js');
        const data = {
            name: 'QA related character', description: '', personality: '', scenario: '', first_mes: 'QA greeting',
            mes_example: '', creator_notes: '', creator: '', character_version: '',
            alternate_greetings: [], group_only_greetings: [], tags: [], extensions: { world: '' },
        };
        const character = {
            ...data, avatar: characterAvatar, data, shallow: false,
            chat: 'qa-related-chat', create_date: Date.now(), json_data: JSON.stringify({ data }),
        };
        app.characters.push(character);
        groups.push({
            id: groupId, name: 'QA related group', members: [characterAvatar], disabled_members: [], member_models: {},
            avatar_url: '', chat_id: 'qa-related-group-chat', chats: ['qa-related-group-chat'],
            activation_strategy: 0, generation_mode: 0, allow_self_responses: false, hideMutedSprites: false,
        });
        power_user.personas[personaAvatar] = 'QA related persona';
        power_user.persona_descriptions[personaAvatar] = {
            description: 'QA persona description', title: '', position: 0, depth: 2, role: 0,
            connections: [{ type: 'character', id: characterAvatar }], lorebook: '', appendices: [], activeAppendices: {},
        };
        setCharacterEditorQuickEdit(false);
        objectNavigation.clear();
    }, { characterAvatar: CHARACTER, personaAvatar: PERSONA, groupId: GROUP });
});

test.afterEach(async ({ page }) => {
    await page.evaluate(async ({ characterAvatar, personaAvatar, groupId }) => {
        const { objectNavigation } = await import('/scripts/sillybunny-editor/object-navigation.js');
        objectNavigation.clear();
        const { discardCharacterEditorForEntity } = await import('/scripts/sillybunny-character-editor.js');
        discardCharacterEditorForEntity(characterAvatar);
        const { mountPersonaEditor } = await import('/scripts/sillybunny-persona-editor.js');
        const container = document.querySelector('#PersonaManagement.sb-persona-editor-mounted');
        if (container) mountPersonaEditor(container).destroy();
        const { power_user } = await import('/scripts/power-user.js');
        delete power_user.personas[personaAvatar];
        delete power_user.persona_descriptions[personaAvatar];
        const { characters } = await import('/script.js');
        const { groups } = await import('/scripts/group-chats.js');
        const characterIndex = characters.findIndex(character => character.avatar === characterAvatar);
        if (characterIndex >= 0) characters.splice(characterIndex, 1);
        const groupIndex = groups.findIndex(group => group.id === groupId);
        if (groupIndex >= 0) groups.splice(groupIndex, 1);
    }, { characterAvatar: CHARACTER, personaAvatar: PERSONA, groupId: GROUP });
});

async function openCharacter(page) {
    expect(await page.evaluate(async avatar => {
        const app = await import('/script.js');
        await window.SillyBunnyShell.openTab('characters', 'characters');
        return app.selectCharacterById(app.characters.findIndex(character => character.avatar === avatar), { switchMenu: true });
    }, CHARACTER)).toBe(true);
    await expect(page.locator('#sb_character_related')).toBeVisible();
    await expect(page.locator('#character_name_pole')).toHaveValue('QA related character');
}

async function openPersona(page) {
    expect(await page.evaluate(async avatarId => (await import('/scripts/sillybunny-persona-editor.js')).openPersonaEditor({ avatarId, section: 'connections' }), PERSONA)).toBe(true);
    await expect(page.locator('.sb-persona-entry-name')).toHaveValue('QA related persona');
}

async function chatIdentity(page) {
    return page.evaluate(async () => {
        const app = await import('/script.js');
        const { selected_group } = await import('/scripts/group-chats.js');
        return { avatar: app.characters[app.this_chid]?.avatar, group: selected_group, chat: app.getCurrentChatId() };
    });
}

async function expectDepth(page, depth) {
    await expect.poll(() => page.evaluate(async () => (await import('/scripts/sillybunny-editor/object-navigation.js')).objectNavigation.depth)).toBe(depth);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`Related → persona → Back restores the character editor at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await openCharacter(page);
        const chat = await chatIdentity(page);
        const row = page.locator('#sb_character_related_rows [data-related-kind="persona-editor"]');
        await row.scrollIntoViewIfNeeded();
        await row.evaluate(element => {
            // Mobile chrome can collapse while Playwright waits for click stability.
            // Match the navigation transaction's origin, not the earlier scroll-into-view frame.
            element.addEventListener('click', () => {
                window.__sbRelatedOriginScrollTop = document.querySelector('#form_create .sb-editor-sheet__content').scrollTop;
            }, { capture: true, once: true });
        });
        await row.click();
        const scrollTop = await page.evaluate(() => window.__sbRelatedOriginScrollTop);
        expect(scrollTop).toBeGreaterThan(0);
        await expect(page.locator('.sb-persona-entry-name')).toHaveValue('QA related persona');
        await expectDepth(page, 1);
        await page.locator('.sb-persona-detail-back').click();
        await expect(page.locator('#sb_character_related')).toBeVisible();
        await expect(page.locator('#character_name_pole')).toHaveValue('QA related character');
        await expectDepth(page, 0);
        await expect.poll(() => page.locator('#form_create .sb-editor-sheet__content').evaluate(node => node.scrollTop)).toBeCloseTo(scrollTop, 0);
        expect(await chatIdentity(page)).toEqual(chat);
    });

    test(`Related → group editor → Back never changes chat at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await openCharacter(page);
        const chat = await chatIdentity(page);
        const row = page.locator('#sb_character_related_rows [data-related-kind="group-editor"]');
        await row.focus();
        await row.press('Enter');
        await expect(page.locator('#sb_group_editor_header')).toBeVisible();
        await expect(page.locator('#rm_group_chat_name')).toHaveValue('QA related group');
        await expectDepth(page, 1);
        expect(await chatIdentity(page)).toEqual(chat);
        await page.locator('#sb_group_editor_back').click();
        await expect(page.locator('#sb_character_related')).toBeVisible();
        await expect(page.locator('#character_name_pole')).toHaveValue('QA related character');
        await expectDepth(page, 0);
        expect(await chatIdentity(page)).toEqual(chat);
    });

    test(`persona connection → character editor → Back restores the persona at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await openPersona(page);
        const row = page.locator('.sb-persona-connections [data-sb-editor-field="connection"]');
        await expect(row.locator('.ds-entity-row__subtitle')).toHaveText('lorum ipsum');
        await row.focus();
        await row.press('Space');
        await expect(page.locator('#sb_character_editor_header')).toBeVisible();
        await expect(page.locator('#character_name_pole')).toHaveValue('QA related character');
        await expectDepth(page, 1);
        const chat = await chatIdentity(page);
        expect(chat.avatar).toBe(CHARACTER);
        await page.locator('#sb_character_editor_back').click();
        await expect(page.locator('.sb-persona-entry-name')).toHaveValue('QA related persona');
        await expect(row).toBeVisible();
        await expectDepth(page, 0);
        expect(await chatIdentity(page)).toEqual(chat);
    });
}
