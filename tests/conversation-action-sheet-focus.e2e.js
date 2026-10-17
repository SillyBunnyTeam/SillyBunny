import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });

const MESSAGE_TEXT = 'A disposable message for sheet focus checks.';

async function openConversation(page, baseURL) {
    const origin = new URL(baseURL).origin;
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname);
    let settingsVersion = Date.now();
    const readEndpoints = new Set([
        '/api/characters/all', '/api/characters/chats', '/api/groups/all', '/api/backgrounds/all',
        '/api/avatars/get', '/api/stats/get', '/api/secrets/read', '/api/users/me',
    ]);
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/api/extensions/discover') {
            const response = await route.fetch();
            const extensions = await response.json();
            return route.fulfill({ json: extensions.filter(extension => !extension.name.startsWith('third-party/')) });
        }
        if (url.pathname === '/api/settings/get') {
            const response = await route.fetch();
            const data = await response.json();
            const settings = JSON.parse(data.settings);
            settings.firstRun = false;
            settings.power_user.auto_connect = false;
            settings.power_user.reduced_motion = false;
            settings.extension_settings.sillybunny_conversation = {};
            settings.extension_settings['quick-image-gen'] = { setupWizardSeen: true };
            data.request_compression = { ...data.request_compression, enabled: false };
            data.settings = JSON.stringify(settings);
            return route.fulfill({ json: data });
        }
        if (url.pathname === '/api/settings/save') {
            return route.fulfill({ json: { version: ++settingsVersion } });
        }
        if (readEndpoints.has(url.pathname) || url.pathname.startsWith('/api/tokenizers/')) {
            return route.continue();
        }
        if (url.pathname.startsWith('/api/backends/')) {
            return route.fulfill({ json: { data: [] } });
        }
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) {
            return route.fulfill({ json: {} });
        }
        return route.continue();
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    // The context option disables the sheet spring motion, so the focus checks time against hidden state only.
    expect(await page.evaluate(async () => {
        const { prefersReducedMotion } = await import('/scripts/sillybunny-motion.js');
        return prefersReducedMotion();
    })).toBe(true);
    await page.evaluate(async ({ text }) => {
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        const { stopConversationAutoWorker } = await import('/scripts/sillybunny-conversation/auto-engine.js');
        const { appendConversationThreadMessage } = await import('/scripts/sillybunny-conversation/thread-store.js');
        const { renderConversationTimeline } = await import('/scripts/sillybunny-conversation/timeline-render.js');
        const { getSettings, saveSettings } = await import('/scripts/sillybunny-conversation/settings-store.js');
        const context = window.SillyTavern.getContext();
        const character = context.characters.find(entry => /Bunny Guide|Seraphina/.test(entry?.name ?? ''));
        if (!character?.avatar) throw new Error('No bundled Conversation character found.');
        openConversationWorkspaceForAvatar(character.avatar, { showToast: false });
        stopConversationAutoWorker();
        saveSettings(character.avatar, { ...getSettings(character.avatar), editable_messages: true });
        appendConversationThreadMessage(character.avatar, { role: 'assistant', name: 'Bunny Guide', mes: text, extra: {} });
        renderConversationTimeline();
    }, { text: MESSAGE_TEXT });
    const message = page.locator('.sb-conversation-message').filter({ hasText: MESSAGE_TEXT });
    await expect(message).toBeVisible();
    const messageId = await message.getAttribute('data-message-id');
    return page.locator(`.sb-conversation-message[data-message-id="${messageId}"]`);
}

async function openSheet(page, trigger) {
    await trigger.focus();
    await trigger.press('Enter');
    const sheet = page.locator('.sb-action-sheet');
    await expect(sheet).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('menu', { name: 'Message Actions' })).toBeVisible();
    return sheet;
}

function getMenu(page) {
    return page.getByRole('menu', { name: 'Message Actions' });
}

const dismissals = [
    {
        name: 'Close button',
        slug: 'close',
        dismiss: (page, sheet) => sheet.getByRole('button', { name: 'Close', exact: true }).click(),
    },
    {
        name: 'Copy message row',
        slug: 'row',
        dismiss: (page) => getMenu(page).getByRole('menuitem', { name: 'Copy message', exact: true }).click(),
    },
    {
        name: 'backdrop tap',
        slug: 'backdrop',
        dismiss: (page) => page.locator('.sb-action-sheet-backdrop').click({ position: { x: 24, y: 24 } }),
    },
];

