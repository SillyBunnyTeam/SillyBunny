import { chromium, expect, test, webkit } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

/*
 * The loops of the splash as they ship: the manifests and frames of `/img/sillybunny/`, with nothing replaced. A loop
 * starts on the picture that the still is, plays whole device pixels at every screen scale, keeps its effects inside the
 * picture, and leaves the still alone under Reduced Motion. The browser runs at the scale itself, as in
 * `art-pixel-evenness.e2e.js`, because Playwright's `deviceScaleFactor` is not a real screen.
 */

test.use({ serviceWorkers: 'block' });
test.describe.configure({ timeout: 120_000 });

const STARTUP_TIMEOUT = 30_000;
const VARIANTS = ['reisen', 'tewi', 'both'];

/** In the WebKit project the browser is WebKit, which takes the scale and the size from its context. */
async function launch(testInfo, { scale, width, height, motion }) {
    const isWebKit = testInfo.project.use.browserName === 'webkit';
    const browser = isWebKit
        ? await webkit.launch()
        : await chromium.launch({ args: [`--force-device-scale-factor=${scale}`, `--window-size=${width},${height}`] });
    const context = await browser.newContext({
        ...(isWebKit ? { viewport: { width, height }, deviceScaleFactor: scale } : { viewport: null }),
        baseURL: testInfo.project.use.baseURL,
        serviceWorkers: 'block',
        reducedMotion: motion ? 'no-preference' : 'reduce',
    });
    const page = await context.newPage();
    return { browser, page };
}

/** Opens the splash of `variant` and keeps it up, with the clock of the page under the control of the test. */
async function openSplash(page, variant, { stopped = false, sameLine = false } = {}) {
    await protectMaintainerServer(page);
    // The splash picks its line at random, and the width of the line moves the picture by up to a device pixel, so two pages
    // that share one screenshot clip need the same line.
    if (sameLine) await page.addInitScript(() => { Math.random = () => 0; });
    let release = () => {};
    const released = new Promise((resolve) => { release = resolve; });
    await page.route('**/api/settings/get', async (route) => {
        await released;
        await route.fallback();
    });
    await page.clock.install({ time: new Date(2026, 9, 30, 12, 0) });
    // A clock that has stopped before the page starts moves only when the test moves it.
    if (stopped) await page.clock.pauseAt(new Date(2026, 9, 30, 12, 0, 1));
    await page.addInitScript((chosen) => localStorage.setItem('sb-splash-character', chosen), variant);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    return release;
}

/** What the page says about a loop of `variant`: its manifest, and the file of the picture that shows first. */
async function readLoop(page, variant) {
    return page.evaluate(async (name) => {
        const splash = window.SillyBunnySplash;
        const response = await fetch(`/img/sillybunny/${splash.LOOP_FILES[name]}?v=${splash.ART_VERSION}`);
        const manifest = await response.json();
        const [layer] = manifest.layers;
        const timeline = manifest.timelines[layer.id];
        return {
            manifest,
            layer,
            first: layer.frames[timeline.keys[0].frame],
            still: splash.ART[name],
            version: splash.ART_VERSION,
        };
    }, variant);
}

