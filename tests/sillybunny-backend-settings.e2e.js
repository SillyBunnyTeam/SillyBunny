import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { auditPromptingLayout } from './helpers/prompting-layout.js';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

async function loadSettings(page, baseURL, settingsStore) {
    const origin = new URL(baseURL).origin;
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname);
    let version = 1_000_000_000_000_000;
    const readOnlyEndpoints = new Set([
        '/api/characters/all', '/api/characters/chats', '/api/groups/all', '/api/backgrounds/all',
        '/api/avatars/get', '/api/stats/get', '/api/secrets/read', '/api/users/me',
    ]);
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/api/extensions/discover') {
            const response = await route.fetch();
            const extensions = await response.json();
            return route.fulfill({ json: extensions.filter(extension => !extension.name.startsWith('third-party/')) });
        }
        if (url.pathname === '/api/settings/get') {
            const response = await route.fetch();
            const data = await response.json();
            data.request_compression = { ...data.request_compression, enabled: false };
            const settings = settingsStore?.saved ?? JSON.parse(data.settings);
            settings.firstRun = false;
            settings.extension_settings['quick-image-gen'] = { ...settings.extension_settings['quick-image-gen'], setupWizardSeen: true };
            data.settings = JSON.stringify(settings);
            return route.fulfill({ json: data });
        }
        if (url.pathname === '/api/settings/save') {
            if (settingsStore) settingsStore.saved = { ...route.request().postDataJSON(), _version: version + 1 };
            return route.fulfill({ json: { version: ++version } });
        }
        if (url.pathname === '/api/presets/save') {
            return route.fulfill({ json: { name: route.request().postDataJSON()?.name ?? '' } });
        }
        if (readOnlyEndpoints.has(url.pathname) || url.pathname.startsWith('/api/tokenizers/')) return route.continue();
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.request().method()) && url.pathname.startsWith('/api/')) {
            return route.fulfill({ json: {} });
        }
        if (url.pathname.startsWith('/api/backends/')) return route.fulfill({ json: { data: [] } });
        if (/^\/api\/.*\/(save|delete|create|edit|rename|update|import|upload|restore|duplicate|write|set)$/.test(url.pathname)) {
            return route.fulfill({ json: {} });
        }
        return route.continue();
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
}

async function openPanel(page, tab, shell = 'left') {
    await page.evaluate(({ tab, shell }) => window.SillyBunnyShell.openTab(shell, tab), { tab, shell });
    const button = page.locator(`button[data-sb-settings-tab="${tab}"]`);
    await button.evaluate(button => button.click());
    const panel = page.locator(`[data-sb-panel="${tab}"]`);
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    await panel.locator('.sb-shell-panel-scroller').evaluate(scroller => { scroller.scrollTop = 0; });
    return panel;
}

async function selectBackend(page, api, source) {
    await page.evaluate(({ api, source }) => {
        $('#main_api').val(api).trigger('change');
        if (source) $(api === 'openai' ? '#chat_completion_source' : '#textgen_type').val(source).trigger('change');
    }, { api, source });
}

async function expectNoOverflow(panel) {
    await expect.poll(() => panel.locator('.sb-shell-panel-scroller').evaluate(scroller => scroller.scrollWidth - scroller.clientWidth)).toBeLessThanOrEqual(1);
}

async function expectSwitchGeometry(root, compactSampling = false) {
    await expect.poll(() => root.locator('input[type="checkbox"]:visible').evaluateAll((inputs, compactSampling) => inputs.flatMap(input => {
        const row = input.closest('.ds-row-switch');
        const id = input.id || input.dataset.name || input.getAttribute('aria-label');
        if (!row) return [`${id}: missing switch row`];
        const style = getComputedStyle(row);
        const rowRect = row.getBoundingClientRect();
        const switchRect = input.getBoundingClientRect();
        const suffix = input.closest('.ds-row-suffix');
        const metrics = {
            padding: style.padding === (compactSampling ? '4px 16px' : '6px 16px'),
            gap: style.gap === '12px',
            minHeight: parseFloat(style.minHeight) === (row.querySelector('.ds-row-subtitle') ? (compactSampling ? 44 : 52) : (compactSampling ? 36 : 44)),
            suffixWidth: suffix && Math.abs(suffix.getBoundingClientRect().width - 42) <= 1,
            rightInset: Math.abs(rowRect.right - switchRect.right - parseFloat(style.borderRightWidth) - 16) <= 1,
            centered: Math.abs(switchRect.top + switchRect.height / 2 - rowRect.top - rowRect.height / 2) <= 1,
        };
        return Object.entries(metrics).filter(([, pass]) => !pass).map(([metric]) => `${id}: ${metric}`);
    }), compactSampling)).toEqual([]);
}

