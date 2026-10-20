import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { applyLibadwaitaTheme } from './helpers/libadwaita-theme.js';

// Server-independent: the fixture origin serves files from public/ only.
const publicRoot = path.resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const SECRET = { savedText: '✔️ Key saved', missingText: '❌ Missing key', revealLabel: 'Show Key' };

async function mountRows(page, { fontSize } = {}) {
    await page.route('http://rows.test/**', route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/scripts/i18n.js') return route.fulfill({
            contentType: 'text/javascript',
            body: 'export const t = (s, ...v) => s.reduce((out, text, i) => out + text + (v[i] ?? ""), ""); export const translate = text => text;',
        });
        if (pathname === '/') {
            return route.fulfill({
                contentType: 'text/html',
                body: '<!doctype html><html><head>'
                    + '<link rel="stylesheet" href="/css/fontawesome.min.css">'
                    + '<link rel="stylesheet" href="/css/solid.min.css">'
                    + '<link rel="stylesheet" href="/style.css">'
                    + '<link rel="stylesheet" href="/css/sillybunny-theme.css">'
                    + '<link rel="stylesheet" href="/css/sillybunny-tabs.css">'
                    + '<link rel="stylesheet" href="/css/sillybunny-editor-shell.css">'
                    + '<link rel="stylesheet" href="/css/sillybunny-message-actions.css">'
                    + (fontSize ? `<style>:root { --mainFontSize: ${fontSize}; }</style>` : '')
                    + '</head><body><main style="padding: 16px; max-width: 640px"><div class="ds-pref-group" id="group"></div></main></body></html>',
            });
        }
        const filePath = path.resolve(publicRoot, `.${pathname}`);
        if (!filePath.startsWith(`${publicRoot}${path.sep}`)) return route.abort();
        const contentType = pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.woff2') ? 'font/woff2' : 'text/javascript';
        return route.fulfill({ path: filePath, contentType });
    });
    await page.goto('http://rows.test/');
    await applyLibadwaitaTheme(page);
    await page.evaluate(async secret => {
        const { createEntryRow } = await import('/scripts/sillybunny-editor/rows.js');
        const group = document.getElementById('group');
        const keyInput = document.createElement('input');
        keyInput.id = 'api_key_fixture';
        keyInput.type = 'text';
        keyInput.className = 'text_pole';
        keyInput.placeholder = '❌ Missing key';
        const rows = [
            createEntryRow({ label: 'Empty Field', field: 'empty', id: 'empty', floating: true, placeholder: 'Example placeholder' }),
            createEntryRow({ label: 'Filled Field', field: 'filled', id: 'filled', floating: true, value: 'A value' }),
            createEntryRow({ label: 'Programmatic Field', field: 'programmatic', id: 'programmatic', floating: true }),
            createEntryRow({ label: 'A Very Long Title That Has To Truncate At Narrow Widths Without Wrapping Onto Another Line', field: 'long', id: 'long', floating: true, subtitle: 'Helpful caption under the field' }),
            createEntryRow({ label: 'API Key', field: 'key', floating: true, secret, input: keyInput }),
        ];
        group.append(...rows.map(row => row.row));
    }, SECRET);
}

