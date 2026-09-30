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
    return page.locator(`${selector} .mes_buttons > .mes_button`).evaluateAll(buttons => buttons
        .filter(button => button.getClientRects().length > 0)
        .map(button => [...button.classList].find(name => /^(mes_|extraMesButtons)/.test(name) && name !== 'mes_button') ?? button.className));
}

test('mobile message row keeps three large targets and opens an opaque popover', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'The popover layout is mobile-only.');
    await seedChat(page, { longName: true });

    const message = page.locator(target);
    const hint = message.locator('.mes_buttons > .extraMesButtonsHint');
    const popover = message.locator('.mes_buttons > .extraMesButtons');

    expect(await visibleRowButtons(page, target)).toEqual(['extraMesButtonsHint', 'mes_edit', 'mes_delete']);
    const rowTops = await message.locator('.mes_buttons > .mes_button').evaluateAll(buttons => new Set(buttons
        .filter(button => button.getClientRects().length > 0)
        .map(button => Math.round(button.getBoundingClientRect().top))).size);
    expect(rowTops).toBe(1);
    const hintBox = await hint.boundingBox();
    expect(hintBox.width).toBeGreaterThanOrEqual(44);
    expect(hintBox.height).toBeGreaterThanOrEqual(44);

    await hint.click();
    await expect(popover).toHaveAttribute('data-sb-open', '');
    await expect(popover).toHaveAttribute('role', 'group');
    await expect(hint).toHaveAttribute('aria-expanded', 'true');
    await expect(hint).toHaveAttribute('aria-controls', await popover.getAttribute('id'));
    await expect(popover.locator('.mes_bookmark')).toBeVisible();
    await expect(popover).toHaveAttribute('data-sb-placement', /^(top|bottom)$/);

    const layout = await popover.evaluate(element => {
        const box = element.getBoundingClientRect();
        const chat = document.getElementById('chat').getBoundingClientRect();
        const background = getComputedStyle(element).backgroundColor;
        const corners = [
            [box.left + 10, box.top + 10], [box.right - 10, box.top + 10],
            [box.left + 10, box.bottom - 10], [box.right - 10, box.bottom - 10],
        ];
        return {
            insideChat: box.left >= chat.left && box.right <= chat.right,
            translucent: /\/\s*0?\.\d+\)|rgba\([^)]*,\s*0?\.\d+\)/.test(background),
            covered: corners.every(([x, y]) => element.contains(document.elementFromPoint(x, y))),
        };
    });
    expect(layout).toEqual({ insideChat: true, translucent: false, covered: true });

    await page.keyboard.press('ArrowRight');
    await expect(popover.locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(popover).not.toHaveAttribute('data-sb-open');
    await expect(hint).toBeFocused();

    await hint.click();
    await expect(popover).toHaveAttribute('data-sb-open', '');
    await page.mouse.click(20, 400);
    await expect(popover).not.toHaveAttribute('data-sb-open');

    await hint.click();
    await popover.locator('.mes_copy').click();
    await expect(popover).not.toHaveAttribute('data-sb-open');
});

test('mobile edit row uses a popover and Escape keeps the edit open', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'The edit popover is mobile-only.');
    await seedChat(page);

    const message = page.locator(target);
    await message.locator('.mes_buttons .mes_edit').click();
    await expect(message.locator('.edit_textarea')).toBeVisible();

    const editRow = await message.locator('.mes_edit_buttons > *').evaluateAll(items => items
        .filter(item => item.getClientRects().length > 0)
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
        .map(item => item.classList[0]));
    expect(editRow).toEqual(['sb-mes-edit-more', 'mes_edit_done', 'mes_edit_cancel']);

    const more = message.locator('.mes_edit_buttons > .sb-mes-edit-more');
    const extra = message.locator('.mes_edit_buttons > .sb-mes-edit-extra');
    await more.click();
    await expect(extra).toHaveAttribute('data-sb-open', '');
    await expect(extra.locator('.mes_edit_copy')).toBeVisible();

    // Wait out the edit-entry animation; its final state must not trap the popover under the textarea.
    await page.waitForTimeout(300);
    const covered = await extra.evaluate(element => {
        const box = element.getBoundingClientRect();
        return [
            [box.left + 10, box.top + 10], [box.right - 10, box.top + 10],
            [box.left + 10, box.bottom - 10], [box.right - 10, box.bottom - 10],
        ].every(([x, y]) => element.contains(document.elementFromPoint(x, y)));
    });
    expect(covered).toBe(true);

    await page.keyboard.press('Escape');
    await expect(extra).not.toHaveAttribute('data-sb-open');
    await expect(message.locator('.edit_textarea')).toBeVisible();

    await message.locator('.mes_edit_cancel').click();
    await expect(message.locator('.edit_textarea')).toHaveCount(0);
});

