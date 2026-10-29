import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = file => readFileSync(path.join(repoRoot, file), 'utf8');
const composerStyles = [
    'public/style.css',
    'public/css/mobile-styles.css',
    'public/css/sillybunny-theme.css',
    'public/css/sillybunny-tabs.css',
    'public/css/sillybunny-mobile-shell.css',
    'public/css/sillybunny-mobile-navigation.css',
].map(readSource);
const statusSource = readSource('public/scripts/RossAscends-mods.js');
const checkOnlineStatus = statusSource.slice(
    statusSource.indexOf('function RA_checkOnlineStatus()'),
    statusSource.indexOf('//Auto-connect to API'),
);
const mainSource = readSource('public/script.js');
const bindSendButton = mainSource.slice(
    mainSource.indexOf('    const sendButtonElement = document.getElementById(\'send_but\');'),
    mainSource.indexOf('    //menu buttons setup'),
);
const activateSendButtonsStart = mainSource.indexOf('export function activateSendButtons(');
const activateSendButtonsSource = mainSource.slice(
    activateSendButtonsStart,
    mainSource.indexOf('\n}', activateSendButtonsStart) + 2,
).replace(/^export /, '');
const keyboardSource = readSource('public/scripts/keyboard.js').replace(/^export /gm, '');
const mobileSendSource = readSource('public/scripts/mobile-send-button.js').replace(/^export /gm, '');

async function renderComposer(page, width, { isIOS = false } = {}) {
    await page.setViewportSize({ width, height: 844 });
    await page.setContent(`
        <!doctype html>
        <html lang="en" ${width <= 768 ? 'data-sb-mobile-ui="true" data-sb-mobile-ui-mode="mobile"' : ''}>
            <body class="no-blur">
                <main id="sheld">
                    <div id="chat"></div>
                    <div id="form_sheld">
                        <div id="sb-bottom-chat-bar" class="displayNone"></div>
                        <div id="send_form" class="no-connection">
                            <div id="nonQRFormItems">
                                <div id="leftSendForm">
                                    <div id="options_button" class="fa-solid fa-bars interactable"></div>
                                </div>
                                <textarea id="send_textarea" placeholder="Not connected to API!" no_connection_text="Not connected to API!" connected_text="Type a message, or /? for help"></textarea>
                                <div id="rightSendForm">
                                    <div id="mes_stop" class="mes_stop" title="Abort request"><i class="fa-solid fa-circle-stop"></i></div>
                                    <div id="qig-input-btn" class="fa-solid fa-palette interactable" aria-label="Quick Image generation"></div>
                                    <div id="send_but" class="fa-solid fa-paper-plane interactable displayNone" title="Send a message"></div>
                                </div>
                            </div>
                            <div id="gg-action-button-container" hidden>
                                <button class="gg-action-button">Guided generation action</button>
                            </div>
                        </div>
                    </div>
                </main>
            </body>
        </html>
    `);

    for (const content of composerStyles) {
        await page.addStyleTag({ content });
    }

    await page.addScriptTag({ path: path.join(repoRoot, 'public/lib/jquery-3.5.1.min.js') });
    // Exercise production status, keyboard and button binding; only the downstream send action is a stand-in.
    await page.addScriptTag({ content: `
        let online_status = 'no_connection';
        let is_send_press = false;
        let selected_group = null;
        let is_group_generating = false;
        let connection_made = false;
        let retry_delay = 500;
        const isIOSFocusSensitiveBrowser = ${JSON.stringify(isIOS)};
        const resolveGenerationUiLockState = () => ({ shouldShowStopButton: false, shouldHideSwipeButtons: false, bodyGeneratingValue: null });
        const hideStopButton = () => document.getElementById('send_form').classList.remove('sb-generating-controls');
        const showSwipeButtons = () => {};
        const userInputGenerateMutex = {
            async update() {
                const textarea = document.getElementById('send_textarea');
                const message = document.createElement('div');
                message.className = 'mes';
                message.textContent = textarea.value;
                document.getElementById('chat').append(message);
                textarea.value = '';
            },
        };
        ${checkOnlineStatus}
        ${keyboardSource}
        ${mobileSendSource}
        ${bindSendButton}
        ${activateSendButtonsSource}
        initKeyboard();
        window.setComposerState = ({ connected = false, generating = false, groupGenerating = false, showStop = generating, refreshStatus = true } = {}) => {
            online_status = connected ? 'connected' : 'no_connection';
            is_send_press = generating;
            selected_group = groupGenerating ? 'group' : null;
            is_group_generating = groupGenerating;
            document.getElementById('send_form').classList.toggle('sb-generating-controls', showStop);
            if (refreshStatus) RA_checkOnlineStatus();
        };
        window.endComposerGeneration = () => {
            is_group_generating = false;
            activateSendButtons({ emitGenerationEnded: false });
        };
        window.setComposerState();
    ` });
}

