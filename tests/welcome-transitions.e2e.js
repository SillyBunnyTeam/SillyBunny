import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { installFixtureChats } from './helpers/fixture-chats.js';
import { applyHomeTestSettings } from './helpers/getting-started-state.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { waitForQuietFrames } from './helpers/quiet-frames.js';
import { fetchBodyOrSkip } from './helpers/route-fetch.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'no-preference' } });
test.describe.configure({ timeout: 120_000 });

const HOST = 'dialog.sb-dialog-host:not([closing])';
const TOLERANCE = 1;

const VIEWPORTS = [
    { name: 'dialog 1440x900', options: { viewport: { width: 1440, height: 900 } } },
    { name: 'sheet 390x844', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];

/** The saved Reduced Motion setting would turn the slide off, so the settings the page loads say it is off. */
async function useMotion(page) {
    await page.route('**/api/settings/get', async (route) => {
        const fetched = await fetchBodyOrSkip(route, response => response.json());
        if (!fetched) return;
        const { response, body: data } = fetched;
        const settings = JSON.parse(data.settings);
        settings.power_user.reduced_motion = false;
        applyHomeTestSettings(settings);
        return route.fulfill({ response, json: { ...data, settings: JSON.stringify(settings) } });
    });
}

/**
 * Installs `window.__transition(trigger)`. It runs `trigger`, freezes every finite animation inside the dialog
 * host in the same task, then steps their clock and samples the layout at each step. Stepping makes the result
 * independent of how fast the machine paints.
 */
async function installTransitionProbe(page) {
    await page.evaluate(() => {
        const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const sample = () => {
            const host = document.querySelector('dialog.sb-dialog-host:not([closing])');
            const surface = host.querySelector('.sb-dialog');
            const surfaceBox = surface.getBoundingClientRect();
            return {
                surface: surfaceBox.height,
                pages: [...host.querySelectorAll('.sb-dialog__page')].filter(page => !page.hidden).map((page) => {
                    const box = page.getBoundingClientRect();
                    return {
                        title: page.querySelector('.sb-dialog__title').textContent,
                        role: page.classList.contains('is-underlay') || page.classList.contains('is-leaving') ? 'outgoing' : 'incoming',
                        height: box.height,
                        visibleHeight: Math.max(0, Math.min(box.bottom, surfaceBox.bottom) - Math.max(box.top, surfaceBox.top)),
                        left: box.left - surfaceBox.left,
                    };
                }),
            };
        };
        const hostAnimations = () => document.getAnimations().filter(animation => animation.effect?.target?.closest?.('dialog.sb-dialog-host')
            && Number.isFinite(animation.effect.getComputedTiming().endTime));
        const endOf = animations => Math.max(0, ...animations.map(animation => animation.effect.getComputedTiming().endTime));
        // Callers fill a pushed page after push() returns, and the dialog reads the page's height once that code has run.
        const afterCaller = () => Promise.resolve();
        const step = async (animations, end, steps, record) => {
            for (let index = 0; index <= steps; index++) {
                animations.forEach((animation) => { animation.currentTime = (end * index) / steps; });
                await settle();
                record(sample());
            }
        };
        // A pin holds the height and flex-shrink of a page with an animation, not with an inline style.
        const pinnedNodes = nodes => nodes.filter(node => node.getAnimations().some(animation => animation.effect.getKeyframes().some(frame => frame.flexShrink !== undefined))).length;
        window.__transition = async (trigger) => {
            const before = sample();
            trigger();
            await afterCaller();
            const animations = hostAnimations();
            animations.forEach(animation => animation.pause());
            const targets = animations.map(animation => animation.effect.target)
                .filter(target => target.matches('dialog.sb-dialog-host, .sb-dialog, .sb-dialog-scrim'))
                .map(target => target.className);
            const end = endOf(animations);
            const frames = [];
            await step(animations, end, 12, frame => frames.push(frame));
            animations.forEach(animation => animation.finish());
            await settle();
            await settle();
            return { before, frames, after: sample(), targets, end };
        };
        window.__interrupted = async (first, second) => {
            const before = sample();
            first();
            await afterCaller();
            const firstAnimations = hostAnimations();
            firstAnimations.forEach(animation => animation.pause());
            const firstEnd = endOf(firstAnimations);
            firstAnimations.forEach((animation) => { animation.currentTime = firstEnd * 0.4; });
            await settle();
            const middle = sample();
            second();
            await afterCaller();
            const secondAnimations = hostAnimations().filter(animation => !firstAnimations.includes(animation));
            secondAnimations.forEach(animation => animation.pause());
            const frames = [];
            await step(secondAnimations, endOf(secondAnimations), 12, frame => frames.push(frame));
            // finish() on an animation that was cancelled brings it back, and the held pins of the first slide were cancelled.
            [...firstAnimations, ...secondAnimations].filter(animation => animation.playState !== 'idle').forEach(animation => animation.finish());
            await settle();
            await settle();
            return { before, middle, frames, after: sample() };
        };
        // Real time, no pausing: samples the painted state after every frame, so work that lands after the first
        // microtask (ResizeObserver callbacks, late content) is part of what the checks see.
        window.__live = (trigger) => new Promise((resolve) => {
            const hostNode = () => document.querySelector('dialog.sb-dialog-host:not([closing])');
            const liveSample = () => {
                const node = hostNode();
                const surfaceBox = node.querySelector('.sb-dialog').getBoundingClientRect();
                return {
                    time: performance.now(),
                    surface: surfaceBox.height,
                    animating: hostAnimations().length > 0,
                    pages: [...node.querySelectorAll('.sb-dialog__page')].filter(page => !page.hidden).map((page) => {
                        const body = page.querySelector('.sb-dialog__body');
                        return {
                            title: page.querySelector('.sb-dialog__title').textContent,
                            cls: [...page.classList].filter(name => name.startsWith('is-')).join(' '),
                            height: page.getBoundingClientRect().height,
                            bodyHeight: body.getBoundingClientRect().height,
                            sliding: page.classList.contains('is-sliding'),
                            edge: getComputedStyle(page).boxShadow,
                            dimOpacity: Number.parseFloat(getComputedStyle(page, '::before').opacity),
                            dimColour: getComputedStyle(page, '::before').backgroundColor,
                        };
                    }),
                };
            };
            const before = liveSample();
            const samples = [];
            const channel = new MessageChannel();
            let idle = 0;
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                resolve({
                    before,
                    samples,
                    startedAt,
                    backdropAlpha: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sb-dialog-backdrop-alpha')),
                });
            };
            // A timer ends the run too, because a page that is hidden or throttled paints no frames.
            setTimeout(finish, 8000);
            channel.port1.onmessage = () => {
                if (done) return;
                const current = liveSample();
                samples.push(current);
                idle = current.animating ? 0 : idle + 1;
                if (samples.length > 8 && idle >= 20) {
                    finish();
                    return;
                }
                requestAnimationFrame(() => channel.port2.postMessage(0));
            };
            const startedAt = performance.now();
            trigger();
            requestAnimationFrame(() => channel.port2.postMessage(0));
        });
        window.__stopped = async (trigger, how) => {
            const host = document.querySelector('dialog.sb-dialog-host:not([closing])');
            const nodes = [...host.querySelectorAll('.sb-dialog__page, .sb-dialog__pages')];
            trigger();
            await afterCaller();
            const nodesDuring = [...host.querySelectorAll('.sb-dialog__page, .sb-dialog__pages')];
            const animations = hostAnimations();
            animations.forEach(animation => animation.pause());
            const end = endOf(animations);
            animations.forEach((animation) => { animation.currentTime = end * 0.4; });
            await settle();
            const pinnedDuring = pinnedNodes(nodesDuring);
            if (how === 'cancel') animations.forEach(animation => animation.cancel());
            else window.__chain.forceClose();
            await settle();
            await new Promise(resolve => setTimeout(resolve, 900));
            return { pinnedDuring, pinnedAfter: pinnedNodes([...new Set([...nodes, ...nodesDuring])]), attached: nodesDuring.some(node => node.isConnected) };
        };
    });
}

