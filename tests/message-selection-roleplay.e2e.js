import { expect, test } from '@playwright/test';
import { waitForAppReady } from './helpers/app-ready.js';

/*
 * Roleplay's "Delete messages" is the selection mode of the conversation timeline on the chat's message rows
 * (sillybunny-message-selection.js, sillybunny-editor/message-selection.js). The conversation side is in message-selection.e2e.js.
 */

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });

/* ---------- Roleplay: Options > Delete messages ---------- */

const MES = '#chat > .mes[mesid]';
const mes = (page, index) => page.locator(`#chat > .mes[mesid="${index}"]`);
const mesChecked = page => page.locator('#chat > .mes.is-selection-selected');
const mesTitle = page => page.locator('#dialogue_del_mes_count');

/** The chat that each roleplay test starts from: Message 0 to 9, alternating character and user, then the chat the tests add to it. */
const PLAIN_CHAT = Array.from({ length: 10 }, (_, index) => ({ who: index % 2 === 0 ? 'char' : 'user', mes: `Message ${index}` }));

/** Two tool calls belong to the assistant message that follows them (Message 4), a third to Message 9. */
const TOOL_CHAT = [
    { who: 'user', mes: 'U0' },
    { who: 'char', mes: 'C1' },
    { who: 'tool', mes: 'T2a' },
    { who: 'tool', mes: 'T2b' },
    { who: 'char', mes: 'C4' },
    { who: 'user', mes: 'U5' },
    { who: 'char', mes: 'C6' },
    { who: 'user', mes: 'U7' },
    { who: 'tool', mes: 'T8' },
    { who: 'char', mes: 'C9' },
    { who: 'user', mes: 'U10' },
];

async function openRoleplay(page, baseURL, messages = PLAIN_CHAT) {
    const origin = new URL(baseURL).origin;
    const saves = [];
    let settingsVersion = Date.now();
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/api/settings/save') {
            return route.fulfill({ json: { version: ++settingsVersion } });
        }
        if (url.pathname === '/api/chats/save') {
            saves.push(JSON.parse(route.request().postData() ?? '{}'));
            return route.fulfill({ json: {} });
        }
        return route.continue();
    });
    await page.goto('/');
    await waitForAppReady(page, { timeout: 60000 });
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
    await page.evaluate(async (items) => {
        const context = window.SillyTavern.getContext();
        context.chat.length = 0;
        document.querySelector('#chat').replaceChildren();
        for (const [index, item] of items.entries()) {
            const at = new Date(Date.UTC(2026, 8, 30, 12, index)).toISOString();
            if (item.who === 'tool') {
                context.chat.push({ name: 'System', is_user: false, is_system: true, send_date: at, mes: item.mes, extra: { isSmallSys: true, tool_invocations: [{ id: `call-${index}`, name: 'lookup' }] } });
            } else {
                context.chat.push({ name: item.who === 'user' ? 'Tester' : 'Seraphina', is_user: item.who === 'user', is_system: false, send_date: at, mes: item.mes, extra: {} });
            }
        }
        await context.printMessages();
        window.__deleted = [];
        context.eventSource.on(context.eventTypes.MESSAGE_DELETED, id => window.__deleted.push(id));
    }, messages);
    await expect(page.locator(MES)).toHaveCount(messages.length);
    // A chat load focuses the composer after a short wait; leaving that to the end keeps it from taking focus from a step.
    await expect(page.locator('#send_textarea')).toBeFocused();
    return { saves };
}

async function openDeleteMessages(page) {
    await page.locator('#options_button').click();
    await page.locator('#option_delete_mes').click();
    await expect(page.locator('#sheld')).toHaveAttribute('data-selection-mode', 'true');
}

async function confirmDelete(page) {
    await page.locator('#dialogue_del_mes_ok').click();
    await page.locator('dialog[open]').getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('#sheld')).toHaveAttribute('data-selection-mode', 'false');
}

const chatTexts = page => page.evaluate(() => window.SillyTavern.getContext().chat.map(message => message.mes));
const mesIds = page => page.locator(MES).evaluateAll(rows => rows.map(node => node.getAttribute('mesid')));
const checkedIds = page => mesChecked(page).evaluateAll(rows => rows.map(node => node.getAttribute('mesid')));

