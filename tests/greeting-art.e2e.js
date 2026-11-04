import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';
import { withoutAssistantAccount } from './helpers/assistant-library.js';
import { installFixtureChats } from './helpers/fixture-chats.js';
import { applyHomeTestSettings } from './helpers/getting-started-state.js';
import { assertIsolatedServer, protectMaintainerServer } from './helpers/maintainer-server.js';
import { sizeFreeTestFor } from './helpers/matrix.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';
import { OPENING_HOLD_MS } from '../public/scripts/sillybunny-home/greeting-art-opening.js';

/**
 * The greeting picture of the bundled assistants, in the real app against the cards that the server seeded. Nothing
 * here stubs the library. The picture is a file in `public/img/sillybunny/`; a spec does not need it to be there,
 * because the figure is sized from the registry before the file loads, but a run that looks at the picture does.
 */
test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 120_000 });

const STARTUP_TIMEOUT = 30_000;
const REPLY = 'A stubbed reply.';
const ALT = 'Early one evening, Reisen waves from her low desk among stacks of paperwork, tea and a mortar of herbs, while Tewi\'s ear peeks round the door.';
const ALT_TEWI = 'Late at night, Tewi rests her chin on her hands at the desk beside a newspaper and carrots, while Reisen sleeps over her papers under a blanket.';
const ENLARGE = 'Enlarge Picture';
const HEIGHT_SHARE = 0.7;
const MIN_FILL = 0.75;

const VIEWPORTS = [
    { name: 'desktop 1440x900', options: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone 390x844', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } },
];

const FIGURES = '#chat .sbGreetingArt';
const greetingOf = page => page.locator('#chat .mes[mesid="0"]');
const cardOf = (page, key) => page.locator(`#chat > .welcomePanel .sbHomeCard[data-sb-home-key="${key}"]`);
const HOME_WAYS = {
    'Start New Chat': card => card.locator('.sbHomeFootButton').nth(0),
    'the card button': card => card.locator('.sbHomeCardOpen'),
    'Temporary Chat': card => card.locator('.sbHomeFootButton').nth(1),
};

test.beforeEach(({ baseURL }) => {
    assertIsolatedServer(baseURL, 'Greeting art');
});

/**
 * Starts the app on Home with the cards that the server seeded. Chats are saved for real, so a spec can read a saved
 * chat back, and the model is a stub that records what it is asked.
 * @param {import('@playwright/test').Page} page
 * @param {{ lastMode?: 'roleplay' | 'conversation' }} [options]
 */
async function boot(page, { lastMode = 'roleplay' } = {}) {
    const world = { generations: [], saves: [], pictures: [] };

    page.on('request', (request) => {
        const { pathname } = new URL(request.url());
        if (pathname.startsWith('/img/sillybunny/greeting-')) world.pictures.push(pathname);
    });

    await protectMaintainerServer(page);
    await installFixtureChats(page);
    await page.route('**/api/settings/get', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        applyHomeTestSettings(settings);
        settings.accountStorage = { ...withoutAssistantAccount(settings.accountStorage), WelcomePage_LastMode: lastMode };
        return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
    });
    await page.route(/\/api\/chats\/save$/, (route) => {
        const request = route.request();
        const buffer = request.postDataBuffer();
        const body = request.headers()['content-encoding'] === 'gzip' ? gunzipSync(buffer) : buffer;
        world.saves.push(body.toString());
        return route.continue();
    });
    await page.route('**/api/backends/chat-completions/generate', (route) => {
        world.generations.push(route.request().postDataJSON());
        return route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }], model: 'qa-model' } });
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await testSetup.waitForAppReady({ page });
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on', { timeout: STARTUP_TIMEOUT });
    await expect(cardOf(page, 'assistant-reisen').locator('.sbHomeCardOpen')).toBeEnabled({ timeout: STARTUP_TIMEOUT });
    await page.evaluate(async () => {
        const { setOnlineStatus } = await import('/script.js');
        const { oai_settings } = await import('/scripts/openai.js');
        oai_settings.stream_openai = false;
        setOnlineStatus('Status check bypassed');
    });
    return world;
}

/**
 * Waits until nothing has been added to or removed from the chat for a while. Opening a chat prints it more than once, and
 * a test that goes on while it is printed again would hold an element that is about to be replaced.
 */
const settleChat = page => page.evaluate(() => new Promise((resolve) => {
    const chat = document.getElementById('chat');
    const QUIET_MS = 800;
    let timer = setTimeout(done, QUIET_MS);
    const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(done, QUIET_MS);
    });
    observer.observe(chat, { childList: true });
    function done() {
        observer.disconnect();
        resolve();
    }
}));

/** Opens a chat from a card on Home and waits for the greeting. */
async function openFromHome(page, key, way) {
    await HOME_WAYS[way](cardOf(page, key)).click();
    await expect(greetingOf(page)).toBeVisible({ timeout: STARTUP_TIMEOUT });
    await settleChat(page);
}

