/**
 * The Window tier of the dialog family: a list, an editor or a viewer, opened from a place that a user reaches. Most are
 * Popups that an adapter moves into the Window frame (Data Bank, Extensions manager, Data Maid, Token Counter), the rest are
 * `openDialog` windows (mass delete, the greeting art viewer).
 *
 * A window that pushes a page (the Data Bank shows a file, the admin panel shows a form) has the page as a state: the root
 * of a state is the Window frame that is on top, because a Popup page over its parent marks the parent `data-sb-covered`.
 */

import { FIXTURES } from './fixture-data.js';
import { stubAccounts } from './dialog-form.js';
import { ALERT_FRAME, auditCharacterIndex, closeDialogs, closeFrame, closeMenus, oncePerPage, openAuditChat, settleFrame, waitForChatQuiet, WINDOW_FRAME, within } from './dialog-steps.js';
import { isBottomBarChipRow, selectBackend, settle } from './steps.js';

const SCRIPTS = 'public/scripts';
const ADAPTERS = `${SCRIPTS}/sillybunny-editor/adapters`;
const TOP_WINDOW = 'dialog.popup.sb-dialog--window[open]:not([closing]):not([data-sb-covered])';
const TOP_POPUP = 'dialog.popup[open]:not([closing]):not([data-sb-covered])';
const TOP_DIALOG = 'dialog.popup.sb-dialog--dialog[open]:not([closing]):not([data-sb-covered])';

/**
 * @param {object} entry
 * @param {string} entry.id The last segments of the id, after `dialog.window.`.
 * @param {boolean} [entry.upstreamMarkup] Whether the content is upstream's (a template or builder of an upstream-origin file) and
 * SillyBunny supplies the frame; `false` for a window that SillyBunny or a bundled extension wrote.
 * @returns {import('./index.js').Surface}
 */
function windowEntry({ id, root = WINDOW_FRAME, owner = 'A', upstreamMarkup = true, ...rest }) {
    return {
        id: `dialog.window.${id}`,
        family: 'dialog',
        owner,
        root,
        close: closeFrame(root),
        needs: [],
        ...(upstreamMarkup && { upstreamMarkup }),
        ...rest,
    };
}

/** Clicks a control that no visible button reaches, the way its handler is bound: through the DOM. */
const clickIn = (page, selector) => page.evaluate(selector => document.querySelector(selector).click(), selector);

/** A state that pushes a page of a Popup Window over the Window that is open. */
function windowPage({ id, trigger, marker, ready, after }) {
    return {
        id,
        root: `${TOP_WINDOW}:has(${marker})`,
        ready: ready ?? `${TOP_WINDOW} ${marker}`,
        async open(page) {
            await trigger(page);
            await page.locator(`${TOP_WINDOW} ${marker}`).waitFor({ state: 'visible' });
            await settleFrame(page, TOP_WINDOW);
            await after?.(page);
        },
    };
}

// The fixture of the Settings Snapshots window: one snapshot, with its text.
const SNAPSHOT = { name: 'audit-snapshot', date: Date.UTC(2026, 0, 1, 12), size: 512 };

// The fixture of the Data Maid report: files that no chat or character refers to.
const MAID_FILES = Array.from({ length: 24 }, (_, index) => ({
    name: `orphan-file-${String(index + 1).padStart(2, '0')}.txt`,
    hash: `audit-hash-${index}`,
    parent: 'audit-fixture',
    size: 48 + index,
    mtime: Date.UTC(2026, 0, 1, 12) + index * 60_000,
}));

const SECRET_KEYS = Array.from({ length: 6 }, (_, index) => ({ id: `audit-secret-${index}`, value: 'sk-...masked', label: `Audit key ${index + 1}`, active: index === 0 }));

/**
 * Answers the secret routes from the page, and has the app read them again: the app read its secret state at start, before
 * the routes were installed. The server of a run holds no secrets, and every route that would write is left alone.
 */
