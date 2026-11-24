import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { waitForAppReady } from './helpers/app-ready.js';
import { acceptPopup } from './helpers/popup.js';
import { auditPromptingLayout } from './helpers/libadwaita-audit.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';
import { applyWelcomeSettings } from './helpers/welcome-dialog.js';
import { selectTheme } from './helpers/page-contrast.js';
import { expectToggleGroupForm, SELECTION_TONES } from './helpers/selection-forms.js';
import { getWatchEntriesForApi } from '../public/scripts/extensions/connection-manager/profile-change-model.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });

const BACKEND_CATEGORY_TITLE = ':scope > .sb-settings-flat-header .sb-settings-category-title, :scope > .sb-settings-flat-header b';

/**
 * The names of the visible groups, in order: a group's heading, or, for a group whose one row carries the title and so
 * has no heading, the label that names its box. A group with neither is left out, as the heading locator left it out.
 */
async function groupNames(groups) {
    return groups.evaluateAll((elements, titleSelector) => elements
        .filter(element => {
            const box = element.getBoundingClientRect();
            return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
        })
        .map(element => {
            const heading = element.querySelector(titleSelector);
            if (heading) return heading.textContent.replace(/\s+/g, ' ').trim();
            return element.querySelector('[role="group"][aria-label]')?.getAttribute('aria-label') ?? null;
        })
        .filter(name => name !== null), BACKEND_CATEGORY_TITLE);
}

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
            const extensions = await fetchJsonOrSkip(route);
            if (!extensions) return;
            return route.fulfill({ json: extensions.filter(extension => !extension.name.startsWith('third-party/')) });
        }
        if (url.pathname === '/api/settings/get') {
            const data = await fetchJsonOrSkip(route);
            if (!data) return;
            data.request_compression = { ...data.request_compression, enabled: false };
            const settings = settingsStore?.saved ?? JSON.parse(data.settings);
            settings.firstRun = false;
            // The guard specs expect the discard prompt, and the app skips it when autosave is on, which a first-run account has by default.
            settings.power_user.sb_preset_autosave = false;
            applyWelcomeSettings(settings);
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
    await waitForAppReady(page);
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

async function expectSwitchGeometry(root) {
    const readFailures = () => root.locator('input[type="checkbox"]:visible').evaluateAll(inputs => inputs.flatMap(input => {
        // A check row picks one of several (the mobile Top Bar Label): a check, not a switch.
        if (input.closest('.ds-row-check')) return [];
        const row = input.closest('.ds-row-switch');
        const id = input.id || input.dataset.name || input.getAttribute('aria-label');
        if (!row) return [`${id}: missing switch row`];
        const style = getComputedStyle(row);
        const rowRect = row.getBoundingClientRect();
        const switchRect = input.getBoundingClientRect();
        // A switch row from the row factory holds the switch itself; an adopted one wraps it in a suffix.
        const suffix = input.closest('.ds-row-suffix') ?? input;
        const metrics = {
            padding: style.padding === '6px 12px',
            gap: style.gap === '6px',
            minHeight: parseFloat(style.minHeight) === 50,
            suffixWidth: Math.abs(suffix.getBoundingClientRect().width - 46) <= 1,
            rightInset: Math.abs(rowRect.right - switchRect.right - parseFloat(style.borderRightWidth) - 12) <= 1,
            centered: Math.abs(switchRect.top + switchRect.height / 2 - rowRect.top - rowRect.height / 2) <= 1,
        };
        return Object.entries(metrics).filter(([, pass]) => !pass).map(([metric]) => `${id}: ${metric}`);
    }));
    await expect.poll(readFailures, { timeout: 5000 }).toEqual([]);
}

async function expectPromptingFlow(prompting, api) {
    const categoryTitles = prompting.locator(':is(#respective-presets-block, #common-gen-settings-block):visible > .sb-settings-flat-header .sb-settings-category-title');
    await expect(categoryTitles).toHaveCount(api === 'openai' ? 1 : 2);
    expect(await categoryTitles.evaluateAll(titles => titles.filter(title => title.dataset.i18n !== title.textContent.trim()).map(title => title.textContent))).toEqual([]);
    if (api !== 'openai') {
        // NovelAI's loose phrase, preamble and banned token blocks are groups of their own, after Character Names.
        const novelGroups = api === 'novel' ? ['Phrase Repetition Penalty', 'Preamble', 'Banned Tokens'] : [];
        await expect.poll(() => groupNames(prompting.locator('.sb-prompting-group'))).toEqual([
            'Presets', 'Generation Settings', 'System Prompt', 'Instruct Template', 'Context Template', 'Character Names', ...novelGroups, 'Reasoning Template',
        ]);
        return;
    }
    await expect.poll(() => groupNames(prompting.locator('.sb-prompting-group'))).toEqual([
        'Presets', 'Preset API/Sampler Linking', 'Generation Settings', 'Character Names Behavior', 'Continue Postfix',
        'System Messages', 'Reply Prefill', 'Request Options', 'Enable function calling', 'Send inline media',
        'Request model reasoning', 'Prompt Caching', 'Reasoning Template',
    ]);
    await expect(prompting.locator('#completion_prompt_manager')).toHaveCount(0);
    await expect(prompting.locator('.openai-tab-buttons, .sb-subpage')).toHaveCount(0);
}

const PRESET_ACTION_ORIGINALS = [
    '[data-preset-manager-import]', '[data-preset-manager-export]', '[data-preset-manager-update]',
    '[data-preset-manager-rename]', '[data-preset-manager-new]', '[data-preset-manager-restore]',
    '[data-preset-manager-restore-defaults]', '[data-preset-manager-delete]', '[data-preset-manager-delete-all]',
    '#import_oai_preset', '#export_oai_preset', '#update_oai_preset', '#new_oai_preset', '#delete_oai_preset',
    '#af_master_import', '#af_master_export',
].join(', ');

const PRESET_MENU_LABELS = {
    openai: [['Update', 'Rename…', 'Save As…'], ['Import…', 'Export…'], ['Delete…', 'Delete in Bulk…']],
    textgenerationwebui: [
        ['Update…', 'Rename…', 'Save As…'], ['Import…', 'Export', 'Master Import…', 'Master Export…'],
        ['Restore…', 'Restore Default Presets…'], ['Delete…', 'Delete in Bulk…'],
    ],
    kobold: [
        ['Update…', 'Rename…', 'Save As…'], ['Import…', 'Export', 'Master Import…', 'Master Export…'],
        ['Restore…', 'Restore Default Presets…'], ['Delete…'],
    ],
};

async function choosePresetAction(page, prompting, label) {
    await prompting.locator('[data-sb-preset-row]:visible').getByRole('button', { name: 'Preset Menu', exact: true }).click();
    await page.locator('.sb-action-menu[role="menu"]').getByRole('menuitem', { name: label, exact: true }).click();
}

async function expectPresetRow(page, prompting, api) {
    // The template groups below keep their own preset buttons, so only the Presets group is checked.
    await expect(prompting.locator(`#respective-presets-block :is(${PRESET_ACTION_ORIGINALS}):visible`)).toHaveCount(0);
    const row = prompting.locator('#respective-presets-block [data-sb-preset-row]:visible');
    await expect(row).toHaveCount(1);
    await expect(row.locator('.ds-row-label')).toHaveText('Preset');
    const selected = await row.locator('select').evaluate(select => select.selectedOptions[0]?.textContent.replace(/\s+/g, ' ').trim() ?? '');
    await expect(row.locator('.ds-select-row__value')).toHaveText(selected);

    const menuButton = row.getByRole('button', { name: 'Preset Menu', exact: true });
    await menuButton.click();
    const menu = page.locator('.sb-action-menu[role="menu"]');
    await expect(menu).toBeVisible();
    const sections = await menu.evaluate(element => [...element.children].reduce((result, child) => {
        if (child.matches('[role="separator"]')) result.push([]);
        else if (child.matches('.sb-action-menu-item')) result.at(-1).push({
            label: child.querySelector('.sb-action-menu-label')?.textContent.trim(),
            icon: Boolean(child.querySelector('i')),
            danger: child.classList.contains('is-danger'),
        });
        return result;
    }, [[]]));
    const expected = PRESET_MENU_LABELS[api] ?? PRESET_MENU_LABELS.kobold;
    expect(sections.map(section => section.map(item => item.label))).toEqual(expected);
    expect(sections.flat().filter(item => !item.icon)).toEqual([]);
    expect(sections.map(section => section.map(item => item.danger))).toEqual(expected.map((section, index) => section.map(() => index === expected.length - 1)));
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(menuButton).toBeFocused();
}

async function expectPromptingInsets(prompting) {
    expect((await prompting.evaluate(auditPromptingLayout)).filter(record => !record.pass)).toEqual([]);
}

async function readBackendHeaderMetrics(header) {
    return header.evaluate(element => {
        const style = getComputedStyle(element);
        const titleRow = element.querySelector(':scope > .sb-backend-title-row');
        const note = element.querySelector(':scope > p');
        const noteStyle = note ? getComputedStyle(note) : null;
        return {
            padding: style.padding,
            rowGap: style.rowGap,
            // One line under the page header, without a box.
            boxed: parseFloat(style.borderTopWidth) > 0 || style.backgroundColor !== 'rgba(0, 0, 0, 0)',
            titleRowHeight: titleRow?.getBoundingClientRect().height ?? 0,
            note: note?.textContent.trim() ?? null,
            noteWraps: noteStyle ? noteStyle.whiteSpace !== 'nowrap' : null,
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
        // Banned Tokens/Strings has no description yet, and keeps the translation key the upstream heading uses.
        const banned = header.closest('[data-sb-sampling-group="banned"]');
        if (!title?.textContent.trim() || title.dataset.i18n !== (banned ? 'Banned Tokens' : title.textContent.trim())) failures.push('missing title localization key');
        if (!banned && (!subtitle?.textContent.trim() || /(?:lorum|lorem) ipsum/i.test(subtitle.textContent))) failures.push('missing category subtitle');
        if (!banned && subtitle?.dataset.i18n !== subtitle?.textContent.trim()) failures.push('missing subtitle localization key');
        return failures.map(failure => `${title?.textContent}: ${failure}`);
    }))).toEqual([]);
    if (api !== 'textgenerationwebui') return;
    await expect.poll(() => groupNames(sampling.locator('.sb-sampling-group'))).toEqual([
        'Sampling', 'Penalties & Repetition', 'Advanced Algorithms', 'Token Control', 'Banned Tokens/Strings', 'Output & Generation',
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
    if (api === 'openai') await acceptPopup(page.locator('dialog[open]'));
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

for (const theme of ['Libadwaita Dark', 'Libadwaita Light']) {
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
                await expect(promptingHeader.locator(':scope > p')).toHaveCount(0);
                await expect(promptingHeader.locator('[data-sb-copy-placeholder]')).toHaveCount(0);
                await expect(promptingHeader.locator('.sb-backend-disclaimer, button')).toHaveCount(0);
                expect(await promptingHeader.evaluate(header => {
                    const container = header.parentElement.getBoundingClientRect();
                    const box = header.getBoundingClientRect();
                    return Math.abs(box.left - container.left) <= 1 && Math.abs(box.right - container.right) <= 1;
                })).toBe(true);
                await expectPromptingFlow(prompting, api);
                await expectPresetRow(page, prompting, api);
                await expectPromptingInsets(prompting);
                const promptingHeaderMetrics = await readBackendHeaderMetrics(promptingHeader);
                await expect(prompting.locator('#sb-openai-sampling')).toBeHidden();
                await expect(prompting.locator('[name="startReplyWithBlock"]')).toHaveCount(0);
                await expect(page.locator('#AdvancedFormatting #sb-af-reply-prefix [name="startReplyWithBlock"]')).toHaveCount(1);
                await expectNoOverflow(prompting);
                await expectSwitchGeometry(prompting);
                const editor = await openPanel(page, 'editor');
                // The page has no backend line and no boxed list: the prompt list starts under the page header, and its header bar
                // carries the context (presets · backend · counts), the way back to Presets and the state badges.
                await expect(editor.locator('.sb-prompt-owned > .sb-backend-section-header, .sb-editor-meta, .sb-sampling-mode-pill')).toHaveCount(0);
                const listHeader = editor.locator('.sb-prompt-list-header');
                await expect(listHeader.locator('[data-sb-editor-mode]')).toHaveText(label);
                await expect(listHeader.locator('[data-sb-editor-preset]')).not.toHaveText('');
                await expect(listHeader.locator('.sb-list-header__subtitle')).toHaveAttribute('title', new RegExp(`${label}`));
                /* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- the Editor header holds Presets in a button or in the menu by its width */
                if (page.viewportSize().width > 600) {
                    const presetsButton = listHeader.locator('[data-sb-editor-presets]');
                    await expect(presetsButton).toHaveAccessibleName('Presets');
                    await expect(presetsButton).toHaveAttribute('title', 'Presets');
                    await expect(presetsButton).toHaveJSProperty('tagName', 'BUTTON');
                    await expect(listHeader.locator('.sb-list-header__button:visible').first()).toHaveAttribute('data-sb-editor-presets', '');
                } else if (api === 'openai') {
                    // A bar too narrow for the title, the states and every button moves Presets into the list's ⋮ menu.
                    await expect(listHeader).toHaveAttribute('data-narrow', 'true');
                    await expect(listHeader.locator('[data-sb-editor-presets]')).toBeHidden();
                    await listHeader.getByRole('button', { name: 'Prompt List Actions', exact: true }).click();
                    await expect(page.getByRole('menuitem', { name: 'Presets', exact: true })).toHaveAttribute('data-sb-editor-presets', '');
                    await page.keyboard.press('Escape');
                }
                /* eslint-enable playwright/no-conditional-in-test, playwright/no-conditional-expect */
                // The list has the top space of every settings page and of the Characters window's list pages (World Info, Persona) above the phone layout, and 14px in it.
                const frameTop = await editor.evaluate((panel, phone) => {
                    const probe = document.createElement('div');
                    probe.style.paddingTop = phone ? '14px' : 'var(--sb-settings-inset-top)';
                    panel.append(probe);
                    const top = parseFloat(getComputedStyle(probe).paddingTop);
                    probe.remove();
                    return top;
                }, width <= 768);
                expect(await editor.evaluate(panel => panel.querySelector('.sb-prompt-editor').getBoundingClientRect().top - panel.getBoundingClientRect().top)).toBeCloseTo(frameTop, 0);
                // The title of the list is a heading in the Title role.
                const groupHeading = await prompting.locator('.ds-pref-group-heading').first().evaluate(heading => ({ size: getComputedStyle(heading).fontSize, weight: getComputedStyle(heading).fontWeight }));
                await expect(editor.locator('.sb-prompt-list-header .sb-list-header__title')).toHaveCSS('font-size', groupHeading.size);
                await expect(editor.locator('.sb-prompt-list-header .sb-list-header__title')).toHaveCSS('font-weight', groupHeading.weight);
                // A group with no rows has no heading, and no prompt is available here.
                await expect(editor.locator('.sb-prompt-section:visible h3')).toHaveText(api === 'openai'
                    ? ['Prompt Order', 'Utility Prompts'] : ['System prompt', 'Context', 'Instruct']);
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
                expect(samplingHeaderMetrics.boxed || promptingHeaderMetrics.boxed).toBe(false);
                expect(promptingHeaderMetrics.note).toBeNull();
                expect(samplingHeaderMetrics.note).toBe('Some backends ignore samplers they do not support');
                expect(samplingHeaderMetrics.noteWraps).toBe(true);
                await expectSamplingTaxonomy(sampling, api);
                await expectNoOverflow(sampling);
                await sampling.locator('.ds-row-expander__toggle[aria-expanded="false"]').evaluateAll(toggles => toggles.forEach(toggle => toggle.click()));
                await expectSwitchGeometry(sampling);
            }
            for (const tab of ['appearance', 'interface', 'messages', 'data-security']) {
                const panel = await openPanel(page, tab, 'right');
                await expectSwitchGeometry(panel);
                await expectNoOverflow(panel);
            }
            const logs = await openPanel(page, 'logs', 'right');
            await expect(logs.locator('.sb-console-log-verbose-action')).toBeVisible();
            const consoleLogs = logs.locator('.sb-settings-category-body');
            await expect(consoleLogs).toHaveCount(1);
            await expect(consoleLogs.locator(':scope > .ds-row, :scope > .sb-console-log-frame')).toHaveCount(5);
            await expect(consoleLogs.locator(':scope > .sb-console-log-frame')).toHaveCSS('padding-left', '12px');
            await expect(consoleLogs.locator(':scope > .ds-button-row')).toHaveText([/Refresh Now/, /(Pause|Resume) Live/]);
            await expect(consoleLogs.locator(':scope > .ds-row-switch:has(.sb-console-log-verbose-action)')).toHaveCount(1);
            await expectSwitchGeometry(logs);
            await expectNoOverflow(logs);
        });
    }
}

