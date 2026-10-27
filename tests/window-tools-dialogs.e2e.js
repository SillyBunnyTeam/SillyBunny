import { expect, test } from '@playwright/test';
import {
    bootWindowToolsDialogs, captureWindowToolsSurface, currentToolPopup, DATA_MAID_VIEW_TEXT,
    DATA_MAID_FILE_HASHES, expectToolPage, expectToolParentRestored, expectToolWindow,
    WINDOW_TOOLS_SAFE_DEBUG_FUNCTION, WINDOW_TOOLS_VIEWPORTS,
} from './helpers/window-tools-dialogs.js';

test.setTimeout(90000);
test.use({ serviceWorkers: 'block' });

async function openExtensionsManager(page) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'extensions'));
    await page.locator('#extensions_details').waitFor({ state: 'visible' });
    await page.locator('#extensions_details').click();
    return currentToolPopup(page, '.extensions_info');
}

async function expectPopupSingleScroller(popup) {
    await expect(popup.locator('.popup-content')).toHaveCSS('overflow-y', 'auto');
    expect(await popup.evaluate(node => [node, node.querySelector('.popup-body')]
        .every(element => !/^(auto|scroll)$/.test(getComputedStyle(element).overflowY)))).toBe(true);
    const nestedScrollers = await popup.locator('.popup-content *').evaluateAll(elements => elements
        .filter(element => element.getClientRects().length && !element.matches('textarea, input, select'))
        .filter(element => /^(auto|scroll)$/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 1)
        .map(element => element.id || element.className));
    expect(nestedScrollers).toEqual([]);
}

async function expectTrailingChecks(root, rowSelector) {
    const failures = await root.locator(rowSelector).evaluateAll(rows => rows.flatMap(row => {
        const label = row.querySelector('.ds-row-text, .ds-row-label, .sampler_name');
        const control = row.querySelector('input[type="checkbox"]');
        if (!label || !control) return ['missing label/control'];
        const labelBox = label.getBoundingClientRect();
        const controlBox = control.getBoundingClientRect();
        return controlBox.left >= labelBox.right && (row.lastElementChild === control || row.lastElementChild.contains(control))
            ? []
            : [`${row.textContent.trim()}: checkbox is not trailing`];
    }));
    expect(failures).toEqual([]);
}

async function readExtensionSettings(page) {
    return page.evaluate(async () => {
        const { extension_settings } = await import('/scripts/extensions.js');
        return JSON.parse(JSON.stringify(extension_settings));
    });
}

async function openBranchPage(page, manager, viewport) {
    const row = manager.locator('.extension_block[data-name="/window-tools-branch"]');
    if (viewport.width <= 450) {
        await row.locator('.sb-extension-actions-menu').click();
        await page.getByRole('menuitem', { name: 'Switch branch', exact: true }).click();
        return;
    }
    await row.locator('.btn_branch').click();
}

async function observePopupResult(page) {
    return page.evaluateHandle(async () => (await import('/scripts/popup.js')).Popup.util.popups.at(-1));
}

