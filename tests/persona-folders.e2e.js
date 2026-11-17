import { expect, test } from '@playwright/test';
import { gunzipSync } from 'node:zlib';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';
import { waitForAppReady } from './helpers/app-ready.js';

const sessions = new WeakMap();

test.setTimeout(90000);

async function waitForApp(page) {
    await waitForAppReady(page, { timeout: 60000 });
}

// Uploads and deletes are stubbed, so no avatar file is written or removed on the server these tests run against.
test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    const session = { saved: [], created: new Set() };
    sessions.set(page, session);
    await page.route('**/api/settings/save', route => {
        const request = route.request();
        const body = request.headers()['content-encoding'] === 'gzip' ? gunzipSync(request.postDataBuffer()) : request.postDataBuffer();
        const payload = JSON.parse(body.toString());
        session.saved.push(payload);
        return route.fulfill({ json: { result: 'ok', version: payload._version + 1 } });
    });
    await page.route('**/api/avatars/get', async route => {
        const avatars = await fetchJsonOrSkip(route);
        if (!avatars) return;
        return route.fulfill({ json: [...avatars, ...session.created] });
    });
    await page.route('**/api/avatars/upload', route => {
        const path = route.request().postDataBuffer().toString('latin1').match(/name="overwrite_name"\r\n\r\n([^\r\n]+)/)?.[1];
        if (!path) throw new Error('Persona upload fixture requires an overwrite_name');
        session.created.add(path);
        return route.fulfill({ json: { path } });
    });
    await page.route('**/api/avatars/delete', route => {
        session.created.delete(route.request().postDataJSON().avatar);
        return route.fulfill({ json: { result: 'ok' } });
    });
    await page.goto('/');
    await waitForApp(page);
});

const savedFolders = page => sessions.get(page).saved.findLast(payload => payload.power_user?.sb_folders)?.power_user.sb_folders;
const editorFor = page => page.locator('#PersonaManagement .sb-persona-editor');
const storedFolders = page => page.evaluate(async () => structuredClone((await import('./scripts/power-user.js')).power_user.sb_folders));

async function currentPersona(page) {
    return page.evaluate(async () => {
        const { user_avatar, getPersonaRecord } = await import('./scripts/personas.js');
        const record = getPersonaRecord(user_avatar);
        if (!record) throw new Error('The running instance needs a current persona for these tests');
        return record;
    });
}

async function openList(page) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'persona'));
    const editor = editorFor(page);
    await expect(editor).toBeVisible();
    await expect(editor.getByRole('listitem').first()).toBeVisible();
    return editor;
}