test('Sampling uses the shared full-width rows at desktop and mobile widths', async ({ page, baseURL }) => {
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
    const rowHeights = await rows.evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
    expect(rowHeights.length).toBeGreaterThan(0);
    expect(rowHeights.every(height => height + 1 >= 50)).toBe(true);
    await expect.poll(() => rows.evaluateAll(rows => rows.every(row => {
        const style = getComputedStyle(row);
        return style.padding === '6px 12px' && parseFloat(style.minHeight) === 50;
    }))).toBe(true);
    for (const selector of ['#dryBlock', '#xtc_block']) {
        const expander = sampling.locator(`.ds-row-expander[data-sb-sampling-control="${selector}"]`);
        await expander.locator('.ds-row-expander__toggle').first().click();
        await expect(expander.locator('.ds-row-expander__toggle').first()).toHaveAttribute('aria-expanded', 'true');
        await expect.poll(() => expander.evaluate(expander => Math.abs(expander.getBoundingClientRect().width - expander.parentElement.clientWidth))).toBeLessThanOrEqual(1);
        await expect.poll(() => expander.locator('.ds-row-expander-content .ds-row:visible').evaluateAll(rows => rows.every(row => {
            const rect = row.getBoundingClientRect();
            // A text-area field has no text column; its label row starts at the inset instead.
            const text = row.querySelector('.ds-row-text, .ds-row-textarea__label-row')?.getBoundingClientRect();
            return text && Math.abs(text.left - rect.left - 12) <= 1 && getComputedStyle(row).display === 'flex';
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
    await expect.poll(() => groupNames(formatting.locator('.sb-formatting-group'))).toEqual([
        'Stopping Strings', 'Reply Prefix', 'Text Cleanup', 'Reasoning', 'Add to Prompts', 'Rendering',
    ]);
    await expect(formatting.locator('#sb-af-reply-prefix #start_reply_with')).toBeVisible();
    await expect(formatting.locator('#advanced-formatting-cc-notice')).toBeHidden();
    await expect(formatting.locator('#reasoning_select, #reasoning_prefix, #reasoning_suffix, #reasoning_separator')).toHaveCount(0);
    await expect(formatting.locator('#reasoning_auto_parse, #reasoning_auto_expand, #reasoning_show_hidden, #reasoning_add_to_prompts, #reasoning_max_additions')).toHaveCount(5);

    await selectBackend(page, 'textgenerationwebui', 'ooba');
    const textFormatting = await openPanel(page, 'context');
    await expect.poll(() => groupNames(textFormatting.locator('.sb-formatting-group'))).toEqual([
        'Tokenizer & Padding', 'Stopping Strings', 'Reply Prefix', 'Text Cleanup', 'Reasoning', 'Add to Prompts', 'Rendering', 'Advanced Formatting',
    ]);
});

test('Backend tabs, aliases and Presets/Editor links are stable in every mode', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    for (const api of ['openai', 'textgenerationwebui', 'kobold', 'koboldhorde', 'novel']) {
        await selectBackend(page, api);
        const presets = await openPanel(page, 'prompting');
        await expect(page.locator('#sb-settings-tab-list button')).toHaveText(['Connections', 'Sampling', 'Presets', 'Editor', 'Formatting', 'Agents']);
        await expect(page.locator('[data-sb-settings-tab="prompting"]')).toHaveAttribute('data-sb-search-aliases', 'Prompting|Presets|Update Preset|Save Preset As|Rename Preset|Import Preset|Export Preset|Delete Preset|reasoning');
        await expect(page.locator('[data-sb-settings-tab="context"]')).toHaveAttribute('data-sb-search-aliases', 'Context|Advanced Formatting|reasoning');
        await expect(page.locator('[data-sb-settings-tab="editor"]')).toHaveAttribute('data-sb-search-aliases', 'Prompt Manager|Prompts');
        const edit = presets.getByRole('button', { name: 'Edit Prompts', exact: true });
        // The Characters list can load the deferred Editor stylesheet first, so it is switched off to check the row's own style.
        expect(await edit.evaluate(row => {
            const editorSheet = document.getElementById('deferred-editor-shell-css');
            if (editorSheet) editorSheet.disabled = true;
            const cursor = getComputedStyle(row).cursor;
            if (editorSheet) editorSheet.disabled = false;
            return cursor;
        })).toBe('pointer');
        await expect(edit.locator('.ds-row__chevron')).toBeVisible();
        // The preset row above draws the separator, so a top border here would double it.
        await expect(edit).toHaveCSS('border-top-width', '0px');
        expect(await edit.evaluate(row => {
            const previous = row.previousElementSibling;
            return previous?.matches('[data-sb-preset-row]') || previous?.querySelector('[data-sb-preset-row]')?.checkVisibility();
        })).toBe(true);
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
    for (const [query, tab] of [['Prompting', 'prompting'], ['Import Preset', 'prompting'], ['Prompt Manager', 'editor'], ['Prompts', 'editor']]) {
        await search.fill(query);
        await expect(page.locator(`[data-sb-settings-tab="${tab}"]`)).not.toHaveClass(/sb-settings-tab--filtered/);
    }
});

test('Preset Menu Import opens the file picker of the active backend', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    for (const api of ['openai', 'textgenerationwebui', 'kobold', 'novel']) {
        await selectBackend(page, api);
        const prompting = await openPanel(page, 'prompting');
        const chooser = page.waitForEvent('filechooser');
        await choosePresetAction(page, prompting, 'Import…');
        expect((await chooser).isMultiple()).toBe(false);
        await expect(page.locator('.sb-action-menu[role="menu"]')).toBeHidden();
    }
});

test('Preset API/Sampler Linking is a Chat Completions group of its own after Presets', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    await selectBackend(page, 'openai', 'openrouter');
    const prompting = await openPanel(page, 'prompting');
    const linking = prompting.locator('#sb-preset-linking');
    await expect(linking).toBeVisible();
    expect(await linking.evaluate(group => group.previousElementSibling?.id)).toBe('respective-presets-block');
    await expect(linking.locator('.ds-row-label')).toHaveText([
        'Keep API/Model Linked to Preset', 'Keep Sampling Settings Linked to Preset', 'Remember Sampling Settings per Model',
    ]);
    await expect(prompting.locator('#openai_api-presets :is(.inline-drawer, .sb-settings-flat-section)')).toHaveCount(0);
    // The copy blocks' `flex: 1 1 320px` basis was written for a row parent and becomes a height floor in a column.
    expect(await linking.locator('.sb-setting-inline-copy').evaluateAll(blocks => blocks.map(block => block.getBoundingClientRect().height < 150))).toEqual([true, true, true]);
    // One subtitle per row: the description of the current mode, with no recommendation line after it (F-127).
    await expect(linking.locator('strong.toggle-description')).toHaveCount(0);
    for (const id of ['bind_preset_to_connection', 'bind_preset_to_sampling']) {
        await expect(linking.locator(`#${id}_copy`)).toHaveText(/^(Linked|Independent) mode: choosing a preset [^.]+$/);
    }

    await page.evaluate(() => window.SillyBunnyShell.openGlobalSearch());
    await page.locator('#sb-universal-search input').fill('Preset API/Sampler Linking');
    const result = page.getByRole('group', { name: 'Backend · Presets', exact: true })
        .getByRole('option', { name: 'Preset API/Sampler Linking Jump to setting', exact: true });
    await expect(result).toHaveCount(1);
    await result.click();
    await expect(linking.locator('.sb-settings-category-title')).toBeInViewport();

    await selectBackend(page, 'textgenerationwebui', 'ooba');
    await openPanel(page, 'prompting');
    await expect(linking).toBeHidden();
});

test('The Reasoning groups of Formatting and Presets open each other and carry their captions', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    for (const api of ['openai', 'textgenerationwebui']) {
        await selectBackend(page, api, api === 'openai' ? 'openrouter' : 'ooba');
        const formatting = await openPanel(page, 'context');
        const reasoning = formatting.locator('#sb-af-reasoning');
        await expect(reasoning.locator('.sb-settings-category-heading > small')).toHaveText('These settings apply to every chat, whichever template is chosen');
        await expect(reasoning.locator('[data-sb-copy-placeholder]')).toHaveCount(0);
        await reasoning.getByRole('button', { name: 'Reasoning Template', exact: true }).click();
        const prompting = page.locator('[data-sb-panel="prompting"]');
        const template = prompting.locator('#sb-reasoning-template');
        await expect(template.locator('.sb-settings-category-title')).toBeInViewport();
        await expect(template.locator('.sb-settings-category-heading > small')).toHaveText('Saves the reasoning prefix, suffix and separator under a name');
        await expect(template.locator('[data-sb-copy-placeholder]')).toHaveCount(0);
        await template.getByRole('button', { name: 'Reasoning', exact: true }).click();
        await expect(reasoning.locator('.sb-settings-category-title')).toBeInViewport();
    }
});

test('Formatting ends with the Advanced Formatting group: its documentation link and the upstream Master Import and Export buttons', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    await selectBackend(page, 'textgenerationwebui', 'ooba');
    const formatting = await openPanel(page, 'context');
    const group = formatting.locator('#sb-af-advanced');
    await expect(formatting.locator('.sb-formatting-group:visible').last()).toHaveAttribute('id', 'sb-af-advanced');
    await expect(group.locator('.sb-settings-category-title')).toHaveText('Advanced Formatting');
    await expect(group.locator('.sb-settings-category-title-row > a.notes-link')).toHaveAccessibleName('Help');
    await expect(group.locator('.sb-settings-category-heading > small')).toHaveCount(0);
    await expect(group.locator('.ds-row-label')).toHaveText(['Master Import', 'Master Export']);
    // The buttons are the upstream nodes: their ids and handlers are what the preset manager bound.
    for (const id of ['af_master_import', 'af_master_export']) {
        await expect(group.locator(`.ds-row > .ds-row-suffix > #${id}`)).toBeVisible();
        await expect(page.locator(`#${id}`)).toHaveCount(1);
    }
    await expect(group.locator(':scope > #af_master_import_file')).toHaveCount(1);
    await expect(formatting.locator('#AdvancedFormatting > .sb-settings-flat-header:visible, #AdvancedFormatting > .flex-container:visible')).toHaveCount(0);
    const chooser = page.waitForEvent('filechooser');
    await group.locator('#af_master_import').click();
    expect((await chooser).isMultiple()).toBe(false);

    await selectBackend(page, 'openai', 'makersuite');
    await openPanel(page, 'context');
    await expect(group).toBeHidden();
    await selectBackend(page, 'kobold');
    await openPanel(page, 'context');
    await expect(group.locator('#af_master_export')).toBeVisible();
});

test('System Messages is the former Character Names & Prompt Formatting group, which the settings search still finds by that title', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    await selectBackend(page, 'openai', 'makersuite');
    const prompting = await openPanel(page, 'prompting');
    const group = prompting.locator('#sb-openai-names');
    await expect(group.locator('.sb-settings-category-title')).toHaveText('System Messages');
    await expect(group.locator('.sb-settings-category-heading > small')).toHaveText('Choose how system messages and the system prompt are sent.');
    await expect(group).toHaveAttribute('data-sb-search-aliases', 'Character Names & Prompt Formatting');
    await expect(group.locator('.ds-row-label:visible')).toHaveText(['Squash system messages', 'Use system prompt']);

    const toggle = page.locator('#sb-settings-search-toggle');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await page.locator('#sb-settings-search-input').fill('Prompt Formatting');
    await expect(group).toBeVisible();
    // The search hides what does not match with aria-hidden.
    await expect(prompting.locator('#sb-openai-request')).toHaveAttribute('aria-hidden', 'true');
    await expect(group).not.toHaveAttribute('aria-hidden', 'true');
});

