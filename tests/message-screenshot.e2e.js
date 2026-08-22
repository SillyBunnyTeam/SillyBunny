/* global document, window */
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const APP_URL = process.env.SILLYBUNNY_TEST_BASE_URL || '/';

async function dismissOnboardingIfPresent(page) {
    const onboardingDialog = page.locator('dialog[open]:has(.onboarding)').first();

    if (await onboardingDialog.isVisible().catch(() => false)) {
        await onboardingDialog.locator('.popup-input').fill('Screenshot Tester');
        await onboardingDialog.locator('.popup-button-ok').click();
        await onboardingDialog.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    }
}

async function installScreenshotMessage(page, messageText) {
    await page.evaluate(async (text) => {
        const context = window.SillyTavern.getContext();
        const chatElement = document.querySelector('#chat');
        if (!chatElement) {
            throw new Error('Chat element not found');
        }

        context.chat.length = 0;
        chatElement.replaceChildren();

        const makeMessage = (name, isUser, mes) => ({
            name,
            is_user: isUser,
            is_system: false,
            send_date: new Date().toISOString(),
            mes,
            extra: {},
        });
        const messages = [
            makeMessage('Screenshot Tester', true, text),
            makeMessage('Screenshot Assistant', false, 'range companion message'),
        ];

        for (const message of messages) {
            context.chat.push(message);
            context.addOneMessage(message, { scroll: false });
        }

        const messageTextElement = document.querySelector('#chat .mes[mesid="0"] .mes_text');
        if (!messageTextElement) {
            throw new Error('Screenshot message text not found');
        }

        messageTextElement.style.color = 'oklch(70% 0.2 140)';
        messageTextElement.closest('.mes_block')?.style.setProperty('background-color', 'color(srgb 0.156863 0.164706 0.196078)', 'important');

        const gradientSpan = document.createElement('span');
        gradientSpan.style.display = 'inline-block';
        gradientSpan.style.backgroundImage = 'linear-gradient(90deg, color(display-p3 1 0 0), color(display-p3 0 0 1))';
        gradientSpan.style.backgroundRepeat = 'no-repeat';
        gradientSpan.style.backgroundSize = '100% 100%';
        gradientSpan.style.webkitBackgroundClip = 'text';
        gradientSpan.style.backgroundClip = 'text';
        gradientSpan.style.webkitTextFillColor = 'transparent';
        gradientSpan.textContent = text;
        messageTextElement.appendChild(gradientSpan);

        const assistantTextElement = document.querySelector('#chat .mes[mesid="1"] .mes_text');
        if (assistantTextElement) {
            assistantTextElement.style.color = 'lab(60% 20 -30)';
        }
    }, messageText);
}

async function readScreenshotPixelStats(page, download) {
    const downloadPath = await download.path();
    const imageData = await readFile(downloadPath);

    return await page.evaluate(async (source) => {
        const image = new window.Image();
        image.src = source;
        await image.decode();

        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);

        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let darkPixels = 0;
        let redPixels = 0;
        let bluePixels = 0;

        for (let index = 0; index < pixels.length; index += 4) {
            const red = pixels[index];
            const green = pixels[index + 1];
            const blue = pixels[index + 2];
            const alpha = pixels[index + 3];
            if (alpha > 200 && red >= 25 && red <= 60 && green >= 25 && green <= 65 && blue >= 30 && blue <= 75) {
                darkPixels++;
            }
            if (alpha > 200 && red > 170 && red > green * 1.4 && red > blue * 1.4) {
                redPixels++;
            }
            if (alpha > 200 && blue > 120 && blue > red * 1.4 && blue > green * 1.4) {
                bluePixels++;
            }
        }

        return { bluePixels, darkPixels, redPixels, totalPixels: canvas.width * canvas.height };
    }, `data:image/png;base64,${imageData.toString('base64')}`);
}

async function completeScreenshotExport(page, startId, endId) {
    await page.locator('#message_screenshot_start_id').fill(String(startId));
    await page.locator('#message_screenshot_end_id').fill(String(endId));

    const downloadPromise = page.waitForEvent('download', { timeout: 45000 });
    await page.locator('.message_screenshot_popup .popup-button-ok').dispatchEvent('click');
    return await downloadPromise;
}

async function exportScreenshotFromMessage(page, messageIndex, startId, endId) {
    await page.locator('#chat .mes').nth(messageIndex).locator('.mes_screenshot').dispatchEvent('click');
    return await completeScreenshotExport(page, startId, endId);
}

async function exportScreenshotFromWand(page, startId, endId) {
    await page.locator('#wand_message_screenshot').waitFor({ state: 'attached' });
    await page.locator('#wand_message_screenshot').dispatchEvent('click');
    return await completeScreenshotExport(page, startId, endId);
}

test.describe('message screenshots', () => {
    test.setTimeout(120000);

    test('exports message and wand screenshots with modern colors', async ({ page }) => {
        const screenshotErrors = [];
        page.on('console', message => {
            if (message.type() === 'error' && /screenshot|html2canvas|unsupported color/i.test(message.text())) {
                screenshotErrors.push(message.text());
            }
        });

        await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
        await dismissOnboardingIfPresent(page);
        await installScreenshotMessage(page, 'single screenshot oklch regression');

        const singleDownload = await exportScreenshotFromMessage(page, 0, 0, 0);
        expect(singleDownload.suggestedFilename()).toContain('message-0.png');
        const { bluePixels, darkPixels, redPixels, totalPixels } = await readScreenshotPixelStats(page, singleDownload);
        expect(darkPixels).toBeGreaterThan(totalPixels * 0.2);
        expect(redPixels).toBeGreaterThan(10);
        expect(bluePixels).toBeGreaterThan(10);
        expect(redPixels).toBeLessThan(totalPixels * 0.002);
        expect(bluePixels).toBeLessThan(totalPixels * 0.002);

        const rangeDownload = await exportScreenshotFromMessage(page, 0, 0, 1);
        expect(rangeDownload.suggestedFilename()).toContain('messages-0-1.png');

        const wandDownload = await exportScreenshotFromWand(page, 1, 1);
        expect(wandDownload.suggestedFilename()).toContain('message-1.png');

        expect(screenshotErrors).toEqual([]);
    });
});
