import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { dismissOnboardingIfPresent } from './chat-scroll-regression-helpers.js';
import { testSetup } from './frontend/frontent-test-utils.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readBundledTheme = name => JSON.parse(readFileSync(path.join(repoRoot, 'default', 'content', 'themes', `${name}.json`), 'utf8'));
const bundledThemes = ['Libadwaita', 'Libadwaita Light'].map(readBundledTheme);
// A bundled theme whose chat tint stores 0.05 alpha, as most bundled themes do.
const lowAlphaTheme = readBundledTheme('Cinder');
// A Libadwaita copy whose chat tint differs from its message tints, the two-tone report shape.
const mismatchedTheme = { ...bundledThemes[0], name: 'Two Tone Probe', chat_tint_color: 'rgba(0, 0, 0, 0.35)' };
const READ_ONLY_POST_ENDPOINTS = new Set([
    '/api/characters/all', '/api/characters/chats', '/api/characters/get', '/api/chats/get', '/api/groups/all',
    '/api/backgrounds/all', '/api/avatars/get', '/api/stats/get', '/api/secrets/read', '/api/users/me',
    '/api/settings/get', '/api/themes/get',
]);
const CHAT_DISPLAY = { default: 0, bubbles: 1 };
const BOT_BLOCK = '#chat .mes:not(.smallSysMes):not([is_user="true"]) .mes_block';
const USER_BLOCK = '#chat .mes[is_user="true"]:not(.smallSysMes) .mes_block';
// The bundled Libadwaita tints store 0.9 as their opaque level; the desktop column maps alpha through it.
const OPAQUE_TINT_ALPHA = 0.9;

// Only computed colors are read, so no motion setting is needed.
test.use({ viewport: { width: 1920, height: 1080 }, serviceWorkers: 'block' });

/** Read the engine's relative-color alpha precision from a literal theme tint. */
async function readResolvedTintAlpha(page, tint) {
    const color = await page.evaluate(value => {
        const probe = document.createElement('span');
        probe.style.backgroundColor = `color(from ${value} srgb r g b / alpha)`;
        document.body.append(probe);
        const result = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return result;
    }, tint);
    return parseColor(color).a;
}

/** The stylesheet formula for the desktop column: min(1, tint alpha / 0.9) times the slider's overlay opacity. */
function expectedColumnAlpha(tintAlpha, overlayOpacity) {
    return Math.min(1, tintAlpha / OPAQUE_TINT_ALPHA) * overlayOpacity;
}

/** Parse a computed color in rgb(), rgba() or color(srgb ...) form into 0-255 channels and alpha. */
function parseColor(value) {
    const srgb = value.match(/^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/);
    if (srgb) {
        return {
            r: Math.round(Number(srgb[1]) * 255),
            g: Math.round(Number(srgb[2]) * 255),
            b: Math.round(Number(srgb[3]) * 255),
            a: srgb[4] === undefined ? 1 : Number(srgb[4]),
        };
    }
    const rgb = value.match(/^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/);
    if (rgb) {
        return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] === undefined ? 1 : Number(rgb[4]) };
    }
    throw new Error(`Unrecognized color: ${value}`);
}

async function interceptWrites(page) {
    let settingsVersion = Date.now();
    await page.route('**/api/**', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === '/api/settings/get') {
            const response = await route.fetch();
            const data = await response.json();
            const settings = JSON.parse(data.settings);
            settings.firstRun = false;
            settings._version ??= settingsVersion;
            settings.extension_settings ??= {};
            settings.extension_settings['quick-image-gen'] = { ...settings.extension_settings['quick-image-gen'], setupWizardSeen: true };
            data.request_compression = { ...data.request_compression, enabled: false };
            data.settings = JSON.stringify(settings);
            return route.fulfill({ response, json: data });
        }
        if (url.pathname === '/api/settings/save') {
            settingsVersion += 1;
            return route.fulfill({ json: { result: 'ok', version: settingsVersion } });
        }
        if (READ_ONLY_POST_ENDPOINTS.has(url.pathname) || url.pathname.startsWith('/api/tokenizers/')) {
            return route.continue();
        }
        const isWriteMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method());
        const isWriteEndpoint = /^\/api\/.*\/(save|delete|create|edit|rename|update|import|upload|restore|duplicate|write|set)(?:\/|$)/i.test(url.pathname);
        if (isWriteMethod || isWriteEndpoint) {
            return route.fulfill({ json: {} });
        }
        return route.continue();
    });
    await page.route('**/api/savesettings**', route => route.fulfill({ json: { result: 'ok' } }));
}

