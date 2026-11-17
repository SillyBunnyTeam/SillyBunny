/**
 * The Dialog tier of the dialog family: a form or an action dialog. Most of these are Popups that an adapter in
 * `sillybunny-editor/adapters/` moves into the frame (utility, form, preset and lorebook, account), and the rest are
 * `openDialog` frames (bulk tag edit, the colour picker under the overlay breakpoint).
 *
 * One entry is one layout: rows of entries and spin boxes, a segmented choice, a select row, a list of checks, a form pushed
 * over another dialog. Each is opened from the place a user opens it where that place is reachable without data that the
 * seeded server lacks, and through the module that the place calls where it is not. Nothing is answered: a dialog is left
 * with Escape, which cancels it.
 */

import { FIXTURES } from './fixture-data.js';
import { closeDialogs, closeFrame, closeMenus, DIALOG_FRAME, oncePerPage, openAuditChat, settleFrame, WINDOW_FRAME, within } from './dialog-steps.js';
import { openCharacterEditor } from './header-steps.js';
import { chooseMenuItem, openExtensionsList, openSettingsTab, selectBackend } from './steps.js';

const SCRIPTS = 'public/scripts';
const ADAPTERS = `${SCRIPTS}/sillybunny-editor/adapters`;
const HOME_MENU_BUTTON = '#chat > .welcomePanel .sbHomeMenuButton';
/** The Popup that is on top: a page over its parent is marked, and the parent under it is not the one to read. */
const TOP_POPUP = 'dialog.popup[open]:not([closing]):not([data-sb-covered])';

/**
 * @param {object} entry
 * @param {string} entry.id The last segments of the id, after `dialog.dialog.`.
 * @param {boolean} [entry.upstreamMarkup] Whether the content is upstream's (a form or template of an upstream-origin file that an
 * adapter moves into rows) and SillyBunny supplies the frame; `false` for a dialog that SillyBunny wrote.
 * @returns {import('./index.js').Surface}
 */
function form({ id, root = DIALOG_FRAME, owner = 'A', upstreamMarkup = true, ...rest }) {
    return {
        id: `dialog.dialog.${id}`,
        family: 'dialog',
        owner,
        root,
        close: closeFrame(root),
        needs: [],
        ...(upstreamMarkup && { upstreamMarkup }),
        ...rest,
    };
}

/** Starts a Popup through a module of the app and waits until its frame is open. `start` runs in the page. */
async function openAndSettle(page, root, start, arg) {
    await closeDialogs(page);
    await closeMenus(page);
    await page.evaluate(start, arg);
    await settleFrame(page, root);
}

/**
 * Opens the editor of the audit character and chooses an item of its action menu. The buttons that the app binds these actions
 * to (`#delete_button`, `#character_open_media_overrides`, `#creators_note_styles_button`) are hidden transports: the menu is what a user presses.
 */
async function chooseFromCharacterMenu(page, item) {
    await closeDialogs(page);
    await closeMenus(page);
    await openCharacterEditor(page);
    await chooseMenuItem(page, '#sb_character_editor_more', item);
}

/** Chooses an item of the Preset Menu of the Prompting page, which is where the presets' actions are. */
async function choosePresetMenuItem(page, { backend, item }) {
    await closeDialogs(page);
    await closeMenus(page);
    await selectBackend(page, backend);
    await openSettingsTab(page, { shell: 'left', tab: 'prompting' });
    await page.locator('[data-sb-panel="prompting"] [data-sb-preset-row]:visible').getByRole('button', { name: 'Preset Menu', exact: true }).click();
    await page.locator('.sb-action-menu[role="menu"]').getByRole('menuitem', { name: item, exact: true }).click();
}

