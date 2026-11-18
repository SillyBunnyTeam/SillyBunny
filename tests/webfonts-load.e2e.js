import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

test.use({ serviceWorkers: 'block' });
test.describe.configure({ timeout: 60_000 });

const STARTUP_TIMEOUT = 30_000;
const FONT_REJECTED = /OTS parsing error|Failed to decode downloaded font/;
const FAMILIES = ['AdwaitaMono', 'AdwaitaSans'];
// Nothing links the preset stylesheets from index.html, so the test injects each one itself.
const PRESETS = [
    { directory: 'Inter', family: 'Inter' },
    { directory: 'JetBrainsMono', family: 'JetBrains Mono' },
    { directory: 'Roboto', family: 'Roboto' },
    { directory: 'PublicSans', family: 'Public Sans' },
    { directory: 'SourceSerif4', family: 'Source Serif 4' },
];

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

for (const { directory, family } of PRESETS) {
    test(`bundled ${family} preset loads upright and italic without a console error`, async ({ page }) => {
        await protectMaintainerServer(page);
        const consoleErrors = [];
        // The app keeps making unrelated requests while it starts, and a loaded server answers
        // some of them with an error. Only an error that names a font file counts here.
        page.on('console', message => {
            const namesFont = message.location().url.includes('/webfonts/') || FONT_REJECTED.test(message.text());
            if (message.type() === 'error' && namesFont) consoleErrors.push(message.text());
        });

        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#chat')).toBeAttached({ timeout: STARTUP_TIMEOUT });

        const faces = await page.evaluate(async ({ href, name }) => {
            await new Promise((resolve, reject) => {
                const link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = href;
                link.onload = resolve;
                link.onerror = () => reject(new Error(`stylesheet ${href} did not load`));
                document.head.append(link);
            });
            const presetFaces = () => [...document.fonts].filter(face => face.family.replace(/^["']|["']$/g, '') === name);
            // A face downloads only when text asks for it, so ask for each style. Chromium resolves
            // document.fonts.load() before it updates the status of the faces it loaded, and
            // FontFace.loaded can stay pending for a face that a style rule created. So ask again
            // for a short time until every face reports loaded, and let the assertion name a face
            // that never does.
            for (let attempt = 0; attempt < 20; attempt++) {
                await document.fonts.load(`16px "${name}"`);
                await document.fonts.load(`italic 16px "${name}"`);
                await document.fonts.load(`bold italic 16px "${name}"`);
                if (presetFaces().length > 1 && presetFaces().every(face => face.status === 'loaded')) break;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return presetFaces().map(face => ({ style: face.style, weight: face.weight, status: face.status }));
        }, { href: `/webfonts/${directory}/stylesheet.css`, name: family });

        expect(faces.map(face => face.style).sort()).toEqual(['italic', 'normal']);
        expect(faces.filter(face => face.status !== 'loaded')).toEqual([]);
        expect(consoleErrors).toEqual([]);
    });
}
