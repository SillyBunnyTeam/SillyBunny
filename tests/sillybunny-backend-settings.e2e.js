import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { auditPromptingLayout } from './helpers/libadwaita-audit.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });

const BACKEND_CATEGORY_TITLE = ':scope > .sb-settings-flat-header .sb-settings-category-title, :scope > .sb-settings-flat-header b';

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
    const readFailures = () => root.locator('input[type="checkbox"]:visible').evaluateAll((inputs, compactSampling) => inputs.flatMap(input => {
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
    }), compactSampling);
    await expect.poll(readFailures, { timeout: 5000 }).toEqual([]);
}

async function expectPromptingFlow(prompting, api) {
    const categoryTitles = prompting.locator(':is(#respective-presets-block, #common-gen-settings-block):visible > .sb-settings-flat-header .sb-settings-category-title');
    await expect(categoryTitles).toHaveCount(api === 'openai' ? 1 : 2);
    expect(await categoryTitles.evaluateAll(titles => titles.filter(title => title.dataset.i18n !== title.textContent.trim()).map(title => title.textContent))).toEqual([]);
    if (api !== 'openai') {
        await expect(prompting.locator('.sb-prompting-group:visible').locator(BACKEND_CATEGORY_TITLE)).toHaveText([
            'Presets', 'Generation Settings', 'System Prompt', 'Instruct Template', 'Context Template', 'Character Names', 'Reasoning Template',
        ]);
        return;
    }
    await expect(prompting.locator('.sb-prompting-group:visible').locator(BACKEND_CATEGORY_TITLE)).toHaveText([
        'Presets', 'Generation Settings', 'Character Names & Prompt Formatting', 'Reply Prefill', 'Request Options', 'Reasoning Template',
    ]);
    await expect(prompting.locator('#completion_prompt_manager')).toHaveCount(0);
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
    const headers = sampling.locator('.sb-sampling-group:visible > .sb-settings-category-header');
    expect(await headers.count()).toBeGreaterThan(0);
    expect(await headers.evaluateAll(elements => elements.flatMap(header => {
        const title = header.querySelector('.sb-settings-category-title');
        const subtitle = header.querySelector('.sb-settings-category-heading > small');
        const failures = [];
        if (!title?.textContent.trim() || title.dataset.i18n !== title.textContent.trim()) failures.push('missing title localization key');
        if (!subtitle?.textContent.trim() || /(?:lorum|lorem) ipsum/i.test(subtitle.textContent)) failures.push('missing category subtitle');
        if (subtitle?.dataset.i18n !== subtitle?.textContent.trim()) failures.push('missing subtitle localization key');
        return failures.map(failure => `${title?.textContent}: ${failure}`);
    }))).toEqual([]);
    if (api !== 'textgenerationwebui') return;
    await expect(sampling.locator('.sb-sampling-group:visible').locator(BACKEND_CATEGORY_TITLE)).toHaveText([
        'Sampling', 'Penalties & Repetition', 'Advanced Algorithms', 'Token Control', 'Output & Generation',
    ]);
    await expect(sampling.locator('.sb-sampling-group[data-sb-sampling-group="presets"]')).toHaveCount(0);
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
            test.setTimeout(120000);
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
                await expect(promptingHeader.locator(':scope > p')).toHaveText('Manage presets and their settings, prompt templates, and reply options.');
                await expect(promptingHeader.locator('[data-sb-copy-placeholder]')).toHaveCount(0);
                await expect(promptingHeader.locator('.sb-backend-disclaimer, button')).toHaveCount(0);
                expect(await promptingHeader.evaluate(header => {
                    const container = header.parentElement.getBoundingClientRect();
                    const box = header.getBoundingClientRect();
                    return Math.abs(box.left - container.left) <= 1 && Math.abs(box.right - container.right) <= 1;
                })).toBe(true);
                await expectPromptingFlow(prompting, api);
                await expectPresetActionLabels(prompting, width);
                await expectPromptingInsets(prompting);
                const promptingHeaderMetrics = await readBackendHeaderMetrics(promptingHeader);
                await expect(prompting.locator('#sb-openai-sampling')).toBeHidden();
                await expect(prompting.locator('[name="startReplyWithBlock"]')).toHaveCount(0);
                await expect(page.locator('#AdvancedFormatting #sb-af-reply-prefix [name="startReplyWithBlock"]')).toHaveCount(1);
                await expectNoOverflow(prompting);
                await expectSwitchGeometry(prompting);
                const editor = await openPanel(page, 'editor');
                await expect(editor.locator('[data-sb-editor-mode]')).toHaveText(`Backend: ${label}`);
                await expect(editor.locator('.sb-prompt-list-titles h2')).toHaveText(api === 'openai' ? 'Prompts' : 'Prompt templates');
                await expect(editor.locator('.sb-prompt-section:visible h3')).toHaveText(api === 'openai'
                    ? ['Prompt order', 'Available', 'Utility prompts'] : ['System prompt', 'Context', 'Instruct']);
                await expect(editor.locator('#completion_prompt_manager, #context_story_string')).toHaveCount(2);
                await expect(editor.locator('#completion_prompt_manager')).toBeHidden();
                await expect(editor.locator('#context_story_string')).toBeHidden();
                await expectNoOverflow(editor);
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
        if (row.classList.contains('sb-sampling-help-row')) {
            return style.padding === '6px 16px' && parseFloat(style.minHeight) === 44;
        }
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

test('Prompting and Formatting rehome live template nodes across repeated backend changes', async ({ page, baseURL }) => {
    // Multiple backend switches follow app startup.
    test.slow();
    await loadSettings(page, baseURL);
    const uniqueSelectors = [
        '#SystemPromptBlock', '#InstructSettingsColumn', '#context_presets', '#always-force-name2-checkbox',
        '#n_textgenerationwebui', '[name="startReplyWithBlock"]',
        '#completion_prompt_manager', '#sb-openai-prompt-manager', '#InstructSequencesColumn',
        '#sysprompt_content', '#sysprompt_post_history', '#context_story_string', '#context_story_string_position',
        '#context_story_string_depth', '#context_story_string_role', '#context_example_separator', '#context_chat_start',
        '#impersonation_prompt_textarea', '#wi_format_textarea', '#scenario_format_textarea', '#personality_format_textarea',
        '#group_nudge_prompt_textarea', '#newchat_prompt_textarea', '#newgroupchat_prompt_textarea',
        '#newexamplechat_prompt_textarea', '#continue_nudge_prompt_textarea', '#send_if_empty_textarea',
        '#reasoning_select', '#reasoning_prefix', '#reasoning_suffix', '#reasoning_separator',
    ];
    await openPanel(page, 'prompting');
    await page.evaluate(selectors => { window.phase45Nodes = selectors.map(selector => document.querySelector(selector)); }, uniqueSelectors);
    for (const api of ['openai', 'textgenerationwebui', 'kobold', 'koboldhorde', 'novel', 'openai', 'textgenerationwebui']) {
        await selectBackend(page, api, api === 'openai' ? 'openrouter' : 'mancer');
        const prompting = await openPanel(page, 'prompting');
        await expect(prompting.locator('[name="startReplyWithBlock"]')).toHaveCount(0);
        await expect(page.locator('#AdvancedFormatting #sb-af-reply-prefix [name="startReplyWithBlock"]')).toHaveCount(1);
        for (const selector of uniqueSelectors) {
            await expect.poll(() => page.locator(selector).count()).toBe(1);
        }
        expect(await page.evaluate(selectors => window.phase45Nodes.every((node, index) => node === document.querySelector(selectors[index])), uniqueSelectors)).toBe(true);
        const editor = await openPanel(page, 'editor');
        await expect(editor.locator('#completion_prompt_manager, #InstructSequencesColumn, #sysprompt_content, #context_story_string')).toHaveCount(4);
        await expect(prompting.locator('#reasoning_select, #reasoning_prefix, #reasoning_suffix, #reasoning_separator')).toHaveCount(4);
        for (const id of ['main_prompt_quick_edit_textarea', 'nsfw_prompt_quick_edit_textarea', 'jailbreak_prompt_quick_edit_textarea']) {
            await expect(page.locator(`#${id}`)).toHaveCount(1);
            await expect(page.locator(`#${id}`)).toBeHidden();
        }
        await openPanel(page, 'prompting');
        if (api === 'openai') {
            await expect(prompting.locator('#sb-openai-prefill [name="startReplyWithBlock"]')).toHaveCount(0);
            await expect(prompting.locator('#sb-tc-sysprompt')).toBeHidden();
        } else if (api === 'textgenerationwebui') {
            await expect(prompting.locator('#common-gen-settings-block #n_textgenerationwebui')).toBeVisible();
            const sampling = await openPanel(page, 'sampling');
            await expect(sampling.locator('#n_textgenerationwebui')).toHaveCount(0);
        }
    }

    await selectBackend(page, 'openai', 'openrouter');
    const formatting = await openPanel(page, 'context');
    await expect(page.locator('[data-sb-settings-tab="context"]')).toContainText('Formatting');
    await expect(formatting.locator('.sb-formatting-group:visible').locator(BACKEND_CATEGORY_TITLE)).toHaveText([
        'Stopping Strings', 'Reply Prefix', 'Text Cleanup', 'Reasoning', 'Rendering',
    ]);
    await expect(formatting.locator('#sb-af-reply-prefix [name="startReplyWithBlock"]')).toBeVisible();
    await expect(formatting.locator('#advanced-formatting-cc-notice')).toBeHidden();
    await expect(formatting.locator('#reasoning_select, #reasoning_prefix, #reasoning_suffix, #reasoning_separator')).toHaveCount(0);
    await expect(formatting.locator('#reasoning_auto_parse, #reasoning_auto_expand, #reasoning_show_hidden, #reasoning_add_to_prompts, #reasoning_max_additions')).toHaveCount(5);

    await selectBackend(page, 'textgenerationwebui', 'ooba');
    const textFormatting = await openPanel(page, 'context');
    await expect(textFormatting.locator('.sb-formatting-group:visible').locator(BACKEND_CATEGORY_TITLE)).toHaveText([
        'Tokenizer & Padding', 'Stopping Strings', 'Reply Prefix', 'Text Cleanup', 'Reasoning', 'Rendering',
    ]);
});

test('Backend tabs, aliases and Presets/Editor links are stable in every mode', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    for (const api of ['openai', 'textgenerationwebui', 'kobold', 'koboldhorde', 'novel']) {
        await selectBackend(page, api);
        const presets = await openPanel(page, 'prompting');
        await expect(page.locator('#sb-settings-tab-list button')).toHaveText(['Connections', 'Sampling', 'Presets', 'Editor', 'Formatting', 'Agents']);
        await expect(page.locator('[data-sb-settings-tab="prompting"]')).toHaveAttribute('data-sb-search-aliases', 'Prompting|Presets');
        await expect(page.locator('[data-sb-settings-tab="editor"]')).toHaveAttribute('data-sb-search-aliases', 'Prompt Manager|Prompts');
        const edit = presets.getByRole('button', { name: 'Edit prompts', exact: true });
        expect(await edit.evaluate(button => button.previousElementSibling?.id)).toBe('respective-presets-block');
        await edit.focus();
        await page.keyboard.press('Enter');
        const editor = page.locator('[data-sb-panel="editor"]');
        await expect(editor).toHaveAttribute('aria-hidden', 'false');
        await expect(editor.locator('[data-sb-editor-preset]')).not.toHaveText('');
        await expect(editor.locator('.sb-backend-disclaimer')).toHaveCount(0);
        await editor.getByRole('button', { name: 'Presets', exact: true }).click();
        await expect(presets).toHaveAttribute('aria-hidden', 'false');
    }
    await page.locator('#sb-settings-search-toggle').click();
    const search = page.locator('#sb-settings-search-input');
    for (const [query, tab] of [['Prompting', 'prompting'], ['Prompt Manager', 'editor'], ['Prompts', 'editor']]) {
        await search.fill(query);
        await expect(page.locator(`[data-sb-settings-tab="${tab}"]`)).not.toHaveClass(/sb-settings-tab--filtered/);
    }
});

