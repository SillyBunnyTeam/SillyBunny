import { expect, test } from '@playwright/test';
import { gunzipSync } from 'node:zlib';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';
import { selectTheme } from './helpers/page-contrast.js';
import { expectToggleGroupForm, SELECTION_TONES } from './helpers/selection-forms.js';
import { waitForAppReady } from './helpers/app-ready.js';
import { expectSortKeepsSearchDismissable } from './helpers/list-search-dismiss.js';

const sessions = new WeakMap();

test.setTimeout(60000);

async function waitForApp(page) {
    await waitForAppReady(page, { timeout: 60000 });
}

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    const session = { savedSettings: [], createdAvatars: new Set() };
    sessions.set(page, session);
    await page.route('**/api/settings/save', route => {
        const request = route.request();
        const body = request.headers()['content-encoding'] === 'gzip'
            ? gunzipSync(request.postDataBuffer()) : request.postDataBuffer();
        const payload = JSON.parse(body.toString());
        session.savedSettings.push(payload);
        return route.fulfill({ json: { result: 'ok', version: payload._version + 1 } });
    });
    await page.route('**/api/avatars/get', async route => {
        const avatars = await fetchJsonOrSkip(route);
        if (!avatars) return;
        return route.fulfill({ json: [...avatars, ...session.createdAvatars] });
    });
    await page.route('**/api/avatars/upload', route => {
        const body = route.request().postDataBuffer().toString('latin1');
        const path = body.match(/name="overwrite_name"\r\n\r\n([^\r\n]+)/)?.[1];
        if (!path) throw new Error('Persona upload fixture requires an overwrite_name');
        session.createdAvatars.add(path);
        return route.fulfill({ json: { path } });
    });
    await page.route('**/api/avatars/delete', route => {
        session.createdAvatars.delete(route.request().postDataJSON().avatar);
        return route.fulfill({ json: { result: 'ok' } });
    });
    await page.goto('/');
    await waitForApp(page);
});

test.afterEach(async ({ page }) => {
    const ids = [...sessions.get(page).createdAvatars];
    await page.evaluate(async ids => {
        const { mountPersonaEditor } = await import('./scripts/sillybunny-persona-editor.js');
        const container = document.querySelector('#PersonaManagement.sb-persona-editor-mounted');
        if (container) mountPersonaEditor(container).destroy();
        const { getRequestHeaders } = await import('./script.js');
        const { power_user } = await import('./scripts/power-user.js');
        for (const avatar of ids) {
            const response = await fetch('/api/avatars/delete', {
                method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar }),
            });
            if (!response.ok) throw new Error(`Could not clean up test avatar ${avatar}: ${response.status}`);
            delete power_user.personas[avatar];
            delete power_user.persona_descriptions[avatar];
        }
        for (const key of Object.keys(localStorage)) {
            if (key.startsWith('sb-persona-editor-draft-')) localStorage.removeItem(key);
        }
        if (!ids.length) return;
        const response = await fetch('/api/avatars/get', { method: 'POST', headers: getRequestHeaders() });
        if (!response.ok) throw new Error('Could not verify test avatar cleanup');
        const remaining = await response.json();
        if (ids.some(id => remaining.includes(id))) throw new Error('Test avatar cleanup left a file behind');
    }, ids);
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('sb-persona-editor-draft-')))).toEqual([]);
});

const savedSettings = page => sessions.get(page).savedSettings;
const editorFor = page => page.locator('#PersonaManagement .sb-persona-editor');
const entryFor = page => editorFor(page).locator('.sb-persona-entry');

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

async function openPersona(page, avatarId, section) {
    await page.evaluate(async options => {
        const { openPersonaEditor } = await import('./scripts/sillybunny-persona-editor.js');
        if (!await openPersonaEditor(options)) throw new Error('Could not open the requested persona');
    }, { avatarId, section });
    const entry = entryFor(page);
    await expect(entry).toBeVisible();
    return entry;
}

async function expectSavedDescription(page, avatarId, description) {
    await expect.poll(() => savedSettings(page).some(payload => payload.power_user.persona_descriptions[avatarId]?.description === description)).toBe(true);
    return savedSettings(page).findLast(payload => payload.power_user.persona_descriptions[avatarId]?.description === description);
}

