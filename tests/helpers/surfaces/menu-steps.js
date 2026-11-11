/**
 * Open and wait steps of the menu family. No Playwright import, so the registry loads in Jest.
 *
 * A menu is a popover on a desktop window and a bottom sheet under the overlay breakpoint, so each root below is a
 * selector list that matches whichever form the size uses. The sheet leaves the DOM when its exit ends, but `hidden`
 * is set at once, so `:not([hidden])` never matches a sheet that is on its way out.
 */

import { FIXTURES } from './fixture-data.js';
import { openPersonaEditorEntry } from './panel-steps.js';
import { selectBackend, settle } from './steps.js';

/** An action menu or a popover: the popover on a desktop window, the sheet under the overlay breakpoint. */
export const MENU_ROOT = '.sb-action-popover, .sb-action-sheet:not([hidden])';
/** The shared picker, in both forms. */
export const PICKER_ROOT = '.sb-picker, .sb-picker-sheet:not([hidden])';
/** A custom popover (`openPopover`), in both forms: the popover keeps its own class, the sheet is the shared one. */
export const POPOVER_ROOT = '.sb-custom-popover, .sb-action-sheet:not([hidden])';

/** Waits until the open animation of the root has ended and the layout has settled. */
export async function settleOverlay(page, root) {
    await page.locator(root).first().waitFor({ state: 'visible' });
    // An animation that repeats for ever (a spinner) never finishes, so only motion that ends is awaited. A cancelled one rejects.
    await page.locator(root).first().evaluate(node => Promise.all(node.getAnimations({ subtree: true })
        .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map(animation => animation.finished.catch(() => {}))));
    await settle(page);
}

/**
 * Waits until a menu that jQuery fades in (the Options menu, the wand menu and its drop-downs) has finished fading and is shown.
 * Their fade is not a Web Animation, so `settleOverlay` cannot see it end.
 */
export async function settleFade(page, root) {
    await page.locator(root).first().waitFor({ state: 'visible' });
    await page.waitForFunction(selector => {
        const node = document.querySelector(selector);
        return Boolean(node) && getComputedStyle(node).display !== 'none' && getComputedStyle(node).opacity === '1';
    }, root);
    await settle(page);
}

/**
 * Opens a menu that its button toggles and that jQuery fades in: the Options menu (`#options_button`) and the wand menu
 * (`#extensionsMenuButton`). Both toggle on a jQuery click handler, so the click waits until the handler is bound.
 */
export async function openLegacyToggle(page, button, root) {
    await page.waitForFunction(selector => Boolean(window.$?._data(document.querySelector(selector), 'events')?.click?.length), button);
    await page.locator(button).click();
    await settleFade(page, root);
}

/**
 * Clicks a trigger and waits until the overlay it opens is shown and still.
 * @param {import('@playwright/test').Page} page
 * @param {string} trigger A selector; the first visible match is clicked.
 * @param {string} [root] Defaults to the action menu.
 */
export async function openFrom(page, trigger, root = MENU_ROOT) {
    const target = page.locator(trigger).filter({ visible: true }).first();
    const scrolledAncestors = () => target.evaluate((node) => {
        // A trigger inside another overlay is no reason to close it: that would close the way to the trigger.
        if (node.closest('.sb-action-popover, .sb-action-sheet, .sb-picker, .sb-picker-sheet, .sb-custom-popover, dialog')) {
            return 0;
        }
        let moved = 0;
        for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
            if (ancestor.scrollTop !== 0) {
                moved++;
            }
        }
        return moved;
    });
    // The overlay hangs on the trigger, so where the page behind is scrolled to is where the overlay opens. A click that Playwright
    // had to retry (the page was still moving, something covered the trigger) scrolls the trigger to another place each time, so the
    // page is let settle first, and an open that left the page scrolled is closed and done again from the top (twice at most).
    for (let attempt = 0; ; attempt++) {
        await settle(page);
        await target.evaluate((node) => {
            for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
                ancestor.scrollTop = 0;
            }
        });
        await target.click();
        await settleOverlay(page, root);
        if (attempt >= 2 || await scrolledAncestors() === 0) {
            return;
        }
        await closeAndWait(page, root);
    }
}

