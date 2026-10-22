import { expect, test } from '@playwright/test';
import { bootMiscDialogs } from './helpers/misc-dialogs.js';

const VIEWPORTS = [
    { width: 1440, height: 900, presentation: 'floating' },
    { width: 390, height: 844, presentation: 'sheet' },
    { width: 844, height: 390, presentation: 'floating' },
];
const ASSET_LIST_URL = 'https://assets.example.test/characters.json';
const WORKFLOW_NAME = 'Window Media Fixture.json';

test.setTimeout(180000);
test.use({ serviceWorkers: 'block', hasTouch: true, screenshot: 'off', video: 'off', trace: 'off' });

function json(route, value) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
}

function requestBody(request) {
    return JSON.parse(request.postData() ?? '{}');
}

async function bootMediaDialogs(page, viewport) {
    const state = { assetDownloads: [], workflowSaves: [] };
    await page.route('**/scripts/extensions/prompt-inspector/index.js*', async route => {
        const response = await route.fetch();
        const source = await response.text();
        return route.fulfill({ response, body: `${source}\nexport { showPromptInspector as windowMediaTestShowPromptInspector };` });
    });
    await page.context().route(/\/api\/sd\//, route => route.fulfill({ status: 400, body: 'Blocked by Window media dialog test' }));
    await page.context().route('**/api/extensions/install', route => route.fulfill({ status: 400, body: 'Extension install stays intercepted' }));
    await page.route('**/api/characters/import', route => json(route, { file_name: 'window-media-character-00' }));
    await page.route('**/api/assets/get', route => json(route, {}));
    await page.route('**/api/assets/download', route => {
        const request = requestBody(route.request());
        state.assetDownloads.push(request);
        if (request.filename === 'window-media-character-00') return json(route, { installed: true });
        return route.fulfill({ status: 400, body: 'Asset download stays intercepted' });
    });
    await page.route(ASSET_LIST_URL, route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(Array.from({ length: 36 }, (_, index) => ({
            type: 'character',
            id: `window-media-character-${String(index).padStart(2, '0')}`,
            name: `Window Media Character ${String(index).padStart(2, '0')}`,
            description: 'Window media list fixture',
            url: `https://assets.example.test/character-${index}.svg`,
        }))),
    }));
    await page.route('https://assets.example.test/character-*.svg', route => route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>',
    }));
    await page.route('**/api/chats/archive/inventory', route => {
        const { scope } = requestBody(route.request());
        const rows = scope === 'archive'
            ? Array.from({ length: 36 }, (_, index) => ({
                _source: 'archive-inventory',
                avatar: 'misc-dialog-character.png',
                file_name: `Window Media Archive ${String(index).padStart(2, '0')}.jsonl`,
                file_size: '1 KB',
                chat_items: 1,
                last_mes: 1_000 + index,
                mes: `Window media archive preview ${index}`,
            }))
            : [];
        return json(route, { rows, cursor: null, read_token: null, errors: 0, total: rows.length });
    });
    await page.route('**/user/files/_sbca_organization.json', route => route.fulfill({ status: 404 }));
    await page.route('**/api/chats/archive/release', route => route.fulfill({ status: 204 }));

    const misc = await bootMiscDialogs(page, viewport, {
        configureSettings(settings) {
            settings.extension_settings.sd ??= {};
            settings.extension_settings.sd.comfy_workflow = WORKFLOW_NAME;
        },
    });
    await page.route('**/api/sd/comfy/workflow', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify('{\n    "fixture": "original workflow"\n}'),
    }));
    await page.route('**/api/sd/comfy/save-workflow', route => {
        state.workflowSaves.push(requestBody(route.request()));
        return json(route, []);
    });
    return { ...state, settings: misc.settings };
}

async function openPopup(page, selector) {
    const popup = page.locator('dialog.popup[open]').last();
    await popup.locator(selector).first().waitFor();
    await expect(popup).not.toHaveAttribute('opening');
    return popup;
}

async function expectWindowPresentation(popup, viewport) {
    await expect(popup).toHaveClass(/sb-dialog--window/);
    await expect(popup).toHaveAttribute('data-presentation', viewport.presentation);
    await expect(popup.locator('.sb-dialog__close:visible, .popup-button-ok:visible, .popup-button-cancel:visible').first()).toBeVisible();
}

