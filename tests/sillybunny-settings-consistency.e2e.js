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

// Verbatim panel markup from BunnyPresetTools/content.js keeps coverage independent of installation.
const ANIMATED_BACKGROUND_PANEL_FIXTURE = `
    <div class="bpt-animated-bg-header">
        <div class="bpt-animated-bg-title">Animated Backgrounds</div>
        <div class="bpt-animated-bg-note">Use the normal uploader for local MP4/WebM files, or paste a YouTube/direct video URL here.</div>
    </div>
    <div class="bpt-animated-bg-url-row">
        <input id="bpt-animated-bg-url" class="text_pole" type="text" placeholder="https://youtube.com/... or https://.../loop.mp4">
        <button id="bpt-animated-bg-apply" class="menu_button menu_button_icon" type="button">
            <i class="fa-solid fa-wand-magic-sparkles"></i>
            <span>Use URL</span>
        </button>
    </div>
    <div class="bpt-animated-bg-controls">
        <label class="checkbox_label" for="bpt-animated-bg-enabled">
            <input id="bpt-animated-bg-enabled" type="checkbox">
            <span>Enable video and YouTube backgrounds</span>
        </label>
        <label class="checkbox_label" for="bpt-animated-bg-muted">
            <input id="bpt-animated-bg-muted" type="checkbox">
            <span>Muted</span>
        </label>
        <label class="checkbox_label" for="bpt-animated-bg-loop">
            <input id="bpt-animated-bg-loop" type="checkbox">
            <span>Loop</span>
        </label>
        <label class="checkbox_label" for="bpt-animated-bg-autoplay">
            <input id="bpt-animated-bg-autoplay" type="checkbox">
            <span>Autoplay</span>
        </label>
        <label class="bpt-animated-bg-volume" for="bpt-animated-bg-volume">
            <span>Volume</span>
            <input id="bpt-animated-bg-volume" type="range" min="0" max="100" step="1">
        </label>
    </div>
    <div id="bpt-animated-bg-sources"></div>
`;

async function ensureAnimatedBackgroundPanel(page) {
    await page.evaluate(markup => {
        if (document.getElementById('bpt-animated-bg-panel')) return;
        const gallery = document.getElementById('Backgrounds');
        if (!(gallery instanceof HTMLElement)) throw new Error('Missing Backgrounds gallery for the extension fixture.');

        const panel = document.createElement('div');
        panel.id = 'bpt-animated-bg-panel';
        panel.innerHTML = markup;
        const nodes = [...panel.querySelectorAll('*')];
        const ids = [panel, ...nodes].filter(node => node.id).map(node => [node.id, node]);
        const labels = [...panel.querySelectorAll('.checkbox_label')];
        const inputs = [...panel.querySelectorAll('input')];
        const events = [];
        const settings = {};
        for (const [id, key, checked] of [
            ['bpt-animated-bg-enabled', 'enableAnimatedBackgrounds', true],
            ['bpt-animated-bg-muted', 'animatedBackgroundMuted', false],
            ['bpt-animated-bg-loop', 'animatedBackgroundLoop', true],
            ['bpt-animated-bg-autoplay', 'animatedBackgroundAutoplay', false],
        ]) {
            const input = panel.querySelector(`#${id}`);
            input.checked = checked;
            settings[key] = checked;
            input.addEventListener('change', event => {
                settings[key] = event.target.checked;
                events.push({ key, value: event.target.checked });
            });
        }
        const url = panel.querySelector('#bpt-animated-bg-url');
        const apply = panel.querySelector('#bpt-animated-bg-apply');
        const volume = panel.querySelector('#bpt-animated-bg-volume');
        url.value = 'https://example.invalid/loop.mp4';
        volume.value = '37';
        settings.animatedBackgroundVolume = 37;
        apply.addEventListener('click', () => {
            events.push({ key: 'url', value: url.value });
            url.value = '';
        });
        url.addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            apply.click();
        });
        volume.addEventListener('input', event => {
            settings.animatedBackgroundVolume = Number(event.target.value);
            events.push({ key: 'animatedBackgroundVolume', value: Number(event.target.value) });
        });
        window.__sbAnimatedBackgroundFixture = {
            panel, nodes, ids, labels, inputs, events, settings,
            text: panel.textContent.replace(/\s+/g, ' ').trim(),
            values: inputs.map(input => ({ id: input.id, value: input.type === 'checkbox' ? input.checked : input.value })),
        };
        gallery.insertBefore(panel, gallery.querySelector('#bg_tabs'));
    }, ANIMATED_BACKGROUND_PANEL_FIXTURE);
}

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
        const row = input.closest('.ds-row-switch, .ds-row, .sb-prompt-row');
        const name = input.id || input.name || input.getAttribute('aria-label') || 'unnamed switch';
        if (!row) return [`${name}: missing settings row`];

        const style = getComputedStyle(row);
        const rowRect = row.getBoundingClientRect();
        const switchRect = input.getBoundingClientRect();
        const subtitle = Boolean(row.querySelector('.ds-row-subtitle, .sb-prompt-row-subtitle'));
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

