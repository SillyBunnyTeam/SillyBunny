import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchBodyOrSkip } from './helpers/route-fetch.js';
import { applyWelcomeSettings } from './helpers/welcome-dialog.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });

test.beforeEach(async ({ page }) => { await protectMaintainerServer(page); });

/** The settings the app has sent to the server, newest last. */
function recordSaves(page) {
    const saved = [];
    page.on('request', request => {
        if (new URL(request.url()).pathname !== '/api/settings/save') return;
        const buffer = request.postDataBuffer();
        if (!buffer) return;
        const text = request.headers()['content-encoding'] === 'gzip' ? gunzipSync(buffer) : buffer;
        saved.push(JSON.parse(text.toString()));
    });
    return saved;
}

async function loadApp(page) {
    await page.route('**/api/settings/get', async route => {
        const fetched = await fetchBodyOrSkip(route, response => response.json());
        if (!fetched) return;
        const { response, body: data } = fetched;
        const settings = JSON.parse(data.settings);
        settings.firstRun = false;
        applyWelcomeSettings(settings);
        data.settings = JSON.stringify(settings);
        return route.fulfill({ response, json: data });
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
}

async function openExtensions(page) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'extensions'));
    await page.locator('button[data-sb-settings-tab="extensions"]').evaluate(element => element.click());
    const panel = page.locator('[data-sb-panel="extensions"]');
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    await expect.poll(() => panel.locator('.sb-subpage-row').count(), { timeout: 30000 }).toBeGreaterThan(3);
    return panel;
}

async function openPage(panel, title) {
    await panel.locator('.sb-subpage-row', { hasText: title }).first().evaluate(element => element.click());
    const content = panel.locator('.sb-subpage-detail-content');
    await expect(content).toHaveCount(1);
    return content;
}

async function closePage(panel) {
    await panel.locator('.sb-subpage-back').evaluate(element => element.click());
    await expect(panel.locator('.sb-subpage-detail-content')).toHaveCount(0);
}

/** Picks an option in the select row that adopted `#id`, through the shared picker. */
async function pick(page, content, id, label) {
    await content.locator(`.ds-select-row:has(#${id}) .ds-select-row__trigger`).click();
    const surface = page.locator('.sb-picker:visible, .sb-picker-sheet:visible').last();
    await surface.getByRole('option', { name: label, exact: true }).click();
}

const savedValue = (saved, ...path) => path.reduce((value, key) => value?.[key], saved.at(-1)?.extension_settings);