test('Backend category search returns one title and retains subtitle matches', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    await selectBackend(page, 'textgenerationwebui', 'ooba');
    const sampling = await openPanel(page, 'sampling');
    for (const query of ['Token Control', 'minimum length streaming speed limits']) {
        await page.evaluate(() => window.SillyBunnyShell.openGlobalSearch());
        await page.locator('#sb-universal-search input').fill(query);
        const result = page.getByRole('group', { name: 'Backend · Sampling', exact: true })
            .getByRole('option', { name: /^Token Control\b/ });
        await expect(result).toHaveCount(1);
        await result.click();
        await expect(sampling.locator('.sb-sampling-section:visible [data-sb-sampling-group="tokens"] .sb-settings-category-title')).toBeInViewport();
    }

    await selectBackend(page, 'openai', 'openrouter');
    const prompting = await openPanel(page, 'prompting');
    for (const query of ['Reply Prefill', 'adjust continuation prefill']) {
        await page.evaluate(() => window.SillyBunnyShell.openGlobalSearch());
        await page.locator('#sb-universal-search input').fill(query);
        const result = page.getByRole('group', { name: 'Backend · Presets', exact: true })
            .getByRole('option', { name: 'Reply Prefill Jump to setting', exact: true });
        await expect(result).toHaveCount(1);
        await result.click();
        await expect(prompting.locator('#sb-openai-prefill .sb-settings-category-title')).toBeInViewport();
    }
});

