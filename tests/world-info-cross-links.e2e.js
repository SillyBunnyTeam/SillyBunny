import { expect, test } from '@playwright/test';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';

const BOOK = 'sb-cross-links-in-memory-book';
const PERSONA = 'sb-cross-links-persona.png';
const PERSONA_NAME = 'QA Linked Persona';
const persistenceAttempts = new WeakMap();

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    const writes = [];
    persistenceAttempts.set(page, writes);
    await page.route(/\/api\/(?:worldinfo|avatars)\/(?!get$|all$|list$)[^/]+$/, route => {
        writes.push(new URL(route.request().url()).pathname);
        return route.abort();
    });
    await page.route('**/api/avatars/get', route => route.fulfill({ json: [PERSONA] }));
    await page.route('**/api/chats/get', route => route.fulfill({ json: [] }));
    await page.route('**/api/characters/chats', route => route.fulfill({ json: {} }));
    await page.route('**/api/characters/get', async route => {
        const { avatar_url } = route.request().postDataJSON();
        const character = await page.evaluate(async avatar => (await import('/script.js')).characters.find(character => character.avatar === avatar), avatar_url);
        return route.fulfill({ json: character });
    });
    await page.route('**/api/worldinfo/get', async route => {
        if (route.request().postDataJSON().name !== BOOK) return route.continue();
        return route.fulfill({ json: { entries: Object.fromEntries(Array.from({ length: 15 }, (_, uid) => [uid, {
            uid, comment: `QA Entry ${String(uid).padStart(2, '0')}`, key: ['qa'], keysecondary: [], content: 'QA content',
            constant: false, vectorized: false, selective: true, order: 100, position: 0, disable: false, displayIndex: uid,
        }])) } });
    });
    await page.goto('/');
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.evaluate(async ({ book, persona, personaName }) => {
        const app = await import('/script.js');
        const wi = await import('/scripts/world-info.js');
        const { power_user } = await import('/scripts/power-user.js');
        const { accountStorage } = await import('/scripts/util/AccountStorage.js');
        wi.world_names.push(book);
        document.getElementById('world_editor_select').add(new Option(book, String(wi.world_names.indexOf(book))));
        for (const [avatar, name, world] of [['qa-primary.png', 'QA Primary', book], ['qa-extra.png', 'QA Extra', '']]) {
            const data = {
                name, description: '', personality: '', scenario: '', first_mes: 'QA greeting', mes_example: '',
                creator_notes: '', creator: '', character_version: '', alternate_greetings: [], group_only_greetings: [], tags: [], extensions: { world },
            };
            app.characters.push({ ...data, avatar, data, shallow: false, chat: `qa-${avatar}`, create_date: Date.now(), json_data: JSON.stringify({ data }) });
        }
        wi.world_info.charLore ??= [];
        wi.world_info.charLore.push({ name: 'qa-primary.png', extraBooks: [book] }, { name: 'qa-extra.png', extraBooks: [book] });
        power_user.personas[persona] = personaName;
        power_user.persona_descriptions[persona] = {
            title: '', description: '', position: 0, depth: 2, role: 0, lorebook: book, connections: [], appendices: [], activeAppendices: {},
        };
        accountStorage.setItem('WI_PerPage', '10');
        if (!await wi.openWorldInfoEditor(book)) throw new Error('In-memory book was not ready');
    }, { book: BOOK, persona: PERSONA, personaName: PERSONA_NAME });
});

test.afterEach(async ({ page }) => {
    expect(persistenceAttempts.get(page), 'Cross-link navigation must never attempt WI or persona writes').toEqual([]);
});

async function openUsedBy(page) {
    await page.locator('#WorldInfo .sb-wi-book-actions').click();
    await page.locator('.sb-action-menu').last().getByRole('menuitem', { name: 'lorum ipsum', exact: true }).click();
    const picker = page.locator('.sb-picker:visible, .sb-picker-sheet:visible');
    await expect(picker).toBeVisible();
    return picker;
}

