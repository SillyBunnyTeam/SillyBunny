/**
 * The editor family: the editors that edit one item with fields and a save or apply step.
 *
 * Each entry's `root` is the whole editor (header, toolbar or property bar, body), so that tools can compare editors of one
 * type with each other.
 *
 * Single-content editors (`editorType: 'single'`) are one body that holds the item: the character editor and the group
 * editor (a sheet of grouped sections under a header and a toolbar), and the Quick Reply and regex editors, which are
 * Window-tier Popups with one document of sections and no list of siblings beside them. List-content editors
 * (`editorType: 'list'`) sit beside a list of their siblings and have a property bar that becomes a summary button on a
 * phone: World Info entries, personas, prompts (and the Text Completion templates), and agents.
 *
 * A state is opened from a fresh open of its surface (see `editor-steps.js`), so the order of the states does not matter,
 * but a state whose control differs by size is still one state: the property bar opens as a drop-down where the bar is shown
 * and as the summary sheet where the editor shows a summary button. A state that exists only at some sizes (the prompt
 * editor's item menu) lists them in `viewports`.
 */

import { FIXTURES } from './fixture-data.js';
import {
    MENU_ROOT, appendToField, clearOverlays, closePopups, closeSheets, discardEdits, gone, leaveDetail, leaveDirtyDetail, renameInHeader,
    scrollSectionIntoView, scrollToTop, settleOverlay, settled, shown, showPreview,
} from './editor-steps.js';
import { expandAll, openCharactersTab, openSettingsTab, selectBackend, settle } from './steps.js';

const SCRIPTS = 'public/scripts';
const CSS = 'public/css';
const EXTENSIONS = `${SCRIPTS}/extensions`;

/** A character whose name is long enough to truncate in the header. */
const LONG_NAMED_CHARACTER = FIXTURES['characters-many'].characters[2];

/** The expanded text area and the leave dialog are Popups; both are found by what they hold. */
const EXPANDED = 'dialog.popup[open]:has(.maximized_textarea)';
const LEAVE = 'dialog.popup[open]:has(.popup-button-cancel)';
const LEAVE_READY = ['dialog.popup[open] .popup-button-cancel', 'dialog.popup[open] :text-is("Discard")'];

// The character editor's count moves from the header to the toolbar's second row when the header is under 560px wide; a
// viewport this narrow or narrower always has such a header.
const PHONE_READOUT_WIDTH = 560;
const PHONE_READOUT_OVER_BUDGET = '#sb_character_editor_toolbar .sb-editor-tokens--row.is-over-budget';
const isPhoneReadout = ctx => Number(String(ctx?.viewport ?? '1440x900').split('x')[0]) <= PHONE_READOUT_WIDTH;

/** The text that pushes a character card over the half of the context that the token readout warns at. */
const OVER_BUDGET = 'The audit repeats this sentence to pass the context warning of the token readout. '.repeat(500);

// ---------------------------------------------------------------------------------------------------------------------
// States that every editor of a kind has
// ---------------------------------------------------------------------------------------------------------------------

const menuState = ({ id = 'item-menu', trigger }) => ({
    id,
    root: MENU_ROOT,
    ready: MENU_ROOT,
    async open(page) {
        await page.locator(trigger).first().click();
        await settleOverlay(page, MENU_ROOT);
    },
});

const expandedState = ({ expand, id = 'field-expanded' }) => ({
    id,
    root: EXPANDED,
    ready: ['dialog.popup[open] .maximized_textarea'],
    async open(page) {
        await page.locator(expand).first().click();
        await shown(page, EXPANDED);
        await settled(page, 'dialog.popup[open]');
    },
});

const sectionState = ({ id, scroller, section, ready = section }) => ({
    id,
    ready,
    open: page => scrollSectionIntoView(page, { scroller, section }),
});

const dirtyState = ({ id = 'dirty', make, dirty }) => ({
    id,
    ready: dirty,
    async open(page) {
        await make(page);
        await shown(page, dirty);
        await settle(page);
    },
});

const leaveState = ({ make, dirty, leave }) => ({
    id: 'leave-dialog',
    root: LEAVE,
    ready: LEAVE_READY,
    async open(page) {
        await make(page);
        await shown(page, dirty);
        await leave(page);
        await shown(page, LEAVE);
        await settled(page, 'dialog.popup[open]');
    },
});

// ---------------------------------------------------------------------------------------------------------------------
// Character editor
// ---------------------------------------------------------------------------------------------------------------------

const CHARACTER = {
    dirty: '#sb_character_editor_dirty:not([hidden])',
    cancel: '#sb_character_editor_cancel',
    scroller: '#form_create .sb-editor-sheet__content',
};
const CHARACTER_LIST = '.sb-character-list[data-mounted="true"]';

/** Turns Quick Edit off, which the editor keeps in the account settings, so that every open shows all sections. */
async function leaveQuickEdit(page) {
    const quick = page.locator('#sb_character_editor_quick_edit');
    if (await quick.getAttribute('aria-pressed') === 'true') {
        await quick.click();
        await page.waitForFunction(() => document.getElementById('sb_character_editor_quick_edit').getAttribute('aria-pressed') === 'false');
    }
}

