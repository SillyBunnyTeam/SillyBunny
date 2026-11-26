import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';
import { dismissOpenDialogIfPresent } from './chat-scroll-regression-helpers.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { NOTIFICATION_FORM_SELECTOR } from './helpers/toasts.js';
import { keepWelcomeClosed } from './helpers/welcome-dialog.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });

const MANUAL_BOOK = 'Pathfinder test memory';
const ATTACHED_BOOK = 'Attached Pathfinder lorebook with a long name '.repeat(4).trim();

async function openSettings(page, baseURL) {
    const origin = new URL(baseURL).origin;
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname);
    const state = { saveMode: 'success', saves: [], heldSaves: [], generation: [], reads: [], writes: [], failBookWrite: false };
    const books = new Map([MANUAL_BOOK, ATTACHED_BOOK].map(name => [name, {
        entries: { 0: { uid: 0, comment: 'Saved summary', content: 'Saved memory.', key: ['summary'], disable: false, constant: false } },
    }]));
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/__pathfinder-test-generation') {
            state.generation.push(route);
            return;
        }
        if (url.pathname === '/api/in-chat-agents/save') {
            const agent = request.postDataJSON();
            if (agent.id === 'pf-e2e-agent') {
                state.saves.push(agent);
                if (state.saveMode === 'hold') {
                    state.heldSaves.push(route);
                    return;
                }
                if (state.saveMode === 'fail') return route.fulfill({ status: 503, json: {} });
            }
            return route.fulfill({ json: {} });
        }
        if (url.pathname === '/api/worldinfo/get') {
            const name = request.postDataJSON().name;
            if (books.has(name)) {
                state.reads.push(name);
                return route.fulfill({ json: books.get(name) });
            }
        }
        if (url.pathname === '/api/worldinfo/edit') {
            const { name, data } = request.postDataJSON();
            state.writes.push({ name, data });
            if (state.failBookWrite) return route.fulfill({ status: 503, json: {} });
            books.set(name, data);
            return route.fulfill({ json: { ok: true, name } });
        }
        // Browser tests never send inference, secrets, or mutations to a real service.
        if (url.pathname.startsWith('/api/backends/')) return route.fulfill({ json: { data: [] } });
        if (/^\/api\/.*\/(save|delete|create|edit|rename|update|import|upload|restore|duplicate|write|set)$/.test(url.pathname)) {
            return route.fulfill({ json: {} });
        }
        return route.fallback();
    });

    await keepWelcomeClosed(page.context());
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.getElementById('preloader'), null, { timeout: 60000 });
    await testSetup.waitForAppReady({ page });
    await dismissOpenDialogIfPresent(page);
    await page.waitForFunction(async () => (await import('/script.js')).settingsReady, null, { timeout: 60000 });
    await page.waitForFunction(() => typeof window.SillyTavern?.getContext === 'function');
    await page.locator('#extension_settings_in_chat_agents_pathfinder #pf--settings').waitFor({ state: 'attached', timeout: 60000 });

    await page.evaluate(async ({ manualBook, attachedBook }) => {
        const ui = await import('/scripts/extensions/in-chat-agents/pathfinder-settings-ui.js');
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        const tree = await import('/scripts/extensions/in-chat-agents/pathfinder/tree-store.js');
        const runner = await import('/scripts/extensions/in-chat-agents/agent-runner.js');
        const pathfinder = await import('/scripts/extensions/in-chat-agents/pathfinder-init.js');
        const world = await import('/scripts/world-info.js');
        const memory = await import('/scripts/extensions/in-chat-agents/pathfinder/summary-memory-store.js');
        const ctx = window.SillyTavern.getContext();
        ctx.chatMetadata.world_info = attachedBook;
        ctx.powerUserSettings.persona_description_lorebook = '';
        for (const character of ctx.characters) {
            character.data = { ...character.data, character_book: undefined, extensions: { ...character.data?.extensions, world: '' } };
        }
        if (ctx.worldInfoSettings) ctx.worldInfoSettings.charLore = [];
        ctx.chat.splice(0, ctx.chat.length, { mes: 'The test characters reach the harbour.', name: 'Test character', is_user: false });
        world.world_names.splice(0, world.world_names.length, manualBook, attachedBook);
        const CMRS = ctx.ConnectionManagerRequestService;
        CMRS.getSupportedProfiles = () => [{ id: 'pf-test-profile', name: 'Pathfinder test profile' }];
        CMRS.sendRequest = async (_profile, messages, _tokens, { signal }) => {
            const response = await fetch('/__pathfinder-test-generation', { method: 'POST', body: JSON.stringify(messages), signal });
            return response.text();
        };
        const tools = pathfinder.getPathfinderToolDefinitions();
        store.setGlobalSettings({ enabled: true, pathfinderEnabled: true, separateRecentChats: false });
        store.loadAgents([{
            id: 'pf-e2e-agent', name: 'Pathfinder', category: 'tool', sourceTemplateId: 'tpl-pathfinder', enabled: true, tools,
            settings: {
                pipelineEnabled: true, sidecarEnabled: false, connectionProfile: 'pf-test-profile',
                enabledLorebooks: [manualBook], selectedLorebook: manualBook,
                toolStates: Object.fromEntries(tools.map(tool => [tool.name, tool.name === 'Pathfinder_Search'])),
                bookPermissions: { [attachedBook]: { read: 'readwrite', write: 'readwrite', delete: 'none' } },
            },
        }]);
        tree.replaceSettings(store.getAgentById('pf-e2e-agent').settings);
        pathfinder.initPathfinder(ctx);
        runner.syncToolAgentRegistrations();
        memory.setSummaryMemoryCreated({ title: 'Saved summary', content: 'Saved memory.', bookName: manualBook, uid: 0 });
        ui.closePathfinderSettings();
        document.querySelectorAll('#pf--settings').forEach(element => element.remove());

        const host = document.createElement('div');
        host.id = 'pf-e2e-host';
        host.style.cssText = 'position:fixed;inset:0 0 0 auto;width:min(434px,100%);padding:12px;box-sizing:border-box;overflow:auto;z-index:10000;background:var(--SmartThemeBlurTintColor)';
        document.body.append(host);
        const panel = await ui.openPathfinderSettings(store.getAgentById('pf-e2e-agent'));
        panel.filter('#pf--settings').addClass('pf--settings-embedded');
        host.append(...panel.toArray());
    }, { manualBook: MANUAL_BOOK, attachedBook: ATTACHED_BOOK });
    await expect(page.locator('#pf-e2e-host #pf--master-enable')).toBeVisible();
    return state;
}