async function restoreDefault(page, avatarId, previous) {
    await page.evaluate(async ({ avatarId, previous }) => {
        const { setPersonaDefault } = await import('./scripts/personas.js');
        await setPersonaDefault(avatarId, false);
        if (previous) await setPersonaDefault(previous, true);
    }, { avatarId, previous });
}

test.describe('Persona editor', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('renders avatar/name rows, the in-use indicator, labelled controls, and hides legacy children', async ({ page }) => {
        const persona = await currentPersona(page);
        const editor = await openList(page);
        const rows = editor.getByRole('listitem');
        expect(await rows.count()).toBeGreaterThan(0);
        for (const row of await rows.all()) {
            await expect(row).toHaveAccessibleName(/\S/);
            await expect(row.locator('.ds-entity-row__avatar img')).toBeVisible();
            await expect(row.locator('.ds-entity-row__avatar img')).toHaveAttribute('loading', 'lazy');
            await expect(row.locator('.ds-entity-row__avatar img')).toHaveAttribute('src', /\S/);
            await expect(row.locator('.ds-entity-row__title')).toHaveText(/\S/);
            await expect(row.locator('.ds-entity-row__chevron')).toHaveCount(0);
        }
        const active = rows.filter({ has: page.getByRole('img', { name: 'Current Persona', exact: true }) });
        await expect(active).toHaveAccessibleName(persona.name);
        await expect(active.getByRole('img', { name: 'Current Persona', exact: true })).toBeVisible();
        const header = editor.locator('.sb-persona-list-header');
        await expect(header.getByRole('button', { name: 'Search', exact: true })).toBeVisible();
        await expect(header.getByRole('button', { name: 'New', exact: true })).toBeVisible();
        await expect(header.getByRole('button', { name: 'Persona Management', exact: true })).toBeVisible();
        for (const button of await header.getByRole('button').all()) await expect(button).toHaveAccessibleName(/\S/);
        const legacy = page.locator('#PersonaManagement > :not(.sb-persona-editor)');
        expect(await legacy.count()).toBeGreaterThan(0);
        for (const child of await legacy.all()) await expect(child).toBeHidden();
    });

    for (const { tone, theme } of SELECTION_TONES) {
        test(`the Edit / Preview toggle is a tray with a raised selected toggle in the ${tone} tone`, async ({ page }) => {
            const persona = await currentPersona(page);
            const editor = await openList(page);
            await editor.getByRole('listitem', { name: persona.name, exact: true }).click();
            await selectTheme(page, theme);
            await expect(page.locator('html')).toHaveAttribute('data-sb-surface-tone', tone);
            await expectToggleGroupForm(page, entryFor(page).locator('.sb-persona-entry-modes'), { tone, floor: 32 });
        });
    }

    test('the list loads in batches behind a Show More row and has no pager', async ({ page }) => {
        const extra = Array.from({ length: 8 }, (_, index) => `sb-page-size-${index}.png`);
        for (const avatar of extra) sessions.get(page).createdAvatars.add(avatar);
        await page.reload();
        await waitForApp(page);
        await page.evaluate(async () => (await import('./scripts/util/AccountStorage.js')).accountStorage.setItem('Personas_PerPage', '5'));
        const editor = await openList(page);
        const total = await page.evaluate(async () => (await (await fetch('/api/avatars/get', { method: 'POST', headers: (await import('./script.js')).getRequestHeaders() })).json()).length);
        expect(total).toBeGreaterThan(5);
        await expect(editor.getByRole('listitem')).toHaveCount(5);
        await expect(editor.locator('.sb-list-pagination')).toHaveCount(0);

        const showMore = editor.locator('.sb-list-show-more__button');
        await expect(showMore).toBeVisible();
        while (await showMore.isVisible()) await showMore.click();
        await expect(editor.getByRole('listitem')).toHaveCount(total);
        await expect(editor.locator('.sb-list-show-more')).toBeHidden();
        await page.evaluate(async () => (await import('./scripts/util/AccountStorage.js')).accountStorage.removeItem('Personas_PerPage'));
    });

    test('a persona is found by its title as well as its name', async ({ page }) => {
        const persona = await currentPersona(page);
        const title = 'Zxqv Cartographer';
        await page.evaluate(async ({ avatarId, title }) => {
            const { power_user } = await import('./scripts/power-user.js');
            power_user.persona_descriptions[avatarId].title = title;
        }, { avatarId: persona.avatarId, title });
        const editor = await openList(page);
        await editor.getByRole('button', { name: 'Search', exact: true }).click();
        const search = editor.locator('.sb-persona-search');
        await search.fill('Cartographer');
        await expect(editor.getByRole('listitem', { name: persona.name, exact: true })).toBeVisible();
        await search.fill('Zxqv');
        await expect(editor.getByRole('listitem', { name: persona.name, exact: true })).toBeVisible();
        await search.fill('Quokkaless');
        await expect(editor.getByRole('listitem')).toHaveCount(0);
        await page.evaluate(async ({ avatarId, title }) => {
            const { power_user } = await import('./scripts/power-user.js');
            power_user.persona_descriptions[avatarId].title = title;
        }, { avatarId: persona.avatarId, title: persona.descriptor.title ?? '' });
    });

    test('Sort ends the search bar, and Select files the selected personas into a folder', async ({ page }) => {
        const persona = await currentPersona(page);
        const folderId = await page.evaluate(async () => (await import('./scripts/sillybunny-folders.js')).createFolder('personas', 'Cast').id);
        const editor = await openList(page);
        const searchToggle = editor.locator('.sb-persona-list-header').getByRole('button', { name: 'Search', exact: true });
        await expect(editor.locator('.sb-persona-list-header .sb-persona-sort-button')).toHaveCount(0);
        await searchToggle.click();
        const sort = editor.locator('.sb-persona-search-field > .sb-persona-sort-button');
        await expect(sort).toBeVisible();
        await expect(sort).toHaveAttribute('aria-pressed', 'false');
        await sort.click();
        await page.getByRole('menuitemradio', { name: 'Z-A', exact: true }).click();
        await expect(sort).toHaveAttribute('aria-pressed', 'true');
        await expect(searchToggle).toHaveAttribute('aria-pressed', 'true');
        await expect(page.getByRole('menuitemradio')).toHaveCount(0);
        await sort.click();
        await page.getByRole('menuitemradio', { name: 'A-Z', exact: true }).click();
        await expect(sort).toHaveAttribute('aria-pressed', 'false');

        await editor.getByRole('button', { name: 'Persona Management', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Select', exact: true }).click();
        await expect(editor.locator('.sb-persona-selection-header .sb-selection-header')).toBeVisible();
        await expect(editor.locator('.sb-persona-list-header')).toBeHidden();
        await editor.getByRole('listitem', { name: persona.name, exact: true }).locator('.sb-selection-check').click();
        await editor.locator('.sb-persona-selection-bar [data-action-id="folder"]').click();
        await page.getByRole('menuitemradio', { name: 'Cast', exact: true }).click();
        await expect(editor.locator('.sb-persona-selection-header .sb-selection-header')).toHaveCount(0);
        await expect(editor.locator('.sb-persona-list-header')).toBeVisible();
        expect(await page.evaluate(async avatarId => (await import('./scripts/sillybunny-folders.js')).getFolderId('personas', avatarId), persona.avatarId)).toBe(folderId);
    });

    test('the search bar closes on a press outside it, also after the sort menu was used', async ({ page }) => {
        const editor = await openList(page);
        const toggle = editor.locator('.sb-persona-list-header').getByRole('button', { name: 'Search', exact: true });
        const field = editor.locator('.sb-persona-search-field');
        const input = field.getByRole('searchbox');
        await expectSortKeepsSearchDismissable({
            page,
            reveal: () => toggle.click(),
            field,
            input,
            sort: field.locator('.sb-persona-sort-button'),
            chooseSort: () => page.getByRole('menuitemradio', { name: 'Z-A', exact: true }).click(),
            outside: editor.locator('.sb-persona-list-header'),
            focusable: editor.getByRole('button', { name: 'Persona Management', exact: true }),
        });
        await expect(field).toBeHidden();
    });

    test('a desktop editor shows the property bar and keeps the summary for the collapsed layout', async ({ page }) => {
        const persona = await currentPersona(page);
        const editor = await openList(page);
        await editor.getByRole('listitem', { name: persona.name, exact: true }).click();
        await expect(entryFor(page).locator('.sb-persona-properties')).toBeVisible();
        await expect(entryFor(page).locator('.sb-persona-property-summary')).toBeHidden();
        await expect(editor.locator('.sb-persona-row-menu').first()).toBeHidden();
    });

    test('Cancel reverts detached edits and Save preserves unknown descriptor keys in the settings payload', async ({ page }) => {
        const persona = await currentPersona(page);
        const unknown = { nested: ['extension-owned', { version: 7 }], enabled: true };
        await page.evaluate(async ({ avatarId, unknown }) => {
            const { power_user } = await import('./scripts/power-user.js');
            power_user.persona_descriptions[avatarId].e2e_unknown_descriptor_key = unknown;
        }, { avatarId: persona.avatarId, unknown });
        const editor = await openList(page);
        await editor.getByRole('listitem', { name: persona.name, exact: true }).click();
        const entry = entryFor(page);
        const header = entry.locator('.sb-persona-entry-header');
        await expect(header.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
        await expect(header.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(persona.name);
        await expect(header.getByRole('radio', { name: 'Edit', exact: true })).toBeChecked();
        await expect(header.getByRole('radio', { name: 'Preview', exact: true })).not.toBeChecked();
        await expect(header.getByRole('button', { name: 'Persona Actions', exact: true })).toBeVisible();
        await expect(header.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
        const save = header.getByRole('button', { name: 'Save', exact: true });
        await expect(save).toBeDisabled();
        const description = entry.getByRole('textbox', { name: 'Persona Description', exact: true });
        const baseline = await description.inputValue();
        await description.fill('Persona editor cancelled description');
        await expect(entry.getByLabel('Unsaved Changes', { exact: true })).toBeVisible();
        await expect(save).toBeEnabled();
        expect(await page.evaluate(async id => (await import('./scripts/power-user.js')).power_user.persona_descriptions[id].description, persona.avatarId)).toBe(persona.descriptor.description);
        await header.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(description).toHaveValue(baseline);
        await expect(save).toBeDisabled();
        await expect(entry.getByLabel('Unsaved Changes', { exact: true })).toBeHidden();
        const edited = 'Persona editor explicitly saved description';
        const firstSave = savedSettings(page).length;
        await description.fill(edited);
        await save.click();
        const payload = await expectSavedDescription(page, persona.avatarId, edited);
        expect(savedSettings(page).length).toBeGreaterThan(firstSave);
        expect(payload.power_user.persona_descriptions[persona.avatarId].e2e_unknown_descriptor_key).toEqual(unknown);
        await expect(save).toBeDisabled();
        await expect(entry.getByLabel('Unsaved Changes', { exact: true })).toBeHidden();
    });

    test('guards dirty Back navigation with Cancel/Discard/Save and Escape in a field keeps Settings open', async ({ page }) => {
        const persona = await currentPersona(page);
        const entry = await openPersona(page, persona.avatarId);
        const description = entry.getByRole('textbox', { name: 'Persona Description', exact: true });
        const baseline = await description.inputValue();
        await description.fill('Unsaved guarded persona description');
        await description.press('Escape');
        await expect(page.locator('#sb-settings-page')).toBeVisible();
        await expect(entry).toBeVisible();
        await expect(description).not.toBeFocused();
        await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
        await entry.getByRole('button', { name: 'Back', exact: true }).click();
        // The Cancel popup keeps [open] while it closes, and the second Back opens another guard before that ends.
        const dialog = page.locator('dialog.popup[open]:not([closing])');
        await expect(dialog).toBeVisible();
        // Cancel · Discard · Save in the order the dialog lays them out (the popup stacks them on a narrow dialog); Discard is
        // the one in the destructive colour.
        const buttons = await dialog.locator('.popup-controls > .menu_button').evaluateAll(nodes => nodes
            .filter(node => node.getClientRects().length)
            .map((node, index) => ({
                text: node.textContent.trim(), order: Number(getComputedStyle(node).order), index, red: node.classList.contains('sb-editor-discard'),
            })));
        expect(buttons.toSorted((a, b) => a.order - b.order || a.index - b.index).map(button => button.text)).toEqual(['Cancel', 'Discard', 'Save']);
        expect(buttons.filter(button => button.red).map(button => button.text)).toEqual(['Discard']);
        await expect(dialog.locator('.sb-editor-discard')).toHaveCSS('color', await page.evaluate(() => {
            const probe = document.createElement('span');
            probe.style.color = 'var(--sb-color-danger)';
            document.body.append(probe);
            const color = getComputedStyle(probe).color;
            probe.remove();
            return color;
        }));
        await dialog.getByText('Cancel', { exact: true }).click();
        await expect(description).toHaveValue('Unsaved guarded persona description');
        await entry.getByRole('button', { name: 'Back', exact: true }).click();
        await dialog.getByText('Discard', { exact: true }).click();
        await expect(entry).toHaveCount(0);
        const reopened = await openPersona(page, persona.avatarId);
        await expect(reopened.getByRole('textbox', { name: 'Persona Description', exact: true })).toHaveValue(baseline);
        await expect(reopened.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
        expect(savedSettings(page).some(payload => payload.power_user.persona_descriptions[persona.avatarId]?.description === 'Unsaved guarded persona description')).toBe(false);
    });

    test('Position reveals Depth and Role and saves the properties draft explicitly', async ({ page }) => {
        const persona = await currentPersona(page);
        const entry = await openPersona(page, persona.avatarId);
        const bar = entry.locator(':scope > .sb-persona-properties');
        await expect(bar).toBeVisible();
        const position = bar.locator('[data-sb-editor-field="position"] > button');
        const role = bar.locator('[data-sb-editor-field="role"] > button');
        await position.click();
        await page.getByRole('option', { name: 'In Story String / Prompt Manager', exact: true }).click();
        await expect(position).toHaveAccessibleName('Position: In Story String / Prompt Manager');
        await expect(bar.getByRole('spinbutton', { name: 'Depth', exact: true })).toBeHidden();
        await expect(role).toBeHidden();
        await position.click();
        await page.getByRole('option', { name: 'In-chat @ Depth', exact: true }).click();
        await expect(position).toHaveAccessibleName('Position: In-chat @ Depth');
        await expect(bar.getByRole('spinbutton', { name: 'Depth', exact: true })).toBeVisible();
        await expect(role).toBeVisible();
        await bar.getByRole('spinbutton', { name: 'Depth', exact: true }).fill('17');
        await role.click();
        await page.getByRole('option', { name: 'Assistant', exact: true }).click();
        await entry.getByRole('button', { name: 'Save', exact: true }).click();
        await expect.poll(() => savedSettings(page).findLast(payload => payload.power_user.persona_descriptions[persona.avatarId]?.depth === 17)?.power_user.persona_descriptions[persona.avatarId]).toMatchObject({ position: 4, depth: 17, role: 2 });
    });

    test('pagehide backs up a draft and reload offers Restore without persisting settings', async ({ page }) => {
        const persona = await currentPersona(page);
        const entry = await openPersona(page, persona.avatarId);
        const draftText = 'Recovered persona editor draft after reload';
        await entry.getByRole('textbox', { name: 'Persona Description', exact: true }).fill(draftText);
        const draftKey = await page.evaluate(async id => {
            const { personaDraftKey } = await import('./scripts/sillybunny-persona-detail.js');
            window.dispatchEvent(new Event('pagehide'));
            return personaDraftKey(id);
        }, persona.avatarId);
        await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key))?.snapshot?.draft?.description, draftKey)).toBe(draftText);
        await page.reload();
        await waitForApp(page);
        const reopened = await openPersona(page, persona.avatarId);
        await showToasts(page);
        const restore = page.getByRole('button', { name: 'Restore', exact: true });
        await expect(restore).toBeVisible();
        await expect(reopened.getByRole('textbox', { name: 'Persona Description', exact: true })).toHaveValue(persona.descriptor.description || '');
        await restore.click();
        await expect(reopened.getByRole('textbox', { name: 'Persona Description', exact: true })).toHaveValue(draftText);
        await expect(reopened.getByLabel('Unsaved Changes', { exact: true })).toBeVisible();
        await expect(reopened.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
        expect(savedSettings(page).some(payload => payload.power_user.persona_descriptions[persona.avatarId]?.description === draftText)).toBe(false);
    });

    test('New saves a persona, inserts its row, and submits its name and description', async ({ page }) => {
        const editor = await openList(page);
        const name = `PERSONA_EDITOR_E2E_${Date.now()}`;
        await editor.getByRole('button', { name: 'New', exact: true }).click();
        const entry = entryFor(page);
        await expect(entry.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
        await entry.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
        await entry.getByRole('textbox', { name: 'Persona Description', exact: true }).fill('Disposable e2e persona');
        await entry.getByRole('button', { name: 'Save', exact: true }).click();
        await expect.poll(() => savedSettings(page).some(payload => Object.values(payload.power_user.personas).includes(name))).toBe(true);
        const payload = savedSettings(page).findLast(payload => Object.values(payload.power_user.personas).includes(name));
        const id = Object.keys(payload.power_user.personas).find(id => payload.power_user.personas[id] === name);
        await expect.poll(() => sessions.get(page).createdAvatars.has(id)).toBe(true);
        expect(payload.power_user.persona_descriptions[id].description).toBe('Disposable e2e persona');
        await expect(entry.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
        await entry.getByRole('button', { name: 'Back', exact: true }).click();
        await expect(editor.getByRole('listitem', { name, exact: true })).toBeVisible();
    });

    test('Default Persona saves immediately without dirtying the content draft and restores the previous default', async ({ page }) => {
        const persona = await currentPersona(page);
        const previous = await page.evaluate(async () => (await import('./scripts/power-user.js')).power_user.default_persona ?? null);
        const entry = await openPersona(page, persona.avatarId);
        const toggle = entry.getByRole('switch', { name: 'Default Persona', exact: true });
        const wasDefault = await toggle.isChecked();
        const firstSave = savedSettings(page).length;
        await toggle.click();
        await expect(toggle).toHaveJSProperty('checked', !wasDefault);
        const expected = [persona.avatarId, null][Number(wasDefault)];
        await expect.poll(() => savedSettings(page).length).toBeGreaterThan(firstSave);
        await expect.poll(() => savedSettings(page).at(-1)?.power_user.default_persona ?? null).toBe(expected);
        await expect(entry.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
        await expect(entry.getByLabel('Unsaved Changes', { exact: true })).toBeHidden();
        const savesBeforeRestore = savedSettings(page).length;
        await restoreDefault(page, persona.avatarId, previous);
        await expect.poll(() => page.evaluate(async () => (await import('./scripts/power-user.js')).power_user.default_persona ?? null)).toBe(previous);
        await expect.poll(() => savedSettings(page).length).toBeGreaterThan(savesBeforeRestore);
        await expect.poll(() => savedSettings(page).at(-1)?.power_user.default_persona ?? null).toBe(previous);
    });

    test('openPersonaEditor bridge targets a persona and the notes section', async ({ page }) => {
        const persona = await currentPersona(page);
        const entry = await openPersona(page, persona.avatarId, 'notes');
        await expect(entry.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(persona.name);
        await expect(entry.locator('[data-sb-section="notes"]')).toBeInViewport();
        await expect(entry.getByRole('heading', { name: 'Scenario Notes', exact: true })).toBeInViewport();
    });
});

test.describe('Persona editor on mobile', () => {
    test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

    test('properties summary opens a sheet and Escape closes only the sheet, retaining unsaved values', async ({ page }) => {
        const persona = await currentPersona(page);
        const editor = await openList(page);
        await editor.getByRole('listitem', { name: persona.name, exact: true }).click();
        const entry = entryFor(page);
        const header = entry.locator('.sb-persona-entry-header');
        for (const label of ['Back', 'Cancel', 'Save']) await expect(header.getByRole('button', { name: label, exact: true })).toBeInViewport();
        const summary = entry.locator('.sb-persona-property-summary');
        await expect(summary).toBeVisible();
        await expect(summary).toHaveAccessibleName(`Persona Properties: ${(await summary.textContent()).replace(/\s*›\s*$/, '')}`);
        await expect(entry.locator(':scope > .sb-persona-properties')).toBeHidden();
        await summary.click();
        const sheet = page.getByRole('dialog', { name: 'Persona Properties', exact: true });
        await expect(sheet).toBeVisible();
        await sheet.locator('[data-sb-editor-field="position"] > button').click();
        await page.getByRole('option', { name: 'In-chat @ Depth', exact: true }).click();
        await sheet.getByRole('spinbutton', { name: 'Depth', exact: true }).fill('23');
        await sheet.locator('[data-sb-editor-field="role"] > button').click();
        await page.getByRole('option', { name: 'User', exact: true }).click();
        await expect(sheet.getByRole('button', { name: 'Role: User', exact: true })).toBeVisible();
        expect((await sheet.getByRole('button', { name: 'Position: In-chat @ Depth', exact: true }).boundingBox()).height).toBeGreaterThanOrEqual(44);
        await page.keyboard.press('Escape');
        await expect(sheet).toBeHidden();
        await expect(summary).toBeFocused();
        await expect(summary).toContainText('Depth 23');
        await expect(summary).toContainText('User');
        await expect(page.locator('#sb-settings-page')).toBeVisible();
        await expect(entry).toBeVisible();
        await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
        await summary.click();
        await expect(sheet.getByRole('spinbutton', { name: 'Depth', exact: true })).toHaveValue('23');
        await sheet.getByRole('button', { name: 'Close', exact: true }).click();
        await entry.getByRole('button', { name: 'Save', exact: true }).click();
        await expect.poll(() => savedSettings(page).findLast(payload => payload.power_user.persona_descriptions[persona.avatarId]?.depth === 23)?.power_user.persona_descriptions[persona.avatarId]).toMatchObject({ position: 4, depth: 23, role: 1 });
        await entry.getByRole('button', { name: 'Back', exact: true }).click();
        await expect(editor.getByRole('listitem', { name: persona.name, exact: true })).toBeInViewport();
    });

    test('the properties sheet keeps a gutter and none of its controls is clipped', async ({ page }) => {
        const persona = await currentPersona(page);
        const editor = await openList(page);
        await editor.getByRole('listitem', { name: persona.name, exact: true }).click();
        await entryFor(page).locator('.sb-persona-property-summary').click();
        const sheet = page.getByRole('dialog', { name: 'Persona Properties', exact: true });
        await sheet.locator('[data-sb-editor-field="position"] > button').click();
        await page.getByRole('option', { name: 'In-chat @ Depth', exact: true }).click();
        await expect(sheet.locator('[data-sb-editor-field="role"]')).toBeVisible();
        const edges = await sheet.evaluate(dialog => {
            const box = dialog.getBoundingClientRect();
            return [...dialog.querySelectorAll('.sb-persona-property')].filter(row => row.getClientRects().length).flatMap(row => [...row.children].map(child => {
                const rect = child.getBoundingClientRect();
                return { start: rect.left - box.left, end: box.right - rect.right };
            }));
        });
        expect(edges.length).toBeGreaterThanOrEqual(6);
        for (const { start, end } of edges) {
            expect(start).toBeGreaterThanOrEqual(8);
            expect(end).toBeGreaterThanOrEqual(8);
        }
    });

    test('the editor header holds Save and the menu at 320px, with Preview in the menu', async ({ page }) => {
        await page.setViewportSize({ width: 320, height: 568 });
        const persona = await currentPersona(page);
        const editor = await openList(page);
        await editor.getByRole('listitem', { name: persona.name, exact: true }).click();
        const header = entryFor(page).locator('.sb-persona-entry-header');
        // The detail slides in over the list; measure once it has settled.
        await expect.poll(async () => (await header.boundingBox()).x).toBeLessThan(40);
        const box = await header.boundingBox();
        for (const label of ['Back', 'Persona Actions', 'Cancel', 'Save']) {
            const button = await header.getByRole('button', { name: label, exact: true }).boundingBox();
            expect(button.x).toBeGreaterThanOrEqual(box.x - 0.5);
            expect(button.x + button.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
        }
        expect(await header.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
        await expect(header.locator('.sb-persona-entry-mode-toggle')).toBeHidden();
        await header.getByRole('button', { name: 'Persona Actions', exact: true }).click();
        await expect(page.getByRole('menuitem', { name: 'Preview', exact: true })).toBeVisible();
    });

    test('text action buttons keep the 44px touch target', async ({ page }) => {
        const persona = await currentPersona(page);
        const entry = await openPersona(page, persona.avatarId);
        const heights = await entry.locator('.menu_button:not(.sb-header-icon-button):not(.sb-status-page__action)').evaluateAll(
            buttons => buttons.filter(button => button.getClientRects().length).map(button => parseFloat(getComputedStyle(button).minHeight)),
        );
        expect(heights.length).toBeGreaterThan(0);
        for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
    });
});
