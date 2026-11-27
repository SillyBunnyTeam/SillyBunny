/**
 * Open and wait steps of the chat family for the Roleplay chat: the transcript, the composer, the bottom chat bar and the
 * group speaker controls. A step that follows a spec says so on the function. No Playwright import, so the registry loads
 * in Jest.
 *
 * Several states change the chat they sit on (an edit row, a generation that adds a user message). A state runs on top of
 * its surface's `open`, and a state is opened after the surface has been opened again, so `open` must bring the chat back
 * from whatever the last state left. Steps that cannot be undone in place call `markChatDirty()`, and the next
 * `openChatFile()` loads the chat again from the server, which still holds the fixture because a save from the page is
 * answered without being stored.
 */

import { VIEWPORT_IDS, viewportById } from '../surface-matrix.js';
import { FIXTURES } from './fixture-data.js';
import { closeComposerSheets, closeOverlays, dismissDialogs, openLegacyToggle } from './menu-steps.js';
import { selectBackend, settle } from './steps.js';
import { TOAST_SELECTOR } from '../toasts.js';

/** The shell switches to its mobile layout at this width (`(max-width: 768px)`). */
const PAGED_WIDTH = 768;

/** The bottom chat bar also folds into its chip row on a touch screen this short (breakpoints.js `BOTTOM_BAR_COMPACT_QUERY`). */
const PAGED_TOUCH_HEIGHT = 450;

/**
 * Whether a run's viewport shows the bottom bar as its chip row. The viewport id is `<width>x<height>`; a run without one is read as a desktop window.
 * @param {{ viewport?: string }} [ctx]
 */
export function isPaged(ctx) {
    const id = String(ctx?.viewport ?? '1440x900');
    const [width, height] = id.split('x').map(Number);
    const coarse = VIEWPORT_IDS.includes(id) && viewportById(id).pointer === 'coarse';
    return width <= PAGED_WIDTH || (coarse && height <= PAGED_TOUCH_HEIGHT);
}

/** The message at `id` of the transcript. */
export const message = id => `#chat > .mes[mesid="${id}"]`;

/** The chat styles of the Appearance settings (`#chat_display`) with the body class that each one sets. */
export const CHAT_STYLES = Object.freeze([
    { id: 'flat', label: 'Flat', value: 0, bodyClass: 'flatchat' },
    { id: 'bubbles', label: 'Bubbles', value: 1, bodyClass: 'bubblechat' },
    { id: 'document', label: 'Document', value: 2, bodyClass: 'documentstyle' },
    { id: 'echo', label: 'Echo', value: 3, bodyClass: 'echostyle' },
    { id: 'whisper', label: 'Whisper', value: 4, bodyClass: 'whisperstyle' },
    { id: 'hush', label: 'Hush', value: 5, bodyClass: 'hushstyle' },
    { id: 'ripple', label: 'Ripple', value: 6, bodyClass: 'ripplestyle' },
    { id: 'tide', label: 'Tide', value: 7, bodyClass: 'tidestyle' },
]);

/**
 * Waits until no message has been added to or removed from the chat for a while, because a chat renders again after its
 * first paint. Only the list of children is watched, so a style or class that keeps changing does not hold the wait; a chat
 * that is still being rebuilt after `cap` ms fails it.
 */
export async function waitForChatQuiet(page, { quiet = 400, cap = 5000 } = {}) {
    await page.evaluate(({ quiet, cap }) => new Promise((resolve, reject) => {
        const chat = document.getElementById('chat');
        let timer = setTimeout(done, quiet);
        const limit = setTimeout(() => {
            observer.disconnect();
            clearTimeout(timer);
            reject(new Error(`The chat was still changing ${cap} ms after it was opened.`));
        }, cap);
        const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(done, quiet);
        });
        observer.observe(chat, { subtree: true, childList: true });
        function done() {
            clearTimeout(limit);
            observer.disconnect();
            resolve();
        }
    }), { quiet, cap });
}

/**
 * Sets "Expand message actions" of the Customize settings and waits until the body shows it. The setting's own input
 * event is dispatched, because the panel that holds the checkbox is closed.
 * @param {import('@playwright/test').Page} page
 * @param {boolean} expanded
 */
