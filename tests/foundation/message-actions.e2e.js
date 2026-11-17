import { expect, test } from '@playwright/test';
import { OPEN_ACTION_SHEET } from '../helpers/action-sheet.js';

const LONG_NAME = 'Seraphina, Guardian of the Eldoria Forest, Keeper of the Moonlit Glade, Warden of the Silver Springs, and Protector of Every Quiet Path';
const target = '#chat .mes[mesid="4"]';

test.beforeEach(async ({ page, baseURL }) => {
    // A settings save without a version token makes the app show an error toast, which can cover the control under test.
    let settingsVersion = Date.now();
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== baseURL) {
            return route.abort();
        }
        if (url.pathname === '/api/settings/save') {
            return route.fulfill({ json: { version: ++settingsVersion } });
        }
        if (url.pathname === '/api/chats/save') {
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
        const id = context.characters.findIndex(character => /Seraphina/.test(character?.name ?? ''));
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
    }, { name: longName ? LONG_NAME : 'Seraphina' });
    await expect(page.locator(target)).toBeVisible();
    await page.locator(target).scrollIntoViewIfNeeded();
}

function visibleRowButtons(page, selector) {
    return page.locator(`${selector} .mes_buttons > .mes_button, ${selector} .mes_buttons > .extraMesButtons > *`).evaluateAll(buttons => buttons
        .filter(button => button.getClientRects().length > 0)
        .map(button => [...button.classList].find(name => /^(mes_|extraMesButtons)/.test(name) && name !== 'mes_button') ?? button.className));
}

const sheet = OPEN_ACTION_SHEET;
const popover = '.sb-action-popover';

function menuLabels(page, selector) {
    return page.locator(`${selector} .sb-action-menu-item .sb-action-menu-label`).allTextContents();
}

test('mobile row shows Edit and the menu button, which opens a labelled overlay', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'The sheet is mobile-only.');
    await seedChat(page, { longName: true });
    const menu = page.viewportSize().width <= 768 ? sheet : popover;

    const message = page.locator(target);
    const hint = message.locator('.mes_buttons > .extraMesButtonsHint');

    expect(await visibleRowButtons(page, target)).toEqual(['mes_edit', 'extraMesButtonsHint']);
    await expect(hint).toHaveClass(/fa-ellipsis-vertical/);
    const hintBox = await hint.boundingBox();
    expect(hintBox.width).toBeGreaterThanOrEqual(44);
    expect(hintBox.height).toBeGreaterThanOrEqual(44);

    await hint.click();
    await expect(page.locator(menu)).toBeVisible();
    await expect(hint).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(`${menu} [role="menu"]`)).toBeVisible();
    const labels = await menuLabels(page, menu);
    expect(labels).toContain('Copy');
    expect(labels).toContain('Checkpoint');
    expect(labels.at(-1)).toBe('Delete');
    await expect(page.locator(`${menu} .sb-action-menu-item.is-danger`)).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(page.locator(menu)).toBeHidden();
    await expect(hint).toHaveAttribute('aria-expanded', 'false');

    await hint.click();
    await expect(page.locator(menu)).toBeVisible();
    // Keep the outside click below the top bar and beside any notification toast.
    await page.mouse.click(page.viewportSize().width - 2, 100);
    await expect(page.locator(menu)).toBeHidden();

    await hint.click();
    await page.locator(`${menu} .sb-action-menu-item`, { hasText: /^Copy$/ }).click();
    await expect(page.locator(menu)).toBeHidden();
});

test('mobile edit row leads with Cancel and Confirm and keeps the rest in the overlay', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'The edit sheet is mobile-only.');
    await seedChat(page);
    const menu = page.viewportSize().width <= 768 ? sheet : popover;

    const message = page.locator(target);
    await message.locator('.mes_buttons .mes_edit').click();
    await expect(message.locator('.edit_textarea')).toBeVisible();

    const editRow = await message.locator('.mes_edit_buttons > *').evaluateAll(items => items
        .filter(item => item.getClientRects().length > 0)
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
        .map(item => item.classList[0]));
    expect(editRow).toEqual(['mes_edit_cancel', 'mes_edit_done', 'sb-mes-edit-more']);

    await message.locator('.mes_edit_buttons > .sb-mes-edit-more').click();
    await expect(page.locator(menu)).toBeVisible();
    const labels = await menuLabels(page, menu);
    expect(labels[0]).toBe('Copy this message');
    expect(labels.at(-1)).toBe('Delete this message');

    await page.keyboard.press('Escape');
    await expect(page.locator(menu)).toBeHidden();
    await expect(message.locator('.edit_textarea')).toBeVisible();

    await message.locator('.mes_edit_cancel').click();
    await expect(message.locator('.edit_textarea')).toHaveCount(0);
});

