import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { PINNED_ASSISTANT_ACCOUNT, REISEN_AVATAR, stubAssistantCards, TEWI_AVATAR } from './helpers/assistant-library.js';
import { installFixtureChats, pickFixtureCharacters } from './helpers/fixture-chats.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const STARTUP_TIMEOUT = 45_000;
const PANEL = '#chat > .welcomePanel';
const RECENT_COUNT = 8;

/**
 * Every pressable surface of Home. `surface` is the element that paints the fill and `target` is where the pointer
 * goes, which differs for the cards and the rows because their own button is laid over them.
 */
const SURFACES = [
    { name: 'a tile', surface: '.sbHomeTile', hover: '--sb-home-tint-hover' },
    { name: 'an assistant card', surface: '.sbHomeCard:not(.sbHomeCard--choose)', target: '.sbHomeCardOpen', hover: '--sb-home-tint-hover' },
    { name: 'Choose Assistant', surface: '.sbHomeCard--choose', target: '.sbHomeCardOpen', hover: '--sb-home-tint-hover' },
    { name: 'a footer button of a card', surface: '.sbHomeFootButton', hover: '--sb-flat-hover-bg' },
    { name: 'the menu button of a card', surface: '.sbHomeCardFooter .sbHomeRowMenu', hover: '--sb-flat-hover-bg' },
    { name: 'the main menu button', surface: '.sbHomeMenuButton', hover: '--sb-flat-hover-bg' },
    { name: 'a Recent Chats row', surface: '.welcomeRecent .recentChat:not(.hidden)', target: '.recentChatOpen', hover: '--sb-flat-hover-bg' },
    { name: 'the pin button of a Recent Chats row', surface: '.welcomeRecent .recentChat:not(.hidden) .chatActions .pinChat', hover: '--sb-flat-hover-bg' },
    { name: 'the menu button of a Recent Chats row', surface: '.welcomeRecent .recentChat:not(.hidden) .chatActions .chatMenu', hover: '--sb-flat-hover-bg' },
    { name: 'Show More in Recent Chats', surface: '.welcomeRecent .showMoreChats', hover: '--sb-flat-hover-bg' },
    { name: 'a filter of Recent Chats', surface: '.welcomeRecentTab:not(.active)', hover: '--sb-flat-hover-bg' },
];

function recentChatEntries(characters) {
    return Array.from({ length: RECENT_COUNT }, (_, index) => {
        const character = characters[index % characters.length];
        return {
            file_name: `qa-home-${index}.jsonl`,
            avatar: character.avatar,
            last_mes: Date.now() - index * 60_000,
            mes: `Preview ${index}`,
            chat_items: 3,
            file_size: '1kb',
        };
    });
}

/** The colour a custom property of Home paints, read the way the browser resolves it for a background. */
async function paintOf(page, property) {
    return page.locator(`${PANEL} .sbHomeLayout`).evaluate((layout, name) => {
        const probe = document.createElement('div');
        probe.style.background = `var(${name})`;
        layout.append(probe);
        const { backgroundColor } = getComputedStyle(probe);
        probe.remove();
        return backgroundColor;
    }, property);
}

const fillOf = locator => locator.evaluate(node => getComputedStyle(node).backgroundColor);

async function pointerTarget(element, target) {
    await element.scrollIntoViewIfNeeded();
    return (target ? element.locator(target) : element).boundingBox();
}

async function moveOnto(page, element, target) {
    const box = await pointerTarget(element, target);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

/** Holds the mouse button down on the target while `during` runs. Releasing away from the control keeps the press from becoming a click. */
async function pressAndHold(page, element, target, during) {
    await moveOnto(page, element, target);
    await page.mouse.down();
    try {
        await during();
    } finally {
        await page.mouse.move(0, 0);
        await page.mouse.up();
    }
}

test.describe('Pressing a surface of Home', () => {
    test.beforeEach(async ({ page }) => {
        await protectMaintainerServer(page);
        await installFixtureChats(page, { accountStorage: PINNED_ASSISTANT_ACCOUNT });
        // A card without a file has no menu button, so the surfaces below need cards that have one whatever the data root holds.
        await stubAssistantCards(page, [REISEN_AVATAR, TEWI_AVATAR]);
        await openQuietChatForSmoke(page, { selectCharacter: false });
        const characters = await pickFixtureCharacters(page, 3);
        await page.route('**/api/chats/recent', route => route.fulfill({ json: recentChatEntries(characters) }));
        await page.evaluate(async () => {
            const { openWelcomeScreen } = await import('/scripts/welcome-screen.js');
            await openWelcomeScreen({ force: true });
        });
        await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on', { timeout: STARTUP_TIMEOUT });
        await expect(page.locator(`${PANEL} .recentChat`)).not.toHaveCount(0);
    });

    for (const { name, surface, target, hover } of SURFACES) {
        test(`shows the pressed fill on ${name}, not the hover fill`, async ({ page }) => {
            const element = page.locator(`${PANEL} ${surface}`).first();
            const hoverFill = await paintOf(page, hover);
            const pressedFill = await paintOf(page, '--sb-flat-active-bg');
            expect(hoverFill, 'the hover and pressed fills are two different colours').not.toBe(pressedFill);

            await moveOnto(page, element, target);
            await expect.poll(() => fillOf(element), { message: 'the hover fill' }).toBe(hoverFill);

            await pressAndHold(page, element, target, async () => {
                await expect.poll(() => fillOf(element), { message: 'the fill while pressed' }).toBe(pressedFill);
            });
        });
    }

    for (const button of ['.pinChat', '.chatMenu']) {
        test(`pressing ${button} in a Recent Chats row leaves the row at its hover fill`, async ({ page }) => {
            const row = page.locator(`${PANEL} .welcomeRecent .recentChat:not(.hidden)`).first();
            const element = row.locator(button);
            const hoverFill = await paintOf(page, '--sb-flat-hover-bg');

            await pressAndHold(page, element, undefined, async () => {
                await expect.poll(() => fillOf(row), { message: 'the row while its button is pressed' }).toBe(hoverFill);
            });
        });
    }
});