const waitForFrames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

/** Waits until the picture is above the greeting once, and stays once. */
async function expectOneFigure(page, { assistant = 'reisen' } = {}) {
    await expect(page.locator(FIGURES)).toHaveCount(1, { timeout: STARTUP_TIMEOUT });
    await waitForFrames(page);
    await expect(page.locator(FIGURES)).toHaveCount(1);

    const figure = page.locator(FIGURES);
    await expect(figure).toHaveAttribute('data-sb-greeting-art', assistant);
    await expect(figure.locator('img')).toHaveAttribute('src', new RegExp(`^/img/sillybunny/greeting-${assistant}(@2x)?\\.webp$`));
    const position = await figure.evaluate((node) => {
        const message = node.closest('.mes');
        const text = message.querySelector('.mes_text');
        return {
            mesid: message.getAttribute('mesid'),
            insideText: Boolean(node.closest('.mes_text')),
            parent: node.parentElement.className,
            above: Boolean(node.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING),
        };
    });
    expect(position).toEqual({ mesid: '0', insideText: false, parent: 'mes_block', above: true });
}

/** The size of the enlarged picture and of the room it had, in CSS pixels. */
const viewerRoom = viewer => viewer.evaluate((image) => {
    const body = image.closest('.sb-dialog__body');
    const style = getComputedStyle(body);
    return {
        column: body.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        boxHeight: window.innerHeight - 160,
        artWidth: Number(image.getAttribute('width')),
        artHeight: Number(image.getAttribute('height')),
        dpr: window.devicePixelRatio,
        width: image.getBoundingClientRect().width,
        src: image.getAttribute('src'),
        rendering: getComputedStyle(image).imageRendering,
    };
});

/** The size of the picture and of the room it had, in CSS pixels. */
const measure = page => page.evaluate(() => {
    const figure = document.querySelector('#chat .sbGreetingArt');
    const image = figure.querySelector('img');
    const style = getComputedStyle(figure);
    const box = image.getBoundingClientRect();
    return {
        column: figure.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        chatHeight: document.querySelector('#chat').clientHeight,
        width: box.width,
        height: box.height,
        artWidth: Number(image.getAttribute('width')),
        artHeight: Number(image.getAttribute('height')),
        dpr: window.devicePixelRatio,
        mode: figure.dataset.sbScale,
        step: figure.dataset.sbPixelStep,
        source: figure.dataset.sbSource,
        src: image.getAttribute('src'),
        rendering: getComputedStyle(image).imageRendering,
    };
});

/**
 * What the rule asks for in a room, worked out here from the rule and not from the page: the picture is fitted to the
 * column and 70% of the chat with its aspect kept; the largest whole step of that is drawn pixelated from the 1x file
 * when it fills at least 75% of the fitted width, and the fitted room is filled smoothly from the 2x file otherwise.
 */
function ruleFor({ column, boxHeight, artWidth, artHeight, dpr }) {
    const fittedWidth = Math.min(column, (boxHeight * artWidth) / artHeight);
    const step = Math.floor((fittedWidth / artWidth) * dpr + 1e-9);
    const stepped = (artWidth * step) / dpr;
    return step >= 1 && stepped >= fittedWidth * MIN_FILL - 1e-6
        ? { mode: 'pixel', step, source: '1x', width: stepped, height: (artHeight * step) / dpr }
        : { mode: 'smooth', step: null, source: '2x', width: fittedWidth, height: (fittedWidth * artHeight) / artWidth };
}

/** Whether a measurement is what the rule asks for, down to the file that the picture shows. */
function followsTheScale(m) {
    const rule = ruleFor({ ...m, boxHeight: m.chatHeight * HEIGHT_SHARE });
    const near = (actual, expected) => Math.abs(actual - expected) < 0.51;
    const file = rule.source === '2x' ? /@2x\.webp$/ : /greeting-[a-z]+\.webp$/;
    return m.mode === rule.mode && m.source === rule.source && m.step === (rule.step === null ? '' : String(rule.step))
        && m.rendering === (rule.mode === 'pixel' ? 'pixelated' : 'auto')
        && file.test(m.src) && near(m.width, rule.width) && near(m.height, rule.height);
}

const currentChat = page => page.evaluate(async () => (await import('/script.js')).getCurrentChatId());
const savedChat = page => page.evaluate(async () => {
    const script = await import('/script.js');
    const character = script.characters[script.this_chid];
    const response = await fetch('/api/chats/get', {
        method: 'POST',
        headers: script.getRequestHeaders(),
        body: JSON.stringify({ ch_name: character.name, file_name: script.getCurrentChatId(), avatar_url: character.avatar }),
    });
    return response.json();
});
const reloadChat = page => page.evaluate(async () => (await import('/script.js')).reloadCurrentChat());