test('press-and-hold shows the action label without activating it', async ({ page, isMobile, browserName }) => {
    test.skip(!isMobile || browserName !== 'chromium', 'Touch long-press is driven through Chromium CDP.');
    await seedChat(page);

    const edit = page.locator(`${target} .mes_buttons .mes_edit`);
    await edit.click({ trial: true });
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

/* ---------- Message rows: the dimmed rest state, the edit row, the Document toolbar, the delete bar, the swipe controls ---------- */

async function seedWithSwipes(page) {
    await seedChat(page);
    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        const last = context.chat.at(-1);
        last.is_user = false;
        last.swipes = [last.mes, 'Another take on the quiet glade.', 'A third.'];
        last.swipe_id = 1;
        await context.printMessages();
    });
    await expect(page.locator('#chat .last_mes .swipes-counter')).toBeVisible();
}

async function setStyle(page, value, bodyClass) {
    await page.evaluate(v => window.$('#chat_display').val(String(v)).trigger('change'), value);
    await expect(page.locator('body')).toHaveClass(new RegExp(bodyClass));
    await page.waitForFunction(() => {
        const link = document.getElementById('sillybunny-native-chat-styles');
        return !link || link.sheet !== null;
    });
}

test('a resting action is dimmed by colour at full opacity, and Delete keeps full opacity', async ({ page }) => {
    await seedChat(page);
    await page.locator(target).hover();
    const rest = await page.evaluate(selector => {
        const probe = document.createElement('i');
        probe.style.color = 'var(--sb-muted-fg)';
        document.body.append(probe);
        const muted = getComputedStyle(probe).color;
        probe.remove();
        const read = element => ({ opacity: getComputedStyle(element).opacity, color: getComputedStyle(element).color });
        const mes = document.querySelector(selector);
        return { muted, edit: read(mes.querySelector('.mes_buttons .mes_edit')), hint: read(mes.querySelector('.extraMesButtonsHint')), del: read(mes.querySelector('.mes_buttons .mes_delete')) };
    }, target);
    // Hovering the message must not be the thing that lifts the controls to a readable contrast.
    await page.mouse.move(2, 2);
    expect(rest.edit.opacity).toBe('1');
    expect(rest.hint.opacity).toBe('1');
    expect(rest.del.opacity).toBe('1');
    expect(rest.edit.color).toBe(rest.muted);
});

test('the action row follows the pointer, never the width', async ({ page, isMobile }) => {
    await seedChat(page);
    const expected = isMobile ? ['mes_edit', 'extraMesButtonsHint'] : ['mes_copy', 'mes_edit', 'extraMesButtonsHint'];
    expect(await visibleRowButtons(page, target)).toEqual(expected);
    // A narrow window with a fine pointer shows the fine set; a wide one with a coarse pointer shows the coarse set.
    const { width, height } = page.viewportSize();
    await page.setViewportSize({ width: isMobile ? 1100 : 390, height });
    expect(await visibleRowButtons(page, target)).toEqual(expected);
    await page.setViewportSize({ width, height });
});

test('Cancel in the edit row is neutral, and Move up and Move down stay visible, disabled at the chat edges', async ({ page, isMobile }) => {
    test.skip(isMobile, 'The inline edit row is desktop-only.');
    await seedChat(page);

    const bodyColor = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--SmartThemeBodyColor').trim());
    await page.locator('#chat .mes[mesid="0"] .mes_buttons .mes_edit').click();
    const first = page.locator('#chat .mes[mesid="0"]');
    await expect(first.locator('.edit_textarea')).toBeVisible();
    await expect(first.locator('.mes_edit_up')).toBeVisible();
    await expect(first.locator('.mes_edit_up')).toHaveClass(/disabled/);
    await expect(first.locator('.mes_edit_down')).not.toHaveClass(/disabled/);
    const cancel = await first.locator('.mes_edit_cancel').evaluate(element => getComputedStyle(element).color);
    const probe = await page.evaluate(color => {
        const element = document.createElement('i');
        element.style.color = color;
        document.body.append(element);
        const resolved = getComputedStyle(element).color;
        element.remove();
        return resolved;
    }, bodyColor);
    expect(cancel).toBe(probe);
    await first.locator('.mes_edit_cancel').click();

    await page.locator('#chat .mes[mesid="5"] .mes_buttons .mes_edit').click();
    const last = page.locator('#chat .mes[mesid="5"]');
    await expect(last.locator('.mes_edit_down')).toBeVisible();
    await expect(last.locator('.mes_edit_down')).toHaveClass(/disabled/);
    await last.locator('.mes_edit_cancel').click();
});

