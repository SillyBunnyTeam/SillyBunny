/**
 * Open and close steps that the panel family shares, and the viewport lists that say where a panel exists. Each step is
 * copied from the spec that already does it (named on the function). Nothing here imports Playwright, so the registry
 * loads in Jest.
 */

import { FIXTURES } from './fixture-data.js';
import { selectBackend, settle } from './steps.js';

/** The viewports where the shell is in its mobile layout (`(max-width: 768px)`), so the phone sheets exist. */
export const MOBILE_LAYOUT_VIEWPORTS = ['768x1024', '390x844', '360x640', '360x294', '320x568'];

/** The viewports wider than the mobile layout, which still includes the two landscape phone sizes. */
export const WIDE_LAYOUT_VIEWPORTS = ['1440x900', '1024x600', '900x700', '844x390', '820x360'];

/**
 * The viewports where the four list-content editors have collapsed their property bar into a summary button, which opens
 * the property sheet. An editor collapses on the mobile layout or when its pane is under 720px (`isListEditorCollapsed`
 * in `list-shell.js`). Measured on each editor at all ten matrix viewports (`data-collapsed` on the editor and the display
 * of the summary button): all four collapse at exactly these eight, with panes of 276px to 716px, and none at 1024x600
 * (panes of 743px to 776px) or 1440x900 (1156px).
 */
export const COLLAPSED_EDITOR_VIEWPORTS = ['900x700', '844x390', '820x360', ...MOBILE_LAYOUT_VIEWPORTS];

/**
 * Opens the chat of the audit character. Every panel here needs a chat: the side panels hang off the chat's options menu,
 * and the bottom chat bar exists only beside a composer. From `chat-scroll-regression-helpers.js` (`selectSampleCharacter`)
 * and the Conversation steps of `settings.js`. Safe to call again: a chat that is open is left alone.
 * @param {import('@playwright/test').Page} page
 */
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
        if (String(context.characterId) !== String(index)) {
            await context.selectCharacterById(index, { switchMenu: false });
        }
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    }, { avatar: FIXTURES.character.avatar });
    await page.locator('#chat .mes').first().waitFor({ state: 'visible' });
    await settle(page);
}

const sidePanelSelector = id => `.sb-side-panel[data-sb-side-panel-id="${id}"]`;

/** A sheet springs in from below and passes over the composer, so only the settled position is the layout. */
export async function waitForPanelToSettle(page, id) {
    await page.waitForFunction(selector => {
        const panel = document.querySelector(selector);
        return Boolean(panel) && !panel.hidden;
    }, sidePanelSelector(id));
    await settle(page, { root: sidePanelSelector(id) });
}

/**
 * Opens a side panel the way a user does, from its entry in the options menu (or for the chat sidebar, the shell's toggle),
 * and waits until it has settled. From `side-panel-adapters.e2e.js` (`openPanel`).
 * @param {import('@playwright/test').Page} page
 * @param {{ id: string, trigger?: string }} panel `trigger` is the options-menu item; the chat sidebar has none.
 */
export async function openSidePanelById(page, { id, trigger }) {
    await openAuditChat(page);
    const shell = page.locator(sidePanelSelector(id));
    if (!(await shell.isVisible())) {
        if (trigger) {
            await page.evaluate(selector => document.querySelector(selector).click(), trigger);
        } else {
            await page.evaluate(() => window.SillyBunnyShell.toggleChatSidebar());
        }
    }
    await shell.waitFor({ state: 'visible' });
    await waitForPanelToSettle(page, id);
}

/**
 * Closes a side panel through the controller, as the Escape handler and the close button do. From
 * `side-panel-adapters.e2e.js` (`closePanel`).
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 */
export async function closeSidePanelById(page, id) {
    await page.evaluate(panelId => window.SillyBunnySidePanels.closeSidePanel(panelId, { restoreFocus: false }), id);
    await page.locator(sidePanelSelector(id)).waitFor({ state: 'hidden' });
}

/**
 * Closes whatever dialog host is open on top of an editor (a property sheet) with Escape, which is how a user leaves it.
 * @param {import('@playwright/test').Page} page
 * @param {string} root A selector of the sheet.
 */
export async function closeWithEscape(page, root) {
    await page.keyboard.press('Escape');
    await page.locator(root).first().waitFor({ state: 'hidden' });
}

/** Opens the bottom chat sheet from the chip of the bottom chat bar. From `sillybunny-mobile-overlays.e2e.js`. */
export async function openBottomChatSheet(page) {
    await openAuditChat(page);
    if (!await page.locator('#sb-bottom-chat-sheet').isVisible()) {
        await page.locator('#sb-bottom-chat-bar .sb-bottom-chat-chip').click();
    }
    await page.locator('#sb-bottom-chat-sheet').waitFor({ state: 'visible' });
    await settle(page, { root: '#sb-bottom-chat-sheet' });
}

export async function closeBottomChatSheet(page) {
    await page.locator('.sb-dialog-host .sb-bottom-chat-sheet-close').click();
    await page.locator('#sb-bottom-chat-sheet').waitFor({ state: 'hidden' });
}

