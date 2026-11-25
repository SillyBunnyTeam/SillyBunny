import { expect, test } from '@playwright/test';
import { auditPromptingLayout } from './helpers/libadwaita-audit.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchBodyOrSkip } from './helpers/route-fetch.js';
import { applyWelcomeSettings } from './helpers/welcome-dialog.js';
import { waitForAppReady } from './helpers/app-ready.js';

test.beforeEach(async ({ page }) => { await protectMaintainerServer(page); });

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });

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
            const fetched = await fetchBodyOrSkip(route, response => response.json());
            if (!fetched) return;
            const { response, body: data } = fetched;
            const settings = settingsStore?.saved ?? JSON.parse(data.settings);
            settings.firstRun = false;
            applyWelcomeSettings(settings);
            settings._version ??= settingsVersion;
            settings.extension_settings ??= {};
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

        if (READ_ONLY_POST_ENDPOINTS.has(url.pathname) || url.pathname.startsWith('/api/tokenizers/')
            || /^\/api\/chats\/(?:group\/)?get$/.test(url.pathname)) {
            return route.fallback();
        }

        const isWriteMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
        const isWriteEndpoint = /^\/api\/.*\/(save|delete|create|edit|rename|update|import|upload|restore|duplicate|write|set)(?:\/|$)/i.test(url.pathname);
        if (isWriteMethod || isWriteEndpoint) {
            return route.fulfill({ json: {} });
        }

        return route.fallback();
    });

    // Keep the legacy settings-save route covered too; the general API route above also blocks it.
    await page.route('**/api/savesettings**', route => route.fulfill({ json: { result: 'ok' } }));
}

async function loadSettings(page, baseURL, settingsStore = null) {
    const hostname = new URL(baseURL).hostname;
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(hostname);
    await mockWrites(page, settingsStore);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page, { timeout: 60000 });
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
};

async function expectSwitchSemantics(panel) {
    const failures = await panel.locator('input[type="checkbox"]').evaluateAll((inputs, allowlist) => inputs.flatMap(input => {
        // Icon-button toggles keep their state in a display:none checkbox; the label button is the control.
        if (getComputedStyle(input).display === 'none') return [];
        if (allowlist.some(selector => input.closest(selector))) return [];
        // A check row picks one of several (the mobile Top Bar Label): a check, not a switch.
        if (input.closest('.ds-row-check')) return [];
        const name = input.id || input.name || input.getAttribute('aria-label') || 'unnamed checkbox';
        const issues = [];
        if (input.getAttribute('role') !== 'switch') issues.push('missing role=switch');
        // ARIA in HTML forbids aria-checked on elements with a native checked state.
        if (input.hasAttribute('aria-checked')) issues.push('redundant aria-checked');
        return issues.map(issue => `${name}: ${issue}`);
    }), Object.keys(SWITCH_SEMANTICS_ALLOWLIST));
    expect(failures).toEqual([]);
}

async function expectSwitchGeometry(panel) {
    const failures = await panel.locator('input[type="checkbox"]:visible').evaluateAll((inputs, allowlist) => inputs.flatMap(input => {
        if (allowlist.some(selector => input.closest(selector))) return [];
        const agentTarget = input.closest('.ica-agent-switch-target');
        if (agentTarget) {
            const target = agentTarget.getBoundingClientRect();
            const row = input.closest('.ica-agent-row, .sb-list-header').getBoundingClientRect();
            const control = input.getBoundingClientRect();
            const coarse = matchMedia('(pointer: coarse), (any-pointer: coarse)').matches;
            const metrics = {
                rowHeight: row.height >= 44,
                targetSize: !coarse || (target.width >= 44 && target.height >= 44),
                centered: Math.abs(control.top + control.height / 2 - row.top - row.height / 2) <= 1,
            };
            return Object.entries(metrics).filter(([, pass]) => !pass).map(([metric]) => `${input.getAttribute('aria-label')}: ${metric}`);
        }
        const row = input.closest('.ds-row-switch, .ds-row, .sb-prompt-row');
        const name = input.id || input.name || input.getAttribute('aria-label') || 'unnamed switch';
        if (!row) return [`${name}: missing settings row`];

        const style = getComputedStyle(row);
        const rowRect = row.getBoundingClientRect();
        const switchRect = input.getBoundingClientRect();
        const minimumHeight = document.documentElement.dataset.sbCompactMode === 'true' ? 46 : 50;
        const metrics = {
            minHeight: parseFloat(style.minHeight) >= minimumHeight,
            actualHeight: rowRect.height >= minimumHeight,
            centered: Math.abs(switchRect.top + switchRect.height / 2 - rowRect.top - rowRect.height / 2) <= 1,
        };
        return Object.entries(metrics).filter(([, pass]) => !pass).map(([metric]) => `${name}: ${metric}`);
    }), Object.keys(SWITCH_SEMANTICS_ALLOWLIST));
    expect(failures).toEqual([]);
}

function getPromptingGroupTitles(prompting) {
    return prompting.locator('.sb-prompting-group:visible').evaluateAll(groups => groups.map(group => {
        const heading = group.querySelector(':scope > .sb-settings-flat-header .sb-settings-category-title, :scope > .sb-settings-flat-header b, :scope > .inline-drawer-header b');
        // A group whose one row carries the title has no heading; its box is named by a label.
        const label = group.querySelector(':scope > [role="group"][aria-label]')?.getAttribute('aria-label');
        return heading?.textContent.replace(/\s+/g, ' ').trim() ?? label ?? '';
    }));
}