/** Opens a character in the editor through the shell's character selection, as a click on its card does. */
async function openCharacterEditor(page, character = FIXTURES.character) {
    await clearOverlays(page);
    await discardEdits(page, CHARACTER);
    await page.evaluate(async avatar => {
        await window.SillyBunnyShell.openTab('characters', 'characters');
        const app = await import('/script.js');
        if (!app.characters.length) {
            await app.getCharacters();
        }
        const index = app.characters.findIndex(candidate => candidate.avatar === avatar);
        if (index < 0) {
            throw new Error(`The audit character ${avatar} is not on the server.`);
        }
        app.setCharacterId(index);
        app.select_selected_character(index);
    }, character.avatar);
    await shown(page, '#sb_character_editor_header');
    await page.waitForFunction(name => document.getElementById('character_name_pole')?.value === name, character.name);
    // The token count arrives after a debounce, and the readout in the header is hidden until it has: it moves the header.
    await page.locator('#sb_character_editor_tokens:not([hidden])').waitFor({ state: 'attached', timeout: 10_000 });
    await leaveQuickEdit(page);
    await scrollToTop(page, CHARACTER.scroller);
}

/** The character editor in create mode, which is the New button of the character list. */
async function openCharacterCreate(page) {
    await page.locator('#sb_character_editor_back').click();
    await shown(page, CHARACTER_LIST);
    await page.locator('.sb-character-list [data-action-id="new"]').click();
    await page.locator('#right-nav-panel[data-menu-type="create"]').waitFor();
    await shown(page, '#sb_character_editor_header');
    await settle(page);
}

const characterSection = (id, section = id) => sectionState({
    id: `section-${id}`,
    scroller: CHARACTER.scroller,
    section: `#form_create [data-sb-section="${section}"]`,
    ready: `#form_create [data-sb-section="${section}"] .ds-pref-group-heading`,
});

// The nickname is in the first section, so that editing it does not scroll the header out of view on a phone.
const makeCharacterDirty = page => appendToField(page, '#character_nickname_pole');

// ---------------------------------------------------------------------------------------------------------------------
// Group editor
// ---------------------------------------------------------------------------------------------------------------------

const GROUP = {
    dirty: '#sb_group_editor_dirty:not([hidden])',
    cancel: '#sb_group_editor_cancel',
    scroller: '#sb_group_editor_content',
};

/** Opens the audit group in the group editor, as a click on its card does. */
async function openGroupEditor(page) {
    await clearOverlays(page);
    await discardEdits(page, GROUP);
    await page.evaluate(async name => {
        await window.SillyBunnyShell.openTab('characters', 'characters');
        const app = await import('/script.js');
        if (!app.characters.length) {
            await app.getCharacters();
        }
        const groupChats = await import('/scripts/group-chats.js');
        const group = groupChats.groups.find(candidate => candidate.name === name);
        if (!group) {
            throw new Error(`The audit group ${name} is not on the server.`);
        }
        if (!await groupChats.openGroupById(group.id, { switchMenu: true })) {
            throw new Error(`Could not open the group ${name}.`);
        }
    }, FIXTURES.group.name);
    await shown(page, '#sb_group_editor_header');
    await page.waitForFunction(name => document.getElementById('rm_group_chat_name')?.value === name, FIXTURES.group.name);
    await scrollToTop(page, GROUP.scroller);
}

const groupSection = section => sectionState({
    id: `section-${section}`,
    scroller: GROUP.scroller,
    section: `#rm_group_chats_block [data-sb-section="${section}"]`,
    ready: `#rm_group_chats_block [data-sb-section="${section}"] .ds-pref-group-heading`,
});

const makeGroupDirty = page => renameInHeader(page, '#sb_group_editor_title_button', 'Audit Group, renamed');

// ---------------------------------------------------------------------------------------------------------------------
// List-content editors
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Opens the properties of a list-content editor: the first drop-down of the property bar where the bar is shown, and the
 * summary sheet where the editor shows a summary button instead (a phone).
 */
const propertiesState = ({ summary, trigger, popover, sheet }) => ({
    id: 'properties-open',
    root: `${popover}, ${sheet}`,
    ready: `${popover}, ${sheet}`,
    async open(page) {
        if (await page.locator(summary).first().isVisible()) {
            await page.locator(summary).first().click();
            await settleOverlay(page, sheet);
        } else {
            await page.locator(trigger).first().click();
            await settleOverlay(page, popover);
        }
    },
});

const previewState = ({ modes, toggle, pane }) => ({
    id: 'preview',
    ready: pane,
    async open(page) {
        await showPreview(page, { modes, toggle });
        await shown(page, pane);
        await settle(page);
    },
});

/** Opens a persona in the detail pane. */
const PERSONA = {
    root: '#PersonaManagement .sb-persona-entry',
    dirty: '#PersonaManagement .sb-persona-entry-dirty:not([hidden])',
    cancel: '#PersonaManagement .sb-persona-entry-cancel',
    back: '#PersonaManagement .sb-persona-detail-back',
    name: '#PersonaManagement .sb-persona-entry-name',
    description: '#PersonaManagement .sb-persona-entry-textarea',
    body: '#PersonaManagement .sb-persona-entry-body',
};

async function openPersonaDetail(page) {
    await clearOverlays(page);
    await discardEdits(page, PERSONA);
    await openCharactersTab(page, 'persona');
    await leaveDetail(page, PERSONA.back);
    await page.evaluate(async avatarId => {
        const { openPersonaEditor } = await import('/scripts/sillybunny-persona-editor.js');
        if (!await openPersonaEditor({ avatarId })) {
            throw new Error('Could not open the audit persona.');
        }
    }, FIXTURES.persona.avatar);
    await shown(page, PERSONA.name);
    await page.waitForFunction(({ selector, name }) => document.querySelector(selector)?.value === name, { selector: PERSONA.name, name: FIXTURES.persona.name });
    await scrollToTop(page, PERSONA.body);
}

