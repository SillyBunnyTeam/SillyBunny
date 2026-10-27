import { expect, test } from '@playwright/test';
import {
    ATTACHMENT_COUNT, ATTACHMENT_TEXT, SECRET_COUNT, SECRET_SENTINEL, WINDOW_VIEWPORTS,
    bootWindowDialogs, captureWindowSurface, currentPopup, expectDebuggerScrollers,
    expectInsideBody, expectNoSecretLeaks, expectParentRestored, expectPushedPage,
    expectWindow, openApiKeyManager, openDataBank, openRegex,
} from './helpers/window-dialogs.js';
import { expectSharedDialogEntryStyles } from './helpers/dialog-entry-parity.js';

test.setTimeout(90000);
test.use({ serviceWorkers: 'block' });

async function readExtensions(page) {
    return page.evaluate(async () => {
        const { extension_settings } = await import('/scripts/extensions.js');
        return { attachments: extension_settings.attachments, regex: extension_settings.regex };
    });
}

test('Regex debugger keeps its two-column rows coherent at 1024×768', async ({ page }) => {
    const viewport = { width: 1024, height: 768, presentation: 'floating' };
    await bootWindowDialogs(page, viewport);
    const debuggerPopup = await openRegex(page, 'debugger');
    await expectWindow(debuggerPopup, viewport);
    const checks = await debuggerPopup.locator('.regex-debugger-rule').evaluateAll(rules => rules.map(rule => {
        const list = rule.closest('.sortable-list').getBoundingClientRect();
        const row = rule.getBoundingClientRect();
        const regex = rule.querySelector('.rule-regex');
        const scope = rule.querySelector('.rule-scope');
        const handle = rule.querySelector('.handle').getBoundingClientRect();
        const editStyle = getComputedStyle(rule.querySelector('.edit_rule'));
        const lineHeight = node => parseFloat(getComputedStyle(node).lineHeight) || node.getBoundingClientRect().height;
        return regex.getClientRects().length === 1
            && regex.getBoundingClientRect().height <= lineHeight(regex) * 1.5
            && scope.getClientRects().length === 1
            && scope.getBoundingClientRect().height <= lineHeight(scope) * 1.5
            && row.right <= list.right + 1
            && handle.left - list.left <= 16
            && (editStyle.backgroundColor === 'transparent' || editStyle.backgroundColor === 'rgba(0, 0, 0, 0)');
    }));
    expect(checks.every(Boolean)).toBe(true);
    await debuggerPopup.locator('.popup-content').evaluate(node => { node.scrollTop = 0; });
    await captureWindowSurface(page, viewport, 'regex-debugger');
});

test.describe('coarse-pointer Data Bank close target', () => {
    test.use({ hasTouch: true });
    for (const viewport of WINDOW_VIEWPORTS) {
        test(`keeps Close at 44×44 at ${viewport.width}×${viewport.height}`, async ({ page }) => {
            await bootWindowDialogs(page, viewport);
            const manager = await openDataBank(page);
            const close = await manager.locator('.popup-button-close').boundingBox();
            expect(close).toMatchObject({ width: 44, height: 44 });
        });
    }
});

async function flushSettings(page) {
    await page.evaluate(async () => (await import('/script.js')).saveSettings());
}

async function readDebuggerResults(popup) {
    return popup.evaluate(node => ({
        steps: node.querySelector('#regex_debugger_steps_output').innerHTML,
        final: node.querySelector('#regex_debugger_final_output').innerHTML,
        rules: [...node.querySelectorAll('.regex-debugger-rule')].map(rule => ({
            id: rule.dataset.id,
            name: rule.querySelector('.rule-name').textContent,
            regex: rule.querySelector('.rule-regex').textContent,
            enabled: rule.querySelector('.rule-enabled').checked,
        })),
    }));
}

async function dismissPopup(page, popup, exit) {
    if (exit === 'escape') {
        await page.keyboard.press('Escape');
        return;
    }
    if (exit === 'back') {
        await popup.getByRole('button', { name: 'Back', exact: true }).click();
        return;
    }
    await popup.locator(exit === 'save' ? '.popup-button-ok' : '.popup-button-cancel').click();
}

async function navigateExpandedResult(page, parent, viewport, view, exit, results) {
    await parent.locator(`#regex_debugger_expand_${view}`).click();
    const expanded = await currentPopup(page, view === 'steps' ? '.expanded-regex-container' : '.regex-popup-content');
    await expectPushedPage(expanded, parent);
    await expectDebuggerScrollers(expanded, { expanded: true });
    expect(await expanded.locator(view === 'steps' ? '.expanded-regex-content' : '.regex-popup-content').innerHTML()).toBe(results[view]);
    if (view === 'steps') {
        const lastLink = expanded.locator('.expanded-regex-nav a').last();
        await lastLink.click();
        await expect(lastLink).toHaveClass(/active/);
        await expect(expanded.locator('.expanded-regex-content .step-result')).toHaveCount(12);
        await expect.poll(() => expanded.locator('.popup-content').evaluate(node => node.scrollTop)).toBeGreaterThan(0);
        await expectInsideBody(expanded.locator('.expanded-regex-content .step-result').last().locator('.step-header'), expanded);
    }
    await captureWindowSurface(page, viewport, `regex-expanded-${view}`);
    await dismissPopup(page, expanded, exit);
    await expectParentRestored(page, expanded, parent);
    expect(await readDebuggerResults(parent)).toEqual(results);
}