async function sendMessage(page, text, expectedMessages) {
    await page.locator('#send_textarea').fill(text);
    await page.locator('#send_textarea').press('Enter');
    await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().chat.length), { timeout: 30_000 }).toBe(expectedMessages);
    await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().chat.at(-1)?.mes), { timeout: 30_000 }).toBe(REPLY);
}

for (const { name, options } of VIEWPORTS) {
    test.describe(`the greeting picture at ${name}`, () => {
        test.use(options);
        // Only the tests that read the size of the picture use `test`; the rest do not depend on the size.
        const sizeFreeTest = sizeFreeTestFor(test, options.viewport);

        for (const way of Object.keys(HOME_WAYS)) {
            sizeFreeTest(`shows once above the greeting of Reisen that ${way} opens, as a button named by its alt text`, async ({ page }) => {
                await boot(page);
                await openFromHome(page, 'assistant-reisen', way);

                await expectOneFigure(page);
                const open = page.locator(FIGURES).getByRole('button', { name: ENLARGE });
                await expect(open).toBeVisible();
                await expect(open).toHaveAttribute('aria-haspopup', 'dialog');
                await expect(page.locator(`${FIGURES} img`)).toHaveAttribute('alt', ALT);
                await expect(page.locator(`${FIGURES} img`)).not.toHaveAttribute('data-sb-copy-placeholder', /./);
                await expect(page.locator(FIGURES).getByRole('img', { name: ALT })).toHaveCount(1);
                await expect(page.locator(`${FIGURES} img`)).toHaveAttribute('decoding', 'async');
            });
        }

        sizeFreeTest('shows the picture of Tewi above her greeting', async ({ page }) => {
            await boot(page);
            await openFromHome(page, 'assistant-tewi', 'Start New Chat');

            await expectOneFigure(page, { assistant: 'tewi' });
            await expect(page.locator(`${FIGURES} img`)).toHaveAttribute('alt', ALT_TEWI);
            await expect(page.locator(FIGURES).getByRole('img', { name: ALT_TEWI })).toHaveCount(1);
        });

        test('is sized and drawn by the rule, from the one file that the rule needs', async ({ page }) => {
            const world = await boot(page);
            await openFromHome(page, 'assistant-reisen', 'Start New Chat');
            await expectOneFigure(page);

            const m = await measure(page);
            expect(followsTheScale(m), JSON.stringify(m)).toBe(true);
            expect(m.height).toBeLessThanOrEqual(m.chatHeight * HEIGHT_SHARE + 0.51);
            expect(m.width).toBeLessThanOrEqual(m.column + 0.51);
            expect([...new Set(world.pictures)]).toEqual([m.src]);
        });

        test('has the control radius of the app at every size, and no frame of its own', async ({ page }) => {
            await boot(page);
            await openFromHome(page, 'assistant-reisen', 'Start New Chat');
            await expectOneFigure(page);

            const look = await page.evaluate(() => {
                const open = document.querySelector('#chat .sbGreetingArtOpen');
                const image = open.querySelector('img');
                const edge = getComputedStyle(open, '::after');
                return {
                    token: getComputedStyle(document.documentElement).getPropertyValue('--sb-radius-control').trim(),
                    openRadius: getComputedStyle(open).borderRadius,
                    openBorder: getComputedStyle(open).borderTopWidth,
                    openPadding: getComputedStyle(open).paddingTop,
                    imageRadius: getComputedStyle(image).borderRadius,
                    imageBorder: getComputedStyle(image).borderTopWidth,
                    imagePadding: getComputedStyle(image).paddingTop,
                    hairline: edge.boxShadow,
                };
            });
            expect(look).toMatchObject({
                token: '9px',
                openRadius: '9px',
                openBorder: '0px',
                openPadding: '0px',
                imageRadius: '0px',
                imageBorder: '0px',
                imagePadding: '0px',
            });
            expect(look.hairline).toMatch(/ 0px 0px 0px 1px inset$/);
        });

        test('keeps its place and its size through a reload of the chat, an edit of the greeting, and a swipe away and back', async ({ page }) => {
            await boot(page);
            await openFromHome(page, 'assistant-reisen', 'Start New Chat');
            await expectOneFigure(page);
            const before = await measure(page);

            await reloadChat(page);
            await expect(greetingOf(page)).toBeVisible();
            await expectOneFigure(page);
            expect(await measure(page)).toEqual(before);

            const message = greetingOf(page);
            await message.hover();
            await message.locator('.mes_edit').click();
            await message.locator('textarea.edit_textarea').fill('An edited greeting.');
            await expect(page.locator(FIGURES)).toHaveCount(1);
            await message.locator('.mes_edit_done').click();
            await expect(message.locator('.mes_text')).toContainText('An edited greeting.');
            await expectOneFigure(page);

            await message.hover();
            await message.locator('.swipe_right').click();
            await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().chat[0].mes), { timeout: 30_000 }).toBe(REPLY);
            await expect(page.locator('#send_but')).toBeVisible();
            await expect(page.locator(FIGURES)).toHaveCount(0);
            expect(await page.evaluate(() => window.SillyTavern.getContext().chat[0].swipe_id)).toBe(1);
            await message.hover();
            await message.locator('.swipe_left').click();
            await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().chat[0].swipe_id)).toBe(0);
            await expectOneFigure(page);
            await expect(message.locator('.mes_text')).toContainText('An edited greeting.');
        });

        sizeFreeTest('comes back when the chat is opened again after the page reloads', async ({ page }) => {
            await boot(page);
            await openFromHome(page, 'assistant-reisen', 'Start New Chat');
            await expectOneFigure(page);
            const saved = page.waitForResponse(response => /\/api\/chats\/save$/.test(response.url()) && response.ok());
            await sendMessage(page, 'Hello there', 3);
            const file = await currentChat(page);
            await saved;

            await page.reload({ waitUntil: 'domcontentloaded' });
            await testSetup.waitForAppReady({ page });
            await page.evaluate(async (chatFile) => {
                const script = await import('/script.js');
                const id = script.characters.findIndex(character => character.avatar === 'default_AssistantReisen.png');
                await script.selectCharacterById(id, { switchMenu: false });
                await script.openCharacterChat(chatFile);
            }, file);

            await expect(greetingOf(page)).toBeVisible({ timeout: STARTUP_TIMEOUT });
            await expectOneFigure(page);
            await expect(page.locator('#chat .mes')).toHaveCount(3);
        });

        sizeFreeTest('is on no later message, not in a chat of another character, and not left behind when the character changes', async ({ page }) => {
            await boot(page);
            await openFromHome(page, 'assistant-reisen', 'Start New Chat');
            await expectOneFigure(page);

            await sendMessage(page, 'Hello there', 3);
            await expect(page.locator('#chat .mes')).toHaveCount(3);
            await expect(page.locator(FIGURES)).toHaveCount(1);
            for (const id of [1, 2]) {
                await expect(page.locator(`#chat .mes[mesid="${id}"] .sbGreetingArt`)).toHaveCount(0);
            }

            await page.evaluate(async () => {
                const script = await import('/script.js');
                const id = script.characters.findIndex(character => character.avatar === 'default_Seraphina.png');
                await script.selectCharacterById(id, { switchMenu: false });
            });
            await expect(greetingOf(page)).toBeVisible({ timeout: STARTUP_TIMEOUT });
            await expect(greetingOf(page).locator('.name_text')).toHaveText('Seraphina');
            await waitForFrames(page);
            await expect(page.locator(FIGURES)).toHaveCount(0);

            await page.evaluate(async () => {
                const script = await import('/script.js');
                const id = script.characters.findIndex(character => character.avatar === 'default_AssistantTewi.png');
                await script.selectCharacterById(id, { switchMenu: false });
            });
            await expectOneFigure(page, { assistant: 'tewi' });
        });

        sizeFreeTest('is not shown in Conversation', async ({ page }) => {
            await boot(page, { lastMode: 'conversation' });
            await cardOf(page, 'assistant-reisen').locator('.sbHomeFootButton').nth(0).click();

            await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-mode', 'on', { timeout: STARTUP_TIMEOUT });
            await waitForFrames(page);
            await expect(page.locator(FIGURES)).toHaveCount(0);
            await expect(page.locator('#sheld .sbGreetingArt')).toHaveCount(0);
        });

        sizeFreeTest('goes in Conversation over the same chat, and comes back when the app returns to Roleplay', async ({ page }) => {
            await boot(page);
            await openFromHome(page, 'assistant-reisen', 'Start New Chat');
            await expectOneFigure(page);

            await page.locator('#sb-mode-toggle').click();
            await page.getByRole('menuitemradio', { name: /Conversation/ }).click();
            await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-mode', 'on', { timeout: STARTUP_TIMEOUT });
            await expect(page.locator(FIGURES)).toHaveCount(0);

            await page.locator('#sb-topbar-title').click();
            await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-conversation-mode', 'on');
            await expectOneFigure(page);
        });

        sizeFreeTest('never reaches the model, and never reaches the chat file', async ({ page }) => {
            const world = await boot(page);
            await openFromHome(page, 'assistant-reisen', 'Start New Chat');
            await expectOneFigure(page);
            const greeting = await page.evaluate(() => window.SillyTavern.getContext().chat[0]);

            const chatSaved = page.waitForResponse(response => /\/api\/chats\/save$/.test(response.url()) && response.ok());
            await sendMessage(page, 'Hello there', 3);
            await chatSaved;

            expect(world.generations).toHaveLength(1);
            const request = JSON.stringify(world.generations[0]);
            expect(request).not.toContain('greeting-');
            expect(request).not.toContain('sillybunny/');
            expect(request).toContain('I will be your SillyBunny assistant');
            for (const message of world.generations[0].messages) {
                const types = [message.content].flat().map(part => part?.type ?? 'text');
                expect(types, JSON.stringify(message)).not.toContain('image_url');
                expect(types).not.toContain('image');
            }

            const [, saved] = await savedChat(page);
            expect(saved.mes).toBe(greeting.mes);
            expect(saved.extra ?? {}).toEqual(greeting.extra ?? {});
            expect(JSON.stringify(await savedChat(page))).not.toContain('greeting-');
            expect(world.saves.length).toBeGreaterThan(0);
            expect(world.saves.join('')).not.toContain('greeting-');
        });

        test('opens larger by mouse and by keyboard, and closes by mouse and by keyboard', async ({ page }) => {
            await boot(page);
            await openFromHome(page, 'assistant-reisen', 'Start New Chat');
            await expectOneFigure(page);
            const open = page.locator(FIGURES).getByRole('button', { name: ENLARGE });
            const viewer = page.locator('dialog.sb-dialog-host:not([closing]) .sbGreetingArtLarge');

            await open.click();
            await expect(viewer).toBeVisible();
            await expect(viewer).toHaveAttribute('alt', ALT);
            const dialog = page.locator('dialog.sb-dialog-host:not([closing])');
            const title = dialog.getByRole('heading', { name: 'Reisen' });
            await expect(title).toBeVisible();
            await expect(title).not.toHaveAttribute('data-sb-copy-slot', /./);
            const room = await viewerRoom(viewer);
            const rule = ruleFor(room);
            expect(room.src).toMatch(rule.source === '2x' ? /@2x\.webp$/ : /greeting-reisen\.webp$/);
            expect(room.rendering).toBe(rule.mode === 'pixel' ? 'pixelated' : 'auto');
            expect(Math.abs(room.width - rule.width)).toBeLessThan(0.51);
            await page.locator('dialog.sb-dialog-host:not([closing])').getByRole('button', { name: /close/i }).click();
            await expect(viewer).toHaveCount(0);
            await expect(open).toBeFocused();

            await page.keyboard.press('Enter');
            await expect(viewer).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(viewer).toHaveCount(0);
            await expect(open).toBeFocused();

            await page.keyboard.press('Space');
            await expect(viewer).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(viewer).toHaveCount(0);
        });

        test('sizes the enlarged picture again when the window is resized while it is open', async ({ page }) => {
            await boot(page);
            await openFromHome(page, 'assistant-reisen', 'Start New Chat');
            await expectOneFigure(page);
            const viewer = page.locator('dialog.sb-dialog-host:not([closing]) .sbGreetingArtLarge');
            await page.locator(`${FIGURES} .sbGreetingArtOpen`).click();
            await expect(viewer).toBeVisible();
            const before = await viewerRoom(viewer);

            // Only the height changes, because the width of the window is what the CSS of the picture follows by itself.
            await page.setViewportSize({ width: page.viewportSize().width, height: 320 });
            await expect.poll(async () => {
                const room = await viewerRoom(viewer);
                return Math.abs(room.width - ruleFor(room).width) < 0.51 && room.width !== before.width;
            }, { timeout: 10_000 }).toBe(true);
        });

        sizeFreeTest('is reached by the Tab key and shows the focus ring of the app when it is', async ({ page }) => {
            await boot(page);
            await openFromHome(page, 'assistant-reisen', 'Start New Chat');
            await expectOneFigure(page);
            const open = page.locator(`${FIGURES} .sbGreetingArtOpen`);
            await page.evaluate(() => document.activeElement?.blur());

            const ring = () => open.evaluate(node => getComputedStyle(node, '::after').boxShadow);
            const hairline = await ring();
            await open.evaluate((node) => {
                const tabbable = [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')]
                    .filter(element => element.tabIndex >= 0 && !element.disabled && element.checkVisibility());
                tabbable[tabbable.indexOf(node) - 1].focus();
            });
            await page.keyboard.press('Tab');
            await expect(open).toBeFocused();
            const focused = await ring();
            expect(focused).not.toBe(hairline);
            expect(focused).toMatch(/inset/);
            expect(focused).toMatch(/0px 0px 0px 2px/);
        });
    });
}

