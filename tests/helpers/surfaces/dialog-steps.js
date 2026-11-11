/**
 * Open and wait steps of the dialog family. No Playwright import, so the registry loads in Jest.
 *
 * Two kinds of frame exist. `openDialog` and `openAlert` build a `dialog.sb-dialog-host` that holds a `section.sb-dialog`
 * (tier in its class), and a second `openDialog` call while one is open pushes a page of the same frame. A `Popup` that the
 * hook frames is its own `dialog.popup.sb-dialog`, and a Popup opened over a frame is a page over it (`sb-dialog--page`) while
 * the parent is marked `data-sb-covered`. A root selector therefore names the frame of one tier in both forms, and the
 * `:not([data-sb-covered])` guard picks the page that is on top.
 */

import { FIXTURES } from './fixture-data.js';
import { settle } from './steps.js';

/** The frame of a tier, in both forms: the section of an `openDialog` host, and the `dialog` of a framed Popup. */
const frameOf = tier => `dialog.sb-dialog-host:not([closing]) section.sb-dialog--${tier}, dialog.popup.sb-dialog--${tier}[open]:not([closing]):not([data-sb-covered])`;

export const ALERT_FRAME = frameOf('alert');
export const DIALOG_FRAME = frameOf('dialog');
export const WINDOW_FRAME = frameOf('window');
/** A Popup that the frame hook left alone (crop, image zoom): the native dialog with the Popup's own markup. */
export const OWN_POPUP = 'dialog.popup[open]:not([closing]):not(.sb-dialog)';

/**
 * A selector for what sits inside a frame. A frame is a list of two forms, so the descendant has to follow each form: a plain
 * `${FRAME} ${selector}` would attach `selector` to the last form only.
 * @param {string} frame A comma-separated list, such as `DIALOG_FRAME`.
 * @param {string} selector
 */
export const within = (frame, selector) => frame.split(', ').flatMap(form => selector.split(', ').map(part => `${form} ${part}`)).join(', ');

/** Waits until the frame that `root` names is shown and still: its opening animation is over and nothing moves in it. */
export async function settleFrame(page, root) {
    await page.locator(root).first().waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('dialog[open][opening]'));
    await settle(page, { root });
}

/**
 * Closes every dialog that is open, the way a user does: a Popup completes as cancelled (its `onClosing` may still refuse),
 * then Escape pops a page or closes an `openDialog` frame. A state of a surface runs after the surface was opened, and a
 * surface is opened again for the next state, so every `open` starts from here.
 * @param {import('@playwright/test').Page} page
 */
export async function closeDialogs(page) {
    for (let attempt = 0; attempt < 12; attempt++) {
        if (await page.locator('dialog[open]').count() === 0) {
            return;
        }
        await page.evaluate(async () => {
            const { Popup } = await import('/scripts/popup.js');
            for (const popup of [...Popup.util.popups].reverse()) {
                await popup.completeCancelled();
            }
        });
        if (await page.locator('dialog[open]:not([closing])').count()) {
            await page.keyboard.press('Escape');
        }
        await page.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 1500 }).catch(() => {});
    }
    throw new Error(`A dialog did not close: ${await page.evaluate(() => [...document.querySelectorAll('dialog[open]')].map(node => node.className).join(' | '))}.`);
}

/** The close step of a surface: leaves every dialog, then waits until the frame is gone. */
export const closeFrame = root => async (page) => {
    await closeDialogs(page);
    await page.locator(root).first().waitFor({ state: 'hidden' });
};

const onceKeys = new WeakMap();

/**
 * Runs `install` once per page for a `key`, so that a state that opens the surface again does not stack the routes of the first run.
 * @param {import('@playwright/test').Page} page
 * @param {string} key
 * @param {() => Promise<void>} install
 */
export async function oncePerPage(page, key, install) {
    const keys = onceKeys.get(page) ?? new Set();
    onceKeys.set(page, keys);
    if (!keys.has(key)) {
        keys.add(key);
        await install();
    }
}

/** Closes the menu of Home (and any other action menu) that an earlier step left open, so that the next click is not swallowed. */
export async function closeMenus(page) {
    await page.evaluate(async () => {
        const menu = await import('/scripts/sillybunny-action-menu.js');
        menu.closeActionMenu({ animate: false, restoreFocus: false });
    });
}

