/**
 * The menu family: action menus, popovers, the shared picker, and the menus that are not built on them.
 *
 * Every surface below is one menu, whichever place opens it. A menu of the shared helpers is a popover beside its trigger
 * on a desktop window and a bottom sheet under the overlay breakpoint, so its root is a selector list that matches the form
 * of the size (`MENU_ROOT`, `PICKER_ROOT`, `POPOVER_ROOT`) and the entry has no second copy for the phone.
 */

import {
    ARCHIVE_MENU_BUTTON, chooseItem, closeComposerSheets, openAuditLorebook, openAuditPersona, closeAndWait, MENU_ROOT, openAgentEditor, openAgentList, openArchiveList, openArchiveSelection, openAuditCharacterEditor, openAuditChat,
    openAuditConversation, openAuditGroupEditor, openCharacterList, openChatHistory, openDataBank, openExtensionsManager, openFrom, openManagerFromList,
    openLegacyToggle, openPromptDetail, openPromptEditor, openPromptProperties, PICKER_ROOT, POPOVER_ROOT, settleFade, settleOverlay, showConversationPage,
} from './menu-steps.js';
import { FIXTURES } from './fixture-data.js';
import { characterSearch, openSearch } from './list-steps.js';
import { openCharactersTab, openSettingsTab, selectBackend, settle } from './steps.js';

const SCRIPTS = 'public/scripts';
const ARCHIVE = `${SCRIPTS}/extensions/sillybunny-chats-archive/src/ui`;
/** The matrix sizes with a touch pointer, and the ones with a mouse. */
const COARSE_VIEWPORTS = ['768x1024', '844x390', '820x360', '390x844', '360x640', '360x294', '320x568'];
/** The matrix sizes up to 450px wide, where every extension row folds its actions into a menu. */
const SMALL_VIEWPORTS = ['390x844', '360x640', '360x294', '320x568'];
/** The open list of a jQuery UI autocomplete. A closed one keeps an inline `display: none`; `:visible` is not valid for the settle step. */
const AUTOCOMPLETE = '.ui-autocomplete:not([style*="display: none"])';
const SELECT2_DROPDOWN = '.select2-dropdown';
const CSS = 'public/css';
/** An input of a custom popover, in both forms. */
const POPOVER_INPUT = '.sb-custom-popover input, .sb-action-sheet:not([hidden]) input';
/** A row of an action menu with this text: names the target menu when a parent menu is open on the way to it. */
const menuItemWith = text => `.sb-action-menu [role^="menuitem"]:has-text("${text}")`;
const HOME_MENU_BUTTON = '#chat > .welcomePanel .sbHomeMenuButton';
const TAG_MANAGER = '#tag_view_list';
const FOLDER_MANAGER = '.sb-dialog-host[open]:has(> .sb-folder-manager)';
const ACTION_MENU = `${SCRIPTS}/sillybunny-action-menu.js`;
const READY = { [MENU_ROOT]: '.sb-action-menu [role^="menuitem"]', [PICKER_ROOT]: '.sb-picker__option' };
const PICKER = `${SCRIPTS}/sillybunny-editor/picker.js`;
const MODEL_ROW_TRIGGER = '.sb-connections-panel .ds-select-row:has(#model_openrouter_select) .ds-select-row__trigger';
/** The models that a connected backend lists, as `[id, name]`. */
const MODELS = [['audit/model-alpha', 'Audit Model Alpha'], ['audit/model-beta', 'Audit Model Beta'], ['audit/model-gamma', 'Audit Model Gamma'], ['audit/model-delta', 'Audit Model Delta']];

/**
 * @param {object} entry
 * @param {string} entry.id The last segments of the id, after `menu.`.
 * @param {string} [entry.root]
 * @returns {import('./index.js').Surface}
 */
function menu({ id, title, owner = 'A', root = MENU_ROOT, close, ...rest }) {
    return {
        id: `menu.${id}`,
        family: 'menu',
        owner,
        title,
        root,
        // An open menu or picker with no rows would be an open shell with nothing in it.
        ...(READY[root] && { ready: READY[root] }),
        close: close ?? (page => closeAndWait(page, root)),
        needs: [],
        ...rest,
    };
}

