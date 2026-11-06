import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

test.use({ serviceWorkers: 'block' });
test.describe.configure({ timeout: 60_000 });

const STARTUP_TIMEOUT = 30_000;
const FONT_REJECTED = /OTS parsing error|Failed to decode downloaded font/;
const FAMILIES = ['AdwaitaMono', 'AdwaitaSans'];

/** Font URLs of a bundled stylesheet, as paths the server serves (query string kept). */
function readServedFontUrls(family) {
    const css = readFileSync(fileURLToPath(new URL(`../public/webfonts/${family}/stylesheet.css`, import.meta.url)), 'utf8');
    return [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)]
        .map(match => `/webfonts/${family}/${match[2]}`);
}

// OTS only runs when a browser decodes the font, so a wrong container or a rejected glyph table
// shows up here and not in the signature check of tests/unit/webfonts-format.test.js.
test('bundled Adwaita fonts pass browser decoding', async ({ page }) => {
    await protectMaintainerServer(page);
    const rejections = [];
    page.on('console', message => {
        if (FONT_REJECTED.test(message.text())) rejections.push(message.text());
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#chat')).toBeAttached({ timeout: STARTUP_TIMEOUT });

    const urls = FAMILIES.flatMap(readServedFontUrls);
    expect(urls.length).toBeGreaterThan(0);

    const statuses = await page.evaluate(async fontUrls => {
        const results = [];
        for (const [index, url] of fontUrls.entries()) {
            const face = new FontFace(`probe-${index}`, `url(${url})`);
            try {
                await face.load();
                results.push({ url, status: face.status });
            } catch (error) {
                results.push({ url, status: `error: ${error.message}` });
            }
        }
        return results;
    }, urls);

    expect(statuses.filter(result => result.status !== 'loaded')).toEqual([]);
    expect(rejections).toEqual([]);
});