test('Pathfinder uses native keyboard disclosures, labelled controls and narrow layouts', async ({ page, baseURL }, testInfo) => {
    const state = await openSettings(page, baseURL);
    expect(state.reads).toEqual([]);
    expect(state.writes).toEqual([]);
    const header = page.locator('#pf--lorebook-section > button');
    await header.focus();
    await page.keyboard.press('Space');
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#pf--lorebook-body')).toBeHidden();
    await page.keyboard.press('Enter');
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('checkbox', { name: ATTACHED_BOOK, exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: `${ATTACHED_BOOK} Read`, exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: `${ATTACHED_BOOK} Write`, exact: true })).toBeChecked();
    await expect(page.getByRole('switch', { name: 'Automatically include attached lorebooks, aside from excluded lorebooks', exact: true })).toBeChecked();
    await expect(page.getByLabel('Pipeline Type', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Allow Summary Memory Tool', { exact: true })).not.toBeChecked();
    await expect(page.locator('#pf--permission-matrix')).toBeVisible();
    await expect(page.locator('#pf--confirm-tool-list')).toBeVisible();

    for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const fontSize of [15, 30]) {
            await page.locator('#pf-e2e-host').evaluate((host, size) => host.style.setProperty('--mainFontSize', `${size}px`), fontSize);
            const layout = await page.locator('#pf-e2e-host').evaluate(host => {
                const controls = [...host.querySelectorAll('button, select, input, textarea')]
                    .filter(element => element.getClientRects().length)
                    .map(element => element.matches('input[type="checkbox"]') ? element.closest('label') : element);
                return {
                    overflow: host.scrollWidth > host.clientWidth,
                    smallestControl: Math.min(...controls.map(element => element.getBoundingClientRect().height)),
                    bookFontSize: parseFloat(window.getComputedStyle(host.querySelector('.pf--lorebook-name')).fontSize),
                };
            });
            expect(layout.overflow).toBe(false);
            expect(layout.smallestControl).toBeGreaterThanOrEqual(38);
            expect(layout.bookFontSize).toBeCloseTo(fontSize * 0.92, 1);
        }
        await page.locator('#pf-e2e-host').evaluate(host => {
            host.style.setProperty('--mainFontSize', '15px');
            host.scrollTop = 0;
        });
        await page.screenshot({ path: testInfo.outputPath(`pathfinder-${width}.png`) });
    }
});

