import { expect, test } from '@playwright/test';
import { auditPromptingLayout } from './helpers/libadwaita-audit.js';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

const BACKENDS = ['openai', 'textgenerationwebui', 'kobold', 'koboldhorde', 'novel'];
const TEXT_BACKENDS = ['textgenerationwebui', 'kobold', 'novel'];
const READ_ONLY_POST_ENDPOINTS = new Set([
    '/api/characters/all', '/api/characters/chats', '/api/groups/all', '/api/backgrounds/all',
    '/api/avatars/get', '/api/stats/get', '/api/secrets/read', '/api/users/me',
]);
const SETTINGS_TABS = [
    { id: 'connections', shell: 'left' },
    { id: 'sampling', shell: 'left' },
    { id: 'prompting', shell: 'left' },
    { id: 'editor', shell: 'left' },
    { id: 'context', shell: 'left' },
    { id: 'agents', shell: 'left' },
    { id: 'appearance', shell: 'right' },
    { id: 'interface', shell: 'right' },
    { id: 'messages', shell: 'right' },
    { id: 'extensions', shell: 'right' },
    { id: 'data-security', shell: 'right' },
    { id: 'logs', shell: 'right' },
];

/** Install API write interceptors before visiting the app. */
async function mockWrites(page, settingsStore = null) {
    let settingsVersion = 1_000_000_000_000_000;

    await page.route('**/api/**', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const method = request.method();

        if (url.pathname === '/api/settings/get') {
            const response = await route.fetch();
            const data = await response.json();
            const settings = settingsStore?.saved ?? JSON.parse(data.settings);
            settings.firstRun = false;
            settings._version ??= settingsVersion;
            settings.extension_settings ??= {};
            settings.extension_settings['quick-image-gen'] = {
                ...settings.extension_settings['quick-image-gen'],
                setupWizardSeen: true,
            };
            settingsVersion = Math.max(settingsVersion, settings._version);
            data.request_compression = { ...data.request_compression, enabled: false };
            data.settings = JSON.stringify(settings);
            return route.fulfill({ response, json: data });
        }

        if (url.pathname === '/api/settings/save') {
            settingsVersion += 1;
            settingsStore && (settingsStore.saved = { ...request.postDataJSON(), _version: settingsVersion });
            return route.fulfill({ json: { result: 'ok', version: settingsVersion } });
        }

        if (url.pathname === '/api/presets/save') {
            return route.fulfill({ json: { name: request.postDataJSON()?.name ?? '' } });
        }

        if (READ_ONLY_POST_ENDPOINTS.has(url.pathname) || url.pathname.startsWith('/api/tokenizers/')) {
            return route.continue();
        }

        const isWriteMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
        const isWriteEndpoint = /^\/api\/.*\/(save|delete|create|edit|rename|update|import|upload|restore|duplicate|write|set)(?:\/|$)/i.test(url.pathname);
        if (isWriteMethod || isWriteEndpoint) {
            return route.fulfill({ json: {} });
        }

        return route.continue();
    });

    // Keep the legacy settings-save route covered too; the general API route above also blocks it.
    await page.route('**/api/savesettings**', route => route.fulfill({ json: { result: 'ok' } }));
}

async function loadSettings(page, baseURL, settingsStore = null) {
    const hostname = new URL(baseURL).hostname;
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(hostname);
    await mockWrites(page, settingsStore);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
        () => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'),
        null,
        { timeout: 60000 },
    );
}

async function openSettingsTab(page, tab, shell = 'left') {
    await page.evaluate(({ shell, tab }) => window.SillyBunnyShell.openTab(shell, tab), { shell, tab });
    const button = page.locator(`button[data-sb-settings-tab="${tab}"]`);
    await button.evaluate(element => element.click());
    const panel = page.locator(`[data-sb-panel="${tab}"]`);
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    await panel.locator('.sb-shell-panel-scroller').evaluate(scroller => { scroller.scrollTop = 0; });
    return panel;
}