test('Legacy Backend shortcuts resolve to current routes', async ({ page, baseURL }) => {
    await page.addInitScript(() => {
        localStorage.setItem('sb-shortcut-left', 'left:presets');
        localStorage.setItem('sb-shortcut-right', 'left:api');
        localStorage.setItem('sb-shortcut-slot3', 'left:advanced-formatting');
    });
    await loadSettings(page, baseURL);
    for (const [side, tab] of [['left', 'prompting'], ['right', 'connections'], ['slot3', 'context']]) {
        await page.locator(`#sb-shortcut-${side}`).evaluate(button => button.click());
        await expect(page.locator(`[data-sb-panel="${tab}"]`)).toHaveAttribute('aria-hidden', 'false');
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
    // Samplers stay visible for every provider; non-sampler rows keep provider gating.
    await expect(sampling.locator('[data-sb-sampling-control="#top_k_openai"]')).toBeVisible();
    await expect(sampling.locator('[data-sb-sampling-control="#openai_logit_bias_preset"]')).toBeVisible();
    await selectBackend(page, 'openai', 'claude');
    await expect(sampling.locator('[data-sb-sampling-control="#top_k_openai"]')).toBeVisible();
    await expect(sampling.locator('[data-sb-sampling-control="#openai_logit_bias_preset"]')).toBeHidden();
    await selectBackend(page, 'openai', 'openrouter');
    await expect(sampling.locator('[data-sb-sampling-control="#top_k_openai"]')).toBeVisible();
    await sampling.locator('#temp_counter_openai').fill('0.73');
    await sampling.locator('#temp_counter_openai').press('Enter');
    await expect(sampling.locator('#temp_openai')).toHaveValue('0.73');
    const temperature = sampling.locator('[data-sb-sampling-control="#temp_openai"]');
    await temperature.getByRole('radio', { name: 'Omit', exact: true }).click();
    await expect(temperature.getByRole('radio', { name: 'Omit', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(sampling.locator('#sb-sampling-openai [data-sb-sampling-control]').first()).toHaveAttribute('data-sb-sampler-id', 'sampler_toolbar');
    await sampling.locator('.sb-neutralize-chat-samplers').click();
    await expect(sampling.locator('#temp_openai')).toHaveValue('1');
    await expect(sampling.locator('#top_p_openai')).toHaveValue('1');
    const prompting = await openPanel(page, 'prompting');
    await expect(prompting.locator('#settings_preset_openai')).toBeVisible();
    await expect(prompting.locator('#import_oai_preset, #export_oai_preset, #update_oai_preset, #new_oai_preset, #delete_oai_preset')).toHaveCount(5);
    expect(await page.evaluate(() => window.phase3Nodes.every(node => node === document.getElementById(node.id)))).toBe(true);
});

async function readSamplingRegistryLayout(page) {
    return page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.sb-sampling-section')].map(section => [
        section.id.replace('sb-sampling-', ''),
        [...section.querySelectorAll('[data-sb-sampling-control]')].map(card => ({
            id: card.dataset.sbSamplerId,
            group: card.closest('[data-sb-sampling-group]').dataset.sbSamplingGroup,
            selector: card.dataset.sbSamplingControl,
            className: card.className,
        })),
    ])));
}