async function expectPromptingFlow(prompting, api) {
    if (api !== 'openai') {
        await expect(prompting.locator('.sb-prompting-group:visible > h3')).toHaveText(['Presets', 'Generation Settings']);
        return;
    }
    await expect(prompting.locator('.sb-prompting-group:visible').locator(':scope > h3, :scope > .sb-settings-flat-header b')).toHaveText([
        'Presets', 'Prompt Manager', 'Generation Settings', 'Output', 'Advanced & Reasoning', 'Quick Prompts Edit / Utility Prompts',
    ]);
    await expect(prompting.locator('#completion_prompt_manager')).toBeVisible();
    await expect(prompting.locator('.openai-tab-buttons, .sb-subpage')).toHaveCount(0);
}

async function expectPresetActionLabels(prompting, width) {
    const actions = prompting.locator(':is(.sb-preset-toolbar-row, .sb-non-chat-preset-row):visible .menu_button:visible');
    for (const action of await actions.all()) {
        const label = action.locator(':scope > .sb-action-btn-label');
        await expect(label).toHaveCount(1);
        const text = (await label.textContent()).trim();
        expect(text).not.toBe('');
        await expect(action).toHaveAccessibleName(text);
        await expect.poll(() => label.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
    }
    for (const toolbar of await prompting.locator(':is(.sb-preset-toolbar-row, .sb-non-chat-preset-row):visible').all()) {
        const destructive = toolbar.locator('.sb-action-btn--danger');
        if (await destructive.count() === 2) {
            const deleteLabel = await destructive.nth(0).locator('.sb-action-btn-label').textContent();
            await expect(destructive.nth(1).locator('.sb-action-btn-label')).not.toHaveText(deleteLabel);
        }
        if (width !== 390) {
            expect(await toolbar.locator('.sb-action-btn-group').evaluateAll(groups => groups.flatMap(group => {
                const buttons = [...group.querySelectorAll('.sb-action-btn')].filter(button => button.getBoundingClientRect().width > 0);
                if (buttons.length < 2) return [];
                const first = buttons[0].getBoundingClientRect().top;
                return buttons.some(button => Math.abs(button.getBoundingClientRect().top - first) > 1) ? [group.className] : [];
            }))).toEqual([]);
        }
        if (width !== 390) continue;
        expect(await toolbar.evaluate(element => {
            const style = getComputedStyle(element);
            const contentWidth = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
            const buttons = [...element.querySelectorAll('.sb-action-btn')].filter(button => button.getClientRects().length > 0);
            const lines = [];
            for (const button of buttons) {
                const rect = button.getBoundingClientRect();
                let offsetTop = button.offsetTop;
                for (let parent = button.offsetParent; parent && element.contains(parent) && parent !== element; parent = parent.offsetParent) {
                    offsetTop += parent.offsetTop;
                }
                const line = lines.find(candidate => Math.abs(candidate.offsetTop - offsetTop) <= 1);
                if (line) line.buttons.push(rect.width);
                else lines.push({ offsetTop, buttons: [rect.width] });
            }
            return lines.flatMap(line => line.buttons.length === 1 && line.buttons[0] < contentWidth * 0.9 ? [line] : []);
        })).toEqual([]);
    }
}

async function expectPromptingInsets(prompting) {
    expect((await prompting.evaluate(auditPromptingLayout)).filter(record => !record.pass)).toEqual([]);
}

async function readBackendHeaderMetrics(header) {
    return header.evaluate(element => {
        const style = getComputedStyle(element);
        const titleRow = element.querySelector(':scope > .sb-backend-title-row');
        const description = element.querySelector(':scope > p');
        const descriptionStyle = description ? getComputedStyle(description) : null;
        return {
            padding: style.padding,
            rowGap: style.rowGap,
            titleRowHeight: titleRow?.getBoundingClientRect().height ?? 0,
            descriptionFont: descriptionStyle ? `${descriptionStyle.fontSize}/${descriptionStyle.lineHeight}` : '',
            descriptionWraps: descriptionStyle?.whiteSpace !== 'nowrap',
        };
    });
}

async function expectSamplingTaxonomy(sampling, api) {
    if (api !== 'textgenerationwebui') return;
    await expect(sampling.locator('.sb-sampling-group:visible > h3')).toHaveText([
        'Sampling', 'Penalties & Repetition', 'Advanced Algorithms', 'Token Control', 'Output & Generation',
    ]);
}

async function readPresetDownload(download) {
    const path = await download.path();
    return JSON.parse(await readFile(path, 'utf8'));
}

function getPresetFixture(api) {
    if (api !== 'openai') return { temp: 0.62, top_p: 0.87, genamt: 128, max_length: 8192, dry_multiplier: 0.4, dry_sequence_breakers: 'test\nfixture' };
    return {
        temperature: 0.62,
        top_p: 0.87,
        openai_max_context: 8192,
        openai_max_tokens: 128,
        prompts: [{ identifier: 'phase3-prompt', name: 'Phase 3', role: 'system', content: 'phase3 regression fixture', system_prompt: false, injection_position: 1, injection_depth: 2, injection_order: 42, forbid_overrides: true, injection_trigger: [0] }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'phase3-prompt', enabled: true }] }],
    };
}

