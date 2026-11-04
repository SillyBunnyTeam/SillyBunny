import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { getPixelArt, getPixelMotionFile } from '../public/scripts/sillybunny-home/art-sources.js';
import { LAYER_EDGE_BIAS_CSS_PX } from '../public/scripts/sillybunny-home/pixel-art.js';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { installFixtureChats } from './helpers/fixture-chats.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

/*
 * The shipped frames, played by the shipped player: nothing is served by the test. What is read from the folder of the
 * pictures is only what the test needs to know what to expect, such as how many pictures a scene has and which of its
 * figures blink, so a new set of frames needs no change here.
 */

test.use({ serviceWorkers: 'block' });
test.describe.configure({ timeout: 120_000 });

const VIEWPORTS = [
    { name: 'desktop 1440x900', options: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone 390x844', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } },
];

const HERO_FIGURE = '.welcomePanel .sbHomeHeroArt .sbArtFigure';
const PLAYING_TIMEOUT = 30_000;

/** The scene that the shipped table names for `id`, as written, with the file names of its pictures. */
function readScene(id) {
    return JSON.parse(readFileSync(new URL(`../public/img/sillybunny/${getPixelMotionFile(id)}`, import.meta.url), 'utf8'));
}

/** How many pictures the player puts in the figure: one for the backdrop and one for each file of each layer. */
function countPictures(scene) {
    const filesOf = layer => new Set(Object.values(layer.images).flatMap(pose => Object.values(pose)));
    return (scene.backdrop ? 1 : 0) + scene.layers.reduce((total, layer) => total + filesOf(layer).size, 0);
}

/** The figures of the scene that have eyes to close, by id. */
const blinkingLayers = scene => scene.layers.filter(layer => layer.images.c.half || layer.images.c.closed).map(layer => layer.id);

/** Collects what the page asks the picture folder for, and what it says about a motion that did not load. */
function watch(page) {
    const watched = { requests: [], failures: [], warnings: [] };
    page.on('request', (request) => {
        const { pathname } = new URL(request.url());
        if (pathname.startsWith('/img/sillybunny/')) watched.requests.push(pathname.split('/').pop());
    });
    page.on('response', (response) => {
        const { pathname } = new URL(response.url());
        if (pathname.startsWith('/img/sillybunny/') && response.status() >= 400) watched.failures.push(`${response.status()} ${pathname}`);
    });
    page.on('console', (message) => {
        if (message.type() === 'warning' && message.text().includes('keeps its still')) watched.warnings.push(message.text());
    });
    return watched;
}

/**
 * The files that only a moving picture has: every one of them has a double dash in its name, and no still has. The loops
 * of the splash have them too, and they are not the art of Home.
 */
const motionFilesOf = requests => requests.filter(file => file.includes('--') && !file.startsWith('splash-'));

async function openHome(page, { hour }) {
    const watched = watch(page);
    await page.clock.setFixedTime(new Date(2026, 9, 30, hour, 0));
    await protectMaintainerServer(page);
    await installFixtureChats(page);
    await openQuietChatForSmoke(page, { selectCharacter: false });
    await expect(page.locator('#chat > .welcomePanel')).toBeAttached({ timeout: PLAYING_TIMEOUT });
    return watched;
}

/** Lets the page run for a while, on its own clock, so that a test can see that nothing changed. */
const sleep = (page, ms) => page.evaluate(duration => new Promise(resolve => setTimeout(resolve, duration)), ms);

/**
 * Collects what the figure shows at intervals as `layer:pose:picture`, until `done` says that it has seen enough or the
 * time is up, and returns what it saw.
 */
async function watchShown(page, figure, done, timeout) {
    const seen = new Set();
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline && !done(seen)) {
        const shown = await figure.evaluate(root => [...root.querySelectorAll('[data-sb-art-layer]')]
            .filter(image => image.style.visibility === 'visible' && image.style.display !== 'none')
            .map(image => (image.dataset.sbArtLayer === 'backdrop' ? 'backdrop' : `${image.dataset.sbArtLayer}:${image.dataset.sbArtPose}:${image.dataset.sbArtPicture}`)));
        shown.forEach(entry => seen.add(entry));
        await sleep(page, 40);
    }
    return seen;
}