export async function setExpandMessageActions(page, expanded) {
    await page.locator('#expandMessageActions').evaluate((box, expanded) => {
        if (box.checked !== expanded) {
            box.checked = expanded;
            box.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }, expanded);
    await page.waitForFunction(expanded => document.body.classList.contains('expandMessageActions') === expanded, expanded);
}

/** Leaves Conversation mode, which an earlier surface of the same page may have left on, for the Roleplay chat. */
async function leaveConversationMode(page) {
    if (!await page.locator('#sheld[data-sb-conversation-mode="on"]').count()) {
        return;
    }
    await page.evaluate(async () => {
        const chrome = await import('/scripts/sillybunny-conversation/chrome.js');
        chrome.disableConversationModeForCurrentCharacter({ focusRoleplay: false });
    });
    await page.locator('#sheld[data-sb-conversation-mode="on"]').waitFor({ state: 'detached' });
}

/** Tells the next `openChatFile()` that this page changed the chat in a way that only a new load undoes. */
export async function markChatDirty(page) {
    await page.evaluate(() => { window.__sbAuditChat = { ...(window.__sbAuditChat ?? {}), dirty: true }; });
}

const generationControls = new WeakMap();

/**
 * Stands in for the model. The route is installed once per page, and `mode` picks what it does with a request: `hold`
 * keeps it open until `releaseGeneration()` (a generation that is under way), `error` answers with a server error.
 * The request path is the one of `greeting-art.e2e.js` and `temporary-chat.e2e.js`.
 */
async function generationControl(page) {
    let control = generationControls.get(page);
    if (!control) {
        control = { mode: 'hold', held: new Set() };
        generationControls.set(page, control);
        // Choosing the backend asks it for its models, and a model in the answer is what makes the app report a connection.
        await page.route('**/api/backends/chat-completions/status', route => route.fulfill({ json: { data: [{ id: 'audit-model' }] } }));
        await page.route('**/api/backends/chat-completions/generate', async (route) => {
            if (control.mode === 'error') {
                await route.fulfill({ status: 500, json: { error: { message: 'The audit model is not available.' } } });
                return;
            }
            await new Promise(resolve => control.held.add(resolve));
            // The app abandons the request when its stop control is used, which leaves the route handled already.
            await route.abort().catch((error) => {
                if (!/already handled|closed|disposed/i.test(error.message)) {
                    throw error;
                }
            });
        });
    }
    return control;
}

/**
 * Empties the composer: the text, the attachment and the height that the text gave the entry.
 * @param {import('@playwright/test').Page} page
 */
export async function resetComposer(page) {
    await page.evaluate(() => {
        const textarea = document.getElementById('send_textarea');
        textarea.value = '';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        window.$('#file_form').trigger('reset');
        const input = document.getElementById('file_form_input');
        if (input) {
            input.value = '';
        }
    });
}

/** Ends a generation that `startGeneration()` began, and lets the held request go. */
export async function stopGeneration(page) {
    const control = generationControls.get(page);
    if (!control) {
        return;
    }
    if (await page.locator('#mes_stop').isVisible()) {
        await page.locator('#mes_stop').click();
    }
    for (const release of control.held) {
        release();
    }
    control.held.clear();
    await page.waitForFunction(() => document.body.dataset.generating !== 'true');
}

/**
 * Makes the app report a connection, or none. The composer enables Send and shows its prompt text accordingly. From
 * `tests/frontend/ConversationLorebooks.e2e.js` and `conversation-composer-connection.e2e.js`.
 * @param {import('@playwright/test').Page} page
 * @param {boolean} connected
 */
export async function setConnection(page, connected) {
    await page.evaluate(async (connected) => {
        const { setOnlineStatus } = await import('/script.js');
        setOnlineStatus(connected ? 'Connected' : 'no_connection');
    }, connected);
    await page.waitForFunction((connected) => {
        const textarea = document.getElementById('send_textarea');
        return textarea.placeholder === textarea.getAttribute(connected ? 'connected_text' : 'no_connection_text');
    }, connected);
}

/**
 * Closes the two menus of the composer, which jQuery fades, by their own buttons; on a phone they are sheets whose scrim
 * covers the buttons, and a press on the scrim closes them.
 */
export async function closeLegacyMenus(page) {
    await closeComposerSheets(page);
    for (const [button, menu] of [['#options_button', '#options'], ['#extensionsMenuButton', '#extensionsMenu']]) {
        if (await page.locator(menu).isVisible()) {
            await page.locator(button).click();
            await page.locator(menu).waitFor({ state: 'hidden' });
        }
    }
}

/**
 * Attaches a small text file to the composer through the button of the wand menu, as a user does: the file chooser opens,
 * and the composer shows the name and size of the file above the entry.
 * @param {import('@playwright/test').Page} page
 */
export async function attachFile(page) {
    const chooser = page.waitForEvent('filechooser');
    await page.evaluate(() => document.getElementById('attachFile').click());
    await (await chooser).setFiles({ name: 'audit-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Notes for the audit chat.') });
    await page.locator('#file_form:not(.displayNone)').waitFor({ state: 'visible' });
    await settle(page);
}