async function confirmPresetExport(page, api) {
    if (api === 'openai') await page.locator('dialog[open] .popup-button-ok').click();
}

function expectPresetMetadata(exported, preset, api) {
    if (api === 'openai') {
        expect(exported.prompts).toEqual(preset.prompts);
        expect(exported.prompt_order).toEqual(preset.prompt_order);
        expect(exported.temperature).toBe(0.62);
        return;
    }
    expect(exported.temp).toBe(0.62);
    expect(exported.dry_multiplier).toBe(0.4);
    expect(exported.dry_sequence_breakers).toBe('test\nfixture');
}

async function bindPresetSampling(page, api) {
    if (api !== 'openai') return;
    await page.evaluate(async () => {
        const { getPresetApplicationPromise, oai_settings } = await import('/scripts/openai.js');
        await getPresetApplicationPromise();
        oai_settings.bind_preset_to_sampling = true;
    });
}

for (const theme of ['Libadwaita', 'Libadwaita Light']) {
    for (const width of [1920, 390]) {
        test(`${theme} Backend groups retain their flow at ${width}px`, async ({ page, baseURL }) => {
            test.setTimeout(60000);
            await loadSettings(page, baseURL);
            await page.setViewportSize({ width, height: width === 390 ? 844 : 1080 });
            await page.evaluate(theme => $('#themes').val(theme).trigger('change'), theme);
            for (const [api, source, label] of [
                ['openai', 'openrouter', 'Chat Completions'],
                ['textgenerationwebui', 'ooba', 'Text Completions'],
                ['kobold', null, 'Kobold/Horde'],
                ['koboldhorde', null, 'Kobold/Horde'],
                ['novel', null, 'NovelAI'],
            ]) {
                await selectBackend(page, api, source);
                const prompting = await openPanel(page, 'prompting');
                await expect(prompting.locator('[data-sb-prompting-mode]')).toHaveText(`Backend: ${label}`);
                const promptingHeader = prompting.locator('#ai_response_configuration > .sb-backend-section-header');
                await expect(promptingHeader).toBeVisible();
                await expect(promptingHeader.locator(':scope > .sb-backend-title-row > [data-sb-prompting-mode]')).toBeVisible();
                await expect(promptingHeader.locator(':scope > p[data-sb-copy-placeholder]')).toHaveText('lorum ipsum');
                await expect(promptingHeader.locator('[data-sb-prompting-disclaimer]')).toBeVisible({ visible: api !== 'openai' });
                await expect(promptingHeader.locator('[data-sb-prompting-context]')).toBeVisible({ visible: api !== 'openai' });
                await expectPromptingFlow(prompting, api);
                await expectPresetActionLabels(prompting, width);
                await expectPromptingInsets(prompting);
                const promptingHeaderMetrics = await readBackendHeaderMetrics(promptingHeader);
                await expect(prompting.locator('#sb-openai-sampling')).toBeHidden();
                await expectNoOverflow(prompting);
                await expectSwitchGeometry(prompting);
                const sampling = await openPanel(page, 'sampling');
                await expect(sampling.locator('.sb-sampling-mode-pill:visible')).toHaveText(`Backend: ${label}`);
                await expect(sampling.locator('.sb-backend-section-header:visible')).toHaveCount(1);
                await expect(sampling.locator('.sb-backend-section-header:visible > .sb-backend-title-row > .sb-sampling-mode-pill')).toBeVisible();
                const samplingHeaderMetrics = await readBackendHeaderMetrics(sampling.locator('.sb-backend-section-header:visible'));
                expect(samplingHeaderMetrics.padding).toBe(promptingHeaderMetrics.padding);
                expect(samplingHeaderMetrics.rowGap).toBe(promptingHeaderMetrics.rowGap);
                expect(Math.abs(samplingHeaderMetrics.titleRowHeight - promptingHeaderMetrics.titleRowHeight)).toBeLessThanOrEqual(1);
                expect(samplingHeaderMetrics.descriptionFont).toBe(promptingHeaderMetrics.descriptionFont);
                expect(samplingHeaderMetrics.descriptionWraps && promptingHeaderMetrics.descriptionWraps).toBe(true);
                await expectSamplingTaxonomy(sampling, api);
                await expectNoOverflow(sampling);
                await sampling.locator('details').evaluateAll(details => details.forEach(detail => { detail.open = true; }));
                await expectSwitchGeometry(sampling, width > 620);
            }
            for (const tab of ['appearance', 'interface', 'messages', 'data-security']) {
                const panel = await openPanel(page, tab, 'right');
                await expectSwitchGeometry(panel);
                await expectNoOverflow(panel);
            }
            const logs = await openPanel(page, 'logs', 'right');
            await expect(logs.locator('.sb-console-log-verbose-action')).toBeVisible();
            await expectSwitchGeometry(logs);
            await expectNoOverflow(logs);
        });
    }
}

