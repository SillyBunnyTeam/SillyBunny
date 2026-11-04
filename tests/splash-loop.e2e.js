import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

/*
 * The idle loops of the boot splash, in a real browser. No loop is shipped yet, so the test gives the splash a table
 * with one entry by changing its script on the way to the page, and serves a scene of its own with one-pixel pictures
 * for frames. The player is what is under test: when it moves, when it stops, where it puts the pictures, and what it
 * leaves alone. The sizes of the stills come from the table in the shipped script, so a new still needs no change here.
 */

test.use({ serviceWorkers: 'block' });
test.describe.configure({ timeout: 90_000 });

const STARTUP_TIMEOUT = 20_000;
const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const VARIANTS = ['reisen', 'tewi', 'both'];
const NO_BLINK = { steps: [{ variant: 'half', ms: 70 }, { variant: 'closed', ms: 110 }, { variant: 'half', ms: 70 }], gapMs: [4000, 5000], never: {} };

/** The pictures of a variant, at their own size, as the shipped script lists them. */
async function readArt(page) {
    const response = await page.request.get('/scripts/sillybunny-splash.js');
    const source = await response.text();
    const art = {};
    for (const [, variant, width, height] of source.matchAll(/(\w+): \{ file: '[^']+', width: (\d+), height: (\d+) \}/g)) {
        art[variant] = { width: Number(width), height: Number(height) };
    }
    return art;
}

/**
 * Two figures on the still of a variant: the first calls from 0.8 s to 1.8 s of a loop of 2.4 s, and the second strikes
 * from 2 s of a loop of 3 s. A figure of the scene is placed in art pixels, and `boxes` says where.
 */
function sceneOf(art, { blinks = NO_BLINK } = {}) {
    const first = { id: 'reisen', z: 1, left: 6, top: 6, width: Math.floor(art.width * 0.45), height: art.height - 12 };
    const second = { id: 'tewi', z: 2, left: Math.floor(art.width * 0.55), top: 40, width: art.width - Math.floor(art.width * 0.55) - 6, height: art.height - 46 };
    return {
        id: 'fixture',
        grid: { width: art.width, height: art.height },
        layers: [
            { ...first, base: 'idle', frames: { idle: 'splash-fx-r-idle.png', call: 'splash-fx-r-call.png', 'idle-half': 'splash-fx-r-idle-half.png', 'idle-closed': 'splash-fx-r-idle-closed.png' } },
            { ...second, base: 'idle', frames: { idle: 'splash-fx-t-idle.png', strike: 'splash-fx-t-strike.png', 'idle-half': 'splash-fx-t-idle-half.png', 'idle-closed': 'splash-fx-t-idle-closed.png' } },
        ],
        timelines: {
            reisen: { seconds: 2.4, keys: [{ at: 0, frame: 'idle' }, { at: 0.8, frame: 'call' }, { at: 1.8, frame: 'idle' }], effects: [{ kind: 'rings', frames: ['call'], from: 0.8, x: 40, y: 40 }] },
            tewi: { seconds: 3, keys: [{ at: 0, frame: 'idle' }, { at: 2, frame: 'strike' }], effects: [{ kind: 'burst', frames: ['strike'], from: 2, x: 30, y: 40 }] },
        },
        blinks,
        boxes: { reisen: first, tewi: second },
    };
}

/**
 * Opens the splash of `variant` with a loop for it, and holds the boot so the preloader stays up. `requests` collects what the
 * page asks for, and `warnings` what it says. `failing` lists files that answer 404, and `scene` replaces the scene.
 */
async function openSplash(page, { variant = 'both', loops = VARIANTS, failing = [], scene = null, mirror = false } = {}) {
    const art = await readArt(page);
    const requests = [];
    const warnings = [];
    page.on('console', (message) => {
        if (message.type() === 'warning') warnings.push(message.text());
    });
    page.on('request', request => requests.push(new URL(request.url()).pathname.split('/').pop()));
    await protectMaintainerServer(page);
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    await page.route('**/api/settings/get', async (route) => {
        await released;
        await route.fallback();
    });
    await page.route('**/scripts/sillybunny-splash.js*', async (route) => {
        // No loops is the table as it ships.
        if (loops.length === 0) return route.fallback();
        const response = await route.fetch();
        const source = await response.text();
        const table = Object.fromEntries(loops.map(name => [name, `splash-${name}--anim.json`]));
        const changed = source.replace('var LOOP_FILES = {};', `var LOOP_FILES = ${JSON.stringify(table)};`);
        if (changed === source) throw new Error('The table of loops is not where the test expects it.');
        await route.fulfill({ response, body: changed });
    });
    await page.route('**/img/sillybunny/splash-*--anim.json*', (route) => {
        const name = new URL(route.request().url()).pathname.split('/').pop().replace('splash-', '').replace('--anim.json', '');
        if (failing.includes('manifest')) return route.fulfill({ status: 404, body: '' });
        const manifest = { ...(scene ?? sceneOf(art[name])) };
        delete manifest.boxes;
        return route.fulfill({ json: manifest });
    });
    await page.route('**/img/sillybunny/splash-fx-*.png*', (route) => {
        const file = new URL(route.request().url()).pathname.split('/').pop();
        if (failing.includes(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ contentType: 'image/png', body: ONE_PIXEL_PNG });
    });
    await page.addInitScript(({ chosen, mirrored }) => {
        localStorage.setItem('sb-splash-character', chosen);
        if (mirrored) localStorage.setItem('sb-reduced-motion', 'true');
    }, { chosen: variant, mirrored: mirror });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    // Not "visible": a loop that has started hides the still under its first frames.
    const mascot = page.locator('#preloader .sb-boot-mascot');
    await expect(mascot).toBeAttached({ timeout: STARTUP_TIMEOUT });
    await expect.poll(() => mascot.evaluate(image => image.complete && image.naturalWidth > 0), { timeout: STARTUP_TIMEOUT }).toBe(true);
    return { art: art[variant], requests, warnings, release, boxes: sceneOf(art[variant]).boxes };
}

/** The files of the frames that show now, without the folder and the extension. */
function readShown(page) {
    return page.evaluate(() => [...document.querySelectorAll('.sb-boot-loop-layer')]
        .filter(image => getComputedStyle(image).visibility === 'visible' && getComputedStyle(image).display !== 'none')
        .map(image => new URL(image.src).pathname.split('/').pop().replace('splash-fx-', '').replace('.png', ''))
        .sort());
}

/** Lets the page run for a while on its own clock, so that a test can see that nothing changed. */
const sleep = (page, ms) => page.evaluate(duration => new Promise(resolve => setTimeout(resolve, duration)), ms);

const mascotOf = page => page.locator('.sb-boot-mascot');
const waitForLoop = page => expect(page.locator('.sb-boot-loop-layer')).toHaveCount(8, { timeout: STARTUP_TIMEOUT });

const VIEWPORTS = [
    { name: 'desktop 1440x900', options: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone 390x844', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } },
];

for (const { name, options } of VIEWPORTS) {
    test.describe(`Splash loop at ${name}`, () => {
        test.use({ ...options, contextOptions: { reducedMotion: 'no-preference' } });

        let release = () => {};
        test.afterEach(() => release());

        for (const variant of VARIANTS) {
            test(`plays the loop of ${variant}: the still is hidden under the first frames, and a frame changes at its key`, async ({ page }) => {
                const opened = await openSplash(page, { variant });
                release = opened.release;

                await waitForLoop(page);

                await expect(mascotOf(page)).toHaveCSS('visibility', 'hidden');
                // The loop is already running by now, so the first frame is read from the frames that it goes through.
                const seen = new Set();
                await expect.poll(async () => {
                    (await readShown(page)).forEach(frame => seen.add(frame));
                    return [...seen].sort();
                }, { timeout: 6000, intervals: [50] }).toEqual(expect.arrayContaining(['r-call', 'r-idle', 't-idle']));
                expect(await readShown(page)).toHaveLength(2);
            });
        }

        test('asks for the script of the loop only after the still, and for its frames only after the script', async ({ page }) => {
            const opened = await openSplash(page, { variant: 'both' });
            release = opened.release;
            await waitForLoop(page);

            const order = file => opened.requests.indexOf(file);
            expect(order('splash-both@native.webp')).toBeGreaterThanOrEqual(0);
            expect(order('sillybunny-splash-loop.js')).toBeGreaterThan(order('splash-both@native.webp'));
            expect(order('splash-both--anim.json')).toBeGreaterThan(order('sillybunny-splash-loop.js'));
            expect(order('splash-fx-r-idle.png')).toBeGreaterThan(order('splash-both--anim.json'));
        });

        test('does not move anything: the picture and the line are where they are without the loop', async ({ page }) => {
            const still = await page.context().newPage();
            const without = await openSplash(still, { variant: 'both', loops: [] });
            await sleep(still, 1500);
            // The line is one of four, so its width differs between loads, and its place down the page and its height do not.
            const before = {
                picture: await mascotOf(still).boundingBox(),
                line: await still.locator('.sb-boot-line').boundingBox(),
                sparkle: await still.locator('.sb-boot-star >> nth=0').boundingBox(),
            };
            without.release();
            await still.close();

            const opened = await openSplash(page, { variant: 'both' });
            release = opened.release;
            await waitForLoop(page);
            await expect(mascotOf(page)).toHaveCSS('visibility', 'hidden');

            expect(await mascotOf(page).boundingBox()).toEqual(before.picture);
            const line = await page.locator('.sb-boot-line').boundingBox();
            expect([line.y, line.height]).toEqual([before.line.y, before.line.height]);
            const sparkle = await page.locator('.sb-boot-star >> nth=0').boundingBox();
            expect([sparkle.y, sparkle.width, sparkle.height]).toEqual([before.sparkle.y, before.sparkle.width, before.sparkle.height]);
        });

        test('keeps the motion inside the box of the picture', async ({ page }) => {
            const opened = await openSplash(page, { variant: 'both' });
            release = opened.release;
            await waitForLoop(page);

            const box = await page.evaluate(() => {
                const mascot = document.querySelector('.sb-boot-mascot').getBoundingClientRect();
                const holder = document.querySelector('.sb-boot-loop');
                return { mascot: [mascot.left, mascot.top, mascot.width, mascot.height], holder: [holder.getBoundingClientRect().left, holder.getBoundingClientRect().top, holder.getBoundingClientRect().width, holder.getBoundingClientRect().height], overflow: getComputedStyle(holder).overflow };
            });

            expect(box.holder).toEqual(box.mascot);
            expect(box.overflow).toBe('hidden');
        });

        test('draws the effects on a canvas as big as the picture, so none is cut off by the box of its figure', async ({ page }) => {
            const opened = await openSplash(page, { variant: 'both' });
            release = opened.release;
            await waitForLoop(page);

            const boxes = await page.evaluate(() => ({
                holder: JSON.stringify(document.querySelector('.sb-boot-loop').getBoundingClientRect()),
                effects: [...document.querySelectorAll('.sb-boot-effect')].map(svg => JSON.stringify(svg.getBoundingClientRect())),
            }));

            expect(boxes.effects.length).toBeGreaterThan(0);
            expect(boxes.effects.every(box => box === boxes.holder)).toBe(true);
        });

        test('stays a still and asks for nothing under the Reduced Motion of the system', async ({ page }) => {
            await page.emulateMedia({ reducedMotion: 'reduce' });
            const opened = await openSplash(page, { variant: 'both' });
            release = opened.release;

            await sleep(page, 2500);

            expect(opened.requests.filter(file => file.includes('splash-loop') || file.includes('--anim') || file.includes('splash-fx'))).toEqual([]);
            await expect(mascotOf(page)).not.toHaveCSS('visibility', 'hidden');
            await expect(page.locator('.sb-boot-loop-layer')).toHaveCount(0);
        });

        test('stays a still and asks for nothing when the saved Reduced Motion setting is mirrored', async ({ page }) => {
            const opened = await openSplash(page, { variant: 'both', mirror: true });
            release = opened.release;

            await sleep(page, 2500);

            expect(opened.requests.filter(file => file.includes('splash-loop') || file.includes('--anim') || file.includes('splash-fx'))).toEqual([]);
            await expect(page.locator('.sb-boot-loop-layer')).toHaveCount(0);
        });

        test('goes back to the still and stops when the app turns Reduced Motion on while it plays', async ({ page }) => {
            const opened = await openSplash(page, { variant: 'both' });
            release = opened.release;
            await waitForLoop(page);
            await expect(mascotOf(page)).toHaveCSS('visibility', 'hidden');

            await page.evaluate(() => document.body.classList.add('reduced-motion'));

            await expect(mascotOf(page)).not.toHaveCSS('visibility', 'hidden');
            await expect(page.locator('.sb-boot-loop-layer').first()).toHaveCSS('display', 'none');
            const effects = await page.locator('.sb-boot-effect path').evaluateAll(paths => paths.map(path => path.getAttribute('d')));
            await sleep(page, 2800);
            expect(await page.locator('.sb-boot-effect path').evaluateAll(paths => paths.map(path => path.getAttribute('d')))).toEqual(effects);
            await expect(mascotOf(page)).not.toHaveCSS('visibility', 'hidden');
        });

        test('keeps the still, and says so once, when the loop is not found', async ({ page }) => {
            const opened = await openSplash(page, { variant: 'both', failing: ['manifest'] });
            release = opened.release;

            await expect.poll(() => opened.warnings.filter(text => text.includes('keeps its still')).length).toBe(1);

            await expect(mascotOf(page)).not.toHaveCSS('visibility', 'hidden');
            await expect(page.locator('.sb-boot-loop-layer')).toHaveCount(0);
            await expect(page.locator('.sb-boot-loop')).toHaveCount(0);
        });

        test('keeps the still when one of the frames cannot be loaded', async ({ page }) => {
            const opened = await openSplash(page, { variant: 'both', failing: ['splash-fx-t-strike.png'] });
            release = opened.release;

            await expect.poll(() => opened.warnings.filter(text => text.includes('keeps its still')).length).toBe(1);

            await expect(mascotOf(page)).not.toHaveCSS('visibility', 'hidden');
            await expect(page.locator('.sb-boot-loop-layer')).toHaveCount(0);
        });

        test('keeps the still when the loop is for a picture of another size', async ({ page }) => {
            const art = { width: 10, height: 10 };
            const opened = await openSplash(page, { variant: 'both', scene: { ...sceneOf(art), grid: art } });
            release = opened.release;

            await expect.poll(() => opened.warnings.filter(text => text.includes('keeps its still')).length).toBe(1);

            await expect(page.locator('.sb-boot-loop-layer')).toHaveCount(0);
        });

        test('loads nothing for a variant that has no loop', async ({ page }) => {
            const opened = await openSplash(page, { variant: 'tewi', loops: ['both'] });
            release = opened.release;

            await sleep(page, 2000);

            expect(opened.requests).not.toContain('sillybunny-splash-loop.js');
            await expect(page.locator('.sb-boot-loop')).toHaveCount(0);
        });

        test('leaves nothing behind when the preloader is removed, and the page has no error', async ({ page }) => {
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            const opened = await openSplash(page, { variant: 'both' });
            release = opened.release;
            await waitForLoop(page);

            opened.release();
            await expect(page.locator('#preloader')).toHaveCount(0, { timeout: STARTUP_TIMEOUT });
            const requestsAtRemoval = opened.requests.length;
            await sleep(page, 1500);

            await expect(page.locator('.sb-boot-loop-layer, .sb-boot-effect')).toHaveCount(0);
            expect(opened.requests.filter(file => file.startsWith('splash-fx')).length).toBeLessThanOrEqual(requestsAtRemoval);
            expect(errors).toEqual([]);
        });
    });
}

/** The pictures of the loop that are not where their art pixels put them at the step of the splash, in device pixels. */
async function layersOffTheirPlace(page, boxes) {
    return page.evaluate((expected) => {
        const mascot = document.querySelector('.sb-boot-mascot');
        const step = Number(mascot.dataset.step);
        const dpr = devicePixelRatio;
        const origin = mascot.getBoundingClientRect();
        const off = [];
        for (const image of document.querySelectorAll('.sb-boot-loop-layer')) {
            const file = new URL(image.src).pathname.split('/').pop();
            const box = expected[file.includes('-r-') ? 'reisen' : 'tewi'];
            const rect = image.getBoundingClientRect();
            const device = [(rect.left - origin.left) * dpr, (rect.top - origin.top) * dpr, rect.width * dpr, rect.height * dpr];
            const wanted = [box.left, box.top, box.width, box.height].map(value => value * step);
            if (device.some((value, index) => Math.abs(value - wanted[index]) > 0.05)) off.push(file);
        }
        return { step, off, count: document.querySelectorAll('.sb-boot-loop-layer').length };
    }, boxes);
}

for (const { width, height, ratio } of [{ width: 1440, height: 900, ratio: 1 }, { width: 1440, height: 1800, ratio: 1 }, { width: 390, height: 844, ratio: 2 }, { width: 390, height: 844, ratio: 3 }, { width: 800, height: 1000, ratio: 1.5 }]) {
    test.describe(`Splash loop pixels at ${width}x${height} on a ${ratio}x screen`, () => {
        test.use({ viewport: { width, height }, deviceScaleFactor: ratio, contextOptions: { reducedMotion: 'no-preference' } });

        test('puts every picture at its place in whole device pixels, at the step of the splash', async ({ page }) => {
            const opened = await openSplash(page, { variant: 'both' });
            await waitForLoop(page);

            const read = await layersOffTheirPlace(page, opened.boxes);

            expect(read.step).toBeGreaterThanOrEqual(1);
            expect(read.count).toBe(8);
            expect(read.off).toEqual([]);
            opened.release();
        });
    });
}

test.describe('Splash loop on a screen that is too short for a whole step', () => {
    test.use({ viewport: { width: 1024, height: 340 }, contextOptions: { reducedMotion: 'no-preference' } });

    test('keeps the still, because a fraction of a step is not whole device pixels', async ({ page }) => {
        const opened = await openSplash(page, { variant: 'both' });

        await expect(mascotOf(page)).toHaveAttribute('data-fit', 'smooth');
        await sleep(page, 2000);

        expect(opened.requests.filter(file => file.includes('--anim') || file.includes('splash-fx'))).toEqual([]);
        await expect(mascotOf(page)).not.toHaveCSS('visibility', 'hidden');
        opened.release();
    });
});

test.describe('Splash loop while the window changes size', () => {
    test.use({ viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'no-preference' } });

    test('follows the step of the splash, and keeps the still while the fit is smooth', async ({ page }) => {
        const opened = await openSplash(page, { variant: 'both' });
        await waitForLoop(page);
        const first = await layersOffTheirPlace(page, opened.boxes);
        expect(first.off).toEqual([]);

        await page.setViewportSize({ width: 1440, height: 1800 });
        await expect.poll(async () => (await layersOffTheirPlace(page, opened.boxes)).step).not.toBe(first.step);
        expect((await layersOffTheirPlace(page, opened.boxes)).off).toEqual([]);

        await page.setViewportSize({ width: 1024, height: 340 });
        await expect(mascotOf(page)).toHaveAttribute('data-fit', 'smooth');
        await expect(mascotOf(page)).not.toHaveCSS('visibility', 'hidden');

        await page.setViewportSize({ width: 1440, height: 900 });
        await expect(mascotOf(page)).toHaveCSS('visibility', 'hidden');
        expect((await layersOffTheirPlace(page, opened.boxes)).off).toEqual([]);
        opened.release();
    });
});
