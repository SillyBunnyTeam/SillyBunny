/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- The right edge of the card is compared on desktop widths only; the phone layout of the Characters window reserves a gutter beside its page. */
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';
import { waitForAppReady } from './helpers/app-ready.js';
import { agentFixture } from './fixtures/in-chat-agents-editor.js';
import { openAgentList, openPromptList, openWorldInfoEntries } from './helpers/surfaces/list-steps.js';

// The Prompt editor is a list-editor page in the Backend; World Info is one in the Characters window. Both lists stand in the same
// frame: the list's card starts at the same distance from the top of its page and from its sides, and the rows sit the same
// distance inside the card.

const BOOK = 'SB_PROMPT_FRAME_BOOK';
const ENTRY_COUNT = 40;
const AGENT_COUNT = 40;

/** A tall window leaves both lists unscrolled; the short one makes the prompt list and a World Info page scroll. */
const CASES = [
    { name: '1440x900 with scrolling lists', width: 1440, height: 900, agents: AGENT_COUNT },
    { name: '1440x2600 without scrolling lists', width: 1440, height: 2600, agents: 3 },
    { name: '390x844 with scrolling lists', width: 390, height: 844, agents: AGENT_COUNT },
    { name: '390x2600 without scrolling lists', width: 390, height: 2600, agents: 3 },
];

let agentCount = 0;

test.beforeEach(async ({ page }) => {
    agentCount = 0;
    await protectMaintainerServer(page);
    const entries = Object.fromEntries(Array.from({ length: ENTRY_COUNT }, (_, uid) => [uid, {
        uid, comment: `Frame entry ${uid}`, key: [`k${uid}`], keysecondary: [], content: `Entry ${uid}`, constant: false, vectorized: false,
        selective: true, order: 100, position: 0, disable: false, displayIndex: uid,
    }]));
    await page.route('**/api/settings/get', async route => {
        const payload = await fetchJsonOrSkip(route);
        if (!payload) return;
        const inChatAgents = Array.from({ length: agentCount }, (_, index) => agentFixture({ id: `frame-agent-${index}`, name: `Frame agent ${index}`, description: 'Frame', tags: [] }));
        return route.fulfill({ json: { ...payload, world_names: [BOOK], ...(agentCount ? { inChatAgents } : {}) } });
    });
    await page.route('**/api/worldinfo/**', route => {
        const endpoint = new URL(route.request().url()).pathname.split('/').at(-1);
        const buffer = route.request().postDataBuffer();
        const payload = buffer ? JSON.parse((route.request().headers()['content-encoding'] === 'gzip' ? gunzipSync(buffer) : buffer).toString()) : {};
        if (endpoint === 'get') return route.fulfill({ status: payload.name === BOOK ? 200 : 404, json: payload.name === BOOK ? { entries } : {} });
        if (endpoint === 'list') return route.fulfill({ json: [{ name: BOOK, entries }] });
        return route.abort();
    });
});

/** The frame of the list that `list` names, in pixels: the card against its page, and the rows against the card. */
function frameOf({ card, row }) {
    const visible = element => element.getBoundingClientRect().height > 0;
    const cardElement = [...document.querySelectorAll(card)].find(visible);
    const header = cardElement.querySelector('.sb-list-header, .sb-persona-list-header');
    const first = [...cardElement.querySelectorAll(row)].find(visible);
    const heading = [...cardElement.querySelectorAll('.sb-wi-list-heading, .sb-prompt-section h3, .ica-agents-stage')].find(visible);
    const body = first.closest('.sb-wi-list-body, .sb-prompt-list-body, .ica-agents-body');
    let page = cardElement.parentElement;
    while (page && !page.matches('.scrollableInner, .sb-shell-panel-scroller')) page = page.parentElement;
    const cardBox = cardElement.getBoundingClientRect();
    const pageBox = page.getBoundingClientRect();
    const firstBox = first.getBoundingClientRect();
    const headerBox = header.getBoundingClientRect();
    return {
        cardTop: cardBox.top - pageBox.top,
        cardLeft: cardBox.left - pageBox.left,
        cardRight: pageBox.right - cardBox.right,
        headerHeight: headerBox.height,
        headerToFirstRow: firstBox.top - headerBox.bottom,
        headerToHeadingText: heading.getBoundingClientRect().top + parseFloat(getComputedStyle(heading).paddingTop) - headerBox.bottom,
        bodyPadding: getComputedStyle(body).padding,
        gutter: getComputedStyle(body).scrollbarGutter,
        scrolls: body.scrollHeight > body.clientHeight,
        rowLeft: firstBox.left - cardBox.left,
        rowRight: cardBox.right - firstBox.right,
    };
}