test('Sampling uses compact full-width rows at desktop and mobile widths', async ({ page, baseURL }) => {
    test.setTimeout(120000);
    await loadSettings(page, baseURL);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await selectBackend(page, 'textgenerationwebui', 'ooba');
    const sampling = await openPanel(page, 'sampling');
    const samplingColumn = sampling.locator('.sb-sampling-panel');
    const connections = await openPanel(page, 'connections');
    const settingsColumnWidth = await connections.locator('.sb-shell-column').first().evaluate(column => parseFloat(getComputedStyle(column).width));

    await openPanel(page, 'sampling');
    await expect.poll(() => samplingColumn.evaluate((column, width) => Math.abs(parseFloat(getComputedStyle(column).width) - width), settingsColumnWidth)).toBeLessThanOrEqual(1);
    const preferenceGroups = sampling.locator('.sb-sampling-group:visible > .ds-pref-group');
    const expectSingleColumn = async () => expect.poll(() => preferenceGroups.evaluateAll(groups => groups.every(group => {
        const groupRect = group.getBoundingClientRect();
        const visibleCards = [...group.children].filter(card => card instanceof HTMLElement
            && !card.hidden && getComputedStyle(card).display !== 'none');
        return visibleCards.every(card => {
            const rect = card.getBoundingClientRect();
            return Math.abs(rect.width - group.clientWidth) <= 1
                && Math.abs(rect.left - groupRect.left - group.clientLeft) <= 1;
        });
    }))).toBe(true);
    await expectSingleColumn();
    const rows = sampling.locator('.sb-sampling-group:visible .ds-row:visible');
    const compactHeights = await rows.evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
    const previousGeometry = await page.addStyleTag({ content: `
        #sb-settings-page .sb-settings-mounted-shell .sb-sampling-panel .ds-row {
            min-height: 44px;
            padding: 6px 16px;
        }
        #sb-settings-page .sb-settings-mounted-shell .sb-sampling-panel .ds-row:has(.ds-row-subtitle) {
            min-height: 52px;
        }
    ` });
    const previousHeights = await rows.evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
    await previousGeometry.evaluate(style => style.remove());
    expect(compactHeights.length).toBeGreaterThan(0);
    expect(compactHeights.every((height, index) => height >= 32 && height <= previousHeights[index] + 1)).toBe(true);
    await expect.poll(() => rows.evaluateAll(rows => rows.every(row => {
        const style = getComputedStyle(row);
        return style.padding === '4px 16px'
            && parseFloat(style.minHeight) === (row.querySelector('.ds-row-subtitle') ? 44 : 36);
    }))).toBe(true);
    for (const selector of ['#dryBlock', '#xtc_block']) {
        const expander = sampling.locator(`details[data-sb-sampling-control="${selector}"]`);
        await expander.locator('summary').click();
        await expect(expander).toHaveAttribute('open', '');
        await expect.poll(() => expander.evaluate(expander => Math.abs(expander.getBoundingClientRect().width - expander.parentElement.clientWidth))).toBeLessThanOrEqual(1);
        await expect.poll(() => expander.locator('.ds-row-expander-content .ds-row:visible').evaluateAll(rows => rows.every(row => {
            const rect = row.getBoundingClientRect();
            const text = row.querySelector('.ds-row-text')?.getBoundingClientRect();
            return text && Math.abs(text.left - rect.left - 16) <= 1 && getComputedStyle(row).display === 'flex';
        }))).toBe(true);
    }
    const expectCleanSeparators = async () => expect.poll(() => preferenceGroups.evaluateAll(groups => groups.flatMap(group => {
        const visibleCards = [...group.children].filter(card => card instanceof HTMLElement
            && !card.hidden && getComputedStyle(card).display !== 'none');
        return visibleCards.flatMap((card, index) => {
            const style = getComputedStyle(card);
            const expectedBottom = index === visibleCards.length - 1 ? 0 : 1;
            return parseFloat(style.borderTopWidth) === 0 && parseFloat(style.borderBottomWidth) === expectedBottom
                ? [] : [card.dataset.sbSamplingControl];
        });
    }))).toEqual([]);
    await expectCleanSeparators();
    await expectNoOverflow(sampling);

    await page.setViewportSize({ width: 390, height: 844 });
    await expectSingleColumn();
    await expectCleanSeparators();
    await expectNoOverflow(sampling);
    await selectBackend(page, 'openai', 'openrouter');
    await expectSingleColumn();
    await expectCleanSeparators();
    await expectNoOverflow(sampling);
    const logitBias = sampling.locator('[data-sb-sampling-control="#openai_logit_bias_preset"]');
    await expect.poll(() => logitBias.evaluate(card => Array.from(card.querySelectorAll('input, select, textarea, button, .menu_button'))
        .filter(control => control.getClientRects().length > 0)
        .flatMap(control => {
            const rect = control.getBoundingClientRect();
            const groupRect = card.parentElement.getBoundingClientRect();
            return rect.left >= groupRect.left && rect.right <= groupRect.right ? [] : [control.id];
        }))).toEqual([]);
});