test('Sampling uses one registry order, grouping and styling for every backend', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    await selectBackend(page, 'kobold', null);
    await openPanel(page, 'sampling');
    const layout = await readSamplingRegistryLayout(page);
    const selectors = Object.values(layout).flat().map(card => card.selector);
    expect(selectors.filter((selector, index) => selectors.indexOf(selector) !== index)).toEqual([]);
    expect(Object.values(layout).flat().every(card => card.id)).toBe(true);
    await expect(page.locator('.sb-sampling-group[data-sb-sampling-group="presets"]')).toHaveCount(0);

    const tcOrder = layout.textgenerationwebui.map(card => card.id);
    for (const backend of ['openai', 'kobold', 'novel']) {
        const shared = layout[backend].filter(card => tcOrder.includes(card.id));
        expect(shared.map(card => card.id), `${backend} follows the Text Completions order`)
            .toEqual(tcOrder.filter(id => shared.some(card => card.id === id)).filter((id, index, ids) => ids.indexOf(id) === index));
        for (const card of shared) {
            const tc = layout.textgenerationwebui.find(entry => entry.id === card.id);
            expect(card.group, `${backend} ${card.id} group`).toBe(tc.group);
            const shape = className => ['ds-row-expander', 'sb-sampling-large-card'].filter(token => className.split(' ').includes(token));
            expect(shape(card.className), `${backend} ${card.id} styling`).toEqual(shape(tc.className));
        }
    }

    expect(layout.kobold.map(card => card.id)).toEqual([
        'temperature', 'top_k', 'top_p', 'typical_p', 'min_p', 'top_a', 'tfs',
        'repetition_penalty', 'rep_pen_range', 'rep_pen_slope',
        'mirostat', 'seed', 'sampler_order', 'use_default_badwordsids', 'grammar',
    ]);
    const kobold = page.locator('#sb-sampling-kobold');
    for (const id of ['top_k', 'typical_p', 'min_p', 'top_a', 'tfs', 'rep_pen_range', 'rep_pen_slope', 'mirostat', 'seed', 'sampler_order', 'grammar']) {
        await expect(kobold.locator(`[data-sb-sampler-id="${id}"]`)).toBeVisible();
    }
    await expect(kobold.locator('[data-sb-sampler-id="mirostat"] .ds-row-subtitle').first()).not.toHaveText('lorum ipsum');
    await expect(page.locator('#sb-sampling-kobold .sb-sampling-header-note')).toHaveText('Some backends ignore samplers they do not support.');
});

