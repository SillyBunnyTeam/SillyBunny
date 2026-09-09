/* global $, document, window, setOpenRouterProviders, syncOpenRouterProvidersForModel, bindInlineSelectPickerSelect */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const models = readFileSync(new URL('../public/scripts/textgen-models.js', import.meta.url), 'utf8');
const openai = readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8');
const tierCode = readFileSync(new URL('../public/scripts/service-tiers.js', import.meta.url), 'utf8').replaceAll('export ', '');
const providerCode = models.slice(models.indexOf('const OPENROUTER_PROVIDER_WARNING_SELECTORS'), models.indexOf('let nanoGptProvidersRequest')).replaceAll('export ', '');
const pickerCode = openai.slice(openai.indexOf('function getInlineSelectPickerEntries('), openai.indexOf('function bindInlineSelectPickerControl('));
const desktopCode = models.slice(models.indexOf('    providersSelect.select2({'), models.indexOf('    nanoGptProvidersSelect.select2({'));

for (const mobile of [false, true]) {
    test(`live provider catalogue preserves choices and ignores stale responses (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
        await page.setViewportSize({ width: mobile ? 390 : 1440, height: 900 });
        await page.setContent(['text', 'chat'].map(mode => `<div><select multiple class="openrouter_providers" id="openrouter_providers_${mode}"></select>
            <select id="openrouter_service_tier_${mode}"><option value="">Default</option><option value="flex">Flex</option><option value="priority">Priority</option></select></div>`).join(''));
        await page.addScriptTag({ path: fileURLToPath(new URL('../public/lib/jquery-3.5.1.min.js', import.meta.url)) });
        await page.addScriptTag({ path: fileURLToPath(new URL('../public/lib/select2.min.js', import.meta.url)) });
        await page.addScriptTag({ content: `
            let openRouterProvidersRequest = null;
            const getRequestHeaders = () => ({});
            const isMobile = () => ${mobile};
            const t = strings => strings[0];
            const bindModelSelectPickerDocumentListener = () => {};
            const closeModelSelectPickerMenus = () => {};
            const scrollElementIntoNearestPanelScroller = () => {};
            window.pending = [];
            window.fetch = (url, options) => new Promise(resolve => pending.push({ url, options, resolve }));
            ${tierCode}
            ${providerCode}
            ${pickerCode}
            const providersSelect = $('.openrouter_providers');
            const select2Defaults = {};
            if (!isMobile()) {
                ${desktopCode}
                for (const select of providersSelect) {
                    const config = $(select).data('select2').options.options;
                    $(select).select2('destroy').select2(config);
                }
            }
        ` });

        await page.evaluate(() => {
            window.changes = 0;
            $('.openrouter_providers').on('change', () => window.changes++);
            for (const mode of ['text', 'chat']) {
                const selector = `#openrouter_providers_${mode}`;
                setOpenRouterProviders(selector, ['Zeta', 'Missing']);
                bindInlineSelectPickerSelect(document.querySelector(selector), {});
            }
            window.loading = Promise.all(['text', 'chat'].map(mode => syncOpenRouterProvidersForModel('test/old', `#openrouter_providers_${mode}`)));
        });
        if (mobile) await page.locator('#openrouter_providers_chat').press('Enter');
        else await page.evaluate(() => $('#openrouter_providers_chat').select2('open'));
        expect(await page.evaluate(() => window.pending.length)).toBe(1);
        // A saved preset or user change during loading must win over the earlier selection.
        await page.evaluate(() => {
            setOpenRouterProviders('#openrouter_providers_chat', ['Missing', 'Zeta']);
            window.pending.shift().resolve({ ok: true, json: async () => ['Alpha', 'Zeta', '<img src=x>'] });
        });
        await expect.poll(() => page.evaluate(() => window.pending.length)).toBe(2);
        await page.evaluate(async () => {
            for (const request of window.pending.splice(0)) request.resolve({ ok: true, json: async () => ({ providers: ['Alpha', 'Zeta'], service_tiers: ['flex', 'priority'] }) });
            await window.loading;
        });
        for (const mode of ['text', 'chat']) {
            await expect(page.locator(`#openrouter_providers_${mode} option`)).toHaveCount(4);
            await expect(page.locator(`#openrouter_service_tier_${mode}`)).toBeEnabled();
            await page.locator(`#openrouter_service_tier_${mode}`).selectOption('flex');
        }
        expect(await page.evaluate(() => Array.from(document.querySelector('#openrouter_providers_chat').selectedOptions, option => option.value))).toEqual(['Missing', 'Zeta']);
        await expect(page.locator('img')).toHaveCount(0);
        expect(await page.evaluate(() => window.changes)).toBe(0);
        const menu = page.locator(mobile ? '#openrouter_providers_chat_menu' : '#select2-openrouter_providers_chat-results');
        await expect(menu.getByRole('option', { name: 'Alpha', exact: true })).toBeVisible();
        await menu.getByRole('option', { name: 'Alpha', exact: true }).click();
        expect(await page.evaluate(() => Array.from(document.querySelector('#openrouter_providers_chat').selectedOptions, option => option.value))).toEqual(['Missing', 'Zeta', 'Alpha']);
        const remove = mobile
            ? menu.getByRole('option', { name: 'Missing', exact: true })
            : page.locator('#openrouter_providers_chat + .select2 .select2-selection__choice[title="Missing"] .select2-selection__choice__remove');
        await remove.click();
        expect(await page.evaluate(() => Array.from(document.querySelector('#openrouter_providers_chat').selectedOptions, option => option.value))).toEqual(['Zeta', 'Alpha']);
        const changes = await page.evaluate(() => window.changes);
        expect(changes).toBeGreaterThan(0);

        // Failed refreshes retain the last catalogue; newer model availability wins.
        await page.evaluate(() => {
            window.old = syncOpenRouterProvidersForModel('test/old', '#openrouter_providers_chat');
            window.pending.shift().resolve({ ok: false, status: 502 });
        });
        await expect.poll(() => page.evaluate(() => window.pending.length)).toBe(1);
        await page.evaluate(() => {
            window.newer = syncOpenRouterProvidersForModel('test/new', '#openrouter_providers_chat');
            window.pending.pop().resolve({ ok: true, json: async () => [] });
        });
        await expect.poll(() => page.evaluate(() => window.pending.length)).toBe(2);
        await page.evaluate(async () => {
            window.pending.pop().resolve({ ok: true, json: async () => ({ providers: ['Alpha'], service_tiers: ['priority'] }) });
            await window.newer;
            window.pending.pop().resolve({ ok: true, json: async () => ({ providers: ['Zeta'], service_tiers: ['flex'] }) });
            await window.old;
        });
        await expect(page.locator('#openrouter_providers_chat option')).toHaveCount(4);
        expect(await page.locator('#openrouter_providers_chat option:enabled').allTextContents()).toEqual(['Alpha']);
        expect(await page.evaluate(() => window.changes)).toBe(changes);
        await expect(page.locator('#openrouter_service_tier_chat')).toHaveValue('flex');
        await expect(page.locator('#openrouter_service_tier_chat option[value="flex"]')).toBeDisabled();
        await expect(page.locator('#openrouter_service_tier_chat option[value="priority"]')).toBeEnabled();
    });
}