test('Max prompt cost is a property row of Generation Settings, shown for the providers that price a prompt', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    const costs = { openrouter: 'openrouter_max_prompt_cost', electronhub: 'electronhub_max_prompt_cost', chutes: 'chutes_max_prompt_cost' };
    for (const source of ['openrouter', 'electronhub', 'chutes', 'openai']) {
        await selectBackend(page, 'openai', source);
        const prompting = await openPanel(page, 'prompting');
        const rows = prompting.locator('#sb-openai-budget .ds-row-property');
        await expect(rows).toHaveCount(3);
        await expect(rows.filter({ visible: true })).toHaveCount(source in costs ? 1 : 0);
        if (!(source in costs)) continue;
        const value = prompting.locator(`#${costs[source]}`);
        await expect(value).toBeVisible();
        await expect(value).toHaveClass(/ds-row-property__value/);
        await expect(value.locator('xpath=ancestor::*[contains(@class, "ds-row-property")][1]').locator('.ds-row-subtitle')).toHaveText('Max prompt cost');
        // The model list writes the cost into the upstream node.
        await value.evaluate(node => { node.textContent = '$0.123'; });
        await expect(value).toHaveText('$0.123');
    }
});

test('The connection profile change notice names the Presets and Formatting groups that show each setting', async ({ page, baseURL }) => {
    test.setTimeout(120000);
    await loadSettings(page, baseURL);
    const pages = { Presets: 'prompting', Formatting: 'context' };
    // Gemini shows every Request Options set: inline images, reasoning, web search.
    for (const [api, source] of [['openai', 'makersuite'], ['textgenerationwebui', 'ooba'], ['kobold', null], ['koboldhorde', null], ['novel', null]]) {
        await selectBackend(page, api, source);
        for (const [name, tab] of Object.entries(pages)) {
            const panel = await openPanel(page, tab);
            // A page builds its groups after its tab opens, so the titles are polled rather than read once. Only the open
            // page has visible groups, so each page is checked while it is open.
            for (const entry of getWatchEntriesForApi(api)) {
                const [entryName, group, ...rest] = entry.group.split(' > ');
                if (entryName !== name || rest.length) continue;
                await expect.poll(
                    () => groupNames(panel.locator('.sb-prompting-group')),
                    { message: `${entry.id} is shown in ${entry.group} for ${api}` },
                ).toContain(group);
            }
        }
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
    // The wire control is a toggle row of its own after the slider row, in the same box.
    await expect(temperature.locator(':scope > .ds-row-slider + .ds-toggle-row.sb-sampling-wire')).toHaveCount(1);
    const wire = temperature.getByRole('radiogroup', { name: 'Temperature Sent to the AI', exact: true });
    await expect(wire.getByRole('radio')).toHaveCount(3);
    // It is shown and hidden by the same provider gating as the slider row.
    const gating = row => row.evaluate(node => ['data-source', 'data-source-mode', 'data-tg-type', 'data-tg-samplers', 'data-sb-sampler-ungated'].map(name => node.getAttribute(name)));
    expect(await gating(temperature.locator('.sb-sampling-wire'))).toEqual(await gating(temperature.locator(':scope > .ds-row-slider')));
    await expect(wire.getByRole('radio', { name: 'Auto', exact: true })).toBeChecked();
    await wire.getByRole('radio', { name: 'Omit', exact: true }).click();
    await expect(wire.getByRole('radio', { name: 'Omit', exact: true })).toBeChecked();
    await expect(wire.getByRole('radio', { name: 'Auto', exact: true })).not.toBeChecked();
    await expect(temperature.locator('#temp_openai')).toHaveCSS('opacity', '0.35');
    await expect.poll(() => page.evaluate(() => Object.values(window.SillyTavern.getContext().chatCompletionSettings.model_sampling_policies.targets)
        .map(target => target.parameters.temperature))).toContain('omit');
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
            const shape = className => ['ds-row-expander'].filter(token => className.split(' ').includes(token));
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
    await expect(page.locator('#sb-sampling-kobold .sb-sampling-header-note')).toHaveText('Some backends ignore samplers they do not support');
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
    await expect(editor.getByRole('button', { name: 'Add Prompt', exact: true })).toBeHidden();
    await expect(editor.getByRole('button', { name: 'Prompt List Actions', exact: true })).toBeHidden();
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
    await expect(editor.locator('.sb-prompt-list-header .sb-list-header__title')).toHaveText('Prompt templates');

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
    await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
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
    await expect(editor.locator('.sb-prompt-list-header .sb-list-header__title')).toHaveText('Prompt templates');
    await editor.locator('[data-prompt-id="context_story_string"] .sb-prompt-row-name').click();
    await expect(detail.locator('.sb-prompt-tc-properties .sb-prompt-dropdown')).toHaveCount(2);
    await expect(detail.locator('.sb-prompt-tc-properties input[type="number"]')).toHaveCount(1);
});

test('Text Completions template fields expand and write back to the draft, under the shared title, label rows and count', async ({ page, baseURL }) => {
    test.setTimeout(120000);
    await loadSettings(page, baseURL);
    await selectBackend(page, 'textgenerationwebui', 'ooba');
    const editor = await openPanel(page, 'editor');
    await editor.locator('[data-prompt-id="tc-user"] .sb-prompt-row-name').click();
    const detail = editor.locator('.sb-prompt-detail');

    // The name is the page's title, the fields have the shared label row with Expand, and there is no footer or switch row.
    await expect(detail.locator('.sb-prompt-title')).toHaveText('User');
    await expect(detail.locator('.sb-prompt-content-field .sb-editor-label-row .editor_maximize')).toHaveCount(4);
    await expect(detail.locator('.sb-prompt-footer')).toHaveCount(0);
    await expect(detail.getByRole('button', { name: 'Expand the Editor' }).first()).toHaveAccessibleDescription('User Message Prefix');
    await expect(detail.locator('.sb-prompt-detail-header .sb-prompt-tokens')).toBeVisible();

    const suffix = detail.locator('#sb-prompt-tc-instruct_input_suffix');
    const originalSuffix = await page.locator('#instruct_input_suffix').inputValue();
    await suffix.locator('xpath=ancestor::*[contains(@class, "sb-prompt-content-field")][1]').locator('.editor_maximize').click();
    const dialog = page.locator('dialog.popup[open]');
    await expect(dialog.locator('.maximized_textarea')).toBeVisible();
    await expect(dialog.getByText('User Message Suffix', { exact: true })).toBeVisible();
    await dialog.locator('.maximized_textarea').fill('Written in the expanded editor');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(suffix).toHaveValue('Written in the expanded editor');
    await expect(detail.locator('.sb-prompt-dirty')).toBeVisible();
    await expect(page.locator('#instruct_input_suffix')).toHaveValue(originalSuffix);

    await detail.locator('.sb-prompt-cancel').click();
    await expect(suffix).toHaveValue(originalSuffix);
});

test('Text Completions template preview substitutes macros, as the prompt preview does', async ({ page, baseURL }) => {
    test.setTimeout(120000);
    await loadSettings(page, baseURL);
    await selectBackend(page, 'textgenerationwebui', 'ooba');
    const editor = await openPanel(page, 'editor');
    await editor.locator('[data-prompt-id="tc-user"] .sb-prompt-row-name').click();
    const detail = editor.locator('.sb-prompt-detail');
    await detail.locator('#sb-prompt-tc-instruct_input_suffix').fill('{{user}} writes:');
    const modes = detail.getByRole('group', { name: 'Edit / Preview', exact: true });
    await modes.getByRole('radio', { name: 'Preview', exact: true }).check();
    const userName = await page.evaluate(async () => (await import('/script.js')).name1);
    expect(userName).toBeTruthy();
    await expect(detail.locator('pre.sb-prompt-preview').nth(1)).toHaveText(`${userName} writes:`);
    await modes.getByRole('radio', { name: 'Edit', exact: true }).check();
    await expect(detail.locator('#sb-prompt-tc-instruct_input_suffix')).toHaveValue('{{user}} writes:');
    await detail.locator('.sb-prompt-cancel').click();
});

test('Native sampler expanders reveal search results and preserve switch and counter interactions', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    await selectBackend(page, 'textgenerationwebui', 'ooba');
    const sampling = await openPanel(page, 'sampling');
    const dry = sampling.locator('.ds-row-expander[data-sb-sampling-control="#dryBlock"]');
    const dryToggle = dry.locator('.ds-row-expander__toggle').first();
    await dryToggle.focus();
    await page.keyboard.press('Enter');
    await expect(dryToggle).toHaveAttribute('aria-expanded', 'true');
    await dry.locator('#dry_multiplier_counter_textgenerationwebui').fill('0.8');
    await dry.locator('#dry_multiplier_counter_textgenerationwebui').press('Enter');
    await expect(dry.locator('#dry_multiplier_textgenerationwebui')).toHaveValue('0.8');
    await page.keyboard.press('Tab');
    await dryToggle.click();
    await expect(dryToggle).toHaveAttribute('aria-expanded', 'false');
    await page.evaluate(() => window.SillyBunnyShell.openGlobalSearch());
    await page.locator('#sb-universal-search input').fill('sequence breakers');
    await page.getByRole('group', { name: 'Backend · Sampling', exact: true }).getByRole('option', { name: /Sequence Breakers/ }).click();
    await expect(dryToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(dry.locator('#dry_sequence_breakers_textgenerationwebui')).toBeVisible();
    const dynamic = sampling.locator('.ds-row-expander[data-sb-sampling-control="#dynatemp_block_ooba"]');
    await dynamic.locator('.ds-row-expander__toggle').first().click();
    const toggle = dynamic.getByRole('switch', { name: 'Dynamic Temperature', exact: true });
    await toggle.focus();
    const checked = await toggle.isChecked();
    await page.keyboard.press('Enter');
    await expect(toggle).toBeChecked({ checked: !checked });
});

for (const width of [1440, 390]) {
    for (const { tone, theme } of SELECTION_TONES) {
        test(`Backend Type is a filled tray with a raised selected toggle at ${width}px in the ${tone} tone`, async ({ page, baseURL }) => {
            await loadSettings(page, baseURL);
            await page.setViewportSize({ width, height: 844 });
            const connections = await openPanel(page, 'connections');
            await selectTheme(page, theme);
            await expect(page.locator('html')).toHaveAttribute('data-sb-surface-tone', tone);
            const group = connections.locator('.ds-toggle-row__group--fill');
            await expect(group).toHaveCount(1);
            await expectToggleGroupForm(page, group, { tone, floor: 32 });
            await page.emulateMedia({ contrast: 'more' });
            await expectToggleGroupForm(page, group, { tone, floor: 32, more: true });
        });
    }
}

test('Agents globals and Connections switches use the shared row semantics', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    await page.setViewportSize({ width: 390, height: 844 });
    const agents = await openPanel(page, 'agents');
    await agents.getByRole('button', { name: 'Agents Menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const settings = agents.locator('[data-agent-page="settings"]');
    await expect(settings.locator('.ds-pref-group-heading')).toHaveText(['Connections', 'Running Agents', 'Chats', 'Notifications and Display', 'Advanced']);
    await expect(settings.locator('.ds-pref-group')).toHaveCount(6);
    await expect(settings.locator('.ds-row')).toHaveCount(11);
    await expect(settings.locator('.ds-select-row')).toHaveCount(2);
    await expect(settings.locator('.ds-select-row__menu')).toHaveCount(0);
    await expect(settings.getByRole('radiogroup')).toHaveCount(2);
    await expect(settings.locator('input[role="switch"]')).toHaveCount(5);
    await expect(settings.locator('#ica--resetDefaults')).toHaveClass(/is-destructive/);
    await expect(agents.locator('#ica--companionConcurrent')).toHaveAttribute('role', 'switch');
    const prefill = settings.locator('[data-sb-editor-field="helperPrefillMessages"]');
    await expect.poll(() => prefill.evaluate(row => getComputedStyle(row).flexDirection)).toBe('column');
    await expect.poll(() => prefill.locator('textarea').evaluate(field => field.getBoundingClientRect().width)).toBeGreaterThan(280);
    await expect(prefill.getByRole('button', { name: 'Expand the Editor', exact: true })).toHaveCount(1);
    await expectNoOverflow(agents);
    await expectSwitchGeometry(settings);
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
        label: (card.querySelector(':scope > .ds-row-expander__header .ds-row-label') ?? card.querySelector('.ds-row-label'))?.textContent.replace(/\s+/g, ' ').trim(),
    })));

    for (const source of ['openai', 'custom', 'openrouter']) {
        await selectBackend(page, 'openai', source);
        const sampling = await openPanel(page, 'sampling');
        const cc = sampling.locator('#sb-sampling-openai');
        for (const id of placeholderIds) {
            const row = cc.locator(`[data-sb-sampling-placeholder][data-sb-sampler-id="${id}"]`);
            await expect(row, `${source} ${id}`).toBeVisible();
            await expect(row.locator('input, select, textarea, button')).toHaveCount(0);
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
    await acceptPopup(page.locator('dialog[open]'));
    const bannedTokens = sampling.locator('#send_banned_tokens_textgenerationwebui');
    const enabled = await bannedTokens.isChecked();
    await sampling.locator('#send_banned_tokens_label').click();
    await expect(bannedTokens).toBeChecked({ checked: !enabled });
    // The two lists follow the switch.
    const bannedLists = sampling.locator('#global_banned_tokens_textgenerationwebui, #banned_tokens_textgenerationwebui');
    for (const list of await bannedLists.all()) await expect(list).toBeEnabled({ enabled: !enabled });
    await sampling.locator('#send_banned_tokens_label').click();
    await expect(bannedTokens).toBeChecked({ checked: enabled });
    for (const list of await bannedLists.all()) await expect(list).toBeEnabled({ enabled });
    await expectNoOverflow(sampling);
});

