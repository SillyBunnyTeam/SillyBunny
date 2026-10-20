import { expect, test } from '@playwright/test';
import { openEditorAgents, waitForEditorApp } from './helpers/in-chat-agents-editor.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });

const fields = [
    ['connectionProfile', 'connectionProfile', 'profile'],
    ['companionConnectionProfile', 'companionConnectionProfile', 'profile'],
    ['appendAgentsExecutionMode', 'appendAgentsExecutionMode', 'toggle'],
    ['companionExecutionMode', 'companionExecutionMode', 'toggle'],
    ['companionConcurrent', 'companionConcurrentWithPostGen', 'switch'],
    ['separateRecentChats', 'separateRecentChats', 'switch'],
    ['promptTransformShowNotifications', 'promptTransformShowNotifications', 'switch'],
    ['postMainInterceptShowMessageFirst', 'postMainInterceptShowMessageFirst', 'switch'],
    ['helperPrefillMessages', 'helperPrefillMessages', 'textarea'],
    ['pathfinderSubmoduleEnabled', 'pathfinderEnabled', 'switch'],
];

async function destination(page, driver, label, id) {
    await driver.root.getByRole('button', { name: 'Agents Menu', exact: true }).click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    const root = driver.root.locator(`[data-agent-page="${id}"]`);
    await expect(root).toBeVisible();
    return root;
}

async function closePage(root) {
    await root.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(root).toHaveCount(0);
}

async function refresh(page) {
    await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/ui/agent-list.js')).refreshAgentsPanels());
}

const listenerCount = page => page.evaluate(async () =>
    (await import('/scripts/events.js')).eventSource.events.in_chat_agent_companion_results_updated?.length ?? 0);

async function expectClean(page, driver) {
    expect(driver.errors).toEqual([]);
    expect(await page.evaluate(() => window.__editorMaxDialogs)).toBeLessThanOrEqual(1);
    expect(driver.writes.filter(write => /\/generate(?:[-/]|$)|\/(?:chat\/)?completions?$/.test(write.path))).toEqual([]);
    await expect(page.locator('.ica--cdash, .ica--footer, .ica--profile-help, .ica--group-card')).toHaveCount(0);
}

async function seedGroups(page) {
    await page.evaluate(async () => {
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        store.loadBuiltinGroups([
            { id: 'qa-one', name: 'QA one', agentTemplateIds: ['missing-template'] },
            { id: 'qa-many', name: 'QA many', agentTemplateIds: ['missing-a', 'missing-b'] },
        ]);
        store.loadCustomGroups([
            { id: 'qa-custom', name: 'QA custom', description: 'QA existing description', customAgents: [
                { name: 'QA snapshot', prompt: 'QA saved prompt', execution: 'post', enabled: false },
            ] },
            { id: 'qa-zero', name: 'QA zero' },
        ]);
    });
}

async function seedNotes(page) {
    await page.evaluate(async () => {
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        store.setGlobalSettings({ enabled: true });
        const app = await import('/script.js');
        app.chat.splice(0, app.chat.length, ...Array.from({ length: 25 }, (_, index) => ({
            is_user: index % 2 === 0, is_system: false, name: 'QA', mes: `Original ${index}`,
            extra: { inChatAgentCompanionResults: {
                'editor-companion': { status: 'done', agentName: 'QA first', content: '{{original}} ' + 'x'.repeat(150), tokenUsage: { inputTokens: index, outputTokens: index + 1 } },
                'qa-other': { status: 'done', agentName: 'QA second', content: 'Second note' },
            } },
        })));
        const chat = document.getElementById('chat');
        chat.replaceChildren(...app.chat.map((_message, index) => {
            const node = document.createElement('div');
            node.className = 'mes';
            node.setAttribute('mesid', index);
            node.style.minHeight = '160px';
            node.textContent = `QA ${index}`;
            return node;
        }));
    });
    await refresh(page);
}