/** Opens the Add menu of the Data Bank and chooses a scraper of it. */
async function chooseScraper(page, name) {
    await closeDialogs(page);
    await closeMenus(page);
    // The Fandom scraper is listed only when the server has its plugin, and the server of a run has not.
    await oncePerPage(page, 'dialog-scraper-routes', async () => {
        await page.route('**/api/plugins/fandom/probe', route => route.fulfill({ status: 200, body: '' }));
    });
    await openAuditChat(page);
    // The Data Bank is reached through the control that the Extensions menu binds, which no visible button stands for.
    await page.evaluate(() => document.getElementById('manageAttachments').click());
    await page.locator(within(WINDOW_FRAME, '.dataBankAttachments .openActionModalButton')).first().click();
    await page.locator(within(WINDOW_FRAME, '.actionButtonsModal .actionButton')).filter({ hasText: name }).click();
    await settleFrame(page, DIALOG_FRAME);
}

// Account and admin. The server of a run has user accounts off, so the account routes answer from the page: the current user
// is a fixed one, and every route that would write is refused.

const OTHER_USERS = [
    { handle: 'other-user', name: 'Other User', admin: false, enabled: true, password: true },
    { handle: 'disabled-user', name: 'Disabled User', admin: false, enabled: false, password: false },
];

/** Answers the account routes and turns the account controls on, once per page. */
export async function stubAccounts(page, { admin }) {
    await oncePerPage(page, 'dialog-accounts', async () => {
        const user = { handle: 'dialog-user', name: 'Dialog User', admin, enabled: true, password: true, created: Date.UTC(2026, 0, 1, 12), avatar: '/img/ai4.png' };
        await page.route('**/api/users/**', (route) => {
            const endpoint = new URL(route.request().url()).pathname.split('/').at(-1);
            if (endpoint === 'me') {
                return route.fulfill({ json: user });
            }
            if (endpoint === 'get') {
                return route.fulfill({ json: OTHER_USERS.map(other => ({ ...user, ...other, created: user.created })) });
            }
            if (endpoint === 'reset-step1') {
                return route.fulfill({ json: {} });
            }
            return route.fulfill({ status: 400, json: { error: 'Refused by the dialog audit' } });
        });
    });
    // A reload keeps the routes but drops the module state, so the controls and the current user are set on every call.
    await page.evaluate(async () => (await import('/scripts/user.js')).setUserControls(true));
}

/** Opens the Data & Security tab, where the account buttons are, and waits until the button is built. */
async function showAccountControls(page, button) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'data-security'));
    await page.locator(button).waitFor({ state: 'attached' });
    await page.evaluate(async () => (await import('/scripts/user.js')).syncUserControls(document.querySelector('[data-sb-panel="data-security"]') ?? document));
}

async function openAccountInfo(page) {
    await closeDialogs(page);
    await stubAccounts(page, { admin: false });
    await showAccountControls(page, '#account_button');
    await page.evaluate(() => window.$('#account_button').trigger('click'));
    await settleFrame(page, DIALOG_FRAME);
    await page.locator(within(DIALOG_FRAME, '.userResetAllButton')).waitFor({ state: 'visible' });
}

/** A state of Account Info: a form of the account, pushed over it as a page. */
function accountPage(id, button, field, tier = 'dialog') {
    return {
        id,
        root: `dialog.popup.sb-dialog--${tier}[open]:not([closing]):not([data-sb-covered]):has(${field})`,
        ready: `${TOP_POPUP} ${field}`,
        async open(page) {
            await page.locator(within(DIALOG_FRAME, button)).first().dispatchEvent('click');
            await page.locator(`${TOP_POPUP} ${field}`).waitFor({ state: 'visible' });
            await settleFrame(page, TOP_POPUP);
        },
    };
}

// Utility dialogs: the Popups that `utility-dialogs.js` adapts into rows.

const UTILITY_SOURCES = [`${ADAPTERS}/utility-dialogs.js`];

