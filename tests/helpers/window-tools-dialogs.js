import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { bootMiscDialogs, MISC_VIEWPORTS } from './misc-dialogs.js';

export const WINDOW_TOOLS_VIEWPORTS = MISC_VIEWPORTS;
export const DATA_MAID_VIEW_TEXT = 'Data Maid viewer fixture\nExact content survives the pushed page.\n';
export const WINDOW_TOOLS_SAFE_DEBUG_FUNCTION = 'window-tools-safe-action';

const reportItems = Array.from({ length: 24 }, (_, index) => ({
    name: `orphan-file-${String(index + 1).padStart(2, '0')}.txt`,
    hash: `window-tools-hash-${index}`,
    parent: 'window-tools-fixture',
    size: 48 + index,
    mtime: 1_700_000_000_000 + index * 60_000,
}));
export const DATA_MAID_FILE_HASHES = reportItems.map(item => item.hash).reverse();

export async function bootWindowToolsDialogs(page, viewport, { admin = false } = {}) {
    // Block write/external-action routes before boot and retain context fallbacks during teardown.
    await page.context().route(/\/api\/(?:data-maid|secrets|(?:backends\/[^/]+\/(?:generate|generate_stream))|(?:extensions\/(?:install|delete|update|sync|move|switch|version|branches))|(?:[^/]*scrap[^/]*))(?:\/|\?|$)/,
        route => route.fulfill({ status: 400, body: 'Blocked by Window tools dialog test' }));
    await page.route('**/api/secrets/read', route => route.fulfill({ json: {} }));
    await page.addInitScript(allowedDebugFunction => {
        window.__windowToolsBlockedDebugActions = [];
        window.__windowToolsDebugRuns = 0;
        document.addEventListener('click', event => {
            const action = event.target instanceof Element ? event.target.closest('[data-debug-function]') : null;
            if (!action) return;
            if (action.dataset.debugFunction === allowedDebugFunction) return;
            window.__windowToolsBlockedDebugActions.push(action.dataset.debugFunction);
            event.preventDefault();
            event.stopImmediatePropagation();
        }, true);
    }, WINDOW_TOOLS_SAFE_DEBUG_FUNCTION);
    await page.route('**/api/extensions/discover', async route => {
        const response = await route.fetch();
        const extensions = await response.json();
        return route.fulfill({ json: [...extensions, { name: 'third-party/window-tools-branch', type: 'local' }] });
    });
    await page.route('**/scripts/extensions/third-party/window-tools-branch/manifest.json*', route => route.fulfill({ json: {
        display_name: 'Window tools branch fixture', version: '1.0', loading_order: 9999,
        requires: [], optional: [], author: 'Test fixture', js: '', css: '',
    } }));
    const misc = await bootMiscDialogs(page, viewport, { admin,
        configureSettings(settings) {
            settings.main_api = 'openai';
            settings.extension_settings.disabledExtensions.push('third-party/window-tools-branch');
        },
    });
    const state = {
        ...misc,
        dataMaidDeletes: [],
        dataMaidFinalizes: [],
        extensionRequests: [],
        consoleErrors: [],
        pageErrors: [],
    };
    page.on('console', message => {
        if (message.type() === 'error') state.consoleErrors.push(message.text());
    });
    page.on('pageerror', error => state.pageErrors.push(error.message));

    await page.context().route('**/api/data-maid/**', route => route.fulfill({ status: 400, body: 'Blocked by Window tools dialog test' }));
    await page.route('**/api/data-maid/report', route => route.fulfill({ json: {
        token: 'window-tools-data-maid-token',
        report: {
            files: reportItems,
            images: [],
            chats: [],
            groupChats: [],
            avatarThumbnails: [],
            backgroundThumbnails: [],
            personaThumbnails: [],
            chatBackups: [],
            settingsBackups: [],
        },
    } }));
    await page.route('**/api/data-maid/view*', route => route.fulfill({ contentType: 'text/plain', body: DATA_MAID_VIEW_TEXT }));
    await page.route('**/api/data-maid/delete', route => {
        state.dataMaidDeletes.push(route.request().postDataJSON());
        return route.fulfill({ status: 204 });
    });
    await page.route('**/api/data-maid/finalize', route => {
        state.dataMaidFinalizes.push(route.request().postDataJSON());
        return route.fulfill({ status: 204 });
    });
    await page.route('**/api/extensions/**', route => {
        const endpoint = new URL(route.request().url()).pathname.split('/').at(-1);
        if (endpoint === 'discover') return route.fallback();
        const request = { endpoint, method: route.request().method(), body: route.request().postDataJSON() };
        state.extensionRequests.push(request);
        if (endpoint === 'branches') {
            return route.fulfill({ json: [
                { name: 'main', commit: 'abc123', current: true, label: 'Main' },
                { name: 'dev', commit: 'def456', current: false, label: 'Development' },
            ] });
        }
        if (endpoint === 'version') {
            return route.fulfill({ json: { currentBranchName: 'main', currentCommitHash: 'abc1234567', isUpToDate: true, remoteUrl: 'https://example.test/window-tools' } });
        }
        return route.fulfill({ status: 400, body: 'Intercepted by Window tools dialog test' });
    });
    return state;
}

export async function currentToolPopup(page, selector) {
    const candidate = page.locator('dialog.popup[open]').last();
    await candidate.locator(selector).waitFor();
    await expect(candidate).not.toHaveAttribute('opening');
    return page.locator(`dialog.popup[data-id="${await candidate.getAttribute('data-id')}"]`);
}

export async function expectToolWindow(popup, viewport) {
    await expect(popup).toHaveClass(/sb-dialog--window/);
    await expect(popup).not.toHaveClass(/sb-dialog--page/);
    await expect(popup).toHaveAttribute('data-presentation', viewport.presentation);
    expect(await popup.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
}

export async function expectToolPage(child, parent) {
    await expect(child).toHaveClass(/sb-dialog--page/);
    await expect(parent).toHaveAttribute('data-sb-covered', '');
    await expect(parent).toHaveJSProperty('inert', true);
}

export async function expectToolParentRestored(page, child, parent) {
    await expect(child).toHaveCount(0);
    await expect(parent).toBeVisible();
    await expect(parent).not.toHaveAttribute('data-sb-covered');
    await expect(parent).toHaveJSProperty('inert', false);
    await expect(page.locator('dialog.popup[open]')).toHaveCount(1);
}

export async function captureWindowToolsSurface(page, viewport, surface) {
    const directory = process.env.WINDOW_TOOLS_SCREENSHOTS;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: join(directory, `${surface}-${viewport.width}x${viewport.height}.png`), animations: 'disabled' });
}
