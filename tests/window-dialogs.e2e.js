import { expect, test } from '@playwright/test';
import {
    ATTACHMENT_COUNT, ATTACHMENT_TEXT, SECRET_COUNT, SECRET_SENTINEL, WINDOW_VIEWPORTS,
    bootWindowDialogs, captureWindowSurface, currentPopup, expectDebuggerScrollers,
    expectInsideBody, expectNoSecretLeaks, expectParentRestored, expectPushedPage,
    expectWindow, openApiKeyManager, openDataBank, openRegex,
} from './helpers/window-dialogs.js';

test.setTimeout(90000);
test.use({ serviceWorkers: 'block' });

async function readExtensions(page) {
    return page.evaluate(async () => {
        const { extension_settings } = await import('/scripts/extensions.js');
        return { attachments: extension_settings.attachments, regex: extension_settings.regex };
    });
}

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
        const rows = manager.locator('.globalAttachmentsList .attachmentListItem');
        await expect(rows).toHaveCount(ATTACHMENT_COUNT);
        const body = manager.locator('.popup-content');
        expect(await body.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
        await rows.last().scrollIntoViewIfNeeded();
        await expectInsideBody(rows.last().locator('.deleteAttachmentButton'), manager);
        for (const action of ['view', 'disable', 'move', 'edit', 'download', 'delete']) {
            await expectInsideBody(rows.last().locator(`.${action}AttachmentButton`), manager);
        }
        expect(await rows.last().evaluate(row => [...row.querySelectorAll('.right_menu_button')]
            .every(button => Boolean(row.querySelector('.attachmentListItemName').compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING)))).toBe(true);
        expect(await body.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
        await captureWindowSurface(page, viewport, 'data-bank-last-row');

        await manager.locator('.attachmentsBulkEditButton').click();
        await expect(manager.locator('.attachmentsBulkEditCheckbox')).toBeChecked();
        expect(await manager.locator('.dataBankAttachments').evaluate(node => node.matches(':has(.attachmentsBulkEditCheckbox:checked)'))).toBe(true);
        await expect(manager.locator('.attachmentBulkActionsContainer')).toHaveCSS('display', 'flex');
        await expect(rows.first().locator('.attachmentListItemCheckboxContainer')).toHaveCSS('display', 'flex');
        await expect(rows.first().locator('.attachmentFileIcon')).toBeHidden();
        await manager.locator('.attachmentsBulkEditButton').click();
        await expect(manager.locator('.attachmentsBulkEditCheckbox')).not.toBeChecked();
        await expect(manager.locator('.attachmentBulkActionsContainer')).toBeHidden();
        await expect(rows.first().locator('.attachmentListItemCheckboxContainer')).toBeHidden();
        await expect(rows.first().locator('.attachmentFileIcon')).toBeVisible();
        await manager.locator('.attachmentsBulkEditButton').click();
        await rows.first().locator('.attachmentListItemCheckbox').check();
        await manager.locator('.bulkActionDisable').click();
        await expect(rows.first()).toHaveClass(/disabled/);
        await expect(manager.locator('.attachmentsBulkEditCheckbox')).not.toBeChecked();
        await expect(manager.locator('.attachmentBulkActionsContainer')).toBeHidden();

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
            await row.locator('.editAttachmentButton').click();
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
        await row.locator('.editAttachmentButton').click();
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
