#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
import { auditLibadwaita, LIBADWAITA_AUDIT_ALLOWLIST } from './helpers/libadwaita-audit.js';

const baseURL = process.env.SILLYBUNNY_TEST_BASE_URL || 'http://127.0.0.1:4444';
const outputPath = process.env.PHASE4_AUDIT_OUTPUT || '/tmp/opencode/phase4-libadwaita-audit.json';
const screenshotDirectory = process.env.PHASE4_VISUAL_OUTPUT;
const backendTabs = [
    { id: 'connections', label: 'Connections', shell: 'left' },
    { id: 'sampling', label: 'Sampling', shell: 'left' },
    { id: 'prompting', label: 'Presets', shell: 'left' },
    { id: 'editor', label: 'Editor', shell: 'left' },
    { id: 'context', label: 'Formatting', shell: 'left' },
    { id: 'agents', label: 'Agents', shell: 'left' },
];
const customizeTabs = [
    { id: 'appearance', label: 'Appearance', shell: 'right' },
    { id: 'interface', label: 'Interface', shell: 'right' },
    { id: 'messages', label: 'Messages', shell: 'right' },
    { id: 'data-security', label: 'Data & Security', shell: 'right' },
    { id: 'logs', label: 'Logs', shell: 'right' },
];
const extensionTab = { id: 'extensions', label: 'Extensions list', shell: 'right' };
const backends = [
    { id: 'openai', source: 'openrouter' },
    { id: 'textgenerationwebui', source: 'ooba' },
    { id: 'kobold', source: null },
    { id: 'koboldhorde', source: null },
    { id: 'novel', source: null },
];
const themes = [
    { value: 'Libadwaita', label: 'libadwaita-dark' },
    { value: 'Libadwaita Light', label: 'libadwaita-light' },
];
const viewports = [
    { width: 1920, height: 1080, label: '1920x1080' },
    { width: 390, height: 844, label: '390x844' },
];
const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function assertLocalBaseURL(value) {
    const parsed = new URL(value);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
        throw new Error(`Refusing to run the settings sweep against a non-local host: ${parsed.hostname}`);
    }
    return parsed;
}

function isAllowlisted(record) {
    return LIBADWAITA_AUDIT_ALLOWLIST.some(entry => {
        if (entry.rule !== '*' && entry.rule !== record.rule) return false;
        return record.selector === entry.selector || record.selector.startsWith(`${entry.selector} `)
            || record.selector.startsWith(`${entry.selector} >`)
            || (entry.selector === '#completion_prompt_manager' && record.selector.includes('completion_prompt_manager'));
    });
}

function getRepresentativeSignature(records) {
    const signatures = records
        // Zero-width borders resolve to currentColor; only painted separators establish parity.
        .filter(record => record.rule === 'cross-tab-parity' && record.measured?.signature?.separatorColor)
        .map(record => record.measured.signature);
    if (!signatures.length) return null;

    const frequency = new Map();
    for (const signature of signatures) {
        const key = JSON.stringify(signature);
        const existing = frequency.get(key) || { signature, count: 0 };
        existing.count++;
        frequency.set(key, existing);
    }
    return [...frequency.values()].sort((left, right) => right.count - left.count)[0].signature;
}

function compareSignatures(left, right) {
    if (!left || !right) return { pass: false, differences: ['no measurable row signature'] };
    const differences = [];
    for (const key of ['paddingLeft', 'paddingRight', 'minHeight', 'gap', 'titleFontSize']) {
        if (left[key] == null || right[key] == null) {
            if (left[key] !== right[key]) differences.push(`${key}: ${left[key]} vs ${right[key]}`);
            continue;
        }
        if (Math.abs(left[key] - right[key]) > 1) differences.push(`${key}: ${left[key]} vs ${right[key]}`);
    }
    if (left.separatorColor !== right.separatorColor) differences.push(`separatorColor: ${left.separatorColor} vs ${right.separatorColor}`);
    return { pass: differences.length === 0, differences };
}