test('Text-style Prompting opens Context from the keyboard for every backend', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    for (const api of ['textgenerationwebui', 'kobold', 'koboldhorde', 'novel']) {
        await selectBackend(page, api, api === 'textgenerationwebui' ? 'ooba' : null);
        for (const key of ['Enter', 'Space']) {
            const prompting = await openPanel(page, 'prompting');
            const context = prompting.getByRole('button', { name: 'Context', exact: true });
            await expect(prompting.locator('[data-sb-prompting-disclaimer] > p[data-sb-copy-placeholder]')).toHaveText('lorum ipsum');
            await context.focus();
            await expect(context).toBeFocused();
            await page.keyboard.press(key);
            await expect(page.locator('[data-sb-panel="context"]')).toHaveAttribute('aria-hidden', 'false');
        }
    }
});

test('Sampling keeps live nodes, provider visibility, numeric handlers and transmission policy', async ({ page, baseURL }) => {
    test.setTimeout(120000);
    await loadSettings(page, baseURL);
    await page.evaluate(() => {
        window.phase3Nodes = ['temp_openai', 'settings_preset_openai', 'completion_prompt_manager', 'dry_multiplier_textgenerationwebui'].map(id => document.getElementById(id));
    });
    await selectBackend(page, 'openai', 'openai');
    const sampling = await openPanel(page, 'sampling');
    await expect(sampling.locator('#temp_openai')).toBeVisible();
    await expect(sampling.locator('[data-sb-sampling-control="#top_k_openai"]')).toBeHidden();
    await selectBackend(page, 'openai', 'openrouter');
    await expect(sampling.locator('[data-sb-sampling-control="#top_k_openai"]')).toBeVisible();
    await sampling.locator('#temp_counter_openai').fill('0.73');
    await sampling.locator('#temp_counter_openai').press('Enter');
    await expect(sampling.locator('#temp_openai')).toHaveValue('0.73');
    const temperature = sampling.locator('[data-sb-sampling-control="#temp_openai"]');
    await temperature.getByRole('radio', { name: 'Omit', exact: true }).click();
    await expect(temperature.getByRole('radio', { name: 'Omit', exact: true })).toHaveAttribute('aria-checked', 'true');
    await sampling.locator('.sb-neutralize-chat-samplers').click();
    await expect(sampling.locator('#temp_openai')).toHaveValue('1');
    await expect(sampling.locator('#top_p_openai')).toHaveValue('1');
    const prompting = await openPanel(page, 'prompting');
    await expect(prompting.locator('#settings_preset_openai')).toBeVisible();
    await expect(prompting.locator('#import_oai_preset, #export_oai_preset, #update_oai_preset, #new_oai_preset, #delete_oai_preset')).toHaveCount(5);
    expect(await page.evaluate(() => window.phase3Nodes.every(node => node === document.getElementById(node.id)))).toBe(true);
});