test('Pathfinder\'s Ask Before Executing list has Select All, mixed while some tools are checked', async ({ page, baseURL }) => {
    const state = await openSettings(page, baseURL);
    const list = page.locator('#pf--confirm-tool-list');
    const selectAll = list.getByRole('checkbox', { name: 'Select All', exact: true });
    const tools = list.locator('input[data-confirm-tool]');
    await expect(tools).toHaveCount(6);
    await expect(list.getByRole('checkbox').first()).toHaveAccessibleName('Select All');
    await selectAll.check();
    await expect(tools.evaluateAll(inputs => inputs.map(input => input.checked))).resolves.toEqual(Array(6).fill(true));
    await expect.poll(() => Object.values(state.saves.at(-1)?.settings?.confirmTools ?? {})).toEqual(Array(6).fill(true));
    await tools.first().uncheck();
    await expect.poll(() => selectAll.evaluate(input => ({ checked: input.checked, mixed: input.indeterminate }))).toEqual({ checked: false, mixed: true });
    // A mixed box that is pressed once checks every tool; pressed again it clears them.
    await selectAll.check();
    await expect(tools.evaluateAll(inputs => inputs.map(input => input.checked))).resolves.toEqual(Array(6).fill(true));
    await selectAll.uncheck();
    await expect(tools.evaluateAll(inputs => inputs.map(input => input.checked))).resolves.toEqual(Array(6).fill(false));
    await expect.poll(() => Object.values(state.saves.at(-1)?.settings?.confirmTools ?? {})).toEqual(Array(6).fill(false));
});

