import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { installFixtureChats } from './helpers/fixture-chats.js';
import { applyHomeTestSettings } from './helpers/getting-started-state.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchBodyOrSkip } from './helpers/route-fetch.js';
import { installSlideProbe } from './helpers/slide-frames.js';

/*
 * Guards the Welcome page slide against stutter.
 *
 * Where a `:has()` rule is rooted at the body, as at phone widths, a node added or removed, an inline-style write or a
 * `hidden` change restyles the whole document, and every one of them in a slide is a chance to drop a frame.
 *
 * The first test is the primary guard. A MutationObserver that runs from before each slide records every such write
 * the dialog receives while a page moves, and allows only the header layout variable and the toasts. That list is
 * exact and does not depend on how fast or how busy the machine is. It also expects the art to play once the slide has
 * ended.
 *
 * The second test is a smoke test on the cost. It counts whole-document restyles in a trace, which cover at least
 * WHOLE_DOCUMENT_ELEMENTS elements. A slide needs three by its structure: the insertion of the incoming page, the write
 * of the header layout variable and the `hidden` attribute on the covered page. On a forward slide the insertion of
 * the art merges with `hidePrevious` as a fourth, so forward slides sit at the limit: in 12 instrumented runs, 16 of 48
 * forward slides counted 5 or more, and backward slides counted 2 to 3. The median over the slides of a run is what
 * the limit applies to, and it absorbs those and the occasional restyle of an unrelated periodic job (toast, picker
 * refresh). The trace is a smoke test because a count of 4 against 5 is noisy.
 */
test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'no-preference' } });
test.describe.configure({ timeout: 180_000 });

const HOST = 'dialog.sb-dialog-host:not([closing])';
const SHOWN = `${HOST} .sb-dialog__page:not([hidden]):not(.is-underlay):not(.is-leaving)`;
const WHOLE_DOCUMENT_ELEMENTS = 300;
const MAX_MEDIAN_RESTYLES_PER_SLIDE = 4;
const CYCLES = 2;
const TRACE_CATEGORIES = 'devtools.timeline,blink.user_timing';
// The one `:has()` rule that is rooted at the body sits in a `max-width: 768px` block (sillybunny-mobile-shell.css), so
// at a wider window a write restyles little more than its own element and the count stays near zero whatever a slide
// writes. This copy applies at every width and gives the body the same subject, so a write costs what it costs on a phone.
const BODY_HAS_PROBE = 'body:has([data-slide-toggle="shown"]) #send_form { --sb-restyle-probe: 1; }';

const VIEWPORTS = [
    { name: 'dialog 1440x900', options: { viewport: { width: 1440, height: 900 } } },
    { name: 'sheet 390x844', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];

const SLIDES = [
    ['1 to 2', '.sb-dialog__affirmative'],
    ['2 to 3', '.sb-dialog__affirmative'],
    ['3 to 2', '.sb-dialog__cancel'],
    ['2 to 1', '.sb-dialog__cancel'],
];

/** The hero of Home plays behind the dialog and writes to the page at every change of its picture, which is not what a slide does. */
async function keepHeroStill(page) {
    await page.route(/\/hero-duo(-night)?--breath\.json/, route => route.abort());
}

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

async function openWelcome(page) {
    await page.locator('#chat > .welcomePanel .sbHomeMenuButton').click();
    await page.getByRole('menuitem', { name: 'Show Welcome', exact: true }).click();
    await expect(page.locator(`${HOST} .sb-dialog__title`)).toHaveText('Welcome');
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => animation.effect?.target?.closest?.('dialog.sb-dialog-host')
        && Number.isFinite(animation.effect.getComputedTiming().endTime)).length)).toBe(0);
}

async function closeWelcome(page) {
    await page.locator(`${SHOWN} .sb-dialog__cancel`).click();
    await expect(page.locator(HOST)).toHaveCount(0);
}

const ART_FIGURE = id => `${SHOWN} .sbArtFigure[data-sb-art-placeholder="${id}"]`;
const PLAYING_TIMEOUT = 30_000;

/**
 * Records the writes that can restyle the document (a node added or removed, an inline `style`, `hidden`, and the
 * `data-sb-art-*` attributes of the art) that the dialog receives while a page moves. A write counts when the
 * observer's callback runs and a page still moves, which is the task that made it. The writes that the click itself
 * makes are the mounting of the page and are dropped. Two writes belong to a slide: the header layout variable, and
 * the toasts, which the dialog host holds in the top layer.
 */
async function recordSlideWrites(page) {
    await page.evaluate(() => {
        const host = document.querySelector('dialog.sb-dialog-host:not([closing])');
        const moving = () => host.querySelector('.is-paging, .is-sliding, .is-underlay, .is-leaving') !== null;
        const elementOf = node => (node.nodeType === 1 ? node : node.parentElement);
        const restyles = (record) => {
            if (record.type === 'childList') return true;
            return record.attributeName === 'style' || record.attributeName === 'hidden' || record.attributeName.startsWith('data-sb-art-');
        };
        const structural = (record) => {
            const target = elementOf(record.target);
            // A node that has left the document, such as a toast that has finished leaving, restyles nothing.
            if (!target.isConnected || target.closest('#toast-container') || [...record.addedNodes, ...record.removedNodes].some(node => node.id === 'toast-container')) return true;
            return record.attributeName === 'style' && target.matches('.sb-dialog__header') && target.style.length === 1 && target.style.getPropertyValue('--sb-dialog-header-side') !== '';
        };
        const describe = (record) => {
            const target = elementOf(record.target);
            const added = [...record.addedNodes].map(node => node.nodeName).join(',');
            return `${target.nodeName.toLowerCase()}.${target.className} ${record.type === 'attributes' ? record.attributeName : `+${added}`}`;
        };
        window.__slideWrites = [];
        window.__slideObserver = new MutationObserver((records) => {
            if (moving()) window.__slideWrites.push(...records.filter(restyles).filter(record => !structural(record)).map(describe));
        });
        window.__slideObserver.observe(host, { subtree: true, childList: true, attributes: true });
    });
}