/**
 * Selects the audit character, which opens its saved chat, and waits until the chat shows its messages and is quiet. Kept apart
 * from the shared step because it also waits for the composer focus that the app moves after a load (`waitForChatQuiet`).
 */
export async function openAuditChat(page) {
    const refocuses = await page.evaluate(async ({ avatar }) => {
        const context = window.SillyTavern.getContext();
        if (!context.characters.length) {
            await context.getCharacters();
        }
        const index = context.characters.findIndex(character => character.avatar === avatar);
        if (index < 0) {
            throw new Error(`The audit character ${avatar} is not on the server.`);
        }
        if (Number(context.characterId) === index && document.querySelector('#chat > .mes')) {
            return false;
        }
        await context.selectCharacterById(index, { switchMenu: false });
        return true;
    }, { avatar: FIXTURES.character.avatar });
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
    await page.locator('#chat > .mes').first().waitFor({ state: 'visible' });
    await waitForChatQuiet(page, { refocuses });
}

/** Opens the audit group and its chat, and waits until the chat is quiet. Loading a group chat does not move the focus (`getChat()` does, `group-chats.js` does not). */
export async function openAuditGroupChat(page) {
    await page.evaluate(async ({ name }) => {
        const groupChats = await import('/scripts/group-chats.js');
        const context = window.SillyTavern.getContext();
        const group = groupChats.groups.find(candidate => candidate.name === name);
        if (!group) {
            throw new Error(`The audit group ${name} is not on the server.`);
        }
        if (context.groupId !== group.id && !await groupChats.openGroupById(group.id, { switchMenu: false })) {
            throw new Error(`Could not open the group ${name}.`);
        }
    }, { name: FIXTURES.group.name });
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
    await page.locator('#group_speaker_controls .group_speaker_avatar').first().waitFor({ state: 'visible' });
    await page.locator('#chat > .mes').first().waitFor({ state: 'visible' });
    await waitForChatQuiet(page, { refocuses: false });
}

/**
 * Waits until the focus is in a visible input or textarea. `getChat()` clicks and focuses the composer a moment after a chat
 * loads unless a visible text input has focus, and that click closes any menu through an outside-click handler, so nothing may
 * be opened on a freshly loaded chat before it. The app skips the focus while the settings shell is open, so then nothing is awaited.
 * @param {import('@playwright/test').Page} page
 */
export async function waitForTextFocus(page) {
    await page.waitForFunction(() => {
        const active = document.activeElement;
        return document.documentElement.dataset.sbSettingsOpen === 'true'
            || (active?.matches('input, textarea') && active.getClientRects().length > 0);
    }, undefined, { timeout: 5000 }).catch((error) => {
        throw new Error(`No text input took the focus after the chat loaded: ${error.message}`);
    });
}

/**
 * Waits until a chat that was just loaded is settled: the focus has moved, and the chat, which renders again after its first
 * paint (swipe controls, avatars), has stopped changing. Fails with a message at the cap.
 * @param {import('@playwright/test').Page} page
 * @param {{ refocuses: boolean }} options Whether the app moves the focus to the composer after this load: not when the chat was open already, nor for a group chat.
 */
export async function waitForChatQuiet(page, { refocuses }) {
    if (refocuses) {
        await waitForTextFocus(page);
    }
    const quiet = await page.evaluate(() => new Promise((resolve) => {
        const chat = document.getElementById('chat');
        let timer = setTimeout(() => finish(true), 400);
        const cap = setTimeout(() => finish(false), 5000);
        const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => finish(true), 400);
        });
        observer.observe(chat, { subtree: true, childList: true, attributes: true });
        function finish(value) {
            clearTimeout(timer);
            clearTimeout(cap);
            observer.disconnect();
            resolve(value);
        }
    }));
    if (!quiet) {
        throw new Error('The chat kept changing for 5 s after it loaded.');
    }
    await settle(page);
}

/** The index of the audit character in the app's list, loading the list when the app has not. */
export async function auditCharacterIndex(page) {
    return page.evaluate(async ({ avatar }) => {
        const context = window.SillyTavern.getContext();
        if (!context.characters.length) {
            await context.getCharacters();
        }
        const index = context.characters.findIndex(character => character.avatar === avatar);
        if (index < 0) {
            throw new Error(`The audit character ${avatar} is not on the server.`);
        }
        return index;
    }, { avatar: FIXTURES.character.avatar });
}
