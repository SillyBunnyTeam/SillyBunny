import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

async function openConversation(page, baseURL) {
    const origin = new URL(baseURL).origin;
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname);
    let settingsVersion = Date.now();
    const readOnlyEndpoints = new Set([
        '/api/characters/all', '/api/characters/chats', '/api/groups/all', '/api/backgrounds/all',
        '/api/avatars/get', '/api/stats/get', '/api/secrets/read', '/api/users/me',
    ]);

    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) {
            return route.abort();
        }
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
            settings.extension_settings['quick-image-gen'] = { ...settings.extension_settings['quick-image-gen'], setupWizardSeen: true };
            data.request_compression = { ...data.request_compression, enabled: false };
            data.settings = JSON.stringify(settings);
            return route.fulfill({ json: data });
        }
        if (url.pathname === '/api/settings/save') {
            return route.fulfill({ json: { version: ++settingsVersion } });
        }
        if (readOnlyEndpoints.has(url.pathname) || url.pathname.startsWith('/api/tokenizers/')) {
            return route.continue();
        }
        if (url.pathname.startsWith('/api/backends/')) {
            return route.fulfill({ json: { data: [] } });
        }
        if (url.pathname.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.request().method())) {
            return route.fulfill({ json: {} });
        }
        return route.continue();
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await page.evaluate(async () => {
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
        const { setOnlineStatus } = await import('/script.js');
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        const { stopConversationAutoWorker } = await import('/scripts/sillybunny-conversation/auto-engine.js');
        const context = window.SillyTavern.getContext();
        const character = context.characters.find(entry => /Bunny Guide|Seraphina/.test(entry?.name ?? ''));
        if (!character?.avatar) {
            throw new Error('No bundled Conversation character found.');
        }
        setOnlineStatus('no_connection');
        openConversationWorkspaceForAvatar(character.avatar, { showToast: false });
        stopConversationAutoWorker();
    });
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-mode', 'on');
}

for (const width of [390, 1440]) {
    test(`Conversation composer stays visible but unavailable offline and recovers at ${width}px`, async ({ page, baseURL }, testInfo) => {
        test.setTimeout(60000);
        await page.setViewportSize({ width, height: 900 });
        await openConversation(page, baseURL);

        const input = page.locator('#sb_conversation_input');
        const send = page.locator('#sb_conversation_send');
        await expect(input).toBeVisible();
        await expect(input).toBeEnabled();
        await expect(input).toHaveAttribute('placeholder', 'Not connected to API!');
        await expect(send).toBeVisible();
        await expect(send).toBeDisabled();
        const offlineColors = await send.evaluate(element => {
            const style = getComputedStyle(element);
            return { background: style.backgroundColor, color: style.color };
        });
        await page.screenshot({ path: testInfo.outputPath('conversation-offline.png') });

        await input.fill('Unsent offline draft');
        await input.press('Enter');
        await expect(input).toHaveValue('Unsent offline draft');
        await page.evaluate(async () => {
            const { submitConversationInput } = await import('/scripts/sillybunny-conversation/attachments.js');
            await submitConversationInput();
        });
        await expect(input).toHaveValue('Unsent offline draft');
        await expect(page.locator('.sb-conversation-message-text').filter({ hasText: 'Unsent offline draft' })).toHaveCount(0);

        await page.evaluate(async () => {
            const { setOnlineStatus } = await import('/script.js');
            setOnlineStatus('Connected');
        });
        await expect(input).toBeEnabled();
        await expect(input).toHaveAttribute('placeholder', 'Type your message...');
        await expect(send).toBeEnabled();
        await expect(input).toHaveValue('Unsent offline draft');
        const connectedColors = await send.evaluate(element => {
            const style = getComputedStyle(element);
            return { background: style.backgroundColor, color: style.color };
        });
        expect(connectedColors.background).not.toBe(offlineColors.background);
        expect(connectedColors.color).not.toBe(offlineColors.color);

        await page.evaluate(async () => {
            const { setOnlineStatus } = await import('/script.js');
            setOnlineStatus('no_connection');
        });
        await expect(send).toBeDisabled();
        await expect(input).toBeEnabled();
        await expect(input).toHaveValue('Unsent offline draft');
        await expect(input).toHaveAttribute('placeholder', 'Not connected to API!');
    });

    test(`Conversation Send stays disabled after an attachment fails during disconnect at ${width}px`, async ({ page, baseURL }) => {
        test.setTimeout(60000);
        await page.setViewportSize({ width, height: 900 });
        await openConversation(page, baseURL);
        await page.route('**/scripts/sillybunny-conversation/chats.js', route => route.fulfill({
            contentType: 'application/javascript',
            body: `export function populateFileAttachment() {
                return new Promise((resolve, reject) => {
                    window.rejectConversationAttachment = () => reject(new Error('Attachment upload failed'));
                });
            }`,
        }));

        const input = page.locator('#sb_conversation_input');
        const send = page.locator('#sb_conversation_send');
        await input.fill('Draft with an attachment');
        await page.locator('#sb_conversation_file_input').setInputFiles({
            name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('Unsent attachment'),
        });
        await page.evaluate(async () => {
            const { setOnlineStatus } = await import('/script.js');
            const { submitConversationInput } = await import('/scripts/sillybunny-conversation/attachments.js');
            setOnlineStatus('Connected');
            window.conversationAttachmentSubmission = submitConversationInput().catch(error => error.message);
        });
        await expect.poll(() => page.evaluate(() => typeof window.rejectConversationAttachment)).toBe('function');
        await expect(send).toBeDisabled();

        await page.evaluate(async () => {
            const { setOnlineStatus } = await import('/script.js');
            const { flushConversationRenders } = await import('/scripts/sillybunny-conversation/render-scheduler.js');
            setOnlineStatus('no_connection');
            flushConversationRenders();
        });
        await expect(send).toBeDisabled();
        await expect(input).toHaveAttribute('placeholder', 'Not connected to API!');
        expect(await page.evaluate(async () => {
            window.rejectConversationAttachment();
            return await window.conversationAttachmentSubmission;
        })).toBe('Attachment upload failed');

        await expect(send).toBeDisabled();
        await expect(input).toHaveValue('Draft with an attachment');
        await expect(page.locator('.sb-conversation-message-text').filter({ hasText: 'Draft with an attachment' })).toHaveCount(0);
    });
}