test('Text Completions types keep sampler rows visible and swap only backend mechanisms', async ({ page, baseURL }) => {
    test.setTimeout(120000);
    await loadSettings(page, baseURL);
    await selectBackend(page, 'textgenerationwebui', 'ooba');
    const sampling = await openPanel(page, 'sampling');
    const card = selector => sampling.locator(`[data-sb-sampling-control="${selector}"]`);
    const samplerRows = ['#top_k_textgenerationwebui', '#typical_p_textgenerationwebui', '#tfs_textgenerationwebui', '#epsilon_cutoff_textgenerationwebui', '#nsigma_textgenerationwebui', '#rep_pen_decay_textgenerationwebui', '#smoothingBlock', '#xtc_block', '#dryBlock', '#mirostat_block_ooba', '#seed_textgenerationwebui'];
    const mechanisms = {
        ooba: { visible: ['#sampler_priority_block_ooba'], hidden: ['#sampler_order_block_kcpp', '#sampler_order_block_lcpp', '#json_schema_block'] },
        llamacpp: { visible: ['#sampler_order_block_lcpp', '#json_schema_block'], hidden: ['#sampler_priority_block_ooba', '#sampler_order_block_kcpp', '#beamSearchBlock'] },
        koboldcpp: { visible: ['#sampler_order_block_kcpp'], hidden: ['#sampler_order_block_lcpp', '#sampler_priority_block_ooba', '#json_schema_block'] },
    };
    for (const [type, { visible, hidden }] of Object.entries(mechanisms)) {
        await selectBackend(page, 'textgenerationwebui', type);
        for (const selector of samplerRows) await expect(card(selector), `${type} ${selector}`).toBeVisible();
        for (const selector of visible) await expect(card(selector), `${type} ${selector}`).toBeVisible();
        for (const selector of hidden) await expect(card(selector), `${type} ${selector}`).toBeHidden();
    }

    await page.evaluate(async () => {
        const { setApiSamplerVisibilityState } = await import('/scripts/samplerSelect.js');
        setApiSamplerVisibilityState({ st_manual_priority: true, temp: true }, 'ooba');
    });
    await selectBackend(page, 'textgenerationwebui', 'ooba');
    await expect(card('#temp_textgenerationwebui')).toBeVisible();
    await expect(card('#top_k_textgenerationwebui')).toBeHidden();
    await expect(card('#dryBlock')).toBeHidden();
    await page.evaluate(async () => {
        const { setApiSamplerVisibilityState } = await import('/scripts/samplerSelect.js');
        setApiSamplerVisibilityState({}, 'ooba');
    });
    await selectBackend(page, 'textgenerationwebui', 'llamacpp');
    await expect(card('#top_k_textgenerationwebui')).toBeVisible();
});

