import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { applyLibadwaitaTheme } from './helpers/libadwaita-theme.js';

const publicRoot = path.resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const indexMarkup = readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
const PROFILE_MARKUP = '<div class="wide100p"><div><h3>Connection Profile</h3>'
    + '<i id="connection_profile_spinner" class="fa-solid fa-spinner hidden"></i></div>'
    + '<div class="connection-profile-picker"><select id="connection_profiles">'
    + '<option value="">None</option><option value="fixture">Fixture</option></select>'
    + '<div id="connection_profile_details_content" class="hidden"></div>'
    + '<div id="sb-connection-profile-sets" hidden></div>'
    + '<div class="connection-profile-actions"><button id="update_connection_profile"></button>'
    + '<button id="reload_connection_profile"></button><button id="create_connection_profile"></button>'
    + '<button id="edit_connection_profile"></button><button id="view_connection_profile"></button>'
    + '<button id="toggle_profile_favorite"></button><button id="manage_profile_folders"></button>'
    + '<button id="delete_connection_profile"></button><button id="delete_all_connection_profiles"></button></div>'
    + '</div></div>';

async function mountConnections(page, { pickerPlaceholders = false, fullWidthTitleColon = false, nestedMirrors = false } = {}) {
    await page.route('http://connections.test/**', route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/') {
            return route.fulfill({
                contentType: 'text/html',
                body: '<!doctype html><html><head>'
                    + '<link rel="stylesheet" href="/css/fontawesome.min.css">'
                    + '<link rel="stylesheet" href="/css/solid.min.css">'
                    + '<link rel="stylesheet" href="/style.css">'
                    + '<link rel="stylesheet" href="/css/sillybunny-theme.css">'
                    + '<link rel="stylesheet" href="/css/sillybunny-tabs.css">'
                    + '<link rel="stylesheet" href="/css/sillybunny-message-actions.css">'
                    + '<link rel="stylesheet" href="/css/sillybunny-editor-shell.css">'
                    + '<link rel="stylesheet" href="/css/sillybunny-mobile-shell.css">'
                    + '</head><body><main id="sb-settings-page"><div class="sb-settings-mounted-shell" style="max-height: 100vh; overflow: auto; width: 100%">'
                    + '<div id="rm_api_block"></div></div></main></body></html>',
            });
        }
        if (pathname === '/script.js') {
            return route.fulfill({
                contentType: 'text/javascript',
                body: 'const handlers = new Set(); export const eventSource = { on(_name, handler) { handlers.add(handler); }, off(_name, handler) { handlers.delete(handler); }, emit() { for (const handler of handlers) handler(); } }; export const event_types = { MAIN_API_CHANGED: "main-api-changed" };',
            });
        }
        if (pathname === '/scripts/i18n.js') {
            return route.fulfill({
                contentType: 'text/javascript',
                body: 'export const t = (strings, ...values) => strings.reduce((out, text, index) => out + text + (values[index] ?? ""), ""); export const translate = text => text;',
            });
        }
        if (pathname === '/scripts/popup.js') {
            return route.fulfill({
                contentType: 'text/javascript',
                body: 'export class Popup {} export const POPUP_TYPE = {}; export const POPUP_RESULT = {};',
            });
        }
        const filePath = path.resolve(publicRoot, `.${pathname}`);
        if (!filePath.startsWith(`${publicRoot}${path.sep}`)) return route.abort();
        return route.fulfill({
            path: filePath,
            contentType: pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
    });
    await page.goto('http://connections.test/');
    await applyLibadwaitaTheme(page);
    await page.addScriptTag({ url: '/lib/jquery-3.5.1.min.js' });
    await page.evaluate(async ({ markup, profileMarkup, pickerPlaceholders, fullWidthTitleColon, nestedMirrors }) => {
        const parsed = new DOMParser().parseFromString(markup, 'text/html');
        const profile = new DOMParser().parseFromString(profileMarkup, 'text/html');
        const root = document.getElementById('rm_api_block');
        root.append(profile.body.firstElementChild, ...parsed.getElementById('rm_api_block').children);
        document.getElementById('main_api').value = 'openai';
        document.getElementById('chat_completion_source').value = 'openai';
        document.getElementById('textgen_type').value = 'openrouter';
        if (nestedMirrors) {
            const outer = document.createElement('div');
            outer.dataset.source = 'claude';
            outer.dataset.sourceMode = 'except';
            const inner = document.createElement('div');
            inner.dataset.source = 'openrouter';
            const typeGate = document.createElement('div');
            typeGate.dataset.tgType = 'koboldcpp';
            typeGate.dataset.tgTypeMode = 'except';
            outer.append(inner);
            inner.append(typeGate);
            for (const id of ['future-field-a', 'future-field-b']) {
                const title = document.createElement('h4');
                title.textContent = id;
                const field = document.createElement('input');
                field.type = 'text';
                field.id = id;
                typeGate.append(title, field);
            }
            document.getElementById('openai_api').append(outer);
        }
        root.querySelectorAll('.api_loading').forEach(node => { node.style.display = 'none'; });
        const refreshSourceGates = () => {
            const source = document.getElementById('chat_completion_source').value;
            for (const node of document.querySelectorAll('[data-source]')) {
                const matches = node.dataset.source.split(',').map(value => value.trim()).includes(source);
                window.jQuery(node).toggle(node.dataset.sourceMode === 'except' ? !matches : matches);
            }
        };
        const refreshTypeGates = () => {
            const type = document.getElementById('textgen_type').value;
            for (const node of document.querySelectorAll('[data-tg-type]')) {
                const matches = node.dataset.tgType.split(',').map(value => value.trim()).some(value => value === type || value === 'all');
                window.jQuery(node).toggle(node.dataset.tgTypeMode === 'except' ? !matches : matches);
            }
        };
        refreshSourceGates();
        refreshTypeGates();
        window.jQuery('#chat_completion_source').on('change', refreshSourceGates);
        window.jQuery('#textgen_type').on('change', refreshTypeGates);
        if (pickerPlaceholders) {
            const select = document.getElementById('model_openrouter_select');
            select.dataset.placeholder = 'Data placeholder';
            window.jQuery(select).data('select2', { options: { get: () => 'Lower priority placeholder' } });
            window.jQuery('#openrouter_providers_chat').data('select2', { options: { get: () => ({ text: 'Provider placeholder' }) } });
            window.jQuery('#openrouter_quantizations_chat').data('select2', { options: { get: () => 'Quantization placeholder' } });
            document.getElementById('openrouter_model').replaceChildren(new Option('Empty option placeholder', ''));
        }
        if (fullWidthTitleColon) root.querySelector('label[for="vertexai_auth_mode"]').textContent = 'Authentication Mode ：  ';
        const originals = [...root.querySelectorAll('*')].map(node => ({
            node,
            parent: node.parentNode,
            next: node.nextSibling,
            attributes: [...node.attributes].map(attribute => [attribute.name, attribute.value]),
        }));
        const gateSelector = '[data-source], [data-tg-type], [data-tg-type-mode], [data-source-mode], [data-mode], [data-cc-type], #openai_external_category, #pollinations_key_section, #oai_max_context_unlocked_block, .reverse_proxy_warning, .displayNone, [data-for]';
        const gateChain = node => {
            const gates = [];
            for (let parent = node; parent; parent = parent.parentElement) {
                if (parent.matches(gateSelector)) gates.push(parent);
            }
            return gates;
        };
        const mirrorAttributes = ['data-source', 'data-source-mode', 'data-tg-type', 'data-tg-type-mode'];
        const gateSignature = node => gateChain(node).map(gate => mirrorAttributes.filter(name => gate.hasAttribute(name)).map(name => [name, gate.getAttribute(name)])).filter(attributes => attributes.length);
        const fixedGates = node => gateChain(node).filter(gate => gate.matches('[data-mode], [data-cc-type], #openai_external_category, #pollinations_key_section, #oai_max_context_unlocked_block, .reverse_proxy_warning, .displayNone, [data-for]'));
        const gates = [...root.querySelectorAll('input, select, button, .menu_button, .right_menu_button')].map(node => ({ node, chain: fixedGates(node), signature: gateSignature(node) }));
        const { eventSource } = await import('/script.js');
        window.jQuery('#main_api').on('change', () => eventSource.emit());
        const { createConnectionsPanel } = await import('/scripts/sillybunny-connections-panel.js');
        const panel = createConnectionsPanel({
            createElement(tag, options = {}) {
                const node = document.createElement(tag);
                node.className = options.className ?? '';
                node.textContent = options.text ?? '';
                if (options.type) node.setAttribute('type', options.type);
                for (const [key, value] of Object.entries(options.attrs ?? {})) node.setAttribute(key, value);
                return node;
            },
            getActiveApi: () => document.getElementById('main_api')?.value ?? 'openai',
            applyPanelApiVisibility() {},
        });
        window.connectionsFixture = { panel, originals, gates, gateChain: fixedGates, gateSignature, refreshSourceGates };
        document.querySelector('.sb-settings-mounted-shell').append(panel.column);
        root.classList.add('sb-legacy-api-drawer');
    }, { markup: indexMarkup, profileMarkup: PROFILE_MARKUP, pickerPlaceholders, fullWidthTitleColon, nestedMirrors });
}