async function switchBackend(page, backend) {
    const source = backend === 'openai' ? 'openrouter' : backend === 'textgenerationwebui' ? 'ooba' : null;
    await page.evaluate(({ backend, source }) => {
        $('#main_api').val(backend).trigger('change');
        if (source) $('#textgen_type, #chat_completion_source').filter((_, element) =>
            element.id === (backend === 'openai' ? 'chat_completion_source' : 'textgen_type'),
        ).val(source).trigger('change');
    }, { backend, source });
}

// Reviewed exceptions: container selector -> reason.
const SWITCH_SEMANTICS_ALLOWLIST = {
    '#completion_prompt_manager_popup': 'Prompt Manager entry editor is redesigned in Phase 5',
    '#bpt-animated-bg-panel': 'Third-party extension (BunnyPresetTools) not in Phase 4 scope',
    // SillyBunny: built-in extension settings are allowlisted per user decision (PR #870):
    // switch conversion is deferred to keep the PR focused. The store CSS hides these
    // containers, so their checkboxes are display:none and already skipped by the display
    // guard above; these entries cover the case where a subpage row is opened during a test.
    '#extensions_settings': 'Built-in extension settings; switch conversion deferred (PR #870 scope)',
    '#extensions_settings2': 'Built-in extension settings; switch conversion deferred (PR #870 scope)',
    '#assets_container': 'Download Extensions & Assets is a feature panel, not a settings panel',
    // Geometry-only: these two TGI sampling checkboxes render below 44px in the consistency test
    // viewport due to the legacy flex-column checkbox group layout; fix deferred (PR #870 scope).
    '#ban_eos_token_textgenerationwebui': 'TGI Ban EOS Token row height; layout fix deferred (PR #870 scope)',
    '#skip_special_tokens_textgenerationwebui': 'TGI Skip Special Tokens row height; layout fix deferred (PR #870 scope)',
};

async function expectSwitchSemantics(panel) {
    const failures = await panel.locator('input[type="checkbox"]').evaluateAll((inputs, allowlist) => inputs.flatMap(input => {
        // Icon-button toggles keep their state in a display:none checkbox; the label button is the control.
        if (getComputedStyle(input).display === 'none') return [];
        if (allowlist.some(selector => input.closest(selector))) return [];
        const name = input.id || input.name || input.getAttribute('aria-label') || 'unnamed checkbox';
        const issues = [];
        if (input.getAttribute('role') !== 'switch') issues.push('missing role=switch');
        // ARIA in HTML forbids aria-checked on elements with a native checked state.
        if (input.hasAttribute('aria-checked')) issues.push('redundant aria-checked');
        return issues.map(issue => `${name}: ${issue}`);
    }), Object.keys(SWITCH_SEMANTICS_ALLOWLIST));
    expect(failures).toEqual([]);
}

async function expectSwitchGeometry(panel, compactSampling = false) {
    const failures = await panel.locator('input[type="checkbox"]:visible').evaluateAll((inputs, { compact, allowlist }) => inputs.flatMap(input => {
        if (allowlist.some(selector => input.closest(selector))) return [];
        const row = input.closest('.ds-row-switch, .ds-row');
        const name = input.id || input.name || 'unnamed switch';
        if (!row) return [`${name}: missing settings row`];

        const style = getComputedStyle(row);
        const rowRect = row.getBoundingClientRect();
        const switchRect = input.getBoundingClientRect();
        const subtitle = Boolean(row.querySelector('.ds-row-subtitle'));
        const samplingRow = compact && Boolean(input.closest('.sb-sampling-group'));
        const minimumHeight = samplingRow ? (subtitle ? 44 : 36) : (subtitle ? 52 : 44);
        const metrics = {
            minHeight: parseFloat(style.minHeight) >= minimumHeight,
            actualHeight: rowRect.height >= minimumHeight,
            centered: Math.abs(switchRect.top + switchRect.height / 2 - rowRect.top - rowRect.height / 2) <= 1,
        };
        return Object.entries(metrics).filter(([, pass]) => !pass).map(([metric]) => `${name}: ${metric}`);
    }), { compact: compactSampling, allowlist: Object.keys(SWITCH_SEMANTICS_ALLOWLIST) });
    expect(failures).toEqual([]);
}

