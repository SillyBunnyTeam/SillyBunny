import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { testSetup } from './frontend/frontent-test-utils.js';

test.use({ contextOptions: { reducedMotion: 'reduce' } });

async function createSwipeFixture(page, count = 52) {
    const messageId = await page.evaluate(async ({ count }) => {
        const { newAssistantChat, selectCharacterById } = await import('/script.js');
        const powerUser = await import('/scripts/power-user.js');
        const context = window.SillyTavern.getContext();
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
        powerUser.power_user.confirm_message_delete = true;
        const characterId = context.characters.findIndex(character => character?.avatar);
        if (characterId >= 0) await selectCharacterById(characterId, { switchMenu: false });
        else await newAssistantChat({ temporary: true });
        const message = {
            name: 'Assistant',
            is_user: false,
            is_system: false,
            send_date: new Date().toISOString(),
            mes: 'Swipe 1 preview text',
            extra: {},
            swipes: Array.from({ length: count }, (_, index) => `Swipe ${index + 1} preview text`),
            swipe_id: 1,
            swipe_info: Array.from({ length: count }, () => ({ send_date: Date.now(), extra: { token_count: 4 } })),
        };
        context.chat.push(message);
        await context.addOneMessage(message);
        const id = context.chat.length - 1;
        document.querySelector(`.mes[mesid="${id}"] .swipes-counter`)?.classList.add('swipe-picker-enabled');
        return id;
    }, { count });
    await page.locator(`.mes[mesid="${messageId}"] .swipes-counter.swipe-picker-enabled`).click();
    const dialog = page.locator('dialog[open].sb-dialog--window');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.swipe_picker_footer')).toBeVisible();
    await expect(dialog).not.toHaveAttribute('opening');
    await expect(dialog.locator('.swipe_picker_block[highlight]')).toBeInViewport();
    return messageId;
}

async function interceptChatSaves(page) {
    const saves = [];
    await page.route('**/api/chats/save', async route => {
        saves.push(route.request().postData() ?? '');
        await route.fulfill({ json: { integrity: 'swipe-picker-test' } });
    });
    return saves;
}

async function getSwipeState(page, messageId) {
    return page.evaluate(messageId => {
        const message = window.SillyTavern.getContext().chat[messageId];
        return { swipeId: message.swipe_id, count: message.swipes.length };
    }, messageId);
}