test.describe('roleplay Delete messages', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('Options > Delete messages starts it with the ids of the delete bar, and /del with no number starts it too', async ({ page, baseURL }) => {
        await openRoleplay(page, baseURL);
        await openDeleteMessages(page);

        await expect(page.locator('#dialogue_del_mes')).toBeVisible();
        await expect(page.locator('#dialogue_del_mes_cancel')).toBeVisible();
        await expect(mesTitle(page)).toHaveText('0 Selected');
        await expect(page.locator('#dialogue_del_mes_ok')).toBeDisabled();
        await expect(page.locator('#send_form')).toBeHidden();
        await expect(page.locator('#chat > .mes > .sb-selection-check')).toHaveCount(PLAIN_CHAT.length);

        await page.locator('#dialogue_del_mes_cancel').click();
        await expect(page.locator('#sheld')).toHaveAttribute('data-selection-mode', 'false');
        await expect(page.locator('#send_form')).toBeVisible();

        await page.evaluate(() => window.SillyTavern.getContext().SlashCommandParser.commands.del.callback({}, ''));
        await expect(page.locator('#sheld')).toHaveAttribute('data-selection-mode', 'true');
        await expect(mesTitle(page)).toHaveText('0 Selected');
    });

    test('it is refused while a reply is generating', async ({ page, baseURL }) => {
        await openRoleplay(page, baseURL);
        await page.evaluate(async () => (await import('/script.js')).setSendButtonState(true));
        await page.locator('#options_button').click();
        await page.locator('#option_delete_mes').click();
        await expect(page.locator('#dialogue_del_mes')).toBeHidden();
        await expect(page.locator('#sheld')).not.toHaveAttribute('data-selection-mode', 'true');
        await page.evaluate(async () => (await import('/script.js')).setSendButtonState(false));
    });

    test('a click toggles a message, Shift-click takes a range, and Select All takes every message', async ({ page, baseURL }) => {
        await openRoleplay(page, baseURL);
        await openDeleteMessages(page);

        await mes(page, 3).locator('.mes_text').click();
        expect(await checkedIds(page)).toEqual(['3']);
        await mes(page, 6).locator('.mes_text').click({ modifiers: ['Shift'] });
        expect(await checkedIds(page)).toEqual(['3', '4', '5', '6']);
        await mes(page, 8).locator('.mes_text').click();
        await mes(page, 4).locator('.mes_text').click();
        expect(await checkedIds(page)).toEqual(['3', '5', '6', '8']);
        await expect(mesTitle(page)).toHaveText('4 Selected');

        await page.locator('#sb_message_selection_header .sb-selection-select-all').click();
        await expect(mesTitle(page)).toHaveText(`${PLAIN_CHAT.length} Selected`);
    });

    test('a message and Shift-click on the last message is upstream\'s "this and everything after", and deleting it ends the chat there', async ({ page, baseURL }) => {
        const { saves } = await openRoleplay(page, baseURL);
        await openDeleteMessages(page);
        await mes(page, 6).locator('.mes_text').click();
        await mes(page, 9).locator('.mes_text').click({ modifiers: ['Shift'] });
        expect(await checkedIds(page)).toEqual(['6', '7', '8', '9']);

        await confirmDelete(page);
        expect(await chatTexts(page)).toEqual(PLAIN_CHAT.slice(0, 6).map(item => item.mes));
        expect(await mesIds(page)).toEqual(['0', '1', '2', '3', '4', '5']);
        await expect(mes(page, 5)).toHaveClass(/last_mes/);
        await expect.poll(() => saves.at(-1)?.allowShrink).toBe(true);
    });

    test('a block in the middle is spliced out, the rows renumber, and every message sends MESSAGE_DELETED once', async ({ page, baseURL }) => {
        const { saves } = await openRoleplay(page, baseURL);
        await openDeleteMessages(page);
        await mes(page, 2).locator('.mes_text').click();
        await mes(page, 4).locator('.mes_text').click({ modifiers: ['Shift'] });
        await mes(page, 6).locator('.mes_text').click({ modifiers: ['Shift'] });
        expect(await checkedIds(page)).toEqual(['2', '3', '4', '5', '6']);

        await confirmDelete(page);
        expect(await chatTexts(page)).toEqual(['Message 0', 'Message 1', 'Message 7', 'Message 8', 'Message 9']);
        expect(await mesIds(page)).toEqual(['0', '1', '2', '3', '4']);
        expect(await page.locator(MES).evaluateAll(rows => rows.map(node => node.querySelector('.mes_text')?.textContent?.trim()))).toEqual(['Message 0', 'Message 1', 'Message 7', 'Message 8', 'Message 9']);
        expect(await page.evaluate(() => window.__deleted)).toHaveLength(5);
        await expect.poll(() => saves.at(-1)?.allowShrink).toBe(true);
        expect(saves.at(-1).chat.slice(1).map(message => message.mes)).toEqual(['Message 0', 'Message 1', 'Message 7', 'Message 8', 'Message 9']);
    });

    test('a tool call is selected and deleted with the assistant message it belongs to, and a block in the middle keeps the rest in order', async ({ page, baseURL }) => {
        await openRoleplay(page, baseURL, TOOL_CHAT);
        await openDeleteMessages(page);

        await mes(page, 2).locator('.mes_text').click();
        expect(await checkedIds(page)).toEqual(['2', '3', '4']);
        await expect(mesTitle(page)).toHaveText('3 Selected');
        await mes(page, 4).locator('.mes_text').click();
        expect(await checkedIds(page)).toEqual([]);
        await mes(page, 8).locator('.mes_text').click();
        expect(await checkedIds(page)).toEqual(['8', '9']);
        await mes(page, 9).locator('.mes_text').click();

        await mes(page, 3).locator('.mes_text').click();
        await mes(page, 6).locator('.mes_text').click({ modifiers: ['Shift'] });
        expect(await checkedIds(page)).toEqual(['2', '3', '4', '5', '6']);
        await expect(mesTitle(page)).toHaveText('5 Selected');

        await confirmDelete(page);
        expect(await chatTexts(page)).toEqual(['U0', 'C1', 'U7', 'T8', 'C9', 'U10']);
        expect(await mesIds(page)).toEqual(['0', '1', '2', '3', '4', '5']);
        expect(await page.evaluate(() => window.__deleted)).toHaveLength(5);
    });

    test('/del with toolcalls=false selects a tool call on its own', async ({ page, baseURL }) => {
        await openRoleplay(page, baseURL, TOOL_CHAT);
        await page.evaluate(() => window.SillyTavern.getContext().SlashCommandParser.commands.del.callback({ toolcalls: 'false' }, ''));
        await expect(page.locator('#sheld')).toHaveAttribute('data-selection-mode', 'true');
        await mes(page, 2).locator('.mes_text').click();
        expect(await checkedIds(page)).toEqual(['2']);
    });

    test('Space and Shift+Space select from the keyboard, and Escape ends the mode from anywhere', async ({ page, baseURL }) => {
        await openRoleplay(page, baseURL);
        await openDeleteMessages(page);

        await mes(page, 2).focus();
        await page.keyboard.press('Space');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Shift+Space');
        expect(await checkedIds(page)).toEqual(['2', '3', '4']);

        await page.evaluate(() => document.activeElement?.blur());
        await page.locator('body').press('Escape');
        await expect(page.locator('#sheld')).toHaveAttribute('data-selection-mode', 'false');
        await expect(page.locator('#dialogue_del_mes')).toBeHidden();
    });

    test('per-message actions are off while it is on, and a Delete that is cancelled in the alert keeps the selection', async ({ page, baseURL }) => {
        await openRoleplay(page, baseURL);
        await openDeleteMessages(page);
        await mes(page, 4).locator('.mes_text').click();

        await mes(page, 4).hover();
        await expect(mes(page, 4).locator('.mes_buttons')).toBeHidden();
        await mes(page, 4).locator('.ch_name').click({ button: 'right' });
        await expect(page.locator('.sb-action-popover')).toHaveCount(0);
        const style = await mes(page, 4).evaluate(node => ({ standard: getComputedStyle(node).userSelect, webkit: getComputedStyle(node).webkitUserSelect }));
        expect(style).toEqual({ standard: 'none', webkit: 'none' });

        await page.locator('#dialogue_del_mes_ok').click();
        await expect(page.locator('dialog[open]')).toContainText('Delete Message?');
        await page.locator('dialog[open]').getByRole('button', { name: 'Cancel' }).click();
        expect(await checkedIds(page)).toEqual(['4']);
        expect(await chatTexts(page)).toHaveLength(PLAIN_CHAT.length);
    });
});

test.describe('roleplay Delete messages on a touch screen', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('taps toggle, Select to End takes the rest of the chat, and a long press on a message does not start it', async ({ page, baseURL }) => {
        await openRoleplay(page, baseURL);
        await mes(page, 2).locator('.mes_text').dispatchEvent('contextmenu');
        await expect(page.locator('#sheld')).not.toHaveAttribute('data-selection-mode', 'true');

        await openDeleteMessages(page);
        await mes(page, 4).locator('.mes_text').tap();
        await mes(page, 6).locator('.mes_text').tap();
        expect(await checkedIds(page)).toEqual(['4', '6']);
        const toEnd = page.locator('#dialogue_del_mes [data-action-id="select-to-end"]');
        await expect(toEnd).toBeVisible();
        await toEnd.tap();
        expect(await checkedIds(page)).toEqual(['4', '5', '6', '7', '8', '9']);
        await expect(mesTitle(page)).toHaveText('6 Selected');
    });
});