for (const { name, width, height } of CASES) {
    test(`the prompt list stands in the frame of the World Info list, ${name}`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await page.goto('/');
        await waitForAppReady(page, { timeout: 60000 });

        await openWorldInfoEntries(page, BOOK);
        const worldInfo = await page.evaluate(frameOf, { card: '#WorldInfo .sb-wi-editor', row: '.sb-wi-row' });
        await openPromptList(page, 'chat-completion');
        const prompt = await page.evaluate(frameOf, { card: '.sb-prompt-editor', row: '.sb-prompt-row' });

        expect(prompt.cardTop).toBeCloseTo(worldInfo.cardTop, 0);
        expect(prompt.cardLeft).toBeCloseTo(worldInfo.cardLeft, 0);
        // The Characters window reserves a scrollbar gutter beside the whole page on a phone layout, which the Backend page does not.
        if (width > 768) {
            expect(prompt.cardRight).toBeCloseTo(worldInfo.cardRight, 0);
        }
        expect(prompt.headerHeight).toBeCloseTo(worldInfo.headerHeight, 0);
        expect(prompt.headerToFirstRow).toBeCloseTo(worldInfo.headerToFirstRow, 0);
        expect(prompt.rowLeft).toBeCloseTo(worldInfo.rowLeft, 0);
        expect(prompt.rowRight).toBeCloseTo(worldInfo.rowRight, 0);
    });
}

/** The open editor's frame: its header against the top of its page, and its right and bottom edges against the window (the two pages have scrollers of different sizes). */
function openFrameOf({ detail }) {
    const visible = element => element.getBoundingClientRect().height > 0;
    const detailElement = [...document.querySelectorAll(detail)].find(visible);
    const header = detailElement.querySelector('.sb-editor-header');
    let page = detailElement.parentElement;
    while (page && !page.matches('.scrollableInner, .sb-shell-panel-scroller')) page = page.parentElement;
    const pageBox = page.getBoundingClientRect();
    const headerBox = header.getBoundingClientRect();
    const detailBox = detailElement.getBoundingClientRect();
    return {
        headerTop: headerBox.top - pageBox.top,
        headerRight: window.innerWidth - headerBox.right,
        headerHeight: headerBox.height,
        detailBottom: window.innerHeight - detailBox.bottom,
    };
}

/** The open editor slides in from beside the window; measure it once it is on screen and two reads in a row agree. */
async function settledOpenFrame(page, detail) {
    let last = await page.evaluate(openFrameOf, { detail });
    await expect.poll(async () => {
        const next = await page.evaluate(openFrameOf, { detail });
        const same = next.headerRight >= 0 && JSON.stringify(next) === JSON.stringify(last);
        last = next;
        return same;
    }).toBe(true);
    return last;
}

for (const { name, width, height, agents } of CASES) {
    test(`the Agents list stands in the frame of the World Info list, ${name}`, async ({ page }) => {
        agentCount = agents;
        await page.setViewportSize({ width, height });
        await page.goto('/');
        await waitForAppReady(page, { timeout: 60000 });

        await openWorldInfoEntries(page, BOOK);
        const worldInfo = await page.evaluate(frameOf, { card: '#WorldInfo .sb-wi-editor', row: '.sb-wi-row' });
        await openAgentList(page);
        const list = await page.evaluate(frameOf, { card: '.ica-agents-editor', row: '[data-saved="true"]' });

        expect(list.cardTop).toBeCloseTo(worldInfo.cardTop, 0);
        expect(list.cardLeft).toBeCloseTo(worldInfo.cardLeft, 0);
        if (width > 768) {
            expect(list.cardRight).toBeCloseTo(worldInfo.cardRight, 0);
        }
        expect(list.headerHeight).toBeCloseTo(worldInfo.headerHeight, 0);
        expect(list.headerToHeadingText).toBeCloseTo(worldInfo.headerToHeadingText, 0);
        expect(list.bodyPadding).toBe(worldInfo.bodyPadding);
        expect(list.gutter).toBe('stable');
        expect(list.rowLeft).toBeCloseTo(worldInfo.rowLeft, 0);
        // The right inset is the reserved gutter, so it is the same whether or not the rows overflow.
        expect(list.rowRight).toBeCloseTo(worldInfo.rowRight, 0);
        expect(list.scrolls).toBe(agents === AGENT_COUNT);
    });

    test(`an open agent stands in the frame of an open World Info entry, ${name}`, async ({ page }) => {
        agentCount = agents;
        await page.setViewportSize({ width, height });
        await page.goto('/');
        await waitForAppReady(page, { timeout: 60000 });

        await openWorldInfoEntries(page, BOOK);
        await page.locator('#WorldInfo .sb-wi-row').first().click();
        await expect(page.locator('#WorldInfo .sb-wi-entry .sb-editor-header')).toBeVisible();
        const entry = await settledOpenFrame(page, '#WorldInfo .sb-wi-entry');
        await openAgentList(page);
        await page.locator('.ica-agents-editor [data-saved="true"]').first().click();
        await expect(page.locator('.ica-agents-editor .ica-agent-detail .sb-editor-header')).toBeVisible();
        const agent = await settledOpenFrame(page, '.ica-agents-editor .ica-agent-detail');

        expect(agent.headerTop).toBeCloseTo(entry.headerTop, 0);
        if (width > 768) {
            expect(agent.headerRight).toBeCloseTo(entry.headerRight, 0);
        }
        expect(agent.headerHeight).toBeCloseTo(entry.headerHeight, 0);
        expect(agent.detailBottom).toBeCloseTo(entry.detailBottom, 0);
    });
}
