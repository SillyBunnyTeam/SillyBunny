import { gunzipSync } from 'node:zlib';
import { bootMiscDialogs, MISC_VIEWPORTS } from './misc-dialogs.js';

export const UTILITY_VIEWPORTS = MISC_VIEWPORTS;
export const UTILITY_SURFACES = ['recent', 'persona', 'secret', 'regex', 'quick-reply', 'image', 'web', 'mediawiki', 'fandom', 'youtube', 'icons'];

function payload(request) {
    const body = request.postDataBuffer();
    return body ? JSON.parse((request.headers()['content-encoding'] === 'gzip' ? gunzipSync(body) : body).toString()) : {};
}

export async function bootUtilityDialogs(page, viewport) {
    const state = { secrets: [], scrapes: [], replies: [], avatars: [] };
    // Internal entry points are exposed only in the test response, never the shipped module.
    for (const [path, name] of [['welcome-screen.js', 'openRecentChatsSettingsPopup'], ['extensions/stable-diffusion/index.js', 'refinePrompt']]) {
        await page.route(`**/scripts/${path}*`, async route => {
            const response = await route.fetch();
            return route.fulfill({ response, body: `${await response.text()}\nexport { ${name} as utilityTestOpen };\n` });
        });
    }
    await page.context().route(/\/api\/(?:secrets\/(?:write|delete|rotate|rename)|search\/(?:visit|transcript)|plugins\/fandom\/scrape[^/]*|sd\/[^/]+|quick-replies\/(?:save|delete)|avatars\/(?:upload|delete))$/, route => route.fulfill({ status: 400, body: 'Blocked by utility dialog test' }));
    await page.route('**/api/secrets/read', route => route.fulfill({ json: {} }));
    await page.route('**/api/secrets/write', route => {
        state.secrets.push(payload(route.request()));
        return route.fulfill({ json: { id: 'utility-secret' } });
    });
    await page.route('**/api/avatars/get', route => route.fulfill({ json: [] }));
    await page.route('**/api/avatars/upload', route => {
        state.avatars.push(true);
        return route.fulfill({ status: 400, body: 'Intercepted avatar upload' });
    });
    await page.route('**/api/quick-replies/save', route => {
        state.replies.push(payload(route.request()));
        return route.fulfill({ json: {} });
    });
    await page.route(/\/api\/plugins\/fandom\/(?:probe|probe-mediawiki)$/, route => route.fulfill({ json: {} }));
    await page.route(/\/api\/plugins\/fandom\/scrape(?:-mediawiki)?$/, route => {
        state.scrapes.push({ endpoint: new URL(route.request().url()).pathname, ...payload(route.request()) });
        return route.fulfill({ json: [{ title: ' First ', content: ' One ' }, { title: ' Second ', content: ' Two ' }] });
    });
    await page.route('**/api/search/visit', route => {
        state.scrapes.push(payload(route.request()));
        return route.fulfill({ contentType: 'text/html', body: '<title>Fixture Page</title><p>Fixture content</p>' });
    });
    await page.route('**/api/search/transcript', route => {
        state.scrapes.push(payload(route.request()));
        return route.fulfill({ body: 'Fixture transcript' });
    });
    await page.route('**/api/sd/**', route => route.fulfill({ status: 400, body: 'Image generation disabled in dialog tests' }));
    const misc = await bootMiscDialogs(page, viewport);
    // protectMaintainerServer's default secret stub is registered by bootMiscDialogs; override it last.
    await page.route('**/api/secrets/write', route => {
        state.secrets.push(payload(route.request()));
        return route.fulfill({ json: { id: 'utility-secret' } });
    });
    return { ...state, settings: misc.settings };
}