test('provider text fields adopt floating rows without crossing visibility gates or flattening help', async ({ page }) => {
    await mountConnections(page);
    const failures = await page.evaluate(() => {
        const { gates, gateChain, gateSignature } = window.connectionsFixture;
        return gates.filter(({ node, chain, signature }) => {
            const after = gateChain(node);
            return after.length !== chain.length || after.some((gate, index) => gate !== chain[index]) || JSON.stringify(signature) !== JSON.stringify(gateSignature(node));
        }).map(({ node }) => node.id || node.className);
    });
    expect(failures).toEqual([]);
    const secrets = page.locator('.sb-connections-provider input').filter({ hasNot: page.locator('[type="checkbox"]') });
    expect(await secrets.count()).toBeGreaterThan(0);
    const secretFailures = await page.evaluate(() => [...document.querySelectorAll('.sb-connections-provider .manage-api-keys')].flatMap(manager => {
        const row = manager.closest('.ds-row-entry--floating');
        return row?.querySelector('.ds-row-entry__status') && row.querySelector('.ds-row-suffix')?.contains(manager) ? [] : [manager.dataset.key];
    }));
    expect(secretFailures).toEqual([]);
    await expect(page.locator('.sb-connections-field-title:not(.sb-legacy-search-hidden)')).toHaveCount(0);
    await expect(page.locator('#api_url_text').locator('xpath=ancestor::*[contains(@class,"ds-row-entry--floating")]').locator('.ds-row-entry__caption')).toContainText('Example:');
    const keyUnit = page.locator('[data-sb-connections-group="connection"] .sb-connections-unit:has(#api_key_openai)');
    await expect(keyUnit.locator('.sb-connections-description ol')).toHaveCount(1);
    await expect(keyUnit.locator('.ds-row-entry--floating ol')).toHaveCount(0);
});

test('provider selects share one picker row each and keep tied controls with their field', async ({ page }) => {
    await mountConnections(page);
    const failures = await page.evaluate(() => [...document.querySelectorAll('.sb-connections-provider select')].flatMap(select => {
        if (select.hidden || select.matches('.displayNone, [id^="featherless_"], #chat_completion_source, #textgen_type')) return [];
        return select.closest('.ds-select-row')?.querySelectorAll('.ds-select-row__trigger').length === 1 ? [] : [select.id];
    }));
    expect(failures).toEqual([]);
    await expect(page.locator('#horde_model').locator('xpath=ancestor::*[contains(@class,"ds-select-row")]').locator('.ds-row-suffix #horde_refresh')).toHaveCount(1);
    await expect(page.locator('#ollama_model').locator('xpath=ancestor::*[contains(@class,"ds-select-row")]').locator('.ds-row-suffix #ollama_download_model')).toHaveCount(1);
    await expect(page.locator('#openai_proxy_preset').locator('xpath=ancestor::*[contains(@class,"ds-select-row")]').locator('.ds-row-suffix #save_proxy')).toHaveCount(1);
});

test('adopted text fields and picker triggers retain accessible names', async ({ page }) => {
    await mountConnections(page);
    await page.locator('.sb-connections-provider .ds-row-entry, .sb-connections-provider .ds-select-row').evaluateAll(rows => {
        for (const row of rows) {
            for (let parent = row; parent && parent !== document.body; parent = parent.parentElement) {
                parent.hidden = false;
                if (getComputedStyle(parent).display === 'none') parent.style.setProperty('display', 'block', 'important');
            }
        }
    });
    const controls = page.locator('.sb-connections-provider .ds-row-entry input, .sb-connections-provider .ds-select-row__trigger');
    for (const control of await controls.all()) {
        await expect(control).toHaveAccessibleName(/\S/);
    }
});