async function openCharacterChat(page) {
    await page.evaluate(async () => {
        const context = SillyTavern.getContext();
        const index = Math.max(0, context.characters.findIndex(character => character.name === 'Seraphina'));
        await context.selectCharacterById(index);
    });
    await expect(page.locator('#chat .mes:not(.smallSysMes)').first()).toBeVisible();
}

/** Append a user turn through the chat thread so the user card rule can be read; nothing is saved. */
async function appendUserMessage(page) {
    await page.evaluate(() => {
        const context = SillyTavern.getContext();
        const message = {
            name: 'Transparency Tester',
            is_user: true,
            is_system: false,
            send_date: new Date().toISOString(),
            mes: 'A user turn, so the user card tint can be read.',
            extra: {},
        };
        context.chat.push(message);
        context.addOneMessage(message, { forceId: context.chat.length - 1, scroll: false, showSwipes: false });
    });
    await expect(page.locator(USER_BLOCK).first()).toBeVisible();
}

async function selectTheme(page, name) {
    await page.evaluate(themeName => {
        const select = document.getElementById('themes');
        select.value = themeName;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }, name);
    await page.waitForFunction(themeName => SillyTavern.getContext().powerUserSettings.theme === themeName, name);
}

async function importTheme(page, theme) {
    await page.locator('#ui_preset_import_file').setInputFiles({
        name: `${theme.name}.json`,
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(theme)),
    });
    await page.waitForFunction(themeName => SillyTavern.getContext().powerUserSettings.theme === themeName, theme.name);
}