async function addSecretAndDismiss(page, manager, viewport, state, exit) {
    const parent = await manager.elementHandle();
    await manager.locator('[data-action="add-secret"]').click();
    const alert = await currentPopup(page, '#newSecretLabel');
    await expect(alert).toHaveClass(/sb-dialog--alert/);
    await expect(alert).not.toHaveClass(/sb-dialog--page/);
    await expect(alert).toHaveAttribute('role', 'alertdialog');
    await expect(page.locator('dialog.popup[open]')).toHaveCount(2);
    await alert.locator('textarea.popup-input').fill(SECRET_SENTINEL);
    await alert.locator('#newSecretLabel').fill('  Added fixture  ');
    await expectNoSecretLeaks(page, state);
    await captureWindowSurface(page, viewport, 'api-keys-add-alert');
    await dismissPopup(page, alert, exit);
    await expectParentRestored(page, alert, manager);
    expect(await manager.evaluate((node, original) => node === original, parent)).toBe(true);
    await parent.dispose();
    await expectNoSecretLeaks(page, state);
    if (exit !== 'save') expect(state.secrets.filter(request => request.endpoint === 'write')).toEqual([]);
}

async function renameSecretAndDismiss(page, manager, viewport, state, exit) {
    await manager.locator('[data-action="rename-secret"][data-id="window-secret-23"]').click();
    const alert = await currentPopup(page, 'textarea.popup-input');
    await expect(alert).toHaveClass(/sb-dialog--alert/);
    await expect(alert).not.toHaveClass(/sb-dialog--page/);
    await alert.locator('.popup-input').fill('Renamed fixture');
    await captureWindowSurface(page, viewport, 'api-keys-rename-alert');
    await dismissPopup(page, alert, exit);
    await expectParentRestored(page, alert, manager);
    if (exit !== 'save') expect(state.secrets.filter(request => request.endpoint === 'rename')).toEqual([]);
}

async function openScraperNotepad(page, manager) {
    await manager.locator('.globalAttachmentsTitle .openActionModalButton').click();
    await manager.locator('.actionButtonsModal .actionButton').filter({ hasText: 'Notepad' }).click();
    return currentPopup(page, '[name="notepadFileContent"]');
}

