/* global document, localStorage */
import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';

const MESSAGE_ID = 9876;

async function installMarkedCardScriptMessage(page, scriptHtml) {
    await page.evaluate(async ({ messageId, html }) => {
        const { rememberCardScript } = await import('/scripts/card-script-detection.js');
        const { power_user } = await import('/scripts/power-user.js');
        const runtime = await import('/scripts/card-script-runtime.js');

        power_user.allow_card_scripts = true;
        localStorage.setItem(runtime.CARD_SCRIPT_CONFIRMATION_STORAGE_KEY, 'true');

        const appChat = document.querySelector('#chat:not([data-card-script-e2e="true"])');
        if (appChat) {
            appChat.id = 'chat-e2e-original';
        }

        let chat = document.querySelector('#chat[data-card-script-e2e="true"]');
        if (!chat) {
            chat = document.createElement('div');
            chat.id = 'chat';
            chat.dataset.cardScriptE2e = 'true';
            document.body.appendChild(chat);
        }
        chat.style.display = 'block';
        chat.style.visibility = 'visible';
        chat.style.position = 'fixed';
        chat.style.left = '16px';
        chat.style.top = '16px';
        chat.style.zIndex = '10000';

        const existingMessage = chat.querySelector(`.mes[mesid="${messageId}"]`);
        existingMessage?.remove();

        const message = document.createElement('div');
        message.className = 'mes';
        message.setAttribute('mesid', String(messageId));
        message.innerHTML = `
            <div class="mes_block">
                <div class="mes_buttons">
                    <div class="extraMesButtons" style="display: flex;">
                        <div title="Run card scripts" class="mes_button mes_run_card_scripts fa-solid fa-play" style="display: none;"></div>
                    </div>
                </div>
                <div class="mes_text">
                    <custom-card-script-marker data-msg-id="${messageId}"></custom-card-script-marker>
                </div>
            </div>
        `;

        chat.appendChild(message);
        rememberCardScript(messageId, html);
        await runtime.syncCardScriptButtonForMessage(messageId);
    }, { messageId: MESSAGE_ID, html: scriptHtml });
}

test.describe('card script sandbox runtime', () => {
    test.beforeEach(async ({ page }) => {
        // A fresh data root stalls startup on the first-run onboarding prompt; APP_READY means
        // no startup popup is waiting to intercept clicks on the injected message buttons.
        await page.goto('/');
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
        await testSetup.waitForAppReady({ page });
    });

    test('shows the opt-in run button and creates a locked iframe sandbox', async ({ page }) => {
        await installMarkedCardScriptMessage(page, '<script>window.triggerSlash("/echo sandbox e2e")</script>');

        const runButton = page.locator(`.mes[mesid="${MESSAGE_ID}"] .mes_run_card_scripts`);
        await expect(runButton).toBeVisible();

        await runButton.click();

        const sandbox = page.locator(`.mes[mesid="${MESSAGE_ID}"] iframe.card-script-sandbox-frame`);
        await expect(sandbox).toHaveAttribute('sandbox', 'allow-scripts');
        await expect(sandbox).not.toHaveAttribute('sandbox', /allow-same-origin/);
        await expect(runButton).toHaveClass(/script-running/);
    });

    test('rejects blocked slash commands from the sandbox bridge', async ({ page }) => {
        await installMarkedCardScriptMessage(page, '<script></script>');

        const result = await page.evaluate(async (messageId) => {
            const { MESSAGE_TYPE, MESSAGE_VERSION } = await import('/scripts/card-script-sandbox/messages.js');
            const runtime = await import('/scripts/card-script-runtime.js');
            const sandbox = await runtime.createSandbox(messageId);

            return runtime.handleSandboxMessage({
                source: sandbox.iframeWindow,
                data: {
                    type: MESSAGE_TYPE,
                    version: MESSAGE_VERSION,
                    messageId,
                    nonce: sandbox.nonce,
                    command: '/delchat',
                },
            });
        }, MESSAGE_ID);

        expect(result).toEqual({ ok: false, reason: 'command_not_allowed' });
    });
});