for (const { name, slug, dismiss } of dismissals) {
    test(`mobile action sheet ${name} returns focus to the message trigger`, async ({ page, baseURL }, testInfo) => {
        test.setTimeout(60000);
        await page.setViewportSize({ width: 390, height: 844 });
        const message = await openConversation(page, baseURL);
        const trigger = message.locator('.sb-conversation-mobile-menu-trigger');
        const sheet = await openSheet(page, trigger);
        await page.screenshot({ path: testInfo.outputPath(`${slug}-open.png`) });
        await dismiss(page, sheet);
        await expect(sheet).toBeHidden();
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');
        await expect(trigger).toBeFocused();
        await page.screenshot({ path: testInfo.outputPath(`${slug}-closed.png`) });
    });
}

test('mobile action sheet reaction chip returns focus to the message trigger before the reaction applies', async ({ page, baseURL }, testInfo) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: 390, height: 844 });
    const message = await openConversation(page, baseURL);
    const trigger = message.locator('.sb-conversation-mobile-menu-trigger');
    const sheet = await openSheet(page, trigger);
    // The reaction re-renders the message row, so the order of events is recorded on the
    // original trigger node instead of reading focus back after the row has been replaced.
    await trigger.evaluate(node => {
        window.__sbFocusLog = [];
        node.addEventListener('focusin', () => window.__sbFocusLog.push('focus:trigger'));
        document.addEventListener('click', event => {
            if (event.target instanceof Element && event.target.closest('.sb-conversation-message-actions .sb-conversation-reaction-button')) {
                window.__sbFocusLog.push(document.activeElement === node ? 'click:reaction:trigger-focused' : 'click:reaction:trigger-blurred');
            }
        }, true);
    });
    await page.screenshot({ path: testInfo.outputPath('chip-open.png') });
    await getMenu(page).getByRole('menuitemcheckbox').first().click();
    await expect(sheet).toBeHidden();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(() => page.evaluate(() => window.__sbFocusLog)).toEqual(['focus:trigger', 'click:reaction:trigger-focused']);
    await expect(message.locator('.sb-conversation-reaction-button[aria-pressed="true"]')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('chip-closed.png') });
});

test('mobile action sheet reaction chip leaves the re-rendered message trigger focused', async ({ page, baseURL }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: 390, height: 844 });
    const message = await openConversation(page, baseURL);
    const trigger = message.locator('.sb-conversation-mobile-menu-trigger');
    const sheet = await openSheet(page, trigger);
    await getMenu(page).getByRole('menuitemcheckbox').first().click();
    await expect(sheet).toBeHidden();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(message.locator('.sb-conversation-reaction-button[aria-pressed="true"]')).toHaveCount(1);
    await expect(trigger).toBeFocused();
});

test('desktop reaction menu leaves the re-rendered message trigger focused', async ({ page, baseURL }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const message = await openConversation(page, baseURL);
    const trigger = message.locator('.sb-conversation-message-menu');
    await trigger.focus();
    await trigger.press('Enter');
    const menu = getMenu(page);
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitemcheckbox').first().click();
    await expect(menu).toBeHidden();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(message.locator('.sb-conversation-reaction-button[aria-pressed="true"]')).toHaveCount(1);
    await expect(trigger).toBeFocused();
});

test('a delayed reaction render preserves focus moved to the composer', async ({ page, baseURL }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: 390, height: 844 });
    const message = await openConversation(page, baseURL);
    const trigger = message.locator('.sb-conversation-mobile-menu-trigger');
    const sheet = await openSheet(page, trigger);
    await page.evaluate(async () => {
        const { flushConversationRenders, registerConversationRenderer } = await import('/scripts/sillybunny-conversation/render-scheduler.js');
        flushConversationRenders();
        window.__sbPendingTimelineRender = false;
        registerConversationRenderer('timeline', () => { window.__sbPendingTimelineRender = true; });
    });
    await getMenu(page).getByRole('menuitemcheckbox').first().click();
    await expect(sheet).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__sbPendingTimelineRender)).toBe(true);
    await expect(trigger).toBeFocused();
    await expect(message.locator('.sb-conversation-reaction-button[aria-pressed="true"]')).toHaveCount(0);
    const composer = page.locator('#sb_conversation_input');
    await composer.focus();
    await page.evaluate(async () => {
        const { registerConversationRenderer } = await import('/scripts/sillybunny-conversation/render-scheduler.js');
        const { renderConversationTimeline } = await import('/scripts/sillybunny-conversation/timeline-render.js');
        registerConversationRenderer('timeline', renderConversationTimeline);
        renderConversationTimeline();
    });
    await expect(message.locator('.sb-conversation-reaction-button[aria-pressed="true"]')).toHaveCount(1);
    await expect(composer).toBeFocused();
});