test('q56 Settings profile rows and Group menus toggle closed without writes', async ({ page, baseURL }, testInfo) => {
    const driver = await openEditorAgents(page, baseURL, 1440);
    const settings = await destination(page, driver, 'Settings', 'settings');
    const trace = [];
    for (const row of await settings.locator('.ds-profile-row').all()) {
        const trigger = row.locator('.ds-select-row__trigger');
        const label = await row.locator('.ds-row-label').textContent();
        for (const [part, target] of [['button', trigger], ['row', row.locator('.ds-row-label')]]) {
            await target.click();
            await expect(trigger).toHaveAttribute('aria-expanded', 'true');
            await target.click();
            await expect.soft(trigger).toHaveAttribute('aria-expanded', 'false');
            trace.push({ label, part, secondClickExpanded: await trigger.getAttribute('aria-expanded') });
            await page.evaluate(async () => (await import('/scripts/sillybunny-editor/picker.js')).closePicker({ animate: false, restoreFocus: false }));
        }
    }
    await closePage(settings);
    await seedGroups(page);
    await refresh(page);
    const groups = await destination(page, driver, 'Agent Groups', 'groups');
    const trigger = groups.getByRole('button', { name: 'Group Menu', exact: true }).first();
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    trace.push({ label: 'Custom Group row menu', secondClickExpanded: await trigger.getAttribute('aria-expanded') });
    await testInfo.attach('q56 pages dropdown sweep', { body: JSON.stringify(trace), contentType: 'application/json' });
    expect(driver.writes.filter(write => write.path.startsWith('/api/in-chat-agents/'))).toEqual([]);
    await expectClean(page, driver);
});

