import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });

const READS = new Set([
    '/api/settings/get', '/api/characters/all', '/api/characters/get', '/api/characters/chats', '/api/groups/all',
    '/api/backgrounds/all', '/api/avatars/get', '/api/stats/get', '/api/secrets/read', '/api/secrets/settings',
    '/api/users/me', '/api/extensions/discover', '/api/worldinfo/get', '/api/worldinfo/list', '/api/themes/all',
    '/api/presets/list', '/api/in-chat-agents/groups/list', '/api/chats/search',
]);

async function openAgents(page, baseURL, width = 1440) {
    const origin = new URL(baseURL).origin;
    if (new URL(baseURL).port !== '4455') throw new Error('Agents QA requires the isolated 4455 instance');
    const writes = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 1000 });
    await page.context().route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (!url.pathname.startsWith('/api/') || request.method() === 'GET') return route.continue();
        if (READS.has(url.pathname) || url.pathname.startsWith('/api/tokenizers/')) return route.continue();
        if (/^\/api\/chats\/(?:group\/)?get$/.test(url.pathname) && request.postDataJSON()?.allow_create !== true) return route.continue();
        writes.push({ path: url.pathname, body: request.postData() });
        return route.fulfill({ json: url.pathname === '/api/settings/save' ? { result: 'ok' } : {} });
    });
    await page.context().route('**/api/horde/text-models', route => route.fulfill({ json: [] }));
    await page.addInitScript(() => {
        window.__agentsMaxDialogs = 0;
        document.addEventListener('DOMContentLoaded', () => {
            new MutationObserver(() => {
                window.__agentsMaxDialogs = Math.max(window.__agentsMaxDialogs, document.querySelectorAll('dialog[open]').length);
            }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
            const style = document.createElement('style');
            style.textContent = '#toast-container { display: none !important; }';
            document.head.append(style);
        });
    });
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'));
    await page.evaluate(async () => {
        window.$('#themes').val('Libadwaita').trigger('change');
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        store.loadAgents(['Alpha', 'Bravo', 'Charlie'].map((name, index) => ({
            ...store.createDefaultAgent(), id: `qa-${name.toLowerCase()}`, name: `QA ${name}`, prompt: 'QA prompt',
            description: 'QA description for truncation and alignment', category: 'custom', phase: 'pre', enabled: false,
            favorite: index === 0, injection: { role: 0, order: index * 10, position: 0, depth: 0, scan: false },
        })));
        store.setGlobalSettings({ enabled: true, separateRecentChats: false });
        (await import('/scripts/extensions/in-chat-agents/ui/agent-list.js')).refreshAgentsPanels();
        await window.SillyBunnyShell.openTab('left', 'agents');
    });
    await page.locator('button[data-sb-settings-tab="agents"]').evaluate(button => button.click());
    const root = page.locator('.ica-agents-editor');
    await expect(root).toBeVisible();
    await expect(root.locator('.ica-agent-row[data-agent-id="qa-bravo"]')).toBeVisible();
    writes.length = 0;
    return { root, writes, errors, saves: () => writes.filter(write => write.path === '/api/in-chat-agents/save') };
}

async function menu(page, root, label = 'Agents Menu') {
    await root.getByRole('button', { name: label, exact: true }).click();
    return page.getByRole('menuitem');
}

async function selectMode(page, root) {
    await menu(page, root);
    await page.getByRole('menuitem', { name: 'Select', exact: true }).click();
    await expect(root.locator('.sb-selection-title')).toHaveText('0 selected');
}

async function back(root) {
    await root.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(root.locator('.ica-agents-fixed')).toBeVisible();
}