test('Native sampler expanders reveal search results and preserve switch and counter interactions', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    await selectBackend(page, 'textgenerationwebui', 'ooba');
    const sampling = await openPanel(page, 'sampling');
    const dry = sampling.locator('details[data-sb-sampling-control="#dryBlock"]');
    await dry.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(dry).toHaveAttribute('open', '');
    await dry.locator('#dry_multiplier_counter_textgenerationwebui').fill('0.8');
    await dry.locator('#dry_multiplier_counter_textgenerationwebui').press('Enter');
    await expect(dry.locator('#dry_multiplier_textgenerationwebui')).toHaveValue('0.8');
    await page.keyboard.press('Tab');
    await dry.locator('summary').click();
    await expect(dry).not.toHaveAttribute('open', '');
    await page.evaluate(() => window.SillyBunnyShell.openGlobalSearch());
    await page.locator('#sb-universal-search input').fill('sequence breakers');
    await page.getByRole('group', { name: 'Backend · Sampling', exact: true }).getByRole('option', { name: /Sequence Breakers/ }).click();
    await expect(dry).toHaveAttribute('open', '');
    await expect(dry.locator('#dry_sequence_breakers_textgenerationwebui')).toBeVisible();
    const dynamic = sampling.locator('details[data-sb-sampling-control="#dynatemp_block_ooba"]');
    await dynamic.locator('summary').click();
    const toggle = dynamic.getByRole('switch', { name: 'Dynamic Temperature', exact: true });
    await toggle.focus();
    const checked = await toggle.isChecked();
    await page.keyboard.press('Enter');
    await expect(toggle).toBeChecked({ checked: !checked });
    const prompting = await openPanel(page, 'prompting');
    await prompting.locator('[data-sb-prompting-context]').click();
    await expect(page.locator('[data-sb-panel="context"]')).toHaveAttribute('aria-hidden', 'false');
});

