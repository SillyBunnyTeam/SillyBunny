import { expect, test } from '@playwright/test';
import { openDetailsApp, seedAndOpen } from './helpers/conversation-details.js';

/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- Whether the picture covers the avatar that opened it depends on the width. */

// One avatar viewer serves roleplay and conversation mode: the same window, in the same place, under the same key, so that a
// position that Moving UI saved in one mode is the position in the other.
test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 120_000 });

const ZOOMED = '.zoomed_avatar[forChar]';
const ROLEPLAY_AVATAR = '#chat .mes[is_user="false"] .avatar';
const CONVERSATION_AVATAR = '#sb_conversation_timeline .sb-conversation-message-avatar[data-sb-conversation-action="zoom-avatar"]';
const HEADER_AVATAR = '#sb_conversation_header [data-sb-conversation-action="zoom-avatar"]';

/** What roleplay has always called the zoomed avatar of a card: the file name without its extension. */
const keyOf = avatar => avatar.replace('.png', '');

const TALK = [
    { id: 'm-1', role: 'character', name: 'Character', mes: 'Good morning!' },
    { id: 'm-2', role: 'user', name: 'Tester', mes: 'Morning. Look at this.' },
    { id: 'm-3', role: 'character', name: 'Character', mes: 'Noon on Saturday, at the old oak.' },
];

/** Boots the app with its own persona and returns the library: Seraphina, who greets in roleplay, and two other characters. */
async function boot(page) {
    // The chat that roleplay starts for Seraphina would be written to the shared server.
    await page.route('**/api/chats/save', route => route.fulfill({ status: 200, json: {} }));
    const { avatars, names } = await openDetailsApp(page);
    const seraphina = avatars.find(avatar => /Seraphina/.test(names[avatar]));
    expect(seraphina, 'the library has Seraphina').toBeTruthy();
    const others = avatars.filter(avatar => avatar !== seraphina);
    return { seraphina, others, names };
}