test('Pathfinder\'s apply-at-once options are switch rows and its pick-several lists stay check boxes', async ({ page, baseURL }) => {
    await openSettings(page, baseURL);
    await page.locator('#pf--enable-tools').check();
    const ids = ['master-enable', 'auto-use-attached', 'auto-sync-lorebooks', 'include-contextual-lorebooks', 'enable-tools', 'enable-pipeline', 'dedupe-natural-activation', 'enable-summarize-tool', 'auto-summary', 'mandatory-tools'];
    for (const id of ids) {
        const input = page.locator(`#pf--${id}`);
        await expect(input).toHaveAttribute('role', 'switch');
        await expect(page.locator(`label.ds-row-switch:has(#pf--${id})`)).toHaveCount(1);
    }
    await expect(page.locator('#pf--master-enable')).toHaveAccessibleName('Enable Pathfinder for This Chat');
    // The help line moved into the row as its subtitle, without being recreated.
    await expect(page.locator('label.ds-row-switch:has(#pf--auto-use-attached) .ds-row-subtitle.pf--setting-help')).toHaveCount(1);
    await expect(page.locator('#pf--confirm-tool-list input[role="switch"], #pf--lorebook-list input[role="switch"], #pf--permission-matrix input[role="switch"], .pf--tool-list input[role="switch"]')).toHaveCount(0);
    // Both tool lists are check rows with the box leading, and the theme does not draw their boxes as switches.
    for (const list of ['#pf--confirm-tool-list', '.pf--tool-list:not(#pf--confirm-tool-list)', '#pf--lorebook-list']) {
        const items = page.locator(`${list} > label`);
        await expect(items).toHaveCount(await items.count());
        expect(await items.count()).toBeGreaterThan(list === '#pf--lorebook-list' ? 1 : 5);
        await expect(page.locator(`${list} > label.ds-row.ds-row-check`)).toHaveCount(await items.count());
        await expect(page.locator(`${list} > label.checkbox_label`)).toHaveCount(0);
        await expect(page.locator(`${list} input[role="switch"]`)).toHaveCount(0);
        const boxes = await page.locator(`${list} > label > input[type="checkbox"]`).evaluateAll(inputs => inputs.map(input => {
            const label = input.closest('label').getBoundingClientRect();
            const box = input.getBoundingClientRect();
            return { width: Math.round(box.width), leading: box.left - label.left < label.width / 2 };
        }));
        expect(boxes).toHaveLength(await items.count());
        for (const box of boxes) {
            expect(box.width).toBeLessThan(30);
            expect(box.leading).toBe(true);
        }
    }
});

test('Pathfinder\'s permission matrix keeps check boxes, each named by its lorebook and permission', async ({ page, baseURL }) => {
    await openSettings(page, baseURL);
    const boxes = page.locator('#pf--permission-matrix input[data-permission]');
    await expect(boxes).toHaveCount(3 * await page.locator('#pf--permission-matrix .pf--permission-row').count());
    expect(await boxes.count()).toBeGreaterThan(0);
    await expect(page.locator('#pf--permission-matrix input[role="switch"], #pf--permission-matrix .checkbox_label')).toHaveCount(0);
    await expect(page.locator('#pf--permission-matrix label.ds-row-check > input[type="checkbox"]')).toHaveCount(await boxes.count());
    const names = await boxes.evaluateAll(inputs => inputs.map(input => ({ width: input.getBoundingClientRect().width, name: input.getAttribute('data-permission') })));
    for (const box of names) expect(box.width).toBeLessThan(30);
    await expect(page.getByRole('checkbox', { name: `${MANUAL_BOOK} Read`, exact: true })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: `${MANUAL_BOOK} Write`, exact: true })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: `${MANUAL_BOOK} Delete`, exact: true })).toBeVisible();
});

test('Pathfinder\'s lorebook list shows Select All only above five lorebooks, and it picks every one', async ({ page, baseURL }) => {
    const state = await openSettings(page, baseURL);
    const list = page.locator('#pf--lorebook-list');
    await expect(list.locator('input[data-lorebook-select-all]')).toHaveCount(0);
    await page.evaluate(async () => {
        const world = await import('/scripts/world-info.js');
        world.world_names.push('Extra book 1', 'Extra book 2', 'Extra book 3', 'Extra book 4');
        document.getElementById('pf--refresh-lorebooks').click();
    });
    const selectAll = list.getByRole('checkbox', { name: 'Select All', exact: true });
    const books = list.locator('.pf--lorebook-item input');
    await expect(books).toHaveCount(6);
    await expect(list.getByRole('checkbox').first()).toHaveAccessibleName('Select All');
    await selectAll.check();
    await expect(books.evaluateAll(inputs => inputs.map(input => input.checked))).resolves.toEqual(Array(6).fill(true));
    await expect.poll(() => state.saves.at(-1)?.settings?.enabledLorebooks?.length).toBe(6);
    await selectAll.uncheck();
    await expect(books.evaluateAll(inputs => inputs.map(input => input.checked))).resolves.toEqual(Array(6).fill(false));
    await books.first().check();
    await expect.poll(() => selectAll.evaluate(input => ({ checked: input.checked, mixed: input.indeterminate }))).toEqual({ checked: false, mixed: true });
});