test('Mobile Backend pages stay inside the settings page when a theme sizes the drawers by ID', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    await page.setViewportSize({ width: 390, height: 844 });
    // The Moonlit Echoes theme extension ships this mobile drawer rule.
    await page.addStyleTag({ content: `
        @media screen and (max-width: 1000px) {
            body:has(#sb-topbar-stack) :is(#left-nav-panel, #right-nav-panel) {
                height: calc(100dvh - var(--topBarBlockSize)) !important;
                max-height: calc(100dvh - var(--topBarBlockSize)) !important;
            }
        }
    ` });
    for (const tab of ['connections', 'sampling', 'prompting', 'editor', 'context']) {
        const panel = await openPanel(page, tab);
        await expect.poll(() => panel.locator('.sb-shell-panel-scroller').evaluate(scroller => {
            const host = document.getElementById('sb-settings-shell-host');
            return scroller.getBoundingClientRect().bottom - host.getBoundingClientRect().bottom;
        }), { message: tab }).toBeLessThanOrEqual(1);
    }
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
        await choosePresetAction(page, prompting, api === 'openai' ? 'Export…' : 'Export');
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
    await expect(firstRow).toHaveClass(/ds-row--activatable/);
    await expect(firstRow.locator('.ds-row__chevron')).toHaveCSS('font-family', /Font Awesome/);
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

test('Extensions lists user-installed extensions after System Extensions, without a description', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    await page.setViewportSize({ width: 390, height: 844 });
    const extensions = await openPanel(page, 'extensions', 'right');
    const system = extensions.getByRole('group', { name: 'System Extensions', exact: true });
    await expect.poll(() => system.locator('.sb-subpage-row').count()).toBeGreaterThan(0);

    // A user-installed extension mounts by appending its own markup to a settings column or to a
    // container slot the page authors, and the list is grouped from that markup alone.
    await page.evaluate(() => {
        const drawer = title => `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>${title}</b></div><div class="inline-drawer-content"><label class="checkbox_label"><input type="checkbox"><span>${title} setting</span></label></div></div>`;
        document.getElementById('extensions_settings').insertAdjacentHTML('beforeend', `<div class="qa-user-extension">${drawer('QA User Extension')}</div>`);
        document.getElementById('dice_container').insertAdjacentHTML('beforeend', drawer('QA Dice Slot'));
    });
    const user = extensions.getByRole('group', { name: 'User-Installed Extensions', exact: true });
    await expect(user.locator('.ds-row-label')).toHaveText(['QA User Extension', 'QA Dice Slot']);
    await expect(user.locator('.ds-row-subtitle, [data-sb-copy-placeholder]')).toHaveCount(0);
    await expect(extensions.locator('.sb-subpage-list')).not.toContainText('lorum ipsum');
    expect(await extensions.locator('[data-sb-subpage-group]').evaluateAll(groups => groups.map(group => group.dataset.sbSubpageGroup))).toEqual(['system', 'user']);
    await expectNoOverflow(extensions);

    await user.locator('.sb-subpage-row').first().click();
    await expect(extensions.locator('.sb-subpage-detail')).toHaveAttribute('aria-hidden', 'false');
    await expect(extensions.locator('.sb-subpage-detail-title')).toHaveText('QA User Extension');
    await expect(extensions.locator('.sb-subpage-detail-description')).toBeHidden();
    await extensions.locator('.sb-subpage-back').click();
    await expect(extensions.locator('.sb-subpage-detail')).toHaveAttribute('aria-hidden', 'true');
    await expect(user.locator('.sb-subpage-row')).toHaveCount(2);
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
    const dry = sampling.locator('.ds-row-expander[data-sb-sampling-control="#dryBlock"]');
    await dry.locator('.ds-row-expander__toggle').first().click();
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
    await waitForAppReady(page);
    await openPanel(page, 'sampling');
    await expect(sampling.locator('#temp_openai')).toHaveValue('0.71');
    await expect(sampling.locator('#temp_counter_openai')).toHaveValue('0.71');
    await selectBackend(page, 'textgenerationwebui', 'ooba');
    await expect(sampling.locator('#temp_textgenerationwebui')).toHaveValue('0.69');
    await dry.locator('.ds-row-expander__toggle').first().click();
    await expect(dry.locator('#dry_multiplier_textgenerationwebui')).toHaveValue('0.7');
    await expect(dry.locator('#dry_multiplier_counter_textgenerationwebui')).toHaveValue('0.7');
    await openPanel(page, 'prompting');
    await expect(prompting.locator('#max_context')).toHaveValue('8192');
});