/** The layers that are not where their art pixels put them, in device pixels from the figure, at the step that the figure is drawn at. */
function layersOffTheirPlace(figure) {
    return figure.evaluate((root, bias) => {
        const origin = root.getBoundingClientRect();
        const dpr = devicePixelRatio;
        const still = root.querySelector(':scope > img');
        const step = Math.round((origin.width * dpr) / still.naturalWidth);
        const layers = [...root.querySelectorAll('[data-sb-art-layer]')];
        const off = layers.filter((image) => {
            const box = image.getBoundingClientRect();
            const art = image.dataset.sbArtBox.split(' ').map(Number);
            const device = [(box.left - origin.left) * dpr, (box.top - origin.top) * dpr, box.width * dpr, box.height * dpr];
            // Every edge of a layer carries the bias that keeps it from being cut under a device pixel, and nothing else. The margin is the cut of a few layout units.
            return device.some((value, index) => Math.abs(value - (art[index] * step + bias * dpr)) > 0.06);
        });
        return { step, count: layers.length, off: off.map(image => `${image.dataset.sbArtLayer}:${image.dataset.sbArtPicture}`) };
    }, LAYER_EDGE_BIAS_CSS_PX);
}

/** Every pose and every blink that the scene has pictures for shows up, each at least once. */
async function expectBreathsAndBlinks(page, figure, scene) {
    const wantedBlinks = blinkingLayers(scene);
    const seen = await watchShown(page, figure, (entries) => {
        const poses = [...entries].filter(entry => entry.endsWith(':base')).map(entry => entry.split(':')[1]);
        const blinked = wantedBlinks.every(id => [...entries].some(entry => entry.startsWith(`${id}:`) && !entry.endsWith(':base')));
        return poses.includes('b') && poses.includes('c') && blinked;
    }, 20_000);

    const bases = [...seen].filter(entry => entry.endsWith(':base'));
    expect(bases.some(entry => entry.split(':')[1] === 'b'), 'a breath pose shows').toBe(true);
    expect(bases.some(entry => entry.split(':')[1] === 'c'), 'the neutral pose shows').toBe(true);
    for (const id of wantedBlinks) {
        expect([...seen].some(entry => entry.startsWith(`${id}:`) && !entry.endsWith(':base')), `${id} blinks`).toBe(true);
    }
}

for (const { name, options } of VIEWPORTS) {
    for (const { label, hour, id } of [{ label: 'day', hour: 12, id: 'hero-duo' }, { label: 'night', hour: 21, id: 'hero-duo-night' }]) {
        test.describe(`Shipped frames in the ${label} hero of Home at ${name}`, () => {
            test.use({ ...options, contextOptions: { reducedMotion: 'no-preference' } });

            test('play: every picture of the scene loads, lies on whole device pixels, and the figures breathe and blink', async ({ page }) => {
                const scene = readScene(id);
                const watched = await openHome(page, { hour });
                const hero = page.locator(HERO_FIGURE);
                await expect(hero).toHaveAttribute('data-sb-art-motion', 'playing', { timeout: PLAYING_TIMEOUT });

                await expect(hero.locator('[data-sb-art-layer]')).toHaveCount(countPictures(scene));
                const placed = await layersOffTheirPlace(hero);
                expect(placed.count).toBe(countPictures(scene));
                expect(placed.step).toBeGreaterThanOrEqual(1);
                expect(placed.off).toEqual([]);
                await expectBreathsAndBlinks(page, hero, scene);

                expect(watched.failures).toEqual([]);
                expect(watched.warnings).toEqual([]);
                expect(motionFilesOf(watched.requests).every(file => file.startsWith(`${id}--`)), 'only the pictures of this hero are asked for').toBe(true);
            });

            test('play without changing the box of the hero or the size of what is around it', async ({ page }) => {
                await openHome(page, { hour });
                const hero = page.locator(HERO_FIGURE);
                await expect(hero).toHaveAttribute('data-sb-art-motion', 'playing', { timeout: PLAYING_TIMEOUT });
                const panel = page.locator('.welcomePanel');
                const read = async () => ({ hero: await hero.boundingBox(), panel: await panel.evaluate(node => [node.scrollWidth, node.scrollHeight, node.clientHeight]) });
                const before = await read();

                await sleep(page, 3000);

                expect(await read()).toEqual(before);
            });
        });

        test.describe(`Shipped frames in the ${label} hero of Home under Reduced Motion at ${name}`, () => {
            test.use({ ...options, contextOptions: { reducedMotion: 'reduce' } });

            test('stay a still, and none of the motion files is asked for', async ({ page }) => {
                const watched = await openHome(page, { hour });
                const hero = page.locator(HERO_FIGURE);
                await expect(hero.locator('> img').first()).toBeVisible();
                await expect.poll(() => hero.locator('> img').first().evaluate(image => image.complete && image.naturalWidth)).toBe(getPixelArt(id).width);

                await sleep(page, 3000);

                expect(motionFilesOf(watched.requests)).toEqual([]);
                await expect(hero).not.toHaveAttribute('data-sb-art-motion', /./);
                await expect(hero.locator('[data-sb-art-layer]')).toHaveCount(0);
            });
        });
    }
}

