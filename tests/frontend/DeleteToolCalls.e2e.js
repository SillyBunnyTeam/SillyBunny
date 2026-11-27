import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test.describe('deleting assistant messages with tool calls', () => {
    test.beforeEach(testSetup.awaitST);

    test('deletes preceding tool calls unless explicitly disabled', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { addOneMessage, chat, deleteMessage, newAssistantChat } = await import('./script.js');
            const commands = window.SillyTavern.getContext().SlashCommandParser.commands;
            const testMessages = new Set(['Run a tool', 'Tool result', 'Done']);
            const snapshot = () => chat
                .filter(message => testMessages.has(message.mes))
                .map(message => ({
                    mes: message.mes,
                    toolCall: Array.isArray(message.extra?.tool_invocations),
                }));

            const addMessages = async () => {
                const messages = [
                    { name: 'User', is_user: true, is_system: false, mes: 'Run a tool', extra: {} },
                    {
                        name: 'System',
                        is_user: false,
                        is_system: true,
                        mes: 'Tool result',
                        extra: { isSmallSys: true, tool_invocations: [{ id: 'call-1', name: 'lookup' }] },
                    },
                    { name: 'Assistant', is_user: false, is_system: false, mes: 'Done', extra: {} },
                ];
                for (const message of messages) {
                    chat.push(message);
                    await addOneMessage(message);
                }
            };

            await newAssistantChat({ temporary: true });
            await addMessages();
            await deleteMessage(chat.length - 1, undefined, false);
            const automatic = snapshot();

            await newAssistantChat({ temporary: true });
            await addMessages();
            await commands.cut.callback({ toolcalls: 'false' }, String(chat.length - 1));
            const disabled = snapshot();

            await newAssistantChat({ temporary: true });
            await addMessages();
            chat.push({ name: 'Assistant', is_user: false, is_system: false, mes: 'Later', extra: {} });
            await addOneMessage(chat.at(-1));
            await commands.del.callback({ toolcalls: 'true' }, '2');
            const range = chat
                .filter(message => new Set([...testMessages, 'Later']).has(message.mes))
                .map(message => message.mes);

            return { automatic, disabled, range };
        });

        expect(result.automatic).toEqual([{ mes: 'Run a tool', toolCall: false }]);
        expect(result.disabled).toEqual([
            { mes: 'Run a tool', toolCall: false },
            { mes: 'Tool result', toolCall: true },
        ]);
        expect(result.range).toEqual(['Run a tool']);
    });

    test('the selection mode selects and deletes a tool call with its assistant message', async ({ page }) => {
        await page.evaluate(async () => {
            const { addOneMessage, chat, newAssistantChat } = await import('./script.js');
            await newAssistantChat({ temporary: true });
            const messages = [
                { name: 'User', is_user: true, is_system: false, mes: 'Run a tool', extra: {} },
                {
                    name: 'System',
                    is_user: false,
                    is_system: true,
                    mes: 'Tool result',
                    extra: { isSmallSys: true, tool_invocations: [{ id: 'call-1', name: 'lookup' }] },
                },
                { name: 'Assistant', is_user: false, is_system: false, mes: 'Done', extra: {} },
            ];
            for (const message of messages) {
                chat.push(message);
                await addOneMessage(message);
            }
        });

        await page.locator('#option_delete_mes').evaluate(item => item.click());
        await expect(page.locator('#sheld')).toHaveAttribute('data-selection-mode', 'true');
        // The tool call is a row of its own, and choosing it chooses the message it belongs to.
        await page.locator('#chat .mes', { hasText: 'Tool result' }).locator('.mes_text').click();
        await expect(page.locator('#dialogue_del_mes_count')).toHaveText('2 Selected');
        await expect(page.locator('#chat .mes.is-selection-selected')).toHaveCount(2);
        await page.locator('#dialogue_del_mes_ok').click();
        await page.locator('dialog[open]').getByRole('button', { name: 'Delete' }).click();

        await expect.poll(() => page.evaluate(async () => (await import('./script.js')).chat
            .filter(message => ['Run a tool', 'Tool result', 'Done'].includes(message.mes))
            .map(message => message.mes))).toEqual(['Run a tool']);
    });
});
