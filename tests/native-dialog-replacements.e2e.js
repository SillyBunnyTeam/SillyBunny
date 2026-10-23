import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });

const readOnlyPosts = new Set([
    '/api/settings/get', '/api/presets/defaults', '/api/avatars/get',
    '/api/backgrounds/folders', '/api/image-metadata/all', '/api/tokenizers/openai/count',
    '/api/server-admin/install-type', '/api/server-admin/config/get',
    '/api/server-admin/config/thumbnail-settings/get', '/api/server-admin/config/chat-completions/get',
]);
let chatCompletionConfigReads = 0;

async function expectAlert(page) {
    const alert = page.getByRole('alertdialog');
    await expect(alert).toBeVisible();
    await expect(alert).toHaveAttribute('data-tier', 'alert');
    return alert;
}

async function expectDestructiveAlert(page, responseId) {
    const alert = await expectAlert(page);
    await expect(alert.locator('[data-response="cancel"]')).toBeFocused();
    await expect(alert.locator(`[data-response="${responseId}"]`)).toHaveClass(/is-destructive/);
    return alert;
}

test.beforeEach(async ({ page, baseURL }) => {
    test.setTimeout(120000);
    chatCompletionConfigReads = 0;
    const origin = new URL(baseURL).origin;
    await page.context().route('**/*', route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
        if (request.method() === 'POST' && readOnlyPosts.has(url.pathname)) return route.continue();
        if (request.method() === 'POST' && url.pathname === '/api/settings/save') {
            return route.fulfill({ json: { result: 'ok', version: 2 } });
        }
        return route.abort();
    });
    await protectMaintainerServer(page);
    await page.route('**/api/server-admin/status', route => route.fulfill({ json: {} }));
    await page.route('**/api/server-admin/config/chat-completions/get', route => {
        chatCompletionConfigReads++;
        return route.fulfill({ json: { settings: {}, lastModifiedMs: 1 } });
    });
    await page.route(/\/api\/(?:characters\/all|groups\/all|chats\/(?:group\/)?get|in-chat-agents\/groups\/list)$/, route => route.fulfill({ json: [] }));
    await page.route('**/api/backgrounds/all', route => route.fulfill({ json: { images: [], config: {} } }));
    await page.route('**/api/quick-replies/save', route => route.fulfill({ body: 'ok' }));
    await page.route('**/api/secrets/read', route => route.fulfill({ json: {} }));
    await page.route('**/api/openrouter/providers', route => route.fulfill({ json: { data: [] } }));
    await page.route('**/api/nanogpt/providers', route => route.fulfill({ json: { data: [] } }));
    await page.route('**/api/sd/comfy/workflows', route => route.fulfill({ json: [] }));
    await page.addInitScript(() => {
        window.SillyBunnyClearFrontendCache = async () => true;
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test.describe(`native dialog replacements at ${viewport.width}×${viewport.height}`, () => {
        test.use({ viewport });

        test('SillyTavern folder import keeps the replacement action destructive and Cancel focused', async ({ page }) => {
            let importRequests = 0;
            await page.route('**/api/users/import-sillytavern/folder', route => {
                importRequests++;
                return route.fulfill({ json: { message: 'Import intercepted for dialog verification.' } });
            });
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'data-security'));
            const panel = page.locator('[data-sb-panel="data-security"]');
            await panel.locator('#sb-import-path-input').fill('/tmp/sillytavern-fixture');
            await panel.getByRole('button', { name: 'Import Folder', exact: true }).click();

            const alert = await expectAlert(page);
            await expect(alert).toContainText('/tmp/sillytavern-fixture');
            await expect(alert.locator('[data-response="cancel"]')).toBeFocused();
            await expect(alert.locator('[data-response="import"]')).toHaveClass(/is-destructive/);
            await page.keyboard.press('Enter');
            await expect(alert).toBeVisible();
            expect(importRequests).toBe(0);
            await alert.locator('[data-response="cancel"]').click();
            await expect(alert).toHaveCount(0);
            expect(importRequests).toBe(0);

            await panel.getByRole('button', { name: 'Import Folder', exact: true }).click();
            await page.getByRole('alertdialog').locator('[data-response="import"]').click();
            await expect.poll(() => importRequests).toBe(1);
        });

        test('Clear cookies and cache opens the shared alert and only clears after confirmation', async ({ page }) => {
            let clearRequests = 0;
            await page.route('**/api/cookies/clear', route => {
                clearRequests++;
                return route.fulfill({ json: { success: true, expirationAttempts: 0 } });
            });
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'data-security'));
            const button = page.locator('#clear_cookies_cache_button');
            await button.click();

            const alert = await expectAlert(page);
            await expect(alert.locator('.sb-dialog__heading')).toHaveText('Clear cookies & cache?');
            await expect(alert).toContainText('browser cache, service worker data, temporary session data, and IndexedDB cache stores for SillyBunny');
            await expect(alert).toContainText('Saved settings and account data stay intact.');
            await expect(alert).toContainText('may require you to sign in again.');
            await expect(alert.locator('[data-response="clear"]')).toHaveClass(/is-destructive/);
            await expect(alert.locator('[data-response="cancel"]')).toBeFocused();
            await page.keyboard.press('Enter');
            await expect(alert).toHaveCount(0);
            expect(clearRequests).toBe(0);
            await expect(button).toBeEnabled();

            await button.click();
            const confirmedAlert = await expectAlert(page);
            await confirmedAlert.locator('[data-response="clear"]').click();
            await expect.poll(() => clearRequests).toBe(1);
        });

        test('server config reload and branch switching wait for the destructive Alert response', async ({ page }) => {
            let configReads = 0;
            let branchSwitchRequests = 0;
            const status = {
                installType: 'git',
                repository: {
                    supported: true,
                    isRepo: true,
                    branch: 'staging',
                    displayBranch: 'staging',
                    hasLocalChanges: true,
                    changedFiles: [{ path: 'config.yaml' }],
                    autoStash: true,
                    trackingBranch: 'origin/staging',
                    currentCommit: 'fixture-commit',
                    ahead: 0,
                    behind: 0,
                },
                version: { pkgVersion: 'fixture', gitBranch: 'staging', gitRevision: 'fixture-commit' },
                configPath: 'config.yaml',
            };
            await page.route('**/api/server-admin/status', route => route.fulfill({ json: status }));
            await page.route('**/api/server-admin/config/get', route => {
                configReads++;
                return route.fulfill({ json: { content: 'fixture: true\n', lastModifiedMs: configReads } });
            });
            await page.route('**/api/server-admin/config/thumbnail-settings/get', route => route.fulfill({ json: { settings: {}, mobileSettings: {} } }));
            await page.route('**/api/server-admin/branches', route => route.fulfill({ json: { branches: ['staging', 'release'] } }));
            await page.route('**/api/server-admin/switch-branch', route => {
                branchSwitchRequests++;
                return route.fulfill({ status: 500, json: { message: 'Branch switch intercepted.' } });
            });
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'data-security'));
            const panel = page.locator('[data-sb-panel="data-security"]');
            const editor = panel.locator('.sb-server-config-editor');
            await expect(editor).toHaveValue('fixture: true\n');
            const initialConfigReads = configReads;
            await editor.fill('fixture: false\n');
            await panel.getByRole('button', { name: 'Reload file', exact: true }).click();

            let alert = await expectDestructiveAlert(page, 'discard');
            await expect(alert).toContainText('Discard your unsaved config edits and reload config.yaml from disk?');
            expect(configReads).toBe(initialConfigReads);
            await alert.locator('[data-response="cancel"]').click();
            await expect(alert).toHaveCount(0);
            expect(configReads).toBe(initialConfigReads);

            await panel.getByRole('button', { name: 'Reload file', exact: true }).click();
            alert = await expectDestructiveAlert(page, 'discard');
            await alert.locator('[data-response="discard"]').click();
            await expect.poll(() => configReads).toBe(initialConfigReads + 1);

            const branch = panel.locator('#sb-branch-select');
            await expect(branch).toHaveValue('staging');
            await branch.selectOption('release');
            alert = await expectDestructiveAlert(page, 'switch');
            await expect(alert).toContainText('Changed files: config.yaml');
            expect(branchSwitchRequests).toBe(0);
            await alert.locator('[data-response="cancel"]').click();
            await expect(alert).toHaveCount(0);
            await expect(branch).toHaveValue('staging');
            expect(branchSwitchRequests).toBe(0);

            await branch.selectOption('release');
            alert = await expectDestructiveAlert(page, 'switch');
            await alert.locator('[data-response="switch"]').click();
            await expect.poll(() => branchSwitchRequests).toBe(1);
            await expect(branch).toHaveValue('staging');
        });

        test('thumbnail cache clear keeps its suggested default and only runs on confirmation', async ({ page }) => {
            let clearRequests = 0;
            await page.route('**/api/server-admin/status', route => route.fulfill({ json: {} }));
            await page.route('**/api/server-admin/config/thumbnail-settings/get', route => route.fulfill({ json: { settings: {}, mobileSettings: {} } }));
            await page.route('**/api/server-admin/thumbnails/clear-cache', route => {
                clearRequests++;
                return route.fulfill({ json: { message: 'Cache clear intercepted.' } });
            });
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'data-security'));
            const panel = page.locator('[data-sb-panel="data-security"]');
            await panel.getByRole('button', { name: 'Clear cache only', exact: true }).click();

            const alert = await expectAlert(page);
            const clear = alert.locator('[data-response="clear"]');
            await expect(clear).toHaveClass(/is-suggested/);
            await expect(clear).toBeFocused();
            await expect(alert.locator('[data-response="cancel"]')).not.toBeFocused();
            expect(clearRequests).toBe(0);
            await clear.click();
            await expect.poll(() => clearRequests).toBe(1);
        });

        test('Chat Archive delete and replace use the real destructive Alert before saving organization data', async ({ page }) => {
            const uploads = [];
            const organization = {
                version: 1,
                lastView: {},
                views: [{ id: 'saved-view', name: 'Fixture view', view: {} }],
                folders: [],
                collections: [],
                chats: {},
            };
            await page.route('**/user/files/_sbca_organization.json', route => route.fulfill({ json: organization }));
            await page.route('**/api/chats/archive/inventory', route => route.fulfill({
                json: { rows: [], cursor: null, read_token: null, errors: 0, total: 0 },
            }));
            await page.route('**/api/files/upload', route => {
                const payload = route.request().postDataJSON();
                if (payload?.name === '_sbca_organization.json') uploads.push(payload);
                return route.fulfill({ json: { result: 'ok' } });
            });
            await page.evaluate(async () => await window.SillyBunnyShell.openTab('characters', 'characters'));
            await page.locator('#sbca_drawer_button').click();
            await expect(page.locator('.sbca-root')).toBeVisible();
            await page.getByRole('button', { name: 'Manage organization' }).click();
            const savedViews = page.locator('.sbca-named-manager').filter({ has: page.getByRole('heading', { name: 'Saved views' }) });
            const deleteView = savedViews.getByRole('button', { name: 'Delete Fixture view' });
            await deleteView.click();

            let alert = await expectDestructiveAlert(page, 'delete');
            await expect(alert).toContainText('Delete saved view Fixture view?');
            expect(uploads).toHaveLength(0);
            await alert.locator('[data-response="cancel"]').click();
            await expect(alert).toHaveCount(0);
            expect(uploads).toHaveLength(0);

            await deleteView.click();
            alert = await expectDestructiveAlert(page, 'delete');
            await alert.locator('[data-response="delete"]').click();
            await expect.poll(() => uploads.length).toBe(1);
            expect(JSON.parse(Buffer.from(uploads[0].data, 'base64').toString('utf8')).views).toEqual([]);

            const backup = {
                version: 1,
                lastView: {},
                views: [],
                folders: [{ id: 'imported-folder', name: 'Imported folder' }],
                collections: [],
                chats: {},
            };
            const backupFile = {
                name: 'organization.json',
                mimeType: 'application/json',
                buffer: Buffer.from(JSON.stringify(backup)),
            };
            await expect(page.locator('.sbca-root')).toBeVisible();
            const organizationFile = page.locator('.sbca-root .sbca-organization-backup input[type="file"]');
            await organizationFile.setInputFiles(backupFile);
            alert = await expectDestructiveAlert(page, 'replace');
            await expect(alert).toContainText('Replace all current folders, collections, saved views, tags, and favorites?');
            expect(uploads).toHaveLength(1);
            await alert.locator('[data-response="cancel"]').click();
            await expect(alert).toHaveCount(0);
            expect(uploads).toHaveLength(1);

            await organizationFile.setInputFiles(backupFile);
            alert = await expectDestructiveAlert(page, 'replace');
            await alert.locator('[data-response="replace"]').click();
            await expect.poll(() => uploads.length).toBe(2);
            expect(JSON.parse(Buffer.from(uploads[1].data, 'base64').toString('utf8')).folders).toEqual(backup.folders);
        });

        test('vector index purge stays behind the real destructive Alert', async ({ page }) => {
            let purgeRequests = 0;
            await page.route('**/api/vector/purge-all', route => {
                purgeRequests++;
                return route.fulfill({ json: {} });
            });
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'interface'));
            await page.locator('#debug_menu').click();
            const debugMenu = page.getByRole('dialog').filter({ has: page.locator('#debug_table') });
            const purgeAction = debugMenu.locator('[data-debug-function="purge-everything"]');
            await expect(purgeAction).toBeVisible();
            await purgeAction.dispatchEvent('click');

            let alert = await expectDestructiveAlert(page, 'purge');
            await expect(alert).toContainText('Are you sure?');
            expect(purgeRequests).toBe(0);
            await alert.locator('[data-response="cancel"]').click();
            await expect(alert).toHaveCount(0);
            expect(purgeRequests).toBe(0);

            await purgeAction.click();
            alert = await expectDestructiveAlert(page, 'purge');
            await alert.locator('[data-response="purge"]').click();
            await expect.poll(() => purgeRequests).toBe(1);
        });

        test('SpeechT5 speaker deletion is reachable and waits for the real destructive Alert', async ({ page }) => {
            await page.evaluate(async () => {
                const { extension_settings } = await import('/scripts/extensions.js');
                extension_settings.tts.SpeechT5 = {
                    speakers: [
                        { voice_id: 'fixture-speaker-one', name: 'Fixture speaker one', data: 'one' },
                        { voice_id: 'fixture-speaker-two', name: 'Fixture speaker two', data: 'two' },
                    ],
                    speaker: 'fixture-speaker-one',
                    voiceMap: {},
                };
            });
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'extensions'));
            await page.getByRole('listitem').filter({ hasText: 'Read chat messages aloud' }).click();
            await expect(page.locator('#tts_settings')).toBeVisible();
            const provider = page.locator('#tts_provider');
            await expect(provider.locator('option[value="SpeechT5"]')).toHaveCount(1);
            await provider.selectOption('SpeechT5');
            const deleteSpeaker = page.locator('#speecht5_tts_delete_speaker_button');
            await expect(deleteSpeaker).toBeVisible();
            await expect(page.locator('#speecht5_tts_speaker option')).toHaveCount(2);
            await deleteSpeaker.click();

            let alert = await expectDestructiveAlert(page, 'delete');
            await expect(alert).toContainText('Are you sure you want to delete this speaker?');
            await alert.locator('[data-response="cancel"]').click();
            await expect(alert).toHaveCount(0);
            await expect(page.locator('#speecht5_tts_speaker option')).toHaveCount(2);

            await deleteSpeaker.dispatchEvent('click');
            alert = await expectDestructiveAlert(page, 'delete');
            await alert.locator('[data-response="delete"]').click();
            await expect(page.locator('#speecht5_tts_speaker option')).toHaveCount(1);
            await expect(page.locator('#speecht5_tts_speaker')).toHaveValue('fixture-speaker-two');
        });

        test('OpenAI server config reload discards a draft only after the destructive Alert response', async ({ page }) => {
            await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'prompting'));
            await page.evaluate(() => {
                $('#main_api').val('openai').trigger('change');
                $('#chat_completion_source').val('claude').trigger('change');
            });
            const setting = page.locator('#sb-config-claude-system-prompt-cache');
            await expect(setting).toBeVisible();
            const initialReads = chatCompletionConfigReads;
            await setting.check();
            const reload = page.locator('#sb-chat-completion-config-reload');
            await reload.evaluate(element => element.scrollIntoView({ block: 'center' }));
            await reload.click();

            let alert = await expectDestructiveAlert(page, 'discard');
            await expect(alert).toContainText('Discard your unsaved server config edits and reload from config.yaml?');
            expect(chatCompletionConfigReads).toBe(initialReads);
            await alert.locator('[data-response="cancel"]').click();
            await expect(alert).toHaveCount(0);
            expect(chatCompletionConfigReads).toBe(initialReads);

            await setting.uncheck();
            await setting.check();
            await reload.evaluate(element => element.scrollIntoView({ block: 'center' }));
            await reload.dispatchEvent('click');
            alert = await expectDestructiveAlert(page, 'discard');
            await alert.locator('[data-response="discard"]').click();
            await expect.poll(() => chatCompletionConfigReads).toBe(initialReads + 1);
        });
    });
}
