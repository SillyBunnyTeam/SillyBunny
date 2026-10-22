import { expect, test } from '@playwright/test';
import { bootUtilityDialogs, UTILITY_VIEWPORTS } from './helpers/utility-dialogs.js';

test.setTimeout(90000);
test.use({ serviceWorkers: 'block' });

const automation = ['preventAutoExecute', 'isHidden', 'executeOnStartup', 'executeOnUser', 'executeOnAi', 'executeOnChatChange', 'executeOnNewChat', 'executeOnGroupMemberDraft', 'executeBeforeGeneration'];

async function openEditor(page) {
    await page.context().route(/\/api\/(?:backends\/[^/]+\/generate(?:\/.*)?|generate|novelai\/generate|horde\/generate)$/, route => route.fulfill({ status: 400, body: 'Generation disabled in Quick Reply editor tests' }));
    await page.evaluate(async () => {
        if (!window.__qrEditorFixture) {
            const { QuickReplySet } = await import('/scripts/extensions/quick-reply/src/QuickReplySet.js');
            const set = QuickReplySet.from({ name: 'Editor Characterisation' });
            QuickReplySet.list.push(set);
            const reply = set.addQuickReply({ label: 'Original label', title: 'Original title', message: '/pass original', icon: 'fa-star' });
            window.__qrEditorFixture = { set, reply };
        }
        void window.__qrEditorFixture.reply.showEditor();
    });
    const popup = page.locator('dialog.popup[open]:has(#qr--modalEditor)');
    await popup.locator('#qr--modal-label').waitFor();
    await page.waitForFunction(() => !document.querySelector('dialog.popup[open][opening]'));
    return popup;
}

async function readReply(page) {
    return page.evaluate(() => JSON.parse(JSON.stringify(window.__qrEditorFixture.reply)));
}

async function setMessage(popup, message) {
    await popup.locator('#qr--modal-message').fill(message);
    await expect.poll(() => popup.page().evaluate(() => window.__qrEditorFixture.reply.message)).toBe(message);
}

async function expectDebuggerLayout(popup, mode, expect) {
    const layout = await popup.evaluate(dialog => {
        const bounds = selector => {
            const { x, y, width, height, right, bottom } = dialog.querySelector(selector).getBoundingClientRect();
            return { x, y, width, height, right, bottom };
        };
        return {
            body: bounds('.popup-body'),
            editor: bounds('#qr--modalEditor'),
            main: bounds('#qr--main'),
            options: bounds('#qr--qrOptions'),
            debug: bounds('#qr--modal-debugState'),
            direction: getComputedStyle(dialog.querySelector('#qr--modalEditor')).flexDirection,
        };
    });
    if (mode === 'split') {
        expect(layout.direction).toBe('row');
        expect(layout.options.x).toBeGreaterThan(layout.main.x);
        expect(layout.main.right).toBeLessThanOrEqual(layout.options.x + 8);
        return;
    }
    expect(layout.options.width / layout.body.width).toBeGreaterThanOrEqual(0.9);
    expect(layout.debug.width / layout.body.width).toBeGreaterThanOrEqual(0.9);
    expect(layout.direction).toBe('column');
    expect(layout.options.y).toBeGreaterThanOrEqual(layout.main.bottom);
}