test('NovelAI Sampling mounts its sampler order as a list of reorderable list rows', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    await selectBackend(page, 'novel');
    const sampling = await openPanel(page, 'sampling');
    const list = sampling.locator('#sb-sampling-novel #novel_order');
    await expect(list).toBeVisible();
    await expect(list).toHaveAttribute('role', 'group');
    const items = list.locator(':scope > div');
    expect(await items.count()).toBeGreaterThan(5);
    await expect(list.locator(':scope > .ds-entity-row')).toHaveCount(await items.count());
    // Each sampler can be switched off: the button is named by its sampler and its state, which follows the item's `disabled` class.
    const toggles = list.locator(':scope > div > .toggle_button');
    await expect(toggles).toHaveCount(await items.count());
    const temperature = list.locator('[data-id="0"] > .toggle_button');
    await expect(temperature).toHaveRole('button');
    await expect(temperature).toHaveAccessibleName('Temperature Sampling Enabled');
    await expect(temperature).not.toHaveAttribute('aria-pressed', /.*/);
    await temperature.focus();
    await page.keyboard.press('Space');
    await expect(temperature).toHaveAccessibleName('Temperature Sampling Disabled');
    await expect(list.locator('[data-id="0"]')).toHaveClass(/disabled/);
    const lock = sampling.locator('#sb-sampling-novel [data-sampler-order-lock="novel_order"]');
    await expect(lock).toBeVisible();
    await expect(lock).toHaveAttribute('aria-pressed', 'true');
    await lock.click();
    await expect(lock).toHaveAttribute('aria-pressed', 'false');
    await expect(list).not.toHaveClass(/ui-sortable-disabled/);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(list).toBeVisible();
    await expectNoOverflow(sampling);
});

