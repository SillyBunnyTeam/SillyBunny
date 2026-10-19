import { devices, expect, test } from '@playwright/test';
import { gunzipSync } from 'node:zlib';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

const sessions = new WeakMap();

test.setTimeout(60000);

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    const savedSettings = [];
    sessions.set(page, savedSettings);
    await page.route('**/api/settings/save', route => {
        const request = route.request();
        const body = request.headers()['content-encoding'] === 'gzip'
            ? gunzipSync(request.postDataBuffer()) : request.postDataBuffer();
        const payload = JSON.parse(body.toString());
        savedSettings.push(payload);
        return route.fulfill({ json: { result: 'ok', version: payload._version + 1 } });
    });
    await page.goto('/');
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
});

test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
        const { mountPersonaEditor } = await import('./scripts/sillybunny-persona-editor.js');
        const container = document.querySelector('#PersonaManagement.sb-persona-editor-mounted');
        if (container) mountPersonaEditor(container).destroy();
        for (const key of Object.keys(localStorage)) {
            if (key.startsWith('sb-persona-editor-draft-')) localStorage.removeItem(key);
        }
    });
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('sb-persona-editor-draft-')))).toEqual([]);
});

async function openNotes(page) {
    const persona = await page.evaluate(async () => {
        const { power_user } = await import('./scripts/power-user.js');
        const { user_avatar, getPersonaRecord, projectActivePersona, getPersonaAppendixScope } = await import('./scripts/personas.js');
        const record = getPersonaRecord(user_avatar);
        if (!record) throw new Error('Scenario note tests require a current persona');
        Object.assign(power_user.persona_descriptions[user_avatar], {
            description: 'Base persona',
            appendices: [
                { id: 'e2e-note-one', name: 'First note', description: 'Long scenario note.\n'.repeat(30) },
                { id: 'e2e-note-two', name: 'Second note', description: 'Second scenario note.' },
            ],
            activeAppendices: {},
        });
        projectActivePersona();
        const { openPersonaEditor } = await import('./scripts/sillybunny-persona-editor.js');
        if (!await openPersonaEditor({ avatarId: user_avatar, section: 'notes' })) throw new Error('Could not open scenario notes');
        return { avatarId: user_avatar, scope: getPersonaAppendixScope().key };
    });
    const entry = page.locator('#PersonaManagement .sb-persona-entry');
    await expect(entry).toBeVisible();
    return { ...persona, entry, notes: entry.getByRole('group', { name: 'Scenario Notes', exact: true }) };
}

async function showPreview(entry, mobile) {
    if (mobile) await entry.getByRole('button', { name: 'Preview', exact: true }).click();
    else await entry.getByRole('radio', { name: 'Preview', exact: true }).check();
    return entry.locator('.sb-persona-entry-preview');
}