/** @type {import('./index.js').Surface[]} */
export const surfaces = [
    menu({
        id: 'message.roleplay',
        title: 'Message menu (chat)',
        needs: ['chat'],
        sources: [`${SCRIPTS}/sillybunny-message-actions.js`, ACTION_MENU],
        async open(page) {
            await openAuditChat(page);
            // The composer takes focus once the chat has loaded, and a popover closes when focus moves away from it.
            await page.locator('#send_textarea').focus();
            await openFrom(page, '#chat > .mes[mesid="2"] .mes_buttons > .extraMesButtonsHint');
        },
        primaryFlow: true,
    }),
    menu({
        id: 'message.conversation',
        title: 'Message menu (Conversation)',
        needs: ['character'],
        sources: [`${SCRIPTS}/sillybunny-conversation/message-menu.js`, ACTION_MENU],
        async open(page) {
            await openAuditConversation(page);
            await showConversationPage(page, 'chat');
            const message = page.locator('#sb_conversation_timeline .sb-conversation-message').nth(2);
            await message.hover();
            await message.locator(':is(.sb-conversation-message-menu, .sb-conversation-mobile-menu-trigger)').filter({ visible: true }).first().click();
            await settleOverlay(page, MENU_ROOT);
        },
        primaryFlow: true,
    }),
    ...[
        ['overflow', 'Conversation menu', 'open-conversation-menu', 'chat'],
        ['composer', 'Conversation composer menu (Add to message)', 'open-composer-menu', 'chat'],
        ['status', 'Conversation status and persona menu', 'open-persona-menu', 'list'],
        ['new', 'New conversation menu', 'open-new-menu', 'list'],
        ['main', 'Conversation list main menu', 'open-main-menu', 'list'],
    ].map(([id, title, action, workspacePage]) => menu({
        id: `conversation.${id}`,
        title,
        needs: ['character'],
        sources: [`${SCRIPTS}/sillybunny-conversation/chrome.js`, `${SCRIPTS}/sillybunny-conversation/conversation-menus.js`, ACTION_MENU],
        async open(page) {
            await openAuditConversation(page);
            await showConversationPage(page, workspacePage);
            await openFrom(page, `[data-sb-conversation-action="${action}"]`);
        },
    })),
    menu({
        id: 'conversation.row',
        title: 'Conversation row menu (secondary click)',
        needs: ['character'],
        sources: [`${SCRIPTS}/sillybunny-conversation/conversation-menus.js`, `${SCRIPTS}/sillybunny-conversation/conversation-list-controls.js`, ACTION_MENU],
        async open(page) {
            await openAuditConversation(page);
            await showConversationPage(page, 'list');
            await page.locator('#sb_conversation_list_items .sb-conversation-list-item').filter({ visible: true }).first().click({ button: 'right' });
            await settleOverlay(page, MENU_ROOT);
        },
    }),
    menu({
        id: 'character-list.actions',
        title: 'Character list menu (More)',
        needs: ['character', 'tags', 'folders'],
        sources: [`${SCRIPTS}/sillybunny-character-list.js`, ACTION_MENU],
        async open(page) {
            await openCharacterList(page);
            await openFrom(page, '.sb-character-list [data-action-id="more"]');
        },
    }),
    menu({
        id: 'character-list.sort',
        title: 'Character list sort and view menu',
        ready: menuItemWith('Least tokens'),
        needs: ['character'],
        sources: [`${SCRIPTS}/sillybunny-character-list.js`, ACTION_MENU],
        async open(page) {
            await openCharacterList(page);
            // The Sort button ends the search bar, so the bar opens first.
            await openSearch(page, characterSearch);
            await openFrom(page, '.sb-character-list__sort');
        },
    }),
    menu({
        id: 'character-list.row',
        title: 'Character row menu',
        needs: ['character'],
        sources: [`${SCRIPTS}/sillybunny-character-list.js`, ACTION_MENU],
        async open(page) {
            await openCharacterList(page);
            await openFrom(page, '.sb-character-list .character_select [aria-label^="Actions for"]');
        },
    }),
    menu({
        id: 'character-editor.export',
        title: 'Character editor export menu',
        ready: menuItemWith('JSON'),
        needs: ['character'],
        sources: [`${SCRIPTS}/sillybunny-character-editor.js`, ACTION_MENU],
        async open(page) {
            await openAuditCharacterEditor(page);
            if (await page.locator('#export_button').isVisible()) {
                await openFrom(page, '#export_button');
            } else {
                await openFrom(page, '#sb_character_editor_more');
                await chooseItem(page, 'Export and Download');
            }
        },
    }),
    menu({
        id: 'picker.tag-filter',
        title: 'Tag filter picker (character list)',
        root: PICKER_ROOT,
        needs: ['character', 'tags'],
        sources: [`${SCRIPTS}/sillybunny-editor/tag-filter-menu.js`, PICKER],
        async open(page) {
            await openCharacterList(page);
            await openFrom(page, '.sb-character-list .sb-tag-filter-menu-button', PICKER_ROOT);
        },
        states: [{
            id: 'selected',
            ready: '.sb-picker__option[aria-selected="true"]',
            async open(page) {
                await page.locator('.sb-picker__option').nth(0).click();
                await page.locator('.sb-picker__option').nth(1).click();
                await settleOverlay(page, PICKER_ROOT);
            },
        }],
    }),
    menu({
        id: 'home.main',
        title: 'Home main menu',
        needs: [],
        sources: [`${SCRIPTS}/sillybunny-home/menu.js`, ACTION_MENU],
        async open(page) {
            await openFrom(page, HOME_MENU_BUTTON);
        },
        primaryFlow: true,
    }),
    menu({
        id: 'home.chat',
        title: 'Home recent chat menu',
        needs: ['chat'],
        sources: [`${SCRIPTS}/sillybunny-home/menu.js`, `${SCRIPTS}/welcome-screen.js`, ACTION_MENU],
        async open(page) {
            await openFrom(page, '#chat > .welcomePanel .recentChat .chatMenu');
        },
    }),
    menu({
        id: 'home.assistant',
        title: 'Home assistant card menu',
        needs: [],
        sources: [`${SCRIPTS}/sillybunny-home/menu.js`, `${SCRIPTS}/sillybunny-home/assistants-view.js`, ACTION_MENU],
        async open(page) {
            await openFrom(page, '#chat > .welcomePanel .sbHomeRowMenu');
        },
    }),
    menu({
        id: 'chat-history.menu',
        title: 'Chat History menu',
        needs: ['chat'],
        sources: [`${SCRIPTS}/sillybunny-chat-dialogs.js`, ACTION_MENU],
        async open(page) {
            await openChatHistory(page);
            await openFrom(page, '.sb-chat-history-menu');
        },
    }),
    menu({
        id: 'chat-history.export',
        title: 'Chat History row menu (chat row)',
        needs: ['chat'],
        sources: [`${SCRIPTS}/sillybunny-chat-dialogs.js`, ACTION_MENU],
        async open(page) {
            await openChatHistory(page);
            await openFrom(page, '.sb-chat-history-row-menu');
        },
    }),
    menu({
        id: 'persona.list',
        title: 'Persona list menu',
        needs: ['persona'],
        sources: [`${SCRIPTS}/sillybunny-persona-editor.js`, ACTION_MENU],
        async open(page) {
            await openCharactersTab(page, 'persona');
            await openFrom(page, '#PersonaManagement .sb-persona-list-menu');
        },
    }),
    menu({
        id: 'world-info.book',
        title: 'World Info book menu',
        needs: ['lorebook', 'lorebook-used-by'],
        sources: [`${SCRIPTS}/sillybunny-world-info-editor.js`, ACTION_MENU],
        async open(page) {
            await openAuditLorebook(page);
            await openFrom(page, '#WorldInfo .sb-wi-book-actions');
        },
        states: [{
            id: 'used-by-picker',
            root: PICKER_ROOT,
            ready: '.sb-picker__option:has-text("Audit Persona")',
            async open(page) {
                await chooseItem(page, 'Used By…', PICKER_ROOT);
            },
        }],
    }),
    menu({
        id: 'world-info.entry',
        title: 'World Info entry menu',
        needs: ['lorebook'],
        sources: [`${SCRIPTS}/sillybunny-world-info-editor.js`, ACTION_MENU],
        async open(page) {
            await openAuditLorebook(page);
            await openFrom(page, '#WorldInfo .sb-wi-row-menu');
        },
        states: [{
            id: 'move-picker',
            root: PICKER_ROOT,
            ready: READY[PICKER_ROOT],
            async open(page) {
                await chooseItem(page, 'Move/Copy', PICKER_ROOT);
            },
        }],
    }),
    menu({
        id: 'persona.row',
        title: 'Persona row menu',
        needs: ['persona'],
        sources: [`${SCRIPTS}/sillybunny-persona-editor.js`, ACTION_MENU],
        async open(page) {
            await openCharactersTab(page, 'persona');
            await openFrom(page, '#PersonaManagement .sb-persona-row-menu');
        },
    }),
    menu({
        id: 'picker.persona-lorebook',
        title: 'Persona lorebook picker',
        root: PICKER_ROOT,
        needs: ['persona', 'lorebook'],
        sources: [`${SCRIPTS}/sillybunny-persona-detail.js`, PICKER],
        async open(page) {
            await openAuditPersona(page);
            await openFrom(page, '#PersonaManagement .sb-persona-lorebook-picker', PICKER_ROOT);
        },
    }),
    menu({
        id: 'editor-chrome.more',
        title: 'Editor header overflow menu (character editor)',
        needs: ['character'],
        ready: menuItemWith('Set / Unset as Welcome Page Assistant'),
        sources: [`${SCRIPTS}/sillybunny-editor/chrome.js`, ACTION_MENU],
        async open(page) {
            await openAuditCharacterEditor(page);
            await openFrom(page, '#sb_character_editor_more');
        },
    }),
    menu({
        id: 'picker.world-info-books',
        title: 'World Info book picker',
        root: PICKER_ROOT,
        needs: ['lorebook'],
        sources: [`${SCRIPTS}/sillybunny-world-info-editor.js`, PICKER],
        async open(page) {
            await openCharactersTab(page, 'world-info');
            await openFrom(page, '#WorldInfo .sb-wi-book-switcher', PICKER_ROOT);
        },
    }),
    menu({
        id: 'tag-manager.header',
        title: 'Tag Manager header menu',
        needs: ['character', 'tags'],
        sources: [`${SCRIPTS}/sillybunny-tag-manager.js`, ACTION_MENU],
        async open(page) {
            await openManagerFromList(page, 'Manage Tags', TAG_MANAGER);
            await openFrom(page, `${TAG_MANAGER} .sb-dialog__menu`);
        },
    }),
    menu({
        id: 'tag-manager.sort',
        title: 'Tag Manager sort menu',
        ready: menuItemWith('Most Used (By Count)'),
        needs: ['character', 'tags'],
        sources: [`${SCRIPTS}/sillybunny-tag-manager.js`, ACTION_MENU],
        async open(page) {
            await openManagerFromList(page, 'Manage Tags', TAG_MANAGER);
            // The Sort button ends the manager's search bar, so the bar opens first.
            await openSearch(page, { input: `${TAG_MANAGER} .sb-dialog__search-input`, toggle: `${TAG_MANAGER} .sb-dialog__search-toggle` });
            await openFrom(page, `${TAG_MANAGER} .sb-tag-manager__sort`);
        },
    }),
    menu({
        id: 'tag-manager.row',
        title: 'Tag Manager tag menu',
        needs: ['character', 'tags'],
        sources: [`${SCRIPTS}/sillybunny-tag-manager.js`, ACTION_MENU],
        async open(page) {
            await openManagerFromList(page, 'Manage Tags', TAG_MANAGER);
            await openFrom(page, `${TAG_MANAGER} .sb-tag-manager__row-menu`);
        },
    }),
    menu({
        id: 'tag-manager.new-tag',
        title: 'Tag Manager new tag popover',
        root: POPOVER_ROOT,
        ready: POPOVER_INPUT,
        needs: ['character', 'tags'],
        sources: [`${SCRIPTS}/sillybunny-tag-manager.js`, ACTION_MENU],
        async open(page) {
            await openManagerFromList(page, 'Manage Tags', TAG_MANAGER);
            await openFrom(page, `${TAG_MANAGER} .sb-tag-manager__add`, POPOVER_ROOT);
        },
    }),
    menu({
        id: 'picker.tag-manager-members',
        title: 'Tag Manager add member picker',
        root: PICKER_ROOT,
        needs: ['character', 'tags', 'characters-many'],
        sources: [`${SCRIPTS}/sillybunny-tag-manager.js`, PICKER],
        async open(page) {
            await openManagerFromList(page, 'Manage Tags', TAG_MANAGER);
            if (!await page.locator(`${TAG_MANAGER} .sb-tag-manager__member-add`).isVisible()) {
                const row = page.locator(`${TAG_MANAGER} .tag_view_item`).first();
                await row.focus();
                await page.keyboard.press('Enter');
                await page.locator(`${TAG_MANAGER} .sb-tag-manager__member-add`).waitFor({ state: 'visible' });
                await settle(page);
            }
            await openFrom(page, `${TAG_MANAGER} .sb-tag-manager__member-add`, PICKER_ROOT);
        },
    }),
    menu({
        id: 'folder-manager.folder',
        title: 'Folder Manager folder menu',
        needs: ['character', 'folders'],
        sources: [`${SCRIPTS}/sillybunny-folder-manager.js`, ACTION_MENU],
        async open(page) {
            await openManagerFromList(page, 'Manage Folders', FOLDER_MANAGER);
            await openFrom(page, `${FOLDER_MANAGER} .sb-folder-manager__row-menu`);
        },
    }),
    menu({
        id: 'folder-manager.new-folder',
        title: 'Folder Manager new folder popover',
        root: POPOVER_ROOT,
        ready: POPOVER_INPUT,
        needs: ['character', 'folders'],
        sources: [`${SCRIPTS}/sillybunny-folder-manager.js`, ACTION_MENU],
        async open(page) {
            await openManagerFromList(page, 'Manage Folders', FOLDER_MANAGER);
            await openFrom(page, `${FOLDER_MANAGER} .sb-folder-manager__add`, POPOVER_ROOT);
        },
    }),
    menu({
        id: 'picker.folder-manager-members',
        title: 'Folder Manager add to folder picker',
        root: PICKER_ROOT,
        needs: ['character', 'folders'],
        sources: [`${SCRIPTS}/sillybunny-folder-manager.js`, PICKER],
        async open(page) {
            await openManagerFromList(page, 'Manage Folders', FOLDER_MANAGER);
            if (!await page.locator(`${FOLDER_MANAGER} .sb-folder-manager__add-member`).isVisible()) {
                await page.locator(`${FOLDER_MANAGER} .sb-folder-manager__count`).first().click();
                await page.locator(`${FOLDER_MANAGER} .sb-folder-manager__add-member`).waitFor({ state: 'visible' });
                await settle(page);
            }
            await openFrom(page, `${FOLDER_MANAGER} .sb-folder-manager__add-member`, PICKER_ROOT);
        },
    }),
    menu({
        id: 'picker.preset',
        title: 'Preset picker (select row)',
        root: PICKER_ROOT,
        needs: [],
        sources: [`${SCRIPTS}/sillybunny-editor/select-row.js`, `${SCRIPTS}/sillybunny-tabs.js`, PICKER],
        async open(page) {
            await selectBackend(page, 'chat-completion');
            await openSettingsTab(page, { shell: 'left', tab: 'prompting' });
            await openFrom(page, '[data-sb-panel="prompting"] [data-sb-preset-row] .ds-select-row__trigger', PICKER_ROOT);
        },
    }),
    menu({
        id: 'preset.menu',
        title: 'Preset menu (profile row)',
        needs: [],
        sources: [`${SCRIPTS}/sillybunny-editor/select-row.js`, `${SCRIPTS}/sillybunny-tabs.js`, ACTION_MENU],
        async open(page) {
            await selectBackend(page, 'chat-completion');
            await openSettingsTab(page, { shell: 'left', tab: 'prompting' });
            await openFrom(page, '[data-sb-panel="prompting"] [data-sb-preset-row] .ds-select-row__menu');
        },
    }),
    menu({
        id: 'connections.profile-menu',
        title: 'Connection profile menu',
        needs: ['connection-profile'],
        sources: [`${SCRIPTS}/sillybunny-connections-panel.js`, ACTION_MENU],
        async open(page) {
            await openSettingsTab(page, { shell: 'left', tab: 'connections' });
            await openFrom(page, '.sb-connections-panel .ds-profile-row .ds-select-row__menu');
        },
    }),
    menu({
        id: 'picker.connection-profile',
        title: 'Connection profile picker (profile row)',
        root: PICKER_ROOT,
        needs: ['connection-profile'],
        sources: [`${SCRIPTS}/sillybunny-connections-panel.js`, `${SCRIPTS}/sillybunny-editor/select-row.js`, PICKER],
        async open(page) {
            await openSettingsTab(page, { shell: 'left', tab: 'connections' });
            await openFrom(page, '.sb-connections-panel .ds-profile-row .ds-select-row__trigger', PICKER_ROOT);
        },
    }),
    menu({
        id: 'group.member',
        title: 'Group member menu',
        upstreamMarkup: true,
        needs: ['character', 'group'],
        sources: [`${SCRIPTS}/group-chats.js`, ACTION_MENU],
        async open(page) {
            await openAuditGroupEditor(page);
            await openFrom(page, '#rm_group_members .group_member .sb-group-member-menu');
        },
    }),
    menu({
        id: 'prompt-editor.list',
        title: 'Prompt list menu',
        needs: [],
        sources: [`${SCRIPTS}/sillybunny-prompt-editor.js`, ACTION_MENU],
        async open(page) {
            await openPromptEditor(page);
            await openFrom(page, '.sb-prompt-editor button[aria-label="Prompt List Actions"]');
        },
    }),
    menu({
        id: 'prompt-editor.row',
        title: 'Prompt row menu',
        needs: [],
        sources: [`${SCRIPTS}/sillybunny-prompt-editor.js`, ACTION_MENU],
        async open(page) {
            await openPromptEditor(page);
            await openFrom(page, '.sb-prompt-row[data-prompt-id="main"] .sb-prompt-row-menu');
        },
    }),
    menu({
        id: 'prompt-editor.detail',
        title: 'Prompt editor more menu',
        needs: [],
        sources: [`${SCRIPTS}/sillybunny-prompt-editor.js`, ACTION_MENU],
        async open(page) {
            await openPromptDetail(page);
            await openFrom(page, '.sb-prompt-detail button[aria-label="Prompt Actions"]');
        },
    }),
    menu({
        id: 'prompt-editor.role',
        title: 'Prompt role menu',
        needs: [],
        sources: [`${SCRIPTS}/sillybunny-prompt-editor.js`, ACTION_MENU],
        async open(page) {
            await openPromptProperties(page);
            await openFrom(page, '.sb-prompt-properties button[aria-label^="Role:"]');
        },
    }),
    menu({
        id: 'prompt-editor.triggers',
        title: 'Prompt generation triggers popover',
        ready: `${MENU_ROOT} input[type="checkbox"]`,
        needs: [],
        sources: [`${SCRIPTS}/sillybunny-prompt-editor.js`, ACTION_MENU],
        async open(page) {
            await openPromptProperties(page);
            await openFrom(page, '.sb-prompt-properties button[aria-label^="Triggers:"]');
        },
    }),
    menu({
        id: 'extensions.row-actions',
        title: 'Extension row actions menu',
        upstreamMarkup: true,
        needs: [],
        viewports: SMALL_VIEWPORTS,
        sources: [`${SCRIPTS}/sillybunny-extension-actions.js`, ACTION_MENU],
        async open(page) {
            await openSettingsTab(page, { shell: 'right', tab: 'extensions' });
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'extensions'));
            await page.locator('#extensions_details').waitFor({ state: 'visible' });
            // A click of Playwright would scroll the button into view, and with it the page behind the Window.
            await page.locator('#extensions_details').evaluate(button => button.click());
            await page.locator('.extensions_info').first().waitFor({ state: 'visible' });
            await openFrom(page, '.extensions_info .sb-extension-actions-menu');
        },
    }),
    ...[
        ['menu', 'Extensions manager menu', 'Menu'],
        ['sort', 'Extensions manager sort menu', 'Sort'],
    ].map(([id, title, label]) => menu({
        id: `extensions-manager.${id}`,
        title,
        needs: [],
        sources: [`${SCRIPTS}/sillybunny-editor/adapters/extensions-manager-dialog.js`, ACTION_MENU],
        async open(page) {
            await openExtensionsManager(page);
            await openFrom(page, `.extensions-header-menus button[aria-label="${label}"]`);
        },
    })),
    menu({
        id: 'data-bank.sort',
        title: 'Data Bank sort menu',
        needs: ['character', 'databank'],
        sources: [`${SCRIPTS}/sillybunny-editor/adapters/data-bank-dialog.js`, ACTION_MENU],
        async open(page) {
            await openDataBank(page);
            await openFrom(page, '.dataBankAttachments .sb-data-bank-sort, .sb-dialog .sb-data-bank-sort');
        },
    }),
    menu({
        id: 'data-bank.row',
        title: 'Data Bank attachment menu',
        needs: ['character', 'databank'],
        sources: [`${SCRIPTS}/sillybunny-editor/adapters/data-bank-dialog.js`, ACTION_MENU],
        async open(page) {
            await openDataBank(page);
            await openFrom(page, '.attachmentRowMenu');
        },
    }),
    menu({
        id: 'data-bank.add-dropdown',
        title: 'Data Bank attachments dropdown (add sources)',
        owner: 'B',
        root: '.actionButtonsModal',
        ready: '.actionButtonsModal .actionButton',
        needs: ['character', 'databank'],
        sources: [`${SCRIPTS}/chats.js`, `${SCRIPTS}/sillybunny-editor/adapters/data-bank-dialog.js`],
        async open(page) {
            await openDataBank(page);
            await page.locator('.openActionModalButton').filter({ visible: true }).first().click();
            await settleFade(page, '.actionButtonsModal');
        },
        async close(page) {
            await page.evaluate(() => document.body.click());
            await page.locator('.actionButtonsModal').first().waitFor({ state: 'hidden' });
        },
    }),
    menu({
        id: 'composer.options',
        title: 'Options menu (#options)',
        owner: 'B',
        root: '#options',
        ready: '#options #option_toggle_AN',
        needs: ['chat'],
        sources: ['public/index.html', 'public/script.js'],
        async open(page) {
            await openAuditChat(page);
            await openLegacyToggle(page, '#options_button', '#options');
        },
        async close(page) {
            // On a phone the menu is a sheet whose scrim covers its trigger, and a press on the scrim closes it.
            if (await page.locator('[data-sb-menu-sheet]').count()) await closeComposerSheets(page);
            else await page.locator('#options_button').click();
            await page.locator('#options').waitFor({ state: 'hidden' });
        },
        primaryFlow: true,
    }),
    menu({
        id: 'composer.wand',
        title: 'Wand menu (#extensionsMenu)',
        owner: 'B',
        root: '#extensionsMenu',
        ready: '#extensionsMenu #sd_gen',
        needs: ['chat'],
        sources: ['public/scripts/templates/wandMenu.html', `${SCRIPTS}/extensions.js`],
        async open(page) {
            await openAuditChat(page);
            await openLegacyToggle(page, '#extensionsMenuButton', '#extensionsMenu');

        },
        async close(page) {
            await page.evaluate(() => document.documentElement.click());
            await page.locator('#extensionsMenu').waitFor({ state: 'hidden' });
        },
        states: [{
            id: 'image-generation',
            root: '#sd_dropdown',
            ready: '#sd_dropdown #sd_background',
            async open(page) {
                await page.locator('#sd_gen').click();
                await settleFade(page, '#sd_dropdown');
            },
        }],
        primaryFlow: true,
    }),
    menu({
        id: 'quick-reply.context',
        title: 'Quick Reply context menu',
        owner: 'B',
        root: '.ctx-menu',
        ready: '.ctx-menu .ctx-item',
        needs: ['chat', 'quick-replies', 'quick-replies-nested'],
        states: [{
            id: 'submenu',
            root: '.ctx-sub-menu',
            ready: '.ctx-sub-menu .ctx-item',
            async open(page) {
                await page.locator('.ctx-blocker').first().click({ position: { x: 1, y: 1 } });
                await page.locator('.ctx-menu').first().waitFor({ state: 'hidden' });
                await page.locator('#qr--bar .qr--button.qr--hasCtx').last().click({ button: 'right' });
                await settleFade(page, '.ctx-menu');
                // A mouse pointer opens the submenu on hover, and the expander's own click would then fold it again. On a phone the submenu
                // opens under its parent item, so the hover lands on the item at every size. A tap would not hold the submenu here: the
                // emulated touch leaves the mouse where the menu opened, and the submenu closes when that mouse is outside both menus.
                await page.locator('.ctx-menu .ctx-has-children').first().hover();
                await settleFade(page, '.ctx-sub-menu');
            },
        }],
        sources: [`${SCRIPTS}/extensions/quick-reply/src/ui/ctx/ContextMenu.js`, `${SCRIPTS}/extensions/quick-reply/src/QuickReply.js`],
        async open(page) {
            await openAuditChat(page);
            await page.locator('#qr--bar .qr--button.qr--hasCtx').first().waitFor({ state: 'attached' });
            // Only the phone layout has the bottom bar and its tray toggle.
            const trayToggle = page.locator('.sb-bottom-chat-tray-toggle');
            if (await page.locator('html[data-sb-mobile-ui-mode="mobile"]').count()) {
                await trayToggle.waitFor({ state: 'visible' });
            }
            if (await trayToggle.count() && await trayToggle.getAttribute('aria-expanded') !== 'true') {
                await trayToggle.click();
                await settle(page);
            }
            await page.locator('#qr--bar .qr--button.qr--hasCtx').first().click({ button: 'right' });
            await settleFade(page, '.ctx-menu');
        },
        async close(page) {
            await page.locator('.ctx-blocker').first().click({ position: { x: 1, y: 1 } });
            await page.locator('.ctx-menu').first().waitFor({ state: 'hidden' });
            const trayToggle = page.locator('.sb-bottom-chat-tray-toggle[aria-expanded="true"]');
            if (await trayToggle.count()) {
                await trayToggle.click();
            }
        },
    }),
    menu({
        id: 'side-panel.header',
        title: 'Side panel header menu',
        needs: ['chat'],
        sources: [`${SCRIPTS}/sillybunny-editor/side-panel.js`, ACTION_MENU],
        async open(page) {
            await openAuditChat(page);
            if (!await page.locator('.sb-side-panel[data-sb-side-panel-id="floatingPrompt"]').isVisible()) {
                await page.evaluate(() => document.querySelector('#option_toggle_AN').click());
            }
            await page.locator('.sb-side-panel[data-sb-side-panel-id="floatingPrompt"]').waitFor({ state: 'visible' });
            await settle(page);
            await openFrom(page, '.sb-side-panel[data-sb-side-panel-id="floatingPrompt"] .sb-side-panel__menu-trigger');
        },
    }),
    menu({
        id: 'tooltip.press-label',
        title: 'Press-and-hold label (touch tooltip)',
        root: '#sb-press-tooltip:not([hidden])',
        ready: '#sb-press-tooltip:not([hidden])',
        needs: ['chat'],
        viewports: COARSE_VIEWPORTS,
        sources: [`${SCRIPTS}/sillybunny-message-actions.js`],
        async open(page) {
            await openAuditChat(page);
            const point = await page.locator('#chat > .mes[mesid="2"] .mes_edit').evaluate((button) => {
                const box = button.getBoundingClientRect();
                return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
            });
            await page.locator('#chat > .mes[mesid="2"] .mes_edit').dispatchEvent('pointerdown', {
                pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: point.x, clientY: point.y, bubbles: true,
            });
            await settleOverlay(page, '#sb-press-tooltip:not([hidden])');
        },
        async close(page) {
            await page.locator('#chat > .mes[mesid="2"] .mes_edit').dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 7, isPrimary: true, bubbles: true });
            await page.evaluate(() => { document.getElementById('sb-press-tooltip').hidden = true; });
            await page.locator('#sb-press-tooltip:not([hidden])').waitFor({ state: 'hidden' });
        },
    }),
    menu({
        id: 'autocomplete.slash-command',
        title: 'Slash command autocomplete',
        owner: 'B',
        root: '.autoComplete-wrap',
        // An option is `display: contents`, so the box to check is its name.
        ready: '.autoComplete-wrap .item .name',
        needs: ['chat'],
        sources: [`${SCRIPTS}/autocomplete/AutoComplete.js`],
        async open(page) {
            await openAuditChat(page);
            await page.locator('#send_textarea').click();
            await page.locator('#send_textarea').fill('/');
            await settleOverlay(page, '.autoComplete-wrap');
        },
        async close(page) {
            await page.locator('#send_textarea').fill('');
            await page.locator('.autoComplete-wrap').first().waitFor({ state: 'hidden' });
        },
        states: [{
            id: 'filtered',
            ready: '.autoComplete-wrap .item:has-text("genraw") .name',
            async open(page) {
                await page.locator('#send_textarea').fill('/ge');
                await settleOverlay(page, '.autoComplete-wrap');
            },
        }],
    }),
    menu({
        id: 'picker.character-tags',
        title: 'Tags picker (character editor)',
        root: PICKER_ROOT,
        needs: ['character', 'tags'],
        sources: [`${SCRIPTS}/sillybunny-editor/tag-filter-menu.js`, `${SCRIPTS}/sillybunny-editor/select-row.js`, PICKER],
        async open(page) {
            await openAuditCharacterEditor(page);
            await page.locator('#tags_div .sb-tag-field').scrollIntoViewIfNeeded();
            await openFrom(page, '#tags_div .sb-tag-field .ds-select-row__trigger', PICKER_ROOT);
        },
        // The trigger toggles the picker, so a state opens it again only after it closed.
        async close(page) {
            await page.keyboard.press('Escape');
            await page.locator(PICKER_ROOT).first().waitFor({ state: 'hidden' });
        },
        states: [{
            id: 'create',
            ready: '.sb-picker__option:has(.fa-plus)',
            async open(page) {
                await page.locator('.sb-picker__search').fill('A tag that is not there yet');
                await settleOverlay(page, PICKER_ROOT);
            },
        }],
    }),
    menu({
        id: 'picker.connection-model',
        title: 'Model picker (Connections model row)',
        root: PICKER_ROOT,
        needs: [],
        sources: [`${SCRIPTS}/sillybunny-connections-form.js`, `${SCRIPTS}/sillybunny-editor/select-row.js`, PICKER],
        async open(page) {
            await selectBackend(page, 'chat-completion');
            await openSettingsTab(page, { shell: 'left', tab: 'connections' });
            await openFrom(page, MODEL_ROW_TRIGGER, PICKER_ROOT);
        },
        states: [{
            id: 'models-loaded',
            root: PICKER_ROOT,
            ready: '.sb-picker__option:has-text("Audit Model Alpha")',
            async open(page) {
                await closeAndWait(page, PICKER_ROOT);
                await page.route('**/api/backends/chat-completions/status', route => route.fulfill({
                    json: { data: MODELS.map(([id, name]) => ({ id, name, context_length: 128000, pricing: { prompt: '0.0000001', completion: '0.0000002' } })) },
                }));
                // The boot answers key writes with a stub that stores nothing, so the app would find no key and not connect.
                await page.route('**/api/secrets/read', route => route.fulfill({
                    json: { api_key_openrouter: [{ id: 'audit-key', value: '********', label: 'audit', active: true }] },
                }));
                await page.locator('#api_key_openrouter').fill('audit-not-a-real-key');
                const status = page.waitForResponse('**/api/backends/chat-completions/status');
                await page.locator('#api_button_openai').click();
                await status;
                await page.locator('#model_openrouter_select option', { hasText: 'Audit Model Alpha' }).waitFor({ state: 'attached' });
                await openFrom(page, MODEL_ROW_TRIGGER, PICKER_ROOT);
            },
        }],
    }),
    menu({
        id: 'agents.add-menu',
        title: 'Agents add menu',
        needs: ['agents'],
        sources: ['public/scripts/extensions/in-chat-agents/ui/agent-list.js', ACTION_MENU],
        async open(page) {
            await openAgentList(page);
            await openFrom(page, '.ica-agents-editor [data-action-id="add"]');
        },
        states: [{
            id: 'template-picker',
            root: PICKER_ROOT,
            ready: READY[PICKER_ROOT],
            async open(page) {
                await chooseItem(page, 'New Agent From Template…', PICKER_ROOT);
            },
        }],
    }),
    menu({
        id: 'agents.list-menu',
        title: 'Agents menu',
        needs: ['agents'],
        sources: ['public/scripts/extensions/in-chat-agents/ui/agent-list.js', ACTION_MENU],
        async open(page) {
            await openAgentList(page);
            await openFrom(page, '.ica-agents-editor [data-action-id="more"]');
        },
    }),
    menu({
        id: 'agents.row-menu',
        title: 'Agent row menu',
        needs: ['agents'],
        sources: ['public/scripts/extensions/in-chat-agents/ui/agent-list.js', ACTION_MENU],
        async open(page) {
            await openAgentList(page);
            await openFrom(page, '.ica-agents-editor button[aria-label="Agent Menu"]');
        },
    }),
    menu({
        id: 'agents.filter-menu',
        title: 'Agents filter menu',
        needs: ['agents'],
        sources: ['public/scripts/extensions/in-chat-agents/ui/agent-list.js', ACTION_MENU],
        async open(page) {
            await openAgentList(page);
            await page.locator('.ica-agents-editor [data-action-id="search"]').click();
            await openFrom(page, '.ica-agents-editor button[aria-label="Filter Agents"]');
        },
    }),
    menu({
        id: 'chats-archive.view',
        title: 'Chats Archive view menu',
        owner: 'C',
        needs: ['archived-chats'],
        sources: [`${ARCHIVE}/menus.js`, ACTION_MENU],
        async open(page) {
            await openArchiveList(page);
            await openFrom(page, '.sbca-dialog .sbca-view-button');
        },
    }),
    menu({
        id: 'chats-archive.filters',
        title: 'Chats Archive filters popover',
        owner: 'C',
        root: POPOVER_ROOT,
        ready: '.sb-custom-popover input[type="checkbox"], .sb-action-sheet:not([hidden]) input[type="checkbox"]',
        needs: ['archived-chats'],
        sources: [`${ARCHIVE}/filters.js`, ACTION_MENU],
        async open(page) {
            await openArchiveList(page);
            await page.locator('.sbca-dialog .sbca-filters-button').filter({ visible: true }).first().click();
            await settleOverlay(page, POPOVER_ROOT);
        },
    }),
    menu({
        id: 'chats-archive.header',
        title: 'Chats Archive header menu',
        owner: 'C',
        needs: ['archived-chats'],
        sources: [`${ARCHIVE}/menus.js`, ACTION_MENU],
        async open(page) {
            await openArchiveList(page);
            await openFrom(page, ARCHIVE_MENU_BUTTON);
        },
        states: [{
            id: 'save-view',
            root: POPOVER_ROOT,
            ready: POPOVER_INPUT,
            async open(page) {
                await chooseItem(page, 'Save Current View…', POPOVER_ROOT);
            },
        }],
    }),
    ...[
        ['favorite', 'Chats Archive selection: Favorite menu', MENU_ROOT],
        ['folder', 'Chats Archive selection: Folder menu', MENU_ROOT],
        ['collections', 'Chats Archive selection: Collections menu', MENU_ROOT],
        ['tags', 'Chats Archive selection: Tags popover', POPOVER_ROOT, POPOVER_INPUT],
    ].map(([action, title, root, ready]) => menu({
        id: `chats-archive.selection-${action}`,
        title,
        owner: 'C',
        root,
        ...(ready && { ready }),
        needs: ['archived-chats'],
        sources: [`${ARCHIVE}/selection.js`, ACTION_MENU],
        async open(page) {
            await openArchiveSelection(page);
            await openFrom(page, `.sbca-selection-bar [data-action-id="${action}"]`, root);
        },
    })),
    menu({
        id: 'chats-archive.download',
        title: 'Chats Archive download menu (viewer)',
        owner: 'C',
        needs: ['archived-chats'],
        sources: [`${ARCHIVE}/viewer.js`, ACTION_MENU],
        async open(page) {
            await openArchiveList(page);
            await page.locator('.sbca-row').first().click();
            await page.locator('.sbca-download:not([disabled])').first().waitFor({ state: 'visible' });
            await openFrom(page, '.sbca-download');
        },
    }),
    ...[
        ['more', 'Agent editor More menu', menuItemWith('Duplicate'), async page => {
            await openFrom(page, '.ica-agent-detail button[aria-label="Agent Actions"]');
        }],
        ['sections', 'Agent editor Sections menu', menuItemWith('Conditions'), async page => {
            if (await page.locator('.ica-agent-detail button[aria-label="Sections"]').filter({ visible: true }).count()) {
                await openFrom(page, '.ica-agent-detail button[aria-label="Sections"]');
            } else {
                await openFrom(page, '.ica-agent-detail button[aria-label="Agent Actions"]');
                await chooseItem(page, 'Sections');
            }
        }],
        ['profile', 'Agent editor connection profile menu', menuItemWith('Connections'), async page => {
            await openFrom(page, '.ica-agent-detail .ds-profile-row .ds-select-row__menu');
        }],
    ].map(([id, title, ready, openMenu]) => menu({
        id: `agent-editor.${id}`,
        title,
        ready,
        needs: ['agents'],
        sources: ['public/scripts/extensions/in-chat-agents/ui/agent-editor.js', 'public/scripts/extensions/in-chat-agents/index.js', ACTION_MENU],
        async open(page) {
            await openAgentEditor(page, FIXTURES.agents.tracker.id);
            await openMenu(page);
        },
    })),
    menu({
        id: 'agent-editor.regex-row',
        title: 'Agent editor regex script menu',
        needs: ['agent-regex-script'],
        sources: ['public/scripts/extensions/in-chat-agents/ui/agent-editor.js', ACTION_MENU],
        async open(page) {
            await openAgentEditor(page, FIXTURES['agent-regex-script'].agent.id);
            await openFrom(page, '.ica-agent-detail .ica-agent-regex-list .ds-row button[aria-label="Regex Script"]');
        },
    }),
    menu({
        id: 'autocomplete.server-history',
        title: 'jQuery UI autocomplete (saved server addresses)',
        owner: 'B',
        root: AUTOCOMPLETE,
        ready: `${AUTOCOMPLETE} .ui-menu-item`,
        needs: ['server-history'],
        sources: [`${SCRIPTS}/server-history.js`],
        async open(page) {
            await selectBackend(page, 'text-completion');
            await openSettingsTab(page, { shell: 'left', tab: 'connections' });
            await page.locator('#textgenerationwebui_api_url_text').click();
            // The blocks of the chosen backend are shown after the page, and they move the field. The list is see-through, so the
            // page behind it is part of what a capture compares, and the field must be raised from a page that has stopped moving.
            await settle(page);
            // Focusing the field scrolls it to the foot of a phone's screen, where its list opens below the fold. Raising the
            // field and asking for the list again puts the list where a user who had scrolled would see it.
            await page.locator('[data-sb-panel="connections"] .sb-shell-panel-scroller').evaluate((scroller, selector) => {
                const input = scroller.querySelector(selector);
                scroller.scrollTop += input.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 120;
                window.$(input).autocomplete('search', '');
            }, '#textgenerationwebui_api_url_text');
            await settleOverlay(page, AUTOCOMPLETE);
        },
        async close(page) {
            await page.locator('#textgenerationwebui_api_url_text').press('Escape');
            await page.locator(AUTOCOMPLETE).first().waitFor({ state: 'hidden' });
        },
    }),
    menu({
        id: 'autocomplete.gallery-folder',
        title: 'jQuery UI autocomplete (gallery folder)',
        owner: 'B',
        root: AUTOCOMPLETE,
        ready: `${AUTOCOMPLETE} .ui-menu-item`,
        needs: ['character', 'chat'],
        sources: [`${SCRIPTS}/extensions/gallery/index.js`],
        async open(page) {
            await page.route('**/api/images/folders', route => route.fulfill({ json: ['audit-folder-a', 'audit-folder-b', 'audit-folder-c'] }));
            await page.route('**/api/images/list', route => route.fulfill({ json: [] }));
            await openAuditChat(page);
            if (!await page.locator('#gallery').count()) {
                await page.evaluate(() => document.getElementById('show_gallery_wand_button').click());
            }
            const input = page.locator('#gallery input[placeholder="Folder Name"]');
            await input.waitFor({ state: 'visible' });
            await settle(page);
            await input.click();
            await settleOverlay(page, AUTOCOMPLETE);
        },
        async close(page) {
            await page.locator('#gallery input[placeholder="Folder Name"]').press('Escape');
            await page.locator(AUTOCOMPLETE).first().waitFor({ state: 'hidden' });
        },
    }),
    menu({
        id: 'select2.extension-dropdown',
        title: 'select2 drop-down (as an extension opens it)',
        owner: 'B',
        root: SELECT2_DROPDOWN,
        ready: `${SELECT2_DROPDOWN} .select2-results__option`,
        needs: [],
        // The app's own selects are adopted by select rows, so a select2 box shows only where an extension builds one. This is a multiple
        // select on the library the app still loads for extensions, and its list is opened the way an extension would open it.
        sources: [`${CSS}/select2-overrides.css`],
        async open(page) {
            await page.evaluate(() => {
                const host = document.createElement('div');
                host.id = 'sb-audit-select2-host';
                host.style.cssText = 'position: fixed; top: 96px; left: 16px; width: min(320px, calc(100vw - 32px)); z-index: 2000;';
                host.innerHTML = '<select id="sb-audit-select2" multiple>'
                    + ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].map((name, index) => `<option value="${name}"${index === 1 ? ' selected' : ''}>${name}</option>`).join('')
                    + '</select>';
                document.body.append(host);
                window.$('#sb-audit-select2').select2({ width: '100%', closeOnSelect: false, placeholder: 'Select items' }).select2('open');
            });
            await settleOverlay(page, SELECT2_DROPDOWN);
        },
        async close(page) {
            await page.evaluate(() => {
                window.$('#sb-audit-select2').select2('destroy');
                document.getElementById('sb-audit-select2-host')?.remove();
            });
            await page.locator(SELECT2_DROPDOWN).first().waitFor({ state: 'hidden' });
        },
    }),
];