for (const viewport of WINDOW_VIEWPORTS) {
    const size = `${viewport.width}×${viewport.height}`;

    test(`Data Bank Window reaches last actions, toggles :has() bulk mode and accepts a .popup file drop at ${size}`, async ({ page }) => {
        const state = await bootWindowDialogs(page, viewport);
        const manager = await openDataBank(page);
        await expectWindow(manager, viewport);
        await captureWindowSurface(page, viewport, 'data-bank-main');
        const bulkBox = await manager.locator('.attachmentsBulkEditButton').boundingBox();
        const closeBox = await manager.locator('.popup-button-close').boundingBox();
        expect(bulkBox).not.toBeNull();
        expect(closeBox).not.toBeNull();
        expect(bulkBox.x + bulkBox.width <= closeBox.x || closeBox.x + closeBox.width <= bulkBox.x
            || bulkBox.y + bulkBox.height <= closeBox.y || closeBox.y + closeBox.height <= bulkBox.y).toBe(true);
        const endControlRights = await manager.locator('.sb-dialog__header-end > *').evaluateAll(nodes => nodes
            .filter(node => node.getClientRects().length > 0)
            .map(node => ({ className: node.className, right: node.getBoundingClientRect().right })));
        const closeRight = endControlRights.find(control => control.className.includes('popup-button-close'))?.right;
        expect(closeRight).toBe(Math.max(...endControlRights.map(control => control.right)));
        await expect(manager.locator('.attachmentsBulkEditButton')).toHaveClass(/sb-header-icon-button/);
        await expect(manager.locator('.attachmentsBulkEditButton')).toHaveAttribute('aria-label', 'Bulk Edit');
        await expect(manager.locator('.attachmentsBulkEditButton i')).toHaveClass(/fa-check-square/);
        const headingStyles = await manager.locator('.globalAttachmentsTitle').evaluate(node => {
            const probeSurface = document.createElement('dialog');
            probeSurface.className = 'popup sb-dialog sb-dialog--window';
            const probeContent = document.createElement('div');
            probeContent.className = 'popup-content';
            const probeHeading = document.createElement('h3');
            probeHeading.className = 'ds-pref-group-heading';
            probeContent.append(probeHeading);
            probeSurface.append(probeContent);
            document.body.append(probeSurface);
            const actual = getComputedStyle(node);
            const reference = getComputedStyle(probeHeading);
            const result = {
                actual: { fontSize: actual.fontSize, fontWeight: actual.fontWeight, letterSpacing: actual.letterSpacing },
                reference: { fontSize: reference.fontSize, fontWeight: reference.fontWeight, letterSpacing: reference.letterSpacing },
            };
            probeSurface.remove();
            return result;
        });
        expect(headingStyles.actual).toEqual(headingStyles.reference);
        await expect(manager.locator('.sb-data-bank-search-toggle')).toHaveAttribute('aria-expanded', 'false');
        await expect(manager.locator('.sb-data-bank-search-toggle')).not.toHaveAttribute('aria-pressed', 'true');
        const rows = manager.locator('.globalAttachmentsList .attachmentListItem');
        await expect(rows).toHaveCount(ATTACHMENT_COUNT);
        await expect(manager.locator('.characterAttachmentsList .attachmentEmptyRow')).toHaveText('No data');
        await expect(manager.locator('.chatAttachmentsList .attachmentEmptyRow')).toHaveText('No data');
        await expect(manager.locator('.sb-data-bank-search-toggle')).toBeVisible();
        await manager.locator('.sb-data-bank-search-toggle').click();
        await expect(manager.locator('#attachmentSearch')).toBeVisible();
        await expectSharedDialogEntryStyles(manager.locator('#attachmentSearch'));
        await expect(manager.locator('.sb-data-bank-search-toggle')).toHaveAttribute('aria-expanded', 'true');
        await manager.locator('#attachmentSearch').fill('attachment 28');
        await expect(rows).toHaveCount(1);
        await manager.locator('#attachmentSearch').fill('');
        await expect(rows).toHaveCount(ATTACHMENT_COUNT);
        await manager.locator('#attachmentSearch').fill('no-matching-attachment');
        await expect(rows).toHaveCount(0);
        await expect(manager.locator('.data-bank-search-status')).toHaveText('No results');
        await manager.locator('#attachmentSearch').fill('');
        await expect(rows).toHaveCount(ATTACHMENT_COUNT);
        await manager.locator('.sb-data-bank-search-toggle').click();
        await expect(manager.locator('#attachmentSearch')).toBeHidden();
        await expect(manager.locator('.sb-data-bank-search-toggle')).toHaveAttribute('aria-expanded', 'false');
        await manager.locator('.sb-data-bank-sort').click();
        await manager.getByRole('menuitemradio', { name: 'Name (Z-A)' }).click();
        await expect(rows.first().locator('.attachmentListItemName')).toHaveText('Window attachment 28.txt');
        const sortState = await page.evaluate(async () => {
            const { accountStorage } = await import('/scripts/util/AccountStorage.js');
            return [accountStorage.getItem('DataBank_sortField'), accountStorage.getItem('DataBank_sortOrder')];
        });
        expect(sortState).toEqual(['name', 'desc']);
        await manager.locator('.sb-data-bank-sort').click();
        await manager.getByRole('menuitemradio', { name: 'Name (A-Z)' }).click();
        for (const [section, source] of [['characterAttachmentsBlock', 'character'], ['chatAttachmentsBlock', 'chat']]) {
            await manager.locator(`.${section} .openActionModalButton`).click();
            await expect(manager.locator('.actionButtonsModal')).toHaveAttribute('data-attachment-manager-target', source);
            await manager.locator('.globalAttachmentsTitle').click();
        }
        const body = manager.locator('.popup-content');
        expect(await body.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
        await rows.last().scrollIntoViewIfNeeded();
        await expect(rows.last().locator('.attachmentListItemName')).toHaveText('Window attachment 28.txt');
        await expect(rows.last().locator('.attachmentListItemMeta')).toContainText('1000 B');
        await expect(rows.last().locator('.viewAttachmentButton')).toBeVisible();
        await expect(rows.last().locator('.attachmentRowMenu')).toBeVisible();
        const rowBounds = await rows.last().boundingBox();
        const menuBounds = await rows.last().locator('.attachmentRowMenu').boundingBox();
        expect(menuBounds.x).toBeGreaterThan(rowBounds.x + rowBounds.width / 2);
        await expect(rows.last().locator('.right_menu_button')).toHaveCount(7);
        await expect(rows.last().locator('.disableAttachmentButton')).toBeHidden();
        expect(await body.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
        await captureWindowSurface(page, viewport, 'data-bank-last-row');

        const deletesBeforeConfirm = state.deletes.length;
        await rows.first().locator('.attachmentRowMenu').click();
        await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
        const deleteAlert = page.getByRole('alertdialog');
        await expect(deleteAlert).toBeVisible();
        await expect(deleteAlert.locator('.popup-button-cancel')).toBeFocused();
        await page.keyboard.press('Enter');
        expect(state.deletes).toHaveLength(deletesBeforeConfirm);
        await expect(deleteAlert).toHaveCount(0);

        await rows.first().locator('.attachmentRowMenu').click();
        await page.getByRole('menuitem', { name: 'Disable', exact: true }).click();
        await expect(rows.first()).toHaveClass(/disabled/);
        await rows.first().locator('.attachmentRowMenu').click();
        await page.getByRole('menuitem', { name: 'Enable', exact: true }).click();
        await expect(rows.first()).not.toHaveClass(/disabled/);

        await rows.first().locator('.attachmentRowMenu').click();
        await page.getByRole('menuitem', { name: 'Move', exact: true }).click();
        const moveDialog = await currentPopup(page, '.moveAttachmentTarget');
        await expect(moveDialog.locator('.moveAttachmentTarget')).toBeVisible();
        await moveDialog.locator('.popup-button-cancel').click();
        await expect(moveDialog).toHaveCount(0);

        const downloadPromise = page.waitForEvent('download');
        await rows.first().locator('.attachmentRowMenu').click();
        await page.getByRole('menuitem', { name: 'Download', exact: true }).click();
        expect((await downloadPromise).suggestedFilename()).toBe('Window attachment 01.txt');

        await manager.locator('.attachmentsBulkEditButton').click();
        await expect(manager.locator('.attachmentsBulkEditCheckbox')).toBeChecked();
        await expect(manager.locator('.attachmentsBulkEditButton')).toHaveAttribute('aria-pressed', 'true');
        expect(await manager.locator('.dataBankAttachments').evaluate(node => node.matches(':has(.attachmentsBulkEditCheckbox:checked)'))).toBe(true);
        await expect(manager.locator('.sb-data-bank-action-bar')).toHaveCSS('display', 'flex');
        await captureWindowSurface(page, viewport, 'data-bank-bulk');
        const actionBarBounds = await manager.locator('.sb-data-bank-action-bar').boundingBox();
        const bodyBounds = await body.boundingBox();
        expect(actionBarBounds.y).toBeGreaterThanOrEqual(bodyBounds.y + bodyBounds.height - 1);
        expect(actionBarBounds.x + actionBarBounds.width).toBeLessThanOrEqual((await manager.boundingBox()).x + (await manager.boundingBox()).width + 1);
        await expect(rows.first().locator('.attachmentListItemCheckboxContainer')).toHaveCSS('display', 'flex');
        await expect(rows.first().locator('.attachmentFileIcon')).toBeHidden();
        await manager.locator('.attachmentsBulkEditButton').click();
        await expect(manager.locator('.attachmentsBulkEditCheckbox')).not.toBeChecked();
        await expect(manager.locator('.attachmentBulkActionsContainer')).toBeHidden();
        await expect(rows.first().locator('.attachmentListItemCheckboxContainer')).toBeHidden();
        await expect(rows.first().locator('.attachmentFileIcon')).toBeVisible();
        if (viewport.width <= 450) {
            const add = manager.locator('.globalAttachmentsTitle .openActionModalButton');
            await expect(add).toHaveCSS('width', '44px');
            await expect(add.locator('span')).toBeHidden();
        }
        await manager.locator('.attachmentsBulkEditButton').click();
        await rows.first().locator('.attachmentListItemCheckbox').check();
        await manager.locator('.bulkActionDisable').click();
        await expect(rows.first()).toHaveClass(/disabled/);
        await expect(manager.locator('.attachmentsBulkEditCheckbox')).not.toBeChecked();
        await expect(manager.locator('.attachmentBulkActionsContainer')).toBeHidden();

        await manager.locator('.attachmentsBulkEditButton').click();
        await manager.locator('.bulkActionSelectAll').click();
        await expect(manager.locator('.attachmentListItemCheckbox:checked')).toHaveCount(ATTACHMENT_COUNT);
        await manager.locator('.bulkActionSelectNone').click();
        await expect(manager.locator('.attachmentListItemCheckbox:checked')).toHaveCount(0);
        await rows.first().locator('.attachmentListItemCheckbox').check();
        await manager.locator('.bulkActionEnable').click();
        await expect(rows.first()).not.toHaveClass(/disabled/);

        const deletesBeforeBulkConfirm = state.deletes.length;
        await manager.locator('.attachmentsBulkEditButton').click();
        await rows.first().locator('.attachmentListItemCheckbox').check();
        await manager.locator('.bulkActionDelete').click();
        const bulkDeleteAlert = await currentPopup(page, '.popup-content');
        await expect(bulkDeleteAlert).toHaveAttribute('role', 'alertdialog');
        await expect(bulkDeleteAlert.locator('.popup-button-cancel')).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(bulkDeleteAlert).toHaveCount(0);
        expect(state.deletes).toHaveLength(deletesBeforeBulkConfirm);

        const transfer = await page.evaluateHandle(() => {
            const data = new DataTransfer();
            data.items.add(new File(['dropped window fixture'], 'dropped-window.txt', { type: 'text/plain' }));
            return data;
        });
        await manager.dispatchEvent('dragover', { dataTransfer: transfer });
        await expect(manager).toHaveClass(/drop_target.*dragover/);
        await manager.dispatchEvent('drop', { dataTransfer: transfer });
        await transfer.dispose();
        const choice = await currentPopup(page, '.droppedFilesTarget');
        await expectPushedPage(choice, manager);
        await choice.locator('.popup-button-ok').click();
        await expectParentRestored(page, choice, manager);
        await expect.poll(() => state.uploads.length).toBe(1);
        expect(Buffer.from(state.uploads[0].data, 'base64').toString()).toBe('dropped window fixture');
        await expect(rows).toHaveCount(ATTACHMENT_COUNT + 1);
        await flushSettings(page);
        expect(state.settings.at(-1).extension_settings.attachments).toContainEqual(expect.objectContaining({ name: 'dropped-window.txt', url: state.uploads[0].path }));
        expect(state.deletes).toEqual([]);
    });

    test(`Data Bank viewer Back/Escape and notepad Cancel/Escape preserve the parent; Save persists at ${size}`, async ({ page }) => {
        const state = await bootWindowDialogs(page, viewport);
        const manager = await openDataBank(page);
        const row = manager.locator('.globalAttachmentsList [data-attachment-url="/fixtures/window-0.txt"]');
        const baseline = await readExtensions(page);
        for (const exit of ['back', 'escape']) {
            await row.locator('.viewAttachmentButton').click();
            const viewer = await currentPopup(page, '.file_modal');
            await expect(viewer).toHaveClass(/sb-dialog--window/);
            await expectPushedPage(viewer, manager);
            await expect(viewer.locator('code.txt')).toHaveText(ATTACHMENT_TEXT);
            await expect(viewer.getByRole('button', { name: 'Back', exact: true })).toBeInViewport();
            await captureWindowSurface(page, viewport, 'data-bank-viewer');
            await dismissPopup(page, viewer, exit);
            await expectParentRestored(page, viewer, manager);
        }
        for (const exit of ['cancel', 'escape']) {
            await row.locator('.attachmentRowMenu').click();
            await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
            const editor = await currentPopup(page, '[name="notepadFileContent"]');
            await expectPushedPage(editor, manager);
            await expect(editor.locator('[name="notepadFileContent"]')).toHaveValue(ATTACHMENT_TEXT);
            await editor.locator('[name="notepadFileName"]').fill('discarded.txt');
            await editor.locator('[name="notepadFileContent"]').fill('discarded attachment edits');
            await dismissPopup(page, editor, exit);
            await expectParentRestored(page, editor, manager);
            expect(await readExtensions(page)).toEqual(baseline);
            expect(state.uploads).toEqual([]);
            expect(state.deletes).toEqual([]);
        }
        await row.locator('.attachmentRowMenu').click();
        await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
        const editor = await currentPopup(page, '[name="notepadFileContent"]');
        await expectPushedPage(editor, manager);
        await editor.locator('[name="notepadFileName"]').fill('saved-window-attachment.txt');
        await editor.locator('[name="notepadFileContent"]').fill('Saved attachment: exact whitespace\n  second line\n');
        await captureWindowSurface(page, viewport, 'data-bank-notepad');
        await editor.locator('.popup-button-ok').click();
        await expectParentRestored(page, editor, manager);
        await expect.poll(() => state.uploads.length).toBe(1);
        expect(Buffer.from(state.uploads[0].data, 'base64').toString()).toBe('Saved attachment: exact whitespace\n  second line\n');
        expect(state.deletes).toEqual([{ path: '/fixtures/window-0.txt' }]);
        await expect(manager.locator('.globalAttachmentsList')).toContainText('saved-window-attachment.txt');
        await flushSettings(page);
        const saved = state.settings.at(-1).extension_settings.attachments;
        expect(saved).toHaveLength(ATTACHMENT_COUNT);
        expect(saved.some(item => item.url === '/fixtures/window-0.txt')).toBe(false);
        expect(saved).toContainEqual(expect.objectContaining({ name: 'saved-window-attachment.txt', url: state.uploads[0].path }));

        await manager.locator('.globalAttachmentsList [data-attachment-url="/fixtures/window-1.txt"] .viewAttachmentButton').click();
        const chainViewer = await currentPopup(page, '.file_modal');
        await expectPushedPage(chainViewer, manager);
        await expect(chainViewer.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
        await chainViewer.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(page.locator('dialog.popup')).toHaveCount(0);
        expect(state.uploads).toHaveLength(1);
        expect(state.deletes).toEqual([{ path: '/fixtures/window-0.txt' }]);
    });

    test(`scrapers.js Notepad pushes a page and returns a File only on Save at ${size}`, async ({ page }) => {
        const state = await bootWindowDialogs(page, viewport);
        const manager = await openDataBank(page);
        // Observe the real return boundary without substituting the scraper or its Popup.
        await page.evaluate(async () => {
            const { ScraperManager } = await import('/scripts/scrapers.js');
            const runScraper = ScraperManager.runDataBankScraper.bind(ScraperManager);
            window.__windowScraperResults = [];
            ScraperManager.runDataBankScraper = async id => {
                const files = await runScraper(id);
                window.__windowScraperResults.push(files ? await Promise.all(files.map(async file => ({
                    isFile: file instanceof File, name: file.name, type: file.type, text: await file.text(),
                }))) : null);
                return files;
            };
        });
        for (const exit of ['cancel', 'escape']) {
            const notepad = await openScraperNotepad(page, manager);
            await expectPushedPage(notepad, manager);
            await notepad.locator('[name="notepadFileContent"]').fill('unsaved scraper note');
            await dismissPopup(page, notepad, exit);
            await expectParentRestored(page, notepad, manager);
        }
        const notepad = await openScraperNotepad(page, manager);
        await expectPushedPage(notepad, manager);
        await notepad.locator('[name="notepadFileName"]').fill('  scraper-window-note  ');
        await notepad.locator('[name="notepadFileContent"]').fill('scraper file result\n');
        await captureWindowSurface(page, viewport, 'scraper-notepad');
        await notepad.locator('.popup-button-ok').click();
        await expectParentRestored(page, notepad, manager);
        await expect.poll(() => page.evaluate(() => window.__windowScraperResults)).toEqual([
            null, null, [{ isFile: true, name: 'Notepad - scraper-window-note.txt', type: 'text/plain', text: 'scraper file result\n' }],
        ]);
        await expect.poll(() => state.uploads.length).toBe(1);
        expect(Buffer.from(state.uploads[0].data, 'base64').toString()).toBe('scraper file result\n');
        await expect(manager.locator('.globalAttachmentsList')).toContainText('Notepad - scraper-window-note.txt');
    });

    test(`Regex editor Window reaches trailing switches and saves exact script values, not Cancel at ${size}`, async ({ page }) => {
        const state = await bootWindowDialogs(page, viewport);
        const editor = await openRegex(page, 'editor');
        await expectWindow(editor, viewport);
        await editor.locator('.popup-content').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await expectInsideBody(editor.locator('input[name="only_format_prompt"]'), editor);
        await expect(editor.locator('input[type="checkbox"]')).toHaveCount(9);
        for (const name of ['disabled', 'run_on_edit', 'only_format_display', 'only_format_prompt']) {
            await expect(editor.locator(`input[name="${name}"]`)).toBeEnabled();
            await expectInsideBody(editor.locator(`input[name="${name}"]`), editor);
        }
        await editor.locator('.regex_script_name').fill('Window saved regex');
        await editor.locator('.find_regex').fill('/saved/g');
        await editor.locator('.regex_replace_string').fill('persisted $1\n');
        await editor.locator('.regex_trim_strings').fill('trim-one\ntrim-two');
        await editor.locator('input[name="replace_position"][value="1"]').uncheck();
        await editor.locator('input[name="replace_position"][value="2"]').check();
        await editor.locator('input[name="replace_position"][value="6"]').check();
        await editor.locator('input[name="disabled"]').check();
        await editor.locator('input[name="run_on_edit"]').uncheck();
        await editor.locator('input[name="only_format_display"]').uncheck();
        await editor.locator('input[name="only_format_prompt"]').check();
        await editor.locator('select[name="substitute_regex"]').selectOption('2');
        await editor.locator('input[name="min_depth"]').fill('1');
        await editor.locator('input[name="max_depth"]').fill('9');
        await editor.locator('.popup-content').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await captureWindowSurface(page, viewport, 'regex-editor-last-controls');
        await editor.locator('.popup-button-ok').click();
        await expect(editor).toHaveCount(0);
        const expected = {
            scriptName: 'Window saved regex', findRegex: '/saved/g', replaceString: 'persisted $1\n',
            trimStrings: ['trim-one', 'trim-two'], placement: [2, 6], disabled: true,
            markdownOnly: false, promptOnly: true, runOnEdit: false, substituteRegex: 2, minDepth: 1, maxDepth: 9,
        };
        await expect.poll(async () => (await readExtensions(page)).regex.at(-1)).toMatchObject(expected);
        await expect.poll(() => state.settings.some(settings => settings.extension_settings.regex.some(script => script.scriptName === expected.scriptName)), { timeout: 15000 }).toBe(true);
        expect(state.settings.at(-1).extension_settings.regex.at(-1)).toMatchObject(expected);
        const baseline = await readExtensions(page);
        const cancelled = await openRegex(page, 'editor');
        await cancelled.locator('.regex_script_name').fill('Window cancelled regex');
        await cancelled.locator('.find_regex').fill('/discarded/g');
        await cancelled.locator('.popup-button-cancel').click();
        await expect(cancelled).toHaveCount(0);
        expect(await readExtensions(page)).toEqual(baseline);
        await flushSettings(page);
        expect(state.settings.at(-1).extension_settings.regex).toEqual(baseline.regex);

        const savedId = baseline.regex.at(-1).id;
        await page.locator(`#saved_regex_scripts [id="${savedId}"] .edit_existing_regex`).dispatchEvent('click');
        const existing = await currentPopup(page, '.regex_editor');
        await expect(existing.locator('.find_regex')).toHaveValue(expected.findRegex);
        await existing.locator('.find_regex').fill('/discarded-existing-edit/g');
        await existing.locator('input[name="disabled"]').uncheck();
        await existing.locator('.popup-button-cancel').click();
        await expect(existing).toHaveCount(0);
        expect(await readExtensions(page)).toEqual(baseline);
        await flushSettings(page);
        expect(state.settings.at(-1).extension_settings.regex).toEqual(baseline.regex);
    });

    test(`Regex debugger has one outer scroller and Steps/Final push/pop without altering results at ${size}`, async ({ page }) => {
        const state = await bootWindowDialogs(page, viewport);
        const debuggerPopup = await openRegex(page, 'debugger');
        await expectWindow(debuggerPopup, viewport);
        await expect(debuggerPopup.locator('.regex-debugger-rules-list')).toBeVisible();
        await expect(debuggerPopup.locator('.regex-debugger-rule')).not.toHaveCount(0);
        await expect(debuggerPopup.locator('.ds-toggle-row')).toBeVisible();
        await expect(debuggerPopup.locator('.ds-select-row')).toBeVisible();
        await expect(debuggerPopup.locator('.regex-debugger-run-button')).toBeVisible();
        await expect(debuggerPopup.locator('.regex-debugger-controls .ds-pref-group')).toHaveCount(1);
        await expect(debuggerPopup.locator('#regex_debugger_run_test')).toHaveCSS('white-space', 'nowrap');
        await expect(debuggerPopup.locator('.regex-debugger-tester .ds-pref-group-heading')).toHaveCount(3);
        const ruleLayout = await debuggerPopup.locator('.regex-debugger-rule').evaluateAll(rules => rules.map(rule => {
            const list = rule.closest('.sortable-list');
            const row = rule.getBoundingClientRect();
            const details = rule.querySelector('.rule-details').getBoundingClientRect();
            const name = rule.querySelector('.rule-name');
            const regex = rule.querySelector('.rule-regex');
            const scope = rule.querySelector('.rule-scope');
            const handle = rule.querySelector('.handle').getBoundingClientRect();
            const edit = rule.querySelector('.edit_rule');
            const editStyle = getComputedStyle(edit);
            const lineHeight = node => parseFloat(getComputedStyle(node).lineHeight) || node.getBoundingClientRect().height;
            return {
                nameStartsAtDetails: name.getBoundingClientRect().left <= details.left + 1,
                regexOneLine: regex.getClientRects().length === 1 && regex.getBoundingClientRect().height <= lineHeight(regex) * 1.5,
                scopeOneLine: scope.getClientRects().length === 1 && scope.getBoundingClientRect().height <= lineHeight(scope) * 1.5,
                rowFitsList: row.right <= list.getBoundingClientRect().right + 1,
                handleNearListStart: handle.left - list.getBoundingClientRect().left <= 16,
                editIsFlat: editStyle.backgroundColor === 'transparent' || editStyle.backgroundColor === 'rgba(0, 0, 0, 0)',
            };
        }));
        expect(ruleLayout.every(layout => Object.values(layout).every(Boolean))).toBe(true);
        const scopeLayout = await debuggerPopup.locator('#regex_debugger_rules').evaluate(container => ({
            headingsOutsideLists: [...container.querySelectorAll(':scope > .regex-debugger-list-header')].every(header => header.parentElement === container),
            scopeListsAreBoxed: [...container.querySelectorAll(':scope > .sortable-list')].every(list => parseFloat(getComputedStyle(list).borderTopWidth) > 0),
        }));
        expect(scopeLayout).toEqual({ headingsOutsideLists: true, scopeListsAreBoxed: true });
        if (viewport.width <= 450) {
            expect(await debuggerPopup.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
            expect(await debuggerPopup.locator('.regex-debugger-rule').first().evaluate(rule => {
                const name = rule.querySelector('.rule-name').getBoundingClientRect();
                const meta = rule.querySelector('.rule-regex').getBoundingClientRect();
                return name.width > 0 && meta.width > 0 && meta.top >= name.bottom - 1;
            })).toBe(true);
        }
        const input = 'alpha beta\n'.repeat(40);
        const expectedOutput = 'gamma gamma\n'.repeat(40);
        await debuggerPopup.locator('#regex_debugger_raw_input').fill(input);
        await debuggerPopup.locator('#regex_debugger_run_test').click();
        const results = await readDebuggerResults(debuggerPopup);
        await expect(debuggerPopup.locator('#regex_debugger_steps_output .step-result')).toHaveCount(12);
        await expect(debuggerPopup.locator('#regex_debugger_final_output')).toHaveText(expectedOutput);
        await expectDebuggerScrollers(debuggerPopup);
        for (const selector of ['#regex_debugger_steps_output', '#regex_debugger_final_output']) {
            expect(await debuggerPopup.locator(selector).evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
        }
        await debuggerPopup.locator('.popup-content').evaluate(node => { node.scrollTop = 0; });
        await captureWindowSurface(page, viewport, 'regex-debugger');
        for (const view of ['steps', 'final']) {
            for (const exit of ['back', 'escape']) {
                await navigateExpandedResult(page, debuggerPopup, viewport, view, exit, results);
            }
        }
        await debuggerPopup.locator('.edit_rule').last().click();
        const nestedEditor = await currentPopup(page, '.regex_editor');
        await expectPushedPage(nestedEditor, debuggerPopup);
        await nestedEditor.locator('.popup-button-cancel').click();
        await expectParentRestored(page, nestedEditor, debuggerPopup);
        await expect(debuggerPopup.locator('#regex_debugger_final_output')).toHaveText(expectedOutput);
        await debuggerPopup.locator('#regex_debugger_expand_steps').click();
        const closeChild = await currentPopup(page, '.expanded-regex-container');
        await expectPushedPage(closeChild, debuggerPopup);
        await expect(closeChild.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
        await expect(closeChild.locator('.sb-dialog__close:not(.sb-dialog__back):visible')).toHaveCount(1);
        await expect(closeChild.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
        await closeChild.getByRole('button', { name: 'Back', exact: true }).click();
        await expectParentRestored(page, closeChild, debuggerPopup);
        expect(await readDebuggerResults(debuggerPopup)).toEqual(results);

        await debuggerPopup.locator('#regex_debugger_expand_steps').click();
        const chainChild = await currentPopup(page, '.expanded-regex-container');
        await expectPushedPage(chainChild, debuggerPopup);
        await captureWindowSurface(page, viewport, 'regex-expanded-back-close');
        await chainChild.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(page.locator('dialog.popup')).toHaveCount(0);
        expect(state.pageErrors).toEqual([]);
    });

    test(`API Keys Window reaches row actions and keeps Add/Rename Alerts and secret values isolated at ${size}`, async ({ page }) => {
        const state = await bootWindowDialogs(page, viewport);
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
        const manager = await openApiKeyManager(page);
        await expectWindow(manager, viewport);
        const rows = manager.locator('.secretKeyManagerItem');
        await expect(rows).toHaveCount(SECRET_COUNT);
        await rows.last().scrollIntoViewIfNeeded();
        for (const action of ['rotate-secret', 'copy-secret', 'rename-secret', 'delete-secret']) {
            await expectInsideBody(rows.last().locator(`[data-action="${action}"]`), manager);
        }
        expect(await rows.last().evaluate(row => {
            const info = row.querySelector('.secretKeyManagerItemInfo').getBoundingClientRect();
            const actions = row.querySelector('.secretKeyManagerItemActions').getBoundingClientRect();
            return actions.left >= info.right - 1;
        })).toBe(true);
        await captureWindowSurface(page, viewport, 'api-keys-last-row');
        await rows.last().locator('[data-action="rotate-secret"]').click();
        await expect.poll(() => state.secrets.filter(request => request.endpoint === 'rotate')).toEqual([{ endpoint: 'rotate', key: 'api_key_openai', id: 'window-secret-23' }]);
        await expect(rows.last()).toHaveClass(/active/);
        await rows.last().locator('[data-action="copy-secret"]').click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(SECRET_SENTINEL);
        await expectNoSecretLeaks(page, state);

        for (const exit of ['cancel', 'escape', 'save']) {
            await addSecretAndDismiss(page, manager, viewport, state, exit);
        }
        await expect.poll(() => rows.count()).toBe(SECRET_COUNT + 1);
        expect(state.secrets.filter(request => request.endpoint === 'write')).toEqual([{ endpoint: 'write', key: 'api_key_openai', value: SECRET_SENTINEL, label: 'Added fixture' }]);
        for (const exit of ['cancel', 'escape', 'save']) {
            await renameSecretAndDismiss(page, manager, viewport, state, exit);
        }
        await expect.poll(() => state.secrets.filter(request => request.endpoint === 'rename')).toEqual([{ endpoint: 'rename', key: 'api_key_openai', id: 'window-secret-23', label: 'Renamed fixture' }]);
        await expect(rows.filter({ hasText: 'Renamed fixture' })).toHaveCount(1);
        await manager.locator('[data-action="delete-secret"][data-id="window-secret-23"]').click();
        const confirmation = await currentPopup(page, '.popup-button-cancel');
        await confirmation.locator('.popup-button-cancel').click();
        await expectParentRestored(page, confirmation, manager);
        expect(state.secrets.filter(request => request.endpoint === 'delete')).toEqual([]);
        await expectNoSecretLeaks(page, state);
    });
}