test('Pathfinder\'s Enabled Tools list has Select All that checks and unchecks every tool', async ({ page, baseURL }) => {
    const state = await openSettings(page, baseURL);
    await page.locator('#pf--enable-tools').check();
    const list = page.locator('.pf--tool-list:not(#pf--confirm-tool-list)');
    const selectAll = list.getByRole('checkbox', { name: 'Select All', exact: true });
    const tools = list.locator('input[data-tool]');
    await expect(tools).toHaveCount(7);
    await expect(list.getByRole('checkbox').first()).toHaveAccessibleName('Select All');
    // The fixture enables Search only, so the box starts mixed.
    await expect.poll(() => selectAll.evaluate(input => ({ checked: input.checked, mixed: input.indeterminate }))).toEqual({ checked: false, mixed: true });
    await selectAll.check();
    await expect(tools.evaluateAll(inputs => inputs.map(input => input.checked))).resolves.toEqual(Array(7).fill(true));
    await expect.poll(() => Object.values(state.saves.at(-1)?.settings?.toolStates ?? {}).filter(Boolean).length).toBeGreaterThanOrEqual(7);
    await selectAll.uncheck();
    await expect(tools.evaluateAll(inputs => inputs.map(input => input.checked))).resolves.toEqual(Array(7).fill(false));
    await tools.first().check();
    await expect.poll(() => selectAll.evaluate(input => ({ checked: input.checked, mixed: input.indeterminate }))).toEqual({ checked: false, mixed: true });
});