async function openRoleplayChat(page, avatar) {
    await page.evaluate(async (avatar) => {
        const context = window.SillyTavern.getContext();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, avatar);
    const decline = page.locator('.popup-button-cancel:visible').first();
    if (await decline.isVisible().catch(() => false)) {
        await decline.click();
    }
    await expect(page.locator(ROLEPLAY_AVATAR).first()).toBeVisible({ timeout: 15_000 });
}

async function leaveConversation(page) {
    await page.evaluate(async () => {
        const { disableConversationModeForCurrentCharacter } = await import('/scripts/sillybunny-conversation/chrome.js');
        disableConversationModeForCurrentCharacter({ focusRoleplay: false });
    });
    await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-conversation-mode', 'on');
}

/** Presses the avatar and waits until its picture has loaded and the window has faded in; the pointer then rests away from it. */
async function open(page, trigger) {
    await trigger.click();
    await expect(page.locator(ZOOMED)).toHaveCount(1);
    await page.waitForFunction(() => {
        const zoomed = document.querySelector('.zoomed_avatar[forChar]');
        const image = zoomed?.querySelector('img');
        return Boolean(image?.complete && image.naturalWidth > 0) && getComputedStyle(zoomed).opacity === '1';
    });
    await page.mouse.move(1, 1);
}

const read = page => page.evaluate(() => {
    const zoomed = document.querySelector('.zoomed_avatar[forChar]');
    const { left, top, width, height } = zoomed.getBoundingClientRect();
    return {
        id: zoomed.id,
        key: zoomed.getAttribute('forChar'),
        src: zoomed.querySelector('img').getAttribute('src'),
        classes: [...zoomed.classList].sort(),
        left,
        top,
        width,
        height,
        topBarBottom: document.getElementById('top-bar').getBoundingClientRect().bottom,
        viewport: { width: innerWidth, height: innerHeight },
    };
});

function expectSamePlace(actual, expected) {
    for (const edge of ['left', 'top', 'width', 'height']) {
        expect(actual[edge], `${edge} of the window`).toBeCloseTo(expected[edge], 0);
    }
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test.describe(`${viewport.width}x${viewport.height}`, () => {
        test.use({ viewport });

        test('the same character opens in the same place, under the same key, in roleplay and in conversation mode', async ({ page }) => {
            const { seraphina } = await boot(page);
            await openRoleplayChat(page, seraphina);
            await open(page, page.locator(ROLEPLAY_AVATAR).first());
            const inRoleplay = await read(page);

            expect(inRoleplay.id).toBe(`zoomFor_${keyOf(seraphina)}`);
            expect(inRoleplay.top, 'the window lies under the top bar').toBeGreaterThanOrEqual(inRoleplay.topBarBottom - 1);
            expect(inRoleplay.top + inRoleplay.height, 'the window lies in the page').toBeLessThanOrEqual(inRoleplay.viewport.height + 1);
            await page.locator(`${ZOOMED} .dragClose`).click();
            await expect(page.locator(ZOOMED)).toHaveCount(0);

            await seedAndOpen(page, { avatar: seraphina, chats: [{ name: 'Main', messages: TALK }] });
            await open(page, page.locator(CONVERSATION_AVATAR).first());
            const inConversation = await read(page);

            expect(inConversation.id).toBe(inRoleplay.id);
            expect(inConversation.key).toBe(inRoleplay.key);
            expect(inConversation.src).toBe(inRoleplay.src);
            expect(inConversation.classes, 'the window has no class of its own in conversation mode').toEqual(inRoleplay.classes);
            expectSamePlace(inConversation, inRoleplay);
        });

        test('Close, Escape and, where the picture leaves the avatar uncovered, a second press close it, in roleplay and in conversation mode', async ({ page }) => {
            const { seraphina } = await boot(page);
            await openRoleplayChat(page, seraphina);
            const zoomed = page.locator(ZOOMED);
            // Up to 1024px wide the picture is centred over the page, and covers the avatar that opened it.
            const coversItsAvatar = viewport.width <= 1024;

            await open(page, page.locator(ROLEPLAY_AVATAR).first());
            await page.locator(`${ZOOMED} .dragClose`).click();
            await expect(zoomed).toHaveCount(0);
            await open(page, page.locator(ROLEPLAY_AVATAR).first());
            if (!coversItsAvatar) {
                await page.locator(ROLEPLAY_AVATAR).first().click();
                await expect(zoomed).toHaveCount(0);
                await open(page, page.locator(ROLEPLAY_AVATAR).first());
            }
            await page.keyboard.press('Escape');
            await expect(zoomed).toHaveCount(0);

            await seedAndOpen(page, { avatar: seraphina, chats: [{ name: 'Main', messages: TALK }] });
            const avatar = page.locator(CONVERSATION_AVATAR).first();
            await open(page, avatar);
            await page.locator(`${ZOOMED} .dragClose`).click();
            await expect(zoomed).toHaveCount(0);
            await open(page, avatar);
            if (!coversItsAvatar) {
                await avatar.click();
                await expect(zoomed).toHaveCount(0);
                await open(page, avatar);
            }
            await page.keyboard.press('Escape');
            await expect(zoomed).toHaveCount(0);

            await avatar.focus();
            await page.keyboard.press('Enter');
            await expect(zoomed).toHaveCount(1);
            await page.keyboard.press('Escape');
            await expect(zoomed).toHaveCount(0);
        });

        test('the picture of the header of a direct conversation opens the same window', async ({ page }) => {
            const { seraphina } = await boot(page);
            await seedAndOpen(page, { avatar: seraphina, chats: [{ name: 'Main', messages: TALK }] });
            const header = page.locator(HEADER_AVATAR).first();

            await open(page, header);
            const opened = await read(page);
            expect(opened.id).toBe(`zoomFor_${keyOf(seraphina)}`);
            expect(opened.src).toBe(`/characters/${encodeURIComponent(seraphina)}`);

            await page.locator(`${ZOOMED} .dragClose`).click();
            await expect(page.locator(ZOOMED)).toHaveCount(0);
        });

        test('the avatar of a member of a group opens that member, and no other', async ({ page }) => {
            const { seraphina, others, names } = await boot(page);
            const [first, second] = others;
            await seedAndOpen(page, {
                avatar: seraphina,
                members: [first, second],
                name: 'Weekend plans',
                chats: [{
                    name: 'Main',
                    messages: [
                        { id: 'g-1', role: 'character', name: names[seraphina], mes: 'Who is coming?' },
                        { id: 'g-2', role: 'member', name: names[first], mes: 'Me.', extra: { member_avatar: first } },
                        { id: 'g-3', role: 'member', name: names[second], mes: 'And me.', extra: { member_avatar: second } },
                    ],
                }],
            });

            await open(page, page.getByRole('button', { name: `Show Full Picture for ${names[first]}` }).first());
            let opened = await read(page);
            expect(opened.key).toBe(keyOf(first));
            expect(opened.src).toBe(`/characters/${encodeURIComponent(first)}`);

            await page.keyboard.press('Escape');
            await expect(page.locator(ZOOMED)).toHaveCount(0);
            await open(page, page.getByRole('button', { name: `Show Full Picture for ${names[second]}` }).first());
            opened = await read(page);
            expect(opened.key).toBe(keyOf(second));
            expect(opened.src).toBe(`/characters/${encodeURIComponent(second)}`);
        });
    });
}

test.describe('a Moving UI position', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    async function enableMovingUI(page) {
        await page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            power_user.movingUI = true;
            power_user.movingUIState = {};
            document.body.classList.add('movingUI');
        });
    }

    /** Drags the window by its grip, the way a user moves it, and returns where it ended up. */
    async function drag(page, dx, dy) {
        await page.locator(ZOOMED).hover();
        const grip = await page.locator(`${ZOOMED} .drag-grabber`).boundingBox();
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
        await page.mouse.down();
        await page.mouse.move(grip.x + grip.width / 2 + dx, grip.y + grip.height / 2 + dy, { steps: 6 });
        await page.mouse.up();
        await page.mouse.move(1, 1);
        return read(page);
    }

    test('saved in roleplay is the position in conversation mode, and saved in conversation mode is the position in roleplay', async ({ page }) => {
        const { seraphina } = await boot(page);
        await openRoleplayChat(page, seraphina);
        await enableMovingUI(page);

        await open(page, page.locator(ROLEPLAY_AVATAR).first());
        const home = await read(page);
        // The picture is as tall as the page under the top bar, so it can only be moved sideways.
        const movedInRoleplay = await drag(page, 140, 0);
        expect(movedInRoleplay.left, 'the drag moved the window').toBeGreaterThan(home.left + 100);
        const saved = await page.evaluate(async () => Object.keys((await import('/scripts/power-user.js')).power_user.movingUIState));
        expect(saved).toEqual([`zoomFor_${keyOf(seraphina)}`]);
        await page.keyboard.press('Escape');
        await expect(page.locator(ZOOMED)).toHaveCount(0);

        await seedAndOpen(page, { avatar: seraphina, chats: [{ name: 'Main', messages: TALK }] });
        await open(page, page.locator(CONVERSATION_AVATAR).first());
        expectSamePlace(await read(page), movedInRoleplay);

        const movedInConversation = await drag(page, 90, 0);
        expect(movedInConversation.left, 'the drag moved the window').toBeGreaterThan(movedInRoleplay.left + 50);
        await page.keyboard.press('Escape');
        await expect(page.locator(ZOOMED)).toHaveCount(0);

        await leaveConversation(page);
        await open(page, page.locator(ROLEPLAY_AVATAR).first());
        expectSamePlace(await read(page), movedInConversation);
    });
});