test('model ID adapters preserve the exact input parent for upstream rebuilds', async ({ page }) => {
    await mountConnections(page);
    const failures = await page.evaluate(() => {
        const { originals } = window.connectionsFixture;
        return originals.filter(({ node }) => node.matches('input[id$="_model_id"], #generic_model_textgenerationwebui')).flatMap(({ node, parent }) => {
            const row = node.closest('.ds-row-entry--floating');
            return node.parentElement === parent && row?.querySelector(`label[for="${node.id}"]`) ? [] : [node.id];
        });
    });
    expect(failures).toEqual([]);
    await page.evaluate(() => {
        const button = document.createElement('button');
        button.dataset.sbModelIdPickerSource = 'openai';
        document.getElementById('openai_model_id').after(button);
    });
    await expect(page.locator('[data-sb-model-id-picker-source="openai"]')).toBeHidden();
    await expect(page.locator('#nanogpt_allowed_providers_picker')).toBeHidden();
});

test('upstream drawers become accessible expander rows and Additional Parameters ends the provider group', async ({ page }) => {
    await mountConnections(page);
    await expect(page.locator('.sb-connections-provider .inline-drawer.sb-connections-expander')).toHaveCount(5);
    const header = page.locator('.sb-connections-expander > .inline-drawer-toggle').first();
    await expect(header).toHaveAttribute('role', 'button');
    await expect(header).toHaveAttribute('tabindex', '0');
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    const action = page.locator('#customize_additional_parameters');
    await expect(action).toHaveClass(/ds-button-row/);
    expect(await action.evaluate(node => node.closest('[data-sb-connections-group]').dataset.sbConnectionsGroup)).toBe('advanced');
});

test('icon-only help links trail their field while text links remain captions', async ({ page }) => {
    await mountConnections(page);
    await page.locator('#chat_completion_source').selectOption('vertexai');
    const region = page.locator('[data-sb-editor-field="vertexai_region"]');
    const regionHelp = region.locator('.ds-row-suffix a.notes-link');
    await expect(regionHelp).toHaveCount(1);
    await expect(regionHelp).toHaveAccessibleName('View available regions and models');
    await expect(region.locator('.ds-row-entry__caption a.notes-link')).toHaveCount(0);
    const processing = page.locator('[data-sb-editor-field="custom_prompt_post_processing"]');
    await expect(processing.locator('.ds-row-suffix a.notes-link')).toHaveAccessibleName('Prompt Post-Processing');
    await expect(processing.locator('.ds-row-entry__caption')).toHaveCount(0);
    await expect(page.locator('[data-sb-editor-field="api_key_openai"] .ds-row-entry__caption #openai_api_usage')).toHaveText('View API Usage Metrics');
});

test('the reverse proxy warning wrapper collapses only while its warning is hidden', async ({ page }) => {
    await mountConnections(page);
    const wrapper = page.locator('#ReverseProxyWarningMessage');
    await wrapper.evaluate(node => { node.style.display = 'block'; });
    await wrapper.locator('.reverse_proxy_warning').evaluate(node => { node.style.display = 'none'; });
    await expect(wrapper).toBeHidden();
    await wrapper.locator('.reverse_proxy_warning').evaluate(node => { node.style.display = 'block'; });
    await expect(wrapper).toBeVisible();
    await expect(wrapper.locator('.reverse_proxy_warning')).toContainText('risk to your data privacy');
});

test('empty picker summaries reuse upstream placeholders in precedence order without inventing text', async ({ page }) => {
    await mountConnections(page, { pickerPlaceholders: true });
    await page.locator('#model_openrouter_select').evaluate(select => { select.replaceChildren(); });
    await expect(page.locator('[data-sb-editor-field="model_openrouter_select"] .ds-select-row__value')).toHaveText('Data placeholder');
    await expect(page.locator('[data-sb-editor-field="openrouter_providers_chat"] .ds-select-row__value')).toHaveText('Provider placeholder');
    await expect(page.locator('[data-sb-editor-field="openrouter_quantizations_chat"] .ds-select-row__value')).toHaveText('Quantization placeholder');
    await page.locator('#openrouter_model').evaluate(select => { select.replaceChildren(); });
    await expect(page.locator('[data-sb-editor-field="openrouter_model"] .ds-select-row__value')).toHaveText('Empty option placeholder');
    await expect(page.locator('[data-sb-editor-field="openrouter_providers_text"] .ds-select-row__value')).toHaveText('');
});

test('derived titles omit trailing ASCII and full-width colons without rewriting upstream labels', async ({ page }) => {
    await mountConnections(page, { fullWidthTitleColon: true });
    for (const [field, title] of [['vertexai_auth_mode', 'Authentication Mode'], ['vertexai_region', 'Region'], ['vertexai_express_project_id', 'Project ID'], ['api_key_vertexai', 'API Key']]) {
        await expect(page.locator(`[data-sb-editor-field="${field}"] .ds-row-label`)).toHaveText(title);
    }
    await expect(page.locator('label[for="vertexai_auth_mode"].sb-connections-field-title')).toHaveText('Authentication Mode ：');
    await expect(page.locator('label[for="vertexai_region"].sb-connections-field-title')).toContainText('Region:');
});

test('Connections headers use Customize category typography and subtitles', async ({ page }) => {
    await mountConnections(page);
    const headings = page.locator('.sb-connections-panel > .sb-editor-section .ds-pref-group-header');
    await expect(headings.locator('.ds-pref-group-subtitle')).toHaveText([
        'Setup all-in-one profiles that save all your settings in one go',
        'Change the backend source and type here. Chat Completions is recommended by default',
        'Settings that affect all connection types',
    ]);
    await expect(headings.locator('[data-sb-copy-placeholder]')).toHaveCount(0);
    const metrics = await headings.evaluateAll(headers => headers.map(header => {
        const title = getComputedStyle(header.querySelector('.ds-pref-group-heading'));
        const subtitle = getComputedStyle(header.querySelector('.ds-pref-group-subtitle'));
        return { size: title.fontSize, weight: title.fontWeight, margin: title.margin, padding: title.padding, subtitleWeight: subtitle.fontWeight, gap: getComputedStyle(header).rowGap, boxGap: getComputedStyle(header).marginBottom };
    }));
    expect(metrics).toEqual(Array(3).fill({ size: '15px', weight: '700', margin: '0px', padding: '0px', subtitleWeight: '700', gap: '2px', boxGap: '8px' }));
});