test('Pathfinder saves rapid toggles in order and an unticked attached book stays excluded', async ({ page, baseURL }) => {
    const state = await openSettings(page, baseURL);
    state.saveMode = 'hold';
    await page.locator('#pf--enable-tools').check();
    await expect.poll(() => state.heldSaves.length).toBe(1);
    await page.locator('#pf--auto-summary').check();
    expect(state.saves).toHaveLength(1);
    expect(await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/pathfinder/tree-store.js')).getSettings().sidecarEnabled)).toBe(false);
    state.saveMode = 'success';
    await state.heldSaves[0].fulfill({ json: {} });
    await expect(page.locator('#pf--settings-save-status')).toHaveText('Saved!');
    await expect.poll(() => state.saves.length).toBe(2);
    expect(state.saves[0].settings.autoSummary).not.toBe(true);
    expect(state.saves[1].settings).toMatchObject({ sidecarEnabled: true, autoSummary: true, toolStates: { Pathfinder_Summarize: true } });

    await page.getByRole('checkbox', { name: ATTACHED_BOOK, exact: true }).uncheck();
    await expect(page.locator('#pf--settings-save-status')).toHaveText('Saved!');
    const access = await page.evaluate(async () => {
        const bridge = await import('/scripts/extensions/in-chat-agents/pathfinder/pathfinder-tool-bridge.js');
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        return { readable: bridge.getReadableBooks(), writable: bridge.getWritableBooks(), permissions: store.getAgentById('pf-e2e-agent').settings.bookPermissions };
    });
    expect(access.readable).not.toContain(ATTACHED_BOOK);
    expect(access.writable).not.toContain(ATTACHED_BOOK);
    expect(access.permissions[ATTACHED_BOOK]).toEqual({ enabled: false, read: 'readwrite', write: 'readwrite', delete: 'none' });
    await page.locator('#pf--refresh-lorebooks').click();
    await expect(page.getByRole('checkbox', { name: ATTACHED_BOOK, exact: true })).not.toBeChecked();
});

test('Pathfinder preserves failed prompt and summary drafts, including an empty summary', async ({ page, baseURL }) => {
    const state = await openSettings(page, baseURL);
    await page.locator('#pf--prompt-editor-section > button').click();
    await page.getByLabel('Select Prompt to Edit', { exact: true }).selectOption('candidate-selector');
    await page.getByLabel('System Prompt', { exact: true }).fill('A test prompt draft');
    state.saveMode = 'fail';
    await page.locator('#pf--prompt-save').click();
    await expect(page.locator('#pf--prompt-status')).toContainText('Save failed:');
    await expect(page.getByLabel('System Prompt', { exact: true })).toHaveValue('A test prompt draft');
    state.saveMode = 'success';
    await page.locator('#pf--settings-retry').click();
    await expect(page.locator('#pf--settings-save-status')).toHaveText('Saved!');

    const editor = page.getByLabel('Latest Memory Summary', { exact: true });
    await editor.fill('An unsaved summary draft');
    await page.locator('#pf--summary-save').focus();
    await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/pathfinder/summary-memory-store.js')).markSummaryMemoryInjected({ mode: 'pipeline' }));
    await expect(editor).toHaveValue('An unsaved summary draft');
    state.failBookWrite = true;
    await page.locator('#pf--summary-save').click();
    await expect(page.locator('#pf--summary-save-status')).toContainText('Save failed:');
    await expect(editor).toHaveValue('An unsaved summary draft');
    state.failBookWrite = false;
    await editor.fill('');
    await expect(page.locator('#pf--summary-save-entry')).toBeDisabled();
    await page.locator('#pf--summary-save').click();
    await expect(page.locator('#pf--summary-save-status')).toHaveText('Saved!');
    await expect(editor).toHaveValue('');
    expect(state.writes.at(-1).data.entries[0].content).toBe('');
});

test('Stop cancels a real auxiliary request without saving a late summary', async ({ page, baseURL }) => {
    const state = await openSettings(page, baseURL);
    await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/pathfinder/summary-memory-store.js')).setSummaryMemoryCreated({ title: '', content: '', bookName: '', uid: null }));
    await page.locator('#pf--summary-create').click();
    await expect.poll(() => state.generation.length).toBe(1);
    await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/agent-runner.js')).cancelAgentGeneration());
    await expect(page.locator('#pf--summary-save-status')).toHaveText('Cancelled');
    await state.generation[0].fulfill({ body: '{"title":"Late","content":"This must not be stored."}' }).catch(() => {});
    expect(state.writes).toEqual([]);
    await expect(page.locator('#pf--summary-create')).toBeEnabled();
});

const windowResultState = page => page.evaluate(() => Promise.race([window.__pathfinderWindowResult.then(() => 'resolved'), Promise.resolve('pending')]));

async function showPathfinderWindow(page, width) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(async () => {
        const ui = await import('/scripts/extensions/in-chat-agents/pathfinder-settings-ui.js');
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
        const panel = await ui.openPathfinderSettings(store.getAgentById('pf-e2e-agent'));
        const popup = new Popup(panel, POPUP_TYPE.TEXT, '', {
            okButton: 'Close',
            tier: 'window',
            title: 'Pathfinder',
            wide: true,
            large: true,
            onClosing: () => ui.canClosePathfinderSettings(panel),
        });
        window.__pathfinderWindowResult = popup.show();
    });
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toHaveClass(/sb-dialog--window/);
    return dialog;
}