for (const width of [320, 390, 1280]) {
    test.describe(`Persona editor Scenario Notes at ${width}px`, () => {
        test.use({
            viewport: { width, height: 844 },
            isMobile: width < 768,
            hasTouch: width < 768,
            userAgent: width < 768 ? devices['iPhone 13'].userAgent : undefined,
        });

        test('expanders are independent, activation updates effective preview, and long labels do not overflow', async ({ page }) => {
            const { avatarId, scope, entry, notes } = await openNotes(page);
            const first = notes.locator('[data-appendix-id="e2e-note-one"]');
            const second = notes.locator('[data-appendix-id="e2e-note-two"]');
            const firstSummary = first.locator('summary');
            const secondSummary = second.locator('summary');
            await expect(first).toHaveJSProperty('open', false);
            await expect(second).toHaveJSProperty('open', false);
            await firstSummary.click();
            await expect(first.getByRole('textbox', { name: 'Scenario Note text', exact: true })).toBeVisible();
            await expect(second).toHaveJSProperty('open', false);
            await second.getByRole('switch', { name: 'Enabled', exact: true }).click();
            await expect(second.getByRole('switch', { name: 'Enabled', exact: true })).toBeChecked();
            await expect(first).toHaveJSProperty('open', true);
            await expect(second).toHaveJSProperty('open', false);
            await expect(entry.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
            await expect.poll(() => sessions.get(page).at(-1)?.power_user.persona_descriptions[avatarId]?.activeAppendices[scope]).toEqual(['e2e-note-two']);
            const preview = await showPreview(entry, width < 768);
            await expect(preview).toHaveText('Base persona\n\n(Second note)\nSecond scenario note.');
            await firstSummary.press('Space');
            await expect(first).toHaveJSProperty('open', false);
            await firstSummary.press('Enter');
            await secondSummary.click();
            await expect(first).toHaveJSProperty('open', true);
            await expect(second).toHaveJSProperty('open', true);
            const longLabel = 'LongLabel'.repeat(20);
            await first.getByRole('textbox', { name: 'Label', exact: true }).fill(longLabel);
            await expect(firstSummary.locator(':scope > .ds-row-text > .ds-row-label')).toHaveText(longLabel);
            for (const note of [first, second]) {
                expect(await note.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
                expect((await note.locator('summary').boundingBox()).height).toBeGreaterThanOrEqual(44);
            }
            await expect(entry.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
            await expect(preview).toContainText('Second scenario note.');
            await entry.getByRole('button', { name: 'Cancel', exact: true }).click();
            await expect(first.getByRole('textbox', { name: 'Label', exact: true })).toHaveValue('First note');
            await expect(second.getByRole('switch', { name: 'Enabled', exact: true })).toBeChecked();
        });

        test('note content is draft-only until Save and deletion prunes every activeAppendices scope in the payload', async ({ page }) => {
            const { avatarId, scope, entry, notes } = await openNotes(page);
            await notes.getByRole('button', { name: 'Add Scenario Note', exact: true }).click();
            const note = notes.locator('[data-appendix-id]').last();
            const noteId = await note.getAttribute('data-appendix-id');
            await note.getByRole('textbox', { name: 'Label', exact: true }).fill('Saved e2e note');
            await note.getByRole('textbox', { name: 'Scenario Note text', exact: true }).fill('Saved e2e scenario text.');
            await expect(note.getByRole('switch', { name: 'Enabled', exact: true })).toBeDisabled();
            expect(await page.evaluate(async ({ avatarId, noteId }) => (await import('./scripts/power-user.js')).power_user.persona_descriptions[avatarId].appendices.some(note => note.id === noteId), { avatarId, noteId })).toBe(false);
            await expect(entry.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
            await entry.getByRole('button', { name: 'Save', exact: true }).click();
            await expect.poll(() => sessions.get(page).at(-1)?.power_user.persona_descriptions[avatarId]?.appendices.find(note => note.id === noteId)).toEqual({ id: noteId, name: 'Saved e2e note', description: 'Saved e2e scenario text.' });
            await expect(note.getByRole('switch', { name: 'Enabled', exact: true })).toBeEnabled();
            await note.getByRole('switch', { name: 'Enabled', exact: true }).click();
            await expect(note.getByRole('switch', { name: 'Enabled', exact: true })).toBeChecked();
            await expect.poll(() => sessions.get(page).at(-1)?.power_user.persona_descriptions[avatarId]?.activeAppendices[scope]).toEqual([noteId]);
            const preview = await showPreview(entry, width < 768);
            await expect(preview).toHaveText('Base persona\n\n(Saved e2e note)\nSaved e2e scenario text.');
            await expect(entry.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
            await page.evaluate(async ({ avatarId, noteId }) => {
                const { power_user } = await import('./scripts/power-user.js');
                const selections = power_user.persona_descriptions[avatarId].activeAppendices;
                selections['e2e-other-character.png'] = [noteId, 'e2e-note-one'];
                selections['e2e-other-group'] = [noteId];
            }, { avatarId, noteId });
            await note.getByRole('button', { name: 'Delete Scenario Note', exact: true }).click();
            await expect(notes.locator(`[data-appendix-id="${noteId}"]`)).toHaveCount(0);
            await expect(entry.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
            await entry.getByRole('button', { name: 'Save', exact: true }).click();
            await expect(entry.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
            await expect.poll(() => sessions.get(page).at(-1)?.power_user.persona_descriptions[avatarId]?.appendices.map(note => note.id)).toEqual(['e2e-note-one', 'e2e-note-two']);
            const descriptor = sessions.get(page).at(-1).power_user.persona_descriptions[avatarId];
            expect(descriptor.activeAppendices[scope]).toEqual([]);
            expect(descriptor.activeAppendices['e2e-other-character.png']).toEqual(['e2e-note-one']);
            expect(descriptor.activeAppendices['e2e-other-group']).toEqual([]);
            expect(Object.values(descriptor.activeAppendices).flat()).not.toContain(noteId);
        });
    });
}
