/**
 * Open steps for the six editors (character, group, World Info entry, persona, prompt, agent), the panes of Global
 * Settings, and the selection modes of the lists. Each step runs on a booted app and can run again on a surface that is
 * already open. Nothing here imports Playwright: a step takes the `page` that the caller passes.
 */

import { FIXTURES } from './fixture-data.js';
import { chooseMenuItem, openCharactersTab, openSettingsTab, settle } from './steps.js';

export const shown = (page, selector) => page.locator(selector).first().waitFor({ state: 'visible' });
export const gone = (page, selector) => page.locator(selector).first().waitFor({ state: 'hidden' });

/** A title long enough to need the ellipsis in the header of an editor. */
export const LONG_TITLE = 'A very long editor title for the header check';

/**
 * Goes back from a detail pane that covers its list (on a phone, and in some desktop layouts), when one is open, so that a
 * step that opens the list again also works from a surface that is already open.
 */
export async function leaveDetail(page, back) {
    const button = page.locator(back).first();
    if (await button.isVisible()) {
        await button.click();
        await button.waitFor({ state: 'hidden' });
    }
}

/**
 * Changes the editor so that its dirty indicator shows: types into a field, or, where the title is renamed in place
 * (`rename` is the title button), renames it, which also puts the new title into the header. Then leaves the field, so
 * that a long title is shown from its start.
 */
export async function makeDirty(page, { field, rename, dirty, value = LONG_TITLE }) {
    if (rename) {
        await page.locator(rename).click();
        const input = page.locator('.sb-editor-title-input');
        await input.fill(value);
        await input.press('Enter');
    } else {
        await page.locator(field).first().fill(value);
        await page.locator(field).first().blur();
    }
    await shown(page, dirty);
    await settle(page);
}

/**
 * Drops the unsaved changes of an open editor with its Cancel button, when the dirty mark shows. Cancel keeps the editor
 * open, so an editor that an earlier state changed is clean again before it is opened.
 */
export async function discardEdits(page, { dirty, cancel }) {
    const mark = page.locator(dirty).first();
    if (!await mark.isVisible()) {
        return;
    }
    await page.locator(cancel).first().click();
    await mark.waitFor({ state: 'hidden' });
}