export async function openUtilityDialog(page, surface) {
    await page.evaluate(async surface => {
        if (surface === 'recent') void (await import('/scripts/welcome-screen.js')).utilityTestOpen();
        if (surface === 'persona') $('#create_dummy_persona').trigger('click');
        if (surface === 'secret') {
            const button = document.createElement('button');
            button.className = 'manage-api-keys';
            button.dataset.key = 'api_key_openai';
            document.body.append(button);
            button.click();
            button.remove();
        }
        if (surface === 'quick-reply') {
            const { QuickReplySet } = await import('/scripts/extensions/quick-reply/src/QuickReplySet.js');
            const source = QuickReplySet.from({ name: 'Utility Source' });
            const target = QuickReplySet.from({ name: 'Utility Target' });
            QuickReplySet.list.push(source, target);
            const reply = source.addQuickReply({ label: 'Utility Reply', message: '/echo fixture', icon: 'fa-star' });
            window.__utilityReplies = { source, target };
            void reply.onTransfer();
        }
        if (surface === 'image') {
            const { extension_settings } = await import('/scripts/extensions.js');
            extension_settings.sd.refine_mode = true;
            window.__utilityImageArgs = { negative: 'Original negative', resolution: '512x768' };
            const module = await import('/scripts/extensions/stable-diffusion/index.js');
            void module.utilityTestOpen(' Original prompt ', window.__utilityImageArgs)
                .then(value => { window.__utilityImageResult = value; })
                .catch(error => { window.__utilityImageError = error.message; });
        }
        if (['web', 'mediawiki', 'fandom', 'youtube'].includes(surface)) {
            const { ScraperManager } = await import('/scripts/scrapers.js');
            void ScraperManager.runDataBankScraper(surface).then(async files => {
                window.__utilityFiles = files ? await Promise.all(files.map(async file => ({ name: file.name, type: file.type, text: await file.text() }))) : null;
            });
        }
        if (surface === 'icons') {
            void (await import('/scripts/utils.js')).showFontAwesomePicker(Array.from({ length: 60 }, (_, index) => [index % 2 ? 'fa-star' : 'fa-heart', `fa-fixture-${index}`]))
                .then(value => { window.__utilityIconResult = value; });
        }
    }, surface);
    if (surface === 'secret') {
        await page.locator('dialog[open] [data-action="add-secret"]').click();
    }
    if (surface === 'regex') {
        await page.locator('#import_regex_file').setInputFiles({ name: 'utility-regex.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ scriptName: 'Utility imported regex', findRegex: 'fixture', replaceString: 'replacement', placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: false, substituteRegex: 0 })) });
    }
    const popup = page.locator('dialog.popup[open]').last();
    await popup.waitFor();
    await page.waitForFunction(() => !document.querySelector('dialog.popup[open][opening]'));
    const required = { recent: '#maxRecentChats', persona: '#persona_title', secret: '#newSecretLabel', regex: '#regex_import_target_global', image: '#sd_refine_negative' }[surface];
    if (required) await popup.locator(required).waitFor();
    return page.locator(`dialog.popup[data-id="${await popup.getAttribute('data-id')}"]`);
}

export async function expectUtilityFrame(popup, viewport, expect) {
    await expect(popup).toHaveClass(/sb-dialog--dialog/);
    const pushed = await popup.evaluate(node => node.classList.contains('sb-dialog--page'));
    await expect(popup).toHaveAttribute('data-presentation', pushed ? 'floating' : viewport.presentation);
    if (await popup.locator('.popup-button-ok').evaluate(node => node.style.display === 'none')) {
        await expect(popup.locator('.sb-dialog__close')).toBeInViewport();
    } else {
        await expect(popup.locator('.popup-button-ok')).toBeInViewport();
        await expect(popup.locator('.popup-button-cancel')).toBeInViewport();
    }
    const content = popup.locator('.popup-content');
    await content.evaluate(node => { node.scrollTop = node.scrollHeight; });
    const last = content.locator('.ds-row, .faPicker > :not(.hidden)').last();
    await expect(last).toBeInViewport();
    expect(await last.evaluate(node => {
        const bounds = node.getBoundingClientRect();
        const body = node.closest('.popup-content').getBoundingClientRect();
        return bounds.top >= body.top - 1 && bounds.bottom <= body.bottom + 1;
    })).toBe(true);
    expect(await popup.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect(await content.locator('.ds-row-switch').evaluateAll(rows => rows.every(row => {
        const label = row.querySelector('.ds-row-text').getBoundingClientRect();
        const control = row.querySelector('input').getBoundingClientRect();
        return control.left >= label.right && row.lastElementChild.matches('input');
    }))).toBe(true);
    expect(await content.locator('.ds-row > .ds-row-suffix').evaluateAll(suffixes => suffixes.every(suffix => {
        if (suffix.parentElement.classList.contains('ds-row--stacked')) return true;
        return suffix.getBoundingClientRect().left >= suffix.previousElementSibling.getBoundingClientRect().right;
    }))).toBe(true);
    expect(await content.locator('.ds-row-entry--floating input').evaluateAll(inputs => inputs.every(input => {
        const style = getComputedStyle(input);
        return style.backgroundColor !== 'rgba(0, 0, 0, 0)' && input.getBoundingClientRect().height >= 32;
    }))).toBe(true);
}