const SEARCH_CLOSE = '#sb-bottom-chat-bar .sb-bottom-chat-search-close';

/**
 * Brings the bottom chat bar back to its resting form: the chat sheet closed and the search closed and empty.
 * @param {import('@playwright/test').Page} page
 */
export async function resetBottomBar(page) {
    if (await page.locator('#sb-bottom-chat-sheet').isVisible()) {
        await page.locator('.sb-dialog-host .sb-bottom-chat-sheet-close').click();
        await page.locator('#sb-bottom-chat-sheet').waitFor({ state: 'hidden' });
    }
    if (await page.locator('#sb-bottom-chat-search').isVisible()) {
        await page.locator('#sb-bottom-chat-search').fill('');
    }
    if (await page.locator('#sb-bottom-chat-bar.sb-bottom-chat-search-open').count() && await page.locator(SEARCH_CLOSE).isVisible()) {
        await page.locator(SEARCH_CLOSE).click();
        await page.locator('#sb-bottom-chat-bar.sb-bottom-chat-search-open').waitFor({ state: 'detached' });
    }
}

/**
 * Opens the search of the bottom chat bar and types a word into it. A desktop window shows the search field in the bar all
 * the time. A phone has the search button in the chat sheet that the chip opens, and the sheet goes away once the search
 * is open, so that the field is in view.
 */
export async function openBottomBarSearch(page, ctx) {
    if (isPaged(ctx)) {
        await page.locator('#sb-bottom-chat-bar .sb-bottom-chat-chip').click();
        await page.locator('#sb-bottom-chat-sheet').waitFor({ state: 'visible' });
        await page.locator('#sb-bottom-chat-sheet .sb-bottom-chat-search-toggle').click();
        await page.locator('#sb-bottom-chat-sheet').waitFor({ state: 'hidden' });
    }
    await page.locator('#sb-bottom-chat-search').fill('lamp');
    // The status beside the field counts matches while the search goes through the chat, and its width moves the field's edge. The
    // search has ended when the status has shown the same count for half a second.
    await page.evaluate(() => new Promise((resolve, reject) => {
        const read = () => {
            const status = document.querySelector('#sb-bottom-chat-bar .sb-bottom-chat-search-status');
            return status && !status.hidden && !status.textContent.includes('Loading') ? status.textContent.trim() : '';
        };
        const started = performance.now();
        let last = read();
        let since = started;
        const tick = (now) => {
            const current = read();
            if (current !== last) {
                last = current;
                since = now;
            }
            if (current !== '' && now - since >= 500) {
                resolve();
            } else if (now - started > 10_000) {
                reject(new Error(`The search status of the bottom chat bar did not settle within 10 s (last text: "${current}").`));
            } else {
                requestAnimationFrame(tick);
            }
        };
        requestAnimationFrame(tick);
    }));
    await settle(page);
}

/**
 * Opens a saved chat of the audit character in the Roleplay chat. A chat that is open and unchanged is left alone.
 * The `chat` need makes the character point at `audit-chat`; the other chats of the character open by name, as
 * `greeting-art.e2e.js` opens one.
 * @param {import('@playwright/test').Page} page
 * @param {string} file The chat file without its extension.
 */