async function setComposerState(page, state) {
    await page.evaluate(value => window.setComposerState(value), state);
}

for (const width of [390, 1440]) {
    const minimumSendSize = width === 390 ? 44 : 30;

    test(`disconnected roleplay send control remains visible at ${width}px`, async ({ page }) => {
        await renderComposer(page, width);

        const send = page.locator('#send_but');
        const imageGeneration = page.locator('#qig-input-btn');

        await expect(send).toBeVisible();
        const sendBounds = await send.boundingBox();
        const imageGenerationBounds = await imageGeneration.boundingBox();
        expect(sendBounds).not.toBeNull();
        expect(imageGenerationBounds).not.toBeNull();
        expect(sendBounds.x - imageGenerationBounds.x - imageGenerationBounds.width).toBeGreaterThanOrEqual(0);
        expect(sendBounds.x - imageGenerationBounds.x - imageGenerationBounds.width).toBeLessThanOrEqual(4);
        expect(sendBounds.y).toBeCloseTo(imageGenerationBounds.y, 0);
        expect(sendBounds.x + sendBounds.width).toBeLessThanOrEqual(width);
        expect(sendBounds.width).toBeCloseTo(sendBounds.height, 0);
        expect(sendBounds.width).toBeGreaterThanOrEqual(minimumSendSize);
        await expect(page.locator('#mes_stop')).toBeHidden();
    });

    test(`offline roleplay send is disabled for mouse and keyboard at ${width}px`, async ({ page }) => {
        await renderComposer(page, width);
        const send = page.locator('#send_but');
        const textarea = page.locator('#send_textarea');
        await textarea.fill('Keep this draft');

        await expect(send).toHaveClass(/\bdisabled\b/);
        await expect(send).toHaveAttribute('aria-disabled', 'true');
        await expect(send).not.toHaveAttribute('tabindex');
        await expect(send).toHaveCSS('pointer-events', 'none');
        await expect(send).toHaveCSS('cursor', 'not-allowed');
        const bounds = await send.boundingBox();
        await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await send.dispatchEvent('keydown', { key: 'Enter', bubbles: true });
        await send.dispatchEvent('keydown', { key: ' ', bubbles: true });
        await expect(textarea).toHaveValue('Keep this draft');
        await expect(page.locator('#chat .mes')).toHaveCount(0);
    });

    test(`synthetic send activation cannot consume offline input at ${width}px`, async ({ page }) => {
        await renderComposer(page, width);
        for (const draft of ['Keep this draft', '/echo untouched']) {
            await page.locator('#send_textarea').fill(draft);
            await page.locator('#send_but').evaluate(element => element.click());
            await expect(page.locator('#send_textarea')).toHaveValue(draft);
            await expect(page.locator('#chat .mes')).toHaveCount(0);
        }

        await setComposerState(page, { connected: true });
        await expect(page.locator('#send_but')).toHaveAttribute('tabindex', '0');
        await setComposerState(page, { connected: false, refreshStatus: false });
        await page.locator('#send_but').click();
        await expect(page.locator('#send_textarea')).toHaveValue('/echo untouched');
        await expect(page.locator('#chat .mes')).toHaveCount(0);
    });

    test(`reconnection restores normal roleplay sending at ${width}px`, async ({ page }) => {
        await renderComposer(page, width);
        const send = page.locator('#send_but');
        const offlineBackground = await send.evaluate(element => getComputedStyle(element).backgroundColor);
        await setComposerState(page, { connected: true });

        await expect(send).toBeVisible();
        await expect(send).not.toHaveClass(/\bdisabled\b/);
        await expect(send).toHaveAttribute('aria-disabled', 'false');
        await expect(send).toHaveAttribute('tabindex', '0');
        await expect(send).toHaveCSS('pointer-events', 'auto');
        expect(await send.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(offlineBackground);
        await page.locator('#send_textarea').fill('Connected click');
        await send.click();
        await expect(page.locator('#chat .mes')).toHaveCount(1);
        await page.locator('#send_textarea').fill('Connected keyboard');
        await send.focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('#chat .mes')).toHaveCount(2);

        await page.locator('#send_textarea').fill('Disconnected while focused');
        await send.focus();
        await setComposerState(page, { connected: false });
        await expect(send).not.toHaveAttribute('tabindex');
        await page.keyboard.press('Enter');
        await expect(page.locator('#send_textarea')).toHaveValue('Disconnected while focused');
        await expect(page.locator('#chat .mes')).toHaveCount(2);
    });

    test(`iOS fast-tap cannot consume a draft after disconnection at ${width}px`, async ({ page }) => {
        await renderComposer(page, width, { isIOS: true });
        const send = page.locator('#send_but');
        await setComposerState(page, { connected: true });
        await page.locator('#send_textarea').fill('Keep the touch draft');
        await send.dispatchEvent('touchstart');
        await setComposerState(page, { connected: false, refreshStatus: false });
        await send.dispatchEvent('touchend');
        await send.evaluate(element => element.click());
        await expect(page.locator('#send_textarea')).toHaveValue('Keep the touch draft');
        await expect(page.locator('#chat .mes')).toHaveCount(0);

        await setComposerState(page, { connected: true });
        await send.dispatchEvent('touchstart');
        await send.dispatchEvent('touchend');
        await send.evaluate(element => element.click());
        await expect(page.locator('#chat .mes')).toHaveCount(1);
        await expect(page.locator('#send_textarea')).toHaveValue('');
    });

    test(`generation keeps roleplay Send hidden even offline at ${width}px`, async ({ page }) => {
        await renderComposer(page, width);
        for (const connected of [false, true]) {
            await setComposerState(page, { connected, generating: true });
            await expect(page.locator('#send_but')).toBeHidden();
            await expect(page.locator('#mes_stop')).toBeVisible();

            await setComposerState(page, { connected, generating: true, showStop: false });
            await expect(page.locator('#send_but')).toBeHidden();
            await setComposerState(page, { connected, groupGenerating: true, showStop: false });
            await expect(page.locator('#send_but')).toBeHidden();
        }

        await setComposerState(page, { connected: false, generating: true });
        await page.evaluate(() => window.endComposerGeneration());
        await expect(page.locator('#send_but')).toBeVisible();
        await expect(page.locator('#send_but')).toHaveAttribute('aria-disabled', 'true');
        await expect(page.locator('#mes_stop')).toBeHidden();
    });

    test(`composer has no stray divider when both optional bars are hidden at ${width}px`, async ({ page }) => {
        await renderComposer(page, width);

        const dividerWidth = await page.locator('#nonQRFormItems').evaluate(element => getComputedStyle(element).borderTopWidth);
        expect(dividerWidth).toBe('0px');

        await page.locator('#gg-action-button-container').evaluate(element => {
            element.hidden = false;
        });
        const dividerWithGuidedBar = await page.locator('#nonQRFormItems').evaluate(element => getComputedStyle(element).borderTopWidth);
        expect(dividerWithGuidedBar).toBe('1px');
    });
}
