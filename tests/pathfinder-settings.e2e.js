/* global document, window */
import { expect, test } from '@playwright/test';
import { dismissOnboardingIfPresent, dismissOpenDialogIfPresent } from './chat-scroll-regression-helpers.js';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

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
        return route.continue();
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.getElementById('preloader'), null, { timeout: 60000 });
    await dismissOnboardingIfPresent(page);
    const onboardingSave = page.locator('dialog[open]:has(.onboarding) .popup-button-ok');
    if (await onboardingSave.isVisible()) await onboardingSave.click();
    await dismissOpenDialogIfPresent(page);
    await page.addLocatorHandler(page.locator('#qig-setup-wizard'), async wizard => {
        await wizard.getByRole('button', { name: 'Skip', exact: true }).click();
    });
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
    await expect(page.getByRole('checkbox', { name: 'Automatically include attached lorebooks, aside from excluded lorebooks', exact: true })).toBeChecked();
    await expect(page.getByLabel('Pipeline Type', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Allow summary memory tool', { exact: true })).not.toBeChecked();
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
            expect(layout.smallestControl).toBeGreaterThanOrEqual(width < 768 ? 44 : 38);
            expect(layout.bookFontSize).toBeCloseTo(fontSize * 0.92, 1);
        }
        await page.locator('#pf-e2e-host').evaluate(host => {
            host.style.setProperty('--mainFontSize', '15px');
            host.scrollTop = 0;
        });
        await page.screenshot({ path: testInfo.outputPath(`pathfinder-${width}.png`) });
    }
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

    const editor = page.getByLabel('Latest memory summary', { exact: true });
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
