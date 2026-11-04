import { expect, test } from '@playwright/test';
import { installSyntheticLongChat, openReadyChat } from './chat-scroll-regression-helpers.js';

async function submitChatInput(page) {
    const simpleSendButton = page.locator('#gg_simple_send_button');
    if (await simpleSendButton.isVisible().catch(() => false)) {
        await simpleSendButton.click();
        return;
    }

    await page.locator('#send_textarea').press('Enter');
}

test.describe('chat send scroll', () => {
    test('scrolls to the latest user message immediately after send', async ({ page }) => {
        await openReadyChat(page, { chatSaveDelayMs: 1200 });

        await installSyntheticLongChat(page, { messageCount: 12 });

        const messageText = `scroll regression ${Date.now()}`;
        await page.locator('#send_textarea').fill(messageText);
        await submitChatInput(page);

        const scrolledToSentMessage = await page.waitForFunction((expectedText) => {
            const chatElement = document.querySelector('#chat');
            const sentMessage = Array.from(chatElement.querySelectorAll('.mes[is_user="true"]'))
                .find(message => message.textContent.includes(expectedText));

            if (!sentMessage) {
                return false;
            }

            const chatRect = chatElement.getBoundingClientRect();
            const messageRect = sentMessage.getBoundingClientRect();
            const bottomDelta = chatElement.scrollHeight - chatElement.clientHeight - chatElement.scrollTop;

            return messageRect.bottom <= chatRect.bottom + 4 && bottomDelta <= 12;
        }, messageText, { timeout: 1000 });

        expect(await scrolledToSentMessage.jsonValue()).toBe(true);
    });
});
