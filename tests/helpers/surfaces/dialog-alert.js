/**
 * The Alert tier of the dialog family: a message, a confirmation, a one-field prompt or one option. Each entry is one layout:
 * a plain Popup text, a plain confirm, an input, a destructive confirm with a checkbox, an `openAlert` with a destructive
 * response, an `openAlert` with three responses, and the legacy `#dialogue_popup` that extensions still call.
 *
 * Every alert here is opened and never answered: a cancelled Popup and an Escape on an `openAlert` write nothing. The
 * destructive requests that an answer would make are refused in the page as well (`guardDestructive`).
 */

import { ALERT_FRAME, closeDialogs, closeFrame, closeMenus, openAuditChat, oncePerPage, settleFrame, waitForTextFocus } from './dialog-steps.js';
import { FIXTURES } from './fixture-data.js';
import { openCharacterEditor } from './header-steps.js';
import { chooseMenuItem, settle } from './steps.js';

const SCRIPTS = 'public/scripts';
const POPUP_ALERT = 'dialog.popup.sb-dialog--alert[open]:not([closing])';

/** Answers the endpoints that an accepted alert would call, so that a stray Enter cannot reach the server. */
async function guardDestructive(page) {
    await oncePerPage(page, 'dialog-alert-guard', async () => {
        await page.route(/\/api\/(?:cookies\/clear|characters\/delete|chats\/delete)$/, route => route.fulfill({ json: { success: true, expirationAttempts: 0 } }));
    });
}

/**
 * @param {object} entry
 * @param {string} entry.id The last segments of the id, after `dialog.alert.`.
 * @param {string} [entry.root]
 * @param {boolean} [entry.upstreamMarkup] Whether the content is upstream's (a Popup that an upstream-origin file builds) and
 * SillyBunny supplies the frame; `false` for an alert that SillyBunny wrote.
 * @returns {import('./index.js').Surface}
 */
function alert({ id, root = ALERT_FRAME, ready, owner = 'A', upstreamMarkup = true, ...rest }) {
    return {
        id: `dialog.alert.${id}`,
        family: 'dialog',
        owner,
        root,
        ready,
        close: closeFrame(root),
        needs: [],
        ...(upstreamMarkup && { upstreamMarkup }),
        ...rest,
    };
}

/**
 * Opens the action menu of the Recent Chats row of the `chat` need on Home and chooses an item of it. Home lists the newest
 * chats first and shows three, and the audit chat is the oldest of those that the needs seed, so the row is picked by its
 * file, and Home is asked to show more when the row is collapsed.
 */
async function chooseHomeChatItem(page, item) {
    await closeDialogs(page);
    await closeMenus(page);
    const panel = page.locator('#chat > .welcomePanel');
    const row = panel.locator(`.recentChat[data-avatar="${FIXTURES.character.avatar}"][data-file="${FIXTURES.chat.file}"]`);
    await row.waitFor({ state: 'attached' });
    if (!await row.isVisible()) {
        await panel.locator('button.showMoreChats:not(.displayNone)').first().click();
    }
    const menu = row.locator('.chatMenu');
    await menu.waitFor({ state: 'visible' });
    await menu.click();
    await page.locator('.sb-action-menu').last().getByRole('menuitem', { name: item, exact: true }).click();
    await settleFrame(page, POPUP_ALERT);
}

/** Asks Home to read the managed content of the server again after a route changed what it answers. */
async function renderHomeAgain(page) {
    await page.evaluate(async () => {
        const { openWelcomeScreen } = await import('/scripts/welcome-screen.js');
        await openWelcomeScreen({ force: true });
    });
    await page.locator('#chat > .welcomePanel .sbHomeCard').first().waitFor({ state: 'visible' });
    await settle(page);
}