for (const viewport of UTILITY_VIEWPORTS) {
    const size = `${viewport.width}×${viewport.height}`;

    test(`Quick Reply editor applies fields and automation before Close and Escape at ${size}`, async ({ page }) => {
        const state = await bootUtilityDialogs(page, viewport);
        let popup = await openEditor(page);
        await expect(popup).toHaveClass(/sb-dialog--window/);
        await expect(popup).toHaveAttribute('data-presentation', viewport.presentation);
        await expect(popup.locator('.sb-dialog__header .sb-dialog__close')).toBeInViewport();
        await expect(popup.locator('.popup-button-ok')).toBeHidden();
        await expect(popup.locator('.popup-button-cancel')).toBeHidden();
        await popup.locator('#qr--modal-label').fill('Changed label');
        await popup.locator('#qr--modal-title').fill('  Kept title whitespace  ');
        await popup.locator('#qr--modal-showLabel').check();
        await setMessage(popup, '/pass changed');
        for (const key of automation) await popup.locator(`#qr--${key}`).setChecked(key !== 'preventAutoExecute');
        await popup.locator('#qr--automationId').fill('  automation-id  ');
        const expected = {
            label: 'Changed label', title: '  Kept title whitespace  ', message: '/pass changed', showLabel: true, automationId: '  automation-id  ',
            ...Object.fromEntries(automation.map(key => [key, key !== 'preventAutoExecute'])),
        };
        expect(await readReply(page)).toMatchObject(expected);
        await expect.poll(() => state.replies.some(set => set.qrList?.some(reply => reply.label === expected.label && reply.automationId === expected.automationId))).toBe(true);
        await popup.locator('.sb-dialog__close').click();
        await expect(popup).toHaveCount(0);
        expect(await readReply(page)).toMatchObject(expected);
        popup = await openEditor(page);
        await expect(popup.locator('#qr--modal-title')).toHaveValue(expected.title);
        await expect(popup.locator('#qr--automationId')).toHaveValue(expected.automationId);
        await popup.locator('#qr--modal-label').fill('Escape also keeps changes');
        await page.keyboard.press('Escape');
        await expect(popup).toHaveCount(0);
        expect(await readReply(page)).toMatchObject({ ...expected, label: 'Escape also keeps changes' });
    });

    test(`Quick Reply icon selection, No Icon and nested Escape preserve editor state at ${size}`, async ({ page }) => {
        await bootUtilityDialogs(page, viewport);
        const popup = await openEditor(page);
        await popup.locator('#qr--modal-icon').click();
        let picker = page.locator('dialog.popup[open]:has(.faPicker-container)');
        await expect(picker).toHaveClass(/sb-dialog--page/);
        await expect(popup).toHaveAttribute('inert', '');
        const parentBounds = await popup.boundingBox();
        const childBounds = await picker.boundingBox();
        for (const key of ['x', 'y', 'width', 'height']) expect(Math.abs(parentBounds[key] - childBounds[key])).toBeLessThanOrEqual(1);
        await expect(picker.locator('.sb-dialog__header .popup-button-cancel')).toBeInViewport();
        await picker.locator('.faQuery').fill('heart');
        await picker.locator('.faPicker > .fa-heart:not(.hidden)').first().click();
        await expect(picker).toHaveCount(0);
        await expect(popup).not.toHaveAttribute('inert');
        expect(await readReply(page)).toMatchObject({ icon: 'fa-heart' });
        await popup.locator('#qr--modal-icon').click();
        picker = page.locator('dialog.popup[open]:has(.faPicker-container)');
        await picker.locator('.popup-button-ok').click();
        await expect(picker).toHaveCount(0);
        expect(await readReply(page)).toMatchObject({ icon: '' });
        await popup.locator('#qr--modal-icon').click();
        picker = page.locator('dialog.popup[open]:has(.faPicker-container)');
        await picker.locator('.popup-button-cancel').click();
        await expect(picker).toHaveCount(0);
        await popup.locator('#qr--modal-icon').click();
        await page.locator('dialog.popup[open]:has(.faPicker-container) .faQuery').waitFor();
        await page.keyboard.press('Escape');
        await expect(page.locator('.faPicker-container')).toHaveCount(0);
        await expect(popup).toBeVisible();
        expect(await readReply(page)).toMatchObject({ icon: '', label: 'Original label', message: '/pass original' });
    });

    test(`Quick Reply editor preferences and dynamic context rows keep source values at ${size}`, async ({ page }) => {
        await bootUtilityDialogs(page, viewport);
        const popup = await openEditor(page);
        for (const [id, checked] of [['wrap', true], ['executeShortcut', false], ['syntax', false]]) {
            await popup.locator(`#qr--modal-${id}`).setChecked(checked);
        }
        await popup.locator('#qr--modal-tabSize').fill('2');
        await popup.locator('#qr--modal-tabSize').dispatchEvent('change');
        await expect(popup.locator('#qr--modal-message')).toHaveCSS('white-space', 'pre-wrap');
        await expect(popup.locator('#qr--modal-message')).toHaveCSS('tab-size', '2');
        await expect(popup.locator('#qr--modal-messageHolder')).toHaveClass(/qr--noSyntax/);
        expect(await page.evaluate(async () => {
            const { accountStorage } = await import('/scripts/util/AccountStorage.js');
            return ['wrap', 'executeShortcut', 'syntax', 'tabSize'].map(key => JSON.parse(accountStorage.getItem(`qr--${key}`)));
        })).toEqual([true, false, false, 2]);
        await popup.locator('#qr--ctxAdd').click();
        const context = popup.locator('#qr--ctxEditor .qr--ctxItem');
        await context.locator('.ds-select-row__trigger').click();
        await page.locator('.sb-picker, .sb-picker-sheet').last().getByRole('option', { name: 'Editor Characterisation', exact: true }).click();
        await context.locator('.qr--isChained').check();
        expect(await page.evaluate(() => window.__qrEditorFixture.reply.contextList.map(link => ({ name: link.set.name, isChained: link.isChained })))).toEqual([{ name: 'Editor Characterisation', isChained: true }]);
        await context.locator('.qr--delete').click();
        await expect(context).toHaveCount(0);
        expect(await page.evaluate(() => window.__qrEditorFixture.reply.contextList.length)).toBe(0);
    });

    test(`Quick Reply execution, debugger minimize, step, resume and close guard at ${size}`, async ({ page }) => {
        await bootUtilityDialogs(page, viewport);
        const popup = await openEditor(page);
        await popup.locator('#qr--modal-send_textarea').fill('Mirror input');
        await expect(page.locator('#send_textarea')).toHaveValue('Mirror input');
        await setMessage(popup, '/pass result-fixture');
        await popup.locator('#qr--modal-execute').click();
        await expect(popup.locator('#qr--modal-executeResult')).toHaveText('result-fixture');
        await expect(popup.locator('#qr--modal-executeProgress')).toHaveClass(/qr--success/);
        await setMessage(popup, '/breakpoint | /pass debug-fixture | /pass final-fixture');
        await popup.locator('#qr--modal-execute').click();
        const editor = popup.locator('#qr--modalEditor');
        await expect(editor).toHaveClass(/qr--isExecuting.*qr--isPaused/);
        await expect(popup.locator('#qr--modal-debugState')).toContainText('Call Stack');
        await page.keyboard.press('Escape');
        await expect(popup).toBeVisible();
        await expect(editor).toHaveClass(/qr--isExecuting/);
        await popup.locator('#qr--modal-minimize').click();
        await expect(editor).toHaveClass(/qr--minimized/);
        await expect(popup.locator('#qr--main')).toBeHidden();
        // HEAD's minimized frame collapses its content to zero width; characterize the
        // upstream state and handler here, and test repaired geometry separately.
        await expect(popup.locator('#qr--modal-maximize')).toHaveCSS('display', 'flex');
        await expect(popup.locator('#qr--modal-minimize')).toBeHidden();
        await popup.locator('#qr--modal-maximize').dispatchEvent('click');
        await expect(editor).not.toHaveClass(/qr--minimized/);
        await expect(popup.locator('#qr--main')).toBeVisible();
        await popup.locator('#qr--modal-step').click();
        await expect(editor).toHaveClass(/qr--isPaused/);
        await popup.locator('#qr--modal-resume').click();
        await expect(editor).not.toHaveClass(/qr--isExecuting/);
        await expect(popup.locator('#qr--modal-executeResult')).toHaveText('final-fixture');
        await expect(popup.locator('#qr--modal-message')).toHaveValue('/breakpoint | /pass debug-fixture | /pass final-fixture');
        await popup.locator('.sb-dialog__close').click();
        await expect(popup).toHaveCount(0);
    });

    test(`Quick Reply pause, continue, abort and parser errors keep upstream results at ${size}`, async ({ page }) => {
        await bootUtilityDialogs(page, viewport);
        const popup = await openEditor(page);
        await setMessage(popup, '/delay 5000 | /pass unreachable-after-abort');
        await popup.locator('#qr--modal-execute').click();
        await expect(popup.locator('#qr--modalEditor')).toHaveClass(/qr--isExecuting/);
        await popup.locator('#qr--modal-pause').click();
        await expect(popup.locator('#qr--modal-executeProgress')).toHaveClass(/qr--paused/);
        expect(await page.evaluate(() => window.__qrEditorFixture.reply.abortController.signal.paused)).toBe(true);
        await popup.locator('#qr--modal-pause').click();
        await expect(popup.locator('#qr--modal-executeProgress')).not.toHaveClass(/qr--paused/);
        await popup.locator('#qr--modal-stop').click();
        await expect(popup.locator('#qr--modalEditor')).not.toHaveClass(/qr--isExecuting/, { timeout: 10000 });
        await expect(popup.locator('#qr--modal-executeProgress')).toHaveClass(/qr--aborted/);
        await expect(popup.locator('#qr--modal-executeResult')).toBeHidden();
        await setMessage(popup, '/characterisation-command-does-not-exist');
        await popup.locator('#qr--modal-execute').click();
        await expect(popup.locator('#qr--modal-executeErrors')).toHaveClass(/qr--hasErrors/);
        await expect(popup.locator('#qr--modal-executeProgress')).toHaveClass(/qr--error/);
        await popup.locator('.sb-dialog__close').click();
        await expect(popup).toHaveCount(0);
    });

    test(`Quick Reply editor Ctrl+Enter, F9 and Ctrl+Backslash shortcuts work at ${size}`, async ({ page }) => {
        await bootUtilityDialogs(page, viewport);
        const popup = await openEditor(page);
        const message = popup.locator('#qr--modal-message');
        await popup.locator('#qr--modal-executeShortcut').check();
        await setMessage(popup, '/pass ctrl-enter-fixture');
        await message.focus();
        await page.keyboard.press('Control+Enter');
        await expect(popup.locator('#qr--modal-executeResult')).toHaveText('ctrl-enter-fixture');
        await expect(message).toBeFocused();

        await setMessage(popup, '/pass breakpoint-fixture');
        await message.focus();
        await page.keyboard.press('F9');
        await expect(message).toHaveValue('/breakpoint |/pass breakpoint-fixture');
        await page.keyboard.press('F9');
        await expect(message).toHaveValue('/pass breakpoint-fixture');

        await setMessage(popup, '/pass comment-fixture\n/pass trailing-fixture');
        await message.evaluate(input => { input.setSelectionRange(6, 6); });
        await page.keyboard.press('Control+\\');
        await expect(message).toHaveValue('/* /pass comment-fixture *|\n/pass trailing-fixture');
        await message.evaluate(input => { input.setSelectionRange(6, 6); });
        await page.keyboard.press('Control+\\');
        await expect(message).toHaveValue('/pass comment-fixture\n/pass trailing-fixture');
    });
}