test('Unavailable samplers are insensitive rows without a striped fill', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    await selectBackend(page, 'openai', 'openai');
    const sampling = await openPanel(page, 'sampling');
    const placeholders = sampling.locator('#sb-sampling-openai [data-sb-sampling-placeholder]');
    await expect(placeholders.first()).toBeVisible();
    const rows = placeholders.locator('.ds-row');
    await expect(rows).toHaveCount(await placeholders.count());
    for (const row of await rows.all()) {
        await expect(row).toHaveClass(/is-insensitive/);
        await expect(row).toHaveAttribute('aria-disabled', 'true');
        await expect(row.locator('.ds-row-subtitle')).toHaveText('Not available in Chat Completions. Custom endpoints can send it with Additional Parameters.');
    }
    // The stripe was a repeating gradient on the card, and the reason's dimming was on the text only.
    expect(await placeholders.evaluateAll(cards => cards.map(card => getComputedStyle(card).backgroundImage))).toEqual(Array(await placeholders.count()).fill('none'));
    expect(await rows.evaluateAll(list => list.map(row => getComputedStyle(row).backgroundImage))).toEqual(Array(await placeholders.count()).fill('none'));
});

test('Adding a Logit Bias entry keeps the rows that are already drawn live', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    await selectBackend(page, 'openai', 'openai');
    const sampling = await openPanel(page, 'sampling');
    const add = sampling.locator('#openai_logit_bias_new_entry');
    const rows = sampling.locator('.openai_logit_bias_list > .openai_logit_bias_form');
    await add.click();
    await add.click();
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toHaveClass(/ds-entity-row/);
    await expect(rows.first().locator('.openai_logit_bias_remove')).toHaveClass(/ds-entity-row__button/);
    // The row that is drawn first is the newest one; the older one sits under it.
    await add.click();
    await expect(rows).toHaveCount(3);
    await rows.nth(2).locator('.openai_logit_bias_text').fill('older');
    await rows.nth(1).locator('.openai_logit_bias_text').fill('middle');
    const saved = await page.evaluate(async () => {
        const { oai_settings } = await import('/scripts/openai.js');
        return oai_settings.bias_presets[oai_settings.bias_preset_selected].map(entry => entry.text);
    });
    expect(saved).toEqual(['older', 'middle', '']);
    // The drag handler sorts the array that the list was drawn from, which has to be the one that is saved.
    const sameArray = await page.evaluate(async () => {
        const { oai_settings } = await import('/scripts/openai.js');
        const before = oai_settings.bias_presets[oai_settings.bias_preset_selected];
        document.getElementById('openai_logit_bias_new_entry').click();
        return oai_settings.bias_presets[oai_settings.bias_preset_selected] === before;
    });
    expect(sameArray).toBe(true);
});

test('NovelAI Logit Bias entries on the Presets page are entity rows, because the page loads the entity list sheet', async ({ page, baseURL }) => {
    await loadSettings(page, baseURL);
    await selectBackend(page, 'novel');
    const prompting = await openPanel(page, 'prompting');
    const add = prompting.locator('#novelai_logit_bias_new_entry');
    await add.scrollIntoViewIfNeeded();
    await add.click();
    const row = prompting.locator('#logit_bias_novel').locator('xpath=ancestor::div[contains(@class,"range-block")][1]').locator('.logit_bias_list > .logit_bias_form').first();
    await expect(row).toHaveClass(/ds-entity-row/);
    await expect(page.locator('#deferred-entity-list-css')).toHaveCount(1);
    // The sheet has applied when the row has the shared row's minimum height.
    await expect.poll(() => row.evaluate(node => getComputedStyle(node).minHeight)).toBe('52px');
});