/** Starts a trace and returns a function that stops it and resolves with the collected events. */
async function startTrace(page) {
    const session = await page.context().newCDPSession(page);
    const events = [];
    session.on('Tracing.dataCollected', ({ value }) => events.push(...value));
    const complete = new Promise(resolve => session.once('Tracing.tracingComplete', resolve));
    await session.send('Tracing.start', { categories: TRACE_CATEGORIES, transferMode: 'ReportEvents' });
    return async () => {
        await session.send('Tracing.end');
        await complete;
        await session.detach();
        return events;
    };
}

/** @returns {number[]} for each slide marked in the trace, the number of whole-document style recalculations inside it */
function wholeDocumentRestylesPerSlide(events) {
    const renderer = events.find(event => event.name === 'thread_name' && event.args?.name === 'CrRendererMain');
    expect(renderer, 'the trace has a renderer main thread').toBeTruthy();
    const marks = name => events
        .filter(event => event.cat?.includes('blink.user_timing') && event.name === name)
        .map(event => event.ts)
        .sort((a, b) => a - b);
    const starts = marks('slide-start');
    const ends = marks('slide-end');
    const recalcs = events.filter(event => event.pid === renderer.pid && event.tid === renderer.tid
        && event.ph === 'X' && event.name === 'UpdateLayoutTree' && (event.args?.elementCount ?? 0) >= WHOLE_DOCUMENT_ELEMENTS);
    return starts.map((start, index) => recalcs.filter(event => event.ts >= start && event.ts <= ends[index]).length);
}

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};

for (const { name, options } of VIEWPORTS) {
    test.describe(`Welcome slide at ${name}`, () => {
        test.use(options);

        test('a Welcome page slide makes no restyling write beyond the header variable, and the art plays when it has ended', async ({ page }) => {
            await protectMaintainerServer(page);
            await installFixtureChats(page);
            await useMotion(page);
            await openQuietChatForSmoke(page, { selectCharacter: false });
            await openWelcome(page);
            await installSlideProbe(page);
            await expect(page.locator(ART_FIGURE('welcome-both'))).toHaveAttribute('data-sb-art-motion', 'playing', { timeout: PLAYING_TIMEOUT });
            await recordSlideWrites(page);

            const steps = [
                ['1 to 2', '.sb-dialog__affirmative', 'welcome-persona-tewi'],
                ['2 to 3', '.sb-dialog__affirmative', 'welcome-next-reisen'],
                ['3 to 2', '.sb-dialog__cancel', 'welcome-persona-tewi'],
                ['2 to 1', '.sb-dialog__cancel', 'welcome-both'],
            ];
            for (const [label, button, art] of steps) {
                await page.evaluate(query => window.__slideFrames(() => {
                    document.querySelector(query).click();
                    window.__slideObserver.takeRecords();
                }), `${SHOWN} ${button}`);
                const writes = await page.evaluate(() => window.__slideWrites.splice(0));

                expect(writes, `restyling writes during the slide ${label}`).toEqual([]);
                await expect(page.locator(ART_FIGURE(art)), `the art plays after the slide ${label}`).toHaveAttribute('data-sb-art-motion', 'playing', { timeout: PLAYING_TIMEOUT });
            }
        });

        test('smoke: a Welcome page slide restyles the whole document at most a handful of times', async ({ page, browserName }) => {
            test.skip(browserName !== 'chromium', 'The trace comes from the Chrome DevTools Protocol.');
            await protectMaintainerServer(page);
            await installFixtureChats(page);
            await useMotion(page);
            await keepHeroStill(page);
            await openQuietChatForSmoke(page, { selectCharacter: false });
            await page.addStyleTag({ content: BODY_HAS_PROBE });
            const stopTrace = await startTrace(page);

            for (let cycle = 0; cycle < CYCLES; cycle++) {
                await openWelcome(page);
                await installSlideProbe(page);
                for (const [, button] of SLIDES) {
                    await page.evaluate(query => window.__slideFrames(() => document.querySelector(query).click()), `${SHOWN} ${button}`);
                    // Lets the work queued behind the slide (focus, observers) run outside the next slide's window.
                    await page.evaluate(() => new Promise(resolve => requestIdleCallback(resolve, { timeout: 300 })));
                }
                await closeWelcome(page);
            }

            const counts = wholeDocumentRestylesPerSlide(await stopTrace());
            expect(counts).toHaveLength(CYCLES * SLIDES.length);
            expect(median(counts), `whole-document restyles per slide: ${counts.join(', ')}`).toBeLessThanOrEqual(MAX_MEDIAN_RESTYLES_PER_SLIDE);
        });
    });
}