/** Presses a response by clicking it, or by focusing it and pressing Enter. */
async function runTransition(page, selector, { keyboard }) {
    const css = `${HOST} .sb-dialog__page:not([hidden]):not(.is-underlay):not(.is-leaving) ${selector}`;
    if (!keyboard) {
        return page.evaluate(query => window.__transition(() => document.querySelector(query).click()), css);
    }
    await page.locator(css).focus();
    await page.keyboard.press('Shift');
    return page.evaluate(() => window.__transition(() => document.activeElement.click()));
}

function expectSteadyTransition({ before, frames, after, targets }, { rtl = false } = {}) {
    const from = before.surface;
    const to = after.surface;
    const low = Math.min(from, to) - TOLERANCE;
    const high = Math.max(from, to) + TOLERANCE;
    const outgoingHeight = before.pages[0].height;
    const incomingHeight = after.pages[0].height;

    expect(before.pages).toHaveLength(1);
    expect(after.pages).toHaveLength(1);

    expect(Math.abs(frames[0].surface - from), `the frame at the start of the slide is ${frames[0].surface}px high, and the dialog was ${from}px high`).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(frames.at(-1).surface - to), `the last frame is ${frames.at(-1).surface}px high, and the dialog rests at ${to}px`).toBeLessThanOrEqual(TOLERANCE);

    const heights = frames.map(frame => frame.surface);
    for (const height of heights) {
        expect(height, `heights: ${heights.join(', ')}`).toBeGreaterThanOrEqual(low);
        expect(height, `heights: ${heights.join(', ')}`).toBeLessThanOrEqual(high);
    }
    const direction = Math.sign(to - from);
    for (let index = 1; index < heights.length; index++) {
        expect((heights[index] - heights[index - 1]) * direction, `heights: ${heights.join(', ')}`).toBeGreaterThanOrEqual(-TOLERANCE);
    }

    for (const [index, frame] of frames.entries()) {
        const outgoing = frame.pages.filter(page => page.role === 'outgoing');
        const incoming = frame.pages.filter(page => page.role === 'incoming');
        expect(outgoing, `frame ${index} has one outgoing page`).toHaveLength(1);
        expect(incoming, `frame ${index} has one incoming page`).toHaveLength(1);
        expect(Math.abs(outgoing[0].height - outgoingHeight), `frame ${index}: the outgoing page is ${outgoing[0].height}px, and it was ${outgoingHeight}px`).toBeLessThanOrEqual(TOLERANCE);
        expect(Math.abs(incoming[0].height - incomingHeight), `frame ${index}: the incoming page is ${incoming[0].height}px, and it rests at ${incomingHeight}px`).toBeLessThanOrEqual(TOLERANCE);
        expect(Math.max(...frame.pages.map(page => page.visibleHeight)), `frame ${index} shows a page`).toBeGreaterThan(0);
    }

    const farthest = frames.flatMap(frame => frame.pages).reduce((far, candidate) => (Math.abs(candidate.left) > Math.abs(far.left) ? candidate : far));
    expect(Math.sign(farthest.left), `the page that travels is ${farthest.left}px from its place at the farthest`).toBe(rtl ? -1 : 1);
    expect(Math.abs(frames.at(-1).pages.find(page => page.role === 'incoming').left), 'the last frame has the incoming page in place').toBeLessThanOrEqual(2);

    expect(targets, 'a page change does not animate the dialog surface, the host or the backdrop').toEqual([]);
}