test('Agents globals and Connections switches use the shared row semantics', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    await page.setViewportSize({ width: 390, height: 844 });
    const agents = await openPanel(page, 'agents');
    await expect(agents.locator('[data-sb-agent-global-settings] > .ds-pref-group')).toHaveCount(2);
    await expect(agents.locator('[data-sb-agent-global-settings] .ds-row')).toHaveCount(10);
    await expect(agents.locator('#ica--companionConcurrent')).toHaveAttribute('role', 'switch');
    const prefill = agents.locator('.ica--helper-prefill-label');
    await expect.poll(() => prefill.evaluate(row => getComputedStyle(row).flexDirection)).toBe('column');
    await expect.poll(() => prefill.locator('textarea').evaluate(field => field.getBoundingClientRect().width)).toBeGreaterThan(280);
    await expectNoOverflow(agents);
    await expectSwitchGeometry(agents.locator('[data-sb-agent-global-settings]'));
    const connections = await openPanel(page, 'connections');
    await expect(connections.locator('#auto-connect-checkbox')).toHaveAttribute('role', 'switch');
    await expectNoOverflow(connections);
    const extensions = await openPanel(page, 'extensions', 'right');
    await expect(extensions.locator('#extensions_notify_updates')).toHaveAttribute('role', 'switch');
    await expectNoOverflow(extensions);
    await expectSwitchGeometry(extensions);
    await extensions.locator('#extensions_details').click();
    const list = page.locator('dialog[open] .extensions_info');
    await expect(list).toBeVisible();
    await expectSwitchGeometry(list);
});

test('Mobile Sampling follows provider and manual sampler visibility', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    await page.setViewportSize({ width: 390, height: 844 });
    await selectBackend(page, 'textgenerationwebui', 'ooba');
    const sampling = await openPanel(page, 'sampling');
    const card = selector => sampling.locator(`[data-sb-sampling-control="${selector}"]`);
    await expect(card('#ignore_eos_token_textgenerationwebui')).toBeHidden();
    await expect(card('#include_reasoning_textgenerationwebui')).toBeHidden();
    await selectBackend(page, 'textgenerationwebui', 'aphrodite');
    await expect(card('#ignore_eos_token_textgenerationwebui')).toBeVisible();
    await expect(card('#include_reasoning_textgenerationwebui')).toBeHidden();
    await selectBackend(page, 'textgenerationwebui', 'openrouter');
    await expect(card('#include_reasoning_textgenerationwebui')).toBeVisible();
    await expect(card('#ignore_eos_token_textgenerationwebui')).toBeHidden();
    await selectBackend(page, 'textgenerationwebui', 'ooba');
    await sampling.locator('#samplerSelectButton').click();
    const temperature = page.locator('#apiSamplersList input[name="temp_checkbox"]');
    await temperature.uncheck();
    await expect(card('#temp_textgenerationwebui')).toBeHidden();
    await temperature.check();
    await expect(card('#temp_textgenerationwebui')).toBeVisible();
    await page.locator('dialog[open] .popup-button-ok').click();
    const bannedTokens = sampling.locator('#send_banned_tokens_textgenerationwebui');
    const enabled = await bannedTokens.isChecked();
    await sampling.locator('#send_banned_tokens_label .menu_button').click();
    await expect(bannedTokens).toBeChecked({ checked: !enabled });
    await sampling.locator('#send_banned_tokens_label .menu_button').click();
    await expect(bannedTokens).toBeChecked({ checked: enabled });
    await expectNoOverflow(sampling);
});

