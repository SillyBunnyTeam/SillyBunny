import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { waitForAppReady } from './helpers/app-ready.js';
import { scanStable } from './helpers/axe-scan.js';

// The Backgrounds gallery's folders. Backgrounds and folders are made on the server the test runs against, with names that
// start with PREFIX, and removed again after each test.
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const PREFIX = 'p13e-';
const NAMES = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map(name => `${PREFIX}${name}.png`);
const STUB = file => `#bg_menu_content .bg_example[bgfile="${file}"]`;

async function seed(page, { folders = [], members = {} } = {}) {
    return page.evaluate(async ({ names, folders: folderNames, members: memberMap }) => {
        const { getRequestHeaders } = await import('./script.js');
        const { getBackgrounds } = await import('./scripts/backgrounds.js');
        const json = headers => ({ ...getRequestHeaders(), ...headers });
        const post = async (path, body) => (await fetch(path, { method: 'POST', headers: json(), body: JSON.stringify(body) })).json().catch(() => ({}));
        for (const [index, name] of names.entries()) {
            const canvas = document.createElement('canvas');
            canvas.width = 64;
            canvas.height = 36;
            const context = canvas.getContext('2d');
            context.fillStyle = `hsl(${index * 55}, 70%, 50%)`;
            context.fillRect(0, 0, 64, 36);
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            const form = new FormData();
            form.append('avatar', new File([blob], name, { type: 'image/png' }));
            await fetch('/api/backgrounds/upload', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form });
        }
        const ids = {};
        for (const folderName of folderNames) ids[folderName] = (await post('/api/image-metadata/folders/create', { name: folderName })).id;
        for (const [folderName, files] of Object.entries(memberMap)) {
            if (files.length) await post('/api/image-metadata/folders/assign', { id: ids[folderName], paths: files.map(file => `backgrounds/${file}`) });
        }
        await getBackgrounds();
        return ids;
    }, { names: NAMES, folders, members });
}

async function cleanup(page) {
    await page.evaluate(async prefix => {
        const { getRequestHeaders } = await import('./script.js');
        const post = (path, body) => fetch(path, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
        const { folders } = await (await post('/api/backgrounds/folders', {})).json();
        for (const folder of folders) if (folder.name.startsWith(prefix)) await post('/api/image-metadata/folders/delete', { id: folder.id });
        const { images } = await (await post('/api/backgrounds/all', {})).json();
        for (const image of images) if (image.filename.startsWith(prefix)) await post('/api/backgrounds/delete', { bg: image.filename });
    }, PREFIX);
}

const serverFolders = page => page.evaluate(async () => {
    const { getRequestHeaders } = await import('./script.js');
    return (await fetch('/api/backgrounds/folders', { method: 'POST', headers: getRequestHeaders(), body: '{}' })).json();
});

async function openGallery(page) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'appearance'));
    await page.locator('button[data-sb-settings-tab="appearance"]').evaluate(button => button.click());
    await expect(page.locator('#bg_tabs')).toBeVisible();
    await expect(page.locator('#Backgrounds .sb-bg-search-field')).toBeVisible();
    await page.locator('#bg_tabs').scrollIntoViewIfNeeded();
}

const folderRow = (page, name) => page.locator('#bg_menu_content .sb-folder-row', { hasText: name });
const section = (page, name) => page.locator('#bg_menu_content .sb-bg-section', { has: page.locator('.sb-folder-row', { hasText: name }) });
const stored = page => page.evaluate(async () => structuredClone((await import('./scripts/power-user.js')).power_user.sb_folders.backgrounds ?? null));
const currentBackground = page => page.evaluate(async () => (await import('./scripts/backgrounds.js')).background_settings.name);

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    await page.goto('/');
    await waitForAppReady(page, { timeout: 60_000 });
});

test.afterEach(async ({ page }) => {
    await cleanup(page).catch(() => {});
});