const IDLE_ANIMATIONS = () => document.getAnimations().filter(animation => animation.effect?.target?.closest?.('dialog.sb-dialog-host')
    && Number.isFinite(animation.effect.getComputedTiming().endTime)).length;
const NEXT = `${HOST} .sb-dialog__page:not([hidden]):not(.is-underlay):not(.is-leaving) .sb-dialog__affirmative`;
/** How many pages of the dialog hold a pinned height now. */
const PINNED_PAGES = () => [...document.querySelectorAll('dialog.sb-dialog-host .sb-dialog__page')]
    .filter(node => node.getAnimations().some(animation => animation.effect.getKeyframes().some(frame => frame.flexShrink !== undefined))).length;

async function openFromMenu(page, item, title) {
    await protectMaintainerServer(page);
    await installFixtureChats(page);
    await useMotion(page);
    await openQuietChatForSmoke(page, { selectCharacter: false });
    await page.locator('#chat > .welcomePanel .sbHomeMenuButton').click();
    await page.getByRole('menuitem', { name: item, exact: true }).click();
    await expect(page.locator(HOST)).toBeVisible();
    await expect(page.locator(`${HOST} .sb-dialog__title`)).toHaveText(title);
    await expect.poll(() => page.evaluate(IDLE_ANIMATIONS)).toBe(0);
    await waitForQuietFrames(page);
    await installTransitionProbe(page);
}