function applyCrossTabParity(records, expectedTabs) {
    const scenarios = new Map();
    for (const record of [...records]) {
        const family = record.family;
        if (family === 'extensions') continue;
        const key = [family, record.backend, record.theme, record.viewport].join('|');
        const scenario = scenarios.get(key) || new Map();
        const tabRecords = scenario.get(record.tab) || [];
        tabRecords.push(record);
        scenario.set(record.tab, tabRecords);
        scenarios.set(key, scenario);
    }

    for (const [scenarioKey, tabRecords] of scenarios) {
        const family = scenarioKey.split('|')[0];
        const tabs = expectedTabs[family];
        // SillyBunny: pick the first tab that yields a non-null signature AND is not
        // allowlisted for cross-tab-parity. Connections has no .ds-row elements (null
        // signature). Sampling uses intentionally compact 44 px rows. Using either as
        // the reference would fail all other tabs. Skip both via the allowlist.
        let referenceTab = tabs[0];
        let referenceSignature = null;
        for (const candidate of tabs) {
            const candidateSelector = `[data-sb-panel="${candidate.id}"]`;
            const candidateExcluded = LIBADWAITA_AUDIT_ALLOWLIST.some(
                e => (e.rule === '*' || e.rule === 'cross-tab-parity') && e.selector === candidateSelector,
            );
            if (candidateExcluded) continue;
            const sig = getRepresentativeSignature(tabRecords.get(candidate.label) || []);
            if (sig) { referenceTab = candidate; referenceSignature = sig; break; }
        }
        for (const tab of tabs) {
            const currentRecords = tabRecords.get(tab.label) || [];
            const currentSignature = getRepresentativeSignature(currentRecords);
            const result = compareSignatures(referenceSignature, currentSignature);
            const basis = currentRecords.find(record => record.rule === 'cross-tab-parity') || currentRecords[0];
            records.push({
                tab: tab.label,
                backend: basis?.backend || (family === 'backend' ? scenarioKey.split('|')[1] : 'n/a'),
                theme: basis?.theme || scenarioKey.split('|')[2],
                viewport: basis?.viewport || scenarioKey.split('|')[3],
                rule: 'cross-tab-parity',
                selector: basis?.selector || `[data-sb-panel="${tab.id}"]`,
                measured: {
                    referenceTab: referenceTab.label,
                    referenceSignature,
                    signature: currentSignature,
                    differences: result.differences,
                },
                pass: result.pass,
                // SillyBunny: also check the tab's panel selector so allowlist entries
                // like `[data-sb-panel="sampling"]` fire even when `basis` points to a
                // deep row selector that does not start with the panel selector.
                allowlisted: isAllowlisted({ selector: `[data-sb-panel="${tab.id}"]`, rule: 'cross-tab-parity' })
                    || (basis ? isAllowlisted(basis) : false),
                family,
            });
        }
    }
}

function buildSummary(records) {
    const failures = records.filter(record => !record.pass && !record.allowlisted);
    const allowlistedFailures = records.filter(record => !record.pass && record.allowlisted);
    const dimensions = new Map();
    for (const record of records) {
        const key = `${record.tab}||${record.rule}`;
        const stats = dimensions.get(key) || { tab: record.tab, rule: record.rule, total: 0, pass: 0, fail: 0, allowlisted: 0 };
        stats.total++;
        if (record.pass) stats.pass++;
        else if (record.allowlisted) stats.allowlisted++;
        else stats.fail++;
        dimensions.set(key, stats);
    }
    const perTabAndRule = [...dimensions.values()].map(stats => ({
        ...stats,
        failRate: stats.total ? Number((stats.fail / stats.total).toFixed(4)) : 0,
    })).sort((left, right) => left.tab.localeCompare(right.tab) || left.rule.localeCompare(right.rule));

    return {
        totalRecords: records.length,
        passCount: records.filter(record => record.pass).length,
        failCount: failures.length,
        allowlistedFailureCount: allowlistedFailures.length,
        failRate: records.length ? Number((failures.length / records.length).toFixed(4)) : 0,
        perTabAndRule,
    };
}

async function mockWritesBeforeNavigation(page, origin) {
    let version = 1_000_000_000_000_000;
    const readOnlyEndpoints = new Set([
        '/api/characters/all', '/api/characters/chats', '/api/groups/all', '/api/backgrounds/all',
        '/api/avatars/get', '/api/stats/get', '/api/secrets/read', '/api/users/me',
    ]);
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();

        if (url.pathname === '/api/settings/get') {
            const response = await route.fetch();
            const data = await response.json();
            data.request_compression = { ...data.request_compression, enabled: false };
            const settings = JSON.parse(data.settings);
            settings.firstRun = false;
            settings.extension_settings ??= {};
            settings.extension_settings['quick-image-gen'] = {
                ...settings.extension_settings['quick-image-gen'],
                setupWizardSeen: true,
            };
            data.settings = JSON.stringify(settings);
            return route.fulfill({ json: data });
        }

        if (readOnlyEndpoints.has(url.pathname) || url.pathname.startsWith('/api/tokenizers/')) {
            return route.continue();
        }

        if (writeMethods.has(request.method())) {
            if (url.pathname === '/api/settings/save') return route.fulfill({ json: { version: ++version } });
            if (url.pathname === '/api/presets/save') {
                return route.fulfill({ json: { name: request.postDataJSON()?.name ?? '' } });
            }
            return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        }
        return route.continue();
    });
}

async function setBackend(page, backend) {
    await page.evaluate(({ api, source }) => {
        $('#main_api').val(api).trigger('change');
        if (source) $(api === 'openai' ? '#chat_completion_source' : '#textgen_type').val(source).trigger('change');
    }, { api: backend.id, source: backend.source });
    await page.waitForFunction(api => document.querySelector('#main_api')?.value === api, backend.id);
}