test('Move up works on the first rendered message of a chat longer than the render window', async ({ page, isMobile }) => {
    test.skip(isMobile, 'The inline edit row is desktop-only.');
    await seedChat(page);
    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        context.powerUserSettings.chat_truncation = 10;
        context.chat.length = 0;
        for (let index = 0; index < 40; index++) {
            const isUser = index % 2 === 1;
            context.chat.push({ name: isUser ? 'Tester' : 'Seraphina', is_user: isUser, is_system: false, send_date: new Date(Date.UTC(2026, 8, 30, 12, index)).toISOString(), mes: `Long ${index}` });
        }
        await context.printMessages();
    });
    const rendered = await page.locator('#chat > .mes').count();
    expect(rendered).toBeLessThan(40);
    const firstId = Number(await page.locator('#chat > .mes').first().getAttribute('mesid'));
    expect(firstId).toBeGreaterThan(0);

    await page.locator(`#chat .mes[mesid="${firstId}"] .mes_buttons .mes_edit`).click();
    const row = page.locator(`#chat .mes[mesid="${firstId}"]`);
    await expect(row.locator('.edit_textarea')).toBeVisible();
    await expect(row.locator('.mes_edit_up')).not.toHaveClass(/disabled/);
    await row.locator('.mes_edit_up').click();
    await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().chat[29].mes)).toBe('Long 30');
    // The moved message is still the one being edited.
    await expect(page.locator(`#chat .mes[mesid="${firstId - 1}"] .edit_textarea`)).toHaveValue('Long 30');
});

test('only the media toggle that matches the message shows', async ({ page, isMobile }) => {
    test.skip(isMobile, 'The inline toggles are desktop-only.');
    await seedChat(page);
    const count = (value) => page.evaluate(({ selector, value }) => {
        const mes = document.querySelector(selector);
        mes.setAttribute('data-sb-actions-expanded', '');
        mes.setAttribute('data-media-display', value);
        const shown = element => element.getClientRects().length > 0;
        return { gallery: [...mes.querySelectorAll('.mes_media_gallery')].filter(shown).length, list: [...mes.querySelectorAll('.mes_media_list')].filter(shown).length };
    }, { selector: target, value });
    expect(await count('gallery')).toEqual({ gallery: 1, list: 0 });
    expect(await count('list')).toEqual({ gallery: 0, list: 1 });
});

test('the edit row of a mirrored user message keeps its order', async ({ page, isMobile }) => {
    test.skip(isMobile, 'The inline edit row is desktop-only.');
    await seedChat(page);
    await setStyle(page, 3, 'echostyle');
    const user = page.locator('#chat .mes[mesid="5"]');
    await user.scrollIntoViewIfNeeded();
    await user.locator('.mes_buttons .mes_edit').click();
    const order = await user.locator('.mes_edit_buttons .menu_button').evaluateAll(items => items
        .filter(item => item.getClientRects().length > 0)
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
        .map(item => item.classList[0]));
    expect(order.slice(0, 3)).toEqual(['mes_edit_cancel', 'mes_edit_done', 'mes_edit_copy']);
    await user.locator('.mes_edit_cancel').click();
});

test('Document: a coarse pointer gets the action row of an older message in the flow', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'The in-flow row is for a coarse pointer.');
    await seedChat(page);
    await setStyle(page, 2, 'documentstyle');
    const older = page.locator('#chat .mes[mesid="2"]');
    await older.scrollIntoViewIfNeeded();
    await expect(older.locator('.ch_name > .mes_buttons')).toBeVisible();
    expect(await visibleRowButtons(page, '#chat .mes[mesid="2"]')).toEqual(['mes_edit', 'extraMesButtonsHint']);
    const box = await older.locator('.mes_buttons .mes_edit').boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
});