/** Clicks an item of the open menu by its accessible name, then waits for the overlay that it opens. */
export async function chooseItem(page, name, root = MENU_ROOT) {
    await page.locator('.sb-action-menu').last().getByRole('menuitem', { name, exact: true }).click();
    await settleOverlay(page, root);
}

/** Closes the action menu, popover or picker that is open, without the exit animation. */
export async function closeOverlays(page) {
    await page.evaluate(async () => {
        const menu = await import('/scripts/sillybunny-action-menu.js');
        const picker = await import('/scripts/sillybunny-editor/picker.js');
        menu.closeActionMenu({ animate: false, restoreFocus: false });
        picker.closePicker({ animate: false, restoreFocus: false });
    });
}

/** Closes what is open, then waits until nothing that matches `root` is shown. */
export async function closeAndWait(page, root = MENU_ROOT) {
    await closeOverlays(page);
    await page.locator(root).first().waitFor({ state: 'hidden' });
}

/** Closes every open dialog of the app by hand: a welcome or import popup would cover the surface under test. */
export async function dismissDialogs(page) {
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
}

/** Selects the audit character, which opens its saved chat, and waits until the chat shows its messages. */
export async function openAuditChat(page) {
    await page.evaluate(async ({ avatar }) => {
        const context = window.SillyTavern.getContext();
        if (!context.characters.length) {
            await context.getCharacters();
        }
        const index = context.characters.findIndex(character => character.avatar === avatar);
        if (index < 0) {
            throw new Error(`The audit character ${avatar} is not on the server.`);
        }
        if (Number(context.characterId) === index && document.querySelector('#chat > .mes')) {
            return;
        }
        await context.selectCharacterById(index, { switchMenu: false });
    }, { avatar: FIXTURES.character.avatar });
    await dismissDialogs(page);
    await page.locator('#chat > .mes').first().waitFor({ state: 'visible' });
    // The chat renders again after its first paint (swipe controls, avatars), and a menu closes when its trigger is replaced.
    await page.evaluate(() => new Promise((resolve) => {
        const chat = document.getElementById('chat');
        let timer = setTimeout(done, 400);
        const cap = setTimeout(done, 5000);
        const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(done, 400);
        });
        observer.observe(chat, { subtree: true, childList: true, attributes: true });
        function done() {
            clearTimeout(timer);
            clearTimeout(cap);
            observer.disconnect();
            resolve();
        }
    }));
    await settle(page);
}

/**
 * Opens the Conversation workspace for the audit character. The thread is saved first, so that the timeline has messages
 * whatever the server holds.
 */
export async function openAuditConversation(page) {
    if (await page.locator('#sheld[data-sb-conversation-mode="on"] #sb_conversation_timeline .sb-conversation-message').count()) {
        return;
    }
    await page.evaluate(async ({ avatar, messages }) => {
        const context = window.SillyTavern.getContext();
        if (!context.characters.length) {
            await context.getCharacters();
        }
        const index = context.characters.findIndex(character => character.avatar === avatar);
        if (index < 0) {
            throw new Error(`The audit character ${avatar} is not on the server.`);
        }
        await context.selectCharacterById(index, { switchMenu: false });
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
        const { saveConversationThread } = await import('/scripts/sillybunny-conversation/thread-store.js');
        const day = Date.UTC(2026, 0, 1, 12, 0, 0);
        saveConversationThread(avatar, messages.map((text, number) => ({
            id: `audit-${number}`, role: number % 2 === 0 ? 'character' : 'user', name: number % 2 === 0 ? 'Audit Character' : 'Audit User',
            mes: text, send_date: new Date(day + number * 60_000).toISOString(), created_at: day + number * 60_000, extra: {},
        })));
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        if (!openConversationWorkspaceForAvatar(avatar, { showToast: false, enable: true })) {
            throw new Error(`Could not open the Conversation workspace for ${avatar}.`);
        }
    }, { avatar: FIXTURES.character.avatar, messages: FIXTURES.chat.messages });
    await page.locator('#sheld[data-sb-conversation-mode="on"]').waitFor({ state: 'visible' });
    await page.locator('#sb_conversation_timeline .sb-conversation-message').first().waitFor({ state: 'visible' });
    await settle(page);
}