for (const width of [1440, 390]) {
    test(`${width}px Agents list colours and bottom inset match the prompt editor list`, async ({ page, baseURL }) => {
        const { root } = await openAgents(page, baseURL, width);
        const read = (panel, selectors) => page.evaluate(({ panel, selectors }) => {
            const host = document.querySelector(`[data-sb-panel="${panel}"]`);
            const visible = selector => [...host.querySelectorAll(selector)].find(node => node.getClientRects().length);
            const pick = (selector, props) => {
                const style = getComputedStyle(visible(selector));
                return Object.fromEntries(props.map(prop => [prop, style.getPropertyValue(prop)]));
            };
            const card = host.querySelector('.sb-list-editor').getBoundingClientRect();
            const scroller = host.querySelector('.sb-shell-panel-scroller').getBoundingClientRect();
            return {
                box: pick(selectors.box, ['background-color', 'border-top-color', 'border-top-width', 'border-radius']),
                // The count is hidden below a 400px list (by design), so phones compare everything else.
                token: selectors.token ? pick(selectors.token, ['background-color', 'color', 'font-size']) : null,
                menu: pick(selectors.menu, ['background-color', 'border-top-width']),
                bottomInset: Math.round(scroller.bottom - card.bottom),
            };
        }, { panel, selectors });
        const withToken = width >= 768;
        if (withToken) await root.locator('.ica-agent-row .ica-agent-token').first().waitFor();
        const agents = await read('agents', { box: '.ica-agents-box', token: withToken && '.ica-agent-row .ica-agent-token', menu: '.ica-agent-row .ds-entity-row__button' });
        expect(await root.locator('.ica-agent-row > .ds-entity-row__badge').first().evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
        await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'editor'));
        await page.locator('button[data-sb-settings-tab="editor"]').evaluate(button => button.click());
        await expect(page.locator('[data-sb-panel="editor"] .sb-prompt-row').first()).toBeVisible();
        const prompt = await read('editor', { box: '.sb-prompt-box', token: withToken && '.sb-prompt-token', menu: '.sb-prompt-row-menu' });
        expect(agents).toEqual(prompt);
    });
}

