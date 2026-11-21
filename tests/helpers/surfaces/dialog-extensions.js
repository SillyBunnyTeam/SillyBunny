/**
 * Dialogs of the bundled extensions: the in-chat agents (their list, their editor and the Popups they open), the
 * guided-generations member choice and the TTS voices list. Each is a Popup that the extension opens with a tier, so the
 * frames are the ones of `dialog-steps.js`. They are owner A: the dialogs are SillyBunny's own, and only the TTS list is
 * built from upstream's extension (`upstreamMarkup`).
 *
 * The agent dialogs are reached through the Agents tab the way a user reaches them: a row menu, the Agents menu, the
 * selection mode, or the agent editor. Nothing is answered; Escape cancels, so no agent is changed, converted or deleted.
 */

import { FIXTURES } from './fixture-data.js';
import { ALERT_FRAME, closeDialogs, closeFrame, closeMenus, DIALOG_FRAME, oncePerPage, openAuditChat, openAuditGroupChat, settleFrame, WINDOW_FRAME, within } from './dialog-steps.js';
import { settle } from './steps.js';

const EXTENSION = 'public/scripts/extensions/in-chat-agents';
const AGENTS = '.ica-agents-editor';
const DETAIL = `${AGENTS} .ica-agent-detail`;

const rowOf = id => `${AGENTS} [data-sb-list-key="agent:${id}"]`;

/**
 * @param {object} entry
 * @param {'alert' | 'dialog' | 'window'} entry.tier
 * @param {string} entry.id The last segments of the id, after `dialog.<tier>.`.
 * @returns {import('./index.js').Surface}
 */
function extensionEntry({ tier, id, root = { alert: ALERT_FRAME, dialog: DIALOG_FRAME, window: WINDOW_FRAME }[tier], ...rest }) {
    return {
        id: `dialog.${tier}.${id}`,
        family: 'dialog',
        owner: 'A',
        root,
        close: closeFrame(root),
        needs: [],
        ...rest,
    };
}

/** Opens the Agents tab on its list, with no dialog or menu open. */
async function openAgentsList(page) {
    await closeDialogs(page);
    await closeMenus(page);
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'agents'));
    const back = page.locator(`${DETAIL} .sb-persona-detail-back`);
    if (await back.isVisible()) {
        await back.click();
    }
    await page.locator(`${AGENTS} .sb-list-header`).first().waitFor({ state: 'visible' });
    await page.locator(`${AGENTS} [data-sb-list-key^="agent:"]`).first().waitFor({ state: 'visible' });
    await settle(page);
}

const OUTDATED = { id: 'audit-agent-outdated', name: 'Audit Outdated Agent', template: 'tpl-drift-tracker' };

/**
 * Adds an agent that is older than its bundled template to the list, in the page only: the app brings a saved agent up to date
 * when it starts, so a seeded one would not stay old. From `in-chat-agents-list.e2e.js` (`Update All stays an Alert`).
 */
async function addOutdatedAgent(page) {
    await page.evaluate(async (outdated) => {
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        const catalogue = await import('/scripts/extensions/in-chat-agents/catalogue.js');
        const templates = await (await fetch('/scripts/extensions/in-chat-agents/templates/index.json')).json();
        const agent = catalogue.buildAgentFromTemplate(templates.find(item => item.id === outdated.template));
        agent.id = outdated.id;
        agent.name = outdated.name;
        agent.version = 0;
        store.loadAgents([...store.getAgents().filter(saved => saved.id !== outdated.id), agent]);
        (await import('/scripts/extensions/in-chat-agents/ui/agent-list.js')).refreshAgentsPanels();
    }, OUTDATED);
    await page.locator(rowOf(OUTDATED.id)).waitFor({ state: 'visible' });
}

/** Opens a menu of the list header and chooses an item of it. */
async function chooseFromHeaderMenu(page, button, item) {
    await page.locator(AGENTS).getByRole('button', { name: button, exact: true }).first().click();
    await page.locator('.sb-action-menu').last().getByRole('menuitem', { name: item }).click();
}

/** Opens the row menu of an agent and chooses an item of it. */
async function chooseFromRowMenu(page, agentId, item) {
    await page.locator(`${rowOf(agentId)} button[aria-label="Agent Menu"]`).click();
    await page.locator('.sb-action-menu').last().getByRole('menuitem', { name: item }).click();
}