/** Opens an entry of the audit lorebook in the World Info editor. From `sillybunny-mobile-overlays.e2e.js` (`openWorldInfoEntry`). */
export async function openWorldInfoEditorEntry(page) {
    await page.evaluate(async name => {
        const { openWorldInfoEditor } = await import('/scripts/world-info.js');
        if (!await openWorldInfoEditor(name)) {
            throw new Error(`Could not open the lorebook ${name}.`);
        }
    }, FIXTURES.lorebook.name);
    const editor = page.locator('#WorldInfo .sb-wi-editor');
    await editor.locator('.sb-wi-row').filter({ hasText: FIXTURES.lorebook.entries[0] }).first().click();
    await page.locator('#WorldInfo .sb-wi-entry').waitFor({ state: 'visible' });
    await settle(page);
}

/** Opens the audit persona in the persona editor. From `sillybunny-mobile-overlays.e2e.js` (`openPersonaEntry`). */
export async function openPersonaEditorEntry(page) {
    await page.evaluate(async avatarId => {
        const { openPersonaEditor } = await import('/scripts/sillybunny-persona-editor.js');
        if (!await openPersonaEditor({ avatarId })) {
            throw new Error(`Could not open the persona ${avatarId}.`);
        }
    }, FIXTURES.persona.avatar);
    await page.locator('.sb-persona-entry').waitFor({ state: 'visible' });
    await settle(page);
}

/** Opens the Main prompt in the prompt editor, which lists prompts for Chat Completion only. From `sillybunny-mobile-overlays.e2e.js` (`openPromptEntry`). */
export async function openPromptEditorEntry(page) {
    await selectBackend(page, 'chat-completion');
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'editor'));
    await page.locator('button[data-sb-settings-tab="editor"]').evaluate(button => button.click());
    await page.locator('.sb-prompt-row[data-prompt-id="main"] .sb-prompt-row-name').click();
    await page.locator('.sb-prompt-detail').waitFor({ state: 'visible' });
    await settle(page);
}

/** Opens the disabled agent of the `agents` need in the Agents editor. From `tests/helpers/in-chat-agents-editor.js` (`seedEditorAgents`, `openEditorAgents`). */
export async function openAgentEditorEntry(page) {
    await page.evaluate(async () => {
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        store.setGlobalSettings({ enabled: true, separateRecentChats: false });
        (await import('/scripts/extensions/in-chat-agents/ui/agent-list.js')).refreshAgentsPanels();
        await window.SillyBunnyShell.openTab('left', 'agents');
    });
    await page.locator('button[data-sb-settings-tab="agents"]').evaluate(button => button.click());
    await page.locator(`.ica-agents-editor [data-sb-list-key="agent:${FIXTURES.agents.disabled.id}"]`).evaluate(row => row.click());
    await page.locator('.ica-agents-editor .ica-agent-detail').waitFor({ state: 'visible' });
    await settle(page);
}

/**
 * The property sheet of a list-content editor: the dialog that the editor's summary button opens once it has collapsed its
 * property bar. `viewports` are the sizes where the editor is collapsed, so where the summary button and the sheet exist
 * (see `isListEditorCollapsed` in `list-shell.js`: a mobile layout, or an editor root narrower than 720px).
 * @typedef {object} PropertySheet
 * @property {string} root The dialog that holds the sheet.
 * @property {string} summary The button of the open item that opens it.
 * @property {string[]} viewports
 * @property {(page: import('@playwright/test').Page) => Promise<void>} openEditor Brings the editor to an open item.
 */

/** @type {Record<'worldInfo' | 'persona' | 'prompt' | 'agent', PropertySheet>} */
export const PROPERTY_SHEETS = {
    worldInfo: {
        root: '.sb-dialog.sb-world-info-properties-dialog',
        summary: '#WorldInfo .sb-wi-entry .sb-wi-property-summary',
        viewports: COLLAPSED_EDITOR_VIEWPORTS,
        openEditor: openWorldInfoEditorEntry,
    },
    persona: {
        root: '.sb-dialog.sb-persona-properties-dialog',
        summary: '.sb-persona-entry .sb-persona-property-summary',
        viewports: COLLAPSED_EDITOR_VIEWPORTS,
        openEditor: openPersonaEditorEntry,
    },
    prompt: {
        root: '.sb-dialog.sb-prompt-properties-dialog',
        summary: '.sb-prompt-detail .sb-prompt-property-summary',
        viewports: COLLAPSED_EDITOR_VIEWPORTS,
        openEditor: openPromptEditorEntry,
    },
    agent: {
        root: '.ica-agent-property-sheet',
        summary: '.ica-agents-editor .ica-agent-property-summary',
        viewports: COLLAPSED_EDITOR_VIEWPORTS,
        openEditor: openAgentEditorEntry,
    },
};

/**
 * Opens a property sheet: the editor, then its summary button. A sheet that is open is left alone.
 * @param {import('@playwright/test').Page} page
 * @param {PropertySheet} sheet
 */
export async function openPropertySheet(page, sheet) {
    if (await page.locator(sheet.root).first().isVisible()) {
        return;
    }
    await sheet.openEditor(page);
    await page.locator(sheet.summary).first().click();
    await page.locator(sheet.root).first().waitFor({ state: 'visible' });
    await settle(page, { root: sheet.root });
}

/** Leaves a property sheet with Escape. */
export const closePropertySheet = (page, sheet) => closeWithEscape(page, sheet.root);

export const openWorldInfoPropertySheet = page => openPropertySheet(page, PROPERTY_SHEETS.worldInfo);
export const openPersonaPropertySheet = page => openPropertySheet(page, PROPERTY_SHEETS.persona);
export const openPromptPropertySheet = page => openPropertySheet(page, PROPERTY_SHEETS.prompt);
export const openAgentPropertySheet = page => openPropertySheet(page, PROPERTY_SHEETS.agent);