const openWelcome = page => openFromMenu(page, 'Show Welcome', 'Welcome');
const openAbout = page => openFromMenu(page, 'About SillyBunny', 'About SillyBunny');

/** Presses a control of the page that shows, as a click, in real time. */
async function runLive(page, selector, { keyboard = false } = {}) {
    const css = `${HOST} .sb-dialog__page:not([hidden]):not(.is-underlay):not(.is-leaving) ${selector}`;
    if (keyboard) {
        await page.locator(css).focus();
        await page.keyboard.press('Shift');
        return page.evaluate(() => window.__live(() => document.activeElement.click()));
    }
    return page.evaluate(query => window.__live(() => document.querySelector(query).click()), css);
}

/** The page that slides in a painted sample: the one that leaves, or the one that enters over a covered page. */
function findSliding(sample) {
    return sample.pages.find(page => page.sliding);
}

/** The same colour with alpha 1, from a computed colour such as `rgba(80, 0, 0, 0.5)` or `oklab(0.3 0.1 0.05 / 0.5)`. */
function opaqueColour(css) {
    return css.replace(/\/\s*[\d.]+\s*\)$/, ')').replace(/^rgba\((.*),\s*[\d.]+\)$/, 'rgb($1)');
}

/**
 * Reads the colours of a computed box-shadow in the order they are painted. A theme colour that goes through relative
 * colour syntax or an interpolation computes to a colour function such as oklab(), so each colour is kept as text
 * with `opaque`, the same colour at alpha 1 for a browser to convert.
 */
function parseShadowColours(shadow) {
    return [...shadow.matchAll(/(?:rgba?|color|oklab|oklch|lab|lch)\([^)]*\)/g)].map(([css]) => ({ css, opaque: opaqueColour(css) }));
}

/** The sRGB channels of a CSS colour, as a browser paints it. */
function paintedChannels(page, colour) {
    return page.evaluate((value) => {
        const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
        return { r, g, b };
    }, colour);
}

/** The alpha of a computed colour, from `rgba(0, 0, 6, 0.5)` or `color(srgb 0 0 0.02 / 0.5)`. */
function colourAlpha(css) {
    const alpha = css.match(/(?:\/|,)\s*([\d.]+)\s*\)$/);
    return alpha ? Number(alpha[1]) : 1;
}

/** What the dim layer of a sliding page paints over the page it covers: its opacity times the alpha of its colour. */
function dimAlpha(page) {
    return page.dimOpacity * colourAlpha(page.dimColour);
}

/**
 * The dim the sliding page casts on the page it covers: it rises across a push to half the Dialog Backdrop alpha,
 * which is libadwaita's dimming, and falls across a pop. Nothing casts a shadow once the slide is over.
 */
function expectDim({ samples, backdropAlpha }, { rising }) {
    const half = backdropAlpha / 2;
    const dims = samples.filter(sample => sample.animating).map(sample => dimAlpha(findSliding(sample)));
    const direction = rising ? 1 : -1;
    for (let index = 1; index < dims.length; index++) {
        expect((dims[index] - dims[index - 1]) * direction, `the dim ${rising ? 'rises' : 'falls'}. dims: ${dims.join(', ')}`).toBeGreaterThanOrEqual(-0.005);
    }
    const [start, end] = rising ? [dims[0], dims.at(-1)] : [dims.at(-1), dims[0]];
    expect(Math.abs(end - half), `the slide ends with half the backdrop alpha (${half}) on the page. dims: ${dims.join(', ')}`).toBeLessThanOrEqual(rising ? 0.03 : half * 0.6);
    expect(start, `the slide starts without it. dims: ${dims.join(', ')}`).toBeLessThanOrEqual(rising ? half * 0.6 : 0.03);
    expect(samples.at(-1).pages.map(shown => shown.edge), 'nothing casts a shadow at rest').toEqual(samples.at(-1).pages.map(() => 'none'));
}