async function assertPickerLayout(page, messageId, screenshotPath) {
    const dialog = page.locator('dialog[open].sb-dialog--window');
    await expect(dialog).toHaveAttribute('data-presentation', 'floating');
    await expect(dialog.locator('.sb-dialog__title')).toHaveText('Swipe Selection');
    await expect(dialog.locator('.swipe_picker_block')).toHaveCount(52);
    await expect(dialog.locator('.swipe_picker_block[highlight]')).toContainText('[Current]');
    await expect(dialog.locator('.swipe_picker_block[highlight]')).toBeInViewport();

    const row = dialog.locator('.swipe_picker_block').first();
    const title = row.locator('.select_chat_block_filename').first();
    const metadata = row.locator('.select_chat_info');
    await expect(title).toHaveCSS('color', /rgb\(/);
    await expect(title).toHaveCSS('font-weight', '700');
    await expect(metadata).toHaveCSS('color', /rgb\(/);
    await expect(row.locator('.swipe_picker_copy, .swipe_picker_branch, .swipe_picker_delete')).toHaveCount(3);
    const geometry = await row.evaluate(node => {
        const rowBounds = node.getBoundingClientRect();
        const buttonBounds = node.querySelector('.swipe_picker_delete').getBoundingClientRect();
        return { rowRight: rowBounds.right, actionRight: buttonBounds.right };
    });
    expect(geometry.actionRight).toBeLessThanOrEqual(geometry.rowRight);
    await mkdir('/tmp/opencode/round1-step6-shots', { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: false });
}

async function assertSwipeIdNavigation(page, messageId) {
    const dialog = page.locator('dialog[open].sb-dialog--window');
    const input = dialog.locator(`#swipe_picker_id_${messageId}`);
    await input.fill('50');
    await dialog.getByRole('button', { name: 'Go', exact: true }).click();
    await expect.poll(() => getSwipeState(page, messageId)).toMatchObject({ swipeId: 49 });
}

test.describe('swipe picker shared Window', () => {
    test.beforeEach(testSetup.awaitST);

    test('desktop supports selection, actions, navigation, scrolling and safe deletion', async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        const saves = await interceptChatSaves(page);
        const messageId = await createSwipeFixture(page);
        await assertPickerLayout(page, messageId, '/tmp/opencode/round1-step6-shots/after-desktop.png');
        const dialog = page.locator('dialog[open].sb-dialog--window');

        await page.evaluate(() => {
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: text => window.__swipeCopied = text } });
        });
        await dialog.locator('.swipe_picker_block').first().getByRole('button', { name: 'Copy' }).click();
        await expect.poll(() => page.evaluate(() => window.__swipeCopied)).toBe('Swipe 1 preview text');

        const lastRow = dialog.locator('.swipe_picker_block').last();
        await lastRow.scrollIntoViewIfNeeded();
        await expect(lastRow).toBeInViewport();
        const deleteButton = lastRow.getByRole('button', { name: 'Delete Swipe' });
        await deleteButton.click();
        const alert = page.locator('dialog[open][role="alertdialog"]');
        await expect(alert).toBeVisible();
        await expect(alert.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(alert).toBeHidden();
        await expect.poll(() => getSwipeState(page, messageId)).toMatchObject({ count: 52 });
        await deleteButton.click();
        await page.locator('dialog[open][role="alertdialog"]').getByRole('button', { name: 'Delete Swipe', exact: true }).click();
        await expect.poll(() => getSwipeState(page, messageId)).toMatchObject({ count: 51 });

        await assertSwipeIdNavigation(page, messageId);
        await page.locator(`.mes[mesid="${messageId}"] .swipes-counter.swipe-picker-enabled`).click();
        await page.locator('dialog[open].sb-dialog--window').locator('.swipe_picker_block').first().click();
        await expect.poll(() => getSwipeState(page, messageId)).toMatchObject({ swipeId: 0 });

        await page.locator(`.mes[mesid="${messageId}"] .swipes-counter.swipe-picker-enabled`).click();
        await page.route('**/api/chats/get', route => route.fulfill({ json: [{}] }));
        const saveCount = saves.length;
        await page.locator('dialog[open].sb-dialog--window .swipe_picker_branch').first().click();
        await expect.poll(() => saves.length).toBeGreaterThan(saveCount);
        await page.keyboard.press('Escape');
        await expect(page.locator('dialog[open].sb-dialog--window')).toBeHidden();
    });

    test('phone is a bottom sheet with reachable rows and keyboard activation', async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 390, height: 844 });
        const messageId = await createSwipeFixture(page);
        const dialog = page.locator('dialog[open].sb-dialog--window');
        await expect(dialog).toHaveAttribute('data-presentation', 'sheet');
        await expect(dialog.locator('.swipe_picker_footer')).toBeVisible();
        const footer = dialog.locator('.swipe_picker_footer');
        const go = footer.getByRole('button', { name: 'Go', exact: true });
        await expect(go).toBeVisible();
        await expect(go).toHaveClass(/menu_button_primary/);
        const footerBounds = await footer.evaluate(node => node.getBoundingClientRect().toJSON());
        const goBounds = await go.evaluate(node => node.getBoundingClientRect().toJSON());
        expect(goBounds.right).toBeLessThan(footerBounds.right - 8);
        await expect(dialog.locator('.swipe_picker_block[highlight]')).toBeInViewport();
        await mkdir('/tmp/opencode/round1-step6-shots', { recursive: true });
        await page.screenshot({ path: '/tmp/opencode/round1-step6-shots/after-phone.png', fullPage: false });

        const lastRow = dialog.locator('.swipe_picker_block').last();
        await lastRow.scrollIntoViewIfNeeded();
        await expect(lastRow).toBeInViewport();
        await dialog.locator('.swipe_picker_block').first().focus();
        await page.keyboard.press('Space');
        await expect.poll(() => getSwipeState(page, messageId)).toMatchObject({ swipeId: 0 });
        await expect(dialog).toBeHidden();

        await page.locator(`.mes[mesid="${messageId}"] .swipes-counter.swipe-picker-enabled`).click();
        const input = page.locator('dialog[open].sb-dialog--window input[type="number"]');
        await input.fill('52');
        await expect(input).toHaveAttribute('max', '52');
        await page.locator('dialog[open].sb-dialog--window').getByRole('button', { name: 'Go', exact: true }).click();
        await expect.poll(() => getSwipeState(page, messageId)).toMatchObject({ swipeId: 51 });
        await expect(page.locator('dialog[open].sb-dialog--window')).toBeHidden();
        await page.locator(`.mes[mesid="${messageId}"] .swipes-counter.swipe-picker-enabled`).click();
        await page.keyboard.press('Escape');
        await expect(page.locator('dialog[open].sb-dialog--window')).toBeHidden();
    });
});