async function setChatDisplay(page, value) {
    await page.evaluate(next => {
        const select = document.getElementById('chat_display');
        select.value = String(next);
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
}

async function setBackgroundVisibility(page, value) {
    await page.evaluate(next => window.SillyBunnyShell.setSurfaceTransparency(next), value);
    await page.waitForFunction(next => window.SillyBunnyShell.getSurfaceTransparency() === next, value);
}

/** Read one of the slider's root opacity tokens as a number. */
async function readRootOpacity(page, token) {
    return page.evaluate(name => Number(getComputedStyle(document.documentElement).getPropertyValue(name)), token);
}

async function readChatColor(page) {
    return parseColor(await page.locator('#chat').evaluate(chat => getComputedStyle(chat).backgroundColor));
}

async function readBlockColor(page, selector) {
    return parseColor(await page.locator(selector).first().evaluate(block => getComputedStyle(block).backgroundColor));
}

test.describe('desktop chat column transparency', () => {
    test.beforeEach(async ({ page }) => {
        await interceptWrites(page);
        await testSetup.awaitST({ page });
        await dismissOnboardingIfPresent(page);
        await page.getByRole('button', { name: 'Close dialog', exact: true }).click({ timeout: 1000 }).catch(() => {});
        await openCharacterChat(page);
        await appendUserMessage(page);
        await setChatDisplay(page, CHAT_DISPLAY.default);
        await setBackgroundVisibility(page, 0);
    });

    test('keeps the bundled Libadwaita column colors unchanged at the default slider value', async ({ page }) => {
        for (const theme of bundledThemes) {
            await selectTheme(page, theme.name);
            const tint = parseColor(theme.chat_tint_color);
            // The bundled tints carry 0.9 alpha; the column stays the opaque view it was before the fix.
            expect(await readChatColor(page), theme.name).toEqual({ r: tint.r, g: tint.g, b: tint.b, a: 1 });
        }
    });

    test('shows the background through a bundled low-alpha column (Cinder) at the formula alpha', async ({ page }) => {
        await selectTheme(page, lowAlphaTheme.name);
        const tint = parseColor(lowAlphaTheme.chat_tint_color);
        const tintAlpha = await readResolvedTintAlpha(page, lowAlphaTheme.chat_tint_color);
        const botTint = parseColor(lowAlphaTheme.bot_mes_blur_tint_color);
        const userTint = parseColor(lowAlphaTheme.user_mes_blur_tint_color);
        expect(tint.a).toBeLessThan(OPAQUE_TINT_ALPHA);

        // The overlay opacity is 1 at slider 0, so the column shows the background at 0.05 / 0.9.
        const column = await readChatColor(page);
        expect([column.r, column.g, column.b]).toEqual([tint.r, tint.g, tint.b]);
        expect(column.a).toBeCloseTo(expectedColumnAlpha(tintAlpha, await readRootOpacity(page, '--sb-page-overlay-opacity')), 3);
        expect(column.a).toBeLessThan(0.1);

        // The cards keep their own tints: the AI and user cards differ by their theme colors.
        const botBlock = await readBlockColor(page, BOT_BLOCK);
        const userBlock = await readBlockColor(page, USER_BLOCK);
        expect([botBlock.r, botBlock.g, botBlock.b]).toEqual([botTint.r, botTint.g, botTint.b]);
        expect([userBlock.r, userBlock.g, userBlock.b]).toEqual([userTint.r, userTint.g, userTint.b]);
        expect(botBlock.a).toBeCloseTo(botTint.a, 1);
        expect(userBlock.a).toBeCloseTo(userTint.a, 1);

        await setBackgroundVisibility(page, 100);
        expect((await readChatColor(page)).a).toBeCloseTo(expectedColumnAlpha(tintAlpha, await readRootOpacity(page, '--sb-page-overlay-opacity')), 3);
    });

    test('respects a chat tint alpha below 1 on the desktop column while cards keep their tints', async ({ page }) => {
        await importTheme(page, mismatchedTheme);
        const column = await readChatColor(page);
        expect([column.r, column.g, column.b]).toEqual([0, 0, 0]);
        expect(column.a).toBeLessThan(1);
        expect(column.a).toBeCloseTo(0.35 / 0.9, 1);
        expect((await readBlockColor(page, BOT_BLOCK)).a).toBeCloseTo(0.9, 1);
        expect((await readBlockColor(page, USER_BLOCK)).a).toBeCloseTo(0.9, 1);

        await setChatDisplay(page, CHAT_DISPLAY.bubbles);
        expect((await readChatColor(page)).a).toBeCloseTo(0.35 / 0.9, 1);
    });

    test('fades the column together with the AI and user cards as Background Visibility rises', async ({ page }) => {
        await importTheme(page, mismatchedTheme);
        await setChatDisplay(page, CHAT_DISPLAY.bubbles);
        const at0 = (await readChatColor(page)).a;
        await setBackgroundVisibility(page, 50);
        const at50 = (await readChatColor(page)).a;
        await setBackgroundVisibility(page, 100);
        const at100 = (await readChatColor(page)).a;
        expect(at50).toBeLessThan(at0);
        expect(at100).toBeLessThan(at50);
        expect(at100).toBeLessThan(0.1);

        // Default cards paint their tint on the text block; on desktop both card rules follow the slider.
        await setChatDisplay(page, CHAT_DISPLAY.default);
        const cardOpacity = await readRootOpacity(page, '--sb-page-card-opacity');
        expect(cardOpacity).toBeLessThan(0.2);
        const botAlpha = await readResolvedTintAlpha(page, mismatchedTheme.bot_mes_blur_tint_color);
        const userAlpha = await readResolvedTintAlpha(page, mismatchedTheme.user_mes_blur_tint_color);
        expect((await readBlockColor(page, BOT_BLOCK)).a).toBeCloseTo(botAlpha * cardOpacity, 2);
        expect((await readBlockColor(page, USER_BLOCK)).a).toBeCloseTo(userAlpha * cardOpacity, 2);

        // The bundled theme follows the slider and returns to the opaque view at the default value.
        await selectTheme(page, bundledThemes[0].name);
        expect((await readChatColor(page)).a).toBeLessThan(0.2);
        await setBackgroundVisibility(page, 0);
        expect((await readChatColor(page)).a).toBe(1);
        expect((await readBlockColor(page, BOT_BLOCK)).a).toBeCloseTo(0.9, 1);
        expect((await readBlockColor(page, USER_BLOCK)).a).toBeCloseTo(0.9, 1);
    });
});