export async function openChatFile(page, file) {
    await stopGeneration(page);
    await leaveConversationMode(page);
    await dismissDialogs(page);
    const loaded = await page.evaluate(async ({ avatar, file }) => {
        const context = window.SillyTavern.getContext();
        if (!context.characters.length) {
            await context.getCharacters();
        }
        const index = context.characters.findIndex(character => character.avatar === avatar);
        if (index < 0) {
            throw new Error(`The audit character ${avatar} is not on the server.`);
        }
        const known = window.__sbAuditChat;
        const open = !context.groupId && Number(context.characterId) === index && context.getCurrentChatId() === file
            && known?.file === file && !known.dirty && document.querySelector('#chat > .mes') !== null;
        if (open) {
            return false;
        }
        if (context.groupId || Number(context.characterId) !== index) {
            await context.selectCharacterById(index, { switchMenu: false });
        }
        if (context.getCurrentChatId() !== file) {
            await context.openCharacterChat(file);
        } else if (known?.dirty) {
            await context.reloadCurrentChat();
        }
        window.__sbAuditChat = { file, dirty: false };
        return true;
    }, { avatar: FIXTURES.character.avatar, file });
    await dismissDialogs(page);
    await page.locator('#chat > .mes').first().waitFor({ state: 'visible' });
    if (loaded) {
        await waitForChatQuiet(page);
    }
    await setChatStyle(page, CHAT_STYLES[0]);
}

/**
 * Puts the page back to a chat without an overlay, an edit, an expanded row, a menu or a toast: what the state steps of
 * the transcript and the composer start from.
 * @param {import('@playwright/test').Page} page
 */
export async function resetChatUi(page) {
    await closeOverlays(page);
    await closeLegacyMenus(page);
    await setExpandMessageActions(page, false);
    await page.evaluate(() => {
        window.toastr?.clear?.();
        document.querySelectorAll('#chat .mes[data-sb-actions-expanded]').forEach(row => row.removeAttribute('data-sb-actions-expanded'));
        document.querySelectorAll('#chat .mes_reasoning_details[open]').forEach((details) => { details.open = false; });
        document.activeElement?.blur?.();
    });
    if (await page.locator('#dialogue_del_mes').isVisible()) {
        await page.locator('#dialogue_del_mes_cancel').click();
        await page.locator('#dialogue_del_mes').waitFor({ state: 'hidden' });
    }
    const cancel = page.locator('#chat .mes_edit_cancel:visible');
    if (await cancel.count()) {
        await cancel.first().click();
        await page.locator('#chat .edit_textarea').first().waitFor({ state: 'detached' });
    }
    await showBars(page);
    await page.mouse.move(0, 0);
}

/**
 * Shows the group speaker bar and the bottom chat bar again if a user hid them. Both are hidden by a button and brought
 * back by an entry of a menu, and both remember it, so the next surface would start without them.
 */
async function showBars(page) {
    const restored = await page.evaluate(() => {
        const hiddenGroupBar = document.body.classList.contains('groupSpeakerControlsHidden');
        const hiddenBottomBar = document.querySelector('#sb-bottom-chat-bar')?.classList.contains('displayNone') ?? false;
        if (hiddenGroupBar) {
            window.$('#wand_group_speaker_controls').trigger('click');
        }
        if (hiddenBottomBar) {
            document.getElementById('option_toggle_bottom_bar').click();
        }
        return { hiddenGroupBar, hiddenBottomBar };
    });
    if (restored.hiddenGroupBar) {
        await page.waitForFunction(() => !document.body.classList.contains('groupSpeakerControlsHidden'));
    }
    if (restored.hiddenBottomBar) {
        await page.waitForFunction(() => !document.querySelector('#sb-bottom-chat-bar').classList.contains('displayNone'));
    }
}

/**
 * Applies one of the chat styles through the Appearance select, as a user does, and waits until the style's body class and
 * its lazily loaded stylesheet are in place.
 * @param {import('@playwright/test').Page} page
 * @param {{ value: number, bodyClass: string }} style
 */