test('provider groups classify whole units in order without changing gate signatures', async ({ page }) => {
    await mountConnections(page);
    const provider = page.locator('[data-sb-provider="openai"]');
    await expect(provider.locator('[data-sb-connections-group] .ds-pref-group-heading')).toHaveText(['Connection', 'Model', 'Providers', 'Advanced']);
    await expect(provider.locator('[data-sb-connections-group] .ds-pref-group-subtitle')).toHaveText([
        'Supply the backend\'s API key and test for a connection',
        'Specify which model is queried from the backend',
        'Extra settings for model providers',
        'Advanced settings that affect your backend queries',
    ]);
    await expect(provider.locator('[data-sb-copy-placeholder]')).toHaveCount(0);
    const assignments = await page.evaluate(() => Object.fromEntries([
        'api_button_openai', 'api_key_openrouter', 'model_openrouter_select', 'openrouter_use_fallback', 'openrouter_sort_models',
        'openrouter_providers_chat', 'openrouter_quantizations_chat', 'nanogpt_payg_override', 'custom_prompt_post_processing',
        'customize_additional_parameters', 'vertexai_form', 'model_vertexai_select', 'api_key_pollinations',
    ].map(id => [id, document.getElementById(id).closest('[data-sb-connections-group]')?.dataset.sbConnectionsGroup])));
    expect(assignments).toEqual({
        api_button_openai: 'connection', api_key_openrouter: 'connection', model_openrouter_select: 'model', openrouter_use_fallback: 'model', openrouter_sort_models: 'model',
        openrouter_providers_chat: 'providers', openrouter_quantizations_chat: 'providers', nanogpt_payg_override: 'providers', custom_prompt_post_processing: 'advanced',
        customize_additional_parameters: 'advanced', vertexai_form: 'connection', model_vertexai_select: 'model', api_key_pollinations: 'connection',
    });
    const gates = await page.evaluate(() => window.connectionsFixture.gates.flatMap(({ node, chain, signature }) => {
        const after = window.connectionsFixture.gateChain(node);
        return after.length === chain.length && chain.every((gate, index) => gate === after[index]) && JSON.stringify(signature) === JSON.stringify(window.connectionsFixture.gateSignature(node)) ? [] : [node.id || node.className];
    }));
    expect(gates).toEqual([]);
    expect(await page.locator('#model_openrouter_select').evaluate(node => node.closest('[data-sb-connections-mirror]').getAttribute('data-source'))).toBe('openrouter');
    expect(await page.locator('#vertexai_auth_mode').evaluate(node => document.getElementById('vertexai_form').contains(node))).toBe(true);
    await expect(provider.locator('.sb-connections-unit:has(.sb-connections-source-label)')).toHaveCount(0);
    await expect(page.locator('[data-sb-provider="textgenerationwebui"] .sb-connections-unit:has(.sb-connections-legacy)')).toHaveCount(0);
});

test('whole Vertex form headings retain the shared row inset', async ({ page }) => {
    await mountConnections(page);
    await page.locator('#chat_completion_source').selectOption('vertexai');
    const inset = await page.locator('#vertexai_form').evaluate(form => {
        const heading = form.querySelector('h4');
        const row = form.querySelector('.ds-row');
        return heading.getBoundingClientRect().left + parseFloat(getComputedStyle(heading).paddingLeft) - row.getBoundingClientRect().left;
    });
    expect(inset).toBe(16);
});

test('source switches hide empty groups and restore them from their own displayed units', async ({ page }) => {
    await mountConnections(page);
    const groups = page.locator('[data-sb-provider="openai"] [data-sb-connections-group]:visible');
    await page.locator('#chat_completion_source').selectOption('openrouter');
    await expect(groups).toHaveCount(4);
    expect(await groups.evaluateAll(nodes => nodes.map(node => node.dataset.sbConnectionsGroup))).toEqual(['connection', 'model', 'providers', 'advanced']);
    await page.locator('#chat_completion_source').selectOption('claude');
    await expect(page.locator('[data-sb-provider="openai"] [data-sb-connections-group="providers"]')).toBeHidden();
    await expect(page.locator('[data-sb-editor-field="api_key_claude"]')).toBeVisible();
    await expect(page.locator('[data-sb-editor-field="api_key_openrouter"]')).toBeHidden();
    await page.locator('#chat_completion_source').selectOption('openrouter');
    await expect(page.locator('[data-sb-provider="openai"] [data-sb-connections-group="providers"]')).toBeVisible();
    const firsts = await groups.evaluateAll(nodes => nodes.map(node => node.querySelectorAll('[data-sb-connections-first]').length));
    expect(firsts).toEqual([1, 1, 1, 1]);
    const emptyUnits = await groups.locator('.sb-connections-unit').evaluateAll(nodes => nodes.filter(node => node.hidden && getComputedStyle(node).display !== 'none').length);
    expect(emptyUnits).toBe(0);
});

test('nested mirrors preserve all four gate attributes and reuse consecutive signatures', async ({ page }) => {
    await mountConnections(page, { nestedMirrors: true });
    const field = page.locator('[data-sb-editor-field="future-field-a"]');
    await expect(field).toBeHidden();
    const structure = await page.locator('#future-field-a').evaluate(node => {
        const typeGate = node.closest('[data-sb-connections-mirror]');
        const inner = typeGate.parentElement;
        return { source: inner.dataset.source, type: typeGate.dataset.tgType, typeMode: typeGate.dataset.tgTypeMode, display: inner.style.display, outerSource: inner.parentElement.dataset.source, outerMode: inner.parentElement.dataset.sourceMode, siblingsShare: typeGate.contains(document.getElementById('future-field-b')), group: node.closest('[data-sb-connections-group]').dataset.sbConnectionsGroup };
    });
    expect(structure).toEqual({ source: 'openrouter', type: 'koboldcpp', typeMode: 'except', display: 'none', outerSource: 'claude', outerMode: 'except', siblingsShare: true, group: 'advanced' });
    await page.locator('#chat_completion_source').selectOption('openrouter');
    await expect(field).toBeVisible();
    await page.evaluate(() => window.jQuery('#textgen_type').val('koboldcpp').trigger('change'));
    await expect(field).toBeHidden();
    await page.evaluate(() => window.jQuery('#textgen_type').val('ooba').trigger('change'));
    await expect(field).toBeVisible();
    await page.locator('#chat_completion_source').selectOption('claude');
    await expect(field).toBeHidden();
});

