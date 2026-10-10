import { expect, test } from '@playwright/test';

const LONG_NAME = 'Seraphina, Guardian of the Eldoria Forest, Keeper of the Moonlit Glade, Warden of the Silver Springs, and Protector of Every Quiet Path';
const target = '#chat .mes[mesid="4"]';

test.beforeEach(async ({ page, baseURL }) => {
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== baseURL) {
            return route.abort();
        }
        if (url.pathname === '/api/chats/save' || url.pathname === '/api/settings/save') {
            return route.fulfill({ json: {} });
        }
        return route.continue();
    });
});

async function seedChat(page, { longName = false } = {}) {
    await page.goto('/');
    await page.waitForFunction(() => document.getElementById('preloader') === null, null, { timeout: 60000 });
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        if (!context.characters.length) {
            await context.getCharacters();
        }
        const id = context.characters.findIndex(character => /Bunny Guide|Seraphina/.test(character?.name ?? ''));
        await context.selectCharacterById(id, { switchMenu: false });
    });
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
    await page.evaluate(async ({ name }) => {
        const context = window.SillyTavern.getContext();
        context.chat.length = 0;
        document.querySelector('#chat').replaceChildren();
        for (let index = 0; index < 6; index++) {
            const isUser = index % 2 === 1;
            context.chat.push({
                name: isUser ? 'Tester' : name,
                is_user: isUser,
                is_system: false,
                send_date: new Date(Date.UTC(2026, 8, 30, 12, index)).toISOString(),
                mes: `Message ${index}. ${'The glade is quiet tonight. '.repeat(4)}`,
                extra: index === 4 ? { bookmark_link: 'Checkpoint A' } : {},
            });
        }
        await context.printMessages();
    }, { name: longName ? LONG_NAME : 'Bunny Guide' });
    await expect(page.locator(target)).toBeVisible();
    await page.locator(target).scrollIntoViewIfNeeded();
}

function visibleRowButtons(page, selector) {
    return page.locator(`${selector} .mes_buttons > .mes_button, ${selector} .mes_buttons > .extraMesButtons > *`).evaluateAll(buttons => buttons
        .filter(button => button.getClientRects().length > 0)
        .map(button => [...button.classList].find(name => /^(mes_|extraMesButtons)/.test(name) && name !== 'mes_button') ?? button.className));
}

const sheet = '.sb-action-sheet';
const popover = '.sb-action-popover';

function menuLabels(page, selector) {
    return page.locator(`${selector} .sb-action-menu-item .sb-action-menu-label`).allTextContents();
}

test('mobile row shows Edit and the menu button, which opens a labelled sheet', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'The sheet is mobile-only.');
    await seedChat(page, { longName: true });

    const message = page.locator(target);
    const hint = message.locator('.mes_buttons > .extraMesButtonsHint');

    expect(await visibleRowButtons(page, target)).toEqual(['mes_edit', 'extraMesButtonsHint']);
    await expect(hint).toHaveClass(/fa-ellipsis-vertical/);
    const hintBox = await hint.boundingBox();
    expect(hintBox.width).toBeGreaterThanOrEqual(44);
    expect(hintBox.height).toBeGreaterThanOrEqual(44);

    await hint.click();
    await expect(page.locator(sheet)).toBeVisible();
    await expect(hint).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(`${sheet} [role="menu"]`)).toBeVisible();
    const labels = await menuLabels(page, sheet);
    expect(labels).toContain('Copy');
    expect(labels).toContain('Checkpoint');
    expect(labels.at(-1)).toBe('Delete');
    await expect(page.locator(`${sheet} .sb-action-menu-item.is-danger`)).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(page.locator(sheet)).toBeHidden();
    await expect(hint).toHaveAttribute('aria-expanded', 'false');

    await hint.click();
    await expect(page.locator(sheet)).toBeVisible();
    await page.mouse.click(20, 40);
    await expect(page.locator(sheet)).toBeHidden();

    await hint.click();
    await page.locator(`${sheet} .sb-action-menu-item`, { hasText: /^Copy$/ }).click();
    await expect(page.locator(sheet)).toBeHidden();
});

