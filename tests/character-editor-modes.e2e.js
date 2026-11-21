import { expect, test } from '@playwright/test';
import { gunzipSync } from 'node:zlib';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';
import { applyWelcomeSettings } from './helpers/welcome-dialog.js';

const STARTUP_TIMEOUT = 30_000;
const SECTIONS = ['essentials', 'character-fields', 'advanced-fields', 'greetings', 'metadata', 'related'];
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];

/** Which modes the stub serves to the page, so that a run never changes the saved settings of the instance. */
let modes = { quickEdit: false, spoilerFree: false };

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
    await page.route('**/api/settings/get', async route => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        settings.firstRun = false;
        applyWelcomeSettings(settings);
        settings.power_user.world_import_dialog = false;
        settings.power_user.characterEditorQuickEdit = modes.quickEdit;
        settings.power_user.spoiler_free_mode = modes.spoilerFree;
        return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
    });
    await page.route('**/api/settings/save', route => {
        const request = route.request();
        const body = request.headers()['content-encoding'] === 'gzip'
            ? gunzipSync(request.postDataBuffer()) : request.postDataBuffer();
        const payload = JSON.parse(body.toString());
        return route.fulfill({ json: { result: 'ok', version: payload._version + 1 } });
    });
});

async function openCharacter(page, index) {
    await page.waitForFunction(() => !document.getElementById('preloader'), null, { timeout: STARTUP_TIMEOUT });
    await page.evaluate(async () => { window.qaApp = await import('/script.js'); });
    await page.waitForFunction(() => window.qaApp.characters.length > 0, null, { timeout: STARTUP_TIMEOUT });
    if (await page.locator('#sb-character-toggle').isVisible()) await page.locator('#sb-character-toggle').click();
    await page.evaluate(i => {
        window.qaApp.setCharacterId(i);
        window.qaApp.select_selected_character(i);
    }, index);
    await expect(page.locator('#sb_character_editor_header')).toBeVisible();
    await page.waitForFunction(i => document.getElementById('character_name_pole')?.value === window.qaApp.characters[i].name, index);
}

async function open(page, viewport, mode) {
    modes = mode;
    await page.setViewportSize(viewport);
    await page.goto('/');
    await openCharacter(page, 0);
}

async function shownSections(page) {
    return page.evaluate(sections => sections.filter(name => {
        const node = document.querySelector(`#form_create [data-sb-section="${name}"]`);
        return node && getComputedStyle(node).display !== 'none' && !node.hidden;
    }), SECTIONS);
}

const greetingBlocks = page => page.evaluate(() => ({
    first: getComputedStyle(document.getElementById('firstMessageWrapper')).display !== 'none',
    alternate: getComputedStyle(document.getElementById('character_greetings_editor')).display !== 'none',
    group: getComputedStyle(document.getElementById('sb_character_group_greetings')).display !== 'none',
}));

for (const viewport of VIEWPORTS) {
    test.describe(`${viewport.width}px`, () => {
        test('Quick Edit shows Essentials, Character Fields, the first message and Metadata', async ({ page }) => {
            await open(page, viewport, { quickEdit: true, spoilerFree: false });
            expect(await shownSections(page)).toEqual(['essentials', 'character-fields', 'greetings', 'metadata']);
            expect(await greetingBlocks(page)).toEqual({ first: true, alternate: false, group: false });
            await expect(page.locator('#sb_character_spoiler_reveal')).toBeHidden();
        });

        test('Spoiler Free Mode hides the definitions behind one row and keeps Metadata', async ({ page }) => {
            await open(page, viewport, { quickEdit: false, spoilerFree: true });
            // Related is not a definition, so Spoiler Free Mode leaves it to its own rule (it shows when the card has links).
            expect(await shownSections(page)).toEqual(['essentials', 'metadata', 'related']);
            await expect(page.locator('#sb_character_spoiler_reveal')).toBeVisible();
            await expect(page.locator('#creator_notes_textarea')).toBeVisible();
        });

        test('Show Definitions reveals the sections for this character only', async ({ page }) => {
            await open(page, viewport, { quickEdit: false, spoilerFree: true });
            await page.locator('#sb_character_spoiler_reveal_button').click();
            await expect(page.locator('#sb_character_spoiler_reveal')).toBeHidden();
            expect(await shownSections(page)).toEqual(['essentials', 'character-fields', 'advanced-fields', 'greetings', 'metadata', 'related']);
            expect(await page.evaluate(async () => (await import('/scripts/power-user.js')).power_user.spoiler_free_mode)).toBe(true);
            const count = await page.evaluate(() => window.qaApp.characters.length);
            if (count > 1) {
                await page.evaluate(() => {
                    window.qaApp.setCharacterId(1);
                    window.qaApp.select_selected_character(1);
                });
                await expect(page.locator('#sb_character_spoiler_reveal')).toBeVisible();
            }
        });

        test('both modes together hide both sets', async ({ page }) => {
            await open(page, viewport, { quickEdit: true, spoilerFree: true });
            expect(await shownSections(page)).toEqual(['essentials', 'metadata']);
            await page.locator('#sb_character_spoiler_reveal_button').click();
            expect(await shownSections(page)).toEqual(['essentials', 'character-fields', 'greetings', 'metadata']);
            expect(await greetingBlocks(page)).toEqual({ first: true, alternate: false, group: false });
        });
    });
}
