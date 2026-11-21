import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

test.beforeEach(async ({ page }) => { await protectMaintainerServer(page); });

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

// CFG Scale reaches only a text completion server with a guidance scale (ooba, tabby); Token Probabilities needs a backend
// that requests logprobs. The counts are the visible rows of the Options menu, with a character chat open.
const BACKENDS = [
    { name: 'Text Completion: ooba', api: 'textgenerationwebui', source: 'ooba', cfg: true, probabilities: true },
    { name: 'Text Completion: tabby', api: 'textgenerationwebui', source: 'tabby', cfg: true, probabilities: true },
    { name: 'Text Completion: llama.cpp', api: 'textgenerationwebui', source: 'llamacpp', cfg: false, probabilities: true },
    { name: 'NovelAI', api: 'novel', source: null, cfg: false, probabilities: true },
    { name: 'Chat Completion: OpenRouter', api: 'openai', source: 'openrouter', cfg: false, probabilities: true },
    { name: 'Chat Completion: Claude', api: 'openai', source: 'claude', cfg: false, probabilities: false },
    { name: 'KoboldAI Horde', api: 'koboldhorde', source: null, cfg: false, probabilities: false },
];

async function selectBackend(page, { api, source }) {
    await page.evaluate(({ api, source }) => {
        window.$('#main_api').val(api).trigger('change');
        if (source) window.$(api === 'openai' ? '#chat_completion_source' : '#textgen_type').val(source).trigger('change');
    }, { api, source });
}

async function openOptions(page) {
    await page.locator('#options_button').click();
    await expect(page.locator('#options')).toBeVisible();
}

async function closeOptions(page) {
    await page.keyboard.press('Escape');
    await page.evaluate(() => { if (document.getElementById('options')?.style.display !== 'none') document.getElementById('options_button').click(); });
    await expect(page.locator('#options')).toBeHidden();
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`the Options menu leaves out CFG Scale and Token Probabilities where they do not apply at ${viewport.width}x${viewport.height}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await openQuietChatForSmoke(page);
        const counts = {};
        for (const backend of BACKENDS) {
            await selectBackend(page, backend);
            await openOptions(page);
            const cfg = page.locator('#option_toggle_CFG');
            const probabilities = page.locator('#option_toggle_logprobs');
            await expect(cfg, `${backend.name}: CFG Scale`).toBeVisible({ visible: backend.cfg });
            await expect(probabilities, `${backend.name}: Token Probabilities`).toBeVisible({ visible: backend.probabilities });
            counts[backend.name] = await page.locator('#options a').evaluateAll(rows => rows.filter(row => row.getClientRects().length).length);
            await closeOptions(page);
        }
        // The rest of the menu is the same for every backend.
        const base = counts['Chat Completion: Claude'];
        for (const backend of BACKENDS) {
            expect(counts[backend.name], backend.name).toBe(base + (backend.cfg ? 1 : 0) + (backend.probabilities ? 1 : 0));
        }
        console.log(`Options rows at ${viewport.width}: ${JSON.stringify(counts)}`);
    });
}