/** The length of the Navigation spring in sillybunny-motion.js, in ms. */
const SLIDE_MS = 334;
const FRAME_MS = 50;

/** The time from the trigger to the last frame that had a motion running. */
function slideLength({ samples, startedAt }) {
    return samples.filter(sample => sample.animating).at(-1).time - startedAt;
}

/**
 * Checks a slide that ran in real time: the dialog height moves one way and ends the slide at the height it rests
 * at, no page reflows while it shows (unless the content itself changes), and the page that slides casts a shadow over the one it covers.
 */
function expectLiveSlide({ before, samples }, { contentChanges = false, minFrames = 6 } = {}) {
    const animated = samples.filter(sample => sample.animating);
    expect(animated.length, 'the slide painted frames').toBeGreaterThanOrEqual(minFrames);
    const lastIndex = samples.lastIndexOf(animated.at(-1));
    const rest = samples.at(-1).surface;
    const heights = [before.surface, ...animated.map(sample => sample.surface)];
    const description = `heights: ${heights.map(height => Math.round(height * 10) / 10).join(', ')}, then ${samples.slice(lastIndex + 1, lastIndex + 3).map(sample => sample.surface).join(', ')}`;

    expect(Math.abs(animated.at(-1).surface - rest), `the last frame of the slide and the rest height differ. ${description}`).toBeLessThanOrEqual(TOLERANCE);
    const direction = Math.sign(rest - before.surface);
    for (let index = 1; index < heights.length; index++) {
        expect((heights[index] - heights[index - 1]) * direction, `the height moves one way. ${description}`).toBeGreaterThanOrEqual(-TOLERANCE);
    }

    for (const [index, sample] of samples.entries()) {
        for (const page of contentChanges ? [] : sample.pages) {
            const earlier = samples[index - 1]?.pages.find(candidate => candidate.title === page.title);
            if (!earlier) continue;
            expect(Math.abs(page.height - earlier.height), `frame ${index}: ${page.title} changed from ${earlier.height}px to ${page.height}px`).toBeLessThanOrEqual(TOLERANCE);
            expect(Math.abs(page.bodyHeight - earlier.bodyHeight), `frame ${index}: the body of ${page.title} changed from ${earlier.bodyHeight}px to ${page.bodyHeight}px`).toBeLessThanOrEqual(TOLERANCE);
        }
    }

    for (const [index, sample] of animated.entries()) {
        const sliding = findSliding(sample);
        expect(sliding?.edge, `frame ${index}: the sliding page casts a shadow over the page it covers`).not.toBe('none');
        expect(sample.pages.filter(page => page !== sliding).map(page => page.edge), `frame ${index}: the page that stays does not cast one`).toEqual(sample.pages.filter(page => page !== sliding).map(() => 'none'));
    }
    expect(samples.at(-1).pages.map(page => page.edge), 'no shadow stays at rest').toEqual(samples.at(-1).pages.map(() => 'none'));
}

/** Opens a plain dialog whose root page is 160px high; `window.__block(n)` makes content of any height. */
async function openChain(page) {
    await protectMaintainerServer(page);
    await installFixtureChats(page);
    await useMotion(page);
    await openQuietChatForSmoke(page, { selectCharacter: false });
    await page.evaluate(async () => {
        const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
        const block = (height) => {
            const node = document.createElement('div');
            node.style.height = `${height}px`;
            return node;
        };
        window.__chain = openDialog({ tier: 'dialog', title: 'Root', content: block(160) });
        window.__block = block;
    });
    await expect(page.locator(`${HOST} .sb-dialog__title`)).toHaveText('Root');
    await expect.poll(() => page.evaluate(IDLE_ANIMATIONS)).toBe(0);
    await waitForQuietFrames(page);
    await installTransitionProbe(page);
}