for (const width of [1440, 390]) {
    test.describe(`Combo row interaction at ${width}px`, () => {
        test.use({ viewport: { width, height: 1000 }, hasTouch: width === 390, reducedMotion: 'reduce' });
        test('select, multi-select and expander share chevron edges and row-owned focus', async ({ page }) => {
            await mountConnections(page);
            await page.locator('#chat_completion_source').selectOption('openrouter');
            const edges = await page.locator('[data-sb-editor-field="model_openrouter_select"] .ds-select-row__arrow, [data-sb-editor-field="openrouter_providers_chat"] .ds-select-row__arrow, .sb-connections-expander:has(#openrouter_sort_models) > .inline-drawer-toggle .inline-drawer-icon').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().right));
            expect(Math.max(...edges) - Math.min(...edges)).toBeLessThanOrEqual(1);
            const trigger = page.locator('[data-sb-editor-field="openrouter_providers_chat"] .ds-select-row__trigger');
            await trigger.focus();
            expect(await trigger.evaluate(node => getComputedStyle(node).boxShadow)).toBe('none');
            expect(await trigger.evaluate(node => getComputedStyle(node.closest('.ds-row')).boxShadow)).toContain('inset');
            await expect(trigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
            await trigger.hover();
            await expect(trigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        });

        test('text fields are filled entries with their own focus ring, and keep their trailing controls outside', async ({ page }) => {
            await mountConnections(page);
            await page.locator('#chat_completion_source').selectOption('openrouter');
            const key = page.locator('#api_key_openrouter');
            const rest = await key.evaluate(input => {
                const style = getComputedStyle(input);
                const field = input.getBoundingClientRect();
                const suffix = input.closest('.ds-row-entry__line').querySelector('.ds-row-suffix')?.getBoundingClientRect();
                return { background: style.backgroundColor, radius: parseFloat(style.borderTopLeftRadius), suffixOutside: !suffix || suffix.left >= field.right };
            });
            expect(rest.background).not.toBe('rgba(0, 0, 0, 0)');
            expect(rest.radius).toBeGreaterThan(0);
            expect(rest.suffixOutside).toBe(true);
            await key.focus();
            expect(await key.evaluate(node => getComputedStyle(node).boxShadow)).not.toBe('none');
            expect(await key.evaluate(node => getComputedStyle(node.closest('.ds-row')).boxShadow)).toBe('none');
        });
    });
}

for (const width of [1440, 390]) {
    test.describe(`Connections row polish at ${width}px`, () => {
        test.use({ viewport: { width, height: 1000 }, hasTouch: width <= 768, reducedMotion: 'reduce' });

        test('expander headers match picker row typography, geometry, and plain chevrons', async ({ page }) => {
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await mountConnections(page);
            await page.locator('#chat_completion_source').selectOption('vertexai');
            const header = page.locator('.sb-connections-expander:has(#openai_proxy_preset) > .inline-drawer-toggle');
            await expect(header).toBeVisible();
            const result = await header.evaluate(node => {
                const reference = document.querySelector('[data-sb-editor-field="vertexai_auth_mode"]');
                const title = getComputedStyle(node.querySelector('b'));
                const label = getComputedStyle(reference.querySelector('.ds-row-label'));
                const icon = node.querySelector('.inline-drawer-icon');
                const arrow = document.querySelector('.ds-select-row__arrow');
                const style = getComputedStyle(node);
                return {
                    typography: [title.fontFamily, title.fontSize, title.fontWeight, title.lineHeight],
                    referenceTypography: [label.fontFamily, label.fontSize, label.fontWeight, label.lineHeight],
                    height: node.getBoundingClientRect().height,
                    referenceHeight: reference.getBoundingClientRect().height,
                    padding: style.padding,
                    referencePadding: getComputedStyle(reference).padding,
                    titleX: node.querySelector('b').getBoundingClientRect().x,
                    referenceTitleX: reference.querySelector('.ds-row-label').getBoundingClientRect().x,
                    glyph: getComputedStyle(icon, '::before').content,
                    referenceGlyph: getComputedStyle(arrow, '::before').content,
                    iconBackground: getComputedStyle(icon).backgroundColor,
                    transition: getComputedStyle(icon).transitionDuration,
                };
            });
            expect(result.typography).toEqual(result.referenceTypography);
            expect(result.height).toBe(result.referenceHeight);
            expect(result.padding).toBe(result.referencePadding);
            expect(result.titleX).toBe(result.referenceTitleX);
            expect(result.glyph).toBe(result.referenceGlyph);
            expect(result.iconBackground).toBe('rgba(0, 0, 0, 0)');
            expect(result.transition).toBe('0s');
            await header.focus();
            await expect(header).toHaveCSS('outline-style', 'none');
            expect(await header.evaluate(node => getComputedStyle(node).boxShadow)).toContain('inset');
            const icon = header.locator('.inline-drawer-icon');
            const closedTransform = await icon.evaluate(node => getComputedStyle(node).transform);
            await icon.evaluate(node => node.classList.replace('down', 'up'));
            expect(await icon.evaluate(node => getComputedStyle(node).transform)).not.toBe(closedTransform);
        });

        test('trailing actions are flat, pointer-sized, and retain accessible Download text', async ({ page }) => {
            await mountConnections(page);
            await page.locator('#model_openai_favorite_toggle').evaluate(button => {
                for (const property of ['width', 'min-width', 'max-width', 'height', 'min-height', 'max-height', 'flex-basis']) {
                    button.style.setProperty(property, '44px', 'important');
                }
            });
            const failures = await page.locator('.sb-connections-provider .ds-row-suffix > :is(button, .menu_button, .right_menu_button):not(.ds-select-row__trigger)').evaluateAll(buttons => buttons.flatMap(button => {
                const style = getComputedStyle(button);
                const size = matchMedia('(pointer: coarse)').matches ? '44px' : '32px';
                return style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.borderTopWidth === '0px'
                    && style.height === size && (button.id === 'vertexai_validate_service_account' || style.width === size)
                    ? [] : [{ id: button.id || button.className, background: style.backgroundColor, border: style.borderTopWidth, width: style.width, height: style.height }];
            }));
            expect(failures).toEqual([]);
            await page.locator('#main_api').selectOption('textgenerationwebui');
            await page.locator('#ollama_download_model').evaluate(node => {
                for (let parent = node; parent && parent !== document.body; parent = parent.parentElement) {
                    parent.hidden = false;
                    if (getComputedStyle(parent).display === 'none') parent.style.setProperty('display', 'block', 'important');
                }
            });
            const download = page.locator('#ollama_download_model');
            await expect(download).toHaveAccessibleName('Download');
            expect(await download.evaluate(node => node.querySelector('span').getBoundingClientRect().width)).toBeLessThanOrEqual(1);
            await expect(page.locator('#vertexai_validate_service_account')).toHaveText('Validate JSON');
        });

        test('Vertex rows stretch across their upstream flex parent', async ({ page }) => {
            await mountConnections(page);
            await page.locator('#chat_completion_source').selectOption('vertexai');
            await page.locator('[data-sb-editor-field="vertexai_auth_mode"]').evaluate(row => {
                row.parentElement.classList.remove('flexFlowColumn');
                row.parentElement.style.display = 'flex';
                row.parentElement.style.flexDirection = 'row';
            });
            const failures = await page.locator('#openai_api .ds-row:visible').evaluateAll(rows => rows.flatMap(row => {
                const parent = row.parentElement;
                const style = getComputedStyle(parent);
                const available = parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
                const width = row.getBoundingClientRect().width;
                return Math.abs(width - available) <= 1 ? [] : [{ field: row.dataset.sbEditorField || row.className, width, available }];
            }));
            expect(failures).toEqual([]);
        });

        test('CC and TC Authorize match the General button row', async ({ page }) => {
            await mountConnections(page);
            await page.locator('#chat_completion_source').selectOption('openrouter');
            const reference = page.locator('[data-sb-editor-field="view-hidden-api-keys"]');
            const geometry = node => {
                const style = getComputedStyle(node);
                return { height: node.getBoundingClientRect().height, padding: style.padding, justify: style.justifyContent, textAlign: style.textAlign, border: style.borderTopWidth, radius: style.borderRadius, background: style.backgroundColor };
            };
            const expected = await reference.evaluate(geometry);
            await reference.focus();
            expect(await reference.evaluate(node => getComputedStyle(node).boxShadow)).toContain('inset');
            await reference.evaluate(node => node.blur());
            for (const api of ['openai', 'textgenerationwebui']) {
                await page.locator('#main_api').selectOption(api);
                const authorize = page.locator('.sb-connections-provider:not([hidden]) .openrouter_authorize');
                await expect(authorize).toBeVisible();
                expect(await authorize.evaluate(geometry)).toEqual(expected);
                await authorize.focus();
                await expect(authorize).toHaveCSS('outline-style', 'none');
                expect(await authorize.evaluate(node => getComputedStyle(node).boxShadow)).toContain('inset');
            }
        });
    });
}