// The name is in the header, which a phone keeps in view; a field of the body may scroll it away.
const makePersonaDirty = page => appendToField(page, PERSONA.name);

const WORLD_INFO = {
    root: '#WorldInfo .sb-wi-entry',
    dirty: '#WorldInfo .sb-wi-entry-dirty:not([hidden])',
    cancel: '#WorldInfo .sb-wi-entry-cancel',
    back: '#WorldInfo .sb-wi-entry .sb-wi-detail-back',
    textarea: '#WorldInfo .sb-wi-entry-textarea',
};

/** Opens an entry of the lorebook with six kinds of entries, by its title. */
async function openWorldInfoEntry(page, title = FIXTURES['lorebook-entries'].kinds.keyed) {
    await clearOverlays(page);
    await discardEdits(page, WORLD_INFO);
    await page.evaluate(async name => {
        await window.SillyBunnyShell.openTab('characters', 'world-info');
        const { openWorldInfoEditor } = await import('/scripts/world-info.js');
        await openWorldInfoEditor(name);
    }, FIXTURES['lorebook-entries'].book);
    await leaveDetail(page, WORLD_INFO.back);
    await shown(page, '#WorldInfo .sb-wi-editor .sb-wi-row');
    await page.locator('#WorldInfo .sb-wi-editor .sb-wi-row', { hasText: title }).first().click();
    await shown(page, '#WorldInfo .sb-wi-entry .sb-wi-entry-header');
    await page.waitForFunction(({ selector, value }) => document.querySelector(selector)?.value === value, { selector: `${WORLD_INFO.root} .sb-wi-entry-title`, value: title });
    await scrollToTop(page, `${WORLD_INFO.root} .sb-wi-entry-body`);
}

const makeWorldInfoDirty = page => appendToField(page, `${WORLD_INFO.root} .sb-wi-entry-title`);


const PROMPT = {
    row: '.sb-prompt-row[data-prompt-id="main"]',
    dirty: '.sb-prompt-detail .sb-prompt-dirty:not([hidden])',
    cancel: '.sb-prompt-detail .sb-prompt-cancel',
    back: '.sb-prompt-detail .sb-prompt-detail-header [aria-label="Back to prompt list"]',
    textarea: '#sb-prompt-form_prompt',
};

async function openPromptList(page) {
    await clearOverlays(page);
    await discardEdits(page, PROMPT);
    await openSettingsTab(page, { shell: 'left', tab: 'editor' });
    await leaveDetail(page, PROMPT.back);
    await shown(page, '.sb-prompt-editor .sb-prompt-list-header');
    await settle(page);
}

/** Opens the Main prompt in the detail pane. */
async function openPromptDetail(page) {
    await openPromptList(page);
    await page.locator(`${PROMPT.row} .sb-prompt-row-name`).click();
    await shown(page, '.sb-prompt-detail .sb-prompt-detail-header');
    await shown(page, PROMPT.textarea);
    await settle(page);
}

const TEMPLATES = {
    row: '.sb-prompt-row[data-prompt-id="tc-user"]',
    story: '.sb-prompt-row[data-prompt-id="context_story_string"]',
    textarea: '.sb-prompt-detail .sb-prompt-tc-textarea',
};

/** The instruct template of the Text Completion backend, whose prompt list is the list of its fields. */
async function openTemplateDetail(page, row = TEMPLATES.row) {
    await openPromptList(page);
    const name = (await page.locator(`${row} .sb-prompt-row-name`).innerText()).trim();
    await page.locator(`${row} .sb-prompt-row-name`).click();
    // On a wide pane the list stays beside the detail, so the header and fields of the template that was open already
    // match; only the title tells which template the detail holds.
    await page.waitForFunction(title => {
        const node = document.querySelector('.sb-prompt-detail .sb-prompt-title');
        return (node?.value ?? node?.textContent ?? '').trim() === title;
    }, name);
    await shown(page, '.sb-prompt-detail .sb-prompt-tc-field');
    await settle(page);
}

const AGENTS = '.ica-agents-editor';
const AGENT = {
    root: `${AGENTS} .ica-agent-detail`,
    dirty: `${AGENTS} .ica-agent-detail .sb-persona-entry-dirty:not([hidden])`,
    cancel: `${AGENTS} .ica-agent-detail .sb-persona-entry-cancel`,
    back: `${AGENTS} .ica-agent-detail .sb-persona-detail-back`,
    name: `${AGENTS} .ica-agent-detail input[data-sb-editor-field="name"]`,
    prompt: `${AGENTS} .ica-agent-detail [data-sb-editor-field="prompt"] textarea`,
    body: `${AGENTS} .ica-agent-detail .sb-persona-entry-body`,
};

const makeAgentDirty = page => appendToField(page, AGENT.name);

/** Opens the tracker agent in the detail pane. */
async function openAgentDetail(page) {
    await clearOverlays(page);
    await discardEdits(page, AGENT);
    await openSettingsTab(page, { shell: 'left', tab: 'agents' });
    await leaveDetail(page, AGENT.back);
    await shown(page, `${AGENTS} .sb-list-header`);
    await page.locator(`${AGENTS} [data-sb-list-key="agent:${FIXTURES.agents.tracker.id}"]`).evaluate(node => node.click());
    await shown(page, `${AGENT.root} .sb-persona-entry-header`);
    await shown(page, AGENT.prompt);
    await scrollToTop(page, AGENT.body);
}