async function setTheme(page, theme) {
    await page.waitForFunction(value => [...(document.querySelector('#themes')?.options || [])]
        .some(option => option.value === value || option.textContent.trim() === value), theme.value, { timeout: 30000 });
    const selected = await page.evaluate(value => {
        const select = document.querySelector('#themes');
        const option = [...(select?.options || [])].find(item => item.value === value || item.textContent.trim() === value);
        if (!select || !option) return null;
        select.value = option.value;
        $(select).trigger('change');
        return { value: option.value, label: option.textContent.trim() };
    }, theme.value);
    if (!selected) throw new Error(`The theme selector has no option for ${theme.value}`);
    await page.waitForFunction(value => document.querySelector('#themes')?.value === value, selected.value);
}

async function openSettingsTab(page, tab) {
    await page.evaluate(({ shell, id }) => window.SillyBunnyShell.openTab(shell, id), { shell: tab.shell, id: tab.id });
    const button = page.locator(`button[data-sb-settings-tab="${tab.id}"]`);
    await button.evaluate(element => element.click());
    const panel = page.locator(`[data-sb-panel="${tab.id}"]`);
    await panel.waitFor({ state: 'visible', timeout: 20000 });
    await panel.locator('.sb-shell-panel-scroller').evaluate(scroller => { scroller.scrollTop = 0; }).catch(() => {});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return panel;
}

async function auditTab(page, tab, family, backend, theme, viewport) {
    const panel = await openSettingsTab(page, tab);
    if (screenshotDirectory && family === 'backend' && ['prompting', 'editor', 'sampling', 'context'].includes(tab.id)) {
        await mkdir(screenshotDirectory, { recursive: true });
        await page.screenshot({ path: `${screenshotDirectory}/${theme.label}-${viewport.label}-${backend.id}-${tab.id}.png` });
    }
    const measuredRecords = await panel.evaluate(auditLibadwaita, { allowlist: LIBADWAITA_AUDIT_ALLOWLIST });
    const normalizedTheme = theme.label;
    const records = measuredRecords.map(record => ({
        ...record,
        tab: tab.label,
        backend: backend?.id ?? 'n/a',
        theme: normalizedTheme,
        viewport: viewport.label,
        family,
    }));
    if (!records.some(record => record.rule === 'cross-tab-parity')) {
        const fallbackSelector = `[data-sb-panel="${tab.id}"]`;
        records.push({
            tab: tab.label,
            backend: backend?.id ?? 'n/a',
            theme: normalizedTheme,
            viewport: viewport.label,
            rule: 'cross-tab-parity',
            selector: fallbackSelector,
            measured: { error: 'No visible preference row was available to derive a signature' },
            pass: false,
            // SillyBunny: Connections has no .ds-row rows; its fallback record must also
            // be checked against the allowlist so the pre-existing allowlist entry fires.
            allowlisted: isAllowlisted({ selector: fallbackSelector, rule: 'cross-tab-parity' }),
            family,
        });
    }
    return records;
}

async function main() {
    const parsedBaseURL = assertLocalBaseURL(baseURL);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce' });
    const page = await context.newPage();
    const records = [];

    try {
        // Route every possible write before page.goto so startup cannot persist fixture changes.
        await mockWritesBeforeNavigation(page, parsedBaseURL.origin);
        await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'), null, { timeout: 60000 });

        for (const theme of themes) {
            for (const viewport of viewports) {
                await page.setViewportSize({ width: viewport.width, height: viewport.height });
                await setTheme(page, theme);
                for (const backend of backends) {
                    await setBackend(page, backend);
                    for (const tab of backendTabs) {
                        records.push(...await auditTab(page, tab, 'backend', backend, theme, viewport));
                    }
                }
                await setBackend(page, backends[0]);
                for (const tab of customizeTabs) {
                    records.push(...await auditTab(page, tab, 'customize', null, theme, viewport));
                }
                records.push(...await auditTab(page, extensionTab, 'extensions', null, theme, viewport));
            }
        }

        applyCrossTabParity(records, { backend: backendTabs, customize: customizeTabs });
    } finally {
        await context.close();
        await browser.close();
    }

    const report = {
        generatedAt: new Date().toISOString(),
        baseURL,
        matrix: {
            backendTabs: backendTabs.map(tab => tab.label),
            customizeTabs: customizeTabs.map(tab => tab.label),
            extensions: extensionTab.label,
            backends: backends.map(backend => backend.id),
            themes: themes.map(theme => theme.label),
            viewports: viewports.map(viewport => viewport.label),
        },
        allowlist: LIBADWAITA_AUDIT_ALLOWLIST,
        summary: buildSummary(records),
        records,
    };
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`Libadwaita sweep wrote ${outputPath}`);
    console.log(JSON.stringify(report.summary, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
