import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchBodyOrSkip } from './helpers/route-fetch.js';
import { applyWelcomeSettings } from './helpers/welcome-dialog.js';
import { waitForAppReady } from './helpers/app-ready.js';

const SCREENSHOT_DIR = process.env.PR872_SCREENSHOT_DIR || '';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });

test.beforeEach(async ({ page }) => {
    await protectMaintainerServer(page);
});

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
    await waitForAppReady(page, { timeout: 60000 });
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

async function pick(page, content, id, label) {
    await content.locator(`.ds-select-row:has(#${id}) .ds-select-row__trigger`).click();
    const surface = page.locator('.sb-picker:visible, .sb-picker-sheet:visible').last();
    await surface.getByRole('option', { name: label, exact: true }).click();
}

async function makeSamplePngBuffer(page, color) {
    const base64 = await page.evaluate(hex => {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 96;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = hex;
        ctx.fillRect(0, 0, 64, 96);
        return canvas.toDataURL('image/png').split(',')[1];
    }, color);
    return Buffer.from(base64, 'base64');
}

async function openImageGenerationNovelAI(page, panel) {
    const sd = await openPage(panel, 'Image Generation');
    await pick(page, sd, 'sd_source', 'NovelAI Diffusion');
    await expect.poll(() => sd.locator('#sd_model option[value="nai-diffusion-4-5-full"]').count(), { timeout: 15000 }).toBe(1);
    await pick(page, sd, 'sd_model', 'NAI Diffusion Anime V4.5 (Full)');
    return {
        pageContent: sd,
        root: sd.locator('#sd_novel_precise_reference'),
        switchId: 'sd_novel_precise_reference_enabled',
        readSavedState: saved => saved.at(-1)?.extension_settings?.sd?.novel_precise_reference,
        seedSixteen: async paths => {
            await page.evaluate(async storedPaths => {
                const { extension_settings } = await import('/scripts/extensions.js');
                extension_settings.sd.novel_precise_reference = {
                    enabled: true,
                    references: storedPaths.map(filePath => ({ path: filePath, bytes: 1024, type: 'character', strength: 1, fidelity: 1 })),
                };
                document.getElementById('sd_model').dispatchEvent(new Event('change', { bubbles: true }));
            }, paths);
        },
    };
}

async function openQuickImageGenNovelAI(page, panel) {
    const qig = await openPage(panel, 'Quick Image Gen');
    const setupToggle = qig.locator('#qig-setup-toggle');
    await setupToggle.evaluate(btn => {
        if (btn.getAttribute('aria-expanded') !== 'true') btn.click();
    });
    const providerToggle = qig.locator('#qig-section-provider-toggle');
    await providerToggle.evaluate(btn => {
        if (btn.getAttribute('aria-expanded') !== 'true') btn.click();
    });
    await qig.locator('#qig-provider').selectOption('novelai');
    await qig.locator('#qig-nai-model').fill('nai-diffusion-4-5-full');
    await qig.locator('#qig-nai-model').dispatchEvent('change');
    return {
        pageContent: qig,
        root: qig.locator('#qig-nai-precise-reference'),
        switchId: 'qig-nai-precise-reference-enabled',
        readSavedState: saved => saved.at(-1)?.extension_settings?.['quick-image-gen']?.naiPreciseReference,
        seedSixteen: async paths => {
            await page.evaluate(async storedPaths => {
                const { extension_settings } = await import('/scripts/extensions.js');
                extension_settings['quick-image-gen'].naiPreciseReference = {
                    enabled: true,
                    references: storedPaths.map(filePath => ({ path: filePath, bytes: 1024, type: 'character', strength: 1, fidelity: 1 })),
                };
                document.getElementById('qig-nai-precise-reference')?.preciseReferenceEditor?.refresh();
            }, paths);
        },
    };
}