/** Runs an action of the agent editor's header: its button where it is shown, its item in the More menu where it is collapsed. */
async function activateAgentAction(page, label) {
    const direct = page.locator(AGENT.root).getByRole('button', { name: label, exact: true });
    if (await direct.isVisible()) {
        await direct.click();
        return;
    }
    await page.locator(`${AGENT.root} .sb-persona-entry-more`).click();
    await page.locator('.sb-action-menu').last().getByRole('menuitem', { name: label, exact: true }).click();
}

/** Picks a category in the agent's property bar: its drop-down where the bar is shown, and the same drop-down in the summary sheet on a phone. */
async function chooseAgentCategory(page, label) {
    const sheet = '.ica-agent-property-sheet';
    const inSheet = await page.locator(`${AGENT.root} .ica-agent-property-summary`).first().isVisible();
    if (inSheet) {
        await page.locator(`${AGENT.root} .ica-agent-property-summary`).first().click();
        await settleOverlay(page, sheet);
    }
    await page.locator(`${inSheet ? sheet : AGENT.root} button[aria-label="Category"]`).click();
    await page.getByRole('option', { name: label, exact: true }).click();
    await gone(page, '.sb-prompt-role-list');
    if (inSheet) {
        await closeSheets(page);
    }
}

/**
 * Saves a Companion agent with no prompt. The editor refuses it while it validates, before it sends anything to the server,
 * and shows the error under the prompt.
 */
async function makeAgentInvalid(page) {
    await chooseAgentCategory(page, 'Companion');
    await page.locator(AGENT.prompt).fill('');
    await scrollToTop(page, AGENT.body);
    await page.locator(AGENT.root).getByRole('button', { name: 'Save', exact: true }).click();
    await shown(page, `${AGENT.prompt}[aria-invalid="true"]`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Popup editors (Quick Reply, regex)
// ---------------------------------------------------------------------------------------------------------------------

const QUICK_REPLY = 'dialog.popup[open]:has(#qr--modalEditor)';

/** Opens a reply of the audit set in the Quick Reply editor, which is what the Edit button of the set's list does. */
async function openQuickReplyEditor(page) {
    await clearOverlays(page);
    const { main, menuReplyId } = FIXTURES['quick-replies'];
    await page.evaluate(async ({ set, id }) => {
        const { QuickReplySet } = await import('/scripts/extensions/quick-reply/src/QuickReplySet.js');
        const reply = QuickReplySet.get(set)?.qrList.find(candidate => candidate.id === id);
        if (!reply) {
            throw new Error(`The audit reply ${id} of the set ${set} is not loaded.`);
        }
        void reply.showEditor();
    }, { set: main.name, id: menuReplyId });
    await shown(page, `${QUICK_REPLY} #qr--modal-label`);
    await page.waitForFunction(() => !document.querySelector('dialog.popup[open][opening]'));
    await settled(page, QUICK_REPLY);
}

const REGEX = 'dialog.popup[open]:has(.regex_editor)';

/** Opens the Regex subpage of the Extensions settings, where the scripts are listed. */
async function openRegexSubpage(page) {
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'extensions'));
    const row = page.locator('[data-sb-subpage-row="regex_container"]');
    await row.waitFor();
    const section = page.locator('#regex_container');
    if (!await section.isVisible()) {
        await row.click();
        await section.waitFor({ state: 'visible' });
    }
}

/** Opens the editor of a script that the regex need seeded, or of a new script. */
async function openRegexEditor(page, { script = FIXTURES['regex-scripts'].enabled } = {}) {
    await clearOverlays(page);
    await openRegexSubpage(page);
    if (script) {
        await page.locator(`#saved_regex_scripts [id="${script.id}"] .edit_existing_regex`).dispatchEvent('click');
    } else {
        await page.locator('#open_regex_editor').dispatchEvent('click');
    }
    await shown(page, `${REGEX} .regex_script_name`);
    // A new script's name is empty and an existing one's is filled in; the field is shown before the editor fills it.
    await page.waitForFunction(({ selector, name }) => document.querySelector(selector)?.value === name, { selector: `${REGEX} .regex_script_name`, name: script?.scriptName ?? '' });
    await page.waitForFunction(() => !document.querySelector('dialog.popup[open][opening]'));
    await settled(page, REGEX);
}

const popupClose = root => async function close(page) {
    await closePopups(page);
    await gone(page, root);
};

// ---------------------------------------------------------------------------------------------------------------------
// The entries
// ---------------------------------------------------------------------------------------------------------------------