async function stubSecrets(page) {
    await oncePerPage(page, 'dialog-secrets', async () => {
        await page.route('**/api/secrets/read', route => route.fulfill({ json: { api_key_openai: SECRET_KEYS } }));
        await page.route('**/api/secrets/settings', route => route.fulfill({ json: { allowKeysExposure: true } }));
        await page.route('**/api/secrets/view', route => route.fulfill({ json: { api_key_openai: 'sk-audit-fixture-value' } }));
        await page.route(/\/api\/secrets\/(?:write|delete|rotate|rename)$/, route => route.fulfill({ status: 400, body: 'Refused by the dialog audit' }));
    });
    await page.evaluate(async () => (await import('/scripts/secrets.js')).readSecretState());
}

/** The itemised prompt that the Prompt Itemization window reads, from `window-content-dialogs.e2e.js`. */
const ITEMIZED_PROMPT = {
    mesId: 0,
    rawPrompt: [{ role: 'system', content: 'Audit prompt line one.\nAudit prompt line two.' }],
    main_api: 'openai',
    charDescription: 'Character description fixture',
    charPersonality: 'Character personality fixture',
    scenarioText: 'Character scenario fixture',
    userPersona: 'Persona fixture',
    worldInfoString: 'World information fixture',
    allAnchors: 'Extension fixture',
    summarizeString: 'Summary fixture',
    authorsNoteString: 'Author note fixture',
    smartContextString: 'Context fixture',
    beforeScenarioAnchor: '',
    afterScenarioAnchor: '',
    zeroDepthAnchor: '',
    padding: 0,
    chatInjects: '',
    chatVectorsString: '',
    dataBankVectorsString: '',
    presetName: 'Audit preset',
    messagesCount: '1',
    examplesCount: '1',
    oaiStartTokens: 10,
    oaiPromptTokens: 25,
    oaiMainTokens: 20,
    oaiConversationTokens: 15,
    oaiExamplesTokens: 4,
    oaiBiasTokens: 2,
    oaiJailbreakTokens: 1,
    oaiNudgeTokens: 1,
    oaiImpersonateTokens: 0,
    oaiNsfwTokens: 0,
    finalPrompt: 'OpenAI itemization fixture',
};