test.describe('the first frame of each loop', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    for (const variant of VARIANTS) {
        test(`${variant} starts on its still, pixel for pixel, and has the size of its still`, async ({ page }) => {
            await openSplash(page, variant);
            await expect.poll(() => page.evaluate(() => Boolean(window.SillyBunnySplash)), { timeout: STARTUP_TIMEOUT }).toBe(true);
            const loop = await readLoop(page, variant);

            expect(loop.manifest.grid, 'the scene is as big as its still').toMatchObject({ width: loop.still.width, height: loop.still.height });
            expect(loop.layer, 'one picture covers the scene').toMatchObject({ left: 0, top: 0, width: loop.still.width, height: loop.still.height });

            const same = await page.evaluate(async ({ stillFile, firstFile, version }) => {
                const read = async (file) => {
                    const image = new Image();
                    image.src = `/img/sillybunny/${file}?v=${version}`;
                    await image.decode();
                    const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
                    const context = canvas.getContext('2d', { willReadFrequently: true });
                    context.drawImage(image, 0, 0);
                    return { size: [image.naturalWidth, image.naturalHeight], data: context.getImageData(0, 0, image.naturalWidth, image.naturalHeight).data };
                };
                const [still, first] = await Promise.all([read(stillFile), read(firstFile)]);
                let differing = 0;
                for (let index = 0; index < still.data.length; index++) {
                    if (still.data[index] !== first.data[index]) differing++;
                }
                return { sizes: [still.size, first.size], differing };
            }, { stillFile: loop.still.file, firstFile: loop.first, version: loop.version });

            expect(same.sizes[0]).toEqual(same.sizes[1]);
            expect(same.differing, 'bytes of the decoded pictures that differ').toBe(0);
        });
    }
});

/**
 * The picture that shows, drawn onto a canvas at the step by nearest neighbour, against the screenshot: every opaque art
 * pixel has to be one even block of the step. The effects are taken out of the page, which is a check of their own.
 */