/**
 * Shows one page of the Conversation workspace. A desktop window shows the rail and the chat together; the pages layout
 * of a phone shows one at a time.
 * @param {import('@playwright/test').Page} page
 * @param {'chat' | 'pals'} wanted `pals` is the rail of conversations, with the status and new-conversation buttons.
 */
export async function showConversationPage(page, wanted) {
    const sheld = page.locator('#sheld');
    if (await sheld.getAttribute('data-sb-conversation-layout') !== 'pages' || await sheld.getAttribute('data-sb-conversation-page') === wanted) {
        return;
    }
    if (wanted === 'pals') {
        await page.locator('#sb_conversation_pals_toggle').click();
    } else {
        await page.locator('.sb-conversation-pal').first().click();
    }
    await page.waitForFunction(value => document.getElementById('sheld')?.getAttribute('data-sb-conversation-page') === value, wanted);
    await settle(page);
}

/** Opens the list of the Characters shell and waits until it is mounted. */
export async function openCharacterList(page) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'characters'));
    await page.locator('.sb-character-list[data-mounted="true"]').waitFor({ state: 'visible' });
    await page.locator('.sb-character-list .character_select').first().waitFor({ state: 'visible' });
    await settle(page);
}

/** A menu item of the open action menu, clicked by its accessible name; it opens no overlay of its own. */
export async function pickItem(page, name) {
    await page.locator('.sb-action-menu').last().getByRole('menuitem', { name, exact: true }).click();
}

/**
 * Opens the Characters list menu and clicks one of its items, which opens a manager dialog (Manage tags, Manage Folders).
 * @param {string} item
 * @param {string} dialogRoot The selector of the manager that the item opens.
 */
export async function openManagerFromList(page, item, dialogRoot) {
    if (await page.locator(dialogRoot).first().isVisible()) {
        return;
    }
    await openCharacterList(page);
    await openFrom(page, '.sb-character-list [data-action-id="more"]');
    await pickItem(page, item);
    await page.locator(dialogRoot).first().waitFor({ state: 'visible' });
    await settleOverlay(page, dialogRoot);
}

/**
 * Opens Chat History, the Window that lists the chat files of the open chat: a desktop window has the chat bar's actions,
 * a phone opens them from the chat chip.
 */
export async function openChatHistory(page) {
    await openAuditChat(page);
    if (await page.locator('.sb-chat-history-dialog').first().isVisible()) {
        return;
    }
    const paged = page.viewportSize().width <= 768;
    if (paged) {
        await page.locator('.sb-bottom-chat-chip').click();
    }
    const actions = page.locator(paged ? '#sb-bottom-chat-sheet .sb-bottom-chat-sheet-actions' : '#sb-bottom-chat-bar .sb-bottom-chat-management-actions');
    await actions.getByRole('button', { name: 'View chat files', exact: true }).click();
    await page.locator('.sb-chat-history-dialog').first().waitFor({ state: 'visible' });
    await page.locator('.sb-chat-history-row').first().waitFor({ state: 'visible' });
    await settleOverlay(page, '.sb-chat-history-dialog');
}

/** Opens the World Info tab with the audit lorebook loaded, by picking it in the book select that the editor reads. */
export async function openAuditLorebook(page) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'world-info'));
    await page.locator('#WorldInfo .sb-wi-book-actions').waitFor({ state: 'visible' });
    if (!await page.locator('#WorldInfo .sb-wi-row').first().isVisible()) {
        await page.evaluate(({ name }) => {
            const select = document.getElementById('world_editor_select');
            const option = [...select.options].find(candidate => candidate.text === name);
            if (!option) {
                throw new Error(`The audit lorebook ${name} is not in the book list.`);
            }
            select.value = option.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }, { name: FIXTURES.lorebook.name });
        await page.locator('#WorldInfo .sb-wi-row').first().waitFor({ state: 'visible' });
    }
    await settle(page);
}