for (const width of [390, 360]) {
    test.describe(`Select title priority at ${width}px`, () => {
        test.use({ viewport: { width, height: 1000 }, hasTouch: true });

        test('select titles stay readable before long values truncate, including shared, Profile and Source rows', async ({ page }) => {
            await mountConnections(page);
            await page.evaluate(async () => {
                const { createSelectRow } = await import('/scripts/sillybunny-editor/select-row.js');
                const group = document.createElement('div');
                group.className = 'ds-pref-group';
                const host = document.querySelector('.sb-settings-mounted-shell');
                host.style.width = 'calc(100vw - 32px)';
                host.prepend(group);
                for (const [field, label] of [['shared-short-title', 'Speech to Text'], ['shared-long-title', 'Speech Recognition Language Preference']]) {
                    const select = document.createElement('select');
                    select.append(new Option('A selected value that is deliberately much longer than the available row width', 'long'));
                    group.append(createSelectRow({ select, label, field }).row);
                }
                const profile = document.querySelector('#connection_profiles option[value="fixture"]');
                profile.textContent = 'A connection profile with a deliberately long selected name';
                window.jQuery('#connection_profiles').val('fixture').trigger('change');
                for (const id of ['model_openrouter_select', 'openrouter_model']) {
                    const select = document.getElementById(id);
                    select.append(new Option('A model value that is deliberately much longer than its row title', 'long', true, true));
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                }
                document.querySelector('#chat_completion_source option[value="openrouter"]').textContent = 'OpenRouter with a deliberately long source name';
                window.jQuery('#chat_completion_source').val('openrouter').trigger('change');
            });
            for (const [api, field] of [['openai', 'model_openrouter_select'], ['textgenerationwebui', 'openrouter_model']]) {
                await page.locator('#main_api').selectOption(api);
                const titles = page.locator('.ds-select-row:visible .ds-row-label');
                const clippedTitles = await titles.evaluateAll(labels => labels.flatMap(label => label.scrollWidth <= label.clientWidth ? [] : [label.textContent]));
                expect(clippedTitles).toEqual([]);
                const label = page.locator(`[data-sb-editor-field="${field}"] .ds-row-label`);
                expect(await label.evaluate(node => node.clientHeight)).toBeLessThanOrEqual(await label.evaluate(node => parseFloat(getComputedStyle(node).lineHeight) + 1));
                const value = page.locator(`[data-sb-editor-field="${field}"] .ds-select-row__value`);
                await expect(value).toHaveCSS('text-overflow', 'ellipsis');
                expect(await value.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
            }
            const shared = page.locator('[data-sb-editor-field="shared-long-title"] .ds-row-label');
            expect(await shared.evaluate(node => node.clientHeight / parseFloat(getComputedStyle(node).lineHeight))).toBeGreaterThan(1);
            expect(await shared.evaluate(node => node.clientHeight / parseFloat(getComputedStyle(node).lineHeight))).toBeLessThanOrEqual(2.1);
            await page.locator('[data-sb-editor-field="shared-short-title"] .ds-select-row__trigger').click();
            await expect(page.locator('.sb-picker-sheet')).toBeVisible();
        });
    });
}

for (const width of [1440, 768, 390, 360]) {
    test.describe(`Connections shell at ${width}px`, () => {
        test.use({ viewport: { width, height: 1000 }, contextOptions: { reducedMotion: 'reduce' } });

        test('keeps the groups, labels, action count, and overflow contract', async ({ page }) => {
            await mountConnections(page);
            const panel = page.locator('.sb-connections-panel');
            const groups = panel.locator(':scope > .sb-editor-section');
            await expect(groups.nth(0)).toHaveClass(/sb-connections-profile/);
            await expect(groups.nth(1)).toHaveAttribute('data-sb-editor-field', 'backend');
            await expect(panel.locator('[data-sb-provider="openai"]')).toBeVisible();
            await expect(groups.last()).toHaveAttribute('data-sb-editor-field', 'general');
            expect(await panel.evaluate(element => [...element.children].map(node => node.dataset.sbEditorField ?? node.dataset.sbProvider))).toEqual([
                'profile', 'backend', 'openai', 'textgenerationwebui', 'novel', 'koboldhorde', 'kobold', 'general',
            ]);
            await expect(panel.locator('.ds-toggle-row [role="radiogroup"]')).toHaveCount(1);
            await expect(panel.locator('.ds-toggle-row i, .ds-toggle-row img, .ds-toggle-row svg')).toHaveCount(0);
            await expect(panel.locator('[data-sb-backend-source]:visible')).toHaveCount(1);
            await expect(panel.locator('.suggested-action:visible')).toHaveText(['Connect']);
            expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
            expect(await panel.evaluate(element => [...element.querySelectorAll('*')].some(node => getComputedStyle(node).position === 'sticky'))).toBe(false);
        });

        test('provider rows keep titles and captions inside the viewport and open the adaptive picker', async ({ page }) => {
            await mountConnections(page);
            const failures = await page.locator('.sb-connections-provider .ds-row:visible').evaluateAll(rows => rows.flatMap(row => {
                const rect = row.getBoundingClientRect();
                return [...row.querySelectorAll('.ds-row-entry__caption, .ds-row-label')].flatMap(node => {
                    const box = node.getBoundingClientRect();
                    const truncated = getComputedStyle(node).textOverflow === 'ellipsis';
                    return box.right <= rect.right + 1 && box.left >= rect.left - 1 && (truncated || node.scrollWidth <= node.clientWidth + 1) ? [] : [row.dataset.sbEditorField || node.textContent];
                });
            }));
            expect(failures).toEqual([]);
            await page.locator('[data-sb-editor-field="model_openai_select"] .ds-select-row__trigger').click();
            await expect(page.locator(width <= 768 ? '.sb-picker-sheet' : '.sb-picker')).toBeVisible();
        });

        test('Featherless keeps its original filters usable without clipping', async ({ page }) => {
            await mountConnections(page);
            await page.evaluate(() => {
                window.jQuery('#main_api').val('textgenerationwebui').trigger('change');
                for (const gate of document.querySelectorAll('[data-tg-type]')) {
                    gate.style.display = gate.dataset.tgType.split(',').map(value => value.trim()).includes('featherless') ? '' : 'none';
                }
            });
            const failures = await page.locator('#featherless_model_search_bar, #featherless_model_sort_order, #featherless_category_selection, #featherless_class_selection, #featherless_model_grid_toggle').evaluateAll(controls => controls.flatMap(control => {
                const box = control.getBoundingClientRect();
                const bounds = control.closest('.ds-pref-group').getBoundingClientRect();
                return box.width >= 44 && box.left >= bounds.left && box.right <= bounds.right ? [] : [control.id];
            }));
            expect(failures).toEqual([]);
            await expect(page.locator('#featherless_model')).toBeHidden();
        });
    });
}

test('manual backend and source picks clear the profile while external changes only resync', async ({ page }) => {
    await mountConnections(page);
    const profile = page.locator('#connection_profiles');
    const source = id => page.locator(`[data-sb-backend-source="${id}"]`);
    const chooseSource = async (id, label) => {
        await source(id).locator('.ds-select-row__trigger').click();
        await page.locator('.sb-picker').getByRole('option', { name: label, exact: true }).click();
    };

    await profile.selectOption('fixture');
    await chooseSource('chat', 'Custom (OpenAI-compatible)');
    await expect(profile).toHaveValue('');
    await expect(page.locator('#chat_completion_source')).toHaveValue('custom');

    await profile.selectOption('fixture');
    await page.evaluate(() => window.jQuery('#chat_completion_source').val('openrouter').trigger('change'));
    await expect(source('chat').locator('.ds-select-row__value')).toHaveText('OpenRouter');
    await expect(profile).toHaveValue('fixture');

    await page.locator('.ds-toggle-row input[value="text"]').check();
    await expect(profile).toHaveValue('');
    await profile.selectOption('fixture');
    await chooseSource('text', 'KoboldCpp');
    await expect(profile).toHaveValue('');
    await expect(page.locator('#textgen_type')).toHaveValue('koboldcpp');

    await profile.selectOption('fixture');
    await page.locator('.ds-toggle-row input[value="other"]').check();
    await expect(profile).toHaveValue('');
    await profile.selectOption('fixture');
    await chooseSource('other', 'AI Horde');
    await expect(profile).toHaveValue('');
    await expect(page.locator('#main_api')).toHaveValue('koboldhorde');
    await expect(source('other').locator('.ds-select-row__value')).toHaveText('AI Horde');

    await profile.selectOption('fixture');
    await page.evaluate(() => window.jQuery('#main_api').val('kobold').trigger('change'));
    await expect(source('other').locator('.ds-select-row__value')).toHaveText('KoboldAI Classic');
    await expect(profile).toHaveValue('fixture');
});

test.describe('profile menu', () => {
    test.use({ viewport: { width: 1440, height: 1000 }, contextOptions: { reducedMotion: 'reduce' } });

    const PROFILE_ACTIONS = [
        ['update_connection_profile', 'Update'],
        ['reload_connection_profile', 'Reload'],
        ['create_connection_profile', 'New…'],
        ['edit_connection_profile', 'Edit…'],
        ['view_connection_profile', 'View Details'],
        ['toggle_profile_favorite', 'Favorite'],
        ['manage_profile_folders', 'Manage Folders…'],
        ['delete_connection_profile', 'Delete…'],
        ['delete_all_connection_profiles', 'Delete All…'],
    ];

    test('q56 profile, backend and provider dropdown owners close on their second click', async ({ page }, testInfo) => {
        await mountConnections(page);
        await page.locator('.sb-connections-panel').evaluate(node => { node.tabIndex = -1; });
        const trace = [];
        for (const row of await page.locator('.sb-connections-panel .ds-select-row:visible').all()) {
            const trigger = row.locator('.ds-select-row__trigger');
            const label = await row.locator('.ds-row-label').textContent();
            for (const [part, target] of [['button', trigger], ['label', row.locator('.ds-row-label')]]) {
                await target.click();
                await expect(trigger).toHaveAttribute('aria-expanded', 'true');
                await target.click();
                await expect.soft(trigger).toHaveAttribute('aria-expanded', 'false');
                trace.push({ label, part, secondClickExpanded: await trigger.getAttribute('aria-expanded') });
                await page.evaluate(async () => (await import('/scripts/sillybunny-editor/picker.js')).closePicker({ animate: false, restoreFocus: false }));
            }
        }
        const profile = page.locator('.sb-connections-profile .ds-select-row__trigger');
        const menu = page.locator('.sb-connections-profile .ds-select-row__menu');
        await profile.click();
        await menu.click();
        await expect(profile).toHaveAttribute('aria-expanded', 'false');
        await expect(menu).toHaveAttribute('aria-expanded', 'true');
        await menu.locator('i').click();
        await expect(menu).toHaveAttribute('aria-expanded', 'false');
        trace.push({ label: 'Profile menu', part: 'button/icon', secondClickExpanded: await menu.getAttribute('aria-expanded') });
        await testInfo.attach('q56 Connections dropdown sweep', { body: JSON.stringify(trace), contentType: 'application/json' });
    });

    test('proxies all nine buttons in four sections and mirrors their state', async ({ page }) => {
        await mountConnections(page);
        await page.evaluate(ids => {
            window.profileClicks = [];
            for (const id of ids) document.getElementById(id).addEventListener('click', () => window.profileClicks.push(id));
            document.getElementById('update_connection_profile').classList.add('disabled');
            document.getElementById('reload_connection_profile').setAttribute('disabled', '');
            document.getElementById('edit_connection_profile').setAttribute('aria-disabled', 'true');
            document.getElementById('toggle_profile_favorite').setAttribute('aria-pressed', 'true');
        }, PROFILE_ACTIONS.map(([id]) => id));
        const openMenu = () => page.locator('.sb-connections-panel .ds-select-row__menu').click();
        await openMenu();
        const menu = page.locator('.sb-action-popover .sb-action-menu');
        const items = menu.locator('[role^="menuitem"]');
        await expect(items.locator('.sb-action-menu-label')).toHaveText(PROFILE_ACTIONS.map(([, label]) => label));
        await expect(menu.locator('[role="separator"]')).toHaveCount(3);
        for (const label of ['Update', 'Reload', 'Edit…']) {
            await expect(items.filter({ hasText: label })).toHaveAttribute('aria-disabled', 'true');
        }
        await expect(items.filter({ hasText: 'View Details' })).not.toHaveAttribute('aria-disabled', 'true');
        await expect(items.filter({ hasText: 'Favorite' })).toHaveAttribute('aria-checked', 'true');

        const enabled = PROFILE_ACTIONS.filter(([id]) => !['update_connection_profile', 'reload_connection_profile', 'edit_connection_profile'].includes(id));
        await items.filter({ hasText: new RegExp(`^${enabled[0][1]}$`) }).click();
        for (const [, label] of enabled.slice(1)) {
            await openMenu();
            await items.filter({ hasText: new RegExp(`^${label}$`) }).click();
        }
        expect(await page.evaluate(() => window.profileClicks)).toEqual(enabled.map(([id]) => id));
    });

    test('a second click on the Profile bar closes its picker', async ({ page }) => {
        await mountConnections(page);
        const bar = page.locator('.sb-connections-panel .ds-profile-row .ds-row-label');
        const trigger = page.locator('.sb-connections-panel .ds-profile-row .ds-select-row__trigger');
        await bar.click();
        await expect(trigger).toHaveAttribute('aria-expanded', 'true');
        await bar.click();
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('.sb-picker__search')).toHaveCount(0);
        await trigger.click();
        await expect(trigger).toHaveAttribute('aria-expanded', 'true');
        await trigger.click();
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });

    test('teardown closes a menu that is still open', async ({ page }) => {
        await mountConnections(page);
        await page.locator('.sb-connections-panel .ds-select-row__menu').click();
        await expect(page.locator('.sb-action-popover')).toHaveCount(1);
        await page.evaluate(() => window.connectionsFixture.panel.teardown());
        await expect(page.locator('.sb-action-popover')).toHaveCount(0);
    });
});

