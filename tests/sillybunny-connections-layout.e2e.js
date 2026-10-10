/* global globalThis */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const publicRoot = path.resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const indexMarkup = readFileSync(path.join(publicRoot, 'index.html'), 'utf8');

async function mountConnections(page, source) {
    await page.route('http://connections.test/**', route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/') {
            return route.fulfill({
                contentType: 'text/html',
                body: '<!doctype html><html><head>'
                    + '<link rel="stylesheet" href="/style.css">'
                    + '<link rel="stylesheet" href="/css/st-tailwind.css">'
                    + '<link rel="stylesheet" href="/css/sillybunny-theme.css">'
                    + '<link rel="stylesheet" href="/css/sillybunny-tabs.css">'
                    + '<link rel="stylesheet" href="/css/sillybunny-mobile-shell.css" media="(max-width: 768px)">'
                    + '</head><body><main id="sb-settings-page"><div class="sb-settings-mounted-shell">'
                    + '<div id="rm_api_block"></div></div></main></body></html>',
            });
        }
        if (pathname === '/script.js') {
            return route.fulfill({
                contentType: 'text/javascript',
                body: 'export const eventSource = {}; export const event_types = {};',
            });
        }
        const filePath = path.resolve(publicRoot, `.${pathname}`);
        if (!filePath.startsWith(`${publicRoot}${path.sep}`)) {
            return route.abort();
        }
        return route.fulfill({
            path: filePath,
            contentType: pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
    });
    await page.goto('http://connections.test/');
    await page.addScriptTag({ url: '/lib/jquery-3.5.1.min.js' });
    await page.evaluate(async ({ markup, source }) => {
        const parsed = new DOMParser().parseFromString(markup, 'text/html');
        const root = document.getElementById('rm_api_block');
        root.append(parsed.getElementById('main_api'), parsed.getElementById('openai_api'));
        document.getElementById('main_api').value = 'openai';
        document.getElementById('chat_completion_source').value = source;

        const { createConnectionsPanel } = await import('/scripts/sillybunny-connections-panel.js');
        const { flattenNestedSettingsDrawers } = await import('/scripts/sillybunny-settings-content.js');
        const panel = createConnectionsPanel({
            createElement(tag, options = {}) {
                const node = document.createElement(tag);
                node.className = options.className ?? '';
                node.textContent = options.text ?? '';
                if (options.type) node.setAttribute('type', options.type);
                for (const [key, value] of Object.entries(options.attrs ?? {})) {
                    node.setAttribute(key, value);
                }
                return node;
            },
            getActiveApi: () => 'openai',
            applyPanelApiVisibility() {},
        });
        document.querySelector('.sb-settings-mounted-shell').append(panel.column);
        flattenNestedSettingsDrawers(panel.column, { includeTopLevel: true });
        globalThis.$('[data-source]').each(function () {
            globalThis.$(this).toggle(this.dataset.source.split(',').includes(source));
        });
    }, { markup: indexMarkup, source });
}

const providers = [
    {
        source: 'openai', sectionBorder: '1px', form: 'openai_form',
        leadingField: '#openai_proxy_access_key',
        fields: ['#openai_reverse_proxy_name', '#openai_reverse_proxy', '#openai_proxy_source', '.flex-container:has(> #openai_proxy_access_key)'],
    },
    {
        source: 'deepseek', sectionBorder: '1px', form: null,
        leadingField: '#openai_proxy_access_key',
        fields: ['#openai_reverse_proxy_name', '#openai_reverse_proxy', '#openai_proxy_source', '.flex-container:has(> #openai_proxy_access_key)'],
    },
    {
        source: 'custom', sectionBorder: '0px', form: 'custom_form',
        leadingField: '#custom_endpoint_preset_name', fields: ['#custom_endpoint_preset_name'],
    },
];

for (const width of [1440, 768, 390]) {
    test.describe(`Connections provider layout at ${width}px`, () => {
        test.use({ viewport: { width, height: 1000 } });

        for (const provider of providers) {
            test(`${provider.source} keeps settings inset within the provider pill`, async ({ page }, testInfo) => {
                await mountConnections(page, provider.source);
                for (const selector of provider.fields) {
                    const geometry = await page.locator(selector).evaluate(input => {
                        const pill = input.closest('.sb-connections-provider-body').getBoundingClientRect();
                        const field = input.getBoundingClientRect();
                        const section = input.closest('.sb-settings-flat-section');
                        return {
                            start: field.left - pill.left,
                            end: pill.right - field.right,
                            sectionBorder: getComputedStyle(section).borderTopWidth,
                            parentBorder: getComputedStyle(section.parentElement).borderTopWidth,
                        };
                    });
                    expect(geometry.start, selector).toBe(17);
                    expect(geometry.end, selector).toBe(17);
                    expect(geometry.sectionBorder).toBe(provider.sectionBorder);
                    expect(geometry.parentBorder).toBe('1px');
                }
                const leadingInset = await page.locator(provider.leadingField).evaluate(input => {
                    return input.getBoundingClientRect().left - input.closest('.sb-connections-provider-body').getBoundingClientRect().left;
                });
                expect(leadingInset).toBe(17);
                expect(await page.locator(`#api_key_${provider.source}`).evaluate(input => input.form?.id ?? null)).toBe(provider.form);
                const screenshotPath = testInfo.outputPath('provider-layout.png');
                await page.locator('.sb-connections-provider-body').screenshot({ path: screenshotPath });
                await testInfo.attach('provider-layout', {
                    path: screenshotPath,
                    contentType: 'image/png',
                });
            });
        }
    });
}