for (const { name, options } of VIEWPORTS) {
    test.describe(`Welcome page transitions at ${name}`, () => {
        test.use(options);

        for (const keyboard of [false, true]) {
            test(`${keyboard ? 'keyboard' : 'pointer'}: Next, Next, Back, Back keep the dialog and both pages steady`, async ({ page }) => {
                await openWelcome(page);

                for (const [label, selector] of [
                    ['Welcome to Your Persona', '.sb-dialog__affirmative'],
                    ['Your Persona to What\u2019s Next', '.sb-dialog__affirmative'],
                    ['What\u2019s Next back to Your Persona', '.sb-dialog__cancel'],
                    ['Your Persona back to Welcome', '.sb-dialog__cancel'],
                ]) {
                    const result = await test.step(label, () => runTransition(page, selector, { keyboard }));
                    expect.soft(result.end, `${label} animates`).toBeGreaterThan(0);
                    await test.step(`${label}: heights`, () => expectSteadyTransition(result));
                    expect(await page.evaluate(PINNED_PAGES), `${label} leaves no pinned height`).toBe(0);
                }
            });
        }

        test('a second Next pressed while the first slide runs keeps the older page at its height', async ({ page }) => {
            await openWelcome(page);

            const result = await page.evaluate(selector => window.__interrupted(
                () => document.querySelector(selector).click(),
                () => document.querySelector(selector).click(),
            ), NEXT);

            const welcomeHeight = result.before.pages[0].height;
            expect(Math.abs(result.frames[0].surface - result.middle.surface), 'the second slide starts from the height the first one reached').toBeLessThanOrEqual(TOLERANCE);
            for (const [index, frame] of result.frames.entries()) {
                const welcome = frame.pages.find(candidate => candidate.title === 'Welcome');
                expect(welcome, `frame ${index} still shows the Welcome page beside the sliding pages`).toBeTruthy();
                expect(Math.abs(welcome.height - welcomeHeight), `frame ${index}: the Welcome page is ${welcome.height}px, and it was ${welcomeHeight}px`).toBeLessThanOrEqual(TOLERANCE);
            }
            expect(result.after.pages.map(candidate => candidate.title)).toEqual(['What\u2019s Next']);
            expect(await page.evaluate(PINNED_PAGES)).toBe(0);
        });
    });
}

for (const { name, options } of VIEWPORTS) {
    test.describe(`Page transitions in real time at ${name}`, () => {
        test.use(options);

        for (const keyboard of [false, true]) {
            test(`${keyboard ? 'keyboard' : 'pointer'}: Welcome, Your Persona and What\u2019s Next slide steadily`, async ({ page }) => {
                await openWelcome(page);

                for (const [label, selector] of [
                    ['Welcome to Your Persona', '.sb-dialog__affirmative'],
                    ['Your Persona to What\u2019s Next', '.sb-dialog__affirmative'],
                    ['What\u2019s Next back to Your Persona', '.sb-dialog__cancel'],
                    ['Your Persona back to Welcome', '.sb-dialog__cancel'],
                ]) {
                    const live = await test.step(label, () => runLive(page, selector, { keyboard }));
                    expect(live.samples.length, `${label} painted frames`).toBeGreaterThan(8);
                    await test.step(`${label}: frames`, () => expectLiveSlide(live));
                }
            });
        }

        for (const [title, section] of [['Troubleshooting', 'Troubleshooting'], ['Credits', 'Credits']]) {
            test(`About to ${title} and back slides steadily and ends at the height the page rests at`, async ({ page }) => {
                await openAbout(page);

                const forward = await page.evaluate(label => window.__live(() => [...document.querySelectorAll('dialog.sb-dialog-host button')]
                    .find(button => button.textContent.trim().startsWith(label)).click()), section);
                expect(forward.samples.length, 'the push painted frames').toBeGreaterThan(8);
                await test.step('push', () => expectLiveSlide(forward));
                const back = await runLive(page, '.sb-dialog__back');
                expect(back.samples.length, 'the pop painted frames').toBeGreaterThan(8);
                await test.step('pop', () => expectLiveSlide(back));
            });
        }

        test('Troubleshooting still ends at its rest height when the page is slow to render', async ({ page, browserName }) => {
            test.skip(browserName !== 'chromium', 'CPU throttling goes through a CDP session, which only Chromium offers');
            await openAbout(page);
            const session = await page.context().newCDPSession(page);
            await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });

            const forward = await page.evaluate(() => window.__live(() => [...document.querySelectorAll('dialog.sb-dialog-host button')]
                .find(button => button.textContent.trim().startsWith('Troubleshooting')).click()));
            await session.send('Emulation.setCPUThrottlingRate', { rate: 1 });

            expect(forward.samples.length, 'the push painted frames').toBeGreaterThan(8);
            // A slow page paints few frames of the slide, so only its end height and its direction are checked.
            expectLiveSlide(forward, { minFrames: 2 });
        });
    });
}