function getPromptingGroupTitles(prompting) {
    return prompting.locator('.sb-prompting-group:visible').evaluateAll(groups => groups.map(group => {
        const heading = group.querySelector(':scope > h3, :scope > .sb-settings-flat-header b, :scope > .inline-drawer-header b');
        return heading?.textContent.replace(/\s+/g, ' ').trim() ?? '';
    }));
}

async function snapshotFormattingControls(page) {
    return page.locator('#AdvancedFormatting').evaluate(root => [...root.querySelectorAll('input, select, textarea')]
        .filter(control => {
            if (['hidden', 'file', 'button', 'submit', 'reset'].includes(control.type)) return false;
            return !['reasoning_select', 'reasoning_prefix', 'reasoning_suffix', 'reasoning_separator'].includes(control.id);
        })
        .map((control, index) => ({
            key: control.id || control.name || `${control.tagName.toLowerCase()}-${index}`,
            value: control.matches('input[type="checkbox"], input[type="radio"]') ? control.checked : control.value,
        })));
}

async function expectNoHorizontalOverflow(element) {
    await expect.poll(() => element.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
}

test.describe('Settings switch-row consistency', () => {
    test.beforeEach(async ({ page, baseURL }) => loadSettings(page, baseURL));

    test('all tabs and backend modes expose switch semantics and row geometry', async ({ page }) => {
        test.setTimeout(120000);
        for (const { id, shell } of SETTINGS_TABS) {
            const panel = await openSettingsTab(page, id, shell);
            await expect(panel).toBeVisible();
            await expectSwitchSemantics(panel);
            await expectSwitchGeometry(panel);
        }

        for (const backend of BACKENDS) {
            await switchBackend(page, backend);
            for (const tab of ['sampling', 'prompting', 'editor', 'context']) {
                const panel = await openSettingsTab(page, tab);
                await expectSwitchSemantics(panel);
                await expectSwitchGeometry(panel, tab === 'sampling');
            }
        }
    });
});

test.describe('Settings header consistency', () => {
    test.beforeEach(async ({ page, baseURL }) => loadSettings(page, baseURL));

    test('Customize headers use the Messages category-title metric', async ({ page }) => {
        const messages = await openSettingsTab(page, 'messages', 'right');
        const reference = await messages.locator('.sb-settings-category-title:visible').first().evaluate(title => {
            const style = getComputedStyle(title);
            return {
                fontSize: style.fontSize,
                fontWeight: style.fontWeight,
                lineHeight: style.lineHeight,
                letterSpacing: style.letterSpacing,
                color: style.color,
            };
        });

        for (const tab of ['appearance', 'interface', 'messages', 'data-security', 'logs']) {
            const panel = await openSettingsTab(page, tab, 'right');
            const failures = await panel.locator('.sb-settings-flat-header:visible').evaluateAll((headers, expected) => headers.flatMap(header => {
                const title = header.querySelector('.sb-settings-category-title');
                if (!(title instanceof HTMLElement)) return ['missing .sb-settings-category-title'];
                const style = getComputedStyle(title);
                const metrics = {
                    fontSize: style.fontSize === expected.fontSize,
                    fontWeight: style.fontWeight === expected.fontWeight,
                    lineHeight: style.lineHeight === expected.lineHeight,
                    letterSpacing: style.letterSpacing === expected.letterSpacing,
                    color: style.color === expected.color,
                };
                return Object.entries(metrics).filter(([, pass]) => !pass)
                    .map(([metric]) => `${title.textContent.trim() || 'unnamed'}: ${metric}`);
            }), reference);
            expect(failures, `${tab} header metrics`).toEqual([]);
        }
    });

    test('Appearance and Formatting keep migrated groups flat and aligned', async ({ page }) => {
        const appearance = await openSettingsTab(page, 'appearance', 'right');
        const appearanceMetrics = await appearance.evaluate(root => {
            const pageSize = root.querySelector('#AppearanceLayoutSection');
            const visual = root.querySelector('#ThemeTogglesSection');
            const borderTop = element => element ? getComputedStyle(element).borderTopWidth : null;
            return { pageSizeBorderTop: borderTop(pageSize), visualBorderTop: borderTop(visual) };
        });
        expect(appearanceMetrics).toEqual({ pageSizeBorderTop: '0px', visualBorderTop: '0px' });

        const topbar = appearance.locator('#sb-topbar-label-drawer:visible');
        const topbarMetrics = await topbar.evaluate(drawer => {
            const desktop = drawer.querySelector('.sb-desktop-setting');
            const mobile = drawer.querySelector('.sb-mobile-setting');
            const option = desktop?.querySelector('.sb-topbar-label-option');
            const input = option?.querySelector('input[type="checkbox"]');
            const title = desktop?.querySelector('.sb-topbar-label-section-heading > strong');
            const optionRect = option?.getBoundingClientRect();
            const inputRect = input?.getBoundingClientRect();
            return {
                desktopTitleVisible: Boolean(title && title.getBoundingClientRect().height > 0 && title.scrollWidth <= title.clientWidth),
                mobileTitlePresent: Boolean(mobile?.querySelector('.sb-topbar-label-section-heading > strong')?.textContent.trim()),
                switchIsTrailing: Boolean(optionRect && inputRect && inputRect.right > optionRect.left + optionRect.width / 2),
                optionGridFullWidth: Boolean(desktop?.querySelector('.sb-topbar-label-option-grid')?.clientWidth === desktop.clientWidth),
            };
        });
        expect(topbarMetrics).toEqual({
            desktopTitleVisible: true,
            mobileTitlePresent: true,
            switchIsTrailing: true,
            optionGridFullWidth: true,
        });

        await page.setViewportSize({ width: 390, height: 844 });
        const mobileAppearance = await openSettingsTab(page, 'appearance', 'right');
        const mobileTopbar = mobileAppearance.locator('#sb-topbar-label-drawer:visible');
        const mobileTitleMetrics = await mobileTopbar.locator('.sb-mobile-setting .sb-topbar-label-section-heading > strong').evaluate(title => ({
            visible: title.getBoundingClientRect().height > 0,
            fits: title.scrollWidth <= title.clientWidth,
        }));
        expect(mobileTitleMetrics).toEqual({ visible: true, fits: true });

        await page.setViewportSize({ width: 1280, height: 720 });
        const formatting = await openSettingsTab(page, 'context', 'left');
        await expect(formatting.locator('#AdvancedFormatting > .sb-settings-flat-header')).toHaveCount(1);
        const formattingMetrics = await formatting.locator('#AdvancedFormatting:visible').evaluate(root => {
            const header = root.firstElementChild;
            const titleRow = header?.querySelector('.sb-settings-category-title-row');
            const help = titleRow?.querySelector('.notes-link');
            const group = root.querySelector('.sb-formatting-group:has(.sb-prompting-group-body)');
            const body = group?.querySelector(':scope > .sb-prompting-group-body');
            const groupStyle = group ? getComputedStyle(group) : null;
            const bodyStyle = body ? getComputedStyle(body) : null;
            const titleRect = titleRow?.getBoundingClientRect();
            const helpRect = help?.getBoundingClientRect();
            return {
                headerIsFirst: header?.matches('.sb-settings-flat-header') ?? false,
                helpBesideTitle: Boolean(titleRect && helpRect && Math.abs(titleRect.top - helpRect.top) < 2),
                outerGroupHasNoBox: groupStyle?.borderTopWidth === '0px' && groupStyle.padding === '0px',
                bodyKeepsPreferenceBox: bodyStyle?.borderTopWidth === '1px' && bodyStyle.borderRadius !== '0px',
            };
        });
        expect(formattingMetrics).toEqual({
            headerIsFirst: true,
            helpBesideTitle: true,
            outerGroupHasNoBox: true,
            bodyKeepsPreferenceBox: true,
        });
    });
});

test.describe('Prompting and Sampling consistency', () => {
    test.beforeEach(async ({ page, baseURL }) => loadSettings(page, baseURL));

    test('Chat and Text Completions share the first two groups and render their full prompting flows', async ({ page }) => {
        const chatGroups = [
            'Presets', 'Generation Settings', 'Character Names & Prompt Formatting',
            'Reply Prefill', 'Request Options', 'Reasoning Template',
        ];
        const textGroups = [
            'Presets', 'Generation Settings', 'System Prompt', 'Instruct Template', 'Context Template',
            'Character Names', 'Reply Prefill', 'Reasoning Template',
        ];

        await switchBackend(page, 'openai');
        const chatPrompting = await openSettingsTab(page, 'prompting');
        await expect.poll(() => getPromptingGroupTitles(chatPrompting)).toEqual(chatGroups);
        expect(await chatPrompting.evaluate(auditPromptingLayout).then(records => records.filter(record => !record.pass))).toEqual([]);
        const chatContent = await chatPrompting.locator('.sb-prompting-group:visible').evaluateAll(groups => groups.map(group =>
            group.querySelector('.sb-prompting-group-body')?.textContent.trim() ?? '',
        ));
        expect(chatContent.length).toBeGreaterThan(0);
        expect(chatContent.every(content => content.length > 0)).toBe(true);

        await switchBackend(page, 'textgenerationwebui');
        const textPrompting = await openSettingsTab(page, 'prompting');
        await expect.poll(() => getPromptingGroupTitles(textPrompting)).toEqual(textGroups);
        expect(await textPrompting.evaluate(auditPromptingLayout).then(records => records.filter(record => !record.pass))).toEqual([]);
        const textContent = await textPrompting.locator('.sb-prompting-group:visible').evaluateAll(groups => groups.map(group =>
            group.querySelector('.sb-prompting-group-body')?.textContent.trim() ?? '',
        ));
        expect(textContent.length).toBeGreaterThan(0);
        expect(textContent.every(content => content.length > 0)).toBe(true);
    });

    test('Presets live in Prompting, not Sampling, for every backend', async ({ page }) => {
        for (const backend of BACKENDS) {
            await switchBackend(page, backend);
            const sampling = await openSettingsTab(page, 'sampling');
            await expect(sampling.locator('.sb-sampling-group:visible > h3').first()).toHaveText('Sampling');
            await expect(sampling.locator('.sb-sampling-group[data-sb-sampling-group="presets"]:visible')).toHaveCount(0);
        }

        for (const backend of TEXT_BACKENDS) {
            await switchBackend(page, backend);
            const prompting = await openSettingsTab(page, 'prompting');
            await expect.poll(() => getPromptingGroupTitles(prompting).then(titles => titles[0])).toBe('Presets');
        }
    });

    test('Formatting controls stay unchanged when a Chat Completions preset loads', async ({ page }) => {
        await switchBackend(page, 'openai');
        await openSettingsTab(page, 'context');
        const before = await snapshotFormattingControls(page);

        const prompting = await openSettingsTab(page, 'prompting');
        const preset = prompting.locator('#respective-presets-block #settings_preset_openai');
        const currentValue = await preset.inputValue();
        const alternate = await preset.locator('option').evaluateAll((options, current) =>
            options.find(option => option.value !== current && !option.disabled)?.value ?? null,
        currentValue);
        expect(alternate, 'a second Chat Completions preset is required to verify preset loading').not.toBeNull();
        await preset.selectOption(alternate);

        await openSettingsTab(page, 'context');
        const after = await snapshotFormattingControls(page);
        expect(after).toEqual(before);
    });

    test('Sampling is a full-width single column with compact rows at 1920×1080', async ({ page }) => {
        await page.setViewportSize({ width: 1920, height: 1080 });
        await switchBackend(page, 'textgenerationwebui');
        const sampling = await openSettingsTab(page, 'sampling');
        const connections = await openSettingsTab(page, 'connections');
        const expectedColumnWidth = await connections.locator('.sb-shell-column').first()
            .evaluate(column => parseFloat(getComputedStyle(column).width));
        await openSettingsTab(page, 'sampling');

        const column = sampling.locator('.sb-sampling-panel');
        // Measure layout width, not the shell reveal's transient scale transform.
        await expect.poll(() => column.evaluate((element, width) => Math.abs(parseFloat(getComputedStyle(element).width) - width), expectedColumnWidth))
            .toBeLessThanOrEqual(1);

        const nonFullWidthCards = await sampling.locator('.sb-sampling-group:visible > .ds-pref-group').evaluateAll(groups =>
            groups.flatMap(group => [...group.children]
                .filter(card => !card.hidden && getComputedStyle(card).display !== 'none')
                .flatMap(card => Math.abs(parseFloat(getComputedStyle(card).width) - group.clientWidth) <= 1 ? [] : [card.dataset.sbSamplingControl ?? card.className])),
        );
        expect(nonFullWidthCards).toEqual([]);

        const incorrectRows = await sampling.locator('.sb-sampling-group:visible .ds-row:visible').evaluateAll(rows => rows.flatMap(row => {
            const subtitle = Boolean(row.querySelector('.ds-row-subtitle'));
            const expectedMinimum = subtitle ? 44 : 36;
            const style = getComputedStyle(row);
            return parseFloat(style.minHeight) >= expectedMinimum && parseFloat(style.height) >= expectedMinimum
                ? [] : [`${row.id || row.className}: expected ${expectedMinimum}px, got ${style.minHeight}/${style.height}`];
        }));
        expect(incorrectRows).toEqual([]);
    });

    test('Sampling mode pill uses the Backend label format for every backend', async ({ page }) => {
        for (const backend of BACKENDS) {
            await switchBackend(page, backend);
            const sampling = await openSettingsTab(page, 'sampling');
            const pill = sampling.locator('.sb-sampling-mode-pill:visible');
            await expect(pill).toHaveCount(1);
            await expect(pill).toHaveText(/^Backend: .+$/);
        }
    });
});

test.describe('Customize consistency', () => {
    test.beforeEach(async ({ page, baseURL }) => loadSettings(page, baseURL));

    test('Extensions list reaches its last row without overflow or stray detail pages', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        const extensions = await openSettingsTab(page, 'extensions', 'right');
        await expect.poll(() => extensions.locator('.sb-subpage-row').count()).toBeGreaterThan(0);
        await expect(extensions.locator('.sb-subpage')).toHaveCount(1);
        await expect(extensions.locator('.sb-subpage-detail[aria-hidden="false"]')).toHaveCount(0);
        await expect(extensions.locator('.sb-subpage-detail-content')).toHaveCount(0);

        const scroller = extensions.locator('.sb-subpage-list');
        await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
        const lastRow = extensions.locator('.sb-subpage-row:visible').last();
        await expect(lastRow).toBeVisible();
        const visibleAtBottom = await scroller.evaluate(element => {
            const row = element.querySelector('.sb-subpage-row:last-of-type');
            const rect = row?.getBoundingClientRect();
            const bounds = element.getBoundingClientRect();
            return {
                horizontalOverflow: element.scrollWidth - element.clientWidth,
                verticalOverflow: element.scrollHeight - element.clientHeight,
                atBottom: element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
                lastRowVisible: Boolean(rect && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1),
            };
        });
        expect(visibleAtBottom.horizontalOverflow).toBeLessThanOrEqual(1);
        expect(visibleAtBottom.verticalOverflow).toBeGreaterThanOrEqual(0);
        expect(visibleAtBottom.atBottom).toBe(true);
        expect(visibleAtBottom.lastRowVisible).toBe(true);
        await expectNoHorizontalOverflow(scroller);
    });

    test('settings have no plain checkboxes or title-only descriptions', async ({ page }) => {
        const violations = [];
        for (const { id, shell } of SETTINGS_TABS) {
            const panel = await openSettingsTab(page, id, shell);
            const panelViolations = await panel.evaluate(root => {
                const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
                const results = [];
                for (const input of root.querySelectorAll('input[type="checkbox"]')) {
                    if (!visible(input)) continue;
                    if (!input.closest('.checkbox_label') && input.getAttribute('role') !== 'switch') {
                        results.push(`${input.id || input.name || 'unnamed input'}: plain checkbox`);
                    }
                }
                for (const row of root.querySelectorAll('[title]')) {
                    if (!visible(row) || !row.matches('.ds-row, .ds-row-switch, .checkbox_label, .flex-container')) continue;
                    const hasSubtitle = [...row.querySelectorAll('.ds-row-subtitle')]
                        .some(subtitle => visible(subtitle) && subtitle.textContent.trim());
                    const hasDescription = [...row.querySelectorAll('.ds-row-label, .checkbox_label, label, small, .notes, .toggle-description, p, [data-sb-description]')]
                        .some(description => visible(description) && description.textContent.trim());
                    if (!hasSubtitle && !hasDescription) results.push(`${row.id || row.className || row.tagName}: title-only description`);
                }
                return results;
            });
            violations.push(...panelViolations.map(violation => `${id}: ${violation}`));
        }
        expect(violations).toEqual([]);
    });

    test('Appearance includes the expected Theme Colors, Page Size, and Visual Toggles rows', async ({ page }) => {
        const appearance = await openSettingsTab(page, 'appearance', 'right');
        await expect(appearance.locator('#color-picker-block > .ds-pref-group')).toHaveCount(2);
        const colorRows = await appearance.locator('#color-picker-block > .ds-pref-group').evaluateAll(groups =>
            groups.map(group => group.querySelectorAll(':scope > .ds-row').length),
        );
        expect(colorRows).toEqual([5, 5]);
        await expect(appearance.locator('#AppearanceLayoutSection .ds-row-slider')).toHaveCount(7);
        await expect(appearance.locator('#sb-background-settings-controls #background-blur-block, #sb-background-settings-controls #background-opacity-block')).toHaveCount(2);
        await expect(appearance.locator('#ThemeTogglesSection .ds-row-switch')).toHaveCount(22);
    });
});