async function measureFrame(page, { shot, ratio, step }) {
    return page.evaluate(async ({ encoded, scale, wanted }) => {
        const holder = document.querySelector('.sb-boot-loop');
        const box = holder.getBoundingClientRect();
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${encoded}`)).blob());
        const screenCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const screenContext = screenCanvas.getContext('2d', { willReadFrequently: true });
        screenContext.drawImage(bitmap, 0, 0);
        const screen = screenContext.getImageData(0, 0, bitmap.width, bitmap.height);

        const shown = [...holder.querySelectorAll('.sb-boot-loop-layer')].filter(image => image.style.visibility === 'visible');
        const first = shown[0];
        const canvas = new OffscreenCanvas(first.naturalWidth * wanted, first.naturalHeight * wanted);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.imageSmoothingEnabled = false;
        for (const layer of shown) {
            const picture = new Image();
            picture.src = layer.currentSrc;
            await picture.decode();
            context.drawImage(picture, 0, 0, picture.naturalWidth * wanted, picture.naturalHeight * wanted);
        }
        const art = context.getImageData(0, 0, canvas.width, canvas.height);
        const left = Math.round(box.left * scale);
        const top = Math.round(box.top * scale);
        let best = null;
        for (let shiftY = -1; shiftY <= 1; shiftY++) {
            for (let shiftX = -1; shiftX <= 1; shiftX++) {
                let total = 0;
                let bad = 0;
                for (let y = 0; y < canvas.height; y++) {
                    for (let x = 0; x < canvas.width; x++) {
                        const at = (y * canvas.width + x) * 4;
                        if (art.data[at + 3] !== 255) continue;
                        total++;
                        const from = ((top + shiftY + y) * screen.width + left + shiftX + x) * 4;
                        if (Math.abs(screen.data[from] - art.data[at]) > 2
                            || Math.abs(screen.data[from + 1] - art.data[at + 1]) > 2
                            || Math.abs(screen.data[from + 2] - art.data[at + 2]) > 2) bad++;
                    }
                }
                if (best === null || bad < best.bad) best = { total, bad, offset: [shiftX, shiftY], shown: shown.length };
            }
        }
        return { ...best, boxWidth: box.width, boxHeight: box.height, artWidth: first.naturalWidth, artHeight: first.naturalHeight };
    }, { encoded: shot.toString('base64'), scale: ratio, wanted: step });
}

/** The box of the picture of the splash, in CSS pixels, which is where the still is and where a loop plays. */
const pictureBox = page => page.evaluate(() => {
    const picture = document.querySelector('.sb-boot-loop') ?? document.querySelector('.sb-boot-mascot');
    const { left, top, width, height } = picture.getBoundingClientRect();
    return { x: left, y: top, width, height };
});

test.describe('the first frame on the screen', () => {
    for (const scale of [1, 1.5, 2, 3]) {
        for (const variant of VARIANTS) {
            test(`${variant} looks like its still at scale ${scale}`, async ({}, testInfo) => {
                // The still, under Reduced Motion, which asks for no loop.
                const still = await launch(testInfo, { scale, width: 1440, height: 900, motion: false });
                let stillShot;
                try {
                    const release = await openSplash(still.page, variant, { sameLine: true });
                    await expect(still.page.locator('.sb-boot-mascot')).toBeVisible({ timeout: STARTUP_TIMEOUT });
                    await expect.poll(() => still.page.locator('.sb-boot-mascot').evaluate(image => image.complete && image.naturalWidth)).toBeGreaterThan(0);
                    stillShot = await still.page.screenshot({ clip: await pictureBox(still.page) });
                    release();
                } finally {
                    await still.browser.close();
                }

                // The loop, with the clock stopped at the start and moved on until the first frame is on the screen.
                const loop = await launch(testInfo, { scale, width: 1440, height: 900, motion: true });
                try {
                    const release = await openSplash(loop.page, variant, { stopped: true, sameLine: true });
                    await loop.page.addStyleTag({ content: '.sb-boot-effect { display: none !important; }' });
                    const shown = () => loop.page.locator('.sb-boot-loop-layer').evaluateAll(images => images.filter(image => image.style.visibility === 'visible').length);
                    await expect.poll(async () => {
                        await loop.page.clock.runFor(16);
                        return shown();
                    }, { timeout: STARTUP_TIMEOUT }).toBeGreaterThan(0);
                    const first = (await readLoop(loop.page, variant)).first;
                    await expect(loop.page.locator('.sb-boot-loop-layer[style*="visible"]')).toHaveAttribute('src', new RegExp(`${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?`));

                    const loopShot = await loop.page.screenshot({ clip: await pictureBox(loop.page) });

                    expect(loopShot.equals(stillShot), 'the first frame of the loop is the still on the screen, pixel for pixel').toBe(true);
                    release();
                } finally {
                    await loop.browser.close();
                }
            });
        }
    }
});

test.describe('the loops on whole device pixels', () => {
    for (const scale of [1, 1.1, 1.5, 1.75, 2, 3]) {
        for (const [width, height] of [[1440, 900], [390, 844]]) {
            for (const variant of VARIANTS) {
                if (width === 390 && variant !== 'both') continue;
                test(`${variant} is even blocks at ${width}x${height} on a screen of scale ${scale}`, async ({}, testInfo) => {
                    const { browser, page } = await launch(testInfo, { scale, width, height, motion: true });
                    try {
                        const release = await openSplash(page, variant);
                        await expect(page.locator('.sb-boot-loop-layer').first()).toBeAttached({ timeout: STARTUP_TIMEOUT });
                        await expect.poll(() => page.locator('.sb-boot-loop-layer').evaluateAll(images => images.filter(image => image.style.visibility === 'visible').length), { timeout: STARTUP_TIMEOUT }).toBeGreaterThan(0);
                        await page.addStyleTag({ content: '.sb-boot-effect { display: none !important; }' });
                        // Some of the loop has to have played, so a frame after the first is on the screen too.
                        await page.clock.runFor(1300);
                        await page.clock.pauseAt(await page.evaluate(() => Date.now() + 20));

                        const mascot = page.locator('.sb-boot-mascot');
                        const unit = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector('.sb-boot-splash')).getPropertyValue('--sb-boot-px')));
                        const dpr = await page.evaluate(() => devicePixelRatio);
                        const step = Math.round(unit * dpr);
                        expect(Math.abs(unit * dpr - step), 'a whole step of device pixels per art pixel').toBeLessThan(0.01);
                        await expect(mascot).toHaveCSS('visibility', 'hidden');

                        const result = await measureFrame(page, { shot: await page.screenshot(), ratio: dpr, step });

                        expect(result.shown, 'a picture shows').toBeGreaterThan(0);
                        expect(result.total, 'there are opaque art pixels to check').toBeGreaterThan(1000);
                        expect(result.bad, `device pixels that are not one even block of the picture (best offset ${result.offset}, of ${result.total})`).toBe(0);
                        release();
                    } finally {
                        await browser.close();
                    }
                });
            }
        }
    }
});

test.describe('the effects of the loops', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    for (const variant of VARIANTS) {
        test(`${variant} draws its effects inside the picture, at every moment of its loop`, async ({ page }) => {
            const release = await openSplash(page, variant);
            await expect(page.locator('.sb-boot-loop-layer').first()).toBeAttached({ timeout: STARTUP_TIMEOUT });
            const { manifest } = await readLoop(page, variant);
            const [layer] = manifest.layers;
            const seconds = Math.max(...Object.values(manifest.timelines).map(timeline => timeline.seconds));
            const wanted = manifest.timelines[layer.id].effects.length;
            expect(wanted, 'the loop has an effect').toBeGreaterThan(0);

            let drawn = 0;
            const outside = [];
            for (let at = 0; at < seconds * 1000 * 2 + 400; at += 50) {
                await page.clock.runFor(50);
                const seen = await page.evaluate(grid => {
                    const boxes = [...document.querySelectorAll('.sb-boot-effect path')]
                        .map(path => path.getBBox())
                        .filter(box => box.width > 0)
                        .map(box => [box.x, box.y, box.x + box.width, box.y + box.height]);
                    return { drawn: boxes.length, outside: boxes.filter(([x0, y0, x1, y1]) => x0 < 0 || y0 < 0 || x1 > grid.width || y1 > grid.height) };
                }, manifest.grid);
                drawn += seen.drawn;
                outside.push(...seen.outside);
            }

            expect(drawn, 'an effect is drawn at some moment of the loop').toBeGreaterThan(0);
            expect(outside, `boxes of the effect that leave the ${manifest.grid.width}x${manifest.grid.height} picture`).toEqual([]);
            release();
        });
    }
});

test.describe('under Reduced Motion', () => {
    test.use({ viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });

    for (const variant of VARIANTS) {
        test(`${variant} stays its still and asks for no loop`, async ({ page }) => {
            const requests = [];
            page.on('request', request => requests.push(new URL(request.url()).pathname.split('/').pop()));
            const release = await openSplash(page, variant);
            const mascot = page.locator('#preloader .sb-boot-mascot');
            await expect(mascot).toBeVisible({ timeout: STARTUP_TIMEOUT });
            await page.clock.runFor(4000);

            await expect(mascot).toHaveCSS('visibility', 'visible');
            await expect(page.locator('.sb-boot-loop-layer')).toHaveCount(0);
            expect(requests.filter(file => file.includes('--anim.json') || file.includes('sillybunny-splash-loop'))).toEqual([]);
            release();
        });
    }
});

test.describe('in forced colours', () => {
    test.use({ viewport: { width: 1440, height: 900 }, forcedColors: 'active' });

    for (const variant of VARIANTS) {
        test(`${variant} still shows its picture, and the loop does not hide it`, async ({ page }) => {
            const release = await openSplash(page, variant);
            await expect.poll(() => page.locator('.sb-boot-loop-layer').evaluateAll(images => images.filter(image => image.style.visibility === 'visible').length), { timeout: STARTUP_TIMEOUT }).toBeGreaterThan(0);

            const shown = await page.evaluate(() => [...document.querySelectorAll('.sb-boot-loop-layer')]
                .filter(image => image.style.visibility === 'visible')
                .map((image) => {
                    const style = getComputedStyle(image);
                    return { opacity: style.opacity, display: style.display, visibility: style.visibility, filter: style.filter, width: image.getBoundingClientRect().width };
                }));
            expect(shown).toHaveLength(1);
            expect(shown[0]).toMatchObject({ opacity: '1', display: 'block', visibility: 'visible' });
            expect(shown[0].width).toBeGreaterThan(0);
            release();
        });
    }
});