/**
 * Opens the detail of the audit persona in the Persona tab. The editor finds the persona's page of the list itself, so the
 * step does not depend on how many personas the list holds.
 */
export async function openAuditPersona(page) {
    await openPersonaEditorEntry(page);
    await page.locator('#PersonaManagement .sb-persona-lorebook-picker').first().waitFor({ state: 'visible' });
    await settle(page);
}

/**
 * Opens the group editor of the audit group, as the Groups list does: through the object navigation of the Characters shell.
 */
export async function openAuditGroupEditor(page) {
    if (await page.locator('#rm_group_members .group_member').first().isVisible()) {
        return;
    }
    await page.waitForFunction(async () => (await import('/scripts/group-chats.js')).groups.length > 0);
    await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'groups'));
    await page.locator('.sb-character-list[data-mounted="true"]').waitFor({ state: 'visible' });
    await page.evaluate(async ({ name }) => {
        const groupChats = await import('/scripts/group-chats.js');
        const group = groupChats.groups.find(candidate => candidate.name === name);
        if (!group) {
            throw new Error(`The audit group ${name} is not on the server.`);
        }
        const { objectNavigation } = await import('/scripts/sillybunny-editor/object-navigation.js');
        await objectNavigation.navigate({ kind: 'group-editor', id: String(group.id), via: 'group-list' }, { from: () => ({ kind: 'group-list' }) });
    }, { name: FIXTURES.group.name });
    await page.locator('#rm_group_members .group_member').first().waitFor({ state: 'visible' });
    await settle(page);
}

/** Opens Backend > Editor on the Chat Completion backend, where the prompt list is. */
export async function openPromptEditor(page) {
    await selectBackend(page, 'chat-completion');
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'editor'));
    await page.locator('[data-sb-panel="editor"]').waitFor({ state: 'visible' });
    await page.locator('.sb-prompt-row[data-prompt-id="main"]').waitFor({ state: 'visible' });
    await settle(page);
}

/** Opens the detail of the Main prompt: a pane beside the list on a desktop window, a page of its own on a phone. */
export async function openPromptDetail(page) {
    await openPromptEditor(page);
    if (!await page.locator('.sb-prompt-detail').first().isVisible()) {
        await page.locator('.sb-prompt-row[data-prompt-id="main"] .sb-prompt-row-name').click();
    }
    await page.locator('#sb-prompt-form_name').waitFor({ state: 'visible' });
    await page.locator('.sb-list-editor__detail--travelling').waitFor({ state: 'detached' });
    await settle(page);
}

/**
 * Shows the Role and Triggers properties of the Main prompt: inline in a wide detail pane, and in the Prompt properties sheet
 * that the summary button opens in a narrow one.
 */
export async function openPromptProperties(page) {
    await openPromptDetail(page);
    if (!await page.locator('.sb-prompt-properties button[aria-label="Role"]').filter({ visible: true }).count()) {
        await page.locator('.sb-prompt-property-summary').click();
        await page.locator('.sb-prompt-properties-dialog').first().waitFor({ state: 'visible' });
        await settleOverlay(page, '.sb-prompt-properties-dialog');
    }
}

/** Closes a prompt editor popover with Escape, as its own keydown handler does, and waits until it has left. */
export async function closePromptPopover(page) {
    await page.keyboard.press('Escape');
    await page.locator('.sb-prompt-popover:not([inert])').first().waitFor({ state: 'hidden' });
}

/** Opens the Extensions manager Window from Customize > Extensions. */
export async function openExtensionsManager(page) {
    if (await page.locator('.extensions-header-menus').first().isVisible()) {
        return;
    }
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'extensions'));
    await page.locator('#extensions_details').waitFor({ state: 'visible' });
    await page.locator('#extensions_details').click();
    await page.locator('.extensions-header-menus').first().waitFor({ state: 'visible' });
    await settleOverlay(page, '.extensions-header-menus');
}

