import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });

async function openConversation(page, baseURL, { ooc = false } = {}) {
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
    await page.evaluate(async ({ ooc }) => {
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        const { stopConversationAutoWorker } = await import('/scripts/sillybunny-conversation/auto-engine.js');
        const { appendConversationThreadMessage } = await import('/scripts/sillybunny-conversation/thread-store.js');
        const { handleConversationSlashAction } = await import('/scripts/sillybunny-conversation/timeline-slash-commands.js');
        const { renderConversationTimeline } = await import('/scripts/sillybunny-conversation/timeline-render.js');
        const { getSettings, saveSettings } = await import('/scripts/sillybunny-conversation/settings-store.js');
        const context = window.SillyTavern.getContext();
        const character = context.characters.find(entry => /Bunny Guide|Seraphina/.test(entry?.name ?? ''));
        if (!character?.avatar) throw new Error('No bundled Conversation character found.');
        openConversationWorkspaceForAvatar(character.avatar, { showToast: false });
        stopConversationAutoWorker();
        saveSettings(character.avatar, { ...getSettings(character.avatar), editable_messages: true });
        if (ooc) {
            await handleConversationSlashAction('/ooc A disposable note for action checks.');
        } else {
            appendConversationThreadMessage(character.avatar, {
                role: 'assistant', name: 'Bunny Guide', mes: 'A disposable message for focus checks.', extra: {},
            });
        }
        renderConversationTimeline();
    }, { ooc });
    const message = page.locator('.sb-conversation-message').filter({ hasText: ooc
        ? 'A disposable note for action checks.'
        : 'A disposable message for focus checks.' });
    await expect(message).toBeVisible();
    const messageId = await message.getAttribute('data-message-id');
    return page.locator(`.sb-conversation-message[data-message-id="${messageId}"]`);
}

async function openOocNote(page, baseURL, width) {
    await page.setViewportSize({ width, height: 900 });
    const message = await openConversation(page, baseURL, { ooc: true });
    await expect(message).toHaveAttribute('data-role', 'system');
    await expect(message.locator('.sb-conversation-message-avatar')).toBeHidden();
    await expect(message.locator('.sb-conversation-message-meta')).toBeHidden();
    await message.hover();
    return message;
}

// Viewport rectangles include CSS transforms, which is how the hover pill is lifted off its bubble.
async function getRect(locator) {
    return locator.evaluate((element) => {
        const { left, top, right, bottom } = element.getBoundingClientRect();
        return { left, top, right, bottom };
    });
}

function rectsIntersect(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

async function openMessageMenu(page, trigger) {
    await trigger.click();
    const menu = page.getByRole('menu', { name: 'Message Actions' });
    await expect(menu.getByRole('menuitem', { name: 'Edit Conversation message', exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Delete message', exact: true })).toBeVisible();
    return menu;
}

async function editThenDeleteFromMenu(page, message, trigger, menu) {
    await menu.getByRole('menuitem', { name: 'Edit Conversation message', exact: true }).click();
    await expect(message.locator('.sb-conversation-message-edit-textarea')).toHaveValue('A disposable note for action checks.');
    await message.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(message.locator('.sb-conversation-message-edit-textarea')).toHaveCount(0);
    await message.hover();
    await trigger.click();
    await menu.getByRole('menuitem', { name: 'Delete message', exact: true }).click();
    const confirmation = page.locator('dialog.sb-popup-destructive-confirm');
    await expect(confirmation).toBeVisible();
    await expect(confirmation.locator('.popup-button-cancel')).toBeFocused();
    await confirmation.locator('.popup-button-cancel').click();
    await expect(message).toBeVisible();
}

test('OOC notes retain Edit and Delete through their message menu at 390px', async ({ page, baseURL }, testInfo) => {
    test.setTimeout(60000);
    const message = await openOocNote(page, baseURL, 390);
    const trigger = message.locator('.sb-conversation-mobile-menu-trigger');
    await expect(trigger).toBeVisible();
    await expect(message.locator('.sb-conversation-message-actions')).toBeHidden();
    // The mobile trigger belongs beside the note line, not a header row below it.
    const triggerRect = await getRect(trigger);
    const noteRect = await getRect(message.locator('.sb-conversation-message-text'));
    const bubbleRect = await getRect(message.locator('.sb-conversation-message-bubble'));
    expect(triggerRect.top).toBeGreaterThanOrEqual(bubbleRect.top - 1);
    expect(triggerRect.top).toBeLessThan(noteRect.bottom);
    expect(triggerRect.bottom).toBeGreaterThan(noteRect.top);
    await page.screenshot({ path: testInfo.outputPath('ooc-row.png') });
    const menu = await openMessageMenu(page, trigger);
    await page.screenshot({ path: testInfo.outputPath('ooc-menu.png') });
    await editThenDeleteFromMenu(page, message, trigger, menu);
});

test('OOC notes retain Edit and Delete through their message menu at 1440px', async ({ page, baseURL }, testInfo) => {
    test.setTimeout(60000);
    const message = await openOocNote(page, baseURL, 1440);
    const trigger = message.locator('.sb-conversation-message-menu');
    await expect(trigger).toBeVisible();
    const note = message.locator('.sb-conversation-message-text');
    const pill = message.locator('.sb-conversation-message-actions');
    // System rows hide the name row, so the hover pill must sit clear of the single note line.
    await expect(pill).toHaveCSS('opacity', '1');
    expect(rectsIntersect(await getRect(pill), await getRect(note))).toBe(false);
    await page.screenshot({ path: testInfo.outputPath('ooc-row.png') });
    const menu = await openMessageMenu(page, trigger);
    await expect(message).toHaveClass(/has-open-menu/);
    expect(rectsIntersect(await getRect(pill), await getRect(note))).toBe(false);
    await page.screenshot({ path: testInfo.outputPath('ooc-menu.png') });
    await editThenDeleteFromMenu(page, message, trigger, menu);
});

for (const reducedMotion of ['reduce', 'no-preference']) {
    test(`mobile action sheet Close restores its message trigger focus with motion ${reducedMotion}`, async ({ page, baseURL }) => {
        test.setTimeout(60000);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.emulateMedia({ reducedMotion });
        const message = await openConversation(page, baseURL);
        expect(await page.evaluate(async () => {
            const { prefersReducedMotion } = await import('/scripts/sillybunny-motion.js');
            return prefersReducedMotion();
        })).toBe(reducedMotion === 'reduce');
        const trigger = message.locator('.sb-conversation-mobile-menu-trigger');
        await trigger.focus();
        await trigger.press('Enter');
        const sheet = page.locator('.sb-action-sheet');
        await expect(sheet).toBeVisible();
        await sheet.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(sheet).toBeHidden();
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');
        await expect(trigger).toBeFocused();
        await trigger.press('Enter');
        await expect(sheet).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(sheet).toBeHidden();
        await expect(trigger).toBeFocused();
    });
}