async function openAssetBrowser(page) {
    await page.evaluate(async url => {
        const assets = await import('/scripts/extensions/assets/index.js');
        if (!document.getElementById('assets-characters-button')) await assets.init();
        document.getElementById('assets-json-url-field').value = url;
        document.getElementById('assets-characters-button').click();
    }, ASSET_LIST_URL);
    return openPopup(page, '.characterAssetDownloadButton');
}

async function openComfyWorkflowEditor(page) {
    await page.addStyleTag({ url: '/scripts/extensions/stable-diffusion/style.css' });
    await page.evaluate(async name => {
        const extensions = await import('/scripts/extensions.js');
        extensions.extension_settings.sd ??= {};
        extensions.extension_settings.sd.comfy_workflow = name;
        const stableDiffusion = await import('/scripts/extensions/stable-diffusion/index.js');
        if (!document.getElementById('sd_comfy_open_workflow_editor')) await stableDiffusion.init();
        document.getElementById('sd_comfy_open_workflow_editor').click();
    }, WORKFLOW_NAME);
    return openPopup(page, '#sd_comfy_workflow_editor_workflow');
}

async function openPromptInspector(page, input) {
    await page.addStyleTag({ url: '/scripts/extensions/prompt-inspector/style.css' });
    await page.evaluate(async input => {
        localStorage.setItem('promptInspectorFormat', 'json');
        const inspector = await import('/scripts/extensions/prompt-inspector/index.js');
        void inspector.windowMediaTestShowPromptInspector(input).then(result => { window.__windowMediaPromptResult = result; });
    }, input);
    return openPopup(page, '#inspectPrompt');
}

async function openArchive(page) {
    await page.addStyleTag({ url: '/scripts/extensions/sillybunny-chats-archive/style.css' });
    await page.evaluate(async () => {
        const archive = await import('/scripts/extensions/sillybunny-chats-archive/src/ui.js');
        void archive.openArchive(window.SillyTavern.getContext(), document.body);
    });
    return openPopup(page, '.sbca-root');
}