test('Document: a fine pointer gets an overlaid toolbar on hover or focus', async ({ page, isMobile }) => {
    test.skip(isMobile, 'The overlaid toolbar is for a fine pointer.');
    await seedChat(page);
    await setStyle(page, 2, 'documentstyle');
    const older = page.locator('#chat .mes[mesid="2"]');
    await older.scrollIntoViewIfNeeded();
    const buttons = older.locator('.ch_name > .mes_buttons');
    await page.mouse.move(2, 2);
    await expect(buttons).toHaveCSS('opacity', '0');
    await older.locator('.mes_text').hover();
    await expect(buttons).toHaveCSS('opacity', '1');
    const placed = await buttons.evaluate(element => {
        const row = element.closest('.mes').getBoundingClientRect();
        const box = element.getBoundingClientRect();
        return { position: getComputedStyle(element).position, inside: box.top >= row.top && box.right <= row.right, width: box.width, fill: getComputedStyle(element).backgroundColor };
    });
    expect(placed.position).toBe('absolute');
    expect(placed.inside).toBe(true);
    // It is as wide as its three buttons, so it never covers the message it floats over.
    expect(placed.width).toBeLessThan(160);
    // The OSD fill: black at 70%.
    expect(placed.fill).toMatch(/^(rgba\(0, 0, 0, 0\.7\)|color\(srgb 0 0 0 \/ 0\.7\))$/);
    // A narrow window with a fine pointer keeps it that small.
    await page.setViewportSize({ width: 390, height: page.viewportSize().height });
    await older.scrollIntoViewIfNeeded();
    await older.locator('.mes_text').hover();
    expect((await buttons.boundingBox()).width).toBeLessThan(160);
    await page.setViewportSize({ width: 1440, height: page.viewportSize().height });
    // Keyboard focus reveals it too.
    await page.mouse.move(2, 2);
    await older.locator('.mes_buttons .mes_edit').focus();
    await expect(buttons).toHaveCSS('opacity', '1');
});

test('delete mode puts Cancel first, a live count in the middle and Delete last, with round checks', async ({ page }) => {
    await seedChat(page);
    await page.evaluate(() => window.$('#option_delete_mes').trigger('click'));
    const bar = page.locator('#dialogue_del_mes');
    await expect(bar).toBeVisible();

    const order = await bar.locator('> *').evaluateAll(items => items.map(item => item.id));
    expect(order).toEqual(['dialogue_del_mes_cancel', 'dialogue_del_mes_count', 'dialogue_del_mes_ok']);
    await expect(bar.locator('#dialogue_del_mes_count')).toHaveAttribute('role', 'status');
    await expect(bar.locator('#dialogue_del_mes_count')).toHaveText('0 selected');

    const check = await page.locator('#chat .mes[mesid="4"] .del_checkbox').evaluate(element => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { width: Math.round(box.width), height: Math.round(box.height), radius: style.borderRadius, border: style.borderTopWidth };
    });
    expect({ width: check.width, height: check.height, border: check.border }).toEqual({ width: 28, height: 28, border: '2px' });
    expect(parseFloat(check.radius)).toBeGreaterThanOrEqual(14);

    // Choosing a message selects it and every message after it.
    await page.locator('#chat .mes[mesid="3"] .mes_text').click();
    await expect(bar.locator('#dialogue_del_mes_count')).toHaveText('3 selected');
    await bar.locator('#dialogue_del_mes_cancel').click();
    await expect(bar).toBeHidden();
});

test('the swipe arrows are at the pointer floor, the previous one at the start edge in a Moonlit style', async ({ page, isMobile }) => {
    await seedWithSwipes(page);
    await setStyle(page, 3, 'echostyle');
    const floor = isMobile ? 44 : 32;
    const last = page.locator('#chat .last_mes');
    await last.scrollIntoViewIfNeeded();
    const boxes = await last.evaluate(element => {
        const rect = selector => {
            const box = element.querySelector(selector).getBoundingClientRect();
            return { left: box.left, right: box.right, width: box.width, height: box.height };
        };
        const row = element.getBoundingClientRect();
        return { row: { left: row.left, right: row.right }, prev: rect('.swipe_left'), next: rect('.swipe_right'), counter: rect('.swipes-counter') };
    });
    expect(boxes.prev.width).toBeGreaterThanOrEqual(floor);
    expect(boxes.prev.height).toBeGreaterThanOrEqual(floor);
    expect(boxes.next.width).toBeGreaterThanOrEqual(floor);
    const middle = boxes.row.left + (boxes.row.right - boxes.row.left) / 2;
    expect(boxes.prev.right).toBeLessThan(middle);
    expect(boxes.next.left).toBeGreaterThan(middle);
    expect(boxes.counter.left).toBeGreaterThan(middle);

    // The counter is small, but the area that opens the swipe picker reaches the floor.
    const hit = await last.locator('.swipes-counter').evaluate(element => parseFloat(getComputedStyle(element, '::after').height));
    expect(hit).toBeGreaterThanOrEqual(floor);
});

test('a reasoning header reaches the pointer floor', async ({ page, isMobile }) => {
    await seedChat(page);
    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        const message = context.chat[2];
        message.extra = { reasoning: 'Thinking it over.', reasoning_duration: 1500 };
        await context.printMessages();
    });
    const header = page.locator('#chat .mes[mesid="2"] .mes_reasoning_header').first();
    await expect(header).toBeVisible();
    const box = await header.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(isMobile ? 44 : 32);
});