for (const cancellation of ['timeout', 'superseded']) {
    test(`delayed WI data cannot commit after its link is ${cancellation}`, async ({ page }) => {
        const lateName = `${BOOK}-${cancellation}`;
        let release;
        const delayed = new Promise(resolve => { release = resolve; });
        await page.route('**/api/worldinfo/get', async route => {
            if (route.request().postDataJSON().name !== lateName) return route.fallback();
            await delayed;
            return route.fulfill({ json: { entries: {} } });
        });
        const requested = page.waitForRequest(request => request.url().endsWith('/api/worldinfo/get') && request.postDataJSON().name === lateName);
        await page.evaluate(async name => {
            const wi = await import('/scripts/world-info.js');
            wi.world_names.push(name);
            document.getElementById('world_editor_select').add(new Option(name, String(wi.world_names.indexOf(name))));
            window.__sbLateCurrent = true;
            window.__sbLateOpen = wi.openWorldInfoEditor(name, { isCurrent: () => window.__sbLateCurrent });
        }, lateName);
        await requested;
        await page.evaluate(cancelled => { window.__sbLateCurrent = !cancelled; }, cancellation === 'superseded');
        expect(await page.evaluate(() => window.__sbLateOpen)).toBe(false);
        const completed = page.waitForResponse(response => response.url().endsWith('/api/worldinfo/get'));
        release();
        await (await completed).finished();
        await page.evaluate(async name => { await (await import('/scripts/world-info.js')).loadWorldInfo(name); }, lateName);
        expect(await page.evaluate(async () => (await import('/scripts/world-info.js')).getWorldInfoEditorState().name)).toBe(BOOK);
        await expect(page.locator('#WorldInfo .sb-wi-book-name')).toHaveText(BOOK);
    });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test.describe(`WI cross-links at ${viewport.width}px`, () => {
        test.use({ viewport });

        test('Used by deduplicates primary/extra characters and Persona Back restores the same book list', async ({ page }) => {
            const editor = page.locator('#WorldInfo .sb-wi-editor');
            await editor.getByRole('button', { name: 'Search', exact: true }).click();
            await editor.locator('.sb-wi-search').fill('QA Entry');
            await expect(editor.locator('.sb-list-editor__status').first()).toContainText('15');
            await editor.locator('.sb-list-pagination__next').click();
            await expect(editor.locator('.sb-list-pagination__status')).toHaveText('Page 2 of 2');
            const picker = await openUsedBy(page);
            await expect(picker.getByRole('option')).toHaveCount(3);
            await expect(picker.getByRole('option', { name: /QA Primary/ })).toContainText('Primary Lorebook');
            await expect(picker.getByRole('option', { name: /QA Extra/ })).toContainText('Additional Lorebooks');
            await picker.getByRole('option', { name: new RegExp(PERSONA_NAME) }).click();
            const persona = page.locator('#PersonaManagement .sb-persona-entry');
            await expect(persona).toBeVisible();
            await expect(persona.locator('.sb-persona-entry-name')).toHaveValue(PERSONA_NAME);
            await persona.locator('.sb-persona-detail-back').click();
            await expect(editor).toBeVisible();
            await expect(editor.locator('.sb-wi-book-name')).toHaveText(BOOK);
            await expect(editor.locator('.sb-wi-search')).toHaveValue('QA Entry');
            await expect(editor.locator('.sb-list-pagination__status')).toHaveText('Page 2 of 2');
            await expect(editor.locator('.sb-wi-row')).toHaveCount(5);
        });

        test('missing book returns false, warns, and leaves the current book selected', async ({ page }) => {
            await showToasts(page);
            expect(await page.evaluate(async () => (await import('/scripts/world-info.js')).openWorldInfoEditor('sb-cross-links-missing'))).toBe(false);
            await expect(page.locator('#toast-container')).toContainText('-- World Info not found --');
            await expect(page.locator('#WorldInfo .sb-wi-book-name')).toHaveText(BOOK);
            expect(await page.evaluate(async () => (await import('/scripts/sillybunny-editor/object-navigation.js')).objectNavigation.depth)).toBe(0);
        });

        test('Back to an inactive character keeps B active and reveals A in Characters', async ({ page }) => {
            expect(await page.evaluate(async () => {
                const app = await import('/script.js');
                const { objectNavigation } = await import('/scripts/sillybunny-editor/object-navigation.js');
                const { setCharacterEditorQuickEdit } = await import('/scripts/power-user.js');
                objectNavigation.clear();
                setCharacterEditorQuickEdit(false);
                return app.selectCharacterById(app.characters.findIndex(character => character.avatar === 'qa-primary.png'), { switchMenu: true });
            })).toBe(true);
            await page.locator('#sb_character_related_rows [data-related-kind="world-info"]').click();
            await expect.poll(() => page.evaluate(async () => (await import('/scripts/sillybunny-editor/object-navigation.js')).objectNavigation.depth)).toBe(1);
            await expect(page.locator('#WorldInfo .sb-wi-editor')).toBeVisible();
            await expect(page.locator('#WorldInfo .sb-wi-book-name')).toHaveText(BOOK);
            const picker = await openUsedBy(page);
            await picker.getByRole('option', { name: /QA Extra/ }).click();
            await expect(page.locator('#rm_ch_create_block')).toBeVisible();
            await expect.poll(() => page.evaluate(async () => (await import('/scripts/sillybunny-editor/object-navigation.js')).objectNavigation.depth)).toBe(2);
            const chatState = () => page.evaluate(async () => {
                const app = await import('/script.js');
                return { avatar: app.characters[app.this_chid]?.avatar, chat: app.getCurrentChatId(), messages: structuredClone(app.chat) };
            });
            const beforeBack = await chatState();
            expect(beforeBack.avatar).toBe('qa-extra.png');
            await page.locator('#sb_character_editor_back').click();
            await expect.poll(() => page.evaluate(async () => (await import('/scripts/sillybunny-editor/object-navigation.js')).objectNavigation.depth)).toBe(1);
            await expect(page.locator('#WorldInfo .sb-wi-editor')).toBeVisible();
            await expect(page.locator('#WorldInfo .sb-wi-book-name')).toHaveText(BOOK);
            await expect(page.locator('#WorldInfo .sb-wi-origin-back')).toHaveCount(0);
            // WI has no Back button by design; the same origin entry is reachable through Persona Back in real use.
            await page.evaluate(async book => (await import('/scripts/sillybunny-editor/object-navigation.js')).objectNavigation.back({
                current: { kind: 'world-info', id: book }, fallback: async () => {},
            }), BOOK);
            const row = page.locator('.sb-character-list [data-sb-list-key="character:qa-primary.png"]');
            await expect(row).toBeVisible();
            await expect(row).toBeFocused();
            await expect(row).toBeInViewport();
            expect(await chatState()).toEqual(beforeBack);
        });
    });
}