for (const viewport of VIEWPORTS) {
    const size = `${viewport.width}×${viewport.height}`;

    test(`Assets browser, ComfyUI editor, Prompt Inspector and Chat Archive use reachable Window frames at ${size}`, async ({ page }) => {
        const state = await bootMediaDialogs(page, viewport);

        const assets = await openAssetBrowser(page);
        await expectWindowPresentation(assets, viewport);
        await expect(assets.locator('.sb-dialog__title')).toHaveText('Characters');
        await expect(assets.locator('.characterAsset')).toHaveCount(36);
        const assetsContent = assets.locator('.popup-content');
        await assetsContent.evaluate(node => { node.scrollTop = node.scrollHeight; });
        expect(await assetsContent.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
        await expect(assets.locator('.characterAsset').last()).toBeInViewport();
        await expect(assets.locator('.sb-dialog__close')).toBeInViewport();
        const firstAsset = assets.locator('.characterAsset').first();
        await firstAsset.locator('.characterAssetDownloadButton').click();
        await expect.poll(() => state.assetDownloads.length).toBe(1);
        expect(state.assetDownloads[0]).toMatchObject({
            category: 'character',
            filename: 'window-media-character-00',
            url: 'https://assets.example.test/character-0.svg',
        });
        await expect(firstAsset.locator('.characterAssetDownloadButton')).toBeHidden();
        await expect(firstAsset.locator('.characterAssetCheckMark')).toBeVisible();
        const failedAsset = assets.locator('.characterAsset').nth(1);
        await failedAsset.locator('.characterAssetDownloadButton').click();
        await expect.poll(() => state.assetDownloads.length).toBe(2);
        await expect(failedAsset.locator('.characterAssetDownloadButton')).toBeVisible();
        await expect(failedAsset.locator('.characterAssetCheckMark')).toBeHidden();
        await assets.locator('.sb-dialog__close').click();

        const comfy = await openComfyWorkflowEditor(page);
        await expectWindowPresentation(comfy, viewport);
        await expect(comfy.locator('.popup-button-cancel')).toBeVisible();
        await expect(comfy.locator('.popup-button-ok')).toBeVisible();
        const workflow = comfy.locator('#sd_comfy_workflow_editor_workflow');
        await expect(workflow).toHaveValue('{\n    "fixture": "original workflow"\n}');
        const workflowValue = Array.from({ length: 90 }, (_, index) => `    "field-${index}": "value-${index}"`).join(',\n');
        await workflow.fill(`{\n${workflowValue}\n}`);
        const comfyScroll = await comfy.evaluate(node => ({
            body: getComputedStyle(node.querySelector('.popup-body')).overflowY,
            content: getComputedStyle(node.querySelector('.popup-content')).overflowY,
            editor: getComputedStyle(node.querySelector('#sd_comfy_workflow_editor_workflow')).overflowY,
        }));
        expect(comfyScroll.body).not.toMatch(/^(auto|scroll)$/);
        expect(comfyScroll.content).not.toMatch(/^(auto|scroll)$/);
        expect(comfyScroll.editor).toMatch(/^(auto|scroll)$/);
        await workflow.evaluate(node => { node.scrollTop = node.scrollHeight; });
        expect(await workflow.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
        const placeholderContainer = comfy.locator('.sd_comfy_workflow_editor_placeholder_container');
        await placeholderContainer.evaluate(node => { node.scrollTop = node.scrollHeight; });
        await expect(placeholderContainer.locator('li[data-placeholder]').last()).toBeInViewport();
        await comfy.locator('.popup-button-ok').click();
        await expect.poll(() => state.workflowSaves.length).toBe(1);
        expect(state.workflowSaves[0]).toEqual({ file_name: WORKFLOW_NAME, workflow: `{\n${workflowValue}\n}` });

        const originalPrompt = JSON.stringify([{ role: 'user', content: 'Original prompt fixture' }], null, 4);
        const inspector = await openPromptInspector(page, originalPrompt);
        await expectWindowPresentation(inspector, viewport);
        await expect(inspector.locator('.popup-button-cancel')).toBeVisible();
        await expect(inspector.locator('.popup-button-ok')).toBeVisible();
        await expect(inspector.locator('#inspectPromptFormat')).toBeVisible();
        const promptResponses = await inspector.evaluate(dialog => {
            const save = dialog.querySelector('.popup-button-ok');
            const discard = dialog.querySelector('.popup-button-cancel');
            const responses = [...dialog.querySelectorAll('.popup-button-ok, .popup-button-cancel, .popup-button-custom')];
            const saveStyle = getComputedStyle(save);
            return {
                discardDestructive: discard.classList.contains('is-destructive'),
                suggested: responses.filter(button => {
                    const style = getComputedStyle(button);
                    return style.backgroundColor === saveStyle.backgroundColor && style.color === saveStyle.color;
                }).map(button => button.textContent.trim()),
            };
        });
        expect(promptResponses.suggested).toEqual(['Save changes']);
        expect(promptResponses.discardDestructive).toBe(false);
        await expect(inspector.locator('.popup-button-cancel')).not.toHaveClass(/is-destructive|is-suggested|menu_button_primary/);
        const extraResponse = inspector.locator('.sb-dialog__bottom-bar .popup-button-custom');
        await expect(extraResponse).toHaveText('Cancel generation');
        await expect(extraResponse).not.toHaveClass(/menu_button_primary|menu_button_default|is-suggested/);
        await expect(extraResponse).toBeInViewport();
        const responseAlignment = await inspector.evaluate(node => {
            const header = node.querySelector('.sb-dialog__header').getBoundingClientRect();
            const cancel = node.querySelector('.popup-button-cancel').getBoundingClientRect();
            const affirmative = node.querySelector('.popup-button-ok').getBoundingClientRect();
            const extra = node.querySelector('.sb-dialog__bottom-bar');
            const extraRect = extra.getBoundingClientRect();
            const buttonRect = extra.querySelector('.popup-button-custom').getBoundingClientRect();
            return {
                headerLeft: header.left,
                headerRight: header.right,
                cancelLeft: cancel.left,
                affirmativeRight: affirmative.right,
                extraRight: extraRect.right,
                buttonRight: buttonRect.right,
            };
        });
        expect(responseAlignment.cancelLeft).toBeLessThan(responseAlignment.headerLeft + (responseAlignment.headerRight - responseAlignment.headerLeft) / 2);
        expect(responseAlignment.affirmativeRight).toBeGreaterThan(responseAlignment.headerRight - 12);
        expect(responseAlignment.buttonRight).toBeCloseTo(responseAlignment.extraRight - 12, 0);
        const prompt = inspector.locator('#inspectPrompt');
        const savedPrompt = JSON.stringify(Array.from({ length: 60 }, (_, index) => ({
            role: 'user',
            content: `Saved prompt fixture ${index}`,
        })), null, 4);
        await prompt.fill(savedPrompt);
        const promptScroll = await inspector.evaluate(node => ({
            body: getComputedStyle(node.querySelector('.popup-body')).overflowY,
            content: getComputedStyle(node.querySelector('.popup-content')).overflowY,
            editor: getComputedStyle(node.querySelector('#inspectPrompt')).overflowY,
        }));
        expect(promptScroll.body).not.toMatch(/^(auto|scroll)$/);
        expect(promptScroll.content).not.toMatch(/^(auto|scroll)$/);
        expect(promptScroll.editor).toMatch(/^(auto|scroll)$/);
        await prompt.evaluate(node => { node.scrollTop = node.scrollHeight; });
        expect(await prompt.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
        await inspector.locator('.popup-button-ok').click();
        await expect.poll(() => page.evaluate(() => window.__windowMediaPromptResult)).toBe(savedPrompt);

        const discardedPrompt = JSON.stringify([{ role: 'user', content: 'Discard this prompt' }], null, 4);
        const discardInspector = await openPromptInspector(page, discardedPrompt);
        await discardInspector.locator('#inspectPrompt').fill('Unsaved prompt fixture');
        await discardInspector.locator('.popup-button-cancel').click();
        await expect.poll(() => page.evaluate(() => window.__windowMediaPromptResult)).toBe(discardedPrompt);

        const cancelledPrompt = JSON.stringify([{ role: 'user', content: 'Keep the original prompt' }], null, 4);
        const cancelGenerationInspector = await openPromptInspector(page, cancelledPrompt);
        await cancelGenerationInspector.locator('#inspectPrompt').fill('Do not apply this prompt');
        await cancelGenerationInspector.locator('.sb-dialog__bottom-bar .popup-button-custom').click();
        await expect.poll(() => page.evaluate(() => window.__windowMediaPromptResult)).toBe(cancelledPrompt);

        const archive = await openArchive(page);
        await expectWindowPresentation(archive, viewport);
        const archiveCloseTarget = await archive.locator('.sb-dialog__close').evaluate(node => ({
            width: node.getBoundingClientRect().width,
            height: node.getBoundingClientRect().height,
        }));
        expect(archiveCloseTarget.width).toBeGreaterThanOrEqual(44);
        expect(archiveCloseTarget.height).toBeGreaterThanOrEqual(44);
        const archiveScroll = await archive.evaluate(node => ({
            body: getComputedStyle(node.querySelector('.popup-body')).overflowY,
            content: getComputedStyle(node.querySelector('.popup-content')).overflowY,
            root: getComputedStyle(node.querySelector('.sbca-root')).overflowY,
        }));
        expect(archiveScroll.body).not.toMatch(/^(auto|scroll)$/);
        expect(archiveScroll.content).not.toMatch(/^(auto|scroll)$/);
        expect(archiveScroll.root).toMatch(/^(auto|scroll)$/);
        const archiveRoot = archive.locator('.sbca-root');
        await archiveRoot.evaluate(node => { node.scrollTop = node.scrollHeight; });
        expect(await archiveRoot.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
        await expect(archive.locator('.sbca-row-button').last()).toBeInViewport();
        await expect(archive.locator('.sb-dialog__close')).toBeInViewport();
        await archive.locator('.sb-dialog__close').click();
    });
}