/** @type {import('./index.js').Surface[]} */
export const surfaces = [
    {
        id: 'editor.character',
        family: 'editor',
        editorType: 'single',
        owner: 'A',
        title: 'Character editor',
        root: '#form_create',
        ready: ['#sb_character_editor_header', '#character_name_pole'],
        open: page => openCharacterEditor(page),
        states: [
            menuState({ trigger: '#sb_character_editor_more' }),
            {
                id: 'quick-edit',
                ready: ['#form_create.sb-editor-sheet--quick-edit', '#form_create [data-sb-section="essentials"]'],
                async open(page) {
                    await page.locator('#sb_character_editor_quick_edit').click();
                    await page.waitForFunction(() => document.getElementById('sb_character_editor_quick_edit').getAttribute('aria-pressed') === 'true');
                    // On a phone the first screen of the sheet is Essentials either way: the end of the sheet is where the
                    // hidden sections would start. The tags decide how tall Essentials is, so the step gives them a moment; a
                    // scroll down hides the header and toolbar on a phone, and a short scroll up brings them back.
                    await page.locator('#tagList .tag').first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
                    await page.locator(CHARACTER.scroller).evaluate(body => { body.scrollTop = body.scrollHeight; });
                    await page.waitForTimeout(400);
                    await page.locator(CHARACTER.scroller).evaluate(body => { body.scrollTop = Math.max(0, body.scrollTop - 24); });
                    await settle(page);
                },
            },
            characterSection('character-fields'),
            characterSection('advanced-fields'),
            {
                id: 'section-greetings',
                ready: ['#form_create [data-sb-section="greetings"] .ds-pref-group-heading', '#character_greetings_editor'],
                async open(page) {
                    await scrollSectionIntoView(page, { scroller: CHARACTER.scroller, section: '#form_create [data-sb-section="greetings"]' });
                },
            },
            {
                id: 'alternate-greeting',
                ready: '#character_greetings_editor .sb-greeting-row',
                async open(page) {
                    await scrollSectionIntoView(page, { scroller: CHARACTER.scroller, section: '#character_greetings_editor', mustMove: false });
                    await page.locator('#character_greetings_editor .sb-greetings-editor__add').click();
                    await shown(page, '#character_greetings_editor .sb-greeting-row');
                    await settle(page);
                },
            },
            {
                id: 'group-greetings',
                ready: '#character_group_greetings_editor .sb-greetings-editor__add',
                async open(page) {
                    await scrollSectionIntoView(page, { scroller: CHARACTER.scroller, section: '#sb_character_group_greetings', mustMove: false });
                    await page.locator('#sb_character_group_greetings > .ds-row-expander__header > .ds-row-expander__toggle').click();
                    await shown(page, '#character_group_greetings_editor .sb-greetings-editor__add');
                    await settle(page);
                },
            },
            characterSection('metadata'),
            expandedState({ expand: '.editor_maximize[data-for="description_textarea"]' }),
            dirtyState({ make: makeCharacterDirty, dirty: CHARACTER.dirty }),
            {
                id: 'token-warning',
                ready: ctx => (isPhoneReadout(ctx)
                    ? [PHONE_READOUT_OVER_BUDGET, `${PHONE_READOUT_OVER_BUDGET} .sb-editor-tokens__warning`]
                    : ['#sb_character_editor_tokens.is-over-budget', '#sb_character_editor_token_warning']),
                async open(page) {
                    await page.locator('#description_textarea').fill(OVER_BUDGET);
                    // Filling scrolls the field into view, which hides the header on a phone; the readout is in that header.
                    await page.locator('#sb_character_editor_tokens.is-over-budget').waitFor({ state: 'attached', timeout: 30_000 });
                    await scrollToTop(page, CHARACTER.scroller);
                    await shown(page, isPhoneReadout({ viewport: `${page.viewportSize().width}x${page.viewportSize().height}` })
                        ? PHONE_READOUT_OVER_BUDGET : '#sb_character_editor_tokens.is-over-budget');
                },
            },
            leaveState({
                make: makeCharacterDirty,
                dirty: CHARACTER.dirty,
                leave: page => page.locator('#sb_character_editor_back').click(),
            }),
            {
                id: 'create-mode',
                ready: ['#sb_character_editor_header', '#character_name_pole'],
                open: openCharacterCreate,
            },
            {
                id: 'long-title',
                ready: ['#sb_character_editor_header', '#character_name_pole'],
                open: page => openCharacterEditor(page, LONG_NAMED_CHARACTER),
            },
        ],
        masks: ['#sb_character_editor_tokens', '#sb_character_editor_toolbar .sb-editor-tokens--row', '#form_create .ds-row-textarea__count-value, #form_create [data-token-counter]', '#sb-topbar-title'],
        needs: ['character', 'characters-many'],
        sources: [`${SCRIPTS}/sillybunny-character-editor.js`, `${SCRIPTS}/sillybunny-editor/chrome.js`, `${CSS}/sillybunny-character-editor.css`],
        primaryFlow: true,
    },
    {
        id: 'editor.group',
        family: 'editor',
        editorType: 'single',
        owner: 'A',
        title: 'Group editor',
        root: '#rm_group_chats_block',
        ready: ['#sb_group_editor_header', '#rm_group_chat_name'],
        open: openGroupEditor,
        states: [
            menuState({ trigger: '#sb_group_editor_more' }),
            groupSection('members'),
            groupSection('add-members'),
            // The sheet cannot scroll the last sections to its top, so Chat Settings, Overrides and Lorebook all stop at the
            // end of it: one state shows the three.
            groupSection('chat-settings'),
            dirtyState({ make: makeGroupDirty, dirty: GROUP.dirty }),
            leaveState({
                make: makeGroupDirty,
                dirty: GROUP.dirty,
                leave: page => page.locator('#sb_group_editor_back').click(),
            }),
        ],
        needs: ['group'],
        sources: [`${SCRIPTS}/sillybunny-group-editor.js`, `${SCRIPTS}/sillybunny-editor/chrome.js`, `${CSS}/sillybunny-character-editor.css`],
    },
    {
        id: 'editor.worldinfo.entry',
        family: 'editor',
        editorType: 'list',
        owner: 'A',
        title: 'World Info entry editor',
        root: WORLD_INFO.root,
        ready: [`${WORLD_INFO.root} .sb-wi-entry-title`, WORLD_INFO.textarea, `${WORLD_INFO.root} :is(.sb-wi-properties, .sb-wi-property-summary):visible`],
        open: page => openWorldInfoEntry(page),
        states: [
            propertiesState({
                summary: `${WORLD_INFO.root} .sb-wi-property-summary`,
                trigger: `${WORLD_INFO.root} .sb-wi-properties .sb-wi-dropdown`,
                popover: '.sb-wi-property-popover',
                sheet: '.sb-world-info-properties-dialog',
            }),
            {
                id: 'expanded-sections',
                ready: `${WORLD_INFO.root} .ds-row-expander.is-open`,
                async open(page) {
                    await expandAll(page, WORLD_INFO.root);
                    await scrollSectionIntoView(page, { scroller: `${WORLD_INFO.root} .sb-wi-entry-body`, section: `${WORLD_INFO.root} .ds-row-expander.is-open`, mustMove: false });
                },
            },
            previewState({
                modes: `${WORLD_INFO.root} .sb-wi-entry-modes`,
                toggle: `${WORLD_INFO.root} .sb-wi-entry-mode-toggle`,
                pane: `${WORLD_INFO.root} .sb-wi-entry-preview`,
            }),
            expandedState({ expand: `${WORLD_INFO.root} .sb-wi-entry-expand` }),
            {
                id: 'long-content',
                ready: WORLD_INFO.textarea,
                open: page => openWorldInfoEntry(page, FIXTURES['lorebook-entries'].kinds.long),
            },
            dirtyState({ make: makeWorldInfoDirty, dirty: WORLD_INFO.dirty }),
            leaveState({
                make: makeWorldInfoDirty,
                dirty: WORLD_INFO.dirty,
                leave: page => leaveDirtyDetail(page, { back: WORLD_INFO.back, otherRow: '#WorldInfo .sb-wi-editor .sb-wi-row', exceptText: FIXTURES['lorebook-entries'].kinds.keyed }),
            }),
        ],
        masks: ['#WorldInfo .sb-wi-entry .sb-wi-entry-tokens', '#WorldInfo .sb-wi-entry .sb-editor-tokens--row'],
        needs: ['lorebook-entries'],
        sources: [`${SCRIPTS}/sillybunny-world-info-entry.js`, `${SCRIPTS}/sillybunny-world-info-model.js`, `${CSS}/sillybunny-world-info-editor.css`],
        primaryFlow: true,
    },
    {
        id: 'editor.persona',
        family: 'editor',
        editorType: 'list',
        owner: 'A',
        title: 'Persona detail editor',
        root: PERSONA.root,
        ready: [PERSONA.name, PERSONA.description, `${PERSONA.root} :is(.sb-persona-properties, .sb-persona-property-summary):visible`],
        open: openPersonaDetail,
        states: [
            menuState({ trigger: `${PERSONA.root} .sb-persona-entry-more` }),
            propertiesState({
                summary: `${PERSONA.root} .sb-persona-property-summary`,
                trigger: `${PERSONA.root} .sb-persona-properties .sb-persona-dropdown`,
                popover: '.sb-persona-property-popover',
                sheet: '.sb-persona-properties-dialog',
            }),
            previewState({
                modes: `${PERSONA.root} .sb-persona-entry-modes`,
                toggle: `${PERSONA.root} .sb-persona-entry-mode-toggle`,
                pane: `${PERSONA.root} .sb-persona-entry-preview`,
            }),
            expandedState({ expand: `${PERSONA.root} .sb-persona-entry-expand` }),
            // Connections and Lorebook are the last two sections, so scrolling to either stops at the end of the body: one
            // state shows both.
            sectionState({ id: 'section-connections', scroller: PERSONA.body, section: `${PERSONA.root} [data-sb-section="connections"]`, ready: [`${PERSONA.root} [data-sb-section="connections"] .ds-pref-group-heading`, `${PERSONA.root} [data-sb-section="lorebook"] .ds-pref-group-heading`] }),
            {
                id: 'scenario-note',
                ready: `${PERSONA.root} [data-appendix-id="${FIXTURES['persona-appendices'].notes[0].id}"] .sb-persona-note-textarea`,
                async open(page) {
                    await scrollSectionIntoView(page, { scroller: PERSONA.body, section: `${PERSONA.root} [data-sb-section="notes"]`, mustMove: false });
                    await page.locator(`${PERSONA.root} [data-appendix-id="${FIXTURES['persona-appendices'].notes[0].id}"] .ds-row-expander__toggle .ds-row-label`).first().click();
                    await shown(page, `${PERSONA.root} [data-appendix-id="${FIXTURES['persona-appendices'].notes[0].id}"] .sb-persona-note-textarea`);
                    await settle(page);
                },
            },
            dirtyState({ make: makePersonaDirty, dirty: PERSONA.dirty }),
            {
                id: 'validation-error',
                ready: `${PERSONA.name}[aria-invalid="true"]`,
                async open(page) {
                    await page.locator(PERSONA.name).fill('');
                    await page.locator(PERSONA.name).blur();
                    await shown(page, `${PERSONA.name}[aria-invalid="true"]`);
                    await settle(page);
                },
            },
            leaveState({
                make: makePersonaDirty,
                dirty: PERSONA.dirty,
                leave: page => leaveDirtyDetail(page, { back: PERSONA.back, otherRow: `#PersonaManagement .sb-persona-row:not([data-avatar-id="${FIXTURES.persona.avatar}"])` }),
            }),
        ],
        masks: ['#PersonaManagement .sb-persona-entry-tokens', '#PersonaManagement .sb-editor-tokens--row'],
        needs: ['persona', 'persona-appendices'],
        sources: [`${SCRIPTS}/sillybunny-persona-detail.js`, `${CSS}/sillybunny-persona-detail.css`],
        primaryFlow: true,
    },
    {
        id: 'editor.prompt',
        family: 'editor',
        editorType: 'list',
        owner: 'A',
        title: 'Prompt editor',
        root: '.sb-prompt-detail',
        ready: ['.sb-prompt-detail .sb-prompt-title', PROMPT.textarea, '.sb-prompt-detail :is(.sb-prompt-properties, .sb-prompt-property-summary):visible'],
        open: openPromptDetail,
        states: [
            {
                // The item menu is in the header at every width, as in every editor.
                id: 'item-menu',
                root: MENU_ROOT,
                ready: MENU_ROOT,
                async open(page) {
                    await page.locator('.sb-prompt-detail').getByRole('button', { name: 'Prompt Actions', exact: true }).click();
                    await settleOverlay(page, MENU_ROOT);
                },
            },
            propertiesState({
                summary: '.sb-prompt-detail .sb-prompt-property-summary',
                trigger: '.sb-prompt-detail .sb-prompt-properties .sb-prompt-dropdown',
                popover: '.sb-prompt-popover',
                sheet: '.sb-prompt-properties-dialog',
            }),
            previewState({
                modes: '.sb-prompt-detail .sb-prompt-modes',
                toggle: '.sb-prompt-detail .sb-prompt-mode-toggle',
                pane: '.sb-prompt-detail .sb-prompt-preview',
            }),
            expandedState({ expand: '.sb-prompt-detail .sb-prompt-expand' }),
            dirtyState({ make: page => appendToField(page, PROMPT.textarea), dirty: PROMPT.dirty }),
            leaveState({
                make: page => appendToField(page, PROMPT.textarea),
                dirty: PROMPT.dirty,
                leave: page => leaveDirtyDetail(page, { back: PROMPT.back, otherRow: '.sb-prompt-row:not([data-prompt-id="main"])' }),
            }),
        ],
        masks: ['.sb-prompt-detail .sb-prompt-tokens', '.sb-prompt-detail .sb-editor-tokens--row'],
        needs: [],
        sources: [`${SCRIPTS}/sillybunny-prompt-editor.js`, `${CSS}/sillybunny-prompt-editor.css`],
        primaryFlow: true,
    },
    {
        id: 'editor.prompt.template',
        family: 'editor',
        editorType: 'list',
        owner: 'A',
        title: 'Prompt editor: Text Completion template',
        root: '.sb-prompt-detail',
        ready: ['.sb-prompt-detail .sb-prompt-title', TEMPLATES.textarea],
        async open(page, ctx = {}) {
            await selectBackend(page, ctx.backend ?? 'text-completion');
            await openTemplateDetail(page);
        },
        states: [
            previewState({
                modes: '.sb-prompt-detail .sb-prompt-modes',
                toggle: '.sb-prompt-detail .sb-prompt-mode-toggle',
                pane: '.sb-prompt-detail .sb-prompt-preview',
            }),
            {
                id: 'story-string',
                ready: '.sb-prompt-detail :is(.sb-prompt-tc-properties, .sb-prompt-property-summary):visible',
                open: page => openTemplateDetail(page, TEMPLATES.story),
            },
            dirtyState({ make: page => appendToField(page, TEMPLATES.textarea), dirty: PROMPT.dirty }),
            leaveState({
                make: page => appendToField(page, TEMPLATES.textarea),
                dirty: PROMPT.dirty,
                leave: page => leaveDirtyDetail(page, { back: PROMPT.back, otherRow: '.sb-prompt-row:not([data-prompt-id="tc-user"])' }),
            }),
        ],
        backends: ['text-completion'],
        needs: [],
        sources: [`${SCRIPTS}/sillybunny-prompt-editor.js`, `${CSS}/sillybunny-prompt-editor.css`],
    },
    {
        id: 'editor.agent',
        family: 'editor',
        editorType: 'list',
        owner: 'A',
        title: 'Agent editor',
        root: AGENT.root,
        ready: [AGENT.name, AGENT.prompt, `${AGENT.root} :is(.ica-agent-properties, .ica-agent-property-summary):visible`],
        open: openAgentDetail,
        states: [
            menuState({ trigger: `${AGENT.root} .sb-persona-entry-more` }),
            {
                id: 'sections-menu',
                root: MENU_ROOT,
                // Only this menu lists the agent's sections.
                ready: [MENU_ROOT, ':is(.sb-action-popover, .sb-action-sheet:not([hidden])) [role="menuitem"]:has-text("Conditions")'],
                async open(page) {
                    await activateAgentAction(page, 'Sections');
                    await page.locator('.sb-action-menu').last().getByRole('menuitem', { name: 'General', exact: true }).waitFor();
                    await settleOverlay(page, MENU_ROOT);
                },
            },
            propertiesState({
                summary: `${AGENT.root} .ica-agent-property-summary`,
                trigger: `${AGENT.root} .ica-agent-properties button[aria-haspopup="listbox"]`,
                popover: '.sb-prompt-popover',
                sheet: '.ica-agent-property-sheet',
            }),
            previewState({
                modes: `${AGENT.root} .sb-persona-entry-modes`,
                toggle: `${AGENT.root} .sb-persona-entry-mode-toggle`,
                pane: `${AGENT.root} .ica-agent-prompt-preview`,
            }),
            expandedState({ expand: `${AGENT.root} .sb-persona-entry-expand` }),
            sectionState({ id: 'section-regex', scroller: AGENT.body, section: `${AGENT.root} [data-sb-editor-field="section-regex"]`, ready: `${AGENT.root} [data-sb-editor-field="section-regex"] .ds-pref-group-heading` }),
            sectionState({ id: 'section-conditions', scroller: AGENT.body, section: `${AGENT.root} [data-sb-editor-field="section-conditions"]`, ready: `${AGENT.root} [data-sb-editor-field="section-conditions"] .ds-pref-group-heading` }),
            dirtyState({ make: makeAgentDirty, dirty: AGENT.dirty }),
            {
                id: 'validation-error',
                ready: [`${AGENT.prompt}[aria-invalid="true"]`, `${AGENT.root} .ica-agent-field-error:not([hidden])`],
                async open(page) {
                    await makeAgentInvalid(page);
                    await page.locator(`${AGENT.root} .ica-agent-field-error:not([hidden])`).first().scrollIntoViewIfNeeded();
                    await settle(page);
                },
            },
            leaveState({
                make: makeAgentDirty,
                dirty: AGENT.dirty,
                leave: page => leaveDirtyDetail(page, { back: AGENT.back, otherRow: `${AGENTS} [data-sb-list-key^="agent:"]:not([data-sb-list-key="agent:${FIXTURES.agents.tracker.id}"])` }),
            }),
        ],
        needs: ['agents'],
        sources: [`${EXTENSIONS}/in-chat-agents/ui/agent-editor.js`, `${EXTENSIONS}/in-chat-agents/ui/agent-editor-properties.js`, `${CSS}/sillybunny-persona-detail.css`, `${CSS}/sillybunny-prompt-editor.css`],
        primaryFlow: true,
    },
    {
        id: 'editor.quick-reply',
        family: 'editor',
        editorType: 'single',
        owner: 'B',
        title: 'Quick Reply editor',
        root: QUICK_REPLY,
        ready: [`${QUICK_REPLY} #qr--modal-label`, `${QUICK_REPLY} #qr--modal-message`],
        open: openQuickReplyEditor,
        close: popupClose(QUICK_REPLY),
        states: [
            {
                id: 'icon-picker',
                root: 'dialog.popup[open]:has(.faPicker-container)',
                ready: 'dialog.popup[open] .faQuery',
                async open(page) {
                    await page.locator(`${QUICK_REPLY} #qr--modal-icon`).click();
                    await shown(page, 'dialog.popup[open]:has(.faPicker-container) .faQuery');
                    await settled(page, 'dialog.popup[open]:has(.faPicker-container)');
                },
            },
            {
                id: 'switcher-open',
                ready: `${QUICK_REPLY} .qr--modal-switcherList`,
                async open(page) {
                    await page.locator(`${QUICK_REPLY} #qr--modal-switcher`).click();
                    await shown(page, `${QUICK_REPLY} .qr--modal-switcherList`);
                    await settled(page, `${QUICK_REPLY} .qr--modal-switcherList`);
                },
            },
        ],
        needs: ['quick-replies'],
        sources: [`${EXTENSIONS}/quick-reply/src/sillybunny-editor.js`, `${EXTENSIONS}/quick-reply/html/qrEditor.html`],
        overlay: true,
    },
    {
        id: 'editor.regex',
        family: 'editor',
        editorType: 'single',
        owner: 'B',
        title: 'Regex editor',
        root: REGEX,
        ready: [`${REGEX} .regex_script_name`, `${REGEX} .find_regex`],
        open: page => openRegexEditor(page),
        close: popupClose(REGEX),
        states: [
            {
                id: 'new-script',
                ready: `${REGEX} .regex_script_name`,
                open: page => openRegexEditor(page, { script: null }),
            },
            {
                id: 'test-mode',
                ready: [`${REGEX} #regex_test_input`, `${REGEX} #regex_test_output`],
                async open(page) {
                    await page.locator(`${REGEX} #regex_test_mode_toggle`).click();
                    await shown(page, `${REGEX} #regex_test_input`);
                    await settled(page, REGEX);
                },
            },
            {
                id: 'validation-error',
                ready: `${REGEX} #regex_info_block.error`,
                async open(page) {
                    await page.locator(`${REGEX} .find_regex`).fill('/an unclosed (group/');
                    await shown(page, `${REGEX} #regex_info_block.error`);
                    // The info block slides in with jQuery, which `settle` cannot see.
                    await page.waitForFunction(() => !window.$(':animated').length);
                    await settle(page);
                },
            },
        ],
        needs: ['regex-scripts'],
        sources: [`${EXTENSIONS}/regex/index.js`, `${EXTENSIONS}/regex/editor.html`],
        overlay: true,
    },
];