test('mobile edit row leads with Cancel and Confirm and keeps the rest in the sheet', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'The edit sheet is mobile-only.');
    await seedChat(page);

    const message = page.locator(target);
    await message.locator('.mes_buttons .mes_edit').click();
    await expect(message.locator('.edit_textarea')).toBeVisible();

    const editRow = await message.locator('.mes_edit_buttons > *').evaluateAll(items => items
        .filter(item => item.getClientRects().length > 0)
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
        .map(item => item.classList[0]));
    expect(editRow).toEqual(['mes_edit_cancel', 'mes_edit_done', 'sb-mes-edit-more']);

    await message.locator('.mes_edit_buttons > .sb-mes-edit-more').click();
    await expect(page.locator(sheet)).toBeVisible();
    const labels = await menuLabels(page, sheet);
    expect(labels[0]).toBe('Copy this message');
    expect(labels.at(-1)).toBe('Delete this message');

    await page.keyboard.press('Escape');
    await expect(page.locator(sheet)).toBeHidden();
    await expect(message.locator('.edit_textarea')).toBeVisible();

    await message.locator('.mes_edit_cancel').click();
    await expect(message.locator('.edit_textarea')).toHaveCount(0);
});

test('press-and-hold shows the action label without activating it', async ({ page, isMobile, browserName }) => {
    test.skip(!isMobile || browserName !== 'chromium', 'Touch long-press is driven through Chromium CDP.');
    await seedChat(page);

    const edit = page.locator(`${target} .mes_buttons .mes_edit`);
    const box = await edit.boundingBox();
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    const tooltip = page.locator('#sb-press-tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(/Edit/);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(450);
    await expect(page.locator(`${target} .edit_textarea`)).toHaveCount(0);
});

test('desktop row shows Copy, Edit, and the menu button, which opens a popover', async ({ page, isMobile }) => {
    test.skip(isMobile, 'The popover is desktop-only.');
    await seedChat(page, { longName: true });

    const message = page.locator(target);
    const hint = message.locator('.mes_buttons > .extraMesButtonsHint');

    const name = await message.locator('.name_text').evaluate(element => {
        const style = getComputedStyle(element);
        return { ellipsis: style.textOverflow === 'ellipsis', truncated: element.scrollWidth > element.clientWidth };
    });
    expect(name).toEqual({ ellipsis: true, truncated: true });
    expect(await visibleRowButtons(page, target)).toEqual(['mes_copy', 'mes_edit', 'extraMesButtonsHint']);

    await message.hover();
    await hint.hover();
    // SillyTavern-Tooltips moves `title` to data-sttt--title.
    const hintTitle = await hint.evaluate(element => element.getAttribute('data-sttt--title') ?? element.getAttribute('title'));
    expect(hintTitle).toBe('Message Actions\nHold shift to expand.');

    await hint.click();
    const menu = page.locator(popover);
    await expect(menu).toBeVisible();
    await expect(hint).toHaveAttribute('aria-expanded', 'true');
    const inside = await menu.evaluate(element => {
        const box = element.getBoundingClientRect();
        const chat = document.getElementById('chat').getBoundingClientRect();
        return box.left >= chat.left - 1 && box.right <= chat.right + 1;
    });
    expect(inside).toBe(true);
    expect((await menuLabels(page, popover)).at(-1)).toBe('Delete');

    await page.keyboard.press('ArrowDown');
    await expect(menu.locator('.sb-action-menu-item:focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(hint).toBeFocused();

    await message.locator('.ch_name .name_text').click({ button: 'right' });
    await expect(page.locator(popover)).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(page.locator(popover)).toHaveCount(0);
});

test('desktop Shift expands only the hovered row, with Delete and dividers', async ({ page, isMobile }) => {
    test.skip(isMobile, 'Shift reveal is desktop-only.');
    await seedChat(page);

    const message = page.locator(target);
    // Shift is ignored while a text field (the composer) has focus.
    await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.blur());
    await message.locator('.mes_text').hover();
    await page.keyboard.down('Shift');
    await page.keyboard.up('Shift');
    await expect(message).toHaveAttribute('data-sb-actions-expanded', '');

    const order = await visibleRowButtons(page, target);
    expect(order).toContain('mes_delete');
    expect(order).toContain('mes_bookmark');
    expect(order.slice(-3)).toEqual(['mes_copy', 'mes_edit', 'extraMesButtonsHint']);
    expect(await message.locator('.mes_buttons .sb-actions-divider:visible').count()).toBeGreaterThan(0);
    expect(await visibleRowButtons(page, '#chat .mes[mesid="2"]')).toEqual(['mes_copy', 'mes_edit', 'extraMesButtonsHint']);

    await page.locator('#chat .mes[mesid="2"] .mes_text').hover();
    await expect(message).not.toHaveAttribute('data-sb-actions-expanded');
});

test('desktop Shift held before hovering expands the row the pointer enters', async ({ page, isMobile }) => {
    test.skip(isMobile, 'Shift reveal is desktop-only.');
    await seedChat(page);

    const message = page.locator(target);
    await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.blur());
    await page.mouse.move(5, 5);
    await page.keyboard.down('Shift');
    await message.locator('.mes_text').hover();
    await expect(message).toHaveAttribute('data-sb-actions-expanded', '');
    await page.keyboard.up('Shift');
});

test('desktop edit row keeps the edit actions inline, Delete last', async ({ page, isMobile }) => {
    test.skip(isMobile, 'The inline edit row is desktop-only.');
    await seedChat(page);

    const message = page.locator(target);
    await message.locator('.mes_buttons .mes_edit').click();
    await expect(message.locator('.edit_textarea')).toBeVisible();
    const editRow = await message.locator('.mes_edit_buttons .menu_button').evaluateAll(items => items
        .filter(item => item.getClientRects().length > 0)
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
        .map(item => item.classList[0]));
    expect(editRow.slice(0, 3)).toEqual(['mes_edit_cancel', 'mes_edit_done', 'mes_edit_copy']);
    expect(editRow.at(-1)).toBe('mes_edit_delete');
    expect(editRow).not.toContain('sb-mes-edit-more');
    await message.locator('.mes_edit_cancel').click();
});

test('Delete always asks first, with Cancel focused', async ({ page }) => {
    await seedChat(page);
    await page.evaluate(() => {
        window.SillyTavern.getContext().powerUserSettings.confirm_message_delete = false;
    });

    const message = page.locator(target);
    await message.locator('.mes_buttons > .extraMesButtonsHint').click();
    await page.locator('.sb-action-menu-item.is-danger').click({ timeout: 10000 });
    const dialog = page.locator('dialog.sb-popup-destructive-confirm');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.popup-button-cancel')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(message).toBeVisible();
    await expect(page.locator('#chat .mes')).toHaveCount(6);
});

test('echo user messages anchor actions to their start edge', async ({ page }) => {
    await seedChat(page);
    await page.evaluate(() => $('#chat_display').val('3').trigger('change'));
    await expect(page.locator('body')).toHaveClass(/echostyle/);

    const userMessage = '#chat .mes[mesid="5"]';
    await page.locator(userMessage).scrollIntoViewIfNeeded();
    const sides = await page.locator(userMessage).evaluate(element => ({
        buttons: element.querySelector('.mes_buttons').getBoundingClientRect().left,
        hint: element.querySelector('.extraMesButtonsHint').getBoundingClientRect().left,
        edit: element.querySelector('.mes_buttons .mes_edit').getBoundingClientRect().left,
        name: element.querySelector('.name_text').getBoundingClientRect().left,
    }));
    expect(sides.buttons).toBeLessThan(sides.name);
    expect(sides.hint).toBeLessThan(sides.edit);
});