async function createFolderInManager(page, editor, name) {
    await editor.getByRole('button', { name: 'Persona Management', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Manage Folders', exact: true }).click();
    const manager = page.locator('.sb-dialog-host[open]:has(> .sb-folder-manager)');
    await expect(manager).toBeVisible();
    await manager.locator('.sb-dialog__header-end').getByRole('button', { name: 'New Folder', exact: true }).click();
    const input = page.locator('.sb-custom-popover:visible, .sb-action-sheet:visible').getByRole('textbox', { name: 'New Folder', exact: true });
    await expect(input).toBeFocused();
    await input.fill(name);
    await input.press('Enter');
    await expect(manager.locator('.sb-folder-manager__folder-row')).toHaveCount(1);
    return manager;
}

for (const { label, width } of [{ label: 'desktop', width: 1440 }, { label: 'mobile', width: 390 }]) {
    test.describe(`Persona folders on ${label}`, () => {
        test.use({ viewport: { width, height: 844 }, hasTouch: width === 390, isMobile: width === 390 });

        test('settings without the scope load unchanged, and a folder made in the manager holds a persona filed from its editor', async ({ page }) => {
            const persona = await currentPersona(page);
            expect(Object.keys(await storedFolders(page))).not.toContain('personas');
            const editor = await openList(page);
            const manager = await createFolderInManager(page, editor, 'Cast');
            await manager.locator('.sb-dialog__close').click();
            await expect(manager).toBeHidden();
            const folder = (await storedFolders(page)).personas.folders[0];
            expect(folder).toMatchObject({ name: 'Cast', expanded: true });
            await expect(editor.locator('.sb-folder-row')).toHaveAccessibleName('Cast, 0 personas');

            await editor.getByRole('listitem', { name: persona.name, exact: true }).click();
            const folderRow = editor.locator('.sb-persona-entry [data-sb-editor-field="folder"]');
            await expect(folderRow.locator('.ds-select-row__trigger')).toHaveText('No folder');
            await folderRow.locator('.ds-select-row__trigger').click();
            await page.getByRole('option', { name: 'Cast', exact: true }).click();
            await expect(folderRow.locator('.ds-select-row__trigger')).toHaveText('Cast');
            await expect(editor.locator('.sb-folder-row')).toHaveAccessibleName('Cast, 1 persona');
            await expect.poll(() => savedFolders(page)?.personas?.members).toEqual({ [persona.avatarId]: folder.id });
            expect(savedFolders(page).characters.members).toEqual((await storedFolders(page)).characters.members);
            // The persona is filed under its header, so it is not dirty and Save stays off.
            await expect(editor.locator('.sb-persona-entry').getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
        });

        test('a header collapses and opens its folder, a search opens it for the match, and the stored choice survives', async ({ page }) => {
            const persona = await currentPersona(page);
            await page.evaluate(async ({ avatarId }) => {
                const folders = await import('./scripts/sillybunny-folders.js');
                folders.setFolder('personas', [avatarId], folders.createFolder('personas', 'Cast').id);
            }, { avatarId: persona.avatarId });
            const editor = await openList(page);
            const header = editor.locator('.sb-folder-row');
            const row = editor.getByRole('listitem', { name: persona.name, exact: true });
            await expect(row).toBeVisible();
            await header.click();
            await expect(row).toHaveCount(0);
            await expect(header).toHaveAttribute('aria-expanded', 'false');
            expect((await storedFolders(page)).personas.folders[0].expanded).toBe(false);

            await editor.getByRole('button', { name: 'Search', exact: true }).click();
            await editor.locator('.sb-persona-search').fill(persona.name);
            await expect(row).toBeVisible();
            await expect(header).toHaveClass(/is-folder-temporarily-expanded/);
            expect((await storedFolders(page)).personas.folders[0].expanded).toBe(false);

            await editor.locator('.sb-persona-search').fill('');
            await expect(row).toHaveCount(0);
            await header.focus();
            await page.keyboard.press('Enter');
            await expect(row).toBeVisible();
        });

        test('a folder closes and opens with motion on its rows and a turning chevron, and reduced motion skips both', async ({ page }) => {
            const persona = await currentPersona(page);
            await page.evaluate(async ({ avatarId }) => {
                const folders = await import('./scripts/sillybunny-folders.js');
                folders.setFolder('personas', [avatarId], folders.createFolder('personas', 'Cast').id);
            }, { avatarId: persona.avatarId });
            const editor = await openList(page);
            const header = editor.locator('.sb-folder-row');
            const members = editor.locator('.sb-persona-row.is-folder-member');
            const chevron = header.locator('.ds-entity-row__chevron');
            await expect(members).toHaveCount(1);
            await expect(chevron).toHaveCSS('transform', 'matrix(-1, 0, 0, -1, 0, 0)');
            await expect(chevron).toHaveClass(/fa-chevron-down/);

            const closing = await header.evaluate(node => {
                const rows = [...node.parentElement.querySelectorAll('.is-folder-member')];
                node.click();
                return { animated: rows.map(row => row.getAnimations().length), kept: rows.map(row => row.isConnected), expanded: node.getAttribute('aria-expanded') };
            });
            expect(closing).toEqual({ animated: [1], kept: [true], expanded: 'false' });
            await expect(members).toHaveCount(0);
            await expect(chevron).toHaveCSS('transform', 'none');
            expect((await storedFolders(page)).personas.folders[0].expanded).toBe(false);

            const opening = await header.evaluate(node => {
                node.click();
                return [...node.parentElement.querySelectorAll('.is-folder-member')].map(row => row.getAnimations().length);
            });
            expect(opening).toEqual([1]);
            await expect(chevron).toHaveCSS('transform', 'matrix(-1, 0, 0, -1, 0, 0)');

            await page.emulateMedia({ reducedMotion: 'reduce' });
            await expect(members).toHaveCount(1);
            const still = await header.evaluate(node => {
                const rows = [...node.parentElement.querySelectorAll('.is-folder-member')];
                node.click();
                return rows.map(row => row.getAnimations().length);
            });
            expect(still).toEqual([0]);
            await expect(members).toHaveCount(0);
            await expect(chevron).toHaveCSS('transition-duration', '0s');
        });

        test('a duplicate keeps the folder of its source and a deleted persona leaves its folder', async ({ page }) => {
            const persona = await currentPersona(page);
            const folderId = await page.evaluate(async ({ avatarId }) => {
                const folders = await import('./scripts/sillybunny-folders.js');
                const folder = folders.createFolder('personas', 'Cast');
                folders.setFolder('personas', [avatarId], folder.id);
                return folder.id;
            }, { avatarId: persona.avatarId });
            const editor = await openList(page);

            const copyId = await page.evaluate(async avatarId => (await import('./scripts/personas.js')).duplicatePersonaRecord(avatarId), persona.avatarId);
            expect(copyId).toBeTruthy();
            await expect.poll(async () => (await storedFolders(page)).personas.members[copyId]).toBe(folderId);
            await expect.poll(() => savedFolders(page)?.personas?.members?.[copyId]).toBe(folderId);
            await expect(editor.locator('.sb-folder-row')).toHaveAccessibleName('Cast, 2 personas');

            const removed = await page.evaluate(async avatarId => (await import('./scripts/personas.js')).deletePersonaRecord(avatarId, { silent: true }), copyId);
            expect(removed).toBeTruthy();
            await expect.poll(async () => (await storedFolders(page)).personas.members).toEqual({ [persona.avatarId]: folderId });
            await expect(editor.locator('.sb-folder-row')).toHaveAccessibleName('Cast, 1 persona');
        });
    });
}