/** Presses the About row that opens the page with this label, in real time. */
function pushAboutPage(page, label) {
    return page.evaluate(text => window.__live(() => [...document.querySelectorAll('dialog.sb-dialog-host button')]
        .find(button => button.textContent.trim().startsWith(text)).click()), label);
}

test.describe('Page transition shade', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    for (const [tone, backdropAlpha] of [['dark', 0.5], ['light', 0.14]]) {
        test(`the page it covers dims as the page slides over it, in a ${tone} surface`, async ({ page }) => {
            await openAbout(page);
            await page.evaluate((value) => { document.documentElement.dataset.sbSurfaceTone = value; }, tone);

            const push = await pushAboutPage(page, 'Credits');
            const pop = await runLive(page, '.sb-dialog__back');

            expect(push.backdropAlpha, `the ${tone} surface has its Dialog Backdrop alpha`).toBeCloseTo(backdropAlpha, 2);
            expectDim(push, { rising: true });
            expectDim(pop, { rising: false });
        });
    }

    test('the shade is the theme\u2019s shadow colour', async ({ page }) => {
        await openAbout(page);
        await page.evaluate(() => document.documentElement.style.setProperty('--SmartThemeShadowColor', 'rgba(80, 0, 0, 1)'));

        const push = await pushAboutPage(page, 'Credits');

        const animated = push.samples.filter(sample => sample.animating);
        expect(animated.length).toBeGreaterThan(5);
        const sliding = findSliding(animated[Math.floor(animated.length / 2)]);
        const [edge] = parseShadowColours(sliding.edge);
        for (const css of [edge.opaque, opaqueColour(sliding.dimColour)]) {
            const { r, g, b } = await paintedChannels(page, css);
            expect(r, `the shade keeps the red of the theme colour: ${css}`).toBeGreaterThan(70);
            expect(r).toBeLessThan(90);
            expect(Math.max(g, b)).toBeLessThan(10);
        }
    });
});

test.describe('Welcome page transitions in a right-to-left document', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('Next and Back slide from the leading side and keep the dialog steady', async ({ page }) => {
        await openWelcome(page);
        await page.evaluate(() => { document.documentElement.dir = 'rtl'; });

        const forward = await runTransition(page, '.sb-dialog__affirmative', { keyboard: false });
        expect(forward.end, 'Next animates').toBeGreaterThan(0);
        await test.step('Next', () => expectSteadyTransition(forward, { rtl: true }));
        const back = await runTransition(page, '.sb-dialog__cancel', { keyboard: false });
        await test.step('Back', () => expectSteadyTransition(back, { rtl: true }));
    });
});