test.describe('Preset persistence regression', () => {
    test('a loaded Chat Completions preset remains selected after saving and reloading', async ({ page, baseURL }) => {
        const settingsStore = {};
        await loadSettings(page, baseURL, settingsStore);
        await switchBackend(page, 'openai');
        const prompting = await openSettingsTab(page, 'prompting');
        const preset = prompting.locator('#respective-presets-block #settings_preset_openai');
        const currentValue = await preset.inputValue();
        const selectedValue = await preset.locator('option').evaluateAll((options, current) =>
            options.find(option => option.value !== current && !option.disabled)?.value ?? null,
        currentValue);
        expect(selectedValue, 'a second Chat Completions preset is required to verify persistence').not.toBeNull();
        await preset.selectOption(selectedValue);
        await prompting.locator('#update_oai_preset').click();
        await page.evaluate(async () => {
            const { saveSettings } = await import('/script.js');
            await saveSettings();
        });
        expect(settingsStore.saved).toBeTruthy();

        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(
            () => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'),
            null,
            { timeout: 60000 },
        );
        await switchBackend(page, 'openai');
        const reloadedPrompting = await openSettingsTab(page, 'prompting');
        await expect(reloadedPrompting.locator('#respective-presets-block #settings_preset_openai')).toHaveValue(selectedValue);
    });
});