async function expectAnimatedBackgroundStructure(appearance, { geometry = true } = {}) {
    const animated = appearance.locator('#bpt-animated-bg-panel.sb-settings-category');
    await expect(animated).toBeVisible();
    await expect(animated).toHaveAttribute('data-sb-background-presented', 'true');
    const header = animated.locator(':scope > .bpt-animated-bg-header.sb-settings-flat-header.sb-settings-category-header');
    await expect(header).toHaveCount(1);
    await expect(header.locator(':scope > .sb-settings-category-heading')).toHaveCount(1);
    await expect(header.locator('.sb-settings-category-heading > .bpt-animated-bg-title.sb-settings-category-title')).toHaveText('Animated Backgrounds');
    await expect(header.locator('.sb-settings-category-heading > .bpt-animated-bg-note')).toHaveText('Use the normal uploader for local MP4/WebM files, or paste a YouTube/direct video URL here.');
    const controls = animated.locator(':scope > .bpt-animated-bg-controls.ds-pref-group.sb-settings-category-body');
    await expect(controls).toHaveCount(1);
    await expect(controls.locator(':scope > .bpt-animated-bg-url-row.ds-row.ds-row-actions:first-child')).toHaveCount(1);
    await expect(controls.locator(':scope > label.checkbox_label.ds-row.ds-row-switch')).toHaveCount(4);
    await expect(controls.locator(':scope > .bpt-animated-bg-volume.ds-row.ds-row-slider #bpt-animated-bg-volume')).toHaveCount(1);
    await expect(animated.locator('.ds-pref-group')).toHaveCount(1);
    await expect(animated.locator(':scope > #bpt-animated-bg-sources')).toHaveCount(1);
    await expect(animated.locator('[data-sb-copy-placeholder]')).toHaveCount(0);
    await expectSwitchSemantics(animated);
    if (geometry) await expectSwitchGeometry(animated);
    return animated;
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
            'Character Names', 'Reasoning Template',
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

test.describe('Backgrounds settings consistency', () => {
    test.describe.configure({ timeout: 60000 });

    for (const { name, width, theme, compact } of [
        { name: 'desktop', width: 1440, theme: 'Libadwaita', compact: false },
        { name: 'compact light desktop', width: 1440, theme: 'Libadwaita Light', compact: true },
        { name: 'compact light mobile', width: 390, theme: 'Libadwaita Light', compact: true },
    ]) {
        test.describe(`${name}`, () => {
            const mobile = width < 620;
            test.use({ viewport: { width, height: mobile ? 844 : 900 }, hasTouch: mobile });

            test('animated preferences and gallery controls share Settings geometry', async ({ page, baseURL }) => {
                await loadSettings(page, baseURL);
                await page.evaluate(({ theme, compact }) => {
                    $('#themes').val(theme).trigger('change');
                    document.documentElement.dataset.sbCompactMode = String(compact);
                }, { theme, compact });
                await openSettingsTab(page, 'appearance', 'right');
                await ensureAnimatedBackgroundPanel(page);
                await openSettingsTab(page, 'interface', 'right');
                const appearance = await openSettingsTab(page, 'appearance', 'right');
                await page.evaluate(() => document.fonts.ready);
                const animated = await expectAnimatedBackgroundStructure(appearance);

                const headingMetrics = await appearance.evaluate(root => {
                    const metric = element => {
                        const style = getComputedStyle(element);
                        return {
                            fontSize: style.fontSize,
                            fontWeight: style.fontWeight,
                            lineHeight: style.lineHeight,
                            letterSpacing: style.letterSpacing,
                        };
                    };
                    const reference = root.querySelector('#sb-background-settings-heading');
                    return {
                        reference: metric(reference),
                        animated: metric(root.querySelector('.bpt-animated-bg-title')),
                        referenceNoteSize: getComputedStyle(reference.parentElement.querySelector('small')).fontSize,
                        animatedNoteSize: getComputedStyle(root.querySelector('.bpt-animated-bg-note')).fontSize,
                    };
                });
                expect(headingMetrics.animated).toEqual(headingMetrics.reference);
                expect(headingMetrics.animatedNoteSize).toBe(headingMetrics.referenceNoteSize);

                const switchFailures = await animated.locator('.ds-row-switch').evaluateAll(rows => rows.flatMap(row => {
                    const bounds = row.getBoundingClientRect();
                    const group = row.parentElement;
                    const input = row.querySelector('input').getBoundingClientRect();
                    const text = row.querySelector('.ds-row-text').getBoundingClientRect();
                    const checks = {
                        fullWidth: Math.abs(bounds.width - group.clientWidth) <= 1,
                        trailingSwitch: input.left > bounds.left + bounds.width / 2,
                        noOverlap: text.right <= input.left + 1,
                    };
                    return Object.entries(checks).filter(([, pass]) => !pass).map(([check]) => `${row.htmlFor}: ${check}`);
                }));
                expect(switchFailures).toEqual([]);

                const gallery = appearance.locator('#Backgrounds');
                const pillFailures = await gallery.locator([
                    '#bpt-animated-bg-url', '#bpt-animated-bg-apply', '#bg-filter', '#bg-sort', '#background_fitting',
                    '#auto_background', '#bg_add_folder_button', '#add_background_button_top', '#bg_tabs .heading-controls .menu_button',
                ].map(selector => `${selector}:visible`).join(', ')).evaluateAll((controls, minimumHeight) => controls.flatMap(control => {
                    const style = getComputedStyle(control);
                    const bounds = control.getBoundingClientRect();
                    const radii = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'];
                    const checks = {
                        pill: radii.every(radius => parseFloat(style[radius]) >= bounds.height / 2),
                        comfortableTarget: bounds.height >= minimumHeight - 1,
                    };
                    return Object.entries(checks).filter(([, pass]) => !pass).map(([check]) => `${control.id}: ${check}`);
                }), mobile ? 44 : 40);
                expect(pillFailures).toEqual([]);
                const circleFailures = await gallery.locator('#bg_selection_mode_button, #bg_thumb_zoom_out, #bg_thumb_zoom_in, #bg-scroll-top')
                    .evaluateAll(buttons => buttons.flatMap(button => {
                        const bounds = button.getBoundingClientRect();
                        return Math.abs(bounds.width - bounds.height) <= 1 ? [] : [button.id];
                    }));
                expect(circleFailures).toEqual([]);

                const tabs = gallery.locator('#bg_tabs');
                await expect(tabs).toHaveCSS('display', 'grid');
                const toolbarFailures = await tabs.evaluate((root, mobile) => {
                    const list = root.querySelector('[role="tablist"]').getBoundingClientRect();
                    const actions = root.querySelector('.heading-controls').getBoundingClientRect();
                    const checks = mobile ? {
                        wrapsBelowTabs: actions.top >= list.bottom - 1,
                    } : {
                        sameRow: Math.abs(list.top - actions.top) <= Math.abs(list.height - actions.height) / 2 + 1,
                        noOverlap: actions.left >= list.right - 1,
                    };
                    return Object.entries(checks).filter(([, pass]) => !pass).map(([check]) => check);
                }, mobile);
                expect(toolbarFailures).toEqual([]);

                for (const id of ['bg_global_tab', 'bg_chat_tab']) {
                    await tabs.locator(`a[href="#${id}"]`).click();
                    const tabPanel = tabs.locator(`#${id}`);
                    await expect(tabPanel).toBeVisible();
                    await expect.poll(() => tabPanel.evaluate(panel => {
                        const grid = panel.parentElement;
                        const bounds = panel.getBoundingClientRect();
                        const gridBounds = grid.getBoundingClientRect();
                        const list = grid.querySelector('[role="tablist"]').getBoundingClientRect();
                        const actions = grid.querySelector('.heading-controls').getBoundingClientRect();
                        return Math.abs(bounds.width - grid.clientWidth) <= 1
                            && Math.abs(bounds.left - gridBounds.left) <= 1
                            && bounds.top >= Math.max(list.bottom, actions.bottom) - 1;
                    })).toBe(true);
                    await expectNoHorizontalOverflow(tabPanel);
                }
                for (const element of [animated, gallery, appearance.locator('.sb-shell-panel-scroller'), page.locator('html')]) {
                    await expectNoHorizontalOverflow(element);
                }
            });
        });
    }

    test('saved source rows retain selection, removal, and mobile keyboard focus', async ({ page, baseURL }) => {
        await page.route('**/BunnyPresetTools/content.js*', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
        await loadSettings(page, baseURL);
        await page.setViewportSize({ width: 390, height: 844 });
        const appearance = await openSettingsTab(page, 'appearance', 'right');
        await ensureAnimatedBackgroundPanel(page);
        const sources = appearance.locator('#bpt-animated-bg-sources');
        await sources.evaluate(container => {
            for (const source of ['https://example.invalid/loop.mp4', `https://example.invalid/${'long-source-'.repeat(20)}.mp4`]) {
                const card = document.createElement('div');
                card.className = 'bpt-animated-source-card';
                card.innerHTML = `
                    <button class="bpt-animated-source-main" type="button">
                        <i class="fa-solid fa-film"></i>
                        <span class="bpt-animated-source-label"></span>
                    </button>
                    <button class="menu_button menu_button_icon" type="button" title="Remove saved source">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                `;
                card.querySelector('.bpt-animated-source-label').textContent = source;
                card.querySelector('.bpt-animated-source-main').addEventListener('click', () => {
                    for (const sibling of container.children) sibling.classList.toggle('is-active', sibling === card);
                });
                card.querySelector('.menu_button').addEventListener('click', () => card.remove());
                container.append(card);
            }
        });
        await expectNoHorizontalOverflow(sources);
        const main = sources.locator('.bpt-animated-source-main').last();
        await main.click();
        await expect(sources.locator('.bpt-animated-source-card').last()).toHaveClass(/is-active/);
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        await expect(main).toBeFocused();
        const metrics = await main.evaluate(button => {
            const style = getComputedStyle(button);
            const card = getComputedStyle(button.parentElement);
            return {
                targetHeight: button.getBoundingClientRect().height,
                pill: parseFloat(style.borderRadius) >= button.getBoundingClientRect().height / 2,
                focusRing: style.boxShadow !== 'none',
                selectedFill: card.backgroundColor !== 'rgba(0, 0, 0, 0)',
                noSelectionGlow: card.boxShadow === 'none',
            };
        });
        expect(metrics.targetHeight).toBeGreaterThanOrEqual(40);
        expect(metrics).toMatchObject({ pill: true, focusRing: true, selectedFill: true, noSelectionGlow: true });
        const remove = sources.locator('.bpt-animated-source-card > .menu_button').last();
        const dimensions = await remove.evaluate(button => ({ width: button.clientWidth, height: button.clientHeight }));
        expect(dimensions.width).toBe(dimensions.height);
        expect(dimensions.height).toBeGreaterThanOrEqual(40);
        await remove.click();
        await expect(sources.locator('.bpt-animated-source-card')).toHaveCount(1);
    });

    test('late normalization and reopening preserve original fixture nodes, values, and handlers', async ({ page, baseURL }) => {
        // The extension's one-second bootstrap would otherwise overwrite the fixture's control state.
        await page.route('**/BunnyPresetTools/content.js*', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
        await loadSettings(page, baseURL);
        const appearance = await openSettingsTab(page, 'appearance', 'right');
        await ensureAnimatedBackgroundPanel(page);
        await expect(page.locator('#bpt-animated-bg-panel')).toHaveAttribute('data-sb-background-presented', 'true');
        const animated = await expectAnimatedBackgroundStructure(appearance, { geometry: false });
        const initialMarkup = await animated.evaluate(panel => panel.outerHTML);
        await page.evaluate(async () => {
            const { normalizeSettingsPresentation } = await import('/scripts/sillybunny-settings-presentation.js');
            const appearance = document.querySelector('[data-sb-panel="appearance"]');
            for (let pass = 0; pass < 3; pass++) normalizeSettingsPresentation(appearance, { name: 'appearance' });
        });
        await openSettingsTab(page, 'interface', 'right');
        await openSettingsTab(page, 'appearance', 'right');
        expect(await animated.evaluate(panel => panel.outerHTML)).toBe(initialMarkup);

        const preserved = await animated.evaluate(panel => {
            const fixture = window.__sbAnimatedBackgroundFixture;
            if (!fixture) throw new Error('Expected original animated background fixture.');
            return {
                samePanel: fixture.panel === panel,
                originalNodesRetained: fixture.nodes.every(node => panel.contains(node)),
                originalIdsRetained: fixture.ids.every(([id, node]) => document.getElementById(id) === node && document.querySelectorAll(`#${id}`).length === 1),
                originalLabelsRetained: fixture.labels.every(label => label.parentElement === panel.querySelector('.bpt-animated-bg-controls') && label.matches('.ds-row-switch')),
                text: panel.textContent.replace(/\s+/g, ' ').trim(),
                originalText: fixture.text,
                values: fixture.inputs.map(input => ({ id: input.id, value: input.type === 'checkbox' ? input.checked : input.value })),
                originalValues: fixture.values,
                events: fixture.events,
            };
        });
        expect(preserved.samePanel).toBe(true);
        expect(preserved.originalNodesRetained).toBe(true);
        expect(preserved.originalIdsRetained).toBe(true);
        expect(preserved.originalLabelsRetained).toBe(true);
        expect(preserved.text).toBe(preserved.originalText);
        expect(preserved.values).toEqual(preserved.originalValues);
        expect(preserved.events).toEqual([]);

        for (const [id, checked] of [
            ['bpt-animated-bg-enabled', false], ['bpt-animated-bg-muted', true],
            ['bpt-animated-bg-loop', false], ['bpt-animated-bg-autoplay', true],
        ]) {
            await animated.locator(`label[for="${id}"]`).click();
            await expect(animated.locator(`#${id}`)).toBeChecked({ checked });
        }
        const url = animated.locator('#bpt-animated-bg-url');
        await url.fill('https://example.invalid/updated.mp4');
        await url.press('Enter');
        await expect(url).toHaveValue('');
        await animated.locator('#bpt-animated-bg-volume').evaluate(input => {
            input.value = '68';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const handlers = await page.evaluate(() => ({
            events: window.__sbAnimatedBackgroundFixture.events,
            settings: window.__sbAnimatedBackgroundFixture.settings,
        }));
        expect(handlers.events).toEqual([
            { key: 'enableAnimatedBackgrounds', value: false },
            { key: 'animatedBackgroundMuted', value: true },
            { key: 'animatedBackgroundLoop', value: false },
            { key: 'animatedBackgroundAutoplay', value: true },
            { key: 'url', value: 'https://example.invalid/updated.mp4' },
            { key: 'animatedBackgroundVolume', value: 68 },
        ]);
        expect(handlers.settings).toEqual({
            enableAnimatedBackgrounds: false,
            animatedBackgroundMuted: true,
            animatedBackgroundLoop: false,
            animatedBackgroundAutoplay: true,
            animatedBackgroundVolume: 68,
        });
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