export async function setChatStyle(page, { value, bodyClass }) {
    await page.evaluate(({ value, bodyClass }) => {
        if (!document.body.classList.contains(bodyClass)) {
            window.$('#chat_display').val(String(value)).trigger('change');
        }
    }, { value, bodyClass });
    await page.waitForFunction(({ bodyClass }) => {
        const link = document.getElementById('sillybunny-native-chat-styles');
        return document.body.classList.contains(bodyClass) && (!link || link.sheet !== null);
    }, { bodyClass });
    await settle(page);
}

/**
 * Waits until the element has kept the same position and size for `quiet` ms (and at least 20 frames), with no image that
 * loads at once still on its way. The chat puts its own scroll position back after a change of layout (a chat style, a
 * reasoning block, images that load), and a timeline scrolls a message into view, so a position read earlier is not the
 * settled one. The wait fails after `cap` ms.
 * @param {import('@playwright/test').Page} page
 * @param {string} selector
 */
export async function waitForStill(page, selector, { quiet = 400, cap = 8000 } = {}) {
    await page.evaluate(({ selector, quiet, cap }) => new Promise((resolve, reject) => {
        const read = () => {
            const rect = document.querySelector(selector)?.getBoundingClientRect();
            const loading = [...document.images].filter(image => !image.complete && image.loading !== 'lazy').length;
            return `${rect ? `${Math.round(rect.top)}:${Math.round(rect.height)}` : 'none'}:${loading}`;
        };
        let last = read();
        let since = performance.now();
        let frames = 0;
        const started = since;
        const tick = (now) => {
            const current = read();
            if (current !== last) {
                last = current;
                since = now;
                frames = 0;
            }
            frames++;
            if (now - since >= quiet && frames >= 20 && current.endsWith(':0')) {
                resolve();
            } else if (now - started > cap) {
                reject(new Error(`${selector} was still moving ${cap} ms after it was asked for.`));
            } else {
                requestAnimationFrame(tick);
            }
        };
        requestAnimationFrame(tick);
    }), { selector, quiet, cap });
}

/**
 * Tells the app that the user has taken over the scroll position of the chat. For a few seconds after a chat loads, the app
 * scrolls it back to the bottom on timers until the user scrolls, and a wheel turn over the chat is that user scroll. Without
 * it, a later timer undoes a scripted scroll.
 */
async function takeOverChatScroll(page) {
    const chat = await page.locator('#chat').boundingBox();
    await page.mouse.move(chat.x + chat.width / 2, chat.y + chat.height / 2);
    await page.mouse.wheel(0, -200);
}

/**
 * Scrolls a message of the transcript to the start, the middle or the end of the chat column, and fails when the message
 * is not in the column once the layout has settled.
 */
export async function scrollToMessage(page, id, block = 'start') {
    const selector = message(id);
    let inView = false;
    await waitForStill(page, selector);
    await takeOverChatScroll(page);
    // Messages above the one that is scrolled to are measured as they render, which moves it; the scroll is repeated up to three times.
    for (let attempt = 0; attempt < 3 && !inView; attempt++) {
        await waitForStill(page, selector);
        await page.evaluate(({ selector, block }) => {
            const row = document.querySelector(selector);
            if (!row) {
                throw new Error(`${selector} is not in the chat.`);
            }
            row.scrollIntoView({ block });
        }, { selector, block });
        await waitForStill(page, selector);
        await settle(page);
        inView = await page.evaluate((selector) => {
            const rect = document.querySelector(selector).getBoundingClientRect();
            const view = document.getElementById('chat').getBoundingClientRect();
            return rect.bottom > view.top + 40 && rect.top < view.bottom - 40;
        }, selector);
    }
    if (!inView) {
        throw new Error(`${selector} is not in the chat column after it was scrolled to.`);
    }
}

/** Brings the control that loads older messages (above the first rendered message of a chat longer than the render window) to the top of the chat column. */
export async function scrollToOlderMessagesControl(page) {
    await waitForStill(page, '#show_more_messages');
    await takeOverChatScroll(page);
    await page.evaluate(() => document.getElementById('show_more_messages').scrollIntoView({ block: 'start' }));
    await waitForStill(page, '#show_more_messages');
    await settle(page);
}

