import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';

const character = {
    name: 'Header Icon Character', description: '', personality: '', scenario: '', first_mes: 'Hello', mes_example: '',
    creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '',
    character_version: '', extensions: { fav: false, talkativeness: 0.5 }, avatar: 'header-icon.png',
    chat: 'header-icon-chat', create_date: '2026-10-24', date_added: 1, spec: 'chara_card_v2', spec_version: '2.0',
    data: { name: 'Header Icon Character', description: '', personality: '', scenario: '', first_mes: 'Hello', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: { fav: false, talkativeness: 0.5 } },
};
const worldInfoBook = 'Header Icon World Info';

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

async function readHeaderHover(button) {
    await button.hover();
    return button.evaluate(node => ({
        backgroundColor: getComputedStyle(node).backgroundColor,
        borderRadius: getComputedStyle(node).borderRadius,
    }));
}

async function readColorToken(page, token) {
    return page.evaluate(variable => {
        const probe = document.createElement('span');
        probe.style.color = `var(${variable})`;
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
    }, token);
}

test.describe('character list and editor header icon parity', () => {
    test.use({ viewport: { width: 1440, height: 900 } });
    test.setTimeout(90000);

    test.beforeEach(async ({ page }) => {
        await protectMaintainerServer(page);
        await page.route('**/api/characters/all', route => route.fulfill({ json: [character] }));
        await page.route('**/api/characters/chats', route => route.fulfill({ json: {} }));
        await page.route('**/api/chats/get', route => route.fulfill({ json: [] }));
        await page.route('**/api/groups/all', route => route.fulfill({ json: [] }));
        await page.route('**/api/settings/get', async route => {
            const settings = await fetchJsonOrSkip(route);
            if (!settings) return;
            return route.fulfill({ json: { ...settings, world_names: [worldInfoBook] } });
        });
        await page.route('**/api/worldinfo/get', route => route.fulfill({ json: { entries: { 0: { uid: 0, comment: 'Header Icon Entry', key: [], content: '', order: 100 } } } }));
        await page.goto('/');
        await page.waitForFunction(() => !document.getElementById('preloader'), null, { timeout: 60000 });
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
            const archiveRadius = await page.locator('#sbca_drawer_button').evaluate(node => getComputedStyle(node).borderRadius);
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
                expect(list.button.borderRadius, `${theme} ${state} list icon corners`).toBe(archiveRadius);
                expect(editor.button.borderRadius, `${theme} ${state} editor icon corners`).toBe(archiveRadius);
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

    for (const theme of ['Libadwaita', 'Libadwaita Light']) {
        test(`${theme} Persona and World Info header icons use the shared hover fill and Chat Archive corner shape`, async ({ page }) => {
            await setTheme(page, theme);
            const archiveRadius = await page.locator('#sbca_drawer_button').evaluate(node => getComputedStyle(node).borderRadius);
            const hoverFill = await page.evaluate(() => {
                const probe = document.createElement('button');
                probe.style.backgroundColor = 'var(--sb-flat-hover-bg)';
                document.body.append(probe);
                const backgroundColor = getComputedStyle(probe).backgroundColor;
                probe.remove();
                return backgroundColor;
            });

            await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'persona'));
            const personaButtons = page.locator('#PersonaManagement .sb-persona-list-header .sb-header-icon-button');
            await expect(personaButtons).toHaveCount(4);
            for (let index = 0; index < await personaButtons.count(); index++) {
                const button = personaButtons.nth(index);
                await expect(button).toBeEnabled();
                await expect.poll(() => readHeaderHover(button)).toEqual({ backgroundColor: hoverFill, borderRadius: archiveRadius });
            }

            await page.evaluate(async name => {
                await window.SillyBunnyShell.openTab('characters', 'world-info');
                const { openWorldInfoEditor } = await import('./scripts/world-info.js');
                await openWorldInfoEditor(name);
            }, worldInfoBook);
            const worldInfoButtons = page.locator('#WorldInfo .sb-wi-list-header .sb-header-icon-button');
            await expect(worldInfoButtons).toHaveCount(4);
            for (let index = 0; index < await worldInfoButtons.count(); index++) {
                const button = worldInfoButtons.nth(index);
                await expect(button).toBeEnabled();
                await expect.poll(() => readHeaderHover(button)).toEqual({ backgroundColor: hoverFill, borderRadius: archiveRadius });
            }
        });
    }

    test('mobile Persona and World Info header icons keep the Chat Archive corner shape', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await setTheme(page, 'Libadwaita');
        const archiveRadius = await page.locator('#sbca_drawer_button').evaluate(node => getComputedStyle(node).borderRadius);

        for (const [tab, selector] of [
            ['persona', '#PersonaManagement .sb-persona-list-header .sb-header-icon-button[aria-label="Search"]'],
            ['world-info', '#WorldInfo .sb-wi-list-header .sb-wi-book-actions'],
        ]) {
            await page.evaluate(tabName => window.SillyBunnyShell.openTab('characters', tabName), tab);
            await expect(page.locator(selector)).toBeVisible();
            await expect.poll(() => page.locator(selector).evaluate(node => getComputedStyle(node).borderRadius)).toBe(archiveRadius);
        }
    });

    for (const width of [1440, 390]) {
        test.describe(`${width}px suggested status actions`, () => {
            test.use({ viewport: { width, height: 844 }, hasTouch: width === 390, isMobile: width === 390 });

            test('World Info pick status keeps its suggested action accent treatment', async ({ page }) => {
                await setTheme(page, 'Libadwaita');
                await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'world-info'));
                const chooseWorld = page.locator('#WorldInfo .sb-status-page__action.is-suggested');
                await expect(chooseWorld).toHaveText('Worlds/Lorebooks');
                await expect(chooseWorld).toBeVisible();
                expect(await chooseWorld.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(await readColorToken(page, '--sb-accent'));
                expect(await chooseWorld.evaluate(node => getComputedStyle(node).color)).toBe(await readColorToken(page, '--sb-on-solid-accent'));
                await expect(chooseWorld).toHaveCSS('min-height', width === 390 ? '44px' : '38px');

                const secondaryActions = page.locator('#WorldInfo .sb-status-page__action:not(.is-suggested)');
                await expect(secondaryActions).toHaveCount(2);
                const shellText = await readColorToken(page, '--sb-shell-text');
                for (let index = 0; index < await secondaryActions.count(); index++) {
                    const button = secondaryActions.nth(index);
                    expect(await button.evaluate(node => getComputedStyle(node).color)).toBe(shellText);
                    await expect(button).toHaveCSS('border-radius', '9px');
                    await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
                    expect(await button.evaluate(node => getComputedStyle(node).border)).toMatch(/^0px none/);
                }
            });

            test('empty Persona keeps the suggested New action accent treatment', async ({ page }) => {
                await setTheme(page, 'Libadwaita');
                await page.route('**/api/avatars/get', route => route.fulfill({ json: [] }));
                await page.evaluate(async () => {
                    const { power_user } = await import('./scripts/power-user.js');
                    power_user.personas = {};
                    power_user.persona_descriptions = {};
                    await window.SillyBunnyShell.openTab('characters', 'persona');
                });
                const createButton = page.locator('#PersonaManagement .sb-status-page__action.is-suggested');
                await expect(createButton).toHaveText('New');
                await expect(createButton).toBeVisible();
                expect(await createButton.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(await readColorToken(page, '--sb-accent'));
                expect(await createButton.evaluate(node => getComputedStyle(node).color)).toBe(await readColorToken(page, '--sb-on-solid-accent'));
                await expect(createButton).toHaveCSS('min-height', width === 390 ? '44px' : '38px');
            });
        });
    }

    test('World Info secondary status actions keep shell foreground and button hover fill', async ({ page }) => {
        await setTheme(page, 'Libadwaita');
        await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'world-info'));
        const secondaryActions = page.locator('#WorldInfo .sb-status-page__action:not(.is-suggested)');
        await expect(secondaryActions).toHaveCount(2);
        const shellText = await readColorToken(page, '--sb-shell-text');
        const hoverFill = await readColorToken(page, '--sb-flat-hover-bg');
        for (let index = 0; index < await secondaryActions.count(); index++) {
            const button = secondaryActions.nth(index);
            expect(await button.evaluate(node => getComputedStyle(node).color)).toBe(shellText);
            expect(await button.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
            expect(await button.evaluate(node => getComputedStyle(node).border)).toMatch(/^0px none/);
            await expect(button).toHaveCSS('border-radius', '9px');
            await expect.poll(() => readHeaderHover(button)).toMatchObject({ backgroundColor: hoverFill });
        }
    });
});