for (const width of [1440, 768, 390, 360]) {
    test(`${width}px Agents list alignment, tooltips, adaptive metadata and accessibility`, async ({ page, baseURL }) => {
        const { root, errors } = await openAgents(page, baseURL, width);
        await expect(page.locator('#ica--agentList, #ica--agentTabs, #ica--bulkBar, .ica--quick-section, .ica--template-browser')).toHaveCount(0);
        for (const label of ['Add Agent', 'Agents Menu', 'Filter Agents']) {
            expect(await root.getByRole('button', { name: label, exact: true }).evaluate(node => node.title || node.getAttribute('data-sttt--title'))).toBe(label);
        }
        const rows = root.locator('.ica-agent-row');
        expect(await rows.count()).toBeGreaterThan(10);
        expect(await rows.locator(':scope > .ds-entity-row__grip').count()).toBe(await rows.count());
        await expect(root.locator('.ica-agent-row[data-saved="false"]').first().locator('.ica-agent-grip-placeholder')).toHaveAttribute('aria-hidden', 'true');
        const geometry = await root.evaluate(node => ({ scroll: node.scrollWidth, client: node.clientWidth }));
        expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
        await expect(rows.first()).toHaveAttribute('aria-description', /tokens/);
        await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
        await page.evaluate(() => document.documentElement.style.setProperty('--mainFontSize', '32px'));
        expect(await root.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        await page.evaluate(() => document.documentElement.style.removeProperty('--mainFontSize'));
        await root.locator('[data-sb-list-key="settings"]').click();
        await expect(root.locator('#ica--helperPrefillMessages')).toBeVisible();
        const sidebarWidth = await root.locator('.sb-list-editor__sidebar').evaluate(node => node.clientWidth);
        expect(sidebarWidth >= 400 || await root.locator('.ica-agent-token:visible').count() === 0).toBe(true);
        expect(await root.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
        await back(root);
        await root.locator('[data-sb-list-key="groups"]').click();
        await expect(root.getByRole('button', { name: 'Save Agents as Group…', exact: true })).toHaveClass(/ds-button-row/);
        expect(await root.getByRole('button', { name: 'Turn On', exact: true }).first().evaluate(node => getComputedStyle(node).whiteSpace)).toBe('nowrap');
        await back(root);
        expect(errors).toEqual([]);
        expect(await page.evaluate(() => window.__agentsMaxDialogs)).toBeLessThanOrEqual(1);
    });
}

for (const width of [1440, 390]) {
    test(`${width}px unused open, cancel, preview and export never save; sole-copy Delete restores unused`, async ({ page, baseURL }) => {
        const { root, writes, saves, errors } = await openAgents(page, baseURL, width);
        const unused = root.locator('.ica-agent-row[data-saved="false"]').first();
        const key = await unused.getAttribute('data-sb-list-key');
        const name = await unused.getAttribute('aria-label');
        const search = root.getByRole('searchbox', { name: 'Search Agents', exact: true });
        await search.fill(name);
        await unused.click();
        await expect(page.locator('dialog[open] #ica--editor')).toBeVisible();
        await page.locator('dialog[open] .popup-button-cancel').click();
        await menu(page, unused, 'Agent Menu');
        await page.getByRole('menuitem', { name: /Preview (Prompt|Feedback)/ }).click();
        await page.locator('dialog[open] .popup-button-ok').click();
        await menu(page, unused, 'Agent Menu');
        const download = page.waitForEvent('download');
        await page.getByRole('menuitem', { name: 'Export…', exact: true }).click();
        expect((await download).suggestedFilename()).toContain(name);
        expect(saves()).toHaveLength(0);
        await unused.getByRole('switch').click();
        await expect.poll(() => saves().length).toBe(1);
        const saved = root.getByRole('listitem', { name, exact: true }).first();
        await expect(saved).toHaveAttribute('data-saved', 'true');
        await expect.poll(() => saved.evaluate(node => node.contains(document.activeElement))).toBe(true);
        await menu(page, saved, 'Agent Menu');
        await page.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
        await expect(page.locator('dialog[open] .popup-button-cancel')).toBeFocused();
        await page.locator('dialog[open] .popup-button-ok').click();
        await expect(root.locator(`[data-sb-list-key="${key}"]`)).toHaveAttribute('data-saved', 'false');
        expect(writes.filter(write => write.path === '/api/in-chat-agents/delete')).toHaveLength(1);
        expect(errors).toEqual([]);
    });

    test(`${width}px selection deduplicates Pinned; filtered Select All includes unused; no-op and mixed Delete are safe`, async ({ page, baseURL }) => {
        const { root, writes, saves } = await openAgents(page, baseURL, width);
        await selectMode(page, root);
        await root.locator('[data-sb-list-key="pinned:agent:qa-alpha"]').click();
        await expect(root.locator('.sb-selection-title')).toHaveText('1 selected');
        await expect(root.locator('[data-sb-list-key="agent:qa-alpha"] .sb-selection-check')).toBeChecked();
        await root.locator('[data-sb-list-key="agent:qa-alpha"]').click();
        const unused = root.locator('.ica-agent-row[data-saved="false"]').first();
        await unused.click();
        await expect(root.getByRole('button', { name: 'Delete…', exact: true })).toBeDisabled();
        await root.getByRole('button', { name: 'Turn Off', exact: true }).click();
        expect(saves()).toHaveLength(0);
        await root.getByRole('button', { name: 'Edit Properties…', exact: true }).click();
        await expect(page.locator('dialog[open] #ica--bulkEdit-role')).toBeVisible();
        await page.locator('dialog[open] .popup-button-cancel').click();
        await expect(root.locator('.sb-selection-title')).toHaveText('1 selected');
        await root.getByRole('button', { name: 'Turn On', exact: true }).click();
        await expect.poll(() => saves().length).toBe(1);
        await expect(root.locator('.sb-selection-title')).toHaveText('1 selected');
        await root.locator('[data-sb-list-key="agent:qa-bravo"]').click();
        await root.getByRole('button', { name: 'Delete…', exact: true }).click();
        await expect(page.locator('dialog[open] .popup-button-ok')).toHaveText('Delete 2 Saved Agents');
        await page.locator('dialog[open] .popup-button-cancel').click();
        expect(writes.filter(write => write.path.endsWith('/delete'))).toHaveLength(0);
        await root.getByRole('button', { name: 'Cancel', exact: true }).click();
        await root.getByRole('searchbox', { name: 'Search Agents', exact: true }).fill(await unused.getAttribute('aria-label'));
        await selectMode(page, root);
        await root.getByRole('button', { name: 'Select All', exact: true }).click();
        await expect(root.locator('.sb-selection-title')).toHaveText('1 selected');
        await root.getByRole('button', { name: 'Cancel', exact: true }).click();
        await root.getByRole('searchbox', { name: 'Search Agents', exact: true }).fill('QA ');
        await selectMode(page, root);
        await root.getByRole('button', { name: 'Select All', exact: true }).click();
        await expect(root.locator('.sb-selection-title')).toHaveText('3 selected');
        await page.keyboard.press('Escape');
        await expect(root).toHaveAttribute('data-selection-mode', 'false');
        expect(await page.evaluate(() => window.__agentsMaxDialogs)).toBeLessThanOrEqual(1);
    });

    test(`${width}px shell search shows control label, help, section and focuses Settings; Escape returns to origin`, async ({ page, baseURL }) => {
        const { root, saves } = await openAgents(page, baseURL, width);
        await page.evaluate(() => window.SillyBunnyShell.openGlobalSearch());
        await page.locator('#sb-universal-search input').fill('helper prefill');
        const result = page.getByRole('group', { name: 'Backend · Agents', exact: true }).getByRole('option').filter({ hasText: 'Helper Prefill Messages' }).first();
        await expect(result.locator('strong')).toHaveText('Helper Prefill Messages');
        await expect(result.locator('span')).toContainText('Use [system]');
        await expect(result.locator('small')).toHaveText('Backend · Agents · Settings');
        await result.click();
        await expect(root.locator('#ica--helperPrefillMessages')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(root.locator('#ica--helperPrefillMessages')).not.toBeFocused();
        await page.keyboard.press('Escape');
        await expect(root.locator('[data-sb-list-key="settings"]')).toBeFocused();
        expect(saves()).toHaveLength(0);
    });
}

test('keyboard reorder and Move Up/Down persist identical saved slots without materialising peers', async ({ page, baseURL }) => {
    const { root, saves } = await openAgents(page, baseURL);
    const group = root.locator('.ica-agents-box').filter({ has: page.locator('[data-sb-list-key="agent:qa-bravo"]') });
    const bravo = group.locator('[data-sb-list-key="agent:qa-bravo"]');
    await bravo.locator('.ica-agent-grip').focus();
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => group.locator('.ica-agent-row').evaluateAll(rows => rows.map(row => row.dataset.agentId))).toEqual(['qa-bravo', 'qa-alpha', 'qa-charlie']);
    await expect(bravo.locator('.ica-agent-grip')).toBeFocused();
    await menu(page, bravo, 'Agent Menu');
    await expect(page.getByRole('menuitem', { name: 'Move Up', exact: true })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Move Down', exact: true }).click();
    await expect.poll(() => group.locator('.ica-agent-row').evaluateAll(rows => rows.map(row => row.dataset.agentId))).toEqual(['qa-alpha', 'qa-bravo', 'qa-charlie']);
    const gripBox = await bravo.locator('.ica-agent-grip').boundingBox();
    const firstBox = await group.locator('.ica-agent-row').first().boundingBox();
    await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(gripBox.x + gripBox.width / 2, firstBox.y + 4, { steps: 15 });
    await page.mouse.up();
    await expect.poll(() => group.locator('.ica-agent-row').evaluateAll(rows => rows.map(row => row.dataset.agentId))).toEqual(['qa-bravo', 'qa-alpha', 'qa-charlie']);
    expect(saves().every(write => JSON.parse(write.body).id.startsWith('qa-'))).toBe(true);
    await root.getByRole('searchbox', { name: 'Search Agents', exact: true }).fill('QA ');
    await menu(page, bravo, 'Agent Menu');
    await expect(page.getByRole('menuitem', { name: /^Move / })).toHaveCount(0);
});

test('bulk roles, six-field properties, companion-output eligibility and conversion skip unchanged saved records', async ({ page, baseURL }) => {
    const { root, saves } = await openAgents(page, baseURL);
    await root.getByRole('searchbox', { name: 'Search Agents', exact: true }).fill('QA ');
    await selectMode(page, root);
    await root.getByRole('button', { name: 'Select All', exact: true }).click();
    const overflow = async label => {
        await menu(page, root, 'Selection Menu');
        await page.getByRole('menuitem', { name: label, exact: true }).click();
    };
    await overflow('Role: System');
    await expect(root.getByRole('button', { name: 'Selection Menu', exact: true })).toBeEnabled();
    expect(saves()).toHaveLength(0);
    await overflow('Role: User');
    await expect.poll(() => saves().length).toBe(3);
    await overflow('Role: User');
    await expect(root.getByRole('button', { name: 'Selection Menu', exact: true })).toBeEnabled();
    expect(saves()).toHaveLength(3);
    await overflow('Run on Companion Outputs');
    await expect(root.getByRole('button', { name: 'Selection Menu', exact: true })).toBeEnabled();
    expect(saves()).toHaveLength(3);
    await root.getByRole('button', { name: 'Edit Properties…', exact: true }).click();
    const fields = { role: '0', phase: 'both', promptMode: 'append', promptEnabled: 'true', ppEnabled: 'true', scan: 'true' };
    for (const [field, value] of Object.entries(fields)) await page.locator(`#ica--bulkEdit-${field}`).selectOption(value);
    await page.locator('dialog[open] .popup-button-ok').click();
    await expect.poll(() => saves().length).toBe(6);
    const edited = JSON.parse(saves().at(-1).body);
    expect(edited).toMatchObject({ injection: { role: 0, scan: true }, phase: 'both', postProcess: { promptTransformMode: 'append', promptTransformEnabled: true, enabled: true } });
    await overflow('Run on Companion Outputs');
    await expect.poll(() => saves().length).toBe(9);
    expect(JSON.parse(saves().at(-1).body).conditions.runOnCompanionOutputs).toBe(true);
    await overflow('Run on Companion Outputs');
    await expect(root.getByRole('button', { name: 'Selection Menu', exact: true })).toBeEnabled();
    expect(saves()).toHaveLength(9);
    await overflow('Convert to Companion');
    await expect.poll(() => saves().length).toBe(12);
    expect(JSON.parse(saves().at(-1).body).execution).toBe('companion');
    await overflow('Convert to Companion');
    await expect(root.getByRole('button', { name: 'Selection Menu', exact: true })).toBeEnabled();
    expect(saves()).toHaveLength(12);
    expect(await page.evaluate(() => window.__agentsMaxDialogs)).toBeLessThanOrEqual(1);
});

test('unused bulk no-ops stay virtual; a changed role materialises once and keeps canonical selection', async ({ page, baseURL }) => {
    const { root, saves } = await openAgents(page, baseURL);
    const unused = root.locator('.ica-agent-row[data-saved="false"]').first();
    const name = await unused.getAttribute('aria-label');
    await root.getByRole('searchbox', { name: 'Search Agents', exact: true }).fill(name);
    await selectMode(page, root);
    await root.getByRole('button', { name: 'Select All', exact: true }).click();
    await root.getByRole('button', { name: 'Edit Properties…', exact: true }).click();
    await page.locator('dialog[open] .popup-button-ok').click();
    await expect(root.getByRole('button', { name: 'Edit Properties…', exact: true })).toBeEnabled();
    await expect(page.locator('#toast-container')).toContainText('No properties selected to change.');
    expect(saves()).toHaveLength(0);
    await menu(page, root, 'Selection Menu');
    await page.getByRole('menuitem', { name: 'Role: User', exact: true }).click();
    await expect.poll(() => saves().length).toBe(1);
    await expect(root.locator('.sb-selection-title')).toHaveText('1 selected');
    await expect(root.locator('.ica-agent-row[data-saved="true"] .sb-selection-check')).toBeChecked();
    await menu(page, root, 'Selection Menu');
    await page.getByRole('menuitem', { name: 'Role: User', exact: true }).click();
    await expect(root.getByRole('button', { name: 'Selection Menu', exact: true })).toBeEnabled();
    expect(saves()).toHaveLength(1);
});

test('mixed Delete names and deletes only the saved count while retaining unused selection', async ({ page, baseURL }) => {
    const { root, writes, saves } = await openAgents(page, baseURL);
    const unused = root.locator('.ica-agent-row[data-saved="false"]').first();
    const key = await unused.getAttribute('data-sb-list-key');
    await selectMode(page, root);
    await root.locator('[data-sb-list-key="agent:qa-bravo"]').click();
    await unused.click();
    await root.getByRole('button', { name: 'Delete…', exact: true }).click();
    await expect(page.locator('dialog[open] .popup-button-ok')).toHaveText('Delete 1 Saved Agents');
    await page.locator('dialog[open] .popup-button-ok').click();
    await expect(root.locator('[data-sb-list-key="agent:qa-bravo"]')).toHaveCount(0);
    await expect(root.locator(`[data-sb-list-key="${key}"] .sb-selection-check`)).toBeChecked();
    await expect(root.locator('.sb-selection-title')).toHaveText('1 selected');
    expect(saves()).toHaveLength(0);
    expect(writes.filter(write => write.path.endsWith('/delete'))).toHaveLength(1);
});

test('Save as Group snapshots selected unused rows without materialisation and cancellation keeps selection', async ({ page, baseURL }) => {
    const { root, writes, saves } = await openAgents(page, baseURL, 390);
    const unused = root.locator('.ica-agent-row[data-saved="false"]').first();
    const key = await unused.getAttribute('data-sb-list-key');
    await selectMode(page, root);
    await unused.click();
    const openGroup = async () => {
        await menu(page, root, 'Selection Menu');
        await page.getByRole('menuitem', { name: 'Save as Group…', exact: true }).click();
    };
    await openGroup();
    await expect(page.locator('#ica--grp-agents input:checked')).toHaveCount(1);
    await expect(page.locator('#ica--grp-agents input:checked')).toHaveValue(key);
    await page.locator('dialog[open] .popup-button-cancel').click();
    await expect(root.locator('.sb-selection-title')).toHaveText('1 selected');
    await openGroup();
    await page.locator('#ica--grp-name').fill('QA catalogue snapshot');
    await page.locator('dialog[open] .popup-button-ok').click();
    await expect.poll(() => writes.filter(write => write.path === '/api/in-chat-agents/groups/save').length).toBe(1);
    const group = JSON.parse(writes.find(write => write.path.endsWith('/groups/save')).body);
    expect(group.customAgents).toHaveLength(1);
    expect(group.customAgents[0]).not.toHaveProperty('id');
    expect(group.customAgents[0].enabled).toBe(false);
    expect(saves()).toHaveLength(0);
    expect(await page.evaluate(() => window.__agentsMaxDialogs)).toBeLessThanOrEqual(1);
});

test('failed unused bulk save retains selection and can retry without a phantom saved row', async ({ page, baseURL }) => {
    const { root, saves } = await openAgents(page, baseURL);
    let fail = true;
    await page.context().route('**/api/in-chat-agents/save', route => fail ? route.fulfill({ status: 503, json: {} }) : route.fallback());
    const unused = root.locator('.ica-agent-row[data-saved="false"]').first();
    const key = await unused.getAttribute('data-sb-list-key');
    await selectMode(page, root);
    await unused.click();
    await root.getByRole('button', { name: 'Turn On', exact: true }).click();
    await expect(root.getByRole('button', { name: 'Turn On', exact: true })).toBeEnabled();
    await expect(root.locator(`[data-sb-list-key="${key}"] .sb-selection-check`)).toBeChecked();
    await expect(root.locator('.sb-selection-title')).toHaveText('1 selected');
    fail = false;
    await root.getByRole('button', { name: 'Turn On', exact: true }).click();
    await expect.poll(() => saves().length).toBe(1);
    await expect(root.locator(`[data-sb-list-key="${key}"]`)).toHaveCount(0);
    await expect(root.locator('.sb-selection-title')).toHaveText('1 selected');
});

test('new drafts, manual-target cancel, pin, duplicate, import and saved-only export keep catalogue boundaries', async ({ page, baseURL }) => {
    const { root, saves } = await openAgents(page, baseURL);
    for (const label of ['New Agent', 'New Companion']) {
        await menu(page, root, 'Add Agent');
        await page.getByRole('menuitem', { name: label, exact: true }).click();
        await expect(page.locator('dialog[open] #ica--editor')).toBeVisible();
        await page.locator('dialog[open] .popup-button-cancel').click();
    }
    const unused = root.locator('.ica-agent-row[data-saved="false"]').first();
    const name = await unused.getAttribute('aria-label');
    await page.locator('#send_textarea').fill('QA composer target');
    await menu(page, unused, 'Agent Menu');
    await page.getByRole('menuitem', { name: 'Apply to…', exact: true }).click();
    await expect(page.locator('dialog[open] input[name="ica--run-target"]')).not.toHaveCount(0);
    await page.locator('dialog[open] .popup-button-cancel').click();
    expect(saves()).toHaveLength(0);
    await menu(page, unused, 'Agent Menu');
    await page.getByRole('menuitem', { name: 'Duplicate', exact: true }).click();
    await expect.poll(() => saves().length).toBe(1);
    expect(JSON.parse(saves()[0].body)).toMatchObject({ enabled: false, sourceTemplateId: '', name: `${name} (Copy)` });
    await expect(unused).toHaveAttribute('data-saved', 'false');
    await menu(page, unused, 'Agent Menu');
    await page.getByRole('menuitem', { name: 'Pin to Top', exact: true }).click();
    await expect.poll(() => saves().length).toBe(2);
    expect(JSON.parse(saves()[1].body)).toMatchObject({ enabled: false, favorite: true });
    await page.locator('#ica--importFile').setInputFiles({ name: 'qa-import.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ id: 'old-import-id', name: 'QA imported', prompt: 'Imported QA', enabled: false })) });
    await expect.poll(() => saves().length).toBe(3);
    expect(JSON.parse(saves()[2].body).id).not.toBe('old-import-id');
    await menu(page, root);
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Export All…', exact: true }).click();
    const exported = JSON.parse(await readFile(await (await download).path(), 'utf8'));
    expect(exported.agents ?? exported).toHaveLength(6);
    expect(saves()).toHaveLength(3);
    expect(await page.evaluate(() => window.__agentsMaxDialogs)).toBeLessThanOrEqual(1);
});

test('global switch and banner preserve row state and unfiltered header totals', async ({ page, baseURL }) => {
    const { root, saves } = await openAgents(page, baseURL);
    const row = root.locator('[data-sb-list-key="agent:qa-bravo"]');
    await row.getByRole('switch').check();
    await expect.poll(() => saves().length).toBe(1);
    await expect(root.locator('.sb-list-header__subtitle')).toHaveText(/1 on · \d+ tokens/);
    await root.getByRole('searchbox', { name: 'Search Agents', exact: true }).fill('no such QA entry');
    await expect(root.locator('.sb-list-header__subtitle')).toHaveText(/1 on · \d+ tokens/);
    await root.locator('.sb-list-header input[role="switch"]').uncheck();
    await expect(root.locator('.sb-banner')).toBeVisible();
    await root.locator('.sb-banner button').click();
    await expect(root.locator('.sb-banner')).toBeHidden();
    await root.getByRole('searchbox', { name: 'Search Agents', exact: true }).fill('QA Bravo');
    await expect(row.getByRole('switch')).toBeChecked();
    expect(saves()).toHaveLength(1);
});

test('390px coarse controls meet 44px and interim pages keep shell and in-pane Back separate', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block', reducedMotion: 'reduce' });
    try {
        const page = await context.newPage();
        const { root } = await openAgents(page, baseURL, 390);
        const targets = root.locator('.sb-list-header__button:visible, .ica-agents-search button, .ica-agent-row .ds-entity-row__button, .ica-agent-grip');
        for (const target of await targets.all()) {
            const box = await target.boundingBox();
            expect(box.width).toBeGreaterThanOrEqual(44);
            expect(box.height).toBeGreaterThanOrEqual(44);
        }
        for (const control of await root.getByRole('switch').all()) {
            const box = await control.evaluate(node => (node.closest('label') ?? node).getBoundingClientRect().toJSON());
            expect(box.width).toBeGreaterThanOrEqual(44);
            expect(box.height).toBeGreaterThanOrEqual(44);
        }
        const switchTarget = root.locator('[data-sb-list-key="agent:qa-bravo"] .ica-agent-switch-target');
        await switchTarget.click({ position: { x: 1, y: 1 } });
        await expect(switchTarget.getByRole('switch')).toBeChecked();
        await expect(page.locator('dialog[open]')).toHaveCount(0);
        for (const key of ['settings', 'groups']) {
            await root.locator(`[data-sb-list-key="${key}"]`).click();
            const paneBack = root.getByRole('button', { name: 'Back', exact: true });
            await expect(paneBack).toBeVisible();
            const box = await paneBack.boundingBox();
            expect(box.width).toBeGreaterThanOrEqual(44);
            expect(box.height).toBeGreaterThanOrEqual(44);
            await expect(page.locator('#sb-settings-back')).toBeVisible();
            await page.locator('#sb-settings-back').click();
            await expect(page.locator('#sb-settings-page')).not.toHaveClass(/sb-settings-page--content/);
            await expect(root).toHaveAttribute('data-open', 'true');
            await page.getByRole('complementary', { name: 'Settings navigation' }).getByRole('tab', { name: 'Agents', exact: true }).click();
            await expect(paneBack).toBeVisible();
            for (const target of await root.getByRole('button', { name: 'Turn On', exact: true }).all()) {
                expect((await target.boundingBox()).height).toBeGreaterThanOrEqual(44);
            }
            await back(root);
            await expect(root.locator(`[data-sb-list-key="${key}"]`)).toBeFocused();
        }
    } finally {
        await context.close();
    }
});

test('saved extra copies update and restore by ID; Update keeps order while Restore resets it', async ({ page, baseURL }) => {
    const { root, saves } = await openAgents(page, baseURL);
    const templateKey = await root.locator('.ica-agent-row[data-saved="false"]').first().getAttribute('data-sb-list-key');
    const fixture = await page.evaluate(async templateId => {
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        const catalogue = await import('/scripts/extensions/in-chat-agents/catalogue.js');
        const templates = await (await fetch('/scripts/extensions/in-chat-agents/templates/index.json')).json();
        const template = templates.find(item => item.id === templateId);
        const agent = catalogue.buildAgentFromTemplate(template);
        agent.id = 'qa-copy-two';
        agent.name = 'QA outdated copy';
        agent.version = 0;
        agent.prompt = 'QA changed prompt';
        agent.favorite = true;
        agent.enabled = true;
        agent.phaseLocked = true;
        agent.connectionProfile = 'qa-profile';
        agent.modelOverride = 'qa-model';
        agent.injection.order = 777;
        store.loadAgents([...store.getAgents(), { ...structuredClone(agent), id: 'qa-copy-one', name: 'QA first copy' }, agent]);
        (await import('/scripts/extensions/in-chat-agents/ui/agent-list.js')).refreshAgentsPanels();
        return { name: template.name, prompt: agent.prompt };
    }, templateKey.slice('agent-template:'.length));
    const copy = root.locator('[data-sb-list-key="agent:qa-copy-two"]');
    await menu(page, copy, 'Agent Menu');
    await page.getByRole('menuitem', { name: /^Update to v/ }).click();
    await page.locator('dialog[open] .popup-button-cancel').click();
    expect(saves()).toHaveLength(0);
    await menu(page, copy, 'Agent Menu');
    await page.getByRole('menuitem', { name: /^Update to v/ }).click();
    await page.locator('dialog[open] .popup-button-ok').click();
    await expect.poll(() => saves().length).toBe(1);
    expect(JSON.parse(saves()[0].body)).toMatchObject({ id: 'qa-copy-two', name: fixture.name, favorite: true, enabled: true, phaseLocked: false, injection: { order: 777 }, connectionProfile: 'qa-profile', modelOverride: 'qa-model' });
    await menu(page, copy, 'Agent Menu');
    await page.getByRole('menuitem', { name: 'Restore Default…', exact: true }).click();
    await expect(page.locator('dialog[open] .popup-button-cancel')).toBeFocused();
    await page.locator('dialog[open] .popup-button-ok').click();
    await expect.poll(() => saves().length).toBe(2);
    expect(JSON.parse(saves()[1].body).id).toBe('qa-copy-two');
    expect(JSON.parse(saves()[1].body).injection.order).not.toBe(777);
    expect(await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/agent-store.js')).getAgentById('qa-copy-one').prompt)).toBe(fixture.prompt);
    expect(await page.evaluate(() => window.__agentsMaxDialogs)).toBeLessThanOrEqual(1);
});

test('unused editor Save materialises once and a later saved edit retains its ID', async ({ page, baseURL }) => {
    const { root, saves } = await openAgents(page, baseURL);
    const unused = root.locator('.ica-agent-row[data-saved="false"]').first();
    const key = await unused.getAttribute('data-sb-list-key');
    await unused.click();
    await page.locator('#ica--editor-name').fill('QA saved catalogue draft');
    expect(saves()).toHaveLength(0);
    await page.locator('dialog[open] .popup-button-ok').click();
    await expect.poll(() => saves().length).toBe(1);
    const saved = JSON.parse(saves()[0].body);
    expect(saved.sourceTemplateId).toBe(key.slice('agent-template:'.length));
    expect(saved.enabled).toBe(false);
    const row = root.locator(`[data-sb-list-key="agent:${saved.id}"]`);
    await expect(row).toBeVisible();
    await row.click();
    await page.locator('#ica--editor-name').fill('QA saved catalogue edited');
    await page.locator('dialog[open] .popup-button-ok').click();
    await expect.poll(() => saves().length).toBe(2);
    expect(JSON.parse(saves()[1].body).id).toBe(saved.id);
    expect(await page.evaluate(() => window.__agentsMaxDialogs)).toBeLessThanOrEqual(1);
});

test('interim Groups create, additive Turn On and Delete retain single-level confirmation', async ({ page, baseURL }) => {
    const { root, writes, saves } = await openAgents(page, baseURL, 390);
    await root.locator('[data-sb-list-key="groups"]').click();
    await root.getByRole('button', { name: 'Save Agents as Group…', exact: true }).click();
    await page.locator('#ica--grp-name').fill('QA group roundtrip');
    await page.locator('dialog[open] .popup-button-ok').click();
    const row = root.locator('.ds-row').filter({ has: page.getByText('QA group roundtrip', { exact: true }) });
    await expect(row).toBeVisible();
    expect(writes.filter(write => write.path.endsWith('/groups/save'))).toHaveLength(1);
    await row.getByRole('button', { name: 'Turn On', exact: true }).click();
    await expect.poll(() => saves().length).toBe(3);
    expect(saves().every(write => JSON.parse(write.body).enabled)).toBe(true);
    await row.getByRole('button', { name: 'Turn On', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Turn On', exact: true })).toBeEnabled();
    expect(saves()).toHaveLength(3);
    await row.getByRole('button', { name: 'Delete…', exact: true }).click();
    await page.locator('dialog[open] .popup-button-cancel').click();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Delete…', exact: true }).click();
    await page.locator('dialog[open] .popup-button-ok').click();
    await expect(row).toHaveCount(0);
    expect(writes.filter(write => write.path.endsWith('/groups/delete'))).toHaveLength(1);
    expect(await page.evaluate(() => window.__agentsMaxDialogs)).toBeLessThanOrEqual(1);
});

test('header Update All, Fix Trackers and Convert Trackers retain safe no-candidate paths', async ({ page, baseURL }) => {
    const { root, saves } = await openAgents(page, baseURL);
    await menu(page, root);
    await expect(page.getByRole('menuitem', { name: /^Update All/ })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Fix Trackers', exact: true }).click();
    await menu(page, root);
    await page.getByRole('menuitem', { name: 'Convert Trackers to Companions…', exact: true }).click();
    expect(saves()).toHaveLength(0);
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(root.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
});