/** @type {import('./index.js').Surface[]} */
export const surfaces = [
    alert({
        id: 'popup-text',
        title: 'Popup text alert (one OK response)',
        root: POPUP_ALERT,
        ready: `${POPUP_ALERT} .popup-button-ok`,
        async open(page) {
            await closeDialogs(page);
            // A plain Popup has no control of its own: every caller builds its text, so the call is the layout.
            await page.evaluate(async () => {
                const { Popup } = await import('/scripts/popup.js');
                void Popup.show.text('Audit heading', 'A short message that an alert shows, with one response.');
            });
            await settleFrame(page, POPUP_ALERT);
        },
        sources: [`${SCRIPTS}/popup.js`, `${SCRIPTS}/sillybunny-editor/popup-frame.js`],
    }),
    alert({
        id: 'home-chat-delete',
        title: 'Popup confirm (Delete the Chat File?, opened from a Recent Chats row on Home)',
        root: POPUP_ALERT,
        ready: [`${POPUP_ALERT} .popup-button-ok`, `${POPUP_ALERT} .popup-button-cancel`],
        needs: ['chat'],
        async open(page) {
            await guardDestructive(page);
            await chooseHomeChatItem(page, 'Delete');
        },
        sources: [`${SCRIPTS}/welcome-screen.js`, `${SCRIPTS}/sillybunny-home/menu.js`, `${SCRIPTS}/popup.js`],
        primaryFlow: true,
    }),
    alert({
        id: 'home-chat-rename',
        title: 'Popup input (Rename the chat file, opened from a Recent Chats row on Home)',
        root: POPUP_ALERT,
        ready: [`${POPUP_ALERT} .popup-input`, `${POPUP_ALERT} .popup-button-ok`],
        needs: ['chat'],
        async open(page) {
            await chooseHomeChatItem(page, 'Rename');
        },
        sources: [`${SCRIPTS}/welcome-screen.js`, `${SCRIPTS}/sillybunny-home/menu.js`, `${SCRIPTS}/popup.js`],
    }),
    alert({
        id: 'delete-media',
        title: 'Popup confirm with three responses and a checkbox (Delete media from message?, the call of a message image)',
        root: POPUP_ALERT,
        ready: [`${POPUP_ALERT} .popup-button-ok`, `${POPUP_ALERT} .popup-button-custom`, `${POPUP_ALERT} input[type="checkbox"]`],
        async open(page) {
            await closeDialogs(page);
            // The call of `deleteMessageMedia`, with its own text: the real control is the delete button of a message image, and the saved chat has no message with an image.
            await page.evaluate(async () => {
                const { Popup, POPUP_RESULT } = await import('/scripts/popup.js');
                void Popup.show.confirm('Delete media from message?', 'This action can\'t be undone.', {
                    okButton: 'Delete one',
                    defaultResult: POPUP_RESULT.NEGATIVE,
                    onOpening: popup => popup.okButton.classList.add('is-destructive'),
                    cancelButton: false,
                    customButtons: [
                        { text: 'Delete all', appendAtEnd: true, result: POPUP_RESULT.CUSTOM1, classes: ['is-destructive'] },
                        { text: 'Cancel', appendAtEnd: true, result: POPUP_RESULT.CANCELLED },
                    ],
                    customInputs: [{ type: 'checkbox', label: 'Also delete files from server', id: 'delete_media_files_checkbox', defaultState: true }],
                });
            });
            await settleFrame(page, POPUP_ALERT);
        },
        sources: [`${SCRIPTS}/chats.js`, `${SCRIPTS}/popup.js`],
    }),
    alert({
        id: 'delete-character',
        title: 'Popup confirm with a checkbox and a destructive response (Delete the character?)',
        root: POPUP_ALERT,
        ready: [`${POPUP_ALERT} .popup-button-ok.is-destructive`, `${POPUP_ALERT} #del_char_checkbox`],
        needs: ['character'],
        async open(page) {
            await closeDialogs(page);
            await guardDestructive(page);
            await closeMenus(page);
            await openCharacterEditor(page);
            await chooseMenuItem(page, '#sb_character_editor_more', 'Delete Character');
            await settleFrame(page, POPUP_ALERT);
        },
        sources: ['public/script.js', `${SCRIPTS}/popup.js`, 'public/scripts/templates/deleteConfirm.html'],
    }),
    alert({
        id: 'clear-cookies',
        upstreamMarkup: false,
        title: 'openAlert with a destructive response (Clear cookies and cache, from Data & Security)',
        ready: ['section.sb-dialog--alert .sb-dialog__heading', 'section.sb-dialog--alert .is-destructive'],
        async open(page) {
            await closeDialogs(page);
            await guardDestructive(page);
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'data-security'));
            const button = page.locator('#clear_cookies_cache_button');
            await button.waitFor({ state: 'visible' });
            // The button listens only after the tab has bound it.
            await page.waitForFunction(() => document.getElementById('clear_cookies_cache_button')?.dataset.sbCookiesCacheBound === 'true');
            // A click of Playwright would scroll the button into view, and with it the page behind the alert.
            await button.evaluate(element => element.click());
            await settleFrame(page, ALERT_FRAME);
        },
        sources: [`${SCRIPTS}/sillybunny-server-tools.js`, `${SCRIPTS}/sillybunny-editor/dialog.js`],
    }),
    alert({
        id: 'managed-update',
        upstreamMarkup: false,
        title: 'openAlert with three responses (Update Reisen?, opened from the menu of an edited assistant card)',
        ready: 'section.sb-dialog--alert .sb-dialog__heading',
        async open(page) {
            await closeDialogs(page);
            await closeMenus(page);
            await oncePerPage(page, 'dialog-managed-update', async () => {
                const reisen = { filename: 'default_AssistantReisen.png', type: 'character', version: 2, status: 'modified', updateAvailable: true };
                const tewi = { filename: 'default_AssistantTewi.png', type: 'character', version: 1, status: 'current', updateAvailable: false };
                await page.route('**/api/sillybunny/managed-content/status', route => route.fulfill({ json: { items: [reisen, tewi] } }));
                await page.route(/\/api\/sillybunny\/managed-content\/(?:apply|restore)$/, route => route.fulfill({ json: { backup: 'managed/backup' } }));
            });
            await renderHomeAgain(page);
            const card = '#chat > .welcomePanel .sbHomeCard[data-sb-home-key="assistant-reisen"]';
            await page.locator(`${card} .sbHomeRowMenu`).click();
            await page.locator('.sb-action-menu').last().getByRole('menuitem', { name: 'Update Available', exact: true }).click();
            await settleFrame(page, ALERT_FRAME);
        },
        sources: [`${SCRIPTS}/sillybunny-home/managed-update-alert.js`, `${SCRIPTS}/sillybunny-home/assistant-managed-actions.js`],
    }),
    alert({
        id: 'temporary-chat-leave',
        upstreamMarkup: false,
        title: 'openAlert with three responses and a destructive one (Keep This Chat?, leaving a temporary chat that holds a message)',
        ready: 'section.sb-dialog--alert .sb-dialog__heading',
        needs: ['character', 'chat'],
        // The message that the audit sends carries the time of the run.
        masks: ['#chat .mes .timestamp'],
        async open(page) {
            await closeDialogs(page);
            await guardDestructive(page);
            await openAuditChat(page);
            const present = await page.locator('#sb-temporary-chat-banner').count();
            if (!present) {
                const started = await page.evaluate(async () => {
                    const script = await import('/script.js');
                    const { startTemporaryChat } = await import('/scripts/sillybunny-temporary-chat.js');
                    const opened = await startTemporaryChat(script.this_chid);
                    if (opened) {
                        await script.sendMessageAsUser('Hello there', '');
                    }
                    return opened;
                });
                if (!started) {
                    throw new Error('The temporary chat did not start.');
                }
                await page.locator('#sb-temporary-chat-banner').waitFor({ state: 'visible' });
                await page.waitForFunction(() => window.SillyTavern.getContext().chat.some(message => message.is_user));
                // Starting the chat moves the focus to the composer after a short delay, and that click would close the menu.
                await waitForTextFocus(page);
            }
            // The Home button leaves a chat that holds a message only by asking.
            await page.locator('#sb-home-toggle').click();
            await settleFrame(page, ALERT_FRAME);
        },
        sources: [`${SCRIPTS}/sillybunny-temporary-chat.js`, `${SCRIPTS}/sillybunny-editor/dialog.js`],
        primaryFlow: true,
    }),
    alert({
        id: 'swipe-delete',
        upstreamMarkup: false,
        title: 'openAlert with a destructive response (Delete Swipe, opened from a row of the swipe picker)',
        ready: ['section.sb-dialog--alert .sb-dialog__heading', 'section.sb-dialog--alert .is-destructive'],
        needs: ['character', 'chat'],
        async open(page) {
            await closeDialogs(page);
            await openAuditChat(page);
            // The picker lists the swipes of a message that has 52 of them: the message is added to the open chat in the page only, as a saved chat holds none.
            const messageId = await page.evaluate(async () => {
                const context = window.SillyTavern.getContext();
                const count = 52;
                const message = {
                    name: 'Assistant', is_user: false, is_system: false, send_date: new Date(Date.UTC(2026, 0, 6, 9, 0, 0)).toISOString(),
                    mes: 'Swipe 1 preview text', extra: {},
                    swipes: Array.from({ length: count }, (_, index) => `Swipe ${index + 1} preview text`),
                    swipe_id: 1,
                    swipe_info: Array.from({ length: count }, () => ({ send_date: Date.UTC(2026, 0, 6, 9, 0, 0), extra: { token_count: 4 } })),
                };
                context.chat.push(message);
                await context.addOneMessage(message);
                const id = context.chat.length - 1;
                document.querySelector(`.mes[mesid="${id}"] .swipes-counter`)?.classList.add('swipe-picker-enabled');
                return id;
            });
            await page.locator(`.mes[mesid="${messageId}"] .swipes-counter.swipe-picker-enabled`).click();
            const picker = 'dialog[open].sb-dialog--window:has(.swipe_picker_div)';
            await page.locator(`${picker} .swipe_picker_footer`).waitFor({ state: 'visible' });
            await page.waitForFunction(() => !document.querySelector('dialog[open].sb-dialog--window[opening]'));
            await page.locator(`${picker} .swipe_picker_menu`).first().click();
            await page.getByRole('menuitem', { name: 'Delete Swipe', exact: true }).click();
            await settleFrame(page, ALERT_FRAME);
        },
        sources: [`${SCRIPTS}/swipe-picker.js`, `${SCRIPTS}/sillybunny-editor/dialog.js`],
    }),
    {
        id: 'dialog.alert.legacy-dialogue-popup',
        family: 'dialog',
        owner: 'A',
        upstreamMarkup: true,
        title: 'Legacy #dialogue_popup (callPopup, restyled as an Alert; kept for extensions)',
        root: '#dialogue_popup',
        ready: ['#dialogue_popup #dialogue_popup_text', '#dialogue_popup #dialogue_popup_ok', '#dialogue_popup #dialogue_popup_cancel'],
        async open(page) {
            await closeDialogs(page);
            await page.evaluate(() => {
                void window.SillyTavern.getContext().callPopup('<h3>Audit heading</h3><p>A message that an extension shows through the legacy popup.</p>', 'confirm');
            });
            await page.locator('#dialogue_popup').waitFor({ state: 'visible' });
            await page.waitForFunction(() => getComputedStyle(document.getElementById('shadow_popup')).opacity === '1');
            await settle(page, { root: '#dialogue_popup' });
        },
        async close(page) {
            await page.locator('#dialogue_popup_cancel').click();
            await page.locator('#dialogue_popup').waitFor({ state: 'hidden' });
        },
        needs: [],
        sources: ['public/script.js', 'public/index.html', 'public/css/sillybunny-theme.css'],
    },
];