test.describe('built-in extension settings rows', () => {
    test('a built-in page gets the shared rows around the same nodes, and a third-party page keeps its markup', async ({ page }) => {
        test.slow();
        await page.setViewportSize({ width: 1440, height: 900 });
        await loadApp(page);
        const panel = await openExtensions(page);

        // A third-party extension mounts its own container in the settings column, as installed extensions do.
        await page.evaluate(() => {
            const container = document.createElement('div');
            container.id = 'qa_third_party_container';
            container.className = 'extension_container';
            container.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>QA Third Party</b></div><div class="inline-drawer-content">
                <label class="checkbox_label" for="qa_tp_on"><input id="qa_tp_on" type="checkbox"><span>Switch</span></label>
                <div class="flex-container flexFlowColumn"><label for="qa_tp_url">Address</label><input id="qa_tp_url" class="text_pole" type="text" placeholder="http://"></div>
                <div class="flex-container flexFlowColumn"><label for="qa_tp_mode">Mode</label><select id="qa_tp_mode" class="text_pole"><option value="a">A</option><option value="b">B</option></select></div>
                <div class="flex-container flexFlowColumn"><label for="qa_tp_count">Count</label><input id="qa_tp_count" class="text_pole" type="number" value="3"></div>
            </div></div>`;
            document.getElementById('extensions_settings2').append(container);
        });
        await expect(panel.locator('.sb-subpage-row', { hasText: 'QA Third Party' })).toHaveCount(1);
        const third = await openPage(panel, 'QA Third Party');
        await expect(third.locator('#qa_tp_on')).toBeVisible();
        await expect(third.locator('.ds-row-switch, .ds-row-entry--floating, .ds-select-row, .ds-row--spin, [data-sb-adopted-label]')).toHaveCount(0);
        await expect(third.locator('#qa_tp_on')).not.toHaveAttribute('role', 'switch');
        await expect(third.locator('label[for="qa_tp_url"]')).toBeVisible();
        await expect(third.locator('#qa_tp_mode')).toBeVisible();
        // Markup the extension adds after the page opened is left alone as well.
        await page.evaluate(() => document.querySelector('#qa_third_party_container .inline-drawer-content').insertAdjacentHTML('beforeend', '<div><label for="qa_tp_late">Late</label><input id="qa_tp_late" type="text"></div>'));
        await expect(third.locator('#qa_tp_late')).toBeVisible();
        await expect(third.locator('.ds-row-entry--floating')).toHaveCount(0);
        await closePage(panel);

        const nodes = await page.evaluate(() => {
            window.__sbExtensionNodes = Object.fromEntries(['vectors_source', 'vectors_query', 'vectors_enabled_chats', 'vector_altEndpoint_address'].map(id => [id, document.getElementById(id)]));
            return Object.keys(window.__sbExtensionNodes);
        });
        expect(nodes).toHaveLength(4);
        const vectors = await openPage(panel, 'Vector Storage');
        // The secondary endpoint shows for the sources that need a URL, and a hidden field has no accessible name.
        await pick(page, vectors, 'vectors_source', 'Ollama');
        await expect(vectors.locator('.ds-row-switch input[type="checkbox"][role="switch"]')).not.toHaveCount(0);
        await expect(vectors.locator('.ds-select-row #vectors_source')).toHaveCount(1);
        await expect(vectors.locator('.ds-row--spin #vectors_query')).toHaveCount(1);
        await expect(vectors.locator('.ds-row-switch #vectors_enabled_chats')).toHaveCount(1);
        await expect(vectors.locator('.ds-row-entry--floating #vector_altEndpoint_address')).toHaveCount(1);
        expect(await page.evaluate(() => Object.entries(window.__sbExtensionNodes).every(([id, node]) => document.getElementById(id) === node))).toBe(true);

        // The field is named once, by the row's title; the placeholder it carried stays as its description.
        const address = vectors.locator('#vector_altEndpoint_address');
        await expect(address).toHaveAccessibleName('Secondary Embedding endpoint URL');
        await expect(address).toHaveAccessibleDescription('e.g. http://localhost:5001');
        await expect(vectors.locator('label[for="vector_altEndpoint_address"]')).toHaveCount(1);
        await expect(vectors.locator('[data-sb-adopted-label]').first()).toBeHidden();
        await expect(vectors.locator('[data-sb-copy-placeholder]')).toHaveCount(0);

        const overflow = await panel.locator('.sb-subpage-detail').evaluate(element => element.scrollWidth - element.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);
    });

    test('a value set through the adopted rows is saved by the extension as before', async ({ page }) => {
        test.slow();
        await page.setViewportSize({ width: 1440, height: 900 });
        const saved = recordSaves(page);
        await loadApp(page);
        const panel = await openExtensions(page);

        // Switches, a select and a spin row: Vector Storage.
        const vectors = await openPage(panel, 'Vector Storage');
        const queryBefore = await page.evaluate(() => Number(document.getElementById('vectors_query').value));
        await pick(page, vectors, 'vectors_source', 'OpenAI');
        await expect.poll(() => savedValue(saved, 'vectors', 'source')).toBe('openai');
        expect(await page.evaluate(() => document.getElementById('vectors_source').value)).toBe('openai');

        await vectors.locator('.ds-row-switch:has(#vectors_enabled_chats)').click();
        await expect.poll(() => savedValue(saved, 'vectors', 'enabled_chats')).toBe(true);
        await expect(vectors.locator('#vectors_enabled_chats')).toBeChecked();

        await vectors.locator('.ds-row--spin:has(#vectors_query) .ds-spin-btn--up').click();
        await expect.poll(() => savedValue(saved, 'vectors', 'query')).toBe(queryBefore + 1);
        await expect(vectors.locator('#vectors_query')).toHaveValue(String(queryBefore + 1));
        await vectors.locator('#vectors_query').fill('7');
        await vectors.locator('#vectors_query').blur();
        await expect.poll(() => savedValue(saved, 'vectors', 'query')).toBe(7);
        await closePage(panel);

        // A text field in an adopted floating row: the Text-to-speech regex pattern, shown once the filter is on.
        const tts = await openPage(panel, 'TTS');
        await tts.locator('.ds-row-switch:has(#tts_apply_regex)').click();
        await expect(tts.locator('#tts_regex_block')).toBeVisible();
        await expect(tts.locator('.ds-row-entry--floating #tts_regex_pattern')).toBeVisible();
        await tts.locator('#tts_regex_pattern').fill('/[0-9]+/g');
        await expect.poll(() => savedValue(saved, 'tts', 'regex_pattern')).toBe('/[0-9]+/g');
        await expect.poll(() => savedValue(saved, 'tts', 'apply_regex')).toBe(true);
        await closePage(panel);

        // A text field that has a Connect button beside it: Image Generation with the AUTOMATIC1111 source.
        const sd = await openPage(panel, 'Image Generation');
        await pick(page, sd, 'sd_source', 'Stable Diffusion Web UI (AUTOMATIC1111)');
        await expect.poll(() => savedValue(saved, 'sd', 'source')).toBe('auto');
        const url = sd.locator('.ds-row-entry--floating #sd_auto_url');
        await expect(url).toBeVisible();
        await expect(sd.locator('.ds-row-entry--floating .ds-row-suffix #sd_auto_validate')).toBeVisible();
        await url.fill('http://127.0.0.1:9999');
        await expect.poll(() => savedValue(saved, 'sd', 'auto_url')).toBe('http://127.0.0.1:9999');
    });

    test('provider settings that Text-to-speech renders again are presented again, text field by text field', async ({ page }) => {
        test.slow();
        await page.setViewportSize({ width: 1440, height: 900 });
        await loadApp(page);
        const panel = await openExtensions(page);
        const tts = await openPage(panel, 'TTS');
        await expect(tts.locator('#tts_provider_settings')).toBeAttached();

        await pick(page, tts, 'tts_provider', 'Azure');
        const region = tts.locator('#tts_provider_settings .ds-row-entry--floating #azure_tts_region');
        await expect(region).toBeVisible();
        await expect(region).toHaveAccessibleName('Region');
        await region.fill('westus');
        await expect(region).toHaveValue('westus');

        const firstNode = await region.evaluate(element => { window.__sbRegion = element; return element.id; });
        expect(firstNode).toBe('azure_tts_region');
        await pick(page, tts, 'tts_provider', 'OpenAI Compatible');
        await expect(tts.locator('#azure_tts_region')).toHaveCount(0);
        await expect(tts.locator('#tts_provider_settings .ds-row-entry--floating')).not.toHaveCount(0);
        for (const input of await tts.locator('#tts_provider_settings .ds-row-entry--floating input').all()) {
            await expect(input).not.toHaveAccessibleName('');
        }

        await pick(page, tts, 'tts_provider', 'Azure');
        await expect(tts.locator('#tts_provider_settings .ds-row-entry--floating #azure_tts_region')).toBeVisible();
        await expect(tts.locator('#azure_tts_region')).toHaveCount(1);
        expect(await tts.locator('#tts_provider_settings .ds-row-entry--floating').count()).toBe(await tts.locator('#tts_provider_settings label.ds-row-entry__title').count());
    });

    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        test(`every built-in extension page opens without clipping or duplicated rows at ${viewport.width}px`, async ({ page }) => {
            test.slow();
            await page.setViewportSize(viewport);
            await loadApp(page);
            const panel = await openExtensions(page);
            const titles = await panel.locator('.sb-subpage-row').evaluateAll(rows => rows.map(row => row.querySelector('.sb-subpage-row-title')?.textContent.trim() ?? row.textContent.trim()));
            expect(titles.length).toBeGreaterThan(8);
            const BUILT_IN = ['Character Expressions', 'Image Generation', 'TTS', 'Guided Generations', 'Quick Reply', 'Chat Translation', 'Image Captioning', 'Summarize', 'Regex', 'Vector Storage'];
            for (const title of BUILT_IN) expect(titles.some(name => name.startsWith(title)), title).toBe(true);

            const report = [];
            for (const title of BUILT_IN) {
                const content = await openPage(panel, title);
                const result = await content.evaluate(element => {
                    const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
                    const detail = element.closest('.sb-subpage-detail');
                    const box = detail.getBoundingClientRect();
                    const clipped = [...element.querySelectorAll('.ds-row, .ds-row-entry--floating, .ds-select-row__trigger, input, select')]
                        .filter(node => visible(node) && !node.closest('.sb-legacy-search-hidden, .ds-select-row__native'))
                        .filter(node => { const rect = node.getBoundingClientRect(); return rect.width > 0 && (rect.right > box.right + 1 || rect.left < box.left - 1); })
                        .map(node => node.id || node.className);
                    const ids = [...element.querySelectorAll('[id]')].map(node => node.id);
                    const entries = [...element.querySelectorAll('.ds-row-entry__field input')];
                    const unnamedSelects = [...element.querySelectorAll('.ds-select-row')]
                        .filter(row => !(row.querySelector('.ds-select-row__trigger')?.getAttribute('aria-labelledby') && row.querySelector('.ds-row-label')?.textContent.trim()))
                        .map(row => row.querySelector('select')?.id ?? '');
                    return {
                        overflow: detail.scrollWidth - detail.clientWidth,
                        clipped,
                        duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index),
                        titleless: [...entries.filter(control => !control.labels?.length && !control.getAttribute('aria-label')).map(control => control.id), ...unnamedSelects],
                        doubleNamed: entries.filter(control => control.labels?.length > 1).map(control => control.id),
                        visibleRetired: [...element.querySelectorAll('[data-sb-adopted-label]')].filter(visible).length,
                        placeholders: element.querySelectorAll('[data-sb-copy-placeholder]').length,
                    };
                });
                report.push({ title, ...result });
                await closePage(panel);
            }
            for (const result of report) {
                expect(result.overflow, `${result.title} overflows`).toBeLessThanOrEqual(1);
                expect(result.clipped, `${result.title} clips`).toEqual([]);
                expect(result.titleless, `${result.title} has an unnamed field`).toEqual([]);
                expect(result.doubleNamed, `${result.title} names a field twice`).toEqual([]);
                expect(result.visibleRetired, `${result.title} still shows an adopted label`).toBe(0);
                expect(result.placeholders, `${result.title} has copy placeholders`).toBe(0);
            }
        });
    }
});
