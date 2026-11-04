import { expect, test } from '@playwright/test';
import { getPixelArt } from '../public/scripts/sillybunny-home/art-sources.js';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { installFixtureChats } from './helpers/fixture-chats.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

/*
 * The player of the idle motion of the art, in a real browser. No real frames are shipped yet, so the scene here is a
 * fixture: two figures on a backdrop, whose pictures are one-pixel files that the test serves itself. The player is
 * what is under test: when it moves, when it stops, where it puts the pictures, and what it leaves alone. The page is
 * a bare one that the test serves from the app's own origin, so the modules are the shipped ones and the app does not
 * have to boot. The clock is Playwright's, so a breath and a blink are read at exact times.
 */

test.use({ serviceWorkers: 'block' });
test.describe.configure({ timeout: 60_000 });

/** `steps` are the device pixels per art pixel to check, the first being the fixed step of the screen. */
const VIEWPORTS = [
    { name: 'desktop 1440x900', options: { viewport: { width: 1440, height: 900 } }, steps: [1, 2] },
    { name: 'phone 390x844', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, steps: [3, 1] },
];

const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/css/sillybunny-home.css"><body style="margin:0;height:3000px">
<div id="host" style="position:fixed;left:20px;top:20px"></div>
<p id="neighbour" style="position:fixed;left:20px;top:420px;margin:0">neighbour</p>`;

/** The size of the art that each fixture scene moves comes from the table, so a new picture needs no change here. */
const HERO = getPixelArt('hero-duo');
const ABOUT = getPixelArt('about-reisen');

/** The first figure has no blink pictures, and the second has them, as the breath scenes will. */
const MANIFEST = {
    scene: 'fixture',
    grid: { width: HERO.width, height: HERO.height },
    rhythm: { cycleSeconds: 3.5, breathsPerCycle: 2 },
    poses: ['c', 'b'],
    backdrop: 'fixture-backdrop.png',
    layers: [
        { id: 'tall', z: 1, left: 10, top: 8, width: 120, height: 340, waist: 150, images: { c: { base: 'fixture-tall-c.png' }, b: { base: 'fixture-tall-b.png' } } },
        {
            id: 'small',
            z: 2,
            left: 170,
            top: 100,
            width: 140,
            height: 250,
            waist: 120,
            images: {
                c: { base: 'fixture-small-c.png', half: 'fixture-small-c-half.png', closed: 'fixture-small-c-closed.png' },
                b: { base: 'fixture-small-b.png', half: 'fixture-small-b-half.png', closed: 'fixture-small-b-closed.png' },
            },
        },
    ],
};

/** Opens the bare page with the clock installed, serving the fixture pictures. `requests` collects what the player asks for. */
async function openFixturePage(page, { failing = [] } = {}) {
    await protectMaintainerServer(page);
    const requests = [];
    await page.route('**/__art-motion-fixture', route => route.fulfill({ contentType: 'text/html', body: PAGE }));
    await page.route('**/img/sillybunny/fixture-*.png*', (route) => {
        const file = new URL(route.request().url()).pathname.split('/').pop();
        requests.push(file);
        if (failing.includes(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ contentType: 'image/png', body: ONE_PIXEL_PNG });
    });
    await page.clock.install({ time: 0 });
    await page.goto('/__art-motion-fixture');
    // The clock stands still until a test runs it, so a breath and a blink are read at the times the test names and not
    // at those plus however long the page took to start.
    await page.clock.pauseAt(1000);
    return requests;
}

/**
 * Puts a moving figure in the page, sized at `step` device pixels per art pixel at the screen's own ratio, and
 * returns once it has been asked to start. It does not wait for it to play.
 */
async function mountFigure(page, { step } = {}) {
    await page.evaluate(async ({ manifest, wantedStep }) => {
        const { parseBreathScene } = await import('/scripts/sillybunny-home/art-motion.js');
        const { startArtMotion } = await import('/scripts/sillybunny-home/art-player.js');
        const { createPixelFigure, sizePixelFigure, pixelStep } = await import('/scripts/sillybunny-home/pixel-art.js');
        const figure = createPixelFigure('hero-duo');
        figure.id = 'figure';
        document.querySelector('#host').append(figure);
        sizePixelFigure(figure, { step: wantedStep ?? pixelStep(), ratio: devicePixelRatio });
        const scene = parseBreathScene(manifest);
        window.motion = startArtMotion(figure, {
            loadScene: async () => scene,
            urlOf: file => `/img/sillybunny/${file}?v=fixture`,
            // The first blinks are due 1.0 s plus a draw of up to 1.0 s in, and the test needs to know when.
            random: () => 0,
        });
    }, { manifest: MANIFEST, wantedStep: step ?? null });
}

/** Lets the page run for a while, on its own clock, so that a test can see that nothing changed. */
const sleep = (page, ms) => page.evaluate(duration => new Promise(resolve => setTimeout(resolve, duration)), ms);

const state = page => page.locator('#figure').getAttribute('data-sb-art-motion');
const waitFor = (page, expected) => expect.poll(() => state(page), { timeout: 10_000 }).toBe(expected);

/** The pictures that show now, by figure, as `layer:pose:picture`. */
function readShown(page) {
    return page.evaluate(() => [...document.querySelectorAll('#figure [data-sb-art-layer]')]
        .filter(image => image.style.visibility === 'visible')
        .map(image => (image.dataset.sbArtLayer === 'backdrop' ? 'backdrop' : `${image.dataset.sbArtLayer}:${image.dataset.sbArtPose}:${image.dataset.sbArtPicture}`)));
}

/** The boxes of the figure and of what is around it, which the motion must not change. */
function readSurroundings(page) {
    return page.evaluate(() => {
        const box = selector => JSON.stringify(document.querySelector(selector).getBoundingClientRect());
        return {
            figure: box('#figure'),
            host: box('#host'),
            neighbour: box('#neighbour'),
            scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
        };
    });
}

/**
 * The layers that are not where their art pixels put them at `step`, measured in device pixels from the figure. An empty
 * list is what is wanted, and the figure must have layers for that to mean anything.
 */
async function layersOffTheirPlace(page, step) {
    return page.evaluate((wantedStep) => {
        const figure = document.querySelector('#figure').getBoundingClientRect();
        const dpr = devicePixelRatio;
        const layers = [...document.querySelectorAll('#figure [data-sb-art-layer]')];
        const off = layers.filter((image) => {
            const box = image.getBoundingClientRect();
            const art = image.dataset.sbArtBox.split(' ').map(Number);
            const device = [(box.left - figure.left) * dpr, (box.top - figure.top) * dpr, box.width * dpr, box.height * dpr];
            return device.some((value, index) => Math.abs(value - art[index] * wantedStep) > 0.05);
        });
        return { count: layers.length, off: off.map(image => image.dataset.sbArtLayer) };
    }, step);
}

for (const { name, options, steps } of VIEWPORTS) {
    test.describe(`Art motion at ${name}`, () => {
        test.use(options);

        test('plays when it is on screen: the pictures lie over the still, which is hidden, and the breath pose shows first', async ({ page }) => {
            await openFixturePage(page);
            await mountFigure(page);

            await waitFor(page, 'playing');

            expect(await readShown(page)).toEqual(['backdrop', 'tall:b:base', 'small:b:base']);
            await expect(page.locator('#figure > img').first()).toHaveCSS('visibility', 'hidden');
        });

        test('breathes, a little out of step for the second figure, and blinks in the pose that the eyes are in', async ({ page }) => {
            await openFixturePage(page);
            await mountFigure(page);
            await waitFor(page, 'playing');
            const at = async (ms) => {
                await page.clock.runFor(ms);
                return readShown(page);
            };

            // The second figure is 1.7 radians of a breath ahead, so it turns first, 401.5 ms in.
            expect(await at(404)).toEqual(['backdrop', 'tall:b:base', 'small:c:base']);
            expect(await at(472)).toEqual(['backdrop', 'tall:c:base', 'small:c:base']);
            // The second figure's first blink is 2700 ms in: half, closed, half and open again, in the pose that it is in.
            expect(await at(2700 - 876 + 1)).toEqual(['backdrop', 'tall:c:base', 'small:c:half']);
            expect(await at(70)).toEqual(['backdrop', 'tall:c:base', 'small:c:closed']);
            expect(await at(110)).toEqual(['backdrop', 'tall:c:base', 'small:c:half']);
            expect(await at(70)).toEqual(['backdrop', 'tall:c:base', 'small:c:base']);
        });

        test('keeps the motion inside the picture: nothing around it moves, and the page does not scroll sideways', async ({ page }) => {
            await openFixturePage(page);
            await mountFigure(page);
            await waitFor(page, 'playing');
            const before = await readSurroundings(page);

            for (let second = 0; second < 8; second++) {
                await page.clock.runFor(1000);
                expect(await readSurroundings(page)).toEqual(before);
            }
            expect(before.scroll[0]).toBeLessThanOrEqual(page.viewportSize().width);
        });

        for (const step of steps) {
            test(`puts every picture at its place in whole device pixels at ${step} device pixel${step === 1 ? '' : 's'} per art pixel`, async ({ page }) => {
                await openFixturePage(page);
                await mountFigure(page, { step });
                await waitFor(page, 'playing');

                const read = await layersOffTheirPlace(page, step);
                expect(read.count).toBe(9);
                expect(read.off).toEqual([]);
            });
        }

        test(`follows the layout when the step changes while it plays, from ${steps[0]} to ${steps[1]}`, async ({ page }) => {
            await openFixturePage(page);
            await mountFigure(page, { step: steps[0] });
            await waitFor(page, 'playing');

            await page.evaluate(async (step) => {
                const { sizePixelFigure } = await import('/scripts/sillybunny-home/pixel-art.js');
                sizePixelFigure(document.querySelector('#figure'), { step, ratio: devicePixelRatio });
            }, steps[1]);

            const read = await layersOffTheirPlace(page, steps[1]);
            expect(read.count).toBe(9);
            expect(read.off).toEqual([]);
        });

        test('stays a still under the Reduced Motion of the system, and asks for none of its pictures', async ({ page }) => {
            await page.emulateMedia({ reducedMotion: 'reduce' });
            const requests = await openFixturePage(page);
            await mountFigure(page);

            await page.clock.runFor(5000);

            expect(await state(page)).toBeNull();
            expect(requests).toEqual([]);
            expect(await readShown(page)).toEqual([]);
            await expect(page.locator('#figure > img')).toHaveCount(1);
            await expect(page.locator('#figure > img')).not.toHaveCSS('visibility', 'hidden');
        });

        test('stops under the Reduced Motion of the app, which is a class on the body, and plays again without it', async ({ page }) => {
            await openFixturePage(page);
            await mountFigure(page);
            await waitFor(page, 'playing');

            await page.evaluate(() => document.body.classList.add('reduced-motion'));
            await waitFor(page, 'still');
            await page.clock.runFor(5000);
            expect(await readShown(page)).toEqual(['backdrop', 'tall:c:base', 'small:c:base']);

            await page.evaluate(() => document.body.classList.remove('reduced-motion'));
            await waitFor(page, 'playing');
            await page.clock.runFor(404);
            expect(await readShown(page)).toEqual(['backdrop', 'tall:b:base', 'small:c:base']);
        });

        test('does not start, and asks for nothing, while the app setting is on', async ({ page }) => {
            const requests = await openFixturePage(page);
            await page.evaluate(() => document.body.classList.add('reduced-motion'));
            await mountFigure(page);

            await page.clock.runFor(3000);

            expect(requests).toEqual([]);
            expect(await state(page)).toBeNull();
        });

        test('pauses while the tab is hidden, and plays from the start of the scene when it is shown', async ({ page }) => {
            await openFixturePage(page);
            await mountFigure(page);
            await waitFor(page, 'playing');
            await page.clock.runFor(900);

            await page.evaluate(() => {
                Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
                document.dispatchEvent(new Event('visibilitychange'));
            });
            await waitFor(page, 'still');
            await page.clock.runFor(10_000);
            expect(await readShown(page)).toEqual(['backdrop', 'tall:c:base', 'small:c:base']);

            await page.evaluate(() => {
                Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
                document.dispatchEvent(new Event('visibilitychange'));
            });
            await waitFor(page, 'playing');
            await page.clock.runFor(404);
            expect(await readShown(page)).toEqual(['backdrop', 'tall:b:base', 'small:c:base']);
        });

        test('pauses when it scrolls out of view, and plays again when it comes back', async ({ page }) => {
            await openFixturePage(page);
            await page.evaluate(() => { document.querySelector('#host').style.cssText = 'position:absolute;left:20px;top:20px'; });
            await mountFigure(page);
            await waitFor(page, 'playing');

            await page.evaluate(() => window.scrollTo(0, 2000));
            await waitFor(page, 'still');
            await page.clock.runFor(5000);
            expect(await readShown(page)).toEqual(['backdrop', 'tall:c:base', 'small:c:base']);

            await page.evaluate(() => window.scrollTo(0, 0));
            await waitFor(page, 'playing');
        });

        test('keeps the still, and says so, when one of the pictures cannot be loaded', async ({ page }) => {
            const warnings = [];
            page.on('console', (message) => {
                if (message.type() === 'warning') warnings.push(message.text());
            });
            await openFixturePage(page, { failing: ['fixture-small-b-closed.png'] });
            await mountFigure(page);

            await waitFor(page, 'failed');

            await expect(page.locator('#figure [data-sb-art-layer]')).toHaveCount(0);
            await expect(page.locator('#figure > img')).not.toHaveCSS('visibility', 'hidden');
            expect(warnings.filter(text => text.includes('keeps its still'))).toHaveLength(1);
        });

        test('stop puts the still back and takes its pictures away', async ({ page }) => {
            await openFixturePage(page);
            await mountFigure(page);
            await waitFor(page, 'playing');

            await page.evaluate(() => window.motion.stop());

            await expect(page.locator('#figure [data-sb-art-layer]')).toHaveCount(0);
            await expect(page.locator('#figure > img')).not.toHaveCSS('visibility', 'hidden');
            expect(await state(page)).toBeNull();
        });
    });
}

/*
 * The same player in the hero of Home, through the shipped wiring: the hero asks `art-sources.js` whether its art
 * moves, reads the description of the scene, checks that it fits the still, and plays the pictures. No scene is
 * shipped yet, so the test gives the table one entry by changing the module on its way to the page, and serves a
 * fixture scene. When the real frames are in the table this block is the test of the wiring.
 */
const HERO_SCENE = { ...MANIFEST, scene: 'hero-duo', backdrop: 'hero-duo--backdrop.png' };
const ABOUT_SCENE = {
    ...MANIFEST,
    scene: 'about-reisen',
    grid: { width: ABOUT.width, height: ABOUT.height },
    backdrop: null,
    layers: [{ id: 'reisen', z: 1, left: 5, top: 6, width: 170, height: 350, waist: 150, images: MANIFEST.layers[0].images }],
};

/** Home with the hero's art listed as moving, and what the hero asked for in `requests`. */
async function openHomeWithMovingHero(page, { scene = HERO_SCENE, moving: extra = {} } = {}) {
    const requests = [];
    await page.clock.setFixedTime(new Date(2026, 9, 30, 12, 0));
    await protectMaintainerServer(page);
    await installFixtureChats(page);
    await page.route('**/scripts/sillybunny-home/art-sources.js*', async (route) => {
        const response = await route.fetch();
        const source = await response.text();
        const table = JSON.stringify({ 'hero-duo': 'hero-duo--breath.json', ...extra });
        const moving = source.replace('const PIXEL_MOTION = Object.freeze({});', `const PIXEL_MOTION = Object.freeze(${table});`);
        if (moving === source) throw new Error('The table of moving art is not where the test expects it.');
        await route.fulfill({ response, body: moving });
    });
    await page.route('**/img/sillybunny/*--*', (route) => {
        const file = new URL(route.request().url()).pathname.split('/').pop();
        requests.push(file);
        if (file === 'hero-duo--breath.json') return route.fulfill({ json: scene });
        if (file === 'about-reisen--breath.json') return route.fulfill({ json: ABOUT_SCENE });
        return route.fulfill({ contentType: 'image/png', body: ONE_PIXEL_PNG });
    });
    await page.route('**/img/sillybunny/fixture-*.png*', (route) => {
        requests.push(new URL(route.request().url()).pathname.split('/').pop());
        return route.fulfill({ contentType: 'image/png', body: ONE_PIXEL_PNG });
    });
    await openQuietChatForSmoke(page, { selectCharacter: false });
    await expect(page.locator('#chat > .welcomePanel')).toBeAttached({ timeout: 30_000 });
    return requests;
}

/** The hero is a panel that holds the figure, and the figure is what moves. */
const HERO_FIGURE = '.welcomePanel .sbHomeHeroArt .sbArtFigure';

for (const { name, options } of VIEWPORTS) {
    test.describe(`Art motion in the hero of Home at ${name}`, () => {
        test.use({ ...options, contextOptions: { reducedMotion: 'no-preference' } });
        test.describe.configure({ timeout: 90_000 });

        test('plays: the pictures of the scene lie over the hero, and its box and its band do not change', async ({ page }) => {
            const requests = await openHomeWithMovingHero(page);
            const hero = page.locator(HERO_FIGURE);
            await expect(hero).toHaveAttribute('data-sb-art-motion', 'playing', { timeout: 20_000 });

            await expect(hero.locator('[data-sb-art-layer]')).toHaveCount(9);
            await expect(hero.locator('> img').first()).toHaveCSS('visibility', 'hidden');
            expect(requests).toContain('hero-duo--breath.json');
            const box = await hero.boundingBox();
            await sleep(page, 2500);
            expect(await hero.boundingBox()).toEqual(box);
        });

        test('keeps the still when the scene is not the size of the picture', async ({ page }) => {
            await openHomeWithMovingHero(page, { scene: { ...HERO_SCENE, grid: { width: 300, height: 300 } } });
            const hero = page.locator(HERO_FIGURE);

            await expect(hero).toHaveAttribute('data-sb-art-motion', 'failed', { timeout: 20_000 });

            await expect(hero.locator('[data-sb-art-layer]')).toHaveCount(0);
            await expect(hero.locator('> img').first()).toBeVisible();
        });
    });

    test.describe(`Art motion in the hero of Home under Reduced Motion at ${name}`, () => {
        test.use({ ...options, contextOptions: { reducedMotion: 'reduce' } });
        test.describe.configure({ timeout: 90_000 });

        test('stays a still and does not even ask for the scene or its pictures', async ({ page }) => {
            const requests = await openHomeWithMovingHero(page);
            const hero = page.locator(HERO_FIGURE);
            await expect(hero.locator('> img').first()).toBeVisible();

            await sleep(page, 3000);

            expect(requests).toEqual([]);
            await expect(hero).not.toHaveAttribute('data-sb-art-motion', /./);
            await expect(hero.locator('[data-sb-art-layer]')).toHaveCount(0);
        });
    });
}

test.describe('Art motion in the hero of Home when the band shrinks the picture by a fraction', () => {
    test.use({ viewport: { width: 320, height: 640 }, contextOptions: { reducedMotion: 'no-preference' } });
    test.describe.configure({ timeout: 90_000 });

    test('keeps the still while the picture is smooth, and plays when the band is wide enough for whole pixels', async ({ page }) => {
        const requests = await openHomeWithMovingHero(page);
        const panel = page.locator('.welcomePanel .sbHomeHeroArt');
        const hero = page.locator(HERO_FIGURE);
        await expect(panel).toHaveAttribute('data-sb-art-fit', 'smooth');
        await expect(hero.locator('> img').first()).toBeVisible();

        await sleep(page, 2000);

        expect(requests, 'a picture that stays a still does not ask for its frames').toEqual([]);
        await expect(hero).not.toHaveAttribute('data-sb-art-motion', /./);
        await expect(hero.locator('[data-sb-art-layer]')).toHaveCount(0);

        await page.setViewportSize({ width: 1440, height: 900 });

        await expect(panel).not.toHaveAttribute('data-sb-art-fit', 'smooth');
        await expect(hero).toHaveAttribute('data-sb-art-motion', 'playing', { timeout: 20_000 });

        await page.setViewportSize({ width: 320, height: 640 });

        await expect(panel).toHaveAttribute('data-sb-art-fit', 'smooth');
        await expect(hero).toHaveAttribute('data-sb-art-motion', 'still', { timeout: 20_000 });
        await expect(hero.locator('> img').first()).not.toHaveCSS('visibility', 'hidden');
        await expect(hero.locator('[data-sb-art-layer]').first()).toHaveCSS('display', 'none');
    });
});

for (const { name, options } of VIEWPORTS) {
    test.describe(`Art motion in a window at ${name}`, () => {
        test.use({ ...options, contextOptions: { reducedMotion: 'no-preference' } });
        test.describe.configure({ timeout: 90_000 });

        test('plays in the panel or the banner of About, inside its box, and pauses when the window closes', async ({ page }) => {
            await openHomeWithMovingHero(page, { moving: { 'about-reisen': 'about-reisen--breath.json' } });
            await page.evaluate(() => import('/scripts/sillybunny-about.js').then(module => module.openAboutWindow()));
            const figure = page.locator('dialog.sb-dialog-host[open] .sbArtFigure[data-sb-art-placeholder="about-reisen"]');
            await expect(figure).toHaveAttribute('data-sb-art-motion', 'playing', { timeout: 20_000 });

            await expect(figure.locator('[data-sb-art-layer]')).toHaveCount(2);
            await expect(figure).toHaveCSS('overflow', 'hidden');
            const dialog = page.locator('dialog.sb-dialog-host[open] .sb-dialog');
            // The window springs open, so it is measured once it has stopped moving.
            let before = null;
            await expect.poll(async () => {
                const previous = before;
                before = await dialog.boundingBox();
                await sleep(page, 300);
                return JSON.stringify(previous) === JSON.stringify(before);
            }, { timeout: 10_000 }).toBe(true);
            await sleep(page, 2500);
            expect(await dialog.boundingBox()).toEqual(before);

            await page.evaluate(() => { window.closing = document.querySelector('dialog.sb-dialog-host[open] .sbArtFigure[data-sb-art-placeholder="about-reisen"]'); });
            await page.keyboard.press('Escape');
            await expect(page.locator('dialog.sb-dialog-host[open]')).toHaveCount(0);
            await expect.poll(() => page.evaluate(() => window.closing.dataset.sbArtMotion)).toBe('still');
        });
    });
}