/** Leaves selection mode with its Cancel button, when the mode is on. */
export async function leaveSelection(page, cancel) {
    const button = page.locator(cancel).first();
    if (await button.isVisible()) {
        await button.click();
        await button.waitFor({ state: 'hidden' });
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------------------------------------------------

export const CHARACTER_LIST = '.sb-character-list[data-mounted="true"]';

export async function openCharacterList(page) {
    await openCharactersTab(page, 'characters');
    await shown(page, CHARACTER_LIST);
    await settle(page);
}

export async function openCharacterEditor(page) {
    await page.evaluate(async avatar => {
        await window.SillyBunnyShell.openTab('characters', 'characters');
        const app = await import('/script.js');
        if (!app.characters.length) {
            await app.getCharacters();
        }
        const index = app.characters.findIndex(character => character.avatar === avatar);
        if (index < 0) {
            throw new Error(`The audit character ${avatar} is not on the server.`);
        }
        app.setCharacterId(index);
        app.select_selected_character(index);
    }, FIXTURES.character.avatar);
    await shown(page, '#sb_character_editor_header');
    await settle(page);
}

/** Goes from the open character editor to the editor of a new character. */
export async function openCharacterCreate(page) {
    await page.locator('#sb_character_editor_back').click();
    await shown(page, CHARACTER_LIST);
    await page.locator('.sb-character-list [data-action-id="new"]').click();
    await page.locator('#right-nav-panel[data-menu-type="create"]').waitFor();
    await shown(page, '#sb_character_editor_header');
    await settle(page);
}

export async function openGroupEditor(page) {
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
    await settle(page);
}

/** Starts selection mode from the header menu of a list. */
export async function enterSelection(page, { trigger, item, header }) {
    await chooseMenuItem(page, trigger, item);
    await shown(page, header);
    await settle(page);
}

export const enterCharacterSelection = page => enterSelection(page, {
    trigger: '.sb-character-list__header [data-action-id="more"]',
    item: 'Select',
    header: '.sb-character-list__selection-header .sb-selection-header',
});

// ---------------------------------------------------------------------------------------------------------------------
// World Info
// ---------------------------------------------------------------------------------------------------------------------

export async function openWorldInfoBook(page, name) {
    await page.evaluate(async name => {
        await window.SillyBunnyShell.openTab('characters', 'world-info');
        const { openWorldInfoEditor } = await import('/scripts/world-info.js');
        await openWorldInfoEditor(name);
    }, name);
    await leaveDetail(page, '#WorldInfo .sb-wi-entry .sb-wi-detail-back');
    await shown(page, '#WorldInfo .sb-wi-editor .sb-wi-row');
    await settle(page);
}

/** Opens the first entry of the audit lorebook in the detail pane. */
export async function openWorldInfoEntry(page) {
    await openWorldInfoBook(page, FIXTURES.lorebook.name);
    await page.locator('#WorldInfo .sb-wi-editor .sb-wi-row').first().click();
    await shown(page, '#WorldInfo .sb-wi-entry .sb-wi-entry-header');
    await settle(page);
}

export const enterWorldInfoSelection = page => enterSelection(page, {
    trigger: '#WorldInfo .sb-wi-book-actions',
    item: 'Select',
    header: '#WorldInfo .sb-wi-selection-header .sb-selection-header',
});

// ---------------------------------------------------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------------------------------------------------

export async function openPersonaList(page) {
    await openCharactersTab(page, 'persona');
    await shown(page, '#PersonaManagement .sb-persona-list-header');
    await settle(page);
}

export async function openPersonaDetail(page) {
    await openCharactersTab(page, 'persona');
    await page.evaluate(async avatarId => {
        const { openPersonaEditor } = await import('/scripts/sillybunny-persona-editor.js');
        if (!await openPersonaEditor({ avatarId })) {
            throw new Error('Could not open the audit persona.');
        }
    }, FIXTURES.persona.avatar);
    await shown(page, '#PersonaManagement .sb-persona-editor .sb-persona-entry-header');
    await settle(page);
}

/** Opens a pane of the Characters shell that its list menu leads to. */
export function openGlobalSettingsPane({ tab, host, trigger, root }) {
    return async page => {
        await openCharactersTab(page, tab);
        await shown(page, `${host} ${trigger}`);
        await chooseMenuItem(page, `${host} ${trigger}`, 'Global Settings');
        await shown(page, `${host} ${root}`);
        await settle(page);
    };
}

// ---------------------------------------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------------------------------------

export const PROMPT_ROW = '.sb-prompt-row[data-prompt-id="main"]';

export async function openPromptList(page) {
    await openSettingsTab(page, { shell: 'left', tab: 'editor' });
    await leaveDetail(page, '.sb-prompt-detail .sb-prompt-detail-header [aria-label="Back to Prompt List"]');
    await shown(page, '.sb-prompt-editor .sb-prompt-list-header');
    await settle(page);
}

export async function openPromptDetail(page) {
    await openPromptList(page);
    await page.locator(`${PROMPT_ROW} .sb-prompt-row-name`).click();
    await shown(page, '.sb-prompt-detail .sb-prompt-detail-header');
    await settle(page);
}

// ---------------------------------------------------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------------------------------------------------

export const AGENTS = '.ica-agents-editor';

export async function openAgentList(page) {
    await openSettingsTab(page, { shell: 'left', tab: 'agents' });
    await leaveDetail(page, `${AGENTS} .ica-agent-detail .sb-persona-detail-back`);
    await shown(page, `${AGENTS} .sb-list-header`);
    await settle(page);
}

export async function openAgentDetail(page) {
    await openAgentList(page);
    await page.locator(`${AGENTS} [data-sb-list-key="agent:${FIXTURES.agents.tracker.id}"]`).evaluate(node => node.click());
    await shown(page, `${AGENTS} .ica-agent-detail .sb-persona-entry-header`);
    await settle(page);
}

export async function enterAgentSelection(page) {
    await page.locator(`${AGENTS}`).getByRole('button', { name: 'Agents Menu', exact: true }).click();
    await page.locator('.sb-action-menu').last().getByRole('menuitem', { name: 'Select', exact: true }).click();
    await shown(page, `${AGENTS} .sb-selection-header`);
    await settle(page);
}