for (const api of ['openai', 'textgenerationwebui']) {
    test(`${api} presets retain imports, switching, exports and prompt metadata`, async ({ page, baseURL }) => {
        await loadSettings(page, baseURL);
        await selectBackend(page, api, api === 'openai' ? 'openrouter' : 'ooba');
        const prompting = await openPanel(page, 'prompting');
        const select = prompting.locator(api === 'openai' ? '#settings_preset_openai' : '#settings_preset_textgenerationwebui');
        const original = await select.inputValue();
        const preset = getPresetFixture(api);
        const name = `phase3-${api}-fixture`;
        const file = prompting.locator(api === 'openai' ? '#openai_preset_import_file' : '[data-preset-manager-file="textgenerationwebui"]');
        await file.setInputFiles({ name: `${name}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(preset)) });
        await expect(select.locator('option:checked')).toHaveText(name);
        const importedValue = await select.inputValue();
        await bindPresetSampling(page, api);
        await select.selectOption(original);
        await select.selectOption(importedValue);
        const sampling = await openPanel(page, 'sampling');
        await expect(sampling.locator(api === 'openai' ? '#temp_openai' : '#temp_textgenerationwebui')).toHaveValue('0.62');
        await expect(sampling.locator(api === 'openai' ? '#top_p_openai' : '#top_p_textgenerationwebui')).toHaveValue('0.87');
        await openPanel(page, 'prompting');
        const downloadPromise = page.waitForEvent('download');
        await prompting.locator(api === 'openai' ? '#export_oai_preset' : '[data-preset-manager-export="textgenerationwebui"]').click();
        await confirmPresetExport(page, api);
        const exported = await readPresetDownload(await downloadPromise);
        expectPresetMetadata(exported, preset, api);
        expect(exported.top_p).toBe(0.87);
    });
}

test('Extensions detail pages retain live controls and restore their list', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    await page.setViewportSize({ width: 390, height: 844 });
    const extensions = await openPanel(page, 'extensions', 'right');
    const firstRow = extensions.locator('.sb-subpage-row').first();
    const containerId = await firstRow.getAttribute('data-sb-subpage-row');
    await page.evaluate(id => {
        const container = document.getElementById(id);
        window.phase3ExtensionNodes = [container, ...container.querySelectorAll('input, select, textarea')];
    }, containerId);
    await firstRow.click();
    await expect(extensions.locator('.sb-subpage-detail')).toHaveAttribute('aria-hidden', 'false');
    await expect(extensions.locator('.sb-subpage-detail-content')).toHaveAttribute('id', containerId);
    expect(await page.evaluate(() => window.phase3ExtensionNodes.every(node => node === document.getElementById(node.id) || !node.id && node.isConnected))).toBe(true);
    await expectNoOverflow(extensions);
    await extensions.locator('.sb-subpage-back').click();
    await expect(extensions.locator('.sb-subpage-detail')).toHaveAttribute('aria-hidden', 'true');
    await expect(firstRow).toBeVisible();
    expect(await page.evaluate(() => window.phase3ExtensionNodes.every(node => node.isConnected))).toBe(true);
});

test('Backend edits and quick context actions survive settings serialization and reload', async ({ page, baseURL }) => {
    const store = {};
    await loadSettings(page, baseURL, store);
    await selectBackend(page, 'textgenerationwebui', 'ooba');
    const sampling = await openPanel(page, 'sampling');
    await sampling.locator('#temp_counter_textgenerationwebui').fill('0.69');
    await sampling.locator('#temp_counter_textgenerationwebui').press('Enter');
    const dry = sampling.locator('details[data-sb-sampling-control="#dryBlock"]');
    await dry.locator('summary').click();
    await dry.locator('#dry_multiplier_counter_textgenerationwebui').fill('0.7');
    await dry.locator('#dry_multiplier_counter_textgenerationwebui').press('Enter');
    const prompting = await openPanel(page, 'prompting');
    await prompting.locator('.quick_context_size_container[data-sb-quick-context-target="text"] [data-size="8192"]').click();
    await expect(prompting.locator('#max_context')).toHaveValue('8192');
    await expect(prompting.locator('#max_context_counter')).toHaveValue('8192');
    await selectBackend(page, 'openai', 'openrouter');
    await openPanel(page, 'sampling');
    await sampling.locator('#temp_counter_openai').fill('0.71');
    await sampling.locator('#temp_counter_openai').press('Enter');
    await page.evaluate(async () => {
        const { oai_settings } = await import('/scripts/openai.js');
        oai_settings.bind_preset_to_sampling = false;
        const { saveSettings } = await import('/script.js');
        await saveSettings();
    });
    expect(store.saved.oai_settings.temp_openai).toBe(0.71);
    expect(store.saved.textgenerationwebui_settings.temp).toBe(0.69);
    expect(store.saved.textgenerationwebui_settings.dry_multiplier).toBe(0.7);
    expect(store.saved.max_context).toBe(8192);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });
    await openPanel(page, 'sampling');
    await expect(sampling.locator('#temp_openai')).toHaveValue('0.71');
    await expect(sampling.locator('#temp_counter_openai')).toHaveValue('0.71');
    await selectBackend(page, 'textgenerationwebui', 'ooba');
    await expect(sampling.locator('#temp_textgenerationwebui')).toHaveValue('0.69');
    await dry.locator('summary').click();
    await expect(dry.locator('#dry_multiplier_textgenerationwebui')).toHaveValue('0.7');
    await expect(dry.locator('#dry_multiplier_counter_textgenerationwebui')).toHaveValue('0.7');
    await openPanel(page, 'prompting');
    await expect(prompting.locator('#max_context')).toHaveValue('8192');
});