/** Enters the selection mode of the list and selects the rows. */
async function selectAgents(page, ids) {
    await chooseFromHeaderMenu(page, 'Agents Menu', 'Select');
    await page.locator(`${AGENTS} .ica-agents-selection-actions`).first().waitFor({ state: 'attached' });
    for (const id of ids) {
        await page.locator(rowOf(id)).evaluate(node => node.click());
    }
    await page.waitForFunction(() => !document.querySelector('.ica-agents-selection-more')?.disabled);
}

/** Opens an agent in the editor from the list. */
async function openAgentEditor(page, agentId) {
    await openAgentsList(page);
    await page.locator(rowOf(agentId)).evaluate(node => node.click());
    await page.locator(`${DETAIL} .sb-persona-entry-header`).waitFor({ state: 'visible' });
    await page.locator(`${DETAIL} [data-sb-editor-field="prompt"] textarea`).waitFor({ state: 'visible' });
    await settle(page);
}

/** Runs an action of the agent editor's header: its button where it is shown, its item in the More menu where it is collapsed. */
async function activateEditorAction(page, label) {
    const direct = page.locator(DETAIL).getByRole('button', { name: label, exact: true });
    if (await direct.isVisible()) {
        await direct.click();
        return;
    }
    await page.locator(`${DETAIL} .sb-persona-entry-more`).click();
    await page.locator('.sb-action-menu').last().getByRole('menuitem', { name: label, exact: true }).click();
}