for (const width of [1440, 390]) {
    test(`${width}px Pathfinder editor keeps its existing Close result in a scrollable Window`, async ({ page, baseURL }) => {
        const state = await openSettings(page, baseURL);
        await protectMaintainerServer(page);
        const dialog = await showPathfinderWindow(page, width);
        await expect(dialog.locator('.sb-dialog__title')).toHaveText('Pathfinder');
        await expect(dialog.locator('.popup-button-close')).toBeVisible();
        await expect(dialog.locator('.popup-button-ok')).toBeHidden();
        const body = dialog.locator('.popup-content');
        const lastSection = dialog.locator('.pf--section').last();
        for (const header of await dialog.locator('.pf--section-collapsible > .pf--collapsible-header').all()) {
            if (await header.getAttribute('aria-expanded') === 'false') await header.click();
        }
        expect(await dialog.locator('#pf--settings').evaluate(node => getComputedStyle(node).overflowY)).toBe('visible');
        await expect.poll(() => body.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
        await body.evaluate(node => node.scrollTop = node.scrollHeight);
        await expect.poll(() => lastSection.evaluate(node => {
            const bodyRect = node.closest('.popup-content').getBoundingClientRect();
            return node.getBoundingClientRect().bottom <= bodyRect.bottom + 1;
        })).toBe(true);
        // An error stays until it is dismissed, and at a phone width a notification at the top covers the Window's Close
        // button, so a user dismisses it before closing the Window.
        for (const dismiss of await page.locator(`${NOTIFICATION_FORM_SELECTOR} > .toast-close-button`).all()) {
            await dismiss.click();
        }
        await expect(page.locator(NOTIFICATION_FORM_SELECTOR)).toHaveCount(0);
        await dialog.locator('.popup-button-close').click();
        await expect(dialog).toHaveCount(0);
        expect(await page.evaluate(async () => await window.__pathfinderWindowResult)).toBe(1);
        expect(state.saves).toEqual([]);
    });

    test(`${width}px Pathfinder editor stays open when a save fails during Close, then closes on the next Close`, async ({ page, baseURL }) => {
        await protectMaintainerServer(page);
        const state = await openSettings(page, baseURL);
        const dialog = await showPathfinderWindow(page, width);
        const savedSettings = () => page.evaluate(async () => JSON.stringify((await import('/scripts/extensions/in-chat-agents/agent-store.js')).getAgentById('pf-e2e-agent').settings));
        const before = await savedSettings();

        state.saveMode = 'hold';
        await dialog.locator('#pf--enable-tools').check();
        await expect.poll(() => state.heldSaves.length).toBe(1);
        await dialog.locator('.popup-button-close').click();
        await expect(dialog).toBeVisible();
        expect(await windowResultState(page)).toBe('pending');
        await state.heldSaves[0].fulfill({ status: 503, json: {} });

        await expect(dialog.locator('#pf--settings-save-status')).toContainText('Save failed:');
        await expect(dialog).toBeVisible();
        expect(await windowResultState(page)).toBe('pending');
        await expect(dialog.locator('#pf--enable-tools')).toBeChecked();
        expect(await savedSettings()).toBe(before);
        expect(state.saves).toHaveLength(1);

        await dialog.locator('.popup-button-close').click();
        await expect(dialog).toHaveCount(0);
        expect(await page.evaluate(async () => await window.__pathfinderWindowResult)).toBe(1);
        expect(state.saves).toHaveLength(1);
        expect(await savedSettings()).toBe(before);
    });

    test(`${width}px Pathfinder editor closes once a pending save succeeds during Close`, async ({ page, baseURL }) => {
        await protectMaintainerServer(page);
        const state = await openSettings(page, baseURL);
        const dialog = await showPathfinderWindow(page, width);

        state.saveMode = 'hold';
        await dialog.locator('#pf--enable-tools').check();
        await expect.poll(() => state.heldSaves.length).toBe(1);
        await dialog.locator('.popup-button-close').click();
        await expect(dialog).toBeVisible();
        expect(await windowResultState(page)).toBe('pending');
        await state.heldSaves[0].fulfill({ json: {} });

        await expect(dialog).toHaveCount(0);
        expect(await page.evaluate(async () => await window.__pathfinderWindowResult)).toBe(1);
        expect(state.saves).toHaveLength(1);
    });
}
