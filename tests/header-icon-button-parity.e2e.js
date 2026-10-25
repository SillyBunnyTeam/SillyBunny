import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

const character = {
    name: 'Header Icon Character', description: '', personality: '', scenario: '', first_mes: 'Hello', mes_example: '',
    creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '',
    character_version: '', extensions: { fav: false, talkativeness: 0.5 }, avatar: 'header-icon.png',
    chat: 'header-icon-chat', create_date: '2026-10-24', date_added: 1, spec: 'chara_card_v2', spec_version: '2.0',
    data: { name: 'Header Icon Character', description: '', personality: '', scenario: '', first_mes: 'Hello', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: { fav: false, talkativeness: 0.5 } },
};

async function waitForAnimations(page) {
    await expect.poll(() => page.evaluate(() => document.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length), { timeout: 30000 }).toBe(0);
}

async function readState(page, selector) {
    return page.locator(selector).evaluate(button => {
        const icon = button.querySelector('i, svg') || button;
        const read = node => {
            const style = getComputedStyle(node);
            return {
                color: style.color,
                opacity: style.opacity,
                backgroundColor: style.backgroundColor,
                border: style.border,
                outline: style.outline,
                borderRadius: style.borderRadius,
            };
        };
        return { button: read(button), icon: read(icon) };
    });
}

async function setTheme(page, theme) {
    await page.evaluate(themeName => window.$('#themes').val(themeName).trigger('change'), theme);
    await expect(page.locator('html')).toHaveAttribute('data-sb-surface-tone', theme === 'Libadwaita Light' ? 'light' : 'dark');
    await waitForAnimations(page);
}

test.describe('character list and editor header icon parity', () => {
    test.setTimeout(90000);

    test.beforeEach(async ({ page }) => {
        await protectMaintainerServer(page);
        await page.route('**/api/characters/all', route => route.fulfill({ json: [character] }));
        await page.route('**/api/characters/chats', route => route.fulfill({ json: {} }));
        await page.route('**/api/chats/get', route => route.fulfill({ json: [] }));
        await page.route('**/api/groups/all', route => route.fulfill({ json: [] }));
        await page.goto('/');
        await page.waitForFunction(() => !document.getElementById('preloader'), null, { timeout: 60000 });
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.evaluate(async () => window.SillyBunnyShell.openTab('characters', 'characters'));
        await expect(page.locator('.sb-character-list[data-view="characters"]')).toBeVisible();
        await waitForAnimations(page);
        await page.locator('.character_select').first().getByRole('button', { name: 'Edit', exact: true }).click();
        await expect(page.locator('#sb_character_editor_toolbar')).toBeVisible();
        await waitForAnimations(page);
    });

    for (const theme of ['Libadwaita', 'Libadwaita Light']) {
        test(`${theme} keeps list and editor icon states equal`, async ({ page }) => {
            await setTheme(page, theme);
            await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'characters'));
            await expect(page.locator('.sb-character-list[data-view="characters"]')).toBeVisible();
            const listButton = '.sb-character-list .sb-list-header__button[data-action-id="search"]';
            const editorButton = '#favorite_button';
            const globe = '#world_button';
            await page.locator('.character_select').first().getByRole('button', { name: 'Edit', exact: true }).click();
            await expect(page.locator('#sb_character_editor_toolbar')).toBeVisible();

            const compare = async (state, listAction, editorAction) => {
                await page.evaluate(async () => window.SillyBunnyShell.openTab('characters', 'characters'));
                await expect(page.locator('.sb-character-list[data-view="characters"]')).toBeVisible();
                await listAction();
                const list = await readState(page, listButton);
                await page.locator('.character_select').first().getByRole('button', { name: 'Edit', exact: true }).click();
                await expect(page.locator('#sb_character_editor_toolbar')).toBeVisible();
                await editorAction();
                const editor = await readState(page, editorButton);
                expect(editor.icon.color, `${theme} ${state} icon color`).toBe(list.icon.color);
                expect(editor.icon.opacity, `${theme} ${state} icon opacity`).toBe(list.icon.opacity);
                expect(list.button.border, `${theme} ${state} list border`).toMatch(/^0px none/);
                expect(editor.button.border, `${theme} ${state} editor border`).toMatch(/^0px none/);
                expect(list.button.outline, `${theme} ${state} list outline`).toContain('none');
                expect(editor.button.outline, `${theme} ${state} editor outline`).toContain('none');
                expect(list.button.borderRadius, `${theme} ${state} list icon corners`).toBe('999px');
                expect(editor.button.borderRadius, `${theme} ${state} editor icon corners`).toBe('999px');
            };

            await compare('rest', async () => {}, async () => {});
            await compare('hover', async () => { await page.locator(listButton).hover(); }, async () => { await page.locator(editorButton).hover(); });
            await compare('pressed', async () => page.evaluate(() => {
                document.querySelector('.sb-character-list .sb-list-header__button[data-action-id="search"]').setAttribute('aria-pressed', 'true');
            }), async () => page.evaluate(() => {
                const favorite = document.getElementById('favorite_button');
                favorite.setAttribute('aria-pressed', 'true');
            }));
            const pressedList = await readState(page, listButton);
            const pressedEditor = await readState(page, editorButton);
            expect(pressedList.button.color).toBe(pressedEditor.button.color);
            expect(pressedList.button.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
            expect(pressedList.button.backgroundColor).toBe(pressedEditor.button.backgroundColor);
            const foreground = await page.locator(listButton).evaluate(button => {
                const probe = document.createElement('span');
                probe.style.color = 'var(--sb-shell-text)';
                button.parentElement.append(probe);
                const color = getComputedStyle(probe).color;
                probe.remove();
                return color;
            });
            expect(pressedList.button.color).toBe(foreground);

            await page.evaluate(() => {
                document.getElementById('world_button').classList.add('world_set');
                document.getElementById('favorite_button').classList.remove('fav_off');
                document.getElementById('favorite_button').classList.add('fav_on');
            });
            const active = await readState(page, globe);
            const activeFavorite = await readState(page, editorButton);
            const accent = await page.locator(globe).evaluate(node => {
                const probe = document.createElement('span');
                probe.style.color = 'var(--sb-accent)';
                node.parentElement.append(probe);
                const color = getComputedStyle(probe).color;
                probe.remove();
                return color;
            });
            expect(active.icon.color).toBe(accent);
            expect(activeFavorite.button.color).toBe(accent);
        });
    }
});