test.describe('the size of the picture follows its room', () => {
    test.use({ viewport: { width: 1800, height: 1100 } });

    test('is chosen again when the window is resized, and the file follows the rule', async ({ page }) => {
        const world = await boot(page);
        await openFromHome(page, 'assistant-reisen', 'Start New Chat');
        await expectOneFigure(page);
        const wide = await measure(page);
        expect(followsTheScale(wide), JSON.stringify(wide)).toBe(true);
        expect(wide).toMatchObject({ mode: 'pixel', source: '1x', step: '1' });
        expect([...new Set(world.pictures)]).toEqual([wide.src]);

        await page.setViewportSize({ width: 1440, height: 900 });
        await expect.poll(async () => followsTheScale(await measure(page)), { timeout: 10_000 }).toBe(true);
        const laptop = await measure(page);
        expect(laptop).toMatchObject({ mode: 'smooth', source: '2x', rendering: 'auto' });
        expect(laptop.src).toMatch(/@2x\.webp$/);
        expect(laptop.chatHeight).toBeLessThan(wide.chatHeight);
        expect(laptop.width).toBeLessThanOrEqual(laptop.column + 0.51);

        await page.setViewportSize({ width: 700, height: 420 });
        await expect.poll(async () => followsTheScale(await measure(page)), { timeout: 10_000 }).toBe(true);
        const small = await measure(page);
        expect(small.height).toBeLessThanOrEqual(small.chatHeight * HEIGHT_SHARE + 0.51);

        await page.setViewportSize({ width: 1800, height: 1100 });
        await expect.poll(async () => followsTheScale(await measure(page)), { timeout: 10_000 }).toBe(true);
        expect(await measure(page)).toEqual(wide);
        expect([...new Set(world.pictures)].sort()).toEqual([wide.src, laptop.src].sort());
    });

    test('keeps its size when only the height of the chat changes, as it does when a person types', async ({ page }) => {
        await boot(page);
        await openFromHome(page, 'assistant-reisen', 'Start New Chat');
        await expectOneFigure(page);
        const before = await measure(page);
        const settled = { width: before.width, height: before.height, mode: before.mode, src: before.src };

        await page.locator('#send_textarea').fill(Array.from({ length: 12 }, (_, line) => `Line ${line}`).join('\n'));
        await expect.poll(async () => (await measure(page)).chatHeight, { timeout: 10_000 }).toBeLessThan(before.chatHeight);
        expect(await measure(page)).toMatchObject(settled);

        await page.locator('#send_textarea').fill('');
        await page.setViewportSize({ width: 1800, height: 800 });
        await expect.poll(async () => (await measure(page)).chatHeight, { timeout: 10_000 }).toBeLessThan(before.chatHeight);
        expect(await measure(page)).toMatchObject(settled);
    });

    // The query for a fractional ratio can be one that never reports a change, so the window's own resize has to do it.
    test('is chosen again on a window resize when the pixel ratio changed and its media query said nothing', async ({ page }) => {
        await page.addInitScript(() => {
            const original = window.matchMedia.bind(window);
            window.matchMedia = query => (/resolution/.test(query)
                ? { matches: false, media: query, addEventListener() {}, removeEventListener() {} }
                : original(query));
        });
        await boot(page);
        await openFromHome(page, 'assistant-reisen', 'Start New Chat');
        await expectOneFigure(page);
        const initial = await measure(page);
        expect(initial).toMatchObject({ mode: 'pixel', step: '1' });

        const session = await page.context().newCDPSession(page);
        await session.send('Emulation.setDeviceMetricsOverride', { width: 1800, height: 1100, deviceScaleFactor: 2, mobile: false });
        await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBe(2);
        await page.evaluate(() => window.dispatchEvent(new Event('resize')));

        await expect.poll(async () => followsTheScale(await measure(page)), { timeout: 10_000 }).toBe(true);
        expect(Number((await measure(page)).step)).toBeGreaterThan(Number(initial.step));
    });

    // Emulating a pixel ratio does not make Chromium report that the resolution query changed unless the window also
    // changes size, which is what moving a window to another screen does not do. The spec changes the ratio by emulation
    // and reports the change itself, on the lists that the page asked for, so what it proves is how the page answers.
    test('is chosen again when the pixel ratio changes, and keeps listening for the next change', async ({ page }) => {
        await page.addInitScript(() => {
            const original = window.matchMedia.bind(window);
            window.qaResolutionLists = [];
            window.matchMedia = (query) => {
                const list = original(query);
                if (/resolution/.test(query)) window.qaResolutionLists.push(list);
                return list;
            };
        });
        await boot(page);
        await openFromHome(page, 'assistant-reisen', 'Start New Chat');
        await expectOneFigure(page);
        const initial = await measure(page);
        expect(initial).toMatchObject({ mode: 'pixel', step: '1' });
        const session = await page.context().newCDPSession(page);

        for (const deviceScaleFactor of [2, 3]) {
            const listsBefore = await page.evaluate(() => window.qaResolutionLists.length);
            await session.send('Emulation.setDeviceMetricsOverride', { width: 1800, height: 1100, deviceScaleFactor, mobile: false });
            await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBe(deviceScaleFactor);
            await page.evaluate(() => {
                for (const list of [...window.qaResolutionLists]) list.dispatchEvent(new MediaQueryListEvent('change', { media: list.media, matches: false }));
            });

            await expect.poll(async () => followsTheScale(await measure(page)), { timeout: 10_000 }).toBe(true);
            const m = await measure(page);
            expect(Number(m.step), `at ${deviceScaleFactor} device pixels per CSS pixel`).toBeGreaterThan(Number(initial.step));
            expect(await page.evaluate(() => window.qaResolutionLists.length), 'listens for the ratio it has now').toBeGreaterThan(listsBefore);
        }
    });

    test('fills the small chat of Visual Novel mode smoothly from the 2x file', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await boot(page);
        await openFromHome(page, 'assistant-reisen', 'Start New Chat');
        await expectOneFigure(page);
        await page.evaluate(() => {
            const toggle = document.querySelector('#waifuMode');
            toggle.checked = true;
            toggle.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await expect(page.locator('body')).toHaveClass(/waifuMode/);

        await expect.poll(async () => followsTheScale(await measure(page)), { timeout: 10_000 }).toBe(true);
        const m = await measure(page);
        expect(m.chatHeight).toBeLessThan(300);
        expect(m).toMatchObject({ mode: 'smooth', source: '2x', rendering: 'auto' });
        expect(m.src).toMatch(/@2x\.webp$/);
        expect(m.height).toBeLessThanOrEqual(m.chatHeight * HEIGHT_SHARE + 0.51);
    });
});

/** Where `#chat` is scrolled, and whether the top of the greeting can be seen. */
const viewOf = page => page.evaluate(async () => {
    const chat = document.getElementById('chat');
    const box = chat.getBoundingClientRect();
    const rectOf = selector => chat.querySelector(selector)?.getBoundingClientRect();
    const name = rectOf('.mes[mesid="0"] .ch_name');
    const picture = rectOf('.sbGreetingArt');
    return {
        top: chat.scrollTop,
        max: chat.scrollHeight - chat.clientHeight,
        nameRowInView: Boolean(name) && name.top >= box.top && name.bottom <= box.bottom,
        pictureTopInView: Boolean(picture) && picture.top >= box.top && picture.top < box.bottom,
        holding: (await import('/scripts/sillybunny-home/greeting-art-opening.js')).shouldHoldChatAtTop(),
        sinceWatch: performance.now() - (window.qaWatch?.start ?? 0),
    };
});
const isAtBottom = view => view.max > 0 && Math.abs(view.max - view.top) <= 2;

/**
 * Records the scroll position of every frame in which the chat holds only its greeting, from the moment it is called.
 * Starting a new chat first shows the last chat of the character for a moment, and that one is no concern of the hold.
 */
const watchFrames = page => page.evaluate(() => {
    const watch = { start: performance.now(), painted: [] };
    window.qaWatch = watch;
    const chat = document.getElementById('chat');
    const record = () => {
        if (chat.querySelector('.mes') && window.SillyTavern.getContext().chat.length === 1) watch.painted.push(chat.scrollTop);
        requestAnimationFrame(record);
    };
    requestAnimationFrame(record);
});

/** The hold ends a full hold time after the last sign that the chat is opening, and the app's late scrolls come before that. */
async function waitUntilHoldIsOver(page) {
    await expect.poll(async () => (await viewOf(page)).sinceWatch, { timeout: 15_000 }).toBeGreaterThan(OPENING_HOLD_MS + 500);
    await expect.poll(async () => (await viewOf(page)).holding, { timeout: 15_000 }).toBe(false);
}

/** Opens a chat from Home with the frames watched, and waits for the picture. */
async function openWatched(page, way = 'Start New Chat') {
    await boot(page);
    await watchFrames(page);
    await openFromHome(page, 'assistant-reisen', way);
    await expectOneFigure(page);
}

test.describe('a chat that holds only the greeting, on desktop 1440x900', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    for (const way of ['Start New Chat', 'Temporary Chat']) {
        test(`opens at its top when ${way} opens it, and no frame is painted anywhere else`, async ({ page }) => {
            await openWatched(page, way);

            const opened = await viewOf(page);
            expect(opened.max, 'the greeting has to overflow, or there is nothing to hold').toBeGreaterThan(0);
            expect(opened).toMatchObject({ top: 0, nameRowInView: true, pictureTopInView: true });

            await waitUntilHoldIsOver(page);
            expect(await viewOf(page)).toMatchObject({ top: 0, nameRowInView: true, pictureTopInView: true, holding: false });
            const painted = await page.evaluate(() => window.qaWatch.painted);
            expect(painted.length).toBeGreaterThan(30);
            expect([...new Set(painted)]).toEqual([0]);
        });
    }

    test('goes to the bottom as usual when a message is sent while the chat is still held', async ({ page }) => {
        await openWatched(page);
        const held = await viewOf(page);
        expect(held.sinceWatch, 'the message has to be sent inside the hold').toBeLessThan(OPENING_HOLD_MS - 300);
        expect(held).toMatchObject({ top: 0, holding: true });

        await sendMessage(page, 'Hello there', 3);
        await expect.poll(async () => isAtBottom(await viewOf(page)), { timeout: 10_000 }).toBe(true);
        await waitUntilHoldIsOver(page);
        expect(isAtBottom(await viewOf(page))).toBe(true);
    });

    test('goes to the bottom as usual when a message is sent after the hold', async ({ page }) => {
        await openWatched(page);
        await waitUntilHoldIsOver(page);

        await sendMessage(page, 'Hello there', 3);
        await expect.poll(async () => isAtBottom(await viewOf(page)), { timeout: 10_000 }).toBe(true);
    });

    test('opens at the bottom when the chat holds more than the greeting', async ({ page }) => {
        await openWatched(page);
        const saved = page.waitForResponse(response => /\/api\/chats\/save$/.test(response.url()) && response.ok());
        await sendMessage(page, 'Hello there', 3);
        const file = await currentChat(page);
        await saved;

        await page.reload({ waitUntil: 'domcontentloaded' });
        await testSetup.waitForAppReady({ page });
        await page.evaluate(async (chatFile) => {
            const script = await import('/script.js');
            const id = script.characters.findIndex(character => character.avatar === 'default_AssistantReisen.png');
            await script.selectCharacterById(id, { switchMenu: false });
            await script.openCharacterChat(chatFile);
        }, file);
        await expect(greetingOf(page)).toBeVisible({ timeout: STARTUP_TIMEOUT });
        await expect(page.locator('#chat .mes')).toHaveCount(3);
        await settleChat(page);

        await expect.poll(async () => isAtBottom(await viewOf(page)), { timeout: 10_000 }).toBe(true);
        expect((await viewOf(page)).holding).toBe(false);
    });

    for (const [gesture, scrollBy] of [
        ['wheel', async page => page.mouse.wheel(0, 120)],
        ['key', async page => page.keyboard.press('PageDown')],
    ]) {
        test(`stays where a person has scrolled it with the ${gesture}`, async ({ page }) => {
            await openWatched(page);
            expect((await viewOf(page)).holding).toBe(true);
            await page.evaluate(() => document.activeElement?.blur());
            await page.mouse.move(720, 450);

            await scrollBy(page);
            await expect.poll(async () => (await viewOf(page)).top, { timeout: 10_000 }).toBeGreaterThan(0);
            await waitUntilHoldIsOver(page);
            const scrolled = await viewOf(page);
            expect(scrolled.holding).toBe(false);
            expect(scrolled.top).toBeGreaterThan(0);
            await expect.poll(async () => (await viewOf(page)).top, { timeout: 5_000 }).toBe(scrolled.top);
        });
    }

    for (const [way, press] of [
        ['mouse', async button => button.click()],
        ['keyboard', async (button, page) => {
            await button.focus();
            await page.keyboard.press('Enter');
        }],
    ]) {
        test(`ends the hold and goes to the bottom when the Go to bottom button is used by ${way}`, async ({ page }) => {
            await openWatched(page);
            expect(await viewOf(page)).toMatchObject({ top: 0, holding: true });

            await press(page.getByRole('button', { name: 'Go to bottom of chat' }), page);
            await expect.poll(async () => isAtBottom(await viewOf(page)), { timeout: 10_000 }).toBe(true);
            expect((await viewOf(page)).holding).toBe(false);
        });
    }

    test('does not take the chat back to the top when it is printed again later', async ({ page }) => {
        await openWatched(page);
        await waitUntilHoldIsOver(page);

        await page.evaluate(async () => {
            const chat = document.getElementById('chat');
            chat.scrollTop = chat.scrollHeight;
            await (await import('/script.js')).printMessages();
        });
        await expect(page.locator(FIGURES)).toHaveCount(1);
        await settleChat(page);
        await expect.poll(async () => isAtBottom(await viewOf(page)), { timeout: 10_000 }).toBe(true);
        expect((await viewOf(page)).holding).toBe(false);
    });

    test.describe('in a window tall enough for the whole greeting', () => {
        test.use({ viewport: { width: 1440, height: 1800 } });

        test('has nothing to hold', async ({ page }) => {
            await openWatched(page);

            expect(await viewOf(page)).toMatchObject({ top: 0, max: 0, holding: false });
        });
    });
});

test.describe('a chat that holds only the greeting, on a phone', () => {
    test.use(VIEWPORTS[1].options);

    test('is shown whole as it was, with nothing held', async ({ page }) => {
        await openWatched(page);
        expect(await viewOf(page)).toMatchObject({ top: 0, max: 0, nameRowInView: true, pictureTopInView: true, holding: false });

        await waitUntilHoldIsOver(page);
        expect(await viewOf(page)).toMatchObject({ top: 0, max: 0, holding: false });
    });
});