test.describe('Shared page chain', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('a pushed page of another height grows and shrinks the dialog with the slide', async ({ page }) => {
        await openChain(page);

        const forward = await page.evaluate(() => window.__transition(() => {
            window.__child = window.__chain.push({ title: 'Child', content: window.__block(420) });
        }));
        expect(forward.end, 'the push animates').toBeGreaterThan(0);
        await test.step('push a taller page', () => expectSteadyTransition(forward));

        const back = await page.evaluate(() => window.__transition(() => window.__child.close()));
        await test.step('pop back to the shorter page', () => expectSteadyTransition(back));
    });

    test('content added after push() returns sets the height the slide ends at', async ({ page }) => {
        await openChain(page);

        const forward = await page.evaluate(() => window.__transition(() => {
            const child = window.__chain.push({ title: 'Late' });
            child.body.append(window.__block(420));
        }));

        expectSteadyTransition(forward);
        expect(forward.after.surface, 'the dialog rests at the height of the late content').toBeGreaterThan(420);
    });

    test('content that grows after the slide has started moves the end of the slide with it', async ({ page }) => {
        await openChain(page);

        const live = await page.evaluate(() => window.__live(() => {
            const block = window.__block(300);
            window.__chain.push({ title: 'Grows', content: block });
            setTimeout(() => { block.style.height = '420px'; }, 90);
        }));

        expectLiveSlide(live, { contentChanges: true });
        expect(live.samples.at(-1).surface, 'the dialog rests at the height of the grown content').toBeGreaterThan(420);
    });

    test('replacing a child with one of the same height does not move the end of the slide', async ({ page }) => {
        await openChain(page);

        const live = await page.evaluate(() => window.__live(() => {
            const first = window.__block(300);
            window.__chain.push({ title: 'Replaced', content: first });
            setTimeout(() => first.replaceWith(window.__block(300)), 60);
        }));

        expect(slideLength(live), 'the height motion ends with its own duration').toBeLessThanOrEqual(SLIDE_MS + FRAME_MS);
        expectLiveSlide(live);
    });

    test('a page whose height keeps changing does not keep the slide running', async ({ page }) => {
        await openChain(page);

        const live = await page.evaluate(() => window.__live(() => {
            const block = window.__block(300);
            window.__chain.push({ title: 'Jitter', content: block });
            let wide = false;
            const timer = setInterval(() => {
                wide = !wide;
                block.style.height = wide ? '304px' : '300px';
            }, 30);
            setTimeout(() => clearInterval(timer), 1500);
        }));

        expect(slideLength(live), 'the height motion ends with its own duration').toBeLessThanOrEqual(SLIDE_MS + FRAME_MS);
    });

    for (const how of ['cancel', 'close']) {
        test(`a slide that is ${how === 'cancel' ? 'cancelled' : 'cut short by closing the dialog'} leaves no pinned height`, async ({ page }) => {
            await openChain(page);

            const result = await page.evaluate(mode => window.__stopped(() => {
                window.__chain.push({ title: 'Child', content: window.__block(420) });
            }, mode), how);

            expect(result.pinnedDuring, 'the pages are pinned while the slide runs').toBeGreaterThan(0);
            expect(result.pinnedAfter, 'no page or pages node keeps an inline height or flex-shrink').toBe(0);
        });
    }

    test('closing several pages at once keeps each page that is still showing at its height', async ({ page }) => {
        await openChain(page);
        await page.evaluate(() => {
            window.__first = window.__chain.push({ title: 'First', content: window.__block(300) });
        });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expect.poll(() => page.evaluate(IDLE_ANIMATIONS)).toBe(0);
        await page.evaluate(() => {
            window.__second = window.__first.push({ title: 'Second', content: window.__block(520) });
        });
        await expect.poll(() => page.evaluate(IDLE_ANIMATIONS)).toBe(0);

        const result = await page.evaluate(() => window.__transition(() => {
            window.__second.forceClose();
            window.__first.forceClose();
        }));
        const chrome = result.before.pages[0].height - 520;
        const rest = { Root: result.after.pages[0].height, First: 300 + chrome, Second: 520 + chrome };

        for (const [index, frame] of result.frames.entries()) {
            expect(frame.pages.map(shown => shown.title), `frame ${index} shows all three pages`).toEqual(['Root', 'First', 'Second']);
            for (const shown of frame.pages) {
                expect(Math.abs(shown.height - rest[shown.title]), `frame ${index}: ${shown.title} is ${shown.height}px, and it rests at ${rest[shown.title]}px`).toBeLessThanOrEqual(TOLERANCE);
            }
        }
        expect(await page.evaluate(PINNED_PAGES)).toBe(0);
    });
});