test('Quick Reply desktop debugger keeps its upstream resize handle', async ({ page }) => {
    await bootUtilityDialogs(page, UTILITY_VIEWPORTS[0]);
    const popup = await openEditor(page);
    await setMessage(popup, '/breakpoint | /pass resize-fixture');
    await popup.locator('#qr--modal-execute').click();
    await expect(popup.locator('#qr--modalEditor')).toHaveClass(/qr--isPaused/);
    const handle = popup.locator('#qr--resizeHandle');
    await handle.scrollIntoViewIfNeeded();
    const bounds = await handle.boundingBox();
    const before = (await popup.locator('#qr--qrOptions').boundingBox()).width;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 8);
    await page.mouse.down();
    await page.mouse.move(bounds.x - 30, bounds.y + 8, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await popup.locator('#qr--qrOptions').boundingBox()).width).toBeGreaterThan(before + 20);
    await popup.locator('#qr--modal-resume').click();
    await expect(popup.locator('#qr--modal-executeResult')).toHaveText('resize-fixture');
});

for (const viewport of [...UTILITY_VIEWPORTS, { width: 844, height: 390, presentation: 'floating' }]) {
    test(`Quick Reply frame owns scrolling and minimized debugger stays operable at ${viewport.width}×${viewport.height}`, async ({ page }) => {
        await bootUtilityDialogs(page, viewport);
        const popup = await openEditor(page);
        await expect(popup).toHaveAttribute('data-presentation', viewport.presentation);
        await expect(popup.locator('.sb-dialog__title')).toHaveText('Quick Reply');
        const content = popup.locator('.popup-content');
        await content.evaluate(node => { node.scrollTop = node.scrollHeight; });
        await expect(popup.locator('#qr--modal-send_textarea')).toBeInViewport();
        await expect(popup.locator('.sb-dialog__close')).toBeInViewport();
        expect(await popup.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        expect(await popup.locator('#qr--modalEditor, #qr--main, #qr--qrOptions, .qr--modal-messageContainer').evaluateAll(nodes => nodes.every(node => !['auto', 'scroll'].includes(getComputedStyle(node).overflowY)))).toBe(true);
        expect(await popup.locator('.ds-row-switch').evaluateAll(rows => rows.every(row => {
            const label = row.querySelector('.ds-row-text').getBoundingClientRect();
            const control = row.querySelector('input').getBoundingClientRect();
            return control.left >= label.right - 1 && row.lastElementChild.matches('input');
        }))).toBe(true);
        await setMessage(popup, '/breakpoint | /pass minimized-fixture');
        await popup.locator('#qr--modal-execute').click();
        await expect(popup.locator('#qr--modalEditor')).toHaveClass(/qr--isPaused/);
        await popup.locator('#qr--modal-debugState').scrollIntoViewIfNeeded();
        expect(await popup.locator('#qr--modal-debugState').evaluate(node => getComputedStyle(node).overflowY)).toBe('visible');
        await expectDebuggerLayout(popup, { 1440: 'split', 390: 'stacked', 844: 'stacked' }[viewport.width], expect);
        await popup.locator('#qr--modal-minimize').click();
        await expect(popup.locator('#qr--modal-maximize')).toBeInViewport();
        await expect(popup.locator('#qr--modal-resume')).toBeInViewport();
        expect((await popup.boundingBox()).width).toBeGreaterThan(300);
        expect(await popup.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        await popup.locator('#qr--modal-maximize').click();
        await popup.locator('#qr--modal-resume').click();
        await expect(popup.locator('#qr--modal-executeResult')).toHaveText('minimized-fixture');
    });
}