/** Goes to the next step of Welcome once the page that is leaving has gone, so there is one button to press. */
async function goToNextStep(page) {
    const next = page.getByRole('button', { name: 'Next', exact: true });
    await expect(next).toHaveCount(1);
    await next.click();
}

const WELCOME_STEPS = [
    { id: 'welcome-both', after: async () => {} },
    { id: 'welcome-persona-tewi', after: goToNextStep },
    {
        id: 'welcome-next-reisen',
        after: async (page) => {
            await goToNextStep(page);
            await expect(page.locator('.sb-dialog__page:not(.is-underlay):not(.is-leaving) [data-sb-art-placeholder="welcome-persona-tewi"]')).toBeVisible();
            await goToNextStep(page);
        },
    },
];

for (const { name, options } of VIEWPORTS) {
    for (const [index, { id, after }] of WELCOME_STEPS.entries()) {
        test.describe(`Shipped frames in Welcome, ${id}, at ${name}`, () => {
            test.use({ ...options, contextOptions: { reducedMotion: 'no-preference' } });

            test('play inside the figure, which stays where it is, and the figures breathe', async ({ page }) => {
                const scene = readScene(id);
                const watched = await openHome(page, { hour: 12 });
                await page.evaluate(() => import('/scripts/sillybunny-welcome.js').then(module => module.openWelcomeDialog()));
                await after(page);
                const figure = page.locator(`.sb-dialog__page:not(.is-underlay):not(.is-leaving) .sbArtFigure[data-sb-art-placeholder="${id}"]`);
                await expect(figure).toHaveAttribute('data-sb-art-motion', 'playing', { timeout: PLAYING_TIMEOUT });

                await expect(figure.locator('[data-sb-art-layer]')).toHaveCount(countPictures(scene));
                await expect(figure).toHaveCSS('overflow', 'hidden');
                // A window springs open, so its figure is measured once it has stopped moving.
                await expect.poll(async () => (await layersOffTheirPlace(figure)).off, { timeout: 10_000 }).toEqual([]);
                await expectBreathsAndBlinks(page, figure, scene);

                expect(watched.failures).toEqual([]);
                expect(watched.warnings).toEqual([]);
                const reached = ['hero-duo', ...WELCOME_STEPS.slice(0, index + 1).map(step => step.id)];
                expect(motionFilesOf(watched.requests).filter(file => !reached.some(name => file.startsWith(`${name}--`))), 'the pictures of a step that was not reached are not asked for').toEqual([]);
            });
        });
    }

    test.describe(`Shipped frames in Welcome under Reduced Motion at ${name}`, () => {
        test.use({ ...options, contextOptions: { reducedMotion: 'reduce' } });

        test('stay a still, and none of the motion files of Welcome is asked for', async ({ page }) => {
            const watched = await openHome(page, { hour: 12 });
            await page.evaluate(() => import('/scripts/sillybunny-welcome.js').then(module => module.openWelcomeDialog()));
            const figure = page.locator('.sb-dialog__page:not(.is-underlay):not(.is-leaving) .sbArtFigure[data-sb-art-placeholder="welcome-both"]');
            await expect(figure.locator('> img').first()).toBeVisible();

            await sleep(page, 3000);

            expect(motionFilesOf(watched.requests)).toEqual([]);
            await expect(figure.locator('[data-sb-art-layer]')).toHaveCount(0);
        });
    });
}