test('q56 select and profile row owners toggle on pointer and keyboard without focusout reopening', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mountRows(page);
    await page.evaluate(async () => {
        const { createSelectRow, createProfileRow } = await import('/scripts/sillybunny-editor/select-row.js');
        const { openActionMenu } = await import('/scripts/sillybunny-action-menu.js');
        document.querySelector('main').tabIndex = -1;
        window.q56Changes = 0;
        for (const kind of ['single', 'multiple', 'profile']) {
            const select = document.createElement('select');
            select.multiple = kind === 'multiple';
            select.append(new Option('First', 'first', true, true), new Option('Second', 'second'));
            select.addEventListener('change', () => window.q56Changes++);
            const create = kind === 'profile' ? createProfileRow : createSelectRow;
            const view = create({ select, label: kind, field: `q56-${kind}`, menuLabel: 'Profile menu',
                onMenu: trigger => openActionMenu({ trigger, sections: [{ items: [{ label: 'Profile action', onSelect() {} }] }] }),
            });
            document.querySelector('#group').append(view.row);
        }
    });
    for (const kind of ['single', 'multiple', 'profile']) {
        const row = page.locator(`[data-sb-editor-field="q56-${kind}"]`);
        const trigger = row.locator('.ds-select-row__trigger');
        for (const target of [trigger, trigger.locator('span'), trigger.locator('i'), row.locator('.ds-row-label')]) {
            await target.click();
            await expect(trigger).toHaveAttribute('aria-expanded', 'true');
            await target.click();
            await expect(trigger).toHaveAttribute('aria-expanded', 'false');
        }
        for (const key of ['Enter', 'Space']) {
            await trigger.press(key);
            await expect(trigger).toHaveAttribute('aria-expanded', 'true');
            await trigger.press(key);
            await expect(trigger).toHaveAttribute('aria-expanded', 'false');
        }
        await trigger.press('ArrowDown');
        await expect(page.getByRole('combobox')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(trigger).toBeFocused();
        expect(await page.evaluate(async () => (await import('/scripts/sillybunny-editor/picker.js')).isPickerOpen())).toBe(false);
    }
    const menu = page.getByRole('button', { name: 'Profile menu', exact: true });
    await menu.click();
    expect(await menu.evaluate(async node => (await import('/scripts/sillybunny-action-menu.js')).isActionMenuOpen(node))).toBe(true);
    await menu.click();
    expect(await menu.evaluate(async node => (await import('/scripts/sillybunny-action-menu.js')).isActionMenuOpen(node))).toBe(false);
    expect(await page.evaluate(() => window.q56Changes)).toBe(0);
});

function geometry(page, id) {
    return page.locator(`#${id}`).evaluate(input => {
        const field = input.closest('.ds-row-entry__field').getBoundingClientRect();
        const title = input.labels[0];
        const box = title.getBoundingClientRect();
        return {
            fieldTop: field.top,
            fieldCenter: field.top + field.height / 2,
            titleTop: box.top,
            titleBottom: box.bottom,
            titleCenter: box.top + box.height / 2,
            titleFont: parseFloat(getComputedStyle(title).fontSize),
            inputFont: parseFloat(getComputedStyle(input).fontSize),
            placeholderColor: getComputedStyle(input, '::placeholder').color,
            titleLineHeight: parseFloat(getComputedStyle(title).lineHeight) || parseFloat(getComputedStyle(title).fontSize) * 1.3,
            titleHeight: box.height,
        };
    });
}

const isFloated = g => g.titleTop - g.fieldTop < 12 && g.titleFont < g.inputFont;
const isResting = g => Math.abs(g.titleCenter - g.fieldCenter) <= 3 && g.titleFont === g.inputFont;