/** @type {import('./index.js').Surface[]} */
export const surfaces = [
    extensionEntry({
        tier: 'alert',
        id: 'agent-convert-trackers',
        title: 'Agents: convert trackers to companions (Popup confirm from the Agents menu)',
        ready: [within(ALERT_FRAME, '.popup-button-ok'), within(ALERT_FRAME, '.popup-button-cancel')],
        needs: ['agents'],
        async open(page) {
            await openAgentsList(page);
            await chooseFromHeaderMenu(page, 'Agents Menu', 'Convert Trackers to Companions…');
            await settleFrame(page, ALERT_FRAME);
        },
        sources: [`${EXTENSION}/index.js`, `${EXTENSION}/ui/agent-list.js`],
    }),
    extensionEntry({
        tier: 'alert',
        id: 'agent-update-all',
        title: 'Agents: update all agents to their templates (Popup confirm with a list of the agents)',
        ready: [within(ALERT_FRAME, '.ica--update-all-list'), within(ALERT_FRAME, '.popup-button-ok')],
        needs: ['agents'],
        async open(page) {
            await openAgentsList(page);
            await addOutdatedAgent(page);
            await chooseFromHeaderMenu(page, 'Agents Menu', /^Update All/);
            await settleFrame(page, ALERT_FRAME);
        },
        sources: [`${EXTENSION}/index.js`, `${EXTENSION}/ui/agent-list.js`],
    }),
    extensionEntry({
        tier: 'alert',
        id: 'agent-update-one',
        title: 'Agents: update one agent to its template (Popup confirm from the row menu)',
        ready: [within(ALERT_FRAME, '.popup-button-ok'), within(ALERT_FRAME, '.popup-button-cancel')],
        needs: ['agents'],
        async open(page) {
            await openAgentsList(page);
            await addOutdatedAgent(page);
            await chooseFromRowMenu(page, OUTDATED.id, /^Update to v/);
            await settleFrame(page, ALERT_FRAME);
        },
        sources: [`${EXTENSION}/index.js`, `${EXTENSION}/ui/agent-list.js`],
    }),
    extensionEntry({
        tier: 'alert',
        id: 'agent-delete',
        title: 'Agents: delete confirmation (destructive Popup confirm of the row menu, with its placeholder text)',
        ready: [within(ALERT_FRAME, '.popup-button-ok'), within(ALERT_FRAME, '.popup-button-cancel')],
        needs: ['agents'],
        async open(page) {
            await openAgentsList(page);
            await chooseFromRowMenu(page, FIXTURES.agents.disabled.id, 'Delete…');
            await settleFrame(page, ALERT_FRAME);
        },
        sources: ['public/scripts/sillybunny-delete-confirm.js', `${EXTENSION}/ui/agent-list.js`],
    }),
    extensionEntry({
        tier: 'dialog',
        id: 'agent-bulk-edit',
        title: 'Agents: bulk edit of the selected agents (a row of drop-downs for each property)',
        ready: [within(DIALOG_FRAME, '.ds-row'), within(DIALOG_FRAME, '.popup-button-ok')],
        needs: ['agents'],
        async open(page) {
            await openAgentsList(page);
            await selectAgents(page, [FIXTURES.agents.tracker.id, FIXTURES.agents.disabled.id]);
            await page.evaluate(() => document.querySelector('.ica-agents-selection-actions [data-action-id="properties"]').click());
            await settleFrame(page, DIALOG_FRAME);
        },
        sources: [`${EXTENSION}/index.js`, `${EXTENSION}/ui/dialog-adapters.js`, `${EXTENSION}/ui/agent-list.js`],
    }),
    extensionEntry({
        tier: 'dialog',
        id: 'agent-group-create',
        title: 'Agents: create a group from the selected agents (entries and a list of checks)',
        ready: [within(DIALOG_FRAME, '#ica--grp-name'), within(DIALOG_FRAME, '#ica--grp-agents input[type="checkbox"]')],
        needs: ['agents'],
        async open(page) {
            await openAgentsList(page);
            await selectAgents(page, [FIXTURES.agents.tracker.id, FIXTURES.agents.disabled.id]);
            await page.locator('.ica-agents-selection-more').click();
            await page.locator('.sb-action-menu').last().getByRole('menuitem', { name: 'Save as Group…' }).click();
            await settleFrame(page, DIALOG_FRAME);
        },
        sources: [`${EXTENSION}/index.js`, `${EXTENSION}/ui/dialog-adapters.js`, `${EXTENSION}/ui/agent-list.js`],
    }),
    extensionEntry({
        tier: 'dialog',
        id: 'agent-apply-target',
        title: 'Agents: apply an agent to a target (list of checks and a range entry; opened from the row menu with a chat open)',
        ready: [within(DIALOG_FRAME, 'input[name="ica--run-target"]'), within(DIALOG_FRAME, '.popup-button-ok')],
        needs: ['agents', 'character', 'chat'],
        async open(page) {
            await closeDialogs(page);
            await openAuditChat(page);
            await openAgentsList(page);
            await chooseFromRowMenu(page, FIXTURES.agents.disabled.id, 'Apply To…');
            await settleFrame(page, DIALOG_FRAME);
        },
        sources: [`${EXTENSION}/index.js`, `${EXTENSION}/ui/dialog-adapters.js`],
    }),
    extensionEntry({
        tier: 'dialog',
        id: 'agent-regex-script',
        title: 'Agent editor: add a regex script (entries, text areas, switches and a choice)',
        ready: [within(DIALOG_FRAME, '.ica-agent-regex-dialog'), within(DIALOG_FRAME, '.popup-button-ok')],
        needs: ['agents', 'agent-regex-script'],
        states: [{
            id: 'validation-error',
            ready: within(DIALOG_FRAME, '.ica-agent-field-error:not([hidden])'),
            async open(page) {
                await page.locator(within(DIALOG_FRAME, '.popup-button-ok')).first().click();
                await page.locator(within(DIALOG_FRAME, '.ica-agent-field-error:not([hidden])')).first().waitFor({ state: 'visible' });
                await settle(page);
            },
        }],
        async open(page) {
            await openAgentEditor(page, FIXTURES['agent-regex-script'].agent.id);
            await page.locator(`${DETAIL} button`, { hasText: 'Add Regex Script' }).first().evaluate(node => node.click());
            await settleFrame(page, DIALOG_FRAME);
        },
        sources: [`${EXTENSION}/ui/agent-editor-dialogs.js`, `${EXTENSION}/ui/agent-editor.js`],
    }),
    extensionEntry({
        tier: 'dialog',
        id: 'agent-ai-maker',
        title: 'Agent editor: AI Maker (one text area, opened over the draft of a new companion)',
        ready: [within(DIALOG_FRAME, '#ica--companion-maker-goal'), within(DIALOG_FRAME, '.popup-button-ok')],
        needs: ['agents'],
        async open(page) {
            await openAgentsList(page);
            await chooseFromHeaderMenu(page, 'Add Agent', 'AI Maker…');
            await settleFrame(page, DIALOG_FRAME);
        },
        sources: [`${EXTENSION}/ui/agent-editor-dialogs.js`, `${EXTENSION}/ui/agent-editor.js`],
    }),
    extensionEntry({
        tier: 'dialog',
        id: 'agent-refine',
        title: 'Agent editor: refine the prompt (a select row of the modes and a custom instruction)',
        ready: [within(DIALOG_FRAME, '.ds-row'), within(DIALOG_FRAME, '#ica--refine-custom')],
        needs: ['agents'],
        async open(page) {
            await openAgentEditor(page, FIXTURES.agents.disabled.id);
            await activateEditorAction(page, 'Refine…');
            await settleFrame(page, DIALOG_FRAME);
        },
        sources: [`${EXTENSION}/index.js`, `${EXTENSION}/ui/dialog-adapters.js`, `${EXTENSION}/ui/agent-editor.js`],
    }),
    extensionEntry({
        tier: 'window',
        id: 'agent-prompt-preview',
        title: 'Agents: preview of the prompt in context (read-only text in a window; opened from the row menu)',
        ready: within(WINDOW_FRAME, '.ica--prompt-preview pre'),
        needs: ['agents'],
        async open(page) {
            await openAgentsList(page);
            await chooseFromRowMenu(page, FIXTURES.agents.disabled.id, 'Preview Prompt in Context');
            await settleFrame(page, WINDOW_FRAME);
        },
        sources: [`${EXTENSION}/index.js`, `${EXTENSION}/ui/agent-list.js`, `${EXTENSION}/ui/agent-editor.css`],
    }),
    extensionEntry({
        tier: 'window',
        id: 'agent-tracker-kit',
        title: 'Agent editor: generated tracker kit (a preview of the kit and an entry for more instructions, with Regenerate)',
        ready: [within(WINDOW_FRAME, '.ica--tracker-preview-prompt'), within(WINDOW_FRAME, '.popup-button-ok')],
        needs: ['agents'],
        async open(page) {
            // The extension asks the model for the kit and falls back to a local scaffold when the request fails, so the audit refuses the request and gets the scaffold of the example.
            await oncePerPage(page, 'dialog-agent-kit', async () => {
                await page.route(/\/api\/backends\/[^/]+\/generate$/, route => route.fulfill({ status: 500, body: 'Refused by the dialog audit' }));
            });
            await openAgentEditor(page, FIXTURES.agents.tracker.id);
            await page.evaluate((example) => {
                const field = document.querySelector('.ica-agent-detail [data-sb-editor-field="trackerBuilder.format"] textarea');
                field.value = example;
                field.dispatchEvent(new Event('input', { bubbles: true }));
            }, '[TRACKER|Mood]\nCalm\n[/TRACKER]');
            await page.locator(`${DETAIL} button`, { hasText: 'Generate Kit…' }).first().evaluate(node => node.click());
            await settleFrame(page, WINDOW_FRAME);
        },
        sources: [`${EXTENSION}/ui/agent-editor-dialogs.js`, `${EXTENSION}/ui/agent-editor.js`, `${EXTENSION}/index.js`],
    }),
    extensionEntry({
        tier: 'dialog',
        id: 'group-member-choice',
        title: 'Guided generations: choose the member who responds (a list of buttons, one for each member of the open group)',
        ready: [within(DIALOG_FRAME, '.sb-dialog-choice-list'), within(DIALOG_FRAME, '.sb-dialog-choice-list .result-control')],
        needs: ['group', 'group-chat'],
        async open(page) {
            await closeDialogs(page);
            await closeMenus(page);
            await openAuditGroupChat(page);
            // A direct call of what the extension's member button calls: the choice is asked for when a guided generation starts.
            await page.evaluate(async () => {
                const { pickGroupMember } = await import('/scripts/extensions/guided-generations/scripts/groupSelection.js');
                void pickGroupMember();
            });
            await settleFrame(page, DIALOG_FRAME);
        },
        sources: ['public/scripts/extensions/guided-generations/scripts/groupSelection.js'],
    }),
    extensionEntry({
        tier: 'dialog',
        id: 'tts-voices',
        title: 'TTS: available voices (a list of buttons that preview a voice, for a provider with a fixed list)',
        upstreamMarkup: true,
        ready: [within(DIALOG_FRAME, '.voice_preview'), within(DIALOG_FRAME, '.voice_name')],
        async open(page) {
            await closeDialogs(page);
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'extensions'));
            await page.locator('#tts_provider').waitFor({ state: 'attached' });
            await page.evaluate(() => window.$('#tts_provider').val('OpenAI').trigger('change'));
            await page.waitForFunction(() => document.querySelector('#tts_provider_settings')?.children.length > 0);
            await page.evaluate(() => window.$('#tts_voices').trigger('click'));
            await settleFrame(page, DIALOG_FRAME);
        },
        sources: ['public/scripts/extensions/tts/index.js', 'public/scripts/extensions/tts/openai.js'],
    }),
];