async function endsOf(page) {
    return page.evaluate(() => {
        const edge = node => Math.round(node.getBoundingClientRect().right * 100) / 100;
        // A hidden button that still takes room is the gap the user saw, so only a button the user can see counts as the last one.
        const controls = [...document.querySelectorAll('#bg_tabs .heading-controls > *')]
            .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
        const grid = document.getElementById('bg_menu_content');
        const cells = [...grid.querySelectorAll('.bg_example')].filter(node => node.getClientRects().length);
        return {
            lastControl: edge(controls.at(-1)),
            grid: edge(grid),
            widestCell: Math.max(...cells.map(edge)),
            row: edge(document.querySelector('#bg_tabs')),
        };
    });
}

for (const { label, width, height, touch } of [
    { label: 'desktop', width: 1440, height: 900, touch: false },
    { label: 'phone', width: 390, height: 844, touch: true },
]) {
    test.describe(`Background folders on ${label}`, () => {
        test.use({ viewport: { width, height }, hasTouch: touch, isMobile: touch });

        test('the tab row ends where the thumbnail grid ends, with and without folders and with the scroll button shown', async ({ page }) => {
            await seed(page);
            await openGallery(page);
            await expect(page.locator(STUB(NAMES[0]))).toBeVisible();
            let ends = await endsOf(page);
            expect(ends.lastControl).toBeCloseTo(ends.grid, 0);
            expect(ends.widestCell).toBeCloseTo(ends.grid, 0);

            await page.evaluate(() => document.getElementById('bg-scroll-top').classList.add('visible'));
            ends = await endsOf(page);
            expect(ends.lastControl).toBeCloseTo(ends.grid, 0);
            await page.evaluate(() => document.getElementById('bg-scroll-top').classList.remove('visible'));

            await seed(page, { folders: [`${PREFIX}One`], members: { [`${PREFIX}One`]: [NAMES[0]] } });
            await expect(folderRow(page, `${PREFIX}One`)).toBeVisible();
            ends = await endsOf(page);
            expect(ends.lastControl).toBeCloseTo(ends.grid, 0);
            const sectionEdge = await page.locator('#bg_menu_content .sb-bg-section').first().evaluate(node => Math.round(node.getBoundingClientRect().right * 100) / 100);
            expect(sectionEdge).toBeCloseTo(ends.lastControl, 0);
        });

        test('folders are sections with a count, closed folders build no thumbnails, and the rest follow under No Folder', async ({ page }) => {
            await seed(page, {
                folders: [`${PREFIX}One`, `${PREFIX}Empty`],
                members: { [`${PREFIX}One`]: [NAMES[0], NAMES[1]], [`${PREFIX}Empty`]: [] },
            });
            await openGallery(page);
            await expect(folderRow(page, `${PREFIX}One`)).toHaveAccessibleName(`${PREFIX}One 2 backgrounds`);
            await expect(folderRow(page, `${PREFIX}Empty`)).toHaveAccessibleName(`${PREFIX}Empty 0 backgrounds`);
            await expect(section(page, `${PREFIX}One`).locator('.bg_example')).toHaveCount(2);
            await expect(page.locator('.sb-bg-unfiled__heading')).toHaveText('No Folder');
            await expect(page.locator('.sb-bg-unfiled .bg_example[bgfile^="p13e-"]')).toHaveCount(4);

            await folderRow(page, `${PREFIX}One`).click();
            await expect(section(page, `${PREFIX}One`).locator('.bg_example')).toHaveCount(0);
            await expect.poll(async () => (await stored(page))?.folders.find(folder => folder.name === `${PREFIX}One`)?.expanded).toBe(false);
            await folderRow(page, `${PREFIX}One`).click();
            await expect(section(page, `${PREFIX}One`).locator('.bg_example')).toHaveCount(2);
            const server = await serverFolders(page);
            expect(Object.keys(server.imageFolderMap).filter(file => file.startsWith(PREFIX)).sort()).toEqual([NAMES[0], NAMES[1]]);
            for (const folder of server.folders.filter(entry => entry.name.startsWith(PREFIX))) expect(Object.keys(folder).sort()).toEqual(['id', 'name', 'thumbnailFile']);
        });

        test('with no folders the gallery is the flat grid, with no heading', async ({ page }) => {
            await seed(page);
            await openGallery(page);
            await expect(page.locator(STUB(NAMES[0]))).toBeVisible();
            await expect(page.locator('#bg_menu_content > .bg_example[bgfile^="p13e-"]')).toHaveCount(NAMES.length);
            await expect(page.locator('.sb-bg-unfiled__heading, #bg_menu_content .sb-folder-row')).toHaveCount(0);
        });

        test('Move to Folder files a background in one folder, from the thumbnail menu', async ({ page }) => {
            const ids = await seed(page, { folders: [`${PREFIX}One`, `${PREFIX}Two`], members: { [`${PREFIX}One`]: [NAMES[0]], [`${PREFIX}Two`]: [NAMES[0]] } });
            await openGallery(page);
            // Upstream data placed this file in both folders, so it shows in both until it is moved.
            await expect(page.locator(`#bg_menu_content .bg_example[bgfile="${NAMES[0]}"]`)).toHaveCount(2);
            const cell = section(page, `${PREFIX}One`).locator(`.bg_example[bgfile="${NAMES[0]}"]`);
            await cell.locator('.sb-bg-cell-menu').focus();
            await page.keyboard.press('Enter');
            await expect(page.getByRole('menuitem', { name: 'Move to Folder', exact: true })).toBeVisible();
            await page.getByRole('menuitem', { name: 'Move to Folder', exact: true }).click();
            await page.getByRole('menuitemradio', { name: `${PREFIX}Two`, exact: true }).click();
            await expect(page.locator(`#bg_menu_content .bg_example[bgfile="${NAMES[0]}"]`)).toHaveCount(1);
            await expect(section(page, `${PREFIX}Two`).locator(`.bg_example[bgfile="${NAMES[0]}"]`)).toHaveCount(1);
            await expect.poll(async () => (await serverFolders(page)).imageFolderMap[NAMES[0]]).toEqual([ids[`${PREFIX}Two`]]);
        });

        test('selection mode moves and deletes the selected backgrounds, and the delete confirmation states the count', async ({ page }) => {
            const ids = await seed(page, { folders: [`${PREFIX}One`], members: { [`${PREFIX}One`]: [NAMES[0]] } });
            await openGallery(page);
            await page.getByRole('button', { name: 'Background', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Select', exact: true }).click();
            await expect(page.locator('#Backgrounds')).toHaveAttribute('data-selection-mode', 'true');
            await page.locator(STUB(NAMES[1])).click();
            await page.locator(STUB(NAMES[2])).click();
            const bar = page.locator('.sb-bg-selection-bar');
            await expect(bar.getByRole('button')).toHaveText(['Move to Folder', 'Delete']);
            await bar.getByRole('button', { name: 'Move to Folder' }).click();
            await page.getByRole('menuitemradio', { name: `${PREFIX}One`, exact: true }).click();
            await expect(page.locator('#Backgrounds')).toHaveAttribute('data-selection-mode', 'false');
            await expect.poll(async () => Object.entries((await serverFolders(page)).imageFolderMap).filter(([, folderIds]) => folderIds.includes(ids[`${PREFIX}One`])).map(([file]) => file).sort())
                .toEqual([NAMES[0], NAMES[1], NAMES[2]]);

            await page.getByRole('button', { name: 'Background', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Select', exact: true }).click();
            await page.locator(STUB(NAMES[3])).click();
            await page.locator(STUB(NAMES[4])).click();
            await page.locator('.sb-bg-selection-bar').getByRole('button', { name: 'Delete' }).click();
            const confirmation = page.locator('.sb-popup-destructive-confirm');
            await expect(confirmation).toContainText('2 backgrounds');
            await confirmation.getByRole('button', { name: 'Cancel' }).click();
            await expect(page.locator(STUB(NAMES[3]))).toBeVisible();
            await page.locator('.sb-bg-selection-bar').getByRole('button', { name: 'Delete' }).click();
            await page.locator('.sb-popup-destructive-confirm').getByRole('button', { name: 'Delete' }).click();
            await expect(page.locator(STUB(NAMES[3]))).toHaveCount(0);
            await expect(page.locator(STUB(NAMES[4]))).toHaveCount(0);
            await expect(page.locator(STUB(NAMES[5]))).toBeVisible();
            const { images } = await page.evaluate(async () => {
                const { getRequestHeaders } = await import('./script.js');
                return (await fetch('/api/backgrounds/all', { method: 'POST', headers: getRequestHeaders(), body: '{}' })).json();
            });
            expect(images.map(image => image.filename).filter(file => file.startsWith(PREFIX)).sort()).toEqual([NAMES[0], NAMES[1], NAMES[2], NAMES[5]]);
        });

        test('a search opens the folders that hold a match and leaves their stored state alone', async ({ page }) => {
            await seed(page, { folders: [`${PREFIX}One`, `${PREFIX}Two`], members: { [`${PREFIX}One`]: [NAMES[0], NAMES[1]], [`${PREFIX}Two`]: [NAMES[2]] } });
            await openGallery(page);
            await folderRow(page, `${PREFIX}One`).click();
            await expect.poll(async () => (await stored(page))?.folders.find(folder => folder.name === `${PREFIX}One`)?.expanded).toBe(false);
            await expect(section(page, `${PREFIX}One`).locator('.bg_example')).toHaveCount(0);
            await page.locator('#bg-filter').fill('bravo');
            await expect(section(page, `${PREFIX}One`).locator('.bg_example')).toHaveCount(1);
            await expect(section(page, `${PREFIX}Two`)).toHaveCount(0);
            expect((await stored(page)).folders.find(folder => folder.name === `${PREFIX}One`).expanded).toBe(false);
            await page.locator('#bg-filter').fill('');
            await expect(section(page, `${PREFIX}One`).locator('.bg_example')).toHaveCount(0);
            await expect(section(page, `${PREFIX}Two`)).toHaveCount(1);
        });

        test('the Chat tab keeps its behaviour and has no folders', async ({ page }) => {
            await seed(page, { folders: [`${PREFIX}One`], members: { [`${PREFIX}One`]: [NAMES[0]] } });
            await openGallery(page);
            await expect(page.getByRole('button', { name: 'Background', exact: true })).toBeVisible();
            await page.locator('#bg_tabs a[href="#bg_chat_tab"]').click();
            await expect(page.locator('#bg_chat_tab')).toBeVisible();
            await expect(page.locator('#bg_chat_tab .sb-bg-section, #bg_chat_tab .sb-folder-row')).toHaveCount(0);
            await expect(page.getByRole('button', { name: 'Background', exact: true })).toBeHidden();
            await page.locator('#bg_tabs a[href="#bg_global_tab"]').click();
            await expect(folderRow(page, `${PREFIX}One`)).toBeVisible();
        });

        test('the Folder Manager creates a folder with the id the server issues, and Remove takes a file out of that folder only', async ({ page }) => {
            const ids = await seed(page, { folders: [`${PREFIX}One`, `${PREFIX}Two`], members: { [`${PREFIX}One`]: [NAMES[0]], [`${PREFIX}Two`]: [NAMES[0]] } });
            await openGallery(page);
            await page.getByRole('button', { name: 'Background', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Manage Folders', exact: true }).click();
            const manager = page.locator('.sb-dialog-host[open]:has(> .sb-folder-manager)');
            await expect(manager).toBeVisible();
            await manager.locator('.sb-dialog__header-end').getByRole('button', { name: 'New Folder', exact: true }).click();
            const input = page.locator('.sb-custom-popover:visible, .sb-action-sheet:visible').getByRole('textbox', { name: 'New Folder', exact: true });
            await input.fill(`${PREFIX}Three`);
            await input.press('Enter');
            const server = (await serverFolders(page)).folders.find(folder => folder.name === `${PREFIX}Three`);
            expect(server).toBeTruthy();
            await expect(manager.locator(`[data-folder-id="${server.id}"]`)).toBeVisible();
            await manager.locator(`[data-folder-id="${ids[`${PREFIX}One`]}"] .ds-entity-row__chevron`).click();
            await manager.locator('.sb-folder-manager__remove').click();
            await expect.poll(async () => (await serverFolders(page)).imageFolderMap[NAMES[0]]).toEqual([ids[`${PREFIX}Two`]]);
        });

        test('the gallery with folders, open and in selection mode, has no WCAG A or AA violation', async ({ page }) => {
            await seed(page, { folders: [`${PREFIX}One`, `${PREFIX}Empty`], members: { [`${PREFIX}One`]: [NAMES[0], NAMES[1]], [`${PREFIX}Empty`]: [] } });
            await openGallery(page);
            await expect(folderRow(page, `${PREFIX}One`)).toBeVisible();
            const found = result => result.violations.map(violation => `${violation.id}: ${violation.nodes.map(node => node.target).join(' | ')}`);
            const open = await scanStable(page, '#bg_menu_content');
            expect(found(open)).toEqual([]);
            await page.getByRole('button', { name: 'Background', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Select', exact: true }).click();
            await page.locator(STUB(NAMES[0])).first().click();
            const selecting = await scanStable(page, '#bg_menu_content');
            expect(found(selecting)).toEqual([]);
        });

        test('the keyboard opens a background\'s menu from a focused thumbnail', async ({ page }) => {
            await seed(page);
            await openGallery(page);
            const cell = page.locator(STUB(NAMES[0]));
            await cell.focus();
            await page.keyboard.press('Shift+F10');
            await expect(page.getByRole('menuitem', { name: 'Set as Background', exact: true })).toBeVisible();
            await expect(page.locator('#Backgrounds')).toHaveAttribute('data-selection-mode', 'false');
            await page.keyboard.press('Escape');
            await expect(page.getByRole('menuitem', { name: 'Set as Background', exact: true })).toBeHidden();
            await cell.focus();
            await page.keyboard.press('ContextMenu');
            await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeVisible();
            await expect(page.locator('#Backgrounds')).toHaveAttribute('data-selection-mode', 'false');
        });
    });
}

test.describe('Background thumbnails on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('no button covers the title, a tap sets the background and a long press opens the menu', async ({ page }) => {
        await seed(page);
        await openGallery(page);
        const cell = page.locator(STUB(NAMES[1]));
        await expect(cell).toBeVisible();
        const button = cell.locator('.sb-bg-cell-menu');
        await expect(button).toHaveCSS('opacity', '0');
        await expect(button).toHaveCSS('pointer-events', 'none');

        await cell.tap();
        await expect.poll(() => currentBackground(page)).toBe(NAMES[1]);

        const other = page.locator(STUB(NAMES[2]));
        await other.evaluate(async node => {
            const rect = node.getBoundingClientRect();
            const init = { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: rect.x + 20, clientY: rect.y + 20, bubbles: true, cancelable: true, composed: true };
            node.dispatchEvent(new PointerEvent('pointerdown', init));
            await new Promise(resolve => setTimeout(resolve, 700));
            node.dispatchEvent(new PointerEvent('pointerup', init));
            node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, clientX: init.clientX, clientY: init.clientY }));
        });
        await expect(page.getByRole('menuitem', { name: 'Set as Background', exact: true })).toBeVisible();
        expect(await currentBackground(page)).toBe(NAMES[1]);
        await expect(page.locator('#Backgrounds')).toHaveAttribute('data-selection-mode', 'false');
        await page.getByRole('menuitem', { name: 'Set as Background', exact: true }).click();
        await expect.poll(() => currentBackground(page)).toBe(NAMES[2]);
    });

    test('the menu button shows when a thumbnail has keyboard focus', async ({ page }) => {
        await seed(page);
        await openGallery(page);
        const button = page.locator(STUB(NAMES[0])).locator('.sb-bg-cell-menu');
        await button.focus();
        await expect(button).toHaveCSS('opacity', '1');
    });
});