for (const width of [1440, 390]) {
    test.describe(`Agents pages ${width}`, () => {
        test('every setting is searchable before mount and after reopen, with live visible focus', async ({ page, baseURL }) => {
            test.setTimeout(90000);
            const driver = await openEditorAgents(page, baseURL, width);
            await expect(driver.root.locator('[data-agent-page]')).toHaveCount(0);
            const descriptors = await page.evaluate(async () => {
                const { getAgentsPanelSearchEntries } = await import('/scripts/extensions/in-chat-agents/ui/agent-list.js');
                const root = document.querySelector('.ica-agents-editor').parentElement;
                return getAgentsPanelSearchEntries({ searchRoot: root, label: 'Agents' }).map(({ element, displayText, description, dedupeKey }) => ({ element, displayText, description, dedupeKey }));
            });
            expect(descriptors).toHaveLength(10);
            expect(descriptors.every(item => item.element === null && item.displayText && item.description)).toBe(true);
            for (const phase of ['before', 'after']) {
                for (const [id, key, kind] of fields) {
                    await page.evaluate(() => window.SillyBunnyShell.openGlobalSearch());
                    await page.locator('#sb-universal-search input').fill(`ica--${id}`);
                    const result = page.getByRole('group', { name: 'Backend · Agents', exact: true }).getByRole('option');
                    const descriptor = descriptors.find(item => item.dedupeKey.endsWith(`:${id.startsWith('ica--') ? id : `ica--${id}`}`));
                    await expect(result).toHaveCount(1);
                    await expect(result.locator('strong')).toHaveText(descriptor.displayText);
                    await expect(result.locator('span')).toHaveText(descriptor.description);
                    await expect(result.locator('small')).toHaveText('Backend · Agents · Settings');
                    await result.click();
                    const settings = driver.root.locator('[data-agent-page="settings"]');
                    await expect(settings).toBeVisible();
                    const row = settings.locator(`[data-sb-editor-field="${key}"]`);
                    const target = kind === 'toggle' ? row.locator('input:checked')
                        : kind === 'profile' ? row.locator('.ds-select-row__trigger') : settings.locator(`#ica--${id}`);
                    await expect(target, `${phase}: ${id}`).toBeFocused();
                    await expect(target).toBeInViewport();
                    await expect(page.locator('[data-sb-settings-tab="agents"]')).toHaveAttribute('aria-selected', 'true');
                    await closePage(settings);
                }
            }
            await page.evaluate(() => window.SillyBunnyShell.openGlobalSearch());
            await page.locator('#sb-universal-search input').fill('Editor companion');
            await expect(page.getByRole('group', { name: 'Backend · Agents', exact: true })).toHaveCount(0);
            await page.keyboard.press('Escape');
            await expectClean(page, driver);
        });

        test('all ten settings apply once, keep native handlers and survive guarded serialization/reload', async ({ page, baseURL }) => {
            test.setTimeout(90000);
            const driver = await openEditorAgents(page, baseURL, width);
            // Startup migrations may already have queued a debounced settings snapshot.
            await page.waitForTimeout(1500);
            let saved;
            let version = 1_000_000_000_000_000;
            const savedWrites = [];
            const agents = await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/agent-store.js')).getAgents());
            await page.route('**/api/settings/save', async route => {
                saved = { ...route.request().postDataJSON(), _version: ++version };
                savedWrites.push(saved);
                await route.fulfill({ json: { result: 'ok', version } });
            });
            await page.route('**/api/settings/get', async route => {
                const response = await route.fetch();
                const data = await response.json();
                if (saved) data.settings = JSON.stringify(saved);
                data.inChatAgents = agents;
                data.request_compression = { ...data.request_compression, enabled: false };
                await route.fulfill({ json: data });
            });
            const settings = await destination(page, driver, 'Settings', 'settings');
            await expect(settings.locator('.ds-pref-group')).toHaveCount(6);
            await expect(settings.locator('.editor_maximize')).toHaveCount(1);
            const changes = [];
            for (const [id, key, kind] of fields) {
                const input = settings.locator(`#ica--${id}`);
                const previous = await input.evaluate(node => node.type === 'checkbox' ? node.checked : node.value);
                const value = kind === 'switch' ? !previous : kind === 'profile' ? 'qa-profile' : kind === 'toggle' ? 'sequential' : '[assistant] QA prefill';
                const before = savedWrites.length;
                if (kind === 'switch') await input.setChecked(value);
                else if (kind === 'textarea') await input.fill(value);
                else if (kind === 'toggle') await settings.locator(`[data-sb-editor-field="${key}"]`).getByRole('radio', { name: 'Sequential', exact: true }).check();
                else {
                    await input.evaluate(node => node.append(new Option('QA Profile', 'qa-profile')));
                    await settings.locator(`[data-sb-editor-field="${key}"] .ds-select-row__trigger`).click();
                    await page.getByRole('option', { name: 'QA Profile', exact: true }).click();
                }
                await expect.poll(() => savedWrites.length).toBe(before + 1);
                expect(saved.extension_settings.inChatAgents.globalSettings[key], key).toBe(value);
                await page.waitForTimeout(1100);
                expect(savedWrites).toHaveLength(before + 1);
                changes.push({ id, value });
            }
            await closePage(settings);
            await destination(page, driver, 'Settings', 'settings');
            const handlers = await settings.locator('input, select, textarea').evaluateAll(inputs => inputs.filter(node => node.id.startsWith('ica--')).map(node =>
                (window.$._data(node, 'events')?.[node.tagName === 'TEXTAREA' ? 'input' : 'change'] ?? []).filter(handler => !handler.namespace).length));
            expect(handlers).toEqual(fields.map(() => 1));
            await expect(settings.locator('.editor_maximize')).toHaveCount(1);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await waitForEditorApp(page);
            await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'agents'));
            await page.locator('[data-sb-settings-tab="agents"]').evaluate(node => node.click());
            await destination(page, driver, 'Settings', 'settings');
            for (const { id, value } of changes) expect(await settings.locator(`#ica--${id}`).evaluate(node => node.type === 'checkbox' ? node.checked : node.value)).toBe(value);
            await expectClean(page, driver);
        });

        test('quick-action setting search includes label, help and location without mounting Settings', async ({ page, baseURL }) => {
            const driver = await openEditorAgents(page, baseURL, width);
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'interface'));
            await page.locator('button[data-sb-settings-tab="interface"]').evaluate(node => node.click());
            const mode = width === 390 ? 'mobile' : 'desktop';
            const search = page.locator(`#sb-${mode}-quick-action-search`);
            for (const [id] of fields) {
                await search.fill(`ica--${id}`);
                const result = page.locator(`#sb-${mode}-quick-action-results .sb-mobile-quick-action-result`);
                await expect(result).toHaveCount(1);
                await expect(result.locator('strong')).not.toHaveText('');
                await expect(result.locator('.sb-mobile-quick-action-help')).not.toHaveText('');
                await expect(result.locator('small').last()).toHaveText('Backend · Agents · Settings');
            }
            await expect(driver.root.locator('[data-agent-page="settings"]')).toHaveCount(0);
            await expectClean(page, driver);
        });

        test('search cancellation leaves a dirty editor mounted and never focuses hidden Settings', async ({ page, baseURL }) => {
            const driver = await openEditorAgents(page, baseURL, width);
            await driver.open('pre');
            await driver.name.fill('QA dirty editor');
            await page.evaluate(() => window.SillyBunnyShell.openGlobalSearch());
            await page.locator('#sb-universal-search input').fill('ica--helperPrefillMessages');
            await page.getByRole('group', { name: 'Backend · Agents', exact: true }).getByRole('option').click();
            const dialog = page.locator('dialog[open]');
            await expect(dialog).toBeVisible();
            await dialog.locator('.popup-button-cancel').click();
            await expect(driver.detail).toBeVisible();
            await expect(driver.name).toHaveValue('QA dirty editor');
            await expect(driver.root.locator('[data-agent-page="settings"]')).toHaveCount(0);
            expect(await page.locator('#ica--helperPrefillMessages').evaluate(node => document.activeElement === node)).toBe(false);
            await expectClean(page, driver);
        });

        test('Reset zero/cancel/confirm preserves Q49 identity, profile/model, scope and custom agents', async ({ page, baseURL }) => {
            const driver = await openEditorAgents(page, baseURL, width);
            await page.evaluate(async () => {
                const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                store.loadAgents([{ ...store.getAgentById('editor-pre'), id: 'qa-custom' }]);
            });
            await refresh(page);
            const settings = await destination(page, driver, 'Settings', 'settings');
            await settings.locator('#ica--resetDefaults').click();
            await expect(page.locator('.toast-info')).toContainText('No bundled agents found to reset');
            await expect(page.locator('dialog[open]')).toHaveCount(0);
            const before = await page.evaluate(async () => {
                const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                const template = await fetch('/scripts/extensions/in-chat-agents/templates/continuity-companion.json').then(response => response.json());
                const bundled = (await import('/scripts/extensions/in-chat-agents/catalogue.js')).buildAgentFromTemplate(template);
                store.loadAgents([...store.getAgents(), { ...bundled, id: 'qa-bundled', name: 'QA changed', prompt: 'QA changed prompt', enabled: true, favorite: true, connectionProfile: 'qa-profile', modelOverride: 'qa-model' }]);
                store.setGlobalSettings({ separateRecentChats: true, scopedEnabledAgentIdsInitialized: true, enabledAgentIdsByChatType: { individual: ['qa-bundled'], group: ['qa-custom'] } });
                return { custom: store.getAgentById('qa-custom'), scopes: store.getGlobalSettings().enabledAgentIdsByChatType };
            });
            await refresh(page);
            await settings.locator('#ica--resetDefaults').click();
            const dialog = page.locator('dialog[open]');
            await expect(dialog.locator('.popup-button-cancel')).toBeFocused();
            await page.keyboard.press('Enter');
            await expect(dialog).toHaveCount(0);
            expect(driver.saves()).toHaveLength(0);
            await settings.locator('#ica--resetDefaults').click();
            await dialog.locator('.popup-button-ok').click();
            await expect.poll(() => driver.saves().length).toBe(1);
            const after = await page.evaluate(async () => {
                const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                return { agents: store.getAgents(), custom: store.getAgentById('qa-custom'), scopes: store.getGlobalSettings().enabledAgentIdsByChatType };
            });
            expect(after.custom).toEqual(before.custom);
            expect(after.scopes).toEqual(before.scopes);
            expect(after.agents).toHaveLength(2);
            expect(after.agents.find(agent => agent.id === 'qa-bundled')).toMatchObject({ id: 'qa-bundled', enabled: true, favorite: true, connectionProfile: 'qa-profile', modelOverride: 'qa-model' });
            expect(after.agents.find(agent => agent.id === 'qa-bundled').prompt).not.toBe('QA changed prompt');
            await expectClean(page, driver);
        });

        test('Run All empty-state notifications and Panel route never make a model request', async ({ page, baseURL }) => {
            const driver = await openEditorAgents(page, baseURL, width);
            await page.evaluate(async () => {
                (await import('/script.js')).chat.splice(0);
                (await import('/scripts/extensions/in-chat-agents/agent-store.js')).loadAgents([]);
            });
            await refresh(page);
            const overview = await destination(page, driver, 'Companions Overview', 'companions');
            await overview.getByRole('button', { name: 'Run All on Last Message', exact: true }).click();
            await expect(page.locator('.toast-warning')).toContainText('No message yet to run companions on');
            await page.evaluate(async () => (await import('/script.js')).chat.push({ is_user: true, is_system: false, mes: 'QA valid user message' }));
            await overview.getByRole('button', { name: 'Run All on Last Message', exact: true }).click();
            await expect(page.locator('.toast-info')).toContainText('No companion agents ran for this message');
            await overview.getByRole('button', { name: 'Open Companion Panel', exact: true }).click();
            await expect(overview).toHaveCount(0);
            await expect(page.locator('.ica--tpanel.is-open')).toBeVisible();
            await expect(page.locator('.ica--tpanel .ica--cdash-empty')).toBeVisible();
            await expectClean(page, driver);
        });

        test('repeated page/tab activation preserves generated groups and tears down queued results', async ({ page, baseURL }) => {
            const driver = await openEditorAgents(page, baseURL, width);
            await seedNotes(page);
            const baseline = await listenerCount(page);
            for (let iteration = 0; iteration < 3; iteration++) {
                for (const [id, label, groups] of [['settings', 'Settings', 6], ['companions', 'Companions Overview', 2], ['groups', 'Agent Groups', 3]]) {
                    const root = await destination(page, driver, label, id);
                    await expect(root.locator('.ds-pref-group')).toHaveCount(groups);
                    const before = await root.locator('.ds-row-subtitle').allTextContents();
                    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'connections'));
                    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'agents'));
                    await page.locator('[data-sb-settings-tab="agents"]').evaluate(node => node.click());
                    await expect(root).toBeVisible();
                    expect(await root.locator('.ds-row-subtitle').allTextContents()).toEqual(before);
                    await expect(root.locator('.inline-drawer')).toHaveCount(0);
                    if (id === 'companions') {
                        expect(await listenerCount(page)).toBe(baseline + 1);
                        await page.evaluate(async () => (await import('/scripts/events.js')).eventSource.emit('in_chat_agent_companion_results_updated'));
                    }
                    await closePage(root);
                    expect(await listenerCount(page)).toBe(baseline);
                }
            }
            await expectClean(page, driver);
        });

        test('overview preserves note order/macros/tokens, edit origin, Conversation Mode and chat-only Jump', async ({ page, baseURL }) => {
            const driver = await openEditorAgents(page, baseURL, width);
            await seedNotes(page);
            const baseline = await listenerCount(page);
            await page.locator('#ica_companions_wand_item').evaluate(node => node.click());
            const overview = driver.root.locator('[data-agent-page="companions"]');
            await expect(overview).toBeVisible();
            const notes = overview.locator('[data-companion-key^="note:"]');
            await expect(notes).toHaveCount(20);
            await expect(notes.nth(0)).toHaveAttribute('data-companion-key', 'note:24:editor-companion');
            await expect(notes.nth(1)).toHaveAttribute('data-companion-key', 'note:24:qa-other');
            const snippet = await notes.first().locator('.ds-row-subtitle').textContent();
            expect(snippet).toHaveLength(121);
            expect(snippet).toMatch(/^Original 24 /);
            const companion = overview.locator('[data-companion-key="companion:editor-companion"]');
            await expect(companion.locator('.ica-agents-page-tokens')).toHaveText('24 in · 25 out');
            await expect(companion.locator('.ds-row-subtitle')).toContainText('Auto · Tracker panel only · Markdown');
            await companion.click();
            await expect(driver.detail).toBeVisible();
            expect(await listenerCount(page)).toBe(baseline);
            await driver.detail.getByRole('button', { name: 'Back', exact: true }).click();
            await expect(companion).toBeFocused();
            expect(await listenerCount(page)).toBe(baseline + 1);
            await page.evaluate(() => document.getElementById('sheld').dataset.sbConversationMode = 'on');
            await expect(overview.locator('.sb-status-page')).toBeVisible();
            expect(await listenerCount(page)).toBe(baseline);
            await expect(page.locator('#ica_companions_wand_item')).toBeHidden();
            await page.evaluate(() => document.getElementById('sheld').dataset.sbConversationMode = 'off');
            await expect(companion).toBeVisible();
            expect(await listenerCount(page)).toBe(baseline + 1);
            await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/agent-store.js')).setGlobalSettings({ enabled: false }));
            await refresh(page);
            await expect(overview.locator('.ica-agents-page-notice')).toBeVisible();
            await expect(overview.getByRole('button', { name: 'Run All on Last Message', exact: true })).toBeDisabled();
            const outer = await page.evaluate(() => window.scrollY);
            await notes.first().getByRole('button', { name: 'Jump', exact: true }).click();
            await expect(overview).toHaveCount(0);
            await expect.poll(() => page.locator('#chat').evaluate(node => node.scrollTop)).toBeGreaterThan(0);
            expect(await page.evaluate(() => window.scrollY)).toBe(outer);
            expect(await listenerCount(page)).toBe(baseline);
            await expectClean(page, driver);
        });

        test('overview refresh uses newest pending/error tokens and ignores system/sentinel notes', async ({ page, baseURL }) => {
            const driver = await openEditorAgents(page, baseURL, width);
            await seedNotes(page);
            const overview = await destination(page, driver, 'Companions Overview', 'companions');
            const companion = overview.locator('[data-companion-key="companion:editor-companion"]');
            await companion.focus();
            for (const status of ['pending', 'error']) {
                await page.evaluate(async status => {
                    const { chat } = await import('/script.js');
                    const results = chat.findLast(message => !message.is_system).extra.inChatAgentCompanionResults;
                    results['editor-companion'] = { status, content: 'Must not be a note', tokenUsage: { inputTokens: 301, outputTokens: 0 } };
                    results['qa-sentinel'] = { status: 'done', content: 'tracker-none' };
                    chat.push({ is_system: true, mes: 'system', extra: { inChatAgentCompanionResults: { 'editor-companion': { status: 'done', content: 'Invalid system note', tokenUsage: { inputTokens: 999 } } } } });
                    (await import('/scripts/events.js')).eventSource.emit('in_chat_agent_companion_results_updated');
                }, status);
                await expect(companion.locator('.ica-agents-page-tokens')).toHaveText('301 in · 0 out');
                await expect(companion).toBeFocused();
                await expect(overview).not.toContainText('Must not be a note');
                await expect(overview).not.toContainText('Invalid system note');
                await expect(overview).not.toContainText('tracker-none');
            }
            await expectClean(page, driver);
        });

        test('Groups counts/descriptions, additive snapshots and safe Delete failure retain boundaries', async ({ page, baseURL }) => {
            const driver = await openEditorAgents(page, baseURL, width);
            await seedGroups(page);
            const groups = await destination(page, driver, 'Agent Groups', 'groups');
            const row = key => groups.locator(`[data-sb-editor-field="${key}"]`);
            for (const [key, text] of [['builtin:qa-one', '1 agent'], ['builtin:qa-many', '2 agents'], ['custom:qa-custom', 'QA existing description'], ['custom:qa-zero', '0 agents']]) {
                await expect(row(`group:${key}`).locator('.ds-row-subtitle')).toHaveText(text);
            }
            await expect(row('group:builtin:qa-one').getByRole('button', { name: 'Group Menu', exact: true })).toHaveCount(0);
            const custom = row('group:custom:qa-custom');
            const before = await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/agent-store.js')).getAgents().map(agent => agent.id));
            await custom.getByRole('button', { name: 'Turn On', exact: true }).click();
            await expect.poll(() => driver.saves().length).toBe(1);
            const after = await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/agent-store.js')).getAgents());
            expect(after.map(agent => agent.id)).toEqual(expect.arrayContaining(before));
            expect(after.find(agent => agent.name === 'QA snapshot')?.enabled).toBe(true);
            const turnOn = custom.getByRole('button', { name: 'Turn On', exact: true });
            expect(await turnOn.evaluate(node => getComputedStyle(node).whiteSpace)).toBe('nowrap');
            await custom.getByRole('button', { name: 'Group Menu', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
            const dialog = page.locator('dialog[open]');
            await expect(dialog.locator('.popup-button-cancel')).toBeFocused();
            await page.keyboard.press('Enter');
            await expect(dialog).toHaveCount(0);
            expect(driver.writes.filter(write => write.path.endsWith('/groups/delete'))).toHaveLength(0);
            await page.route('**/api/in-chat-agents/groups/delete', route => route.fulfill({ status: 500, json: { error: 'QA rejection' } }));
            await custom.getByRole('button', { name: 'Group Menu', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
            await dialog.locator('.popup-button-ok').click();
            await expect(page.locator('.toast-error')).toContainText('Failed to delete group');
            // The existing store mutates its cache before HTTP; A4 must not invent rollback.
            await expect(custom).toHaveCount(0);
            await expectClean(page, driver);
        });

        test('Save Agents as Group prechecks, validates and saves ID-free snapshots; Cancel cannot save', async ({ page, baseURL }) => {
            const driver = await openEditorAgents(page, baseURL, width);
            const agentCount = await driver.root.locator('.ica-agent-row').count();
            const groups = await destination(page, driver, 'Agent Groups', 'groups');
            await groups.getByRole('button', { name: 'Save Agents as Group…', exact: true }).click();
            const dialog = page.locator('dialog[open]');
            expect(agentCount).toBeGreaterThan(0);
            await expect(dialog.locator('#ica--grp-agents input')).toHaveCount(agentCount);
            await expect(dialog.locator('#ica--grp-agents input:checked')).toHaveCount(agentCount);
            await dialog.locator('.popup-button-cancel').click();
            await expect(dialog).toHaveCount(0);
            expect(driver.writes.filter(write => write.path.endsWith('/groups/save'))).toHaveLength(0);
            await groups.getByRole('button', { name: 'Save Agents as Group…', exact: true }).click();
            await dialog.locator('.popup-button-ok').click();
            await expect(page.locator('.toast-warning')).toContainText('Please enter a group name');
            expect(driver.writes.filter(write => write.path.endsWith('/groups/save'))).toHaveLength(0);
            await groups.getByRole('button', { name: 'Save Agents as Group…', exact: true }).click();
            await dialog.locator('#ica--grp-name').fill('QA snapshot group');
            await dialog.locator('.popup-button-ok').click();
            await expect.poll(() => driver.writes.filter(write => write.path.endsWith('/groups/save')).length).toBe(1);
            const saved = driver.writes.find(write => write.path.endsWith('/groups/save')).body;
            expect(saved.agentTemplateIds).toEqual([]);
            expect(saved.customAgents).toHaveLength(agentCount);
            expect(saved.customAgents.every(agent => !Object.hasOwn(agent, 'id') && agent.enabled === false)).toBe(true);
            await expectClean(page, driver);
        });
    });
}