/** Opens the Data Bank Window of the open chat's character. */
export async function openDataBank(page) {
    await openAuditChat(page);
    if (!await page.locator('.dataBankAttachments').first().isVisible()) {
        await page.locator('#manageAttachments').dispatchEvent('click');
        await page.locator('.dataBankAttachments').first().waitFor({ state: 'visible' });
    }
    await page.locator('.attachmentListItem').first().waitFor({ state: 'visible' });
    await settleOverlay(page, '.dataBankAttachments');
}

/** Opens the Agents page of the Backend shell and waits for its header. */
export async function openAgentList(page) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'agents'));
    await page.locator('.ica-agents-editor [data-action-id="add"]').waitFor({ state: 'visible' });
    await page.locator('.ica-agents-editor [data-saved="true"]').first().waitFor({ state: 'visible' });
    await settle(page);
}

/** Opens a saved agent in the detail pane of the Agents tab. */
export async function openAgentEditor(page, agentId) {
    await openAgentList(page);
    await page.locator(`.ica-agents-editor [data-sb-list-key="agent:${agentId}"]`).evaluate(node => node.click());
    await page.locator('.ica-agents-editor .ica-agent-detail .sb-persona-entry-header').waitFor({ state: 'visible' });
    await settle(page);
}

export const ARCHIVE_MENU_BUTTON = '.sbca-dialog .sb-dialog__header:visible .sb-dialog__menu';

/**
 * Opens the Chats Archive and shows its chat list: the archive
 * keeps a sidebar and a list side by side on a wide frame, and on a narrow one the list is a pushed page.
 */
export async function openArchiveList(page) {
    if (!await page.locator('.sbca-dialog').first().isVisible()) {
        await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'characters'));
        await page.locator('#sbca_drawer_button').waitFor({ state: 'visible' });
        await page.locator('#sbca_drawer_button').click();
        await page.locator('.sbca-dialog').first().waitFor({ state: 'visible' });
        await page.waitForFunction(() => !document.querySelector('.sbca-dialog[opening]'));
    }
    if (!await page.locator('.sbca-row').first().isVisible()) {
        await page.locator('.sbca-location').first().waitFor({ state: 'visible' });
        await page.locator('.sbca-location').first().click();
    }
    await page.locator('.sbca-row').first().waitFor({ state: 'visible' });
    // The archive goes on loading after its first rows and moves focus as it does, and a popover closes when focus leaves it.
    await page.waitForFunction(() => !/Searching source/.test(document.querySelector('.sbca-dialog')?.innerText ?? ''), null, { timeout: 15_000 });
    await settle(page);
}

/** Puts the Chats Archive list into selection mode with its first chat selected. */
export async function openArchiveSelection(page) {
    await openArchiveList(page);
    if (!await page.locator('.sbca-selection-bar').first().isVisible()) {
        await openFrom(page, ARCHIVE_MENU_BUTTON);
        await pickItem(page, 'Select Chats');
        await page.locator('.sbca-row').first().click();
        await page.locator('.sbca-selection-bar').first().waitFor({ state: 'visible' });
        await settle(page);
    }
}

/**
 * Opens the editor of the audit character in the Characters shell.
 */
export async function openAuditCharacterEditor(page) {
    if (await page.locator('#sb_character_editor_header').isVisible()) {
        return;
    }
    await page.evaluate(async () => {
        window.sbMenuApp = await import('/script.js');
    });
    await page.waitForFunction(() => window.sbMenuApp.characters.length > 0);
    await page.locator('#sb-character-toggle').click();
    await page.evaluate(({ avatar }) => {
        const index = window.sbMenuApp.characters.findIndex(character => character.avatar === avatar);
        window.sbMenuApp.setCharacterId(index);
        window.sbMenuApp.select_selected_character(index);
    }, { avatar: FIXTURES.character.avatar });
    await page.locator('#sb_character_editor_header').waitFor({ state: 'visible' });
    await settle(page);
}