/** @type {import('./index.js').Surface[]} */
export const surfaces = [
    form({
        id: 'account-info',
        title: 'Account Info (profile dialog with a pushed form for each action)',
        ready: within(DIALOG_FRAME, '.userResetAllButton'),
        masks: [within(DIALOG_FRAME, '.userCreated')],
        open: openAccountInfo,
        states: [
            accountPage('change-password', '.userChangePasswordButton', 'input[name="confirm"]'),
            // One question and one field: an Alert over the profile dialog, not a Dialog.
            accountPage('reset-settings', '.userResetSettingsButton', '#resetSettingsPassword', 'alert'),
            accountPage('reset-everything', '.userResetAllButton', 'input[name="code"]'),
        ],
        sources: [`${SCRIPTS}/user.js`, `${ADAPTERS}/window-content-dialogs.js`, `${ADAPTERS}/misc-dialogs.js`],
    }),
    form({
        id: 'popup-input-text-area',
        title: 'Popup input with a text area (an INPUT of more than three rows is promoted from Alert to Dialog)',
        ready: [within(DIALOG_FRAME, 'textarea.popup-input'), within(DIALOG_FRAME, '.popup-button-ok')],
        async open(page) {
            await openAndSettle(page, DIALOG_FRAME, async () => {
                const { Popup } = await import('/scripts/popup.js');
                void Popup.show.input('Audit heading', 'A prompt that asks for several lines.', 'First line\nSecond line', { rows: 6 });
            });
        },
        sources: [`${SCRIPTS}/popup.js`, `${SCRIPTS}/sillybunny-editor/popup-frame.js`],
    }),
    form({
        id: 'persona-selection',
        title: 'Persona selection (a list of persona avatars to choose from, with an OK-only response)',
        ready: [within(DIALOG_FRAME, '.persona-list'), within(DIALOG_FRAME, '.avatar[data-type="persona"]')],
        needs: ['persona'],
        async open(page) {
            await openAndSettle(page, DIALOG_FRAME, async (avatar) => {
                const { askForPersonaSelection } = await import('/scripts/personas.js');
                void askForPersonaSelection('Persona Connections', 'Choose a persona.', [avatar], { okButton: 'None' });
            }, FIXTURES.persona.avatar);
        },
        sources: [`${SCRIPTS}/personas.js`],
    }),
    form({
        id: 'recent-chats-settings',
        title: 'Recent Chats Settings (form of two number rows, opened from the main menu of Home)',
        ready: [within(DIALOG_FRAME, '#maxRecentChats'), within(DIALOG_FRAME, '#collapsedRecentChats')],
        async open(page) {
            await closeDialogs(page);
            await closeMenus(page);
            await page.locator(HOME_MENU_BUTTON).click();
            await page.locator('.sb-action-menu').last().getByRole('menuitem', { name: 'Recent Chats Settings', exact: true }).click();
            await settleFrame(page, DIALOG_FRAME);
        },
        sources: [`${SCRIPTS}/welcome-screen.js`, ...UTILITY_SOURCES],
    }),
    form({
        id: 'persona-create',
        title: 'Create persona (form of an entry row and a text area)',
        ready: within(DIALOG_FRAME, '#persona_title'),
        open: page => openAndSettle(page, DIALOG_FRAME, () => window.$('#create_dummy_persona').trigger('click')),
        sources: [`${SCRIPTS}/personas.js`, ...UTILITY_SOURCES],
    }),
    form({
        id: 'regex-import-target',
        title: 'Regex import target (segmented choice of Global and Scoped)',
        ready: within(DIALOG_FRAME, '#regex_import_target_global'),
        async open(page) {
            await closeDialogs(page);
            await page.locator('#import_regex_file').setInputFiles({
                name: 'audit-regex.json',
                mimeType: 'application/json',
                buffer: Buffer.from(JSON.stringify({ scriptName: 'Audit imported regex', findRegex: 'audit', replaceString: 'replacement', placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: false, substituteRegex: 0 })),
            });
            await settleFrame(page, DIALOG_FRAME);
        },
        sources: [`${SCRIPTS}/extensions/regex/index.js`, ...UTILITY_SOURCES],
    }),
    form({
        id: 'quick-reply-transfer',
        title: 'Quick Reply transfer (select row of the target set)',
        ready: within(DIALOG_FRAME, '[data-sb-editor-field="quick-reply-transfer"] .ds-row'),
        needs: ['quick-replies'],
        async open(page) {
            // A direct call: the Transfer control sits in the editor of a Quick Reply, which opens from a set that the page has to build first, and the module call is what that control makes.
            await openAndSettle(page, DIALOG_FRAME, async (setName) => {
                const { QuickReplySet } = await import('/scripts/extensions/quick-reply/src/QuickReplySet.js');
                const set = QuickReplySet.list.find(candidate => candidate.name === setName);
                if (!set) {
                    throw new Error(`The Quick Reply set ${setName} is not loaded.`);
                }
                void set.qrList[0].onTransfer();
            }, FIXTURES['quick-replies'].main.name);
        },
        sources: [`${SCRIPTS}/extensions/quick-reply/src/QuickReply.js`, ...UTILITY_SOURCES],
    }),
    ...[
        ['web', 'Web', 'Web scraper (a list of addresses in one stacked entry row)', '[data-sb-editor-field="scrape-source"] textarea, [data-sb-editor-field="scrape-source"] input'],
        ['fandom', 'Fandom', 'Fandom scraper (entry rows and a segmented output choice)', '[data-sb-editor-field="scrape-output"]'],
        ['youtube', 'YouTube', 'YouTube scraper (video entry row and a language row)', '[data-sb-editor-field="scrape-language"]'],
    ].map(([kind, name, title, field]) => form({
        id: `scraper-${kind}`,
        title,
        ready: within(DIALOG_FRAME, field),
        needs: ['character', 'chat'],
        open: page => chooseScraper(page, name),
        sources: [`${SCRIPTS}/scrapers.js`, `${SCRIPTS}/chats.js`, ...UTILITY_SOURCES],
    })),
    form({
        id: 'icon-picker',
        title: 'Icon picker (search row over a grid of icons)',
        ready: [within(DIALOG_FRAME, 'input.faQuery'), within(DIALOG_FRAME, '.faPicker > [data-result]')],
        async open(page) {
            await closeDialogs(page);
            await closeMenus(page);
            await page.evaluate(async () => {
                const { showFontAwesomePicker } = await import('/scripts/utils.js');
                void showFontAwesomePicker();
            });
            await settleFrame(page, DIALOG_FRAME);
        },
        sources: [`${SCRIPTS}/utils.js`, ...UTILITY_SOURCES],
    }),
    // Form dialogs of `misc-dialogs.js`.
    form({
        id: 'creator-notes-styles',
        title: 'Creator\'s Notes styles preference (segmented choice and a warning)',
        ready: within(DIALOG_FRAME, '[data-sb-editor-field="creator-styles"] .sb-boolean-radio-group'),
        needs: ['character'],
        async open(page) {
            await chooseFromCharacterMenu(page, 'Global Styles');
            await settleFrame(page, DIALOG_FRAME);
        },
        sources: [`${ADAPTERS}/misc-dialogs.js`, `${SCRIPTS}/sillybunny-character-editor.js`],
    }),
    form({
        id: 'external-media',
        title: 'External media override (segmented choice with a subtitle)',
        ready: within(DIALOG_FRAME, '[data-sb-editor-field="external-media"] .sb-boolean-radio-group'),
        needs: ['character'],
        async open(page) {
            await chooseFromCharacterMenu(page, 'External Media');
            await settleFrame(page, DIALOG_FRAME);
        },
        sources: [`${ADAPTERS}/misc-dialogs.js`, `${SCRIPTS}/sillybunny-character-editor.js`],
    }),
    form({
        id: 'custom-css-assistant',
        title: 'Custom CSS assistant (profile select and a request area)',
        ready: [within(DIALOG_FRAME, '[data-sb-editor-field="custom-css-ai-fields"]'), within(DIALOG_FRAME, 'textarea')],
        open: page => openAndSettle(page, DIALOG_FRAME, () => window.$('#custom_css_ai_wand').trigger('click')),
        sources: [`${ADAPTERS}/misc-dialogs.js`],
    }),
    form({
        id: 'message-screenshot',
        title: 'Screenshot messages (two number rows, opened from a message)',
        ready: within(DIALOG_FRAME, '.ds-row'),
        needs: ['character', 'chat'],
        async open(page) {
            await closeDialogs(page);
            await openAuditChat(page);
            await page.evaluate(() => document.querySelector('#chat .mes .mes_screenshot').click());
            await settleFrame(page, DIALOG_FRAME);
        },
        sources: [`${ADAPTERS}/misc-dialogs.js`],
    }),
    form({
        id: 'install-extension',
        title: 'Install extension (address entry and a scope choice)',
        ready: [within(DIALOG_FRAME, '[data-sb-editor-field="extension-install-fields"]'), within(DIALOG_FRAME, 'input')],
        async open(page) {
            await oncePerPage(page, 'dialog-extension-routes', async () => {
                await page.route('**/api/extensions/install', route => route.fulfill({ status: 400, body: 'Refused by the dialog audit' }));
            });
            await page.evaluate(async () => (await import('/scripts/util/AccountStorage.js')).accountStorage.setItem('extensionInstallationWarningShown', '1'));
            await closeDialogs(page);
            await closeMenus(page);
            await openExtensionsList(page);
            // A click of the test scrolls the button into view, and so scrolls the clipped stack of the page behind the dialog by
            // a few pixels sideways and down, in three of four runs; the page then differs between two captures.
            await page.locator('#third_party_extension_button').evaluate(button => button.click());
            await settleFrame(page, DIALOG_FRAME);
        },
        sources: [`${ADAPTERS}/misc-dialogs.js`, `${SCRIPTS}/extensions.js`],
    }),
    form({
        id: 'switch-branch',
        title: 'Switch branch (select row of the branches of an extension)',
        ready: [within(DIALOG_FRAME, '[data-sb-editor-field="extension-branch-selection"]'), within(DIALOG_FRAME, '.ds-row')],
        async open(page) {
            // A direct click on a synthetic Branch button: the real one sits on a git-installed third-party extension in the Extensions manager, and the server of a run has none.
            await oncePerPage(page, 'dialog-branch-routes', async () => {
                await page.route('**/api/extensions/branches', route => route.fulfill({ json: [
                    { name: 'main', commit: 'abc123', current: true, label: 'Main' },
                    { name: 'dev', commit: 'def456', current: false, label: 'Development' },
                ] }));
                await page.route('**/api/extensions/switch', route => route.fulfill({ status: 400, body: 'Refused by the dialog audit' }));
            });
            await closeDialogs(page);
            await page.evaluate(() => {
                const parent = document.createElement('div');
                parent.className = 'extensions_info';
                parent.innerHTML = '<div class="extension_block"><button class="btn_branch" data-name="dialog-extension"></button></div>';
                document.body.append(parent);
                parent.querySelector('button').click();
                parent.remove();
            });
            await settleFrame(page, DIALOG_FRAME);
        },
        sources: [`${ADAPTERS}/misc-dialogs.js`, `${SCRIPTS}/extensions.js`],
    }),
    // Preset and lorebook dialogs of `preset-lorebook-dialogs.js`.
    form({
        id: 'preset-export',
        title: 'Master export (list of checks, one for each kind of preset)',
        ready: [within(DIALOG_FRAME, 'h3:has-text("Choose what to export")'), within(DIALOG_FRAME, 'input[type="checkbox"]')],
        async open(page) {
            await choosePresetMenuItem(page, { backend: 'text-completion', item: 'Master Export…' });
            await settleFrame(page, DIALOG_FRAME);
        },
        sources: [`${SCRIPTS}/preset-manager.js`, `${SCRIPTS}/sillybunny-tabs.js`, `${ADAPTERS}/preset-lorebook-dialogs.js`],
    }),
    form({
        id: 'preset-import',
        title: 'Master import (list of checks, one for each kind of preset in the file)',
        ready: [within(DIALOG_FRAME, 'h3:has-text("Choose what to import")'), within(DIALOG_FRAME, 'input[type="checkbox"]')],
        async open(page) {
            await closeDialogs(page);
            // The Master Import menu item opens the file picker of this input, so the file is the answer of the picker.
            await page.locator('#af_master_import_file').setInputFiles({
                name: 'audit-import.json',
                mimeType: 'application/json',
                buffer: Buffer.from(JSON.stringify({
                    instruct: { name: 'Audit import instruct', input_sequence: 'Input', output_sequence: 'Output' },
                    context: { name: 'Audit import context', story_string: '{{description}}' },
                    sysprompt: { name: 'Audit import system', content: 'System' },
                    preset: { name: 'Audit import preset', temp: 1, top_k: 40, top_p: 0.9, rep_pen: 1 },
                    reasoning: { name: 'Audit import reasoning', prefix: '<think>', suffix: '</think>', separator: '\n' },
                    srw: { value: 'Audit prefix', show: true },
                })),
            });
            await settleFrame(page, DIALOG_FRAME);
        },
        sources: [`${SCRIPTS}/preset-manager.js`, `${ADAPTERS}/preset-lorebook-dialogs.js`],
    }),
    form({
        id: 'preset-delete-all',
        title: 'Delete presets (list of checks with a destructive response)',
        ready: [within(DIALOG_FRAME, 'input[type="checkbox"]'), within(DIALOG_FRAME, '.is-destructive')],
        async open(page) {
            await choosePresetMenuItem(page, { backend: 'chat-completion', item: 'Delete in Bulk…' });
            await settleFrame(page, DIALOG_FRAME);
        },
        sources: [`${SCRIPTS}/preset-manager.js`, `${SCRIPTS}/sillybunny-tabs.js`, `${ADAPTERS}/preset-lorebook-dialogs.js`],
    }),
    form({
        id: 'lorebook-sorting',
        title: 'Apply the sorting of the open lorebook (list of checks and a choice)',
        ready: within(DIALOG_FRAME, '[data-sb-editor-field="sorting"]'),
        needs: ['lorebook', 'lorebook-entries'],
        async open(page) {
            await closeDialogs(page);
            await page.evaluate(async (name) => {
                const { openWorldInfoEditor } = await import('/scripts/world-info.js');
                await openWorldInfoEditor(name);
            }, FIXTURES.lorebook.name);
            await page.locator('#WorldInfo .sb-wi-row').first().waitFor({ state: 'attached' });
            await page.evaluate(() => {
                window.$('#world_info_sort_order').val('1').trigger('change');
                document.getElementById('world_apply_current_sorting').click();
            });
            await settleFrame(page, DIALOG_FRAME);
        },
        sources: [`${SCRIPTS}/world-info.js`, `${ADAPTERS}/preset-lorebook-dialogs.js`],
    }),
    form({
        id: 'lorebook-chat',
        title: 'Chat lorebook (select row of the book bound to the chat)',
        ready: within(DIALOG_FRAME, '[data-sb-editor-field="chat_world_info_selector"]'),
        needs: ['lorebook', 'character', 'chat'],
        async open(page) {
            await closeDialogs(page);
            await openAuditChat(page);
            await page.evaluate(async () => {
                const { assignLorebookToChat } = await import('/scripts/world-info.js');
                void assignLorebookToChat({ shiftKey: true });
            });
            await settleFrame(page, DIALOG_FRAME);
        },
        sources: [`${SCRIPTS}/world-info.js`, `${ADAPTERS}/preset-lorebook-dialogs.js`],
    }),
    form({
        id: 'lorebook-persona',
        title: 'Persona lorebook (select row of the book bound to the persona)',
        ready: within(DIALOG_FRAME, '[data-sb-editor-field="persona_world_info_selector"]'),
        needs: ['lorebook', 'persona'],
        open: page => openAndSettle(page, DIALOG_FRAME, () => window.$('#persona_lore_button').trigger({ type: 'click', shiftKey: true })),
        sources: [`${SCRIPTS}/personas.js`, `${ADAPTERS}/preset-lorebook-dialogs.js`],
    }),
    form({
        id: 'lorebook-character',
        title: 'Character lorebooks (primary book and additional books of the open character)',
        ready: within(DIALOG_FRAME, '[data-sb-editor-field="character_world_info_selector"]'),
        needs: ['lorebook', 'character'],
        async open(page) {
            await closeDialogs(page);
            await openAuditChat(page);
            await page.evaluate(async () => {
                const core = await import('/script.js');
                const id = core.this_chid;
                core.select_selected_character(id, { switchMenu: false });
                window.$('#set_character_world').data('chid', id).prop('selected', true);
                window.$('#char-management-dropdown').trigger('change');
            });
            await settleFrame(page, DIALOG_FRAME);
        },
        sources: [`${SCRIPTS}/world-info.js`, `${ADAPTERS}/preset-lorebook-dialogs.js`],
    }),
    form({
        id: 'embedded-lorebook-import',
        title: 'Batch import of embedded lorebooks (a Select all check, and a check for each card that carries a lorebook)',
        ready: [within(DIALOG_FRAME, 'input.batch_wi_import_candidate'), within(DIALOG_FRAME, '.popup-button-ok')],
        needs: ['character-embedded-lorebook'],
        async open(page) {
            await closeDialogs(page);
            // The dialog lists the cards that the app has loaded.
            await page.evaluate(async () => {
                const context = window.SillyTavern.getContext();
                if (!context.characters.length) {
                    await context.getCharacters();
                }
            });
            await page.locator('#world_batch_import_embedded').waitFor({ state: 'attached' });
            await page.evaluate(() => document.getElementById('world_batch_import_embedded').click());
            await settleFrame(page, DIALOG_FRAME);
        },
        sources: [`${SCRIPTS}/world-info.js`, `${ADAPTERS}/preset-lorebook-dialogs.js`],
    }),
    form({
        id: 'bulk-tag-edit',
        title: 'Bulk tag edit (tag entry, current tags and options; opened from selection mode of the character list)',
        root: 'dialog.sb-dialog-host:not([closing]) section.sb-bulk-tag-dialog',
        ready: [within('dialog.sb-dialog-host:not([closing]) section.sb-bulk-tag-dialog', '#bulkTagInput'), within('dialog.sb-dialog-host:not([closing]) section.sb-bulk-tag-dialog', '#bulk_tag_popup_reset')],
        needs: ['character', 'tags'],
        async open(page) {
            await closeDialogs(page);
            await closeMenus(page);
            await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'characters'));
            const list = page.locator('.sb-character-list[data-mounted="true"]');
            await list.locator('.character_select').first().waitFor({ state: 'visible' });
            await list.locator('.sb-character-list__header [data-action-id="more"]').click();
            await page.locator('.sb-action-menu').last().getByRole('menuitem', { name: 'Select', exact: true }).click();
            // The list holds every character that the needs seeded, so the row is picked by name and not by place.
            await list.locator('.character_select .ch_name').filter({ hasText: new RegExp(`^\\s*${FIXTURES.character.name}\\s*$`) }).first().click();
            await list.locator('.sb-selection-action[data-action-id="tag"]').click();
            await settleFrame(page, 'dialog.sb-dialog-host:not([closing]) section.sb-bulk-tag-dialog');
        },
        sources: [`${SCRIPTS}/BulkEditOverlay.js`, `${SCRIPTS}/tags.js`],
    }),
    form({
        id: 'color-picker',
        upstreamMarkup: false,
        title: 'Colour picker as a bottom sheet (under the overlay breakpoint; a popover above it)',
        root: 'dialog.sb-dialog-host:not([closing]) section.sb-color-picker-dialog',
        ready: within('dialog.sb-dialog-host:not([closing]) section.sb-color-picker-dialog', 'input[data-color-field="hex"]'),
        viewports: ['820x360', '390x844', '360x640', '360x294'],
        async open(page) {
            await closeDialogs(page);
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'appearance'));
            await page.locator('#main-text-color-picker').waitFor({ state: 'attached' });
            await page.waitForFunction(() => Boolean(document.getElementById('main-text-color-picker')?.shadowRoot?.querySelector('.button')));
            await page.evaluate(() => document.getElementById('main-text-color-picker').shadowRoot.querySelector('.button').click());
            await settleFrame(page, 'dialog.sb-dialog-host:not([closing]) section.sb-color-picker-dialog');
        },
        states: [{
            id: 'invalid-hex',
            ready: within('dialog.sb-dialog-host:not([closing]) section.sb-color-picker-dialog', 'input[data-color-field="hex"][aria-invalid="true"]'),
            async open(page) {
                await page.locator('dialog.sb-dialog-host:not([closing]) section.sb-color-picker-dialog input[data-color-field="hex"]').fill('not a colour');
                await page.locator('dialog.sb-dialog-host:not([closing]) section.sb-color-picker-dialog input[data-color-field="hex"][aria-invalid="true"]').waitFor({ state: 'visible' });
            },
        }],
        sources: [`${SCRIPTS}/sillybunny-color-picker.js`, 'public/css/sillybunny-color-picker.css'],
    }),
    // Connection Manager dialogs (`connection-manager/sillybunny-dialogs.js`). The buttons sit in the Connection Manager block of the Connections page.
    ...[
        ['create', 'Create connection profile (name, folder and a list of checks)', 'create_connection_profile', ['h2:has-text("Creating a Connection Profile")', 'input[type="checkbox"]']],
        ['edit', 'Edit connection profile (name, folder and the settings that the profile includes)', 'edit_connection_profile', ['.ds-pref-group-heading:has-text("Included settings")', 'input[type="checkbox"]']],
        ['delete-all', 'Delete connection profiles (list of checks with a destructive response)', 'delete_all_connection_profiles', ['.is-destructive']],
        ['folders', 'Profile folders (list of folders and their actions)', 'manage_profile_folders', ['[data-sb-editor-field="profile-folders"]']],
        ['view', 'View connection profile (read-only list of what the profile holds)', 'view_connection_profile', ['[data-sb-editor-field="profile-properties"]']],
    ].map(([id, title, button, fields]) => form({
        id: `connection-profile-${id}`,
        title,
        owner: 'C',
        // The create, edit and view dialogs show the extension's own templates (`profile.html`, `edit.html`, `view.html`), the folder manager one of SillyBunny's.
        upstreamMarkup: id !== 'folders',
        ready: fields.map(field => within(DIALOG_FRAME, field)),
        needs: ['connection-profile'],
        async open(page) {
            await closeDialogs(page);
            // The profile buttons stay disabled until a profile is picked, and the pick is a change of the profile select.
            await page.evaluate((profile) => {
                const select = document.getElementById('connection_profiles');
                if (select.value !== profile) {
                    select.value = profile;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }, FIXTURES['connection-profile'].id);
            await page.waitForFunction(id => !document.getElementById(id).classList.contains('disabled') && !document.getElementById(id).hasAttribute('disabled'), button);
            await page.evaluate(id => document.getElementById(id).click(), button);
            await settleFrame(page, DIALOG_FRAME);
        },
        sources: [`${SCRIPTS}/extensions/connection-manager/sillybunny-dialogs.js`, `${SCRIPTS}/extensions/connection-manager/index.js`],
    })),
];