async function verifySurfaceEditor({ page, viewport, surfaceName, openSurface }) {
    const saved = recordSaves(page);
    const uploadedFiles = [];
    page.on('request', request => {
        if (new URL(request.url()).pathname === '/api/files/upload') {
            uploadedFiles.push(JSON.parse(request.postData() || '{}').name);
        }
    });

    await loadApp(page);
    const panel = await openExtensions(page);
    const { root, switchId, readSavedState, seedSixteen } = await openSurface(page, panel);

    await expect(root).toBeVisible();
    await expect(root.locator('.ds-pref-group')).toHaveCount(1);
    const switchInput = root.locator(`#${switchId}`);
    await expect(switchInput).toHaveAttribute('role', 'switch');
    await expect(root.locator('.ds-row-switch .ds-row-subtitle')).toContainText('5 additional Anlas per reference');

    // Toggle switch via keyboard and verify focus survives on the switch.
    await switchInput.focus();
    await page.keyboard.press('Space');
    await expect(switchInput).toBeChecked();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(switchId);

    // Stylesheet loads via loadStylesheetAsync with a ?v= cache key.
    await expect.poll(async () => page.evaluate(() => {
        const link = document.getElementById('novelai-precise-reference-css');
        return Boolean(link && link.getAttribute('href')?.includes('?v=') && link.dataset.sbStyleState === 'loaded');
    })).toBe(true);

    // No hand-built legacy controls.
    await expect(root.locator('fieldset, select, .menu_button')).toHaveCount(0);
    const addButton = root.locator('[data-sb-editor-field="novelai-precise-reference-add"]');
    await expect(addButton).toHaveClass(/ds-button-row/);

    // Upload two references and confirm user-file storage and focus preservation.
    const png1 = await makeSamplePngBuffer(page, '#4c7a9c');
    const png2 = await makeSamplePngBuffer(page, '#9c5b4c');
    await addButton.focus();
    await root.locator('input[type="file"]').setInputFiles([
        { name: 'ref1.png', mimeType: 'image/png', buffer: png1 },
        { name: 'ref2.png', mimeType: 'image/png', buffer: png2 },
    ]);

    const expanders = root.locator('.ds-row-expander');
    await expect(expanders).toHaveCount(2, { timeout: 15000 });
    expect(uploadedFiles).toHaveLength(2);
    for (const fileName of uploadedFiles) {
        expect(fileName).toMatch(/^sb-nai-ref-[0-9a-f]{16}\.png$/);
    }

    // Focus must survive adding and not fall to document.body.
    expect(await page.evaluate(() => document.activeElement?.dataset?.sbEditorField)).toBe('novelai-precise-reference-add');

    // References start collapsed with thumbnails and summaries.
    await expect(expanders.nth(0).locator('.ds-row-expander__toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(expanders.nth(0).locator('.ds-row-expander__toggle .ds-row-subtitle')).toHaveText('Character • Strength 1 • Fidelity 1');
    await expect.poll(() => expanders.nth(0).locator('.nai-precise-reference__thumb').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);

    // Settings saved user-file paths only, never inline base64 PNG data.
    await expect.poll(() => readSavedState(saved)?.references?.length, { timeout: 10000 }).toBe(2);
    const savedAfterUpload = readSavedState(saved);
    for (const ref of savedAfterUpload.references) {
        expect(ref.path).toMatch(/^\/user\/files\/sb-nai-ref-[0-9a-f]{16}\.png$/);
        expect(ref).not.toHaveProperty('image');
    }

    // Expand Reference 1 and verify shared toggle row + slider rows.
    const firstToggle = expanders.nth(0).locator('.ds-row-expander__toggle');
    await firstToggle.click();
    await expect(firstToggle).toHaveAttribute('aria-expanded', 'true');
    expect(await page.evaluate(el => document.activeElement === el, await firstToggle.elementHandle())).toBe(true);

    const typeRow = expanders.nth(0).locator('.ds-toggle-row');
    await expect(typeRow).toHaveCount(1);
    await expect(typeRow.locator('input[type="radio"]')).toHaveCount(3);
    await typeRow.locator('.sb-boolean-radio-option', { hasText: 'Style' }).first().click();
    await expect(expanders.nth(0).locator('.ds-row-expander__toggle .ds-row-subtitle')).toHaveText('Style • Strength 1 • Fidelity 1');

    // Slider input previews without saving; change commits once and preserves focus.
    await expect.poll(() => readSavedState(saved)?.references?.[0]?.type, { timeout: 10000 }).toBe('style');
    const savesBeforeSlide = saved.length;
    const strengthSlider = expanders.nth(0).locator('[data-sb-editor-field="novelai-precise-reference-strength"] input[type="range"]');
    await strengthSlider.focus();
    await strengthSlider.evaluate(input => {
        input.value = '0.65';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(expanders.nth(0).locator('.ds-row-expander__toggle .ds-row-subtitle')).toHaveText('Style • Strength 0.65 • Fidelity 1');
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1300)));
    expect(saved.length).toBe(savesBeforeSlide);

    await strengthSlider.evaluate(input => {
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect.poll(() => readSavedState(saved)?.references?.[0]?.strength, { timeout: 10000 }).toBe(0.65);
    expect(await page.evaluate(el => document.activeElement === el, await strengthSlider.elementHandle())).toBe(true);

    // Optional After screenshots with Reference 1 expanded and Reference 2 collapsed.
    if (SCREENSHOT_DIR) {
        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
        await root.scrollIntoViewIfNeeded();
        await page.screenshot({
            path: path.join(SCREENSHOT_DIR, `after-${surfaceName}-${viewport.name}.png`),
            animations: 'disabled',
        });
    }

    // Status copy must wrap cleanly rather than clip horizontally on narrow viewports.
    const statusClip = await root.locator('.nai-precise-reference__status > [role]').evaluate(el => {
        const rowRect = el.closest('.ds-row').getBoundingClientRect();
        const textRect = el.getBoundingClientRect();
        return { overflow: el.scrollWidth - el.clientWidth, rightGap: textRect.right - rowRect.right };
    });
    expect(statusClip.overflow).toBeLessThanOrEqual(1);
    expect(statusClip.rightGap).toBeLessThanOrEqual(1);

    // Coarse-pointer touch targets on mobile must meet the 44 px floor.
    if (viewport.coarse) {
        const heights = await expanders.nth(0).evaluate(row => {
            const measure = selector => [...row.querySelectorAll(selector)].map(el => el.getBoundingClientRect().height);
            return {
                toggle: row.querySelector('.ds-row-expander__toggle').getBoundingClientRect().height,
                segments: measure('.ds-toggle-row__group .sb-boolean-radio-option > span'),
                ranges: measure('.ds-row-slider input[type="range"]'),
                remove: row.querySelector('[data-sb-editor-field="novelai-precise-reference-remove"]').getBoundingClientRect().height,
            };
        });
        expect(heights.toggle).toBeGreaterThanOrEqual(44);
        expect(heights.remove).toBeGreaterThanOrEqual(44);
        for (const h of heights.segments) expect(h).toBeGreaterThanOrEqual(44);
        for (const h of heights.ranges) expect(h).toBeGreaterThanOrEqual(44);
        expect(await addButton.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    }

    // Remove Reference 1 and verify focus moves to the next reference toggle, then Add button.
    await expanders.nth(0).locator('[data-sb-editor-field="novelai-precise-reference-remove"]').click();
    await expect(expanders).toHaveCount(1);
    expect(await page.evaluate(el => document.activeElement === el, await expanders.nth(0).locator('.ds-row-expander__toggle').elementHandle())).toBe(true);

    await expanders.nth(0).locator('.ds-row-expander__toggle').click();
    await expanders.nth(0).locator('[data-sb-editor-field="novelai-precise-reference-remove"]').click();
    await expect(expanders).toHaveCount(0);
    expect(await page.evaluate(el => document.activeElement === el, await addButton.elementHandle())).toBe(true);

    // Seed 16 references and verify compact collapsed height and zero horizontal overflow.
    const paths = Array.from({ length: 16 }, (_, index) => `/user/files/sb-nai-ref-${String(index).padStart(16, '0')}.png`);
    await seedSixteen(paths);
    await expect(expanders).toHaveCount(16);
    const layout = await root.evaluate(element => {
        const detail = element.closest('.sb-subpage-detail');
        return {
            height: element.getBoundingClientRect().height,
            overflow: detail ? detail.scrollWidth - detail.clientWidth : element.scrollWidth - element.clientWidth,
        };
    });
    expect(layout.height).toBeLessThan(1600);
    expect(layout.overflow).toBeLessThanOrEqual(1);
    return layout;
}

for (const viewport of [
    { name: 'desktop', width: 1440, height: 900, coarse: false },
    { name: 'mobile', width: 390, height: 844, coarse: true },
]) {
    test.describe(`NovelAI Precise Reference surfaces (${viewport.name})`, () => {
        test.use({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.coarse });

        test('Image Generation uses shared rows, user files, compact expanders, and keeps focus', async ({ page }) => {
            test.slow();
            const layout = await verifySurfaceEditor({
                page,
                viewport,
                surfaceName: 'image-gen',
                openSurface: openImageGenerationNovelAI,
            });
            expect(layout.height).toBeLessThan(1600);
        });

        test('Quick Image Gen uses shared rows, user files, compact expanders, touch targets, and keeps focus', async ({ page }) => {
            test.slow();
            const layout = await verifySurfaceEditor({
                page,
                viewport,
                surfaceName: 'qig',
                openSurface: openQuickImageGenNovelAI,
            });
            expect(layout.height).toBeLessThan(1600);
        });
    });
}

test.describe('NovelAI Precise Reference preparation guards', () => {
    test('locks every control while preparing an image and drops images when host replaces references mid-flight', async ({ page }) => {
        await loadApp(page);
        const result = await page.evaluate(async () => {
            const { mountNovelAIPreciseReferenceEditor } = await import('/scripts/novelai-precise-reference-ui.js');
            const canvas = document.createElement('canvas');
            canvas.width = 32;
            canvas.height = 48;
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            const deletes = [];
            const mockFetch = async (url, options = {}) => {
                const body = options.body ? JSON.parse(options.body) : {};
                if (url === '/api/files/upload') {
                    return { ok: true, status: 200, json: async () => ({ path: `/user/files/${body.name}` }) };
                }
                if (url === '/api/files/delete') {
                    deletes.push(body.path);
                    return { ok: true, status: 200 };
                }
                return { ok: false, status: 404 };
            };

            let state = {
                enabled: true,
                references: [{ path: '/user/files/sb-nai-ref-1111111111111111.png', bytes: 100, type: 'style', strength: 0.5, fidelity: 0.5 }],
            };
            const container = document.createElement('div');
            document.body.append(container);
            mountNovelAIPreciseReferenceEditor(container, {
                id: 'guard_precise_reference_enabled',
                getState: () => state,
                onChange: next => { state = structuredClone(next); },
                getModel: () => 'nai-diffusion-4-5-full',
                getRequestHeaders: () => ({}),
                fetchFn: mockFetch,
            });
            const controls = () => [...container.querySelectorAll('input, select, button')];
            const describe = control => control.getAttribute('aria-label') || control.textContent || `${control.localName}[${control.type}]`;

            const upload = container.querySelector('input[type="file"]');
            const files = new DataTransfer();
            files.items.add(new File([blob], 'reference.png', { type: 'image/png' }));
            upload.files = files.files;
            upload.dispatchEvent(new Event('change'));
            const enabledWhilePreparing = controls().filter(control => !control.disabled).map(describe);

            // Replace host reference list while preparation is in flight.
            state = {
                enabled: true,
                references: [{ path: '/user/files/sb-nai-ref-2222222222222222.png', bytes: 100, type: 'character', strength: 1, fidelity: 1 }],
            };

            const addButton = () => container.querySelector('[data-sb-editor-field="novelai-precise-reference-add"]');
            const deadline = Date.now() + 10_000;
            while (addButton().disabled && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            const alert = container.querySelector('[role="alert"]')?.textContent ?? null;
            container.remove();
            return {
                enabledWhilePreparing,
                references: state.references.map(reference => reference.path),
                alert,
                deletedCount: deletes.length,
            };
        });

        expect(result.enabledWhilePreparing).toEqual([]);
        expect(result.references).toEqual(['/user/files/sb-nai-ref-2222222222222222.png']);
        expect(result.alert).toBe('The images were not added because the references changed while they were prepared. Add them again.');
        expect(result.deletedCount).toBe(1);
    });
});