test('teardown restores every upstream node and its presentation attributes', async ({ page }) => {
    await mountConnections(page);
    const differences = await page.evaluate(() => {
        const { panel, originals } = window.connectionsFixture;
        const normalizeAttributes = attributes => Object.fromEntries(attributes
            .filter(([name, value]) => name !== 'class' || value.trim())
            .map(([name, value]) => [name, name === 'class' ? value.trim().split(/\s+/).sort().join(' ') : value]));
        panel.teardown();
        return originals.flatMap(({ node, parent, next, attributes }) => {
            const before = normalizeAttributes(attributes);
            const after = normalizeAttributes([...node.attributes].map(attribute => [attribute.name, attribute.value]));
            const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => before[name] !== after[name]);
            if (node.parentNode === parent && node.nextSibling === next && !changed.length) return [];
            return [{ node: node.id || node.tagName, parentRestored: node.parentNode === parent, siblingRestored: node.nextSibling === next, changed }];
        });
    });
    expect(differences).toEqual([]);
});

test('teardown does not resurrect an upstream node removed while mounted', async ({ page }) => {
    await mountConnections(page);
    await page.evaluate(() => {
        document.getElementById('connection_profiles').remove();
        window.connectionsFixture.panel.teardown();
    });
    await expect(page.locator('#connection_profiles')).toHaveCount(0);
});

