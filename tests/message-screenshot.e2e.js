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
        const messageElement = messageTextElement.closest('.mes');
        const messageBlock = messageTextElement.closest('.mes_block');
        if (!messageElement || !messageBlock) {
            throw new Error('Screenshot message layout not found');
        }

        messageElement.classList.add('message-screenshot-grid-probe', 'reasoning');
        messageBlock.style.setProperty('background-color', 'color(srgb 0.156863 0.164706 0.196078)', 'important');

        const reasoningDetails = document.createElement('details');
        reasoningDetails.className = 'mes_reasoning_details';
        reasoningDetails.open = true;
        const reasoningSummary = document.createElement('summary');
        reasoningSummary.className = 'mes_reasoning_summary flex-container';
        const reasoningHeaderBlock = document.createElement('div');
        reasoningHeaderBlock.className = 'mes_reasoning_header_block flex-container';
        const reasoningHeader = document.createElement('div');
        reasoningHeader.className = 'mes_reasoning_header flex-container';
        reasoningHeader.style.backgroundColor = 'rgb(0 255 255)';
        reasoningHeader.textContent = 'Thought for 3 minutes';
        reasoningHeaderBlock.appendChild(reasoningHeader);
        reasoningSummary.appendChild(reasoningHeaderBlock);
        const reasoningText = document.createElement('div');
        reasoningText.className = 'mes_reasoning';
        reasoningText.textContent = 'Reasoning width probe.';
        reasoningDetails.append(reasoningSummary, reasoningText);
        messageBlock.prepend(reasoningDetails);

        const reflowStyle = document.createElement('style');
        reflowStyle.textContent = `
            .message-screenshot-grid-probe {
                contain: content !important;
                display: grid !important;
                grid-template-columns: 100px minmax(0, 1fr) !important;
                grid-template-rows: auto;
            }
            .message-screenshot-grid-probe > .mesAvatarWrapper { grid-area: 1 / 1 !important; }
            .message-screenshot-grid-probe > .mes_block { grid-area: 1 / 2 !important; }
            .message-screenshot-reflow-probe::first-line { font-size: 4px; }
        `;
        document.head.appendChild(reflowStyle);

        const overlapProbe = document.createElement('div');
        overlapProbe.style.cssText = 'width:270px;font:500 14px/24px sans-serif;';

        const quoteLine = document.createElement('p');
        quoteLine.style.margin = '0';
        const gradientQuote = document.createElement('q');
        gradientQuote.style.backgroundImage = 'linear-gradient(90deg, color(display-p3 1 0 0), color(display-p3 0 0 1))';
        gradientQuote.style.backgroundRepeat = 'no-repeat';
        gradientQuote.style.backgroundSize = '100% 100%';
        gradientQuote.style.webkitBackgroundClip = 'text';
        gradientQuote.style.backgroundClip = 'text';
        gradientQuote.style.webkitTextFillColor = 'transparent';
        gradientQuote.textContent = 'This quote should just fit the source line.';
        quoteLine.appendChild(gradientQuote);

        const followingLine = document.createElement('p');
        followingLine.style.cssText = 'margin:0;color:rgb(255 255 0);';
        followingLine.textContent = 'Following narrow line.';
        overlapProbe.append(quoteLine, followingLine);

        const reflowProbe = document.createElement('div');
        reflowProbe.style.cssText = 'width:485px;font:500 24px/24px Figtree,sans-serif;';
        const reflowLine = document.createElement('p');
        reflowLine.style.margin = '0';
        reflowLine.className = 'message-screenshot-reflow-probe';
        const gradientReflowText = document.createElement('span');
        gradientReflowText.style.cssText = gradientQuote.style.cssText;
        gradientReflowText.textContent = 'He fixed my glasses. His hand is warm. Why is his hand warm. Walls. Drainage. Load-bearing things.';
        reflowLine.appendChild(gradientReflowText);

        const reflowMarker = document.createElement('p');
        reflowMarker.style.cssText = followingLine.style.cssText;
        reflowMarker.textContent = 'Following reflow line.';
        reflowProbe.append(reflowLine, reflowMarker);
        for (let index = 0; index < 6; index++) {
            const extraReflowLine = document.createElement('p');
            extraReflowLine.className = 'message-screenshot-reflow-probe';
            extraReflowLine.style.margin = '0';
            extraReflowLine.textContent = 'This source line fits narrowly but must wrap after foreign-object font reflow.';
            reflowProbe.appendChild(extraReflowLine);
        }
        messageTextElement.append(overlapProbe, reflowProbe);

        const captureEndMarker = document.createElement('div');
        captureEndMarker.style.cssText = 'width:200px;height:12px;background:rgb(255 0 255);';
        messageBlock.appendChild(captureEndMarker);

        const assistantTextElement = document.querySelector('#chat .mes[mesid="1"] .mes_text');
        if (assistantTextElement) {
            assistantTextElement.style.color = 'lab(60% 20 -30)';
        }

        await new Promise(resolve => window.requestAnimationFrame(resolve));
        messageElement.style.gridTemplateRows = window.getComputedStyle(messageElement).gridTemplateRows;
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
        let endMarkerPixels = 0;
        let endMarkerWidth = 0;
        let markerPixels = 0;
        let overlappingColorRows = 0;
        let reasoningLeft = canvas.width;
        let reasoningRight = -1;
        let redPixels = 0;
        let bluePixels = 0;

        for (let y = 0; y < canvas.height; y++) {
            let hasGradient = false;
            let hasMarker = false;
            let markerRun = 0;
            for (let x = 0; x < canvas.width; x++) {
                const index = (y * canvas.width + x) * 4;
                const red = pixels[index];
                const green = pixels[index + 1];
                const blue = pixels[index + 2];
                const alpha = pixels[index + 3];
                if (alpha > 200 && red >= 25 && red <= 60 && green >= 25 && green <= 65 && blue >= 30 && blue <= 75) {
                    darkPixels++;
                }
                if (alpha > 200 && red > 170 && red > green * 1.4 && red > blue * 1.4) {
                    redPixels++;
                    hasGradient = true;
                }
                if (alpha > 200 && blue > 120 && blue > red * 1.4 && blue > green * 1.4) {
                    bluePixels++;
                    hasGradient = true;
                }
                if (alpha > 200 && red > 180 && green > 180 && blue < 100) {
                    markerPixels++;
                    hasMarker = true;
                }
                if (alpha > 200 && red > 220 && green < 30 && blue > 220) {
                    endMarkerPixels++;
                    markerRun++;
                    endMarkerWidth = Math.max(endMarkerWidth, markerRun);
                } else {
                    markerRun = 0;
                }
                if (alpha > 200 && red < 30 && green > 220 && blue > 220) {
                    reasoningLeft = Math.min(reasoningLeft, x);
                    reasoningRight = Math.max(reasoningRight, x);
                }
            }
            if (hasGradient && hasMarker) overlappingColorRows++;
        }

        const reasoningWidth = reasoningRight >= reasoningLeft ? reasoningRight - reasoningLeft + 1 : 0;
        return { bluePixels, darkPixels, endMarkerPixels, endMarkerWidth, markerPixels, overlappingColorRows, reasoningWidth, redPixels, totalPixels: canvas.width * canvas.height };
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
        const { bluePixels, darkPixels, endMarkerPixels, endMarkerWidth, markerPixels, overlappingColorRows, reasoningWidth, redPixels, totalPixels } = await readScreenshotPixelStats(page, singleDownload);
        expect(darkPixels).toBeGreaterThan(totalPixels * 0.2);
        expect(redPixels).toBeGreaterThan(10);
        expect(bluePixels).toBeGreaterThan(10);
        expect(endMarkerPixels).toBeGreaterThan(1000);
        expect(endMarkerWidth).toBeGreaterThan(150);
        expect(markerPixels).toBeGreaterThan(10);
        expect(overlappingColorRows).toBe(0);
        expect(reasoningWidth).toBeGreaterThan(250);
        expect(redPixels).toBeLessThan(totalPixels * 0.01);
        expect(bluePixels).toBeLessThan(totalPixels * 0.01);

        const rangeDownload = await exportScreenshotFromMessage(page, 0, 0, 1);
        expect(rangeDownload.suggestedFilename()).toContain('messages-0-1.png');

        const wandDownload = await exportScreenshotFromWand(page, 1, 1);
        expect(wandDownload.suggestedFilename()).toContain('message-1.png');

        expect(screenshotErrors).toEqual([]);
    });
});