test('row popover stays above a neighbouring message that is being edited', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'The popover layout is mobile-only.');
    await seedChat(page);

    const editing = page.locator('#chat .mes[mesid="5"]');
    await editing.locator('.mes_buttons .mes_edit').click();
    await expect(editing.locator('.edit_textarea')).toBeVisible();
    await page.waitForTimeout(300);

    const message = page.locator(target);
    await message.scrollIntoViewIfNeeded();
    await message.locator('.mes_buttons > .extraMesButtonsHint').click();
    const popover = message.locator('.mes_buttons > .extraMesButtons');
    await expect(popover).toHaveAttribute('data-sb-open', '');
    const covered = await popover.evaluate(element => {
        const box = element.getBoundingClientRect();
        return [
            [box.left + 10, box.top + 10], [box.right - 10, box.top + 10],
            [box.left + 10, box.bottom - 10], [box.right - 10, box.bottom - 10],
        ].every(([x, y]) => element.contains(document.elementFromPoint(x, y)));
    });
    expect(covered).toBe(true);
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

test('desktop keeps inline expansion and truncates long names first', async ({ page, isMobile }) => {
    test.skip(isMobile, 'Inline expansion is desktop-only.');
    await seedChat(page, { longName: true });

    const message = page.locator(target);
    const hint = message.locator('.mes_buttons > .extraMesButtonsHint');
    const extras = message.locator('.mes_buttons > .extraMesButtons');

    const name = await message.locator('.name_text').evaluate(element => {
        const style = getComputedStyle(element);
        return { ellipsis: style.textOverflow === 'ellipsis', truncated: element.scrollWidth > element.clientWidth };
    });
    expect(name).toEqual({ ellipsis: true, truncated: true });

    await message.hover();
    await hint.click();
    await expect(extras).toHaveCSS('display', 'flex');
    await expect(extras).not.toHaveAttribute('data-sb-open');
    await expect(extras).not.toHaveAttribute('role');

    const order = await visibleRowButtons(page, target);
    expect(order.indexOf('mes_bookmark')).toBeLessThan(order.indexOf('mes_edit'));
});

test('echo user messages anchor actions and the popover to their start edge', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'The mirrored popover check is mobile-only.');
    await seedChat(page);
    await page.evaluate(() => $('#chat_display').val('3').trigger('change'));
    await expect(page.locator('body')).toHaveClass(/echostyle/);

    const userMessage = '#chat .mes[mesid="5"]';
    await page.locator(userMessage).scrollIntoViewIfNeeded();
    const hint = page.locator(`${userMessage} .mes_buttons > .extraMesButtonsHint`);
    const popover = page.locator(`${userMessage} .mes_buttons > .extraMesButtons`);

    const sides = await page.locator(userMessage).evaluate(element => ({
        buttons: element.querySelector('.mes_buttons').getBoundingClientRect().left,
        name: element.querySelector('.name_text').getBoundingClientRect().left,
    }));
    expect(sides.buttons).toBeLessThan(sides.name);

    await hint.click();
    await expect(popover).toHaveAttribute('data-sb-open', '');
    const bounds = await popover.evaluate(element => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, viewport: window.innerWidth };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewport);
});