test('teardown restores the current select2 container after upstream reinitialization', async ({ page }) => {
    await mountConnections(page);
    await page.addScriptTag({ url: '/lib/select2.min.js' });
    const restored = await page.evaluate(() => {
        const select = document.getElementById('model_openai_select');
        const $select = window.jQuery(select);
        $select.select2();
        const oldContainer = $select.data('select2').$container[0];
        $select.select2('destroy');
        $select.select2();
        const current = $select.data('select2').$container[0];
        window.connectionsFixture.panel.teardown();
        const original = window.connectionsFixture.originals.find(entry => entry.node === select);
        return { adjacent: select.nextElementSibling === current, currentConnected: current.isConnected, oldDisconnected: !oldContainer.isConnected, selectRestored: select.parentElement === original.parent };
    });
    expect(restored).toEqual({ adjacent: true, currentConnected: true, oldDisconnected: true, selectRestored: true });
});

test.describe('coarse-pointer status controls', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test('secondary status actions retain a 44px touch target', async ({ page }) => {
        await mountConnections(page);
        await page.locator('#chat_completion_source').selectOption('openrouter');
        const authorize = page.locator('#openai_api .sb-connections-status-extra .openrouter_authorize');
        await expect(authorize).toBeVisible();
        expect(await authorize.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    });
});