for (const viewport of WINDOW_TOOLS_VIEWPORTS) {
    const size = `${viewport.width}×${viewport.height}`;

    test(`Token Counter is a scrollable Window and retains token results at ${size}`, async ({ page }) => {
        await bootWindowToolsDialogs(page, viewport);
        await page.locator('#extensionsMenuButton').click();
        await page.locator('#token_counter').click();
        const popup = await currentToolPopup(page, '#token_counter_textarea');
        const popupInstance = await observePopupResult(page);
        await expectToolWindow(popup, viewport);
        await expectPopupSingleScroller(popup);

        const body = popup.locator('.popup-content');
        const input = popup.locator('#token_counter_textarea');
        await expect(popup.locator('[data-sb-editor-field="token-counter-input-group"] .ds-pref-group-subtitle')).toContainText('Type / paste');
        await expect(popup.locator('.sb-dialog__subtitle')).toHaveCount(0);
        await expect(popup.locator('.ds-pref-group')).toHaveCount(2);
        await expect(popup.locator('[data-sb-editor-field="token-counter-tokenizer"]')).toContainText('Selected tokenizer');
        await expect(popup.locator('[data-sb-editor-field="token-counter-result"]')).toContainText('Tokens');
        expect(await input.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(144);
        await expect(popup.locator('#token_counter_ids')).toHaveAttribute('readonly', '');
        await expect(popup.locator('[data-sb-editor-field="token-counter-ids"] textarea')).toHaveCSS('font-family', /monospace|mono/i);
        expect(await popup.locator('.ds-row-label').evaluateAll(labels => labels.every(label => !/[：:]$/.test(label.textContent.trim())))).toBe(true);
        const text = 'The exact token-counter fixture.\n'.repeat(45);
        await input.fill(text);
        await expect.poll(() => popup.locator('#token_counter_result').textContent()).not.toBe('0');
        await expect(input).toHaveValue(text);
        const expectedIds = await page.evaluate(async text => {
            const { getTextTokens, tokenizers } = await import('/scripts/tokenizers.js');
            return getTextTokens(tokenizers.OPENAI, text);
        }, text);
        await expect(popup.locator('#token_counter_result')).toHaveText(String(expectedIds.length));
        await expect(popup.locator('#token_counter_ids')).toHaveValue(`[${expectedIds.join(', ')}]`);
        await body.evaluate(node => { node.scrollTop = node.scrollHeight; });
        await expect(popup.locator('#token_counter_ids')).toBeInViewport();
        await expect(popup.locator('.sb-dialog__close')).toBeInViewport();
        await captureWindowToolsSurface(page, viewport, 'token-counter');
        await popup.locator('.sb-dialog__close').click();
        await expect(popup).toHaveCount(0);
        expect(await popupInstance.evaluate(instance => instance.result)).toBe(1);
        await popupInstance.dispose();
    });

    test(`Extensions manager uses header menus, one scroller, and pushes nested flows at ${size}`, async ({ page }) => {
        const state = await bootWindowToolsDialogs(page, viewport, { admin: true });
        let manager = await openExtensionsManager(page);
        const initialExtensionSettings = await readExtensionSettings(page);
        await expectToolWindow(manager, viewport);
        await expectPopupSingleScroller(manager);
        if (viewport.width === 390) {
            await expect(manager.locator('.sb-dialog__title')).toHaveText('Extensions');
            expect(await manager.locator('.sb-dialog__title').evaluate(title => title.scrollWidth <= title.clientWidth)).toBe(true);
        }

        let content = manager.locator('.popup-content');
        const headerMenus = manager.locator('.extensions-header-menus');
        await expect(manager.locator('.extensions_toolbar')).toHaveCount(0);
        await expect(headerMenus.locator('button')).toHaveCount(2);
        await expect(headerMenus.locator('button[aria-haspopup="menu"]')).toHaveCount(2);
        const sortTrigger = headerMenus.getByRole('button', { name: 'Sort', exact: true });
        await expect(sortTrigger).toHaveClass(/sb-dialog__icon-button.*sb-header-icon-button/);
        await expect(sortTrigger).toBeVisible();
        await expect(headerMenus.getByRole('button', { name: 'Menu', exact: true })).toBeVisible();
        expect(await manager.evaluate(node => {
            const title = node.querySelector('.sb-dialog__title').getBoundingClientRect();
            const sort = node.querySelector('.extensions-header-menus [aria-label="Sort"]').getBoundingClientRect();
            const menu = node.querySelector('.extensions-header-menus [aria-label="Menu"]').getBoundingClientRect();
            const close = node.querySelector('.extensions-header-menus .sb-dialog__close').getBoundingClientRect();
            return sort.left >= title.right && menu.left >= sort.right && close.left >= menu.right;
        })).toBe(true);
        await expect(manager.locator('.sb-extensions-section .ds-pref-group')).toHaveCount(3);
        expect(await manager.locator('.sb-extensions-section .ds-pref-group-heading').evaluateAll(headings => headings.every(heading => !/[：:]$/.test(heading.textContent.trim())))).toBe(true);
        await expect(manager.locator('.sb-extensions-section .extension_block.ds-row')).not.toHaveCount(0);
        await expect(manager.locator('.sb-extensions-api-status .ds-row')).toHaveCount(1);
        await sortTrigger.click();
        const sortMenu = page.getByRole('menu', { name: 'Sort' });
        const sortByName = sortMenu.getByRole('menuitemradio', { name: 'Sort: Display Name' });
        const sortByLoadingOrder = sortMenu.getByRole('menuitemradio', { name: 'Sort: Loading Order' });
        await expect(sortByName).toBeVisible();
        await expect(sortByLoadingOrder).toBeVisible();
        const currentlySortedByName = await sortByName.getAttribute('aria-checked') === 'true';
        await (currentlySortedByName ? sortByLoadingOrder : sortByName).click();
        await expect(manager).toHaveCount(0);
        manager = await currentToolPopup(page, '.extensions_info');
        await expect(manager.locator('.extensions-header-menus')).toBeVisible();
        expect(await manager.locator('.sb-dialog__title').evaluate(title => title.scrollWidth <= title.clientWidth)).toBe(true);
        await manager.locator('.extensions-header-menus').getByRole('button', { name: 'Sort', exact: true }).click();
        const refreshedSortMenu = page.getByRole('menu', { name: 'Sort' });
        await expect(refreshedSortMenu.getByRole('menuitemradio', { name: 'Sort: Display Name' })).toHaveAttribute('aria-checked', String(!currentlySortedByName));
        await expect(refreshedSortMenu.getByRole('menuitemradio', { name: 'Sort: Loading Order' })).toHaveAttribute('aria-checked', String(currentlySortedByName));
        await page.keyboard.press('Escape');
        await manager.locator('.extensions-header-menus').getByRole('button', { name: 'Menu', exact: true }).click();
        const updateMenu = page.getByRole('menu', { name: 'Extensions' });
        await expect(updateMenu.getByRole('menuitem', { name: 'Update all' })).toBeVisible();
        await expect(updateMenu.getByRole('menuitem', { name: 'Update enabled' })).toBeVisible();
        await page.keyboard.press('Escape');
        content = manager.locator('.popup-content');
        const rows = manager.locator('.extension_block');
        await expect.poll(() => rows.count()).toBeGreaterThan(0);
        await content.evaluate(node => { node.scrollTop = node.scrollHeight; });
        await expect(rows.last()).toBeInViewport();
        await expect(manager.locator('.sb-dialog__close')).toBeInViewport();
        await expectTrailingChecks(manager, '.extension_block');
        await expect(manager.locator('.extension_block .extension_toggle input').first()).toHaveAttribute('role', 'switch');
        await captureWindowToolsSurface(page, viewport, 'extensions-manager-scrolled');

        await page.evaluate(async () => {
            const { openThirdPartyExtensionMenu } = await import('/scripts/extensions.js');
            void openThirdPartyExtensionMenu('https://example.test/window-tools');
        });
        const install = await currentToolPopup(page, '#extension_branch_name');
        await expect(install).toHaveClass(/sb-dialog--dialog/);
        await expectToolPage(install, manager);
        await install.locator('.popup-input').fill('https://example.test/window-tools');
        await install.locator('.popup-button-cancel').click();
        await expectToolParentRestored(page, install, manager);
        expect(state.installs).toEqual([]);

        await page.evaluate(async () => (await import('/scripts/util/AccountStorage.js')).accountStorage.removeItem('extensionInstallationWarningShown'));
        await page.locator('#third_party_extension_button').dispatchEvent('click');
        const confirmedInstall = await currentToolPopup(page, '#extension_branch_name');
        await confirmedInstall.locator('.popup-input').fill('https://example.test/window-tools');
        await confirmedInstall.locator('.popup-button-ok').click();
        const warning = await currentToolPopup(page, '#dontAskAgain');
        const warningTier = await warning.evaluate(node => node.classList.contains('sb-dialog--alert') ? 'alert' : 'dialog');
        expect(await warning.evaluate(node => node.classList.contains('sb-dialog--page'))).toBe(warningTier !== 'alert');
        expect(await manager.evaluate(node => node.hasAttribute('data-sb-covered'))).toBe(warningTier !== 'alert');
        await expectTrailingChecks(warning, '.ds-row-switch');
        await warning.locator('.popup-button-cancel').click();
        await expectToolParentRestored(page, warning, manager);
        expect(state.installs).toEqual([]);

        await openBranchPage(page, manager, viewport);
        let branch = await currentToolPopup(page, '.ds-select-row');
        await expectToolPage(branch, manager);
        await expect(branch.locator('.ds-select-row__value')).toContainText('main');
        await branch.locator('.popup-button-cancel').click();
        await expectToolParentRestored(page, branch, manager);
        expect(state.extensionRequests.filter(request => request.endpoint === 'switch')).toEqual([]);

        await openBranchPage(page, manager, viewport);
        branch = await currentToolPopup(page, '.ds-select-row');
        await branch.locator('.ds-select-row__trigger').click();
        await page.locator('.sb-picker, .sb-picker-sheet').last().getByRole('option', { name: /dev \(def456\)/ }).click();
        await branch.locator('.popup-button-ok').click();
        await expectToolParentRestored(page, branch, manager);
        expect(state.extensionRequests.filter(request => request.endpoint === 'switch')).toEqual([{
            endpoint: 'switch',
            method: 'POST',
            body: { extensionName: '/window-tools-branch', branch: 'dev', global: false },
        }]);
        await expect.poll(() => state.settings.length).toBeGreaterThan(0);
        expect(state.settings.at(-1).extension_settings).toEqual(initialExtensionSettings);
        await manager.locator('.sb-dialog__close').click();
        expect(state.extensionRequests.filter(request => ['delete', 'update', 'sync', 'move'].includes(request.endpoint))).toEqual([]);
    });

    test(`Sampler visibility uses trailing check rows and a mixed Select All at ${size}`, async ({ page }) => {
        await bootWindowToolsDialogs(page, viewport);
        await page.evaluate(() => {
            $('#main_api').val('textgenerationwebui').trigger('change');
            $('#textgen_type').val('ooba').trigger('change');
        });
        await page.locator('#samplerSelectButton').dispatchEvent('click');
        const popup = await currentToolPopup(page, '#apiSamplersList');
        const popupInstance = await observePopupResult(page);
        await expectToolWindow(popup, viewport);
        await expectPopupSingleScroller(popup);

        const rows = popup.locator('#apiSamplersList .sampler_view_list_item');
        await expect.poll(() => rows.count()).toBeGreaterThan(5);
        const selectAll = popup.locator('#apiSamplersList input[name="sampler_select_all"]');
        await expect(selectAll).toHaveCount(1);
        await expect(selectAll).toHaveAttribute('name', 'sampler_select_all');
        await expectTrailingChecks(popup, '#apiSamplersList .sampler_view_list_item');
        const all = popup.locator('#apiSamplersList .ds-row-check').first();
        await expect(all.locator('.ds-row-label')).toHaveText('Select All');

        const temperature = popup.locator('#apiSamplersList input[name="temp_checkbox"]');
        const allInputs = rows.locator('input[type="checkbox"]');
        const initiallyCheckedStates = await allInputs.evaluateAll(inputs => inputs.map(input => input.checked));
        const initiallyChecked = await temperature.isChecked();
        const relatedElement = await page.evaluateHandle(() => {
            const input = document.getElementById('temp_textgenerationwebui');
            return input.closest('[data-tg-samplers]') ?? input.parentElement;
        });
        await temperature.setChecked(!initiallyChecked);
        await expect.poll(() => relatedElement.evaluate(node => getComputedStyle(node).display !== 'none')).toBe(!initiallyChecked);
        await temperature.setChecked(initiallyChecked);
        await expect.poll(() => relatedElement.evaluate(node => getComputedStyle(node).display !== 'none')).toBe(initiallyChecked);
        await selectAll.check();
        await expect.poll(() => rows.locator('input[type="checkbox"]:checked').count()).toBe(await rows.count());
        await temperature.uncheck();
        await expect(selectAll).toHaveJSProperty('indeterminate', true);
        await captureWindowToolsSurface(page, viewport, 'sampler-visibility');
        await allInputs.evaluateAll((inputs, states) => inputs.forEach((input, index) => {
            if (input.checked === states[index]) return;
            input.checked = states[index];
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }), initiallyCheckedStates);
        await relatedElement.dispose();
        const expectedSaved = await page.evaluate(async () => (await import('/scripts/samplerSelect.js')).getApiSamplerVisibilityState());
        expect(expectedSaved).not.toHaveProperty('sampler_select_all');
        await popup.locator('.popup-content').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await expect(rows.last()).toBeInViewport();
        await expect(popup.locator('.sb-dialog__close')).toBeInViewport();
        await popup.locator('.sb-dialog__close').click();
        await expect(popup).toHaveCount(0);
        expect(await popupInstance.evaluate(instance => instance.result)).toBe(1);
        await popupInstance.dispose();
        await expect.poll(() => page.evaluate(async () => {
            const { localforage } = await import('/lib.js');
            const saved = await localforage.createInstance({ name: 'SillyTavern_TextCompletions' }).getItem('selectedSamplers');
            return saved?.ooba;
        })).toEqual(expectedSaved);
    });

    test(`Data Maid viewer pushes a page and destructive defaults cannot delete data at ${size}`, async ({ page }) => {
        const state = await bootWindowToolsDialogs(page, viewport);
        await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'interface'));
        await page.locator('#data_maid_button').click();
        const manager = await currentToolPopup(page, '.dataMaidDialog');
        await expectToolWindow(manager, viewport);
        await expectPopupSingleScroller(manager);
        await manager.locator('.dataMaidStartButton').click();
        const items = manager.locator('.dataMaidItem');
        await expect(items).toHaveCount(24);
        const category = manager.locator('.dataMaidCategory').first();
        await expect(category.locator('.dataMaidCategoryContent')).toBeVisible();
        await expect(category.locator('.dataMaidToggleCategory')).toHaveAttribute('aria-expanded', 'true');
        await expect(category.getByRole('button', { name: 'Show or Hide Files', exact: true })).toHaveAttribute('title', 'Show or Hide Files');
        await category.locator('.dataMaidToggleCategory').click();
        await expect(category.locator('.dataMaidCategoryContent')).toBeHidden();
        await expect(category.locator('.dataMaidToggleCategory')).toHaveAttribute('aria-expanded', 'false');
        await category.locator('.dataMaidToggleCategory').click();
        await expect(category.locator('.dataMaidCategoryContent')).toBeVisible();
        await expect(category.locator('.dataMaidDeleteAll')).toHaveClass(/sb-header-icon-button/);
        await expect(category.locator('.dataMaidCategoryName')).toHaveClass(/ds-pref-group-heading/);
        await expect(category.locator('.dataMaidCategoryInfo')).toContainText('·');
        const rowChecks = await category.locator('.dataMaidItem').evaluateAll(rows => rows.map(row => {
            const title = row.querySelector('.dataMaidItemName > .ds-row-label');
            const info = row.querySelector('.dataMaidItemInfo');
            const titleStyle = getComputedStyle(title);
            const infoStyle = getComputedStyle(info);
            const titleBox = title.getBoundingClientRect();
            const titleLineHeight = parseFloat(titleStyle.lineHeight) || titleBox.height;
            return {
                titleIsSingleLine: titleBox.height <= titleLineHeight * 1.5,
                titleEllipsizes: titleStyle.whiteSpace === 'nowrap' && titleStyle.overflow === 'hidden',
                parentVisibleOnce: [...row.querySelectorAll('.dataMaidItemParent')].filter(node => getComputedStyle(node).display !== 'none').length === 1,
                parentTextOnce: (info.textContent.match(/window-tools-fixture/g) ?? []).length === 1,
                upstreamParentNode: Boolean(row.querySelector('.dataMaidItemParent')),
                upstreamFileIcon: Boolean(info.querySelector('.fa-file')),
                upstreamCalendarIcon: Boolean(info.querySelector('.fa-calendar')),
                infoEllipsizes: infoStyle.whiteSpace === 'nowrap' && infoStyle.overflow === 'hidden',
            };
        }));
        expect(rowChecks).toHaveLength(24);
        expect(rowChecks.every(check => Object.values(check).every(Boolean))).toBe(true);
        await expect(category.locator('.dataMaidItemName .ds-row-label').first()).toHaveText('orphan-file-24.txt');
        await expect(category.locator('.dataMaidItemName .ds-row-subtitle').first()).toContainText('window-tools-fixture');
        await expect(category.locator('.dataMaidItem').first().locator('.dataMaidItemActions button')).toHaveCount(3);
        expect(await category.locator('.dataMaidItem').first().locator('.dataMaidItemActions button').evaluateAll(buttons => buttons.every(button => button.classList.contains('sb-header-icon-button')))).toBe(true);
        const body = manager.locator('.popup-content');
        await body.evaluate(node => { node.scrollTop = node.scrollHeight; });
        await expect(items.last()).toBeInViewport();
        await expect(manager.locator('.sb-dialog__close')).toBeInViewport();
        await expect(manager.locator('.dataMaidResultsList')).toHaveCSS('overflow-y', 'visible');
        await captureWindowToolsSurface(page, viewport, 'data-maid-scanned');

        await items.first().locator('.dataMaidItemView').click();
        const viewer = await currentToolPopup(page, '.dataMaidTextView');
        const viewerInstance = await observePopupResult(page);
        await expect(viewer).toHaveClass(/sb-dialog--window/);
        await expectToolPage(viewer, manager);
        await expect(viewer.locator('.dataMaidTextView')).toHaveValue(DATA_MAID_VIEW_TEXT);
        await viewer.getByRole('button', { name: 'Back', exact: true }).click();
        await expectToolParentRestored(page, viewer, manager);
        expect(await viewerInstance.evaluate(instance => instance.result)).toBe(0);
        await viewerInstance.dispose();

        await items.first().locator('.dataMaidItemDelete').click();
        const confirmation = await currentToolPopup(page, '.popup-button-cancel');
        await expect(confirmation).toHaveClass(/sb-dialog--alert/);
        await expect(confirmation.locator('.popup-button-ok')).toHaveClass(/is-destructive/);
        await expect(confirmation.locator('.popup-button-cancel')).toBeFocused();
        await expect(confirmation.locator('.popup-button-ok')).toBeInViewport();
        await page.keyboard.press('Enter');
        await expect(confirmation).toHaveCount(0);
        await expect(manager).toBeVisible();
        expect(state.dataMaidDeletes).toEqual([]);

        const expectedCategoryHashes = await category.locator('.dataMaidItem').evaluateAll(items => items.map(item => item.dataset.hash));
        expect(expectedCategoryHashes).toEqual(DATA_MAID_FILE_HASHES);
        await category.locator('.dataMaidDeleteAll').click();
        const categoryConfirmation = await currentToolPopup(page, '.popup-button-cancel');
        await expect(categoryConfirmation).toHaveClass(/sb-dialog--alert/);
        await expect(categoryConfirmation.locator('.popup-button-ok')).toHaveClass(/is-destructive/);
        await expect(categoryConfirmation.locator('.popup-button-cancel')).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(categoryConfirmation).toHaveCount(0);
        expect(state.dataMaidDeletes).toEqual([]);

        await category.locator('.dataMaidDeleteAll').click();
        const confirmedCategoryDeletion = await currentToolPopup(page, '.popup-button-ok');
        await expect(confirmedCategoryDeletion.locator('.popup-button-cancel')).toBeFocused();
        await confirmedCategoryDeletion.locator('.popup-button-ok').click();
        await expect.poll(() => state.dataMaidDeletes.length).toBe(1);
        expect(state.dataMaidDeletes).toEqual([{
            hashes: expectedCategoryHashes,
            token: 'window-tools-data-maid-token',
        }]);
        await expect(category).toHaveCount(0);
        await captureWindowToolsSurface(page, viewport, 'data-maid-parent-restored');
        await manager.locator('.sb-dialog__close').click();
        await expect.poll(() => state.dataMaidFinalizes.length).toBe(1);
        expect(state.dataMaidFinalizes).toEqual([{ token: 'window-tools-data-maid-token' }]);
    });

    test(`Debug Menu rows scroll in the shared Window and action execution stays intercepted at ${size}`, async ({ page }) => {
        await bootWindowToolsDialogs(page, viewport);
        await page.evaluate(async functionId => {
            const { registerDebugFunction } = await import('/scripts/power-user.js');
            registerDebugFunction(functionId, 'Window tools safe action', 'A harmless test-only action.', () => {
                window.__windowToolsDebugRuns += 1;
            });
        }, WINDOW_TOOLS_SAFE_DEBUG_FUNCTION);
        await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'interface'));
        await page.locator('#debug_menu').click();
        const popup = await currentToolPopup(page, '#debug_table');
        const popupInstance = await observePopupResult(page);
        await expectToolWindow(popup, viewport);
        await expectPopupSingleScroller(popup);

        const actions = popup.locator('#debug_table [data-debug-function]');
        await expect.poll(() => actions.count()).toBeGreaterThan(0);
        const rows = popup.locator('#debug_table .ds-row-debug');
        await expect(rows).toHaveCount(await actions.count());
        const body = popup.locator('.popup-content');
        await body.evaluate(node => { node.scrollTop = node.scrollHeight; });
        await expect(rows.last()).toBeInViewport();
        await expect(popup.locator('.sb-dialog__close')).toBeInViewport();
        const action = actions.last();
        await expect(action).toHaveAttribute('data-debug-function', WINDOW_TOOLS_SAFE_DEBUG_FUNCTION);
        const row = action.locator('xpath=ancestor::tr[1]');
        await expect(row).toContainText(await action.evaluate(node => node.closest('.ds-row-debug').querySelector('.ds-row-label').textContent));
        await expect(action).toBeInViewport();
        expect(await action.evaluate(node => {
            const rowNode = node.closest('.ds-row-debug');
            const labelBox = rowNode.querySelector('.ds-row-text').getBoundingClientRect();
            const actionBox = node.getBoundingClientRect();
            return actionBox.left >= labelBox.right && rowNode.lastElementChild.contains(node);
        })).toBe(true);
        await captureWindowToolsSurface(page, viewport, 'debug-menu-scrolled');

        const blockedAction = popup.locator('#debug_table [data-debug-function]:not([data-debug-function="window-tools-safe-action"])').first();
        const blockedFunctionId = await blockedAction.getAttribute('data-debug-function');
        await blockedAction.click();
        expect(await page.evaluate(() => window.__windowToolsBlockedDebugActions)).toEqual([blockedFunctionId]);
        expect(await page.evaluate(() => window.__windowToolsDebugRuns)).toBe(0);
        await action.click();
        expect(await page.evaluate(() => window.__windowToolsDebugRuns)).toBe(1);
        expect(await page.evaluate(() => window.__windowToolsBlockedDebugActions)).toEqual([blockedFunctionId]);
        await popup.locator('.sb-dialog__close').click();
        expect(await popupInstance.evaluate(instance => instance.result)).toBe(1);
        await popupInstance.dispose();
    });
}