async function readBackendCategorySpacing(panel, groupSelector, expectedBetween) {
    return panel.evaluate((root, { selector, expectedBetween }) => {
        const visible = element => element instanceof HTMLElement && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
        const groups = [...root.querySelectorAll(selector)].filter(visible);
        const failures = [];
        let boundaries = 0;
        for (const group of groups) {
            const header = group.querySelector(':scope > .sb-settings-category-header, :scope > .sb-settings-flat-header');
            const body = group.querySelector(':scope > .ds-pref-group');
            const name = group.id || group.dataset.sbSamplingGroup;
            // A group with no heading is named by a label on its box and starts at the box.
            const headless = !header && body?.matches('[role="group"][aria-label]');
            if ((!header && !headless) || !body) {
                failures.push(`${name}: missing category header or body`);
                continue;
            }
            const top = header ?? body;
            if (header) {
                const insideGap = body.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
                if (Math.abs(insideGap - 6) > 1) failures.push(`${name}: header-to-body gap ${insideGap}px`);
            }
            let previous = group.previousElementSibling;
            while (previous && !visible(previous)) previous = previous.previousElementSibling;
            // Navigation actions and wrapper boundaries are not consecutive categories.
            if (previous?.matches(selector)) {
                const previousBody = previous.querySelector(':scope > .ds-pref-group');
                if (!previousBody) {
                    failures.push(`${name}: preceding category has no body`);
                    continue;
                }
                boundaries++;
                const betweenGap = top.getBoundingClientRect().top - previousBody.getBoundingClientRect().bottom;
                if (Math.abs(betweenGap - expectedBetween) > 1) failures.push(`${name}: between-category gap ${betweenGap}px`);
            } else if (parseFloat(getComputedStyle(group).marginTop) !== 0) {
                failures.push(`${name}: first or separated category has a leading margin`);
            }
        }
        return { groups: groups.length, boundaries, failures };
    }, { selector: groupSelector, expectedBetween });
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
    const animated = appearance.locator('#bpt-animated-bg-panel.sb-appearance-group');
    await expect(animated).toBeVisible();
    await expect(animated).toHaveAttribute('data-sb-background-presented', 'true');
    const header = animated.locator(':scope > .ds-pref-group-header');
    await expect(header).toHaveCount(1);
    await expect(header.locator('.bpt-animated-bg-title.ds-pref-group-heading')).toHaveText('Animated Backgrounds');
    await expect(header.locator('.bpt-animated-bg-note.ds-pref-group-subtitle')).toHaveText('Use the normal uploader for local MP4/WebM files, or paste a YouTube/direct video URL here.');
    const box = animated.locator(':scope > .ds-pref-group');
    await expect(box).toHaveCount(1);
    await expect(box.locator(':scope > .ds-row-entry--floating:first-child #bpt-animated-bg-url')).toHaveCount(1);
    await expect(box.locator('.ds-row-suffix > #bpt-animated-bg-apply')).toHaveCount(1);
    await expect(box.locator(':scope > label.checkbox_label.ds-row.ds-row-switch')).toHaveCount(4);
    await expect(box.locator(':scope > .bpt-animated-bg-volume.ds-row.ds-row-slider #bpt-animated-bg-volume')).toHaveCount(1);
    await expect(animated.locator('.ds-pref-group')).toHaveCount(1);
    await expect(box.locator(':scope > #bpt-animated-bg-sources')).toHaveCount(1);
    await expect(box.locator(':scope > .ds-row-entry--floating:first-child .ds-row-label')).toHaveText('Video URL');
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
                await expectSwitchGeometry(panel);
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
                    noIcon: !header.querySelector('.sb-settings-category-title i[class*="fa-"]:not(:is(button, .menu_button) *)'),
                };
                return Object.entries(metrics).filter(([, pass]) => !pass)
                    .map(([metric]) => `${title.textContent.trim() || 'unnamed'}: ${metric}`);
            }), reference);
            expect(failures, `${tab} header metrics`).toEqual([]);
        }
    });

    test('Messages keeps a dependent set in its own group and leaves its rows insensitive while the switch is off', async ({ page }) => {
        const messages = await openSettingsTab(page, 'messages', 'right');
        const groups = [
            ['auto-swipe', '#auto_swipe', ['#auto_swipe_minimum_length', '#auto_swipe_blacklist', '#auto_swipe_blacklist_threshold']],
            ['auto-continue', '#auto_continue_enabled', ['#auto_continue_allow_chat_completions', '#auto_continue_target_length']],
            ['smooth-streaming', '#smooth_streaming', ['#smooth_streaming_no_think', '#smooth_streaming_speed']],
        ];
        for (const [group, enabler, dependents] of groups) {
            const body = messages.locator(`[data-sb-category="${group}"] > .sb-settings-category-body`);
            await expect(body.locator('.ds-row').first().locator(enabler), `${group} starts with its switch`).toHaveCount(1);
            const input = body.locator(enabler);
            await input.setChecked(false);
            for (const dependent of dependents) {
                await expect(body.locator('.ds-row', { has: page.locator(dependent) }), `${group} ${dependent} while off`).toHaveClass(/is-insensitive/);
            }
            await input.setChecked(true);
            for (const dependent of dependents) {
                await expect(body.locator('.ds-row', { has: page.locator(dependent) }), `${group} ${dependent} while on`).not.toHaveClass(/is-insensitive/);
            }
        }
    });

    test('Messages fields are select, spin and text-area rows with plain titles', async ({ page }) => {
        const messages = await openSettingsTab(page, 'messages', 'right');
        await expect(messages.locator('.ds-select-row:has(#send_on_enter)')).toHaveCount(1);
        await expect(messages.locator('.ds-row--spin:has(#ooc_context_depth)')).toHaveCount(1);
        await expect(messages.locator('.ds-row-textarea:has(#auto_swipe_blacklist)')).toHaveCount(1);
        const titles = await messages.locator('.ds-pref-group .ds-row-label').evaluateAll(labels => labels.map(label => label.textContent.trim()).filter(Boolean));
        expect(titles.filter(title => /[:：]$/.test(title)), 'row titles that still end in a colon').toEqual([]);
    });

    test('Messages titles its swipes group Swipes, leaves Smooth Streaming without a description and names the slider Speed', async ({ page }) => {
        const messages = await openSettingsTab(page, 'messages', 'right');
        await expect(messages.locator('[data-sb-category="swipes"] .sb-settings-category-title')).toHaveText('Swipes');
        const smooth = messages.locator('[data-sb-category="smooth-streaming"]');
        await expect(smooth.locator('.sb-settings-category-title')).toHaveText('Smooth Streaming');
        await expect(smooth.locator('.sb-settings-category-heading small')).toHaveCount(0);
        await expect(smooth.locator('[data-sb-copy-placeholder]')).toHaveCount(0);
        await expect(smooth.locator('#smooth_streaming_speed_control .ds-row-label')).toHaveText('Speed');
        await expect(smooth.locator('#smooth_streaming_speed_counter')).toHaveAccessibleName('Speed');
    });

    test('Data & Security opens windows and acts in place from button rows titled with the action', async ({ page }) => {
        const dataSecurity = await openSettingsTab(page, 'data-security', 'right');
        for (const [selector, title, arrow] of [
            ['#account_button', 'Account', true],
            ['.user_stats_button', 'Usage Stats', true],
            ['#user_backup_button', 'Download Backup', false],
            ['#settings_snapshots_button', 'Settings Snapshots', true],
        ]) {
            const row = dataSecurity.locator(`${selector}.ds-button-row`);
            await expect(row, title).toBeVisible();
            await expect(row.locator('.ds-row-label'), title).toHaveText(title);
            await expect(row.locator('.ds-row__chevron'), `${title} arrow`).toHaveCount(arrow ? 1 : 0);
            await expect(row.locator('.ds-row-subtitle'), `${title} subtitle`).toHaveCount(0);
        }
        await expect(dataSecurity.locator('[data-sb-editor-field="updates-restart"] .ds-pref-group-subtitle'))
            .toHaveText('Updates use Git and only run when the repository can fast-forward cleanly.');
        const actions = dataSecurity.locator('[data-sb-editor-field="thumbnail-actions"]');
        await expect(actions.locator('.ds-pref-group-heading')).toHaveText('Thumbnail Actions');
        await expect(actions.locator('.ds-pref-group-heading')).not.toHaveAttribute('data-sb-copy-placeholder', /.*/);
        await expect(actions.locator('.ds-pref-group-subtitle')).toHaveCount(0);
        await expect(actions.locator('.ds-button-row')).toHaveText(['Use Desktop Recommended', 'Use Mobile Recommended', 'Save Thumbnails', 'Save & Clear Cache', 'Clear Cache Only']);
    });

    test('a button row on a settings page shows the focus ring when the keyboard reaches it', async ({ page }) => {
        const dataSecurity = await openSettingsTab(page, 'data-security', 'right');
        const account = dataSecurity.locator('#account_button.ds-button-row');
        await expect(account).toBeVisible();
        await account.focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        await expect(account).toBeFocused();
        expect(await account.evaluate(row => row.matches(':focus-visible'))).toBe(true);
        expect(await account.evaluate(row => getComputedStyle(row).boxShadow)).not.toBe('none');
    });

    test('a select row and a spin row on a settings page show the focus ring when the keyboard reaches their control', async ({ page }) => {
        const messages = await openSettingsTab(page, 'messages', 'right');
        const select = messages.locator('.ds-pref-group > .ds-row.ds-select-row:not(.is-insensitive)').first();
        const spin = messages.locator('.ds-pref-group > .ds-row.ds-row--spin:not(.is-insensitive)').first();
        for (const [row, control, name] of [
            [select, select.locator('.ds-select-row__trigger'), 'select row'],
            [spin, spin.locator('input.ds-spin'), 'spin row'],
        ]) {
            await expect(control, name).toBeVisible();
            await control.focus();
            await page.keyboard.press('Shift+Tab');
            await page.keyboard.press('Tab');
            await expect(control, name).toBeFocused();
            expect(await row.evaluate(element => getComputedStyle(element).boxShadow), name).not.toBe('none');
        }
    });

    test('an entry row on a settings page draws one ring round the row, none on its text, and no fill', async ({ page }) => {
        const dataSecurity = await openSettingsTab(page, 'data-security', 'right');
        const row = dataSecurity.locator('.ds-row-entry--floating').first();
        const input = row.locator('.ds-row-entry__field > input');
        await expect(row).toBeVisible();
        await expect(row.locator('.ds-row-entry__edit')).toBeVisible();
        await input.focus();
        await expect.poll(() => row.evaluate(node => getComputedStyle(node).boxShadow)).toContain('inset');
        expect(await input.evaluate(node => {
            const style = getComputedStyle(node);
            return { shadow: style.boxShadow, background: style.backgroundColor, border: style.borderTopWidth };
        })).toEqual({ shadow: 'none', background: 'rgba(0, 0, 0, 0)', border: '0px' });
        await expect(row.locator('.ds-row-entry__edit')).toBeHidden();
    });

    test('Appearance and Formatting keep migrated groups flat and aligned', async ({ page }) => {
        const appearance = await openSettingsTab(page, 'appearance', 'right');
        const appearanceMetrics = await appearance.evaluate(root => {
            const pageSize = root.querySelector('[data-sb-category="page-size"]');
            const visual = root.querySelector('[data-sb-category="visual-toggles"]');
            const borderTop = element => element ? getComputedStyle(element).borderTopWidth : null;
            return { pageSizeBorderTop: borderTop(pageSize), visualBorderTop: borderTop(visual) };
        });
        expect(appearanceMetrics).toEqual({ pageSizeBorderTop: '0px', visualBorderTop: '0px' });

        const topbar = appearance.locator('#sb-topbar-label-drawer:visible');
        const topbarMetrics = await topbar.evaluate(group => {
            const title = group.querySelector('.ds-pref-group-heading');
            const row = group.querySelector('.ds-row-switch');
            const input = row?.querySelector('input[type="checkbox"]');
            const rowRect = row?.getBoundingClientRect();
            const inputRect = input?.getBoundingClientRect();
            return {
                desktopTitleVisible: Boolean(title && title.getBoundingClientRect().height > 0 && title.scrollWidth <= title.clientWidth),
                switchIsTrailing: Boolean(rowRect && inputRect && inputRect.right > rowRect.left + rowRect.width / 2),
                boxFullWidth: group.querySelector('.ds-pref-group')?.clientWidth === group.clientWidth,
            };
        });
        expect(topbarMetrics).toEqual({
            desktopTitleVisible: true,
            switchIsTrailing: true,
            boxFullWidth: true,
        });

        await page.setViewportSize({ width: 390, height: 844 });
        const mobileAppearance = await openSettingsTab(page, 'appearance', 'right');
        const mobileTopbar = mobileAppearance.locator('#sb-topbar-label-drawer:visible');
        const mobileTitleMetrics = await mobileTopbar.locator('.ds-pref-group-heading').evaluate(title => ({
            visible: title.getBoundingClientRect().height > 0,
            fits: title.scrollWidth <= title.clientWidth,
        }));
        expect(mobileTitleMetrics).toEqual({ visible: true, fits: true });
        await expect(mobileTopbar.locator('.ds-row-switch')).toHaveCount(3);
        await expect(mobileTopbar.locator('.ds-row-check')).toHaveCount(0);
        await expect(mobileAppearance.locator('#sb-topbar-label-mobile-group, #sb-topbar-custom-text-input-mobile')).toHaveCount(0);

        await page.setViewportSize({ width: 1280, height: 720 });
        const messages = await openSettingsTab(page, 'messages', 'right');
        const titleMetrics = await messages.locator('.sb-settings-category-title:visible').first().evaluate(title => {
            const style = getComputedStyle(title);
            return { fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, color: style.color };
        });
        const formatting = await openSettingsTab(page, 'context', 'left');
        const groups = formatting.locator('#AdvancedFormatting > .sb-formatting-group');
        await expect(groups).toHaveCount(8);
        await expect(groups.locator(':scope > .sb-settings-category-header .sb-settings-category-title')).toHaveText([
            'Tokenizer & Padding', 'Stopping Strings', 'Reply Prefix', 'Text Cleanup', 'Reasoning', 'Add to Prompts', 'Rendering', 'Advanced Formatting',
        ]);
        await expect(groups.locator(':scope > .sb-settings-category-header .sb-settings-category-heading > small')).toHaveText([
            'Choose a tokenizer and adjust prompt token counts with padding',
            'Choose text that stops generation, with optional macro replacement',
            'Set how replies begin and whether that text appears in chat',
            'Control line breaks, extra spaces, and unfinished sentences in replies',
            'These settings apply to every chat, whichever template is chosen',
            'Keep specified standalone text from being treated as Markdown',
        ]);
        const failures = await groups.evaluateAll((groups, expectedTitle) => groups.flatMap(group => {
            const header = group.querySelector(':scope > .sb-settings-category-header');
            const body = group.querySelector(':scope > .ds-pref-group.sb-settings-category-body');
            const title = header?.querySelector('.sb-settings-category-title');
            const subtitle = header?.querySelector('.sb-settings-category-heading > small');
            const groupStyle = getComputedStyle(group);
            const bodyStyle = body ? getComputedStyle(body) : null;
            const titleStyle = title ? getComputedStyle(title) : null;
            const checks = {
                headerIsFirst: header === group.firstElementChild,
                oneHeaderAndBody: [...group.children].filter(child => !child.hidden).length === 2 && header?.nextElementSibling === body,
                localizedTitle: Boolean(title && title.dataset.i18n === title.textContent),
                localizedSubtitle: !subtitle || subtitle.dataset.sbCopyPlaceholder === 'true' || subtitle.dataset.i18n === subtitle.textContent,
                titleMetrics: Boolean(titleStyle && Object.entries(expectedTitle).every(([key, value]) => titleStyle[key] === value)),
                outerGroupHasNoBox: groupStyle.borderTopWidth === '0px' && groupStyle.padding === '0px' && groupStyle.backgroundColor === 'rgba(0, 0, 0, 0)' && groupStyle.boxShadow === 'none',
                bodyKeepsPreferenceBox: bodyStyle?.borderTopWidth === '0px' && bodyStyle.boxShadow !== 'none' && bodyStyle.borderRadius === '12px',
            };
            return Object.entries(checks).filter(([, pass]) => !pass).map(([check]) => `${group.id}: ${check}`);
        }), titleMetrics);
        expect(failures).toEqual([]);
        // The upstream heading is the last group, with its documentation link beside the title; the old heading block is gone.
        await expect(formatting.locator('#AdvancedFormatting > .sb-settings-flat-header:visible')).toHaveCount(0);
        const help = formatting.locator('#sb-af-advanced a.notes-link[href$="/advancedformatting/"]');
        // The group hides with its buttons while a message-style Chat Completions backend is active.
        await expect(help).toBeHidden();
        await page.evaluate(() => $('#main_api').val('textgenerationwebui').trigger('change'));
        await expect(help).toBeVisible();
        await expect(help).toHaveAccessibleName('Help');
        expect(await help.evaluate(link => {
            const title = link.closest('.sb-settings-category-title-row')?.querySelector('h3[data-i18n="Advanced Formatting"]');
            const titleRect = title?.getBoundingClientRect();
            const helpRect = link.getBoundingClientRect();
            return Boolean(titleRect && helpRect.left >= titleRect.right - 1
                && Math.abs(helpRect.top + helpRect.height / 2 - titleRect.top - titleRect.height / 2) <= 2);
        })).toBe(true);
    });
});