/** @type {import('./index.js').Surface[]} */
export const surfaces = [
    windowEntry({
        id: 'admin-panel',
        title: 'Admin panel (user list with a row menu; New User and the account actions push pages)',
        ready: within(WINDOW_FRAME, '.usersList .userAccount'),
        masks: [within(WINDOW_FRAME, '.userCreated')],
        async open(page) {
            await closeDialogs(page);
            await stubAccounts(page, { admin: true });
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'data-security'));
            await page.locator('#admin_button').waitFor({ state: 'attached' });
            await page.evaluate(() => window.$('#admin_button').trigger('click'));
            await settleFrame(page, WINDOW_FRAME);
            await page.locator(within(WINDOW_FRAME, '.usersList .userAccount')).first().waitFor({ state: 'visible' });
        },
        states: [
            windowPage({
                id: 'new-user',
                marker: '.userCreateForm',
                async trigger(page) {
                    await page.locator(`${TOP_WINDOW} .sb-dialog__header .newUserButton`).first().click();
                },
            }),
            {
                id: 'delete-user',
                root: `${TOP_DIALOG}:has(#deleteUserHandle)`,
                ready: `${TOP_DIALOG} #deleteUserHandle`,
                async open(page) {
                    await page.locator(within(WINDOW_FRAME, '.usersList .userAccount .userOverflowButton')).first().click();
                    await page.getByRole('menuitem', { name: 'Delete user account.', exact: true }).click();
                    await page.locator(`${TOP_DIALOG} #deleteUserHandle`).waitFor({ state: 'visible' });
                    await settleFrame(page, TOP_DIALOG);
                },
            },
        ],
        sources: [`${SCRIPTS}/user.js`, `${ADAPTERS}/window-content-dialogs.js`],
    }),
    windowEntry({
        id: 'settings-snapshots',
        title: 'Settings Snapshots (list of snapshots that expand to their text)',
        ready: within(WINDOW_FRAME, '.snapshotList > .snapshot'),
        masks: [within(WINDOW_FRAME, '.snapshotDate')],
        async open(page) {
            await closeDialogs(page);
            await oncePerPage(page, 'dialog-snapshots', async () => {
                await page.route('**/api/settings/get-snapshots', route => route.fulfill({ json: [SNAPSHOT] }));
                await page.route('**/api/settings/load-snapshot', route => route.fulfill({ contentType: 'text/plain', body: '{\n    "fixture": "snapshot content"\n}\n' }));
                await page.route(/\/api\/settings\/(?:make-snapshot|restore-snapshot)$/, route => route.fulfill({ status: 400, body: 'Refused by the dialog audit' }));
            });
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'data-security'));
            await page.locator('#settings_snapshots_button').waitFor({ state: 'attached' });
            await clickIn(page, '#settings_snapshots_button');
            await settleFrame(page, WINDOW_FRAME);
            await page.locator(within(WINDOW_FRAME, '.snapshotList > .snapshot')).first().waitFor({ state: 'visible' });
        },
        states: [{
            id: 'snapshot-expanded',
            ready: within(WINDOW_FRAME, '.snapshotContent'),
            async open(page) {
                await page.locator(within(WINDOW_FRAME, '.snapshotExpandButton')).first().click();
                await page.locator(within(WINDOW_FRAME, '.snapshotContent')).first().waitFor({ state: 'visible' });
            },
        }],
        sources: [`${SCRIPTS}/user.js`, `${ADAPTERS}/window-content-dialogs.js`],
    }),
    windowEntry({
        id: 'data-bank',
        title: 'Data Bank (header search, sort and add menus; a list of attachments with row actions)',
        ready: [within(WINDOW_FRAME, '.dataBankAttachments'), within(WINDOW_FRAME, '.attachmentListItem')],
        needs: ['character', 'chat', 'databank'],
        masks: [within(WINDOW_FRAME, '.attachmentListItemCreated')],
        async open(page) {
            await closeDialogs(page);
            await openAuditChat(page);
            await clickIn(page, '#manageAttachments');
            await settleFrame(page, WINDOW_FRAME);
            await page.locator(within(WINDOW_FRAME, '.attachmentListItem')).first().waitFor({ state: 'visible' });
        },
        states: [
            windowPage({
                id: 'attachment-view',
                marker: '.file_modal',
                async trigger(page) {
                    await clickIn(page, '.dataBankAttachments .attachmentListItem .viewAttachmentButton');
                },
            }),
            windowPage({
                id: 'attachment-edit',
                marker: '[name="notepadFileContent"]',
                async trigger(page) {
                    await clickIn(page, '.dataBankAttachments .attachmentListItem .editAttachmentButton');
                },
            }),
        ],
        sources: [`${SCRIPTS}/chats.js`, `${ADAPTERS}/data-bank-dialog.js`, `${SCRIPTS}/extensions/attachments/index.js`],
    }),
    windowEntry({
        id: 'extensions-manager',
        title: 'Extensions manager (header sort and menu buttons; sections of extension rows)',
        ready: [within(WINDOW_FRAME, '.extensions-header-menus'), within(WINDOW_FRAME, '.extension_block')],
        // The version of each extension changes with the build and is updated after the list is shown.
        masks: [within(WINDOW_FRAME, '.extension_version')],
        async open(page) {
            await closeDialogs(page);
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'extensions'));
            await page.locator('#extensions_details').waitFor({ state: 'visible' });
            // A click of Playwright would scroll the button into view, and with it the page behind the Window.
            await page.locator('#extensions_details').evaluate(button => button.click());
            await settleFrame(page, WINDOW_FRAME);
            await page.locator(within(WINDOW_FRAME, '.extension_block')).first().waitFor({ state: 'visible' });
        },
        sources: [`${SCRIPTS}/extensions.js`, `${ADAPTERS}/extensions-manager-dialog.js`],
    }),
    windowEntry({
        id: 'api-key-manager',
        title: 'API key manager (list of saved keys with row actions)',
        ready: within(WINDOW_FRAME, '.secretKeyManager'),
        async open(page) {
            await closeDialogs(page);
            await stubSecrets(page);
            await clickIn(page, '.manage-api-keys[data-key="api_key_openai"]');
            await settleFrame(page, WINDOW_FRAME);
            await page.locator(within(WINDOW_FRAME, '.secretKeyManagerList > *')).first().waitFor({ state: 'visible' });
        },
        states: [
            {
                id: 'add-key',
                root: `${TOP_POPUP}:has(#newSecretLabel)`,
                ready: `${TOP_POPUP} #newSecretLabel`,
                async open(page) {
                    await page.locator(within(WINDOW_FRAME, '[data-action="add-secret"]')).first().click();
                    await page.locator(`${TOP_POPUP} #newSecretLabel`).waitFor({ state: 'visible' });
                    await settleFrame(page, TOP_POPUP);
                },
            },
            ...[
                ['rename-key', 'rename-secret', '.popup-input'],
                ['delete-key', 'delete-secret', '.popup-button-ok.is-destructive'],
            ].map(([id, action, marker]) => ({
                id,
                root: ALERT_FRAME,
                ready: within(ALERT_FRAME, marker),
                async open(page) {
                    await clickIn(page, `.secretKeyManagerList [data-action="${action}"]`);
                    await page.locator(within(ALERT_FRAME, marker)).first().waitFor({ state: 'visible' });
                    await settleFrame(page, ALERT_FRAME);
                },
            })),
        ],
        sources: [`${SCRIPTS}/secrets.js`],
    }),
    windowEntry({
        id: 'secrets-view',
        title: 'Secrets view (a table of the stored API keys and their values, from the API connection panel)',
        ready: [within(WINDOW_FRAME, 'table.responsiveTable'), within(WINDOW_FRAME, 'table.responsiveTable tr')],
        async open(page) {
            await closeDialogs(page);
            await stubSecrets(page);
            await clickIn(page, '#viewSecrets');
            await settleFrame(page, WINDOW_FRAME);
            await page.locator(within(WINDOW_FRAME, 'table.responsiveTable tr')).first().waitFor({ state: 'visible' });
        },
        sources: [`${SCRIPTS}/secrets.js`],
    }),
    ...[
        ['regex-editor', 'Regex script editor (find, replace and the places the script runs)', 'open_regex_editor', '.regex_editor'],
        ['regex-debugger', 'Regex debugger (a test input and two output panes)', 'open_regex_debugger', '.regex-debugger-container'],
    ].map(([id, title, button, marker]) => windowEntry({
        id,
        title,
        ready: within(WINDOW_FRAME, marker),
        needs: ['regex-scripts'],
        async open(page) {
            await closeDialogs(page);
            await clickIn(page, `#${button}`);
            await settleFrame(page, WINDOW_FRAME);
            await page.locator(within(WINDOW_FRAME, marker)).first().waitFor({ state: 'visible' });
        },
        sources: [`${SCRIPTS}/extensions/regex/index.js`],
    })),
    windowEntry({
        id: 'quick-reply-editor',
        title: 'Quick Reply editor (label, message and the options of one reply)',
        ready: within(WINDOW_FRAME, '#qr--modalEditor'),
        needs: ['quick-replies'],
        async open(page) {
            await closeDialogs(page);
            await page.evaluate(async (setName) => {
                const { QuickReplySet } = await import('/scripts/extensions/quick-reply/src/QuickReplySet.js');
                const set = QuickReplySet.list.find(candidate => candidate.name === setName);
                if (!set) {
                    throw new Error(`The Quick Reply set ${setName} is not loaded.`);
                }
                void set.qrList[0].showEditor();
            }, FIXTURES['quick-replies'].main.name);
            await settleFrame(page, WINDOW_FRAME);
            await page.locator(within(WINDOW_FRAME, '#qr--modalEditor')).first().waitFor({ state: 'visible' });
        },
        sources: [`${SCRIPTS}/extensions/quick-reply/src/sillybunny-editor.js`, `${SCRIPTS}/extensions/quick-reply/src/QuickReply.js`],
    }),
    windowEntry({
        id: 'token-counter',
        title: 'Token Counter (text area, tokenizer and the token results)',
        ready: [within(WINDOW_FRAME, '#token_counter_textarea'), within(WINDOW_FRAME, '#token_counter_ids')],
        async open(page) {
            await closeDialogs(page);
            await clickIn(page, '#token_counter');
            await settleFrame(page, WINDOW_FRAME);
            await page.locator(within(WINDOW_FRAME, '#token_counter_textarea')).first().waitFor({ state: 'visible' });
        },
        sources: [`${SCRIPTS}/extensions/token-counter/index.js`, `${ADAPTERS}/window-tools-dialogs.js`],
    }),
    windowEntry({
        id: 'sampler-select',
        title: 'Sampler selection (a list of checks, one for each sampler)',
        ready: within(WINDOW_FRAME, '#apiSamplersList'),
        async open(page) {
            await closeDialogs(page);
            // The list is read for the sampler of the backend in use, and Chat Completion has none.
            await selectBackend(page, 'text-completion');
            await clickIn(page, '#samplerSelectButton');
            await settleFrame(page, WINDOW_FRAME);
            await page.locator(within(WINDOW_FRAME, '#apiSamplersList')).first().waitFor({ state: 'visible' });
        },
        sources: [`${SCRIPTS}/samplerSelect.js`, `${ADAPTERS}/window-tools-dialogs.js`],
    }),
    windowEntry({
        id: 'data-maid',
        title: 'Data Maid (scan button in the header; a report of categories and their files)',
        owner: 'C',
        ready: within(WINDOW_FRAME, '.dataMaidStartButton'),
        async open(page) {
            await closeDialogs(page);
            await oncePerPage(page, 'dialog-data-maid', async () => {
                await page.route('**/api/data-maid/report', route => route.fulfill({ json: {
                    token: 'audit-data-maid-token',
                    report: { files: MAID_FILES, images: [], chats: [], groupChats: [], avatarThumbnails: [], backgroundThumbnails: [], personaThumbnails: [], chatBackups: [], settingsBackups: [] },
                } }));
                await page.route(/\/api\/data-maid\/(?:delete|finalize|view)/, route => route.fulfill({ status: 400, body: 'Refused by the dialog audit' }));
            });
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'data-security'));
            await page.locator('#data_maid_button').waitFor({ state: 'attached' });
            await clickIn(page, '#data_maid_button');
            await settleFrame(page, WINDOW_FRAME);
            await page.locator(within(WINDOW_FRAME, '.dataMaidStartButton')).first().waitFor({ state: 'visible' });
        },
        states: [{
            id: 'report',
            ready: within(WINDOW_FRAME, '.dataMaidCategory'),
            async open(page) {
                await page.locator(within(WINDOW_FRAME, '.dataMaidStartButton')).first().click();
                await page.locator(within(WINDOW_FRAME, '.dataMaidCategory')).first().waitFor({ state: 'visible' });
                await settle(page);
            },
        }],
        sources: [`${SCRIPTS}/data-maid-dialog.js`, `${SCRIPTS}/data-maid.js`, `${ADAPTERS}/window-tools-dialogs.js`],
    }),
    windowEntry({
        id: 'debug-menu',
        title: 'Debug menu (a list of actions, each with a description)',
        ready: within(WINDOW_FRAME, '[data-debug-function]'),
        async open(page) {
            await closeDialogs(page);
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'data-security'));
            await page.locator('#debug_menu').waitFor({ state: 'attached' });
            await page.evaluate(() => window.$('#debug_menu').trigger('click'));
            await settleFrame(page, WINDOW_FRAME);
            await page.locator(within(WINDOW_FRAME, '[data-debug-function]')).first().waitFor({ state: 'visible' });
        },
        sources: [`${SCRIPTS}/power-user.js`, `${ADAPTERS}/window-tools-dialogs.js`],
    }),
    windowEntry({
        id: 'prompt-itemization',
        title: 'Prompt itemization (token breakdown of one prompt and its raw text)',
        ready: within(WINDOW_FRAME, '#showRawPrompt'),
        async open(page) {
            await closeDialogs(page);
            await page.evaluate(async (prompt) => {
                const { promptItemize } = await import('/scripts/itemized-prompts.js');
                void promptItemize([prompt], 0);
            }, ITEMIZED_PROMPT);
            await settleFrame(page, WINDOW_FRAME);
            await page.locator(within(WINDOW_FRAME, '#showRawPrompt')).first().waitFor({ state: 'visible' });
        },
        sources: [`${SCRIPTS}/itemized-prompts.js`],
    }),
    windowEntry({
        id: 'scenario-override',
        title: 'Chat scenario override (three text areas: scenario, example messages and system prompt)',
        ready: within(WINDOW_FRAME, '#chat_scenario_override'),
        needs: ['character', 'chat'],
        async open(page) {
            await closeDialogs(page);
            await openAuditChat(page);
            await page.evaluate(async () => {
                const { setCharacterSettingsOverrides } = await import('/script.js');
                void setCharacterSettingsOverrides();
            });
            await settleFrame(page, WINDOW_FRAME);
            await page.locator(within(WINDOW_FRAME, '#chat_scenario_override')).first().waitFor({ state: 'visible' });
        },
        sources: ['public/script.js', `${ADAPTERS}/window-content-dialogs.js`, 'public/scripts/templates/scenarioOverride.html'],
    }),
    windowEntry({
        id: 'custom-endpoint-parameters',
        title: 'Custom endpoint additional parameters (YAML text areas and the reasoning parameter rows)',
        ready: [within(WINDOW_FRAME, '#custom_include_body'), within(WINDOW_FRAME, '#custom_reasoning_preset')],
        async open(page) {
            await closeDialogs(page);
            await clickIn(page, '#customize_additional_parameters');
            await settleFrame(page, WINDOW_FRAME);
            await page.locator(within(WINDOW_FRAME, '#custom_include_body')).first().waitFor({ state: 'visible' });
        },
        sources: [`${SCRIPTS}/openai.js`, `${ADAPTERS}/window-content-dialogs.js`],
    }),
    windowEntry({
        id: 'prompt-inspector',
        title: 'Prompt Inspector (the prompt as editable text, with Save changes, Discard changes and Cancel generation)',
        ready: [within(WINDOW_FRAME, '#inspectPrompt'), within(WINDOW_FRAME, '.popup-button-custom')],
        owner: 'C',
        upstreamMarkup: false,
        async open(page) {
            await closeDialogs(page);
            await selectBackend(page, 'chat-completion');
            await page.locator('#inspectNextPromptButton').waitFor({ state: 'attached' });
            // The extension asks for the prompt only once its toggle is on, and the toggle is a button of the wand menu.
            if (await page.evaluate(() => localStorage.getItem('promptInspectorEnabled') !== 'true')) {
                await clickIn(page, '#inspectNextPromptButton');
            }
            await page.evaluate(async () => {
                const { eventSource, eventTypes } = window.SillyTavern.getContext();
                const chat = [{ role: 'system', content: 'Audit system prompt.' }, { role: 'user', content: 'Audit user message.' }];
                void eventSource.emit(eventTypes.CHAT_COMPLETION_PROMPT_READY, { chat, dryRun: false });
            });
            await settleFrame(page, WINDOW_FRAME);
            await page.locator(within(WINDOW_FRAME, '#inspectPrompt')).first().waitFor({ state: 'visible' });
        },
        sources: [`${SCRIPTS}/extensions/prompt-inspector/index.js`, 'public/scripts/extensions/prompt-inspector/style.css'],
    }),
    windowEntry({
        id: 'debugger-report',
        title: 'Bunny Debugger diagnostic report (action buttons over one read-only text area)',
        ready: [within(WINDOW_FRAME, '.sbdbg-report'), within(WINDOW_FRAME, '.sbdbg-report-text')],
        owner: 'C',
        upstreamMarkup: false,
        masks: [within(WINDOW_FRAME, '.sbdbg-report-text')],
        async open(page) {
            await closeDialogs(page);
            // The debugger is off until a user turns it on in Bundled Extras, so the audit starts it the way the extension loader does.
            await page.evaluate(async () => (await import('/scripts/extensions/sillybunny-debugger/index.js')).init());
            await page.waitForFunction(() => [...document.querySelectorAll('[data-extension-name="SillyBunny-Debugger"] .ds-button-row')].some(button => button.textContent.trim() === 'Diagnostic report'));
            await page.evaluate(() => [...document.querySelectorAll('[data-extension-name="SillyBunny-Debugger"] .ds-button-row')].find(button => button.textContent.trim() === 'Diagnostic report').click());
            await settleFrame(page, WINDOW_FRAME);
            await page.locator(within(WINDOW_FRAME, '.sbdbg-report-text')).first().waitFor({ state: 'visible' });
        },
        sources: [`${SCRIPTS}/extensions/sillybunny-debugger/src/ui.js`, `${SCRIPTS}/extensions/sillybunny-debugger/style.css`],
    }),
    windowEntry({
        id: 'comfy-workflow-editor',
        title: 'ComfyUI workflow editor (one JSON text area that fills the window)',
        ready: within(WINDOW_FRAME, '#sd_comfy_workflow_editor_workflow'),
        async open(page) {
            await closeDialogs(page);
            await oncePerPage(page, 'dialog-comfy', async () => {
                await page.route('**/api/sd/comfy/workflow', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify('{\n    "fixture": "original workflow"\n}') }));
                await page.route(/\/api\/sd\/comfy\/(?:save-workflow|delete-workflow)$/, route => route.fulfill({ json: [] }));
                await page.addStyleTag({ url: '/scripts/extensions/stable-diffusion/style.css' });
            });
            await page.evaluate(async () => {
                const extensions = await import('/scripts/extensions.js');
                extensions.extension_settings.sd ??= {};
                extensions.extension_settings.sd.comfy_workflow = 'Audit Workflow.json';
                const stableDiffusion = await import('/scripts/extensions/stable-diffusion/index.js');
                if (!document.getElementById('sd_comfy_open_workflow_editor')) {
                    await stableDiffusion.init();
                }
                document.getElementById('sd_comfy_open_workflow_editor').click();
            });
            await settleFrame(page, WINDOW_FRAME);
            await page.locator(within(WINDOW_FRAME, '#sd_comfy_workflow_editor_workflow')).first().waitFor({ state: 'visible' });
        },
        sources: [`${SCRIPTS}/extensions/stable-diffusion/index.js`, `${ADAPTERS}/window-content-dialogs.js`],
    }),
    windowEntry({
        id: 'assets-browser',
        title: 'Characters asset browser (a list of downloadable character assets with a download button each)',
        ready: [within(WINDOW_FRAME, '.characterAsset'), within(WINDOW_FRAME, '.characterAssetDownloadButton')],
        async open(page) {
            await closeDialogs(page);
            await oncePerPage(page, 'dialog-assets', async () => {
                await page.route('https://assets.example.test/characters.json', route => route.fulfill({
                    contentType: 'application/json',
                    headers: { 'access-control-allow-origin': '*' },
                    body: JSON.stringify(Array.from({ length: 36 }, (_, index) => ({
                        type: 'character',
                        id: `audit-character-${String(index).padStart(2, '0')}`,
                        name: `Audit Character ${String(index).padStart(2, '0')}`,
                        description: 'Audit list fixture',
                        url: `https://assets.example.test/character-${index}.svg`,
                    }))),
                }));
                await page.route('https://assets.example.test/character-*.svg', route => route.fulfill({
                    contentType: 'image/svg+xml',
                    body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>',
                }));
                await page.route(/\/api\/assets\/(?:get|download)$/, route => route.fulfill({ json: {} }));
            });
            await page.evaluate(async () => {
                const assets = await import('/scripts/extensions/assets/index.js');
                if (!document.getElementById('assets-characters-button')) {
                    await assets.init();
                }
                document.getElementById('assets-json-url-field').value = 'https://assets.example.test/characters.json';
                document.getElementById('assets-characters-button').click();
            });
            await settleFrame(page, WINDOW_FRAME);
            await page.locator(within(WINDOW_FRAME, '.characterAsset')).first().waitFor({ state: 'visible' });
        },
        sources: [`${SCRIPTS}/extensions/assets/index.js`],
    }),
    windowEntry({
        id: 'maximized-editor',
        title: 'Maximised text editor (one text area that fills the window)',
        ready: within(WINDOW_FRAME, 'textarea.maximized_textarea'),
        needs: ['character'],
        async open(page) {
            await closeDialogs(page);
            await closeMenus(page);
            const index = await auditCharacterIndex(page);
            await page.evaluate(async (chid) => {
                const core = await import('/script.js');
                core.setCharacterId(chid);
                core.select_selected_character(chid, { switchMenu: false });
            }, index);
            await page.locator('.editor_maximize[data-for="description_textarea"]').first().waitFor({ state: 'attached' });
            await clickIn(page, '.editor_maximize[data-for="description_textarea"]');
            await settleFrame(page, WINDOW_FRAME);
            await page.locator(within(WINDOW_FRAME, 'textarea.maximized_textarea')).first().waitFor({ state: 'visible' });
        },
        sources: [`${SCRIPTS}/chats.js`],
    }),
    windowEntry({
        id: 'mass-delete-chats',
        upstreamMarkup: false,
        title: 'Mass delete chats (list of chat files with checks; a Dialog page over the chat actions on a narrow window)',
        root: 'dialog.sb-dialog-host:not([closing]) section.sb-dialog.sb-chat-mass-delete, dialog.sb-dialog-host:not([closing]) .sb-dialog__page.sb-chat-mass-delete',
        ready: ['dialog.sb-dialog-host:not([closing]) .sb-chat-delete-row', 'dialog.sb-dialog-host:not([closing]) .sb-chat-delete-presets'],
        // The list holds every chat of the open character: those of `chat`, `chat-long`, `chat-very-long` and the three of `archived-chats`.
        needs: ['character', 'chat', 'chat-long', 'chat-very-long', 'archived-chats'],
        async open(page) {
            await closeDialogs(page);
            await openAuditChat(page);
            const paged = await isBottomBarChipRow(page);
            if (paged) {
                await page.locator('.sb-bottom-chat-chip').click();
            }
            const actions = page.locator(paged ? '#sb-bottom-chat-sheet .sb-bottom-chat-sheet-actions' : '#sb-bottom-chat-bar .sb-bottom-chat-management-actions');
            await actions.getByRole('button', { name: 'Mass delete chats', exact: true }).click();
            await page.locator('dialog.sb-dialog-host:not([closing]) .sb-chat-delete-row').first().waitFor({ state: 'visible' });
            // The count of chats older than the age depends on the date of the run. The seeded chats are from the first days of
            // January 2026, so with the shortest age every one of them counts, on any later day.
            await page.locator('dialog.sb-dialog-host:not([closing]) .sb-chat-delete-presets button', { hasText: /^7$/ }).click();
            await settleFrame(page, 'dialog.sb-dialog-host:not([closing]) .sb-chat-mass-delete');
        },
        sources: [`${SCRIPTS}/sillybunny-chat-dialogs.js`],
    }),
    windowEntry({
        id: 'greeting-art-viewer',
        upstreamMarkup: false,
        title: 'Greeting art viewer (the picture above the greeting of a bundled assistant, enlarged)',
        root: 'dialog.sb-dialog-host:not([closing]) section.sbGreetingArtDialog',
        ready: 'dialog.sb-dialog-host:not([closing]) .sbGreetingArtLarge',
        async open(page) {
            await closeDialogs(page);
            await closeMenus(page);
            const start = page.locator('#chat > .welcomePanel .sbHomeCard[data-sb-home-key="assistant-reisen"] .sbHomeFootButton').first();
            await start.waitFor({ state: 'visible' });
            await start.click();
            const opener = page.locator('#chat .sbGreetingArt .sbGreetingArtOpen');
            await opener.waitFor({ state: 'visible', timeout: 30_000 });
            // The chat is printed more than once while it opens, and a button that is replaced loses its click.
            await waitForChatQuiet(page, { refocuses: true });
            await opener.click();
            await settleFrame(page, 'dialog.sb-dialog-host:not([closing]) section.sbGreetingArtDialog');
            await page.waitForFunction(() => {
                const image = document.querySelector('dialog.sb-dialog-host:not([closing]) .sbGreetingArtLarge');
                return image?.complete && image.naturalWidth > 0;
            });
        },
        sources: [`${SCRIPTS}/sillybunny-home/greeting-art-viewer.js`, `${SCRIPTS}/sillybunny-home/greeting-art-opening.js`],
        primaryFlow: true,
    }),
];