/** Enters the message deletion mode through the Options menu: the composer gives way to the selection bar, the header offers Cancel and Select All, and each message gets a check. */
export async function openDeleteMode(page) {
    await openLegacyToggle(page, '#options_button', '#options');
    await page.locator('#option_delete_mes').click();
    await page.locator('#options').waitFor({ state: 'hidden' });
    await page.locator('#dialogue_del_mes').waitFor({ state: 'visible' });
    await settle(page);
}

/** Hides the bottom chat bar with its entry in the Options menu, then opens the menu again, where the entry offers to show it. */
export async function hideBottomBar(page) {
    await openLegacyToggle(page, '#options_button', '#options');
    await page.locator('#option_toggle_bottom_bar').click();
    await page.locator('#options').waitFor({ state: 'hidden' });
    await page.locator('#sb-bottom-chat-bar.displayNone').waitFor({ state: 'attached' });
    await openLegacyToggle(page, '#options_button', '#options');
}

/** Hides the group speaker bar with its own button, then opens the wand menu, where an entry brings it back. */
export async function hideGroupSpeakerBar(page) {
    await page.locator('#group_speaker_hide').click();
    await page.locator('#group_speaker_controls').waitFor({ state: 'hidden' });
    await openLegacyToggle(page, '#extensionsMenuButton', '#extensionsMenu');
}

/** Moves the pointer onto the text of a message, which reveals its action row in the styles that show the row only then. */
export async function hoverMessage(page, id) {
    await page.locator(`${message(id)} .mes_text`).hover();
    await settle(page);
}

/**
 * Opens the edit row of a message. From `foundation/message-actions.e2e.js`.
 * @param {import('@playwright/test').Page} page
 * @param {number} id
 */
export async function editMessage(page, id) {
    await hoverMessage(page, id);
    await page.locator(`${message(id)} .mes_buttons .mes_edit`).click();
    await page.locator(`${message(id)} .edit_textarea`).waitFor({ state: 'visible' });
    await scrollToMessage(page, id);
}

/** Opens the reasoning block of a message, as a click on its header does (a click on the rest of the summary row does nothing). */
export async function openReasoning(page, id) {
    await page.locator(`${message(id)} .mes_reasoning_header`).click();
    await page.waitForFunction(selector => document.querySelector(selector)?.open === true, `${message(id)} .mes_reasoning_details`);
    await settle(page);
}

/**
 * Types a message and sends it while the model request is held, so that the app is generating: the stop control replaces
 * Send, and the chat has the new user message. `mode: 'error'` answers the request with a server error instead.
 * @param {import('@playwright/test').Page} page
 * @param {'hold' | 'error'} [mode]
 */
export async function startGeneration(page, mode = 'hold') {
    const control = await generationControl(page);
    control.mode = mode;
    await selectBackend(page);
    await setConnection(page, true);
    await markChatDirty(page);
    await page.evaluate(() => {
        // A toast that closes by itself would be gone before the capture.
        window.toastr.options.timeOut = 0;
        window.toastr.options.extendedTimeOut = 0;
        document.documentElement.setAttribute('data-qa-show-toasts', '');
    });
    await page.locator('#send_textarea').fill('Audit message');
    await page.locator('#send_but').click();
    if (mode === 'hold') {
        await page.locator('#mes_stop').waitFor({ state: 'visible' });
        // Sending the first message completes a step of Getting Started, which toasts over the chat.
        await page.evaluate(() => window.toastr.clear());
    } else {
        await page.locator(`${TOAST_SELECTOR}.toast-error`).first().waitFor({ state: 'visible' });
    }
    await settle(page);
}

/**
 * Opens the audit group and its chat.
 * @param {import('@playwright/test').Page} page
 */
export async function openAuditGroupChat(page) {
    await stopGeneration(page);
    await leaveConversationMode(page);
    await dismissDialogs(page);
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
    await dismissDialogs(page);
    await page.locator('#group_speaker_controls .group_speaker_avatar').first().waitFor({ state: 'visible' });
    await page.locator('#chat > .mes').first().waitFor({ state: 'visible' });
    await waitForChatQuiet(page);
    await setChatStyle(page, CHAT_STYLES[0]);
}
