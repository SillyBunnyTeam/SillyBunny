import { expect } from '@playwright/test';
import { bootMiscDialogs } from './misc-dialogs.js';

export const WINDOW_CONTENT_VIEWPORTS = [
    { width: 1440, height: 900, presentation: 'floating' },
    { width: 390, height: 844, presentation: 'sheet' },
    { width: 844, height: 390, presentation: 'floating' },
];
export const EXPOSED_SECRET_SENTINEL = 'window-content-secret-sentinel-927';
export const SNAPSHOT_FIXTURE = {
    name: 'window-content-fixture',
    date: 1_700_000_000_000,
    size: 512,
};
export const SNAPSHOT_TEXT = '{\n    "fixture": "snapshot content stays intercepted"\n}\n';
export const CUSTOM_BODY_YAML = 'top_k: 20\nrepetition_penalty: 1.1';

export async function bootWindowContentDialogs(page, viewport, { admin = false, configureSettings } = {}) {
    const state = { snapshotRequests: [], secretViewCalls: 0 };
    await page.context().route(/\/api\/settings\/(?:get-snapshots|load-snapshot|make-snapshot|restore-snapshot)$/, route => route.fulfill({ status: 400, body: 'Blocked by window-content dialog test' }));
    await page.context().route(/\/api\/secrets\//, route => {
        const endpoint = new URL(route.request().url()).pathname.split('/').at(-1);
        if (endpoint === 'read') return route.fulfill({ json: {} });
        if (endpoint === 'settings') return route.fulfill({ json: { allowKeysExposure: true } });
        return route.fulfill({ status: 400, body: 'Blocked by window-content dialog test' });
    });

    const misc = await bootMiscDialogs(page, viewport, {
        admin,
        configureSettings(settings) {
            configureSettings?.(settings);
        },
    });

    await page.route('**/api/settings/get-snapshots', route => {
        state.snapshotRequests.push('get-snapshots');
        return route.fulfill({ json: [SNAPSHOT_FIXTURE] });
    });
    await page.route('**/api/settings/load-snapshot', route => {
        state.snapshotRequests.push('load-snapshot');
        return route.fulfill({ contentType: 'text/plain', body: SNAPSHOT_TEXT });
    });
    await page.route('**/api/settings/make-snapshot', route => {
        state.snapshotRequests.push('make-snapshot');
        return route.fulfill({ json: {} });
    });
    await page.route('**/api/settings/restore-snapshot', route => {
        state.snapshotRequests.push('restore-snapshot');
        return route.fulfill({ status: 400, body: 'Restore must remain cancelled in this suite' });
    });

    return { ...misc, ...state };
}

export async function interceptExposedSecretViewer(page, state) {
    await page.route('**/api/secrets/view', route => {
        state.secretViewCalls += 1;
        return route.fulfill({ json: { 'qa-secret-key': EXPOSED_SECRET_SENTINEL } });
    });
}

export async function openAccountProfile(page) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'data-security'));
    await page.locator('#account_button').waitFor({ state: 'attached' });
    await page.locator('#account_button').dispatchEvent('click');
    const popup = page.locator('dialog.popup[open]').last();
    await popup.locator('.userResetAllButton').waitFor();
    return page.locator(`dialog.popup[data-id="${await popup.getAttribute('data-id')}"]`);
}

export async function openAdminPanel(page) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'data-security'));
    await page.locator('#admin_button').waitFor({ state: 'attached' });
    await page.locator('#admin_button').dispatchEvent('click');
    const popup = page.locator('dialog.popup[open]').last();
    await popup.locator('.usersList').waitFor();
    return popup;
}

export async function expectWindowFrame(popup, viewport) {
    await expect(popup).toHaveClass(/sb-dialog--window/);
    await expect(popup).not.toHaveAttribute('opening');
    const isPage = await popup.evaluate(node => node.classList.contains('sb-dialog--page'));
    if (!isPage) {
        await expect(popup).toHaveAttribute('data-presentation', viewport.presentation);
    }
}
