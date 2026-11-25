/**
 * What the settings inventory does not touch, and why. Record mode copies the matching rule into the fixture next to the
 * control (`exception: { reason, lands }`), so the fixture says on its own why a control is not round-tripped, and check mode
 * reads it from there. A rule changes nothing about whether the control exists and can be reached: those checks always run.
 */

/**
 * Data-driven lists inside a page, which are not settings: one entry per background file, per prompt of the loaded preset, per
 * character, lorebook, quick reply set or agent of the library, one entry per row of the selected logit bias preset, and the hidden
 * store of extension containers (each extension's own controls are inventoried through its subpage). Keyed by the surface id, by the
 * surface id and `#` and the state id, or by `extension:` and the container of an extension subpage.
 */
export const SKIP_SELECTORS = Object.freeze({
    'settings.backend.sampling': ['.openai_logit_bias_list', '.logit_bias_list'],
    'settings.backend.editor': ['#completion_prompt_manager_list', '.sb-prompt-box'],
    'settings.backend.agents': ['.ica-agents-group'],
    'settings.conversation.panel': ['.sb-conversation-partner-list'],
    'settings.customize.appearance': ['.bg_list'],
    'settings.customize.extensions': ['.sb-subpage-store'],
    'extension:extension_settings_in_chat_agents_pathfinder': ['#pf--lorebook-list'],
    'extension:qr_container': ['.qr--setList', '.qr--set-qrListContents'],
});

/**
 * What a page has when it has finished loading, for the pages that fill themselves from the server after the page's own
 * ready selector is there. Until then every control of Data & Security is disabled and its branch select does not exist.
 */
const READY_EXTRAS = Object.freeze({
    'settings.customize.data-security': [
        '#sb-branch-select',
        '[data-sb-panel="data-security"] button:has-text("Restart Server"):enabled',
        '[data-sb-panel="data-security"] button:has-text("Save Thumbnails"):enabled',
        '[data-sb-panel="data-security"] button:has-text("Save Config"):enabled',
    ],
});

/** @param {string} surfaceId */
export const readyExtrasFor = surfaceId => [...(READY_EXTRAS[surfaceId] ?? [])];

/**
 * Saved settings that change as a side effect of other controls, and so say nothing about the control that was just changed:
 * the app writes them the first time a connection, a preset or a panel is used.
 * @type {readonly { path: RegExp, reason: string }[]}
 */
export const IGNORED_PATHS = Object.freeze([
    { path: /^accountStorage\.WelcomePage_GettingStarted$/, reason: 'the Getting Started checklist marks a step done when a connection or a preset changes' },
    { path: /^accountStorage\.StoryStringValidationCache$/, reason: 'a cache of the story string check, written when a context template is read' },
    { path: /^accountStorage\.WINavOpened$/, reason: 'remembers that the World Info panel was opened' },
]);

/**
 * The differences from the recorded fixture that a rebuild of the settings pages makes on purpose, one entry per control and
 * section (the shapes are described with `ACCEPTED_KINDS`). The check passes for an entry while the difference occurs and
 * fails once it no longer does, so an entry is removed together with the change that makes the fixture agree. Moving a control to another
 * group or giving a group another title needs no entry: the group is not compared.
 * @type {readonly { section: string, identity?: string, difference: 'kind' | 'left' | 'arrived' | 'renamed' | 'added' | 'unreachable', from?: string, to?: string, problem?: string, coveredBy?: string, reason: string }[]}
 */
export const ACCEPTED_DIFFERENCES = Object.freeze([]);

/** @param {string} path A dotted path of the saved settings. */
export const isIgnoredPath = path => IGNORED_PATHS.some(rule => rule.path.test(path));

/**
 * @param {string} surfaceId
 * @param {string} [stateId]
 * @returns {string[]}
 */
export function skipSelectorsFor(surfaceId, stateId) {
    return [...(SKIP_SELECTORS[surfaceId] ?? []), ...(stateId ? (SKIP_SELECTORS[`${surfaceId}#${stateId}`] ?? []) : [])];
}

/**
 * Controls whose value must not be changed by the round trip. A rule matches on the control's identity (a regular
 * expression) and, when it lists kinds, on the kind. `lands` says where the value goes when it is not the saved settings.
 * @type {readonly { identity: RegExp, kinds?: string[], reason: string, lands?: string }[]}
 */
export const EXCEPTION_RULES = Object.freeze([
    {
        identity: /^#ui_language_select$/,
        reason: 'a change of language stores it and reloads the page, which ends the run',
        lands: 'the browser\'s local storage, key "language"',
    },
    {
        identity: /^field:backend-type:radio/,
        reason: 'the backend picker of Connections: choosing a backend rebuilds the page, and the backend is a parameter of every section',
        lands: 'main_api, with the source in oai_settings.chat_completion_source or textgenerationwebui_settings.type',
    },
    {
        identity: /^#(?:settings_preset(?:_[a-z]+)?|instruct_presets|context_presets|sysprompt_select|reasoning_select|openai_logit_bias_preset|custom_endpoint_preset)$/,
        kinds: ['select'],
        reason: 'picking a preset loads all of its values at once, and the round trip cannot put every one of them back',
        lands: 'the name of the preset in the settings; its values come from a preset file on the server or a bundled preset',
    },
    {
        identity: /^#sb-branch-select$/,
        kinds: ['select'],
        reason: 'choosing a branch asks to switch the git checkout of the running server, and the confirmation stays open over the page',
        lands: 'a request to the server admin API (/api/server-admin/switch-branch), not the settings',
    },
    {
        identity: /^#sb-config-(?:prompt-caching-enabled|claude-extended-ttl|claude-caching-depth|claude-adaptive-thinking|gemini-api-version|gemini-thought-signatures)$/,
        reason: 'changing a server config flag saves it at once to config.yaml through the server admin API rather than to browser settings',
        lands: 'a request to the server admin API (/api/server-admin/config/chat-completions/save), not the settings',
    },
    {
        identity: /^#themes$/,
        kinds: ['select'],
        reason: 'picking a theme applies its whole set of colours, fonts and blur at once',
        lands: 'twelve or more power_user keys; the theme is a file on the server (/api/themes) or a bundled one',
    },
    {
        identity: /^#model_novel_select$/,
        kinds: ['select'],
        reason: 'a NovelAI model change loads that model\'s default sampler values, which replaces about eighteen settings',
        lands: 'nai_settings.* with amount_gen and max_context',
    },
]);

/**
 * The exception that applies to a control, or null. A secret field is always one: its value goes to the secrets store, and a
 * round trip would write a key.
 * @param {{ identity: string, kind: string, secret?: boolean }} control
 * @returns {{ reason: string, lands?: string } | null}
 */
export function exceptionFor(control) {
    if (control.secret) {
        return { reason: 'a secret field: its value is saved through the secrets API, and a round trip would write a key', lands: 'the secrets store (/api/secrets/write), not the settings' };
    }
    const rule = EXCEPTION_RULES.find(candidate => candidate.identity.test(control.identity) && (!candidate.kinds || candidate.kinds.includes(control.kind)));
    return rule ? { reason: rule.reason, ...(rule.lands && { lands: rule.lands }) } : null;
}