test('Text Completions templates use the shared editor and guard backend and preset changes', async ({ page, baseURL }) => {
    test.setTimeout(120000);
    await loadSettings(page, baseURL);
    await selectBackend(page, 'textgenerationwebui', 'ooba');
    const alternatePreset = await page.evaluate(async () => {
        const { getPresetManager } = await import('/scripts/preset-manager.js');
        const manager = getPresetManager('instruct');
        const selected = manager.getSelectedPresetName();
        const current = structuredClone(manager.getPresetSettings(selected));
        const name = 'SB Prompt Editor Guard';
        manager.updateList(name, { ...current, name, input_sequence: 'alternate preset value' });
        await manager.selectPreset(manager.findPreset(selected));
        return { selected, alternate: name };
    });

    const editor = await openPanel(page, 'editor');
    await expect(editor.locator('.sb-prompt-section:visible h3')).toHaveText(['System prompt', 'Context', 'Instruct']);
    await expect(editor.getByRole('button', { name: 'Add prompt', exact: true })).toBeHidden();
    await expect(editor.getByRole('button', { name: 'Prompt list actions', exact: true })).toBeHidden();
    await expect(editor.locator('.sb-prompt-tc-system input[type="checkbox"], .sb-prompt-tc-instruct input[type="checkbox"]')).toHaveCount(0);
    for (const id of ['sb-editor-sysprompt', 'sb-editor-instruct', 'sb-editor-context']) {
        await expect(editor.locator(`#${id}`)).toBeHidden();
    }
    await editor.locator('[data-prompt-id="tc-user"] .sb-prompt-row-name').click();
    const detail = editor.locator('.sb-prompt-detail');
    const fields = detail.locator('.sb-prompt-tc-textarea');
    await expect(fields).toHaveCount(4);
    const originalPrefix = await page.locator('#instruct_input_sequence').inputValue();
    await expect.poll(() => fields.evaluateAll(nodes => {
        const heights = nodes.map(node => node.getBoundingClientRect().height);
        return Math.max(...heights) - Math.min(...heights);
    })).toBeLessThanOrEqual(1);
    await fields.first().fill('Unsaved TC draft');
    await expect(page.locator('#instruct_input_sequence')).toHaveValue(originalPrefix);

    const dispatchChange = async (selector, value) => page.evaluate(({ selector, value }) => {
        const control = document.querySelector(selector);
        control.value = value;
        control.dispatchEvent(new Event('change', { bubbles: true }));
    }, { selector, value });
    const dialog = page.locator('dialog.popup[open]');

    await dispatchChange('#main_api', 'openai');
    await expect(dialog).toBeVisible();
    await dialog.locator('.popup-button-cancel').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#main_api')).toHaveValue('textgenerationwebui');
    await expect(detail.locator('.sb-prompt-tc-textarea').first()).toHaveValue('Unsaved TC draft');

    await dispatchChange('#main_api', 'openai');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#main_api')).toHaveValue('openai');
    await expect(page.locator('#instruct_input_sequence')).toHaveValue(originalPrefix);
    await expect(editor.locator('.sb-prompt-detail')).toBeHidden();
    await dispatchChange('#main_api', 'textgenerationwebui');
    await expect(editor.locator('.sb-prompt-list-titles h2')).toHaveText('Prompt templates');

    await editor.locator('[data-prompt-id="tc-user"] .sb-prompt-row-name').click();
    await fields.first().fill('Saved before preset switch');
    for (const id of ['sysprompt_select', 'instruct_presets', 'context_presets']) {
        const select = page.locator(`#${id}`);
        const previousValue = await select.inputValue();
        const nextValue = await select.locator('option').evaluateAll((options, previous) => options.find(option => option.value !== previous)?.value, previousValue);
        expect(nextValue).toBeTruthy();
        await dispatchChange(`#${id}`, nextValue);
        await expect(dialog).toBeVisible();
        await dialog.locator('.popup-button-cancel').click();
        await expect(dialog).toBeHidden();
        await expect(select).toHaveValue(previousValue);
        await expect(fields.first()).toHaveValue('Saved before preset switch');
    }
    const alternateValue = await page.locator('#instruct_presets option').evaluateAll(options => options.find(option => option.textContent === 'SB Prompt Editor Guard')?.value);
    expect(alternateValue).toBeTruthy();
    await dispatchChange('#instruct_presets', alternateValue);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toContainText('You have unsaved changes to this template. Discard them?');
    await dialog.getByRole('button', { name: 'Yes', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#instruct_presets option:checked')).toHaveText('SB Prompt Editor Guard');
    await expect(editor.locator('.sb-prompt-detail')).toBeHidden();

    const originalPresetValue = await page.locator('#instruct_presets option').evaluateAll((options, selected) => options.find(option => option.textContent === selected)?.value, alternatePreset.selected);
    expect(originalPresetValue).toBeTruthy();
    await editor.locator('[data-prompt-id="tc-user"] .sb-prompt-row-name').click();
    await fields.first().fill('Discarded before preset switch');
    await dispatchChange('#instruct_presets', originalPresetValue);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#instruct_presets')).toHaveValue(originalPresetValue);
    await expect(page.locator('#instruct_input_sequence')).toHaveValue(originalPrefix);
    await editor.locator('[data-prompt-id="tc-user"] .sb-prompt-row-name').click();
    await fields.first().fill('Saved before backend switch');
    await dispatchChange('#main_api', 'openai');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#main_api')).toHaveValue('openai');
    await expect(page.locator('#instruct_input_sequence')).toHaveValue('Saved before backend switch');
    await dispatchChange('#main_api', 'textgenerationwebui');
    await expect(editor.locator('.sb-prompt-list-titles h2')).toHaveText('Prompt templates');
    await editor.locator('[data-prompt-id="context_story_string"] .sb-prompt-row-name').click();
    await expect(detail.locator('.sb-prompt-tc-properties select')).toHaveCount(2);
    await expect(detail.locator('.sb-prompt-tc-properties input[type="number"]')).toHaveCount(1);
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

test('Chat Completions lists Text Completions-only samplers as inert rows in the shared order', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    const placeholderIds = [
        'typical_p', 'tfs', 'epsilon_cutoff', 'eta_cutoff', 'nsigma', 'min_keep', 'skew',
        'rep_pen_range', 'rep_pen_slope', 'rep_pen_decay', 'encoder_rep_pen', 'no_repeat_ngram',
        'adaptive_p', 'smoothing', 'xtc', 'dry', 'dynatemp', 'mirostat',
    ];
    const readCards = section => page.locator(`#sb-sampling-${section}`).evaluate(root => [...root.querySelectorAll('[data-sb-sampling-control], [data-sb-sampling-placeholder]')].map(card => ({
        id: card.dataset.sbSamplerId,
        group: card.closest('[data-sb-sampling-group]').dataset.sbSamplingGroup,
        placeholder: card.hasAttribute('data-sb-sampling-placeholder'),
        label: (card.querySelector(':scope > summary .ds-row-label') ?? card.querySelector('.ds-row-label'))?.textContent.replace(/\s+/g, ' ').trim(),
    })));

    for (const source of ['openai', 'custom', 'openrouter']) {
        await selectBackend(page, 'openai', source);
        const sampling = await openPanel(page, 'sampling');
        const cc = sampling.locator('#sb-sampling-openai');
        for (const id of placeholderIds) {
            const row = cc.locator(`[data-sb-sampling-placeholder][data-sb-sampler-id="${id}"]`);
            await expect(row, `${source} ${id}`).toBeVisible();
            await expect(row.locator('input, select, textarea, button, summary')).toHaveCount(0);
            await expect(row.locator('.ds-row-subtitle')).toHaveText('Not available in Chat Completions. Custom endpoints can send it with Additional Parameters.');
            await expect(row.locator('.sb-sampling-unavailable-badge')).toHaveText('Unavailable');
        }
        await expect(cc.locator('[data-sb-sampling-placeholder]')).toHaveCount(placeholderIds.length);
        await expect(cc.locator('[data-sb-sampling-group="algorithms"]')).toBeVisible();
        // Placeholders never borrow Text Completions controls.
        await expect(cc.locator('[id$="_textgenerationwebui"], #dryBlock, #xtc_block, #smoothingBlock')).toHaveCount(0);
        await expect(cc.locator('[data-sb-sampler-id="sampler_priority"], [data-sb-sampler-id="json_schema"], [data-sb-sampler-id="beam_search"]')).toHaveCount(0);
    }

    const cc = await readCards('openai');
    const tc = await readCards('textgenerationwebui');
    const ccIds = cc.map(card => card.id);
    expect(ccIds.filter((id, index) => ccIds.indexOf(id) !== index)).toEqual([]);
    expect(ccIds).toEqual(tc.map(card => card.id).filter(id => ccIds.includes(id)).filter((id, index, ids) => ids.indexOf(id) === index));
    for (const card of cc.filter(entry => entry.placeholder)) {
        const source = tc.find(entry => entry.id === card.id);
        expect(card.group, `${card.id} group`).toBe(source.group);
        expect(card.label, `${card.id} label`).toBe(source.label);
    }
    for (const section of ['textgenerationwebui', 'kobold', 'novel']) {
        await expect(page.locator(`#sb-sampling-${section} [data-sb-sampling-placeholder]`)).toHaveCount(0);
    }
});

test('Mobile Sampling follows provider and manual sampler visibility', async ({ page, baseURL }) => {
    // Multiple backend switches follow app startup.
    test.slow();
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
        const samplingPanel = await openPanel(page, 'sampling');
        await expect(samplingPanel.locator(api === 'openai' ? '#temp_openai' : '#temp_textgenerationwebui')).toHaveValue('0.62');
        await expect(samplingPanel.locator(api === 'openai' ? '#top_p_openai' : '#top_p_textgenerationwebui')).toHaveValue('0.87');
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

test('Universal search reaches Extensions detail pages after the list is built', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    // Activating the tab moves every extension section into the hidden subpage store.
    const extensions = await openPanel(page, 'extensions', 'right');
    await expect.poll(() => extensions.locator('.sb-subpage-row').count()).toBeGreaterThan(0);
    const jumpTo = async (query, option = /^Summarize Trigger a summary update/) => {
        await page.evaluate(() => window.SillyBunnyShell.openGlobalSearch());
        await page.locator('#sb-universal-search input').fill(query);
        const result = page.getByRole('group', { name: 'Customize · Extensions', exact: true })
            .getByRole('option', { name: option });
        await expect(result).toHaveCount(1);
        await result.click();
    };
    await jumpTo('summarize now');
    await expect(extensions.locator('.sb-subpage-detail')).toHaveAttribute('aria-hidden', 'false');
    await expect(extensions.locator('.sb-subpage-detail-content')).toHaveAttribute('id', 'summarize_container');
    await expect(page.locator('#memory_force_summarize')).toBeInViewport();
    // The store keeps every other section out of the layout; a stored section that still lays out
    // puts a second, stale copy of the menu under the list.
    await expect.poll(() => extensions.locator('.sb-shell-panel-scroller').evaluate(scroller => scroller.scrollHeight - scroller.clientHeight)).toBeLessThan(200);
    await expect(extensions.locator('.sb-subpage-store #tts_container')).toBeHidden();
    // The list page's own chrome is presented by the stack, so it is searchable too.
    await jumpTo('manage extensions', /^Manage extensions/);
    await expect(extensions.locator('.sb-subpage-detail')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('#extensions_details')).toBeInViewport();
    await jumpTo('summarize now');
    // A second jump into the page already on screen must not lose the section when it closes.
    await jumpTo('summarize now');
    await expect(extensions.locator('.sb-subpage-detail-content')).toHaveAttribute('id', 'summarize_container');
    await extensions.locator('.sb-subpage-back').click();
    await expect(extensions.locator('.sb-subpage-detail')).toHaveAttribute('aria-hidden', 'true');
    await expect(extensions.locator('.sb-subpage-store #summarize_container')).toHaveCount(1);
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