for (const width of [1440, 360]) {
    test.describe(`floating entry row at ${width}px`, () => {
        test.use({ viewport: { width, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });

        test('rests in the field when empty and floats on focus, on a typed value and on a programmatic value', async ({ page }) => {
            await mountRows(page);
            const empty = await geometry(page, 'empty');
            expect(isResting(empty)).toBe(true);
            expect(empty.placeholderColor).toBe('rgba(0, 0, 0, 0)');

            await page.locator('#empty').focus();
            const focused = await geometry(page, 'empty');
            expect(isFloated(focused)).toBe(true);
            expect(focused.placeholderColor).not.toBe('rgba(0, 0, 0, 0)');

            expect(isFloated(await geometry(page, 'filled'))).toBe(true);

            await page.locator('#programmatic').evaluate(input => { input.value = 'Set by code'; });
            expect(isFloated(await geometry(page, 'programmatic'))).toBe(true);
        });

        test('draws the field as a filled entry and shows one focus ring, on the field', async ({ page }) => {
            await mountRows(page);
            const rest = await page.locator('#empty').evaluate(input => {
                const style = getComputedStyle(input);
                return { background: style.backgroundColor, radius: parseFloat(style.borderTopLeftRadius) };
            });
            expect(rest.background).not.toBe('rgba(0, 0, 0, 0)');
            expect(rest.radius).toBeGreaterThan(0);
            await page.keyboard.press('Tab');
            await expect(page.locator('#empty')).toBeFocused();
            const rings = await page.locator('#empty').evaluate(input => ({
                row: getComputedStyle(input.closest('.ds-row')).boxShadow,
                input: getComputedStyle(input).boxShadow,
                outline: getComputedStyle(input).outlineStyle,
            }));
            expect(rings.row).toBe('none');
            expect(rings.input).not.toBe('none');
            expect(rings.outline).toBe('none');
        });

        test('long titles stay on one line and nothing overflows', async ({ page }) => {
            await mountRows(page);
            const long = await geometry(page, 'long');
            expect(long.titleHeight).toBeLessThanOrEqual(long.titleLineHeight + 2);
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            expect(overflow).toBeLessThanOrEqual(0);
        });

        test('at 200% text the floated title stays clear of the value and nothing overflows', async ({ page }) => {
            await mountRows(page, { fontSize: '30px' });
            const filled = await page.locator('#filled').evaluate(input => {
                const title = input.labels[0].getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(input);
                const style = getComputedStyle(input);
                const valueTop = input.getBoundingClientRect().top + parseFloat(style.paddingTop);
                return { titleBottom: title.bottom, valueTop, rowHeight: input.closest('.ds-row').getBoundingClientRect().height };
            });
            expect(filled.titleBottom).toBeLessThanOrEqual(filled.valueTop + 1);
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            expect(overflow).toBeLessThanOrEqual(0);
        });
    });
}

test.describe('floating entry row under forced colours', () => {
    test.use({ viewport: { width: 1024, height: 800 }, contextOptions: { forcedColors: 'active', reducedMotion: 'reduce' } });

    test('keeps a visible focus indicator and a key status with text', async ({ page }) => {
        await mountRows(page);
        await page.keyboard.press('Tab');
        const outline = await page.locator('#empty').evaluate(input => getComputedStyle(input).outlineStyle);
        expect(outline).toBe('solid');
        const status = page.locator('.ds-row-entry__status');
        await expect(status).toHaveAttribute('data-state', 'missing');
        await expect(status.locator('.sr-only')).toHaveText('❌ Missing key');
        await expect(status.locator('i')).toBeVisible();
    });
});

for (const browserName of ['chromium', 'firefox', 'webkit']) {
    // browserName cannot be set per describe group; launch each engine from the playwright fixture instead.
    test(`secret entry row in ${browserName} masks with a reveal toggle where supported, otherwise leaves the text field as it is`, async ({ playwright }) => {
        let browser;
        try {
            browser = await playwright[browserName].launch();
        } catch (error) {
            // Some hosts lack an engine's system libraries (WebKit on non-Ubuntu Linux); check Safari on a device instead.
            test.skip(/missing dependencies/i.test(String(error)), `${browserName} cannot launch on this host`);
            throw error;
        }
        try {
            const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
            await mountRows(page);
            const supported = await page.evaluate(() => CSS.supports('-webkit-text-security', 'disc'));
            test.info().annotations.push({ type: 'text-security', description: `${browserName}: ${supported}` });
            const key = page.locator('#api_key_fixture');
            await expect(key).toHaveAttribute('type', 'text');
            const reveal = page.locator('.ds-row-entry__reveal');
            if (!supported) {
                await expect(reveal).toHaveCount(0);
                return;
            }
            const masking = () => key.evaluate(input => getComputedStyle(input).getPropertyValue('-webkit-text-security'));
            expect(await masking()).toBe('disc');
            await reveal.click();
            await expect(reveal).toHaveAttribute('aria-pressed', 'true');
            expect(await masking()).toBe('none');
        } finally {
            await browser.close();
        }
    });
}
