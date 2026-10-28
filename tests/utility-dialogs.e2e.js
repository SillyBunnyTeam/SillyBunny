import { expect, test } from '@playwright/test';
import { keysFromLastRadioToFirst } from './helpers/browser-neutral.js';
import { bootUtilityDialogs, expectUtilityFrame, openUtilityDialog, UTILITY_VIEWPORTS } from './helpers/utility-dialogs.js';

test.setTimeout(90000);
// Playwright's `page.route` does not see requests that the app's service worker handles, so the worker is blocked
// to keep every stub in effect.
test.use({ serviceWorkers: 'block' });

// Only Transfer removes the reply from its source set.
const SOURCE_REPLIES_LEFT = { Transfer: 0, Copy: 1, 'Shift+Enter': 1 };

async function arrowChoice(page, popup, selector, nextValue) {
    await popup.locator(selector).focus();
    await page.keyboard.press('ArrowRight');
    await expect(popup.locator('input[type="radio"]:checked')).toHaveValue(nextValue);
    await page.keyboard.press('ArrowLeft');
    await expect(popup.locator(selector)).toBeChecked();
    await page.keyboard.press('ArrowRight');
}

for (const viewport of UTILITY_VIEWPORTS) {
    const size = `${viewport.width}×${viewport.height}`;
    test(`Recent Chats settings preserve clamp, empty defaults, Cancel and account storage at ${size}`, async ({ page }) => {
        await bootUtilityDialogs(page, viewport);
        const read = () => page.evaluate(async () => (await import('/scripts/util/AccountStorage.js')).accountStorage.getItem('recentChatsSettings'));
        const before = await read();
        let popup = await openUtilityDialog(page, 'recent');
        await expectUtilityFrame(popup, viewport, expect);
        await popup.locator('#maxRecentChats').fill('42');
        await popup.locator('.popup-button-cancel').click();
        await expect(popup).toHaveCount(0);
        expect(await read()).toBe(before);
        popup = await openUtilityDialog(page, 'recent');
        await popup.locator('#maxRecentChats').fill('12');
        await popup.locator('#collapsedRecentChats').fill('99');
        await popup.locator('.popup-button-ok').click();
        await expect.poll(read).toBe(JSON.stringify({ maxDisplayed: 12, collapsedDisplayed: 12 }));
        popup = await openUtilityDialog(page, 'recent');
        await popup.locator('#maxRecentChats').fill('');
        await popup.locator('#collapsedRecentChats').fill('');
        await popup.locator('.popup-button-ok').click();
        await expect.poll(read).toBe(JSON.stringify({ maxDisplayed: 15, collapsedDisplayed: 3 }));
    });

    test(`Create persona keeps name, trimmed display title and persisted schema at ${size}`, async ({ page }) => {
        const state = await bootUtilityDialogs(page, viewport);
        const popup = await openUtilityDialog(page, 'persona');
        await expectUtilityFrame(popup, viewport, expect);
        await popup.locator('.popup-input').fill('Utility Persona');
        await popup.locator('#persona_title').fill('  Display Title  ');
        await popup.locator('.popup-button-ok').click();
        await expect.poll(() => page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            const avatar = Object.keys(power_user.personas).find(id => power_user.personas[id] === 'Utility Persona');
            return power_user.persona_descriptions[avatar]?.title;
        })).toBe('Display Title');
        await expect.poll(() => state.settings.some(settings => Object.values(settings.power_user.personas).includes('Utility Persona'))).toBe(true);
    });

    test(`Add Secret preserves input identity, labels, Cancel and empty-secret confirmation at ${size}`, async ({ page }) => {
        const state = await bootUtilityDialogs(page, viewport);
        let popup = await openUtilityDialog(page, 'secret');
        await expectUtilityFrame(popup, viewport, expect, 'alert');
        // This upstream call uses Popup's textarea, not a password input; the adapter must not replace it.
        await expect(popup.locator('textarea.popup-input')).toHaveCount(1);
        const secret = 'fixture-secret-only';
        await popup.locator('.popup-input').fill(secret);
        await expect(popup.locator('textarea.popup-input')).not.toHaveAttribute('value', secret);
        expect(await popup.evaluate((dialog, value) => [...dialog.querySelectorAll('*')]
            .filter(element => element !== dialog.querySelector('textarea.popup-input'))
            .some(element => element.textContent?.includes(value) || [...element.attributes].some(attribute => attribute.value.includes(value))), secret)).toBe(false);
        await popup.locator('#newSecretLabel').fill('  Fixture Label  ');
        await popup.locator('.popup-button-ok').click();
        await expect.poll(() => state.secrets.length).toBe(1);
        expect(state.secrets[0]).toEqual({ key: 'api_key_openai', value: 'fixture-secret-only', label: 'Fixture Label' });
        await page.locator('dialog[open] .sb-dialog__close').click();
        popup = await openUtilityDialog(page, 'secret');
        await popup.locator('.popup-button-cancel').click();
        await expect(popup).toHaveCount(0);
        expect(state.secrets).toHaveLength(1);
        await page.locator('dialog[open] .sb-dialog__close').click();
        popup = await openUtilityDialog(page, 'secret');
        await popup.locator('.popup-button-ok').click();
        const confirmation = page.locator('dialog.popup[open]').last();
        await expect(confirmation).toContainText('No value entered');
        await confirmation.locator('.popup-button-cancel').click();
        expect(state.secrets).toHaveLength(1);
    });

    test(`Regex import keeps native target events and arrow-key grouping at ${size}`, async ({ page, browserName }) => {
        const state = await bootUtilityDialogs(page, viewport);
        const popup = await openUtilityDialog(page, 'regex');
        await expectUtilityFrame(popup, viewport, expect);
        await expect(popup.locator('input[type="radio"]')).toHaveCount(3);
        await arrowChoice(page, popup, '#regex_import_target_global', 'preset');
        await page.keyboard.press('ArrowRight');
        await expect(popup.locator('#regex_import_target_scoped')).toBeChecked();
        for (const key of keysFromLastRadioToFirst(browserName, 3)) await page.keyboard.press(key);
        await expect(popup.locator('#regex_import_target_global')).toBeChecked();
        await popup.locator('.sb-dialog__close').click();
        await expect.poll(() => state.settings.some(settings => settings.extension_settings.regex.some(script => script.scriptName === 'Utility imported regex'))).toBe(true);
    });

    for (const action of Object.keys(SOURCE_REPLIES_LEFT)) {
        test(`Quick Reply ${action} keeps response layout and source/target results at ${size}`, async ({ page }) => {
            const state = await bootUtilityDialogs(page, viewport);
            const popup = await openUtilityDialog(page, 'quick-reply');
            await expectUtilityFrame(popup, viewport, expect);
            const copy = popup.locator('.sb-dialog__bottom-bar .qr--copy');
            await expect(copy).toBeInViewport();
            await expect(copy).not.toHaveClass(/menu_button_primary|menu_button_default|is-suggested/);
            await expect(popup.locator('.sb-dialog__header .popup-button-cancel')).toBeInViewport();
            await expect(popup.locator('.sb-dialog__header .popup-button-ok')).toBeInViewport();
            await popup.locator('.ds-select-row__trigger').click();
            await page.locator('.sb-picker, .sb-picker-sheet').last().getByRole('option', { name: 'Utility Target', exact: true }).click();
            if (action === 'Shift+Enter') {
                await popup.locator('.ds-select-row__trigger').focus();
                await page.keyboard.press('Shift+Enter');
            } else {
                await (action === 'Copy' ? copy : popup.locator('.popup-button-ok')).click();
            }
            const sourceCount = SOURCE_REPLIES_LEFT[action];
            await expect.poll(() => page.evaluate(() => ({ source: window.__utilityReplies.source.qrList.length, target: window.__utilityReplies.target.qrList.map(qr => ({ label: qr.label, message: qr.message, icon: qr.icon })) }))).toEqual({ source: sourceCount, target: [{ label: 'Utility Reply', message: '/echo fixture', icon: 'fa-star' }] });
            // Each set saves 200 ms after its last change. Ending the test earlier lets that save run after the
            // test's routes are gone, which writes both sets to the real server.
            const expectedSaves = [['Utility Target', 1], ['Utility Source', sourceCount]];
            await expect.poll(() => expectedSaves.every(([name, length]) => state.replies.some(reply => reply.name === name && reply.qrList.length === length))).toBe(true);
        });
    }

    test(`Image prompt review keeps prompt whitespace, negative trim and resolution results at ${size}`, async ({ page }) => {
        await bootUtilityDialogs(page, viewport);
        const popup = await openUtilityDialog(page, 'image');
        await expectUtilityFrame(popup, viewport, expect);
        await expect(popup.locator('.ds-row--stacked')).toHaveCount(2);
        await popup.locator('.popup-input').fill('  Updated prompt  ');
        await popup.locator('#sd_refine_negative').fill('  Updated negative  ');
        await popup.locator('#sd_use_saved_resolution').uncheck();
        await popup.locator('.popup-button-ok').click();
        await expect.poll(() => page.evaluate(() => ({ value: window.__utilityImageResult, args: window.__utilityImageArgs }))).toEqual({ value: '  Updated prompt  ', args: { negative: 'Updated negative', resolution: null } });
    });

    for (const kind of ['web', 'mediawiki', 'fandom', 'youtube']) {
        test(`${kind} scraper keeps intercepted requests and file results at ${size}`, async ({ page }) => {
            const state = await bootUtilityDialogs(page, viewport);
            const popup = await openUtilityDialog(page, kind);
            await expectUtilityFrame(popup, viewport, expect);
            if (kind === 'web') await popup.locator('.popup-input').fill(' https://example.test/a \ninvalid\nhttps://example.test/b ');
            if (kind === 'youtube') {
                await popup.locator('.popup-input').fill('https://youtu.be/TDpxx5UqrVU');
                await popup.locator('input[name="youtubeLanguageCode"]').fill('fr');
            }
            if (kind === 'mediawiki' || kind === 'fandom') {
                const prefix = kind === 'fandom' ? 'fandomScrape' : 'scrape';
                await popup.locator(`input[name="${prefix}Input"]`).fill(kind === 'fandom' ? 'https://fixture.fandom.com/' : 'https://example.test/wiki');
                await popup.locator(`input[name="${prefix}Filter"]`).fill('/fixture/gi');
                await arrowChoice(page, popup, `#${prefix}OutputSingle`, 'multi');
            }
            await popup.locator('.popup-button-ok').click();
            await expect.poll(() => state.scrapes.length).toBe(kind === 'web' ? 2 : 1);
            await expect.poll(() => page.evaluate(() => window.__utilityFiles?.length)).toBe(kind === 'youtube' ? 1 : 2);
            if (kind === 'web') expect(state.scrapes).toEqual([{ url: 'https://example.test/a' }, { url: 'https://example.test/b' }]);
            if (kind === 'youtube') {
                // Preserve the pre-existing post-close language-listener behavior (lang remains empty).
                expect(state.scrapes[0]).toEqual({ id: 'TDpxx5UqrVU', lang: '' });
                expect(await page.evaluate(() => window.__utilityFiles[0].text)).toBe('Fixture transcript');
            }
            if (kind === 'mediawiki' || kind === 'fandom') {
                expect(state.scrapes[0]).toMatchObject(kind === 'fandom' ? { fandom: 'https://fixture.fandom.com/', filter: '/fixture/gi' } : { url: 'https://example.test/wiki', filter: '/fixture/gi' });
                expect(await page.evaluate(() => window.__utilityFiles.map(file => ({ name: file.name, text: file.text })))).toEqual([{ name: 'First.txt', text: 'One' }, { name: 'Second.txt', text: 'Two' }]);
            }
        });
    }

    test(`Icon picker body search preserves filter, keyboard selection, No Icon and Cancel at ${size}`, async ({ page }) => {
        await bootUtilityDialogs(page, viewport);
        let popup = await openUtilityDialog(page, 'icons');
        await expectUtilityFrame(popup, viewport, expect);
        await popup.locator('.faQuery').fill('star');
        await expect(popup.locator('.faPicker > :not(.hidden)')).toHaveCount(30);
        const icon = popup.locator('.faPicker > :not(.hidden)').last();
        await icon.focus();
        await page.keyboard.press('Enter');
        await expect.poll(() => page.evaluate(() => window.__utilityIconResult)).toBe('fa-star');
        popup = await openUtilityDialog(page, 'icons');
        await popup.locator('.popup-button-ok').click();
        await expect.poll(() => page.evaluate(() => window.__utilityIconResult)).toBe('');
        popup = await openUtilityDialog(page, 'icons');
        await popup.locator('.popup-button-cancel').click();
        await expect.poll(() => page.evaluate(() => window.__utilityIconResult)).toBe(null);
    });
}