test.describe('Prompting and Sampling consistency', () => {
    test.beforeEach(async ({ page, baseURL }) => loadSettings(page, baseURL));

    test('Chat and Text Completions open with Presets and render their full prompting flows', async ({ page }) => {
        const chatGroups = [
            'Presets', 'Preset API/Sampler Linking', 'Generation Settings', 'Character Names Behavior', 'Continue Postfix',
            'System Messages', 'Reply Prefill', 'Request Options', 'Enable function calling',
            'Send inline media', 'Request model reasoning', 'Prompt Caching', 'Reasoning Template',
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
            await expect(sampling.locator('.sb-sampling-group:visible > .sb-settings-category-header .sb-settings-category-title').first()).toHaveText('Sampling');
            await expect(sampling.locator('.sb-sampling-group[data-sb-sampling-group="presets"]:visible')).toHaveCount(0);
        }

        for (const backend of TEXT_BACKENDS) {
            await switchBackend(page, backend);
            const prompting = await openSettingsTab(page, 'prompting');
            await expect.poll(() => getPromptingGroupTitles(prompting).then(titles => titles[0])).toBe('Presets');
        }
    });

    test('Backend categories keep 24px boundaries (18px compact) and 6px internal gaps across layouts', async ({ page }) => {
        test.setTimeout(120000);
        for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
            for (const compact of [false, true]) {
                await page.evaluate(compact => { document.documentElement.dataset.sbCompactMode = String(compact); }, compact);
                for (const backend of ['openai', 'textgenerationwebui']) {
                    await switchBackend(page, backend);
                    for (const [tab, selector] of [
                        ['sampling', '.sb-sampling-group'],
                        ['prompting', '.sb-prompting-group'],
                        ['context', '#AdvancedFormatting > .sb-formatting-group'],
                    ]) {
                        const panel = await openSettingsTab(page, tab);
                        const expectedBetween = [24, 18][Number(compact)];
                        await expect.poll(async () => (await readBackendCategorySpacing(panel, selector, expectedBetween)).failures).toEqual([]);
                        const metrics = await readBackendCategorySpacing(panel, selector, expectedBetween);
                        expect(metrics.groups).toBeGreaterThan(1);
                        expect(metrics.boundaries).toBeGreaterThan(0);
                    }
                }
            }
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

    test('Sampling is a full-width single column with the shared rows at 1920×1080', async ({ page }) => {
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
            const expectedMinimum = 50;
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
            const rows = element.querySelectorAll('.sb-subpage-row');
            const row = rows[rows.length - 1];
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

    test('every Customize and Backend page, and Characters Import, keeps the one page frame: the same side inset and top space, and a scroller that reaches the page bottom', async ({ page }) => {
        test.setTimeout(300000);
        // The Prompt editor and the Agents list are list pages with their own header and scroller, so they have no group to measure.
        const pages = [
            { id: 'appearance', shell: 'right' }, { id: 'extensions', shell: 'right' }, { id: 'interface', shell: 'right' },
            { id: 'messages', shell: 'right' }, { id: 'data-security', shell: 'right' }, { id: 'logs', shell: 'right' },
            { id: 'connections', shell: 'left' }, { id: 'sampling', shell: 'left' }, { id: 'prompting', shell: 'left' }, { id: 'context', shell: 'left' },
            { id: 'characters-import', shell: 'characters' },
        ];
        const readFrame = selector => page.evaluate(rootSelector => {
            const settingsPage = document.getElementById('sb-settings-page');
            const root = document.querySelector(rootSelector);
            const hidden = node => node.closest('[hidden], [aria-hidden="true"]') !== null;
            const shown = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden' && !hidden(node);
            const scrollers = [root, ...root.querySelectorAll('*')].filter(node => /^(auto|scroll)$/.test(getComputedStyle(node).overflowY)
                && !['TEXTAREA', 'INPUT', 'SELECT', 'PRE'].includes(node.tagName) && node.clientHeight > 0 && shown(node));
            // The outermost box that scrolls, or the outermost that would when the content were longer.
            const scroller = scrollers.find(node => node.scrollHeight > node.clientHeight + 1) ?? scrollers[0];
            if (!scroller) return { error: `${rootSelector} has no scroller` };
            scroller.scrollTop = 0;
            const box = scroller.getBoundingClientRect();
            // The page's own box, not the scroller's: a page whose scroller sits inside another box that pads it must show that padding.
            const frame = root.getBoundingClientRect();
            const group = [...scroller.querySelectorAll('.ds-pref-group')].find(shown);
            if (!group) return { error: `${rootSelector} has no group` };
            const flowing = [...scroller.querySelectorAll('*')].filter(node => shown(node) && !['absolute', 'fixed'].includes(getComputedStyle(node).position) && node.getBoundingClientRect().height > 0);
            // Content is a flowing box with no flowing box inside it. A wrapper starts where its own padding starts, and a
            // zero-height sibling that `display: flex` keeps in a flex column pushes the content down by a gap without
            // moving any wrapper's top, so the wrappers' tops cannot show it.
            const flowingSet = new Set(flowing);
            const leaves = flowing.filter(node => ![...node.children].some(child => flowingSet.has(child)));
            // A row's text sits inside the row's padding, so a leaf in a boxed group counts from the group's top edge.
            const contentTop = Math.min(...leaves.map(node => (node.closest('.ds-pref-group') ?? node).getBoundingClientRect().top));
            const resolve = value => {
                const probe = document.createElement('div');
                probe.style.cssText = `position:absolute;visibility:hidden;padding-left:${value}`;
                settingsPage.append(probe);
                const resolved = parseFloat(getComputedStyle(probe).paddingLeft);
                probe.remove();
                return resolved;
            };
            return {
                inset: resolve('var(--sb-settings-inset)'),
                pane: frame.width,
                insetTop: resolve('var(--sb-settings-inset-top)'),
                left: Math.round((group.getBoundingClientRect().left - frame.left) * 10) / 10,
                right: Math.round((frame.right - group.getBoundingClientRect().right) * 10) / 10,
                top: Math.round((contentTop - frame.top) * 10) / 10,
                bottomGap: Math.round((settingsPage.getBoundingClientRect().bottom - box.bottom) * 10) / 10,
                scroller: `${scroller.tagName.toLowerCase()}.${[...scroller.classList].join('.')}`,
            };
        }, selector);

        // Formatting, Sampling, Prompting and Connections show other groups for each API type, and a group that one type
        // hides can leave space behind, so each pair is measured. The Characters Import page does not depend on the type.
        // The page's content is an AdwClamp above 768px, so its sides sit further in than the inset while Limit Content Width is on, and
        // the same for every page. With the switch off the sides are the inset again, as they are at every width on a phone.
        const frameRuns = [[1440, 900, 'openai', 'on'], [1440, 900, 'textgenerationwebui', 'on'], [1440, 900, 'openai', 'off'], [390, 844, 'openai', 'on'], [390, 844, 'textgenerationwebui', 'on']];
        for (const [width, height, backend, clamp] of frameRuns) {
            await page.setViewportSize({ width, height });
            await page.evaluate(state => (state === 'off' ? document.documentElement.setAttribute('data-sb-content-clamp', 'off') : document.documentElement.removeAttribute('data-sb-content-clamp')), clamp);
            await switchBackend(page, backend);
            const frames = {};
            for (const { id, shell } of pages) {
                if (shell === 'characters') {
                    // The Characters list is shown first: its panel keeps matching the list's `:has()` rules on the scroll box afterwards.
                    await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'characters'));
                    await page.waitForTimeout(600);
                    await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'import'));
                    await expect(page.locator('#sb_character_import_content')).toBeVisible();
                    await page.waitForTimeout(400);
                    frames[id] = await readFrame('#right-nav-panel');
                } else {
                    await openSettingsTab(page, id, shell);
                    await page.waitForTimeout(300);
                    // Some pages build their groups after the tab opens; under load Data & Security had none yet at 300ms.
                    await expect.poll(async () => (await readFrame(`[data-sb-panel="${id}"]`)).error ?? '', { timeout: 10_000 }).not.toMatch(/has no group/);
                    frames[id] = await readFrame(`[data-sb-panel="${id}"]`);
                }
            }
            const problems = [];
            const reference = frames.interface;
            expect(reference.error).toBeUndefined();
            expect(reference.inset).toBe(12);
            // AdwClamp of 1000sp, its threshold at 2/3 of that, over the room between the insets: 950px at 1440px, centred in the pane.
            const side = clamp === 'on' && width > 768 ? (reference.pane - 950) / 2 : reference.inset;
            expect(reference.left, `${width} ${backend} ${clamp}: the Interface page's side`).toBeCloseTo(side, 0);
            for (const [id, frame] of Object.entries(frames)) {
                if (frame.error) { problems.push(`${width} ${backend}: ${frame.error}`); continue; }
                if (Math.abs(frame.left - reference.left) > 0.5) problems.push(`${width} ${backend} ${clamp} ${id}: left side ${frame.left}, not ${reference.left}`);
                if (Math.abs(frame.right - reference.left) > 0.5) problems.push(`${width} ${backend} ${clamp} ${id}: right side ${frame.right}, not ${reference.left}`);
                if (Math.abs(frame.top - reference.insetTop) > 1) problems.push(`${width} ${backend} ${id}: top space ${frame.top}, not ${reference.insetTop}`);
                if (Math.abs(frame.bottomGap - reference.bottomGap) > 1) problems.push(`${width} ${backend} ${id}: scroller (${frame.scroller}) ends ${frame.bottomGap}px above the page's bottom, Interface ${reference.bottomGap}px`);
            }
            expect(problems).toEqual([]);

            // An extension's own page, opened from its row, keeps the frame too, and Back returns to the list where it was.
            const extensions = await openSettingsTab(page, 'extensions', 'right');
            await expect.poll(() => extensions.locator('.sb-subpage-row').count()).toBeGreaterThan(0);
            for (const label of backend === 'openai' && clamp === 'on' ? ['Character Expressions', 'Quick Reply', 'Regex'] : []) {
                const scrolled = await page.evaluate(() => {
                    const list = document.querySelector('[data-sb-panel="extensions"] .sb-subpage-list');
                    list.scrollTop = 300;
                    return list.scrollTop;
                });
                await page.evaluate(name => [...document.querySelectorAll('[data-sb-panel="extensions"] .sb-subpage-row')].find(row => row.textContent.includes(name)).click(), label);
                const detail = extensions.locator('.sb-subpage-detail[aria-hidden="false"]');
                await expect(detail).toBeVisible();
                await page.waitForTimeout(300);
                const sides = await detail.evaluate(node => {
                    const panel = document.querySelector('[data-sb-panel="extensions"]').getBoundingClientRect();
                    const group = [...node.querySelectorAll('.ds-pref-group')].find(candidate => candidate.getClientRects().length).getBoundingClientRect();
                    const settingsPage = document.getElementById('sb-settings-page').getBoundingClientRect();
                    return { left: group.left - panel.left, right: panel.right - group.right, bottomGap: settingsPage.bottom - node.getBoundingClientRect().bottom };
                });
                expect(sides.left, `${label} left side at ${width} ${clamp}`).toBeCloseTo(reference.left, 0);
                expect(sides.right, `${label} right side at ${width} ${clamp}`).toBeCloseTo(reference.left, 0);
                expect(sides.bottomGap, `${label} page bottom at ${width}`).toBeCloseTo(reference.bottomGap, 0);
                await detail.locator('.sb-subpage-back').click();
                await expect(extensions.locator('.sb-subpage-detail[aria-hidden="false"]')).toHaveCount(0);
                expect(await page.evaluate(() => document.querySelector('[data-sb-panel="extensions"] .sb-subpage-list').scrollTop), `${label} list scroll at ${width}`).toBe(scrolled);
            }
        }
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
                // Gallery captions identify files and appear on hover or focus.
                for (const tile of root.querySelectorAll('.bg_example')) {
                    if (!visible(tile)) continue;
                    const filename = tile.getAttribute('title') || '';
                    const caption = tile.querySelector('.BGSampleTitle')?.textContent.trim();
                    if (!filename || !caption || caption !== filename.slice(0, filename.lastIndexOf('.'))) {
                        results.push(`${filename || 'unnamed background'}: gallery caption does not match its filename`);
                    }
                }
                for (const row of root.querySelectorAll('[title]')) {
                    if (!visible(row) || !row.matches('.ds-row, .ds-row-switch, .checkbox_label, .flex-container')) continue;
                    if (row.classList.contains('bg_example')) continue;
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

    test('Reasoning Template keeps visible copy and live preset controls across layouts', async ({ page }, testInfo) => {
        // Both settings layouts and their backend transitions run after app startup.
        test.slow();
        const actions = ['update', 'rename', 'new', 'import', 'export', 'restore', 'restore-defaults', 'delete'];
        const selectors = [
            '#reasoning_select', '#reasoning_prefix', '#reasoning_suffix', '#reasoning_separator',
            '[data-preset-manager-file="reasoning"]',
            ...actions.map(action => `[data-preset-manager-${action}="reasoning"]`),
        ];
        for (const selector of selectors) await expect(page.locator(selector)).toHaveCount(1);
        await page.evaluate(selectors => {
            window.__sbReasoningNodes = selectors.map(selector => document.querySelector(selector));
        }, selectors);

        const viewports = [
            { width: 1440, backend: 'openai' },
            { width: 390, backend: 'textgenerationwebui' },
        ];
        for (const { width, backend } of viewports) {
            await page.setViewportSize({ width, height: 900 });
            await switchBackend(page, backend);
            const prompting = await openSettingsTab(page, 'prompting');
            const row = prompting.locator('.ds-row:has(#reasoning_select)');
            const label = row.locator('.ds-row-label');
            const subtitle = row.locator('.ds-row-subtitle');
            await expect(label).toBeVisible();
            await expect(label).toHaveText('Reasoning Template');
            await expect(label).toHaveAttribute('data-i18n', 'Reasoning Template');
            await expect(subtitle).toBeVisible();
            await expect(subtitle).toHaveText('Select your current Reasoning Template');
            await expect(subtitle).toHaveAttribute('data-i18n', 'Select your current Reasoning Template');
            await expect(row).not.toHaveAttribute('title', /.+/);
            await expect(row.locator('[data-sb-copy-placeholder]')).toHaveCount(0);
            // The actions sit in the Template Actions menu; the upstream buttons stay in the document, in a holder the menu delegates to.
            await expect(row.getByRole('button', { name: 'Template Actions', exact: true })).toBeVisible();
            for (const action of actions) await expect(prompting.locator(`[data-sb-template-actions="reasoning"] [data-preset-manager-${action}="reasoning"]`)).toHaveCount(1);
            expect(await page.evaluate(selectors => window.__sbReasoningNodes.every((node, index) => node === document.querySelector(selectors[index])), selectors)).toBe(true);

            const select = row.locator('#reasoning_select');
            await expect(select).toHaveAttribute('data-preset-manager-for', 'reasoning');
            await select.selectOption('Blank');
            await expect(prompting.locator('#reasoning_prefix')).toHaveValue('');
            await select.selectOption('DeepSeek');
            await expect(prompting.locator('#reasoning_prefix')).toHaveValue('<think>\n');
            await expectNoHorizontalOverflow(row);
            await row.scrollIntoViewIfNeeded();
        }

        const layouts = [];
        for (const width of [1440, 320, 390, 620, 621, 768, 769]) {
            await page.setViewportSize({ width, height: 900 });
            const prompting = await openSettingsTab(page, 'prompting');
            const row = prompting.locator('.ds-row:has(#reasoning_select)');
            const select = row.locator('#reasoning_select');
            await expect(select).toHaveValue('DeepSeek');
            await expect(row.getByRole('button', { name: 'Template Actions', exact: true })).toBeVisible();
            expect(await page.evaluate(selectors => window.__sbReasoningNodes.every((node, index) => node === document.querySelector(selectors[index])), selectors)).toBe(true);
            await expectNoHorizontalOverflow(row);
            await row.scrollIntoViewIfNeeded();
            await page.evaluate(() => document.fonts.ready);
            layouts.push(await select.evaluate(control => {
                const suffix = control.closest('.ds-row-suffix');
                const trigger = suffix.querySelector('.ds-select-row__trigger');
                const value = trigger.querySelector('.ds-select-row__value');
                const style = getComputedStyle(value);
                const bounds = element => {
                    const { x, y, width, height } = element.getBoundingClientRect();
                    return { x, y, width, height };
                };
                return {
                    viewportWidth: window.innerWidth,
                    selectedText: value.textContent,
                    textWidth: value.scrollWidth,
                    availableTextWidth: value.clientWidth,
                    font: style.font,
                    select: bounds(trigger),
                    actions: bounds(suffix.querySelector('.ds-select-row__menu')),
                    row: bounds(control.closest('.ds-row')),
                };
            }));
            await page.screenshot({ path: testInfo.outputPath(`reasoning-template-${width}.png`) });
        }
        await testInfo.attach('reasoning-control-bounds', { body: JSON.stringify(layouts, null, 2), contentType: 'application/json' });
        expect(layouts.filter(layout => layout.availableTextWidth + 1 < layout.textWidth)).toEqual([]);

        const chooserPromise = page.waitForEvent('filechooser');
        await page.locator('[data-sb-panel="prompting"] .ds-row:has(#reasoning_select)').getByRole('button', { name: 'Template Actions', exact: true }).click();
        await page.locator('.sb-action-menu[role="menu"]').getByRole('menuitem', { name: 'Import…', exact: true }).click();
        const chooser = await chooserPromise;
        expect(await chooser.element().evaluate(input => input === document.querySelector('[data-preset-manager-file="reasoning"]'))).toBe(true);
    });

    test('Appearance includes the expected Theme Colors, Page Size, and Visual Toggles rows', async ({ page }) => {
        const appearance = await openSettingsTab(page, 'appearance', 'right');
        await expect(appearance.locator('[data-sb-category="theme-colors"] > .ds-pref-group')).toHaveCount(1);
        const colorRows = await appearance.locator('[data-sb-category="theme-colors"] > .ds-pref-group').evaluateAll(groups =>
            groups.map(group => group.querySelectorAll(':scope > .ds-row').length),
        );
        expect(colorRows).toEqual([10]);
        await expect(appearance.locator('[data-sb-category="page-size"] .ds-row-slider')).toHaveCount(7);
        await expect(appearance.locator('#sb-background-settings-controls #background-blur-block, #sb-background-settings-controls #background-opacity-block')).toHaveCount(2);
        // 19: Tags as Folders was retired for full folder support (#bogus_folders stays as a hidden transport), and Zen Sliders and
        // Mad Lab Mode are one Slider Mode choice of three, a toggle row.
        await expect(appearance.locator('[data-sb-category="visual-toggles"] .ds-row-switch')).toHaveCount(19);
        await expect(appearance.locator('[data-sb-category="visual-toggles"] #sb-slider-mode .sb-boolean-radio-option')).toHaveCount(3);
        await expect(appearance.locator('#bogus_folders')).toBeHidden();
        const themeMenu = appearance.locator('[data-sb-category="ui-theme"] .ds-select-row__menu');
        await expect(themeMenu).toHaveAccessibleName('Theme Actions');
        await expect(themeMenu).toHaveAttribute('title', 'Theme Actions');
        await expect(themeMenu).not.toHaveAttribute('data-sb-copy-placeholder', /.*/);
    });
});

test.describe('Backgrounds settings consistency', () => {
    test.describe.configure({ timeout: 60000 });

    for (const { name, width, theme, compact } of [
        { name: 'desktop', width: 1440, theme: 'Libadwaita Dark', compact: false },
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
                        referenceNoteSize: getComputedStyle(reference.parentElement.querySelector('.ds-pref-group-subtitle')).fontSize,
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
                const radiusFailures = await gallery.locator([
                    '#bg-filter', '#bg-sort',
                    '.sb-bg-sort-button', '#add_background_button_top', '#bg_tabs .heading-controls .menu_button',
                ].map(selector => `${selector}:visible`).join(', ')).evaluateAll((controls, minimumHeight) => controls.flatMap(control => {
                    const style = getComputedStyle(control);
                    const bounds = control.getBoundingClientRect();
                    const radii = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'];
                    const checks = {
                        controlRadius: radii.every(radius => style[radius] === '9px'),
                        comfortableTarget: bounds.height >= minimumHeight - 1,
                    };
                    return Object.entries(checks).filter(([, pass]) => !pass).map(([check]) => `${control.id}: ${check}`);
                }), mobile ? 44 : 40);
                expect(radiusFailures).toEqual([]);
                const circleFailures = await gallery.locator('#add_background_button_top, #bg_thumb_zoom_out, #bg_thumb_zoom_in, #bg-scroll-top, .sb-bg-list-menu, .sb-bg-sort-button')
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
        await expectAnimatedBackgroundStructure(appearance, { geometry: false });
        // The section order moves the panel out of the Backgrounds gallery at a time that depends on load, and the gallery's
        // button rules (`#sb-settings-page #Backgrounds .menu_button`) stop matching its buttons when it does. Measure where it ends up.
        await page.evaluate(() => document.getElementById('sb-appearance-content').append(document.getElementById('bpt-animated-bg-panel')));
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
                radius: style.borderRadius,
                focusRing: style.boxShadow !== 'none',
                selectedFill: card.backgroundColor !== 'rgba(0, 0, 0, 0)',
                noSelectionGlow: card.boxShadow === 'none',
            };
        });
        expect(metrics.targetHeight).toBeGreaterThanOrEqual(40);
        expect(metrics).toMatchObject({ radius: '9px', focusRing: true, selectedFill: true, noSelectionGlow: true });
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
                // The extension's layout wrappers (header, URL row, controls) give way to the group; its controls stay inside the panel.
                originalNodesRetained: fixture.nodes.filter(node => node.matches('input, label, button, #bpt-animated-bg-sources')).every(node => panel.contains(node)),
                originalIdsRetained: fixture.ids.every(([id, node]) => document.getElementById(id) === node && document.querySelectorAll(`#${id}`).length === 1),
                originalLabelsRetained: fixture.labels.every(label => label.parentElement === panel.querySelector(':scope > .ds-pref-group') && label.matches('.ds-row-switch')),
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
        // The URL field gained its title; the group's blocks need no space between them.
        const unspaced = text => text.replace(/\s+/g, '');
        expect(unspaced(preserved.text)).toBe(unspaced(preserved.originalText.replace('Use URL', 'Video URL Use URL')));
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

test.describe('Settings entry regressions', () => {
    for (const width of [1440, 390]) {
        test.describe(`${width}px`, () => {
            const mobile = width < 620;
            const mode = mobile ? 'mobile' : 'desktop';
            test.use({ viewport: { width, height: mobile ? 844 : 1000 }, hasTouch: mobile, locale: 'en-US' });

            test.beforeEach(async ({ page }) => {
                await page.addInitScript(() => {
                    localStorage.setItem('language', 'en');
                    localStorage.setItem('sb-right-tab', 'interface');
                });
            });

            test('cold Interface entry creates live normalized controls without visiting Appearance', async ({ page, baseURL }) => {
                const settingsStore = {};
                await loadSettings(page, baseURL, settingsStore);
                // The two bar switches are one stored value each on every device, so each has one switch, in the Bottom Bar group.
                const barIds = ['sb-desktop-bottom-bar-visible-input', 'sb-desktop-gg-bar-visible-input'];
                const ids = [`sb-${mode}-button-scale-input`, ...barIds];
                const interfacePanel = page.locator('[data-sb-panel="interface"]');
                const outlet = interfacePanel.locator(`#sb-${mode}-settings-outlet`);
                const bottomBar = interfacePanel.locator('#sb-bottom-bar-settings');
                // Compact Mode is one stored value on every device, so its one switch belongs to the page's first group.
                const firstGroup = interfacePanel.locator('#sb-interface-settings-body');

                const openInterface = async () => {
                    // One native entry only: a second tab activation can conceal initialization-order bugs.
                    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'interface'));
                    await expect(interfacePanel).toHaveAttribute('aria-hidden', 'false');
                    await expect.poll(() => page.evaluate(ids => ids.filter(id => !document.getElementById(id)), ids)).toEqual([]);
                    await expect(outlet).toHaveClass(/ds-pref-group/);
                    await expect(firstGroup).toHaveClass(/ds-pref-group/);
                    await expect(outlet.locator(`#sb-${mode}-button-scale-input`)).toBeVisible();
                    for (const id of barIds) {
                        const input = bottomBar.locator(`#${id}`);
                        await expect(input).toHaveCount(1);
                        await expect(input).toBeVisible();
                    }
                    await expect(bottomBar.locator('#sb-bottom-bar-scale-input')).toBeVisible();
                    await expect(page.locator('#sb-mobile-bottom-bar-visible-input, #sb-mobile-gg-bar-visible-input')).toHaveCount(0);
                    await expect(page.locator('[data-sb-bottom-bar-visible-input], [data-sb-gg-bar-visible-input]')).toHaveCount(2);
                    await expect(firstGroup.locator('#sb-compact-mode-input')).toBeVisible();
                    await expectSwitchSemantics(outlet);
                    await expectSwitchSemantics(bottomBar);
                    await expectSwitchSemantics(firstGroup);
                    const anatomy = await page.evaluate(({ ids, mode }) => ids.every(id => {
                        const input = document.getElementById(id);
                        const group = id.endsWith('button-scale-input') ? `sb-${mode}-settings-outlet` : 'sb-bottom-bar-settings';
                        return document.querySelectorAll(`[id="${id}"]`).length === 1
                            && input.closest('.ds-pref-group')?.id === group
                            && (input.type !== 'checkbox' || input.classList.contains('sb-switch') && Boolean(input.closest('.ds-row-switch')));
                    }) && document.querySelectorAll('[id$="compact-mode-input"]').length === 1
                        && document.getElementById('sb-compact-mode-input').closest('.ds-pref-group')?.id === 'sb-interface-settings-body', { ids, mode });
                    expect(anatomy).toBe(true);
                };

                await openInterface();
                await page.evaluate(ids => {
                    window.__sbInterfaceControlRefs = ids.map(id => document.getElementById(id));
                }, ids);
                const scale = outlet.locator(`#sb-${mode}-button-scale-input`);
                await scale.focus();
                await scale.press('Home');
                await scale.press('ArrowRight');
                await expect(scale).toHaveValue('75');
                await expect.poll(() => page.evaluate(mode => document.documentElement.style.getPropertyValue(`--sb-${mode}-button-scale`), mode)).toBe('0.75');

                await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'messages'));
                await openInterface();
                expect(await page.evaluate(ids => ids.every((id, index) => document.getElementById(id) === window.__sbInterfaceControlRefs[index]), ids)).toBe(true);
                await expect(scale).toHaveValue('75');

                await page.reload({ waitUntil: 'domcontentloaded' });
                await waitForAppReady(page, { timeout: 60000 });
                await openInterface();
                await expect(scale).toHaveValue('75');
                await scale.focus();
                await scale.press('ArrowRight');
                await expect(scale).toHaveValue('80');
                await expect.poll(() => page.evaluate(mode => document.documentElement.style.getPropertyValue(`--sb-${mode}-button-scale`), mode)).toBe('0.8');
            });

            if (!mobile) {
                test('the desktop Icons only switch is live, kept across tabs and reloads, and the phone switch is gone', async ({ page, baseURL }) => {
                    await loadSettings(page, baseURL);
                    const outlet = page.locator('[data-sb-panel="interface"] #sb-desktop-settings-outlet');
                    const iconsOnly = outlet.locator('#sb-desktop-topbar-icons-only-input');
                    const openInterface = async () => {
                        await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'interface'));
                        await expect(iconsOnly).toBeVisible();
                    };

                    await openInterface();
                    await expect(page.locator('[data-sb-panel="interface"] #sb-mobile-topbar-icons-only-input')).toHaveCount(0);
                    await expect(outlet.getByText('Show only icons in the desktop top bar', { exact: true })).toBeVisible();
                    const nextIconsOnly = !(await iconsOnly.isChecked());
                    await iconsOnly.setChecked(nextIconsOnly);
                    await expect(page.locator('html')).toHaveAttribute('data-sb-topbar-icons-only', String(nextIconsOnly));

                    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'messages'));
                    await openInterface();
                    await expect(iconsOnly).toBeChecked({ checked: nextIconsOnly });

                    await page.reload({ waitUntil: 'domcontentloaded' });
                    await waitForAppReady(page, { timeout: 60000 });
                    await openInterface();
                    await expect(iconsOnly).toBeChecked({ checked: nextIconsOnly });
                    await iconsOnly.setChecked(!nextIconsOnly);
                    await expect(page.locator('html')).toHaveAttribute('data-sb-topbar-icons-only', String(!nextIconsOnly));
                });
            }

            if (mobile) {
                test('the phone has no Icons only switch and its stored value is left alone', async ({ page, baseURL }) => {
                    await page.addInitScript(() => {
                        if (localStorage.getItem('sb-mobile-topbar-icons-only') === null) localStorage.setItem('sb-mobile-topbar-icons-only', 'true');
                    });
                    await loadSettings(page, baseURL);
                    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'interface'));
                    const interfacePanel = page.locator('[data-sb-panel="interface"]');
                    await expect(interfacePanel.locator('#sb-mobile-button-scale-input')).toBeVisible();
                    await expect(interfacePanel.locator('[id$="topbar-icons-only-input"]:visible')).toHaveCount(0);
                    await expect(interfacePanel.locator('#sb-mobile-topbar-icons-only-input')).toHaveCount(0);
                    await expect(interfacePanel.getByText('Mobile Navigation', { exact: true })).toHaveCount(0);
                    expect(await page.evaluate(() => localStorage.getItem('sb-mobile-topbar-icons-only'))).toBe('true');
                });
            }

            test('the Bottom Bar group follows the device groups and holds the size and both bar switches once', async ({ page, baseURL }) => {
                await loadSettings(page, baseURL);
                await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'interface'));
                const interfacePanel = page.locator('[data-sb-panel="interface"]');
                const headings = interfacePanel.locator('.sb-settings-category:visible > .sb-settings-category-header .ds-pref-group-heading');
                await expect(headings.first()).toHaveText('General');
                const titles = await headings.allTextContents();
                expect(titles.slice(0, 3)).toEqual(['General', mobile ? 'Mobile' : 'Desktop', 'Bottom Bar']);
                const group = interfacePanel.locator('.sb-settings-category[data-sb-category="bottom-bar"]');
                await expect(group).toHaveAttribute('data-sb-description', 'none');
                await expect(group.locator('.sb-settings-category-header small')).toHaveCount(0);
                const descriptionOf = id => interfacePanel.locator(`.sb-settings-category[data-sb-category="${id}"] .sb-settings-category-header small`);
                await expect(descriptionOf('interface')).toHaveText('Choose the splash character and Compact Mode');
                await expect(descriptionOf('mobile')).toHaveText('Adjust the button size on phones');
                for (const id of ['sb-bottom-bar-scale-input', 'sb-desktop-bottom-bar-visible-input', 'sb-desktop-gg-bar-visible-input']) {
                    await expect(group.locator(`#${id}`)).toBeVisible();
                }
                await expect(group.locator('.ds-row')).toHaveCount(3);
            });

            test('Compact Mode is one switch for the one stored value, whatever the width', async ({ page, baseURL }) => {
                await loadSettings(page, baseURL);
                await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'interface'));
                const interfacePanel = page.locator('[data-sb-panel="interface"]');
                await expect(interfacePanel.locator('[data-sb-compact-mode-input]')).toHaveCount(1);
                await expect(page.locator('#sb-desktop-compact-mode-input, #sb-mobile-compact-mode-input')).toHaveCount(0);
                const compact = interfacePanel.locator('#sb-compact-mode-input');
                await expect(compact).toBeVisible();
                const next = !(await compact.isChecked());
                await compact.setChecked(next);
                await expect(page.locator('html')).toHaveAttribute('data-sb-compact-mode', String(next));
                await expect.poll(() => page.evaluate(() => localStorage.getItem('sb-compact-mode'))).toBe(String(next));

                await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'messages'));
                await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'interface'));
                await expect(compact).toBeChecked({ checked: next });
                // The value is the same on both sides of the layout breakpoint.
                await page.setViewportSize({ width: mobile ? 1440 : 390, height: 900 });
                await expect(page.locator('html')).toHaveAttribute('data-sb-compact-mode', String(next));
                await expect(compact).toBeChecked({ checked: next });
                // A page that was open at the wider layout shows its sidebar first on a phone, where the page is inert.
                await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'interface'));
                await compact.setChecked(!next);
                await expect(page.locator('html')).toHaveAttribute('data-sb-compact-mode', String(!next));
            });

            if (!mobile) {
                test('the pin switch stores NavLockOn, drives the hidden pin and follows the stored value across tabs and reloads', async ({ page, baseURL }) => {
                    await loadSettings(page, baseURL, {});
                    const pin = page.locator('[data-sb-panel="interface"] #sb-desktop-pin-characters-input');
                    const stored = () => page.evaluate(() => window.SillyTavern.getContext().accountStorage.getItem('NavLockOn'));
                    const openInterface = async () => {
                        await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'interface'));
                        await expect(pin).toBeVisible();
                    };

                    await openInterface();
                    await expect(pin).toHaveAttribute('role', 'switch');
                    const pinRow = pin.locator('xpath=ancestor::*[contains(@class, "ds-row")][1]');
                    await expect(pinRow.locator('.ds-row-label')).toHaveText('Keep Characters Open');
                    await expect(pinRow.locator('.ds-row-subtitle')).toHaveText('The Characters page stays open after you pick a chat');
                    const next = !(await pin.isChecked());
                    // A reload must find the value in the settings that the page saved.
                    const saved = page.waitForRequest(request => request.url().includes('/api/settings/save'));
                    await pin.setChecked(next);
                    await saved;
                    await expect.poll(stored).toBe(String(next));
                    await expect(page.locator('#rm_button_panel_pin')).toBeChecked({ checked: next });
                    if (next) await expect(page.locator('#right-nav-panel')).toHaveClass(/pinnedOpen/);
                    else await expect(page.locator('#right-nav-panel')).not.toHaveClass(/pinnedOpen/);

                    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'messages'));
                    await openInterface();
                    await expect(pin).toBeChecked({ checked: next });

                    await page.reload({ waitUntil: 'domcontentloaded' });
                    await waitForAppReady(page, { timeout: 60000 });
                    await openInterface();
                    await expect(pin).toBeChecked({ checked: next });
                    await pin.setChecked(!next);
                    await expect.poll(stored).toBe(String(!next));
                });
            }

            test('the old pin and character list transports stay out of the layout in every menu type', async ({ page, baseURL }) => {
                await loadSettings(page, baseURL);
                const displays = await page.evaluate(() => {
                    const panel = document.getElementById('right-nav-panel');
                    const read = {};
                    for (const type of [null, 'characters', 'character_edit', 'create', 'group_edit']) {
                        if (type) panel.setAttribute('data-menu-type', type);
                        else panel.removeAttribute('data-menu-type');
                        read[String(type)] = ['rm_PinAndTabs', 'CharListButtonAndHotSwaps'].map(id => getComputedStyle(document.getElementById(id)).display);
                    }
                    return read;
                });
                for (const pair of Object.values(displays)) expect(pair).toEqual(['none', 'none']);
            });

            test('Interface has no Quick Actions group and leaves the old saved lists alone', async ({ page, baseURL }) => {
                const savedKeys = ['sb-desktop-quick-actions-v2', 'sb-mobile-quick-actions-v2', 'sb-mobile-quick-actions'];
                await page.addInitScript(keys => {
                    for (const key of keys) if (localStorage.getItem(key) === null) localStorage.setItem(key, 'orphan');
                }, savedKeys);
                await loadSettings(page, baseURL);
                await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'interface'));
                const interfacePanel = page.locator('[data-sb-panel="interface"]');
                await expect(interfacePanel).toHaveAttribute('aria-hidden', 'false');
                await expect(interfacePanel.locator('#sb-interface-settings-body')).toHaveClass(/ds-pref-group/);

                for (const kind of ['mobile', 'desktop']) {
                    await expect(interfacePanel.locator(`.sb-${kind}-quick-actions-group`)).toHaveCount(0);
                    await expect(interfacePanel.locator(`[id^="sb-${kind}-quick-action"]`)).toHaveCount(0);
                    await expect(interfacePanel.getByText(`${kind === 'mobile' ? 'Mobile' : 'Desktop'} Quick Actions`)).toHaveCount(0);
                }
                await expect(page.locator('#sb-mobile-nav')).toHaveCount(0);
                await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'messages'));
                await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'interface'));
                await expect(interfacePanel.locator('.sb-mobile-quick-actions-group')).toHaveCount(0);
                expect(await page.evaluate(keys => keys.map(key => localStorage.getItem(key)), savedKeys)).toEqual(['orphan', 'orphan', 'orphan']);
            });

            test('native enlarged avatar stays hidden during settings and returns unchanged on close', async ({ page, baseURL }) => {
                await loadSettings(page, baseURL);
                await page.evaluate(async () => {
                    const native = await import('/script.js');
                    const message = {
                        name: 'Portrait verification', is_user: false, is_system: false,
                        mes: 'Disposable portrait verification message.', send_date: new Date().toISOString(),
                        force_avatar: '/img/ai4.png', extra: {},
                    };
                    native.chat.push(message);
                    native.addOneMessage(message, { forceId: native.chat.length - 1, scroll: false, showSwipes: false });
                });
                // Invoke the rendered message's native avatar handler; do not inject a portrait fixture.
                await page.locator('#chat .mes .avatar').last().evaluate(avatar => avatar.click());
                const portrait = page.locator('body > .zoomed_avatar[forchar]');
                await expect(portrait).toBeVisible();
                const original = await portrait.evaluate(node => {
                    window.__sbPortraitRef = node;
                    const bounds = node.getBoundingClientRect();
                    return {
                        x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
                        style: node.getAttribute('style'), src: node.querySelector('img').getAttribute('src'),
                    };
                });
                const point = {
                    x: Math.max(1, Math.min(width - 1, original.x + original.width / 2)),
                    y: Math.max(1, Math.min((mobile ? 844 : 1000) - 1, original.y + original.height / 2)),
                };
                const portraitHit = () => page.evaluate(point => Boolean(window.__sbPortraitRef?.contains(document.elementFromPoint(point.x, point.y))), point);
                await expect.poll(portraitHit).toBe(true);
                const settingsPage = page.locator('#sb-settings-page');

                for (const [shell, tab] of [['left', 'connections'], ['right', 'interface'], ['characters', 'characters']]) {
                    await page.evaluate(({ shell, tab }) => window.SillyBunnyShell.openTab(shell, tab), { shell, tab });
                    await expect(settingsPage).toBeVisible();
                    await expect(portrait).toHaveCount(1);
                    expect(await portrait.evaluate(node => node === window.__sbPortraitRef)).toBe(true);
                    await expect.soft(portrait, `${shell} settings must conceal the portrait`).not.toBeVisible({ timeout: 1500 });
                    expect.soft(await portraitHit(), `${shell} settings must receive input instead of the portrait`).toBe(false);
                    expect.soft(await page.evaluate(point => document.getElementById('sb-settings-page').contains(document.elementFromPoint(point.x, point.y)), point)).toBe(true);

                    await page.locator('#sb-settings-close').click();
                    await expect(settingsPage).toBeHidden();
                    await expect(portrait).toBeVisible();
                    await expect.poll(portraitHit).toBe(true);
                    const restored = await portrait.evaluate(node => {
                        const bounds = node.getBoundingClientRect();
                        return {
                            sameNode: node === window.__sbPortraitRef,
                            x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
                            style: node.getAttribute('style'), src: node.querySelector('img').getAttribute('src'),
                        };
                    });
                    expect(restored).toEqual({ sameNode: true, ...original });
                }

                await portrait.hover();
                await portrait.locator('.dragClose').click();
                await expect(portrait).toHaveCount(0);
                await expect(page.locator('#zoomed_avatar_template .zoomed_avatar')).toHaveCount(1);
            });
        });
    }
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
        await prompting.locator('[data-sb-preset-row]:visible').getByRole('button', { name: 'Preset Menu', exact: true }).click();
        // A bundled preset disables Update, and a press on it then does nothing, like the original button.
        await page.locator('.sb-action-menu[role="menu"]').getByRole('menuitem', { name: 'Update', exact: true }).click({ force: true });
        await page.evaluate(async () => {
            const { saveSettings } = await import('/script.js');
            await saveSettings();
        });
        expect(settingsStore.saved).toBeTruthy();

        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAppReady(page, { timeout: 60000 });
        await switchBackend(page, 'openai');
        const reloadedPrompting = await openSettingsTab(page, 'prompting');
        await expect(reloadedPrompting.locator('#respective-presets-block #settings_preset_openai')).toHaveValue(selectedValue);
    });
});
