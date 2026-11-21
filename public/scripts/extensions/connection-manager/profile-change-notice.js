// Glue for the connection profile change notice: reads the live settings a profile switch touches, tracks where a
// switch came from, and runs one report per switch from the snapshot before the apply to the toast after it settles.
// It also keeps the "Also sets" line on the profile card. The pure rules live in profile-change-model.js.

import { amount_gen, event_types, eventSource, main_api, max_context, online_status } from '../../../script.js';
import { extension_settings } from '../../extensions.js';
import { translate } from '../../i18n.js';
import { kai_settings } from '../../kai-settings.js';
import { nai_settings } from '../../nai-settings.js';
import { oai_settings, settingsToUpdate } from '../../openai.js';
import { getChatCompletionSamplingSettingsKeys } from '../../openai-preset-utils.js';
import { power_user } from '../../power-user.js';
import { setting_names as textgenSettingNames, textgenerationwebui_settings } from '../../textgen-settings.js';
import { getAvailableTokenizers } from '../../tokenizers.js';
import { getScriptsByType, SCRIPT_TYPES } from '../regex/engine.js';
import {
    PROFILE_SNAPSHOT_NAMES,
    PROFILE_SWITCH_COPY,
    PROFILE_WATCH_LIST,
    SAMPLER_GROUP_BY_API,
    createBusyHintTracker,
    diffProfileSnapshots,
    formatProfileChange,
    getAppliedOverrideCommands,
    regexPresetMatchesLive,
    resolveRegexPresetName,
    resolveReportBaseline,
    waitForProfileSettle,
} from './profile-change-model.js';

/** @typedef {import('./profile-change-model.js').Snapshot} Snapshot */
/** @typedef {import('./profile-change-model.js').Change} Change */
/** @typedef {import('./profile-change-model.js').FormatHelpers} FormatHelpers */
/** @typedef {ReturnType<typeof formatProfileChange>} ProfileChangeLine */

/**
 * @typedef {object} ProfileSwitchStart Where a switch came from, read once at the start of the picker listener.
 * @property {'user'|'scripted'} origin Whether `/profile` marked the switch as scripted.
 * @property {boolean} notify Whether the switch may show a summary.
 * @property {string|null} previousProfileId The profile selected before the switch.
 */

/**
 * @typedef {object} ProfileSwitchReport One switch's report, from the snapshot before the apply to the summary.
 * @property {number} applySequence Sequence number of the switch.
 * @property {string} profileName Name of the profile being applied.
 * @property {boolean} notify Whether the summary is shown.
 * @property {Snapshot} before Baseline the switch is compared against.
 * @property {boolean} finished Whether the report is closed: delivered, dropped, silent, failed, abandoned, or closed by
 * a newer report. A superseded report stays open so the switch that superseded it can carry its BEFORE forward.
 * @property {boolean} watchRegexPreset Whether the profile sets a Regex preset, which arms the regex busy hint.
 * @property {ReturnType<typeof createBusyHintTracker>} tracker The switch's busy hints, first read at begin: a hint that
 * is on from begin and never drops does not count, and does not hide another hint that turns on later. The regex hint
 * is read as off at begin, so it counts as soon as it is on.
 */

/** @typedef {import('./profile-change-model.js').ProfileCommandTables} ProfileCommandTables */
/**
 * @typedef {ProfileCommandTables & { fancyNames: Record<string, string> }} ProfileChangeTables Command tables and the
 * display name per command id from cm/index.js, supplied by `initProfileChangeNotice`.
 */

const NONE_TEXT = '<None>';
const EMPTY_TEXT = '<Empty>';
const TRUNCATE_LENGTH = 40;
const KOBOLD_PRESET_SELECT = '#settings_preset';
const KOBOLD_GUI_PRESET = 'gui';
const PROFILE_SETS_LINE_ID = 'sb-connection-profile-sets';
// The busy hints of a profile apply, as the keys `readBusyHintStates` returns.
const BUSY_HINT_NAMES = Object.freeze(['api', 'offline', 'regex']);

// Text Completion settings that are not samplers: streaming and swipes have their own rows, the rest is connection state.
const TC_NON_SAMPLER_KEYS = new Set(['streaming', 'n', 'custom_model', 'bypass_status_check', 'openrouter_allow_fallbacks', 'generic_model', 'extensions']);
const KOBOLD_NON_SAMPLER_KEYS = new Set(['api_server', 'preset_settings', 'streaming_kobold', 'extensions']);
// The keys loadNovelPreset (nai-settings.js) assigns from a preset, in that order, minus `prefix` (its own row) and `extensions`.
const NOVEL_SAMPLER_KEYS = Object.freeze([
    'temperature',
    'repetition_penalty',
    'repetition_penalty_range',
    'repetition_penalty_slope',
    'repetition_penalty_frequency',
    'repetition_penalty_presence',
    'tail_free_sampling',
    'top_k',
    'top_p',
    'top_a',
    'typical_p',
    'min_length',
    'phrase_rep_pen',
    'mirostat_lr',
    'mirostat_tau',
    'banned_tokens',
    'order',
    'logit_bias',
    'preamble',
    'min_p',
    'math1_temp',
    'math1_quad',
    'math1_quad_entropy_scale',
]);
// Sampler key that holds the entries of the selected Logit Bias preset (one Sampling row, compared by value).
const CC_BIAS_ENTRIES_KEY = 'bias_preset_entries';

/** @type {{ notify: boolean } | null} */
let switchOrigin = null;
/** @type {ProfileSwitchReport | null} */
let openReport = null;
/** @type {ProfileChangeTables | null} */
let tables = null;
/** @type {JQuery<HTMLElement> | null} */
let previousSummary = null;
/** @type {string | null} Ids the card line shows, joined with `|`; null until the first refresh. */
let profileSetsKey = null;

/**
 * Reads and clears the switch origin. Called as the first statement of the picker listener, before its first await.
 * @returns {ProfileSwitchStart} Origin, notify flag and the profile selected before the switch
 */
export function takeProfileSwitchStart() {
    const token = switchOrigin;
    switchOrigin = null;
    const previousProfileId = extension_settings.connectionManager?.selectedProfile ?? null;
    if (token) {
        return { origin: 'scripted', notify: token.notify, previousProfileId };
    }
    return { origin: 'user', notify: true, previousProfileId };
}

/**
 * Marks the next picker switch as scripted. `/profile` calls it right before its own dispatch.
 * @param {{ notify: boolean }} options Whether the scripted switch may show a summary
 */
export function markScriptedProfileSwitch(options) {
    switchOrigin = { notify: Boolean(options?.notify) };
}

/**
 * Clears a scripted mark that no listener consumed.
 */
export function clearProfileSwitchOrigin() {
    switchOrigin = null;
}

/**
 * Whether a value is a non-null object.
 * @param {unknown} value Value
 * @returns {value is Record<string, any>} True for objects
 */
function isObject(value) {
    return typeof value === 'object' && value !== null;
}

/**
 * Gets the value of the Regex preset select, or an empty string when the Regex extension is not loaded.
 * @returns {string} Selected Regex preset id
 */
function getRegexPresetSelectValue() {
    const select = /** @type {HTMLSelectElement | null} */ (document.getElementById('regex_presets'));
    return select?.value ?? '';
}

/**
 * Gets the ids of the live Regex scripts of one type: every script, and the ones that are not disabled.
 * @param {number} scriptType Regex script type
 * @returns {{ all: string[], enabled: string[] }} Script ids
 */
function readRegexLiveScripts(scriptType) {
    const scripts = getScriptsByType(scriptType).filter(Boolean);
    return { all: scripts.map(script => script.id), enabled: scripts.filter(script => !script.disabled).map(script => script.id) };
}

/**
 * Gets the ids of the enabled Regex scripts of one type, read the same way as the Regex busy hint reads them.
 * @param {number} scriptType Regex script type
 * @returns {string[]} Script ids
 */
function getEnabledRegexScriptIds(scriptType) {
    return readRegexLiveScripts(scriptType).enabled;
}

/**
 * Gets the sampler keys of a main api with the settings object that holds them, in a fixed order.
 * @param {string} mainApi Main api id
 * @returns {{ settings: Record<string, any>, keys: string[] }} Settings object and keys
 */
function getSamplerSource(mainApi) {
    switch (mainApi) {
        case 'openai':
            return { settings: oai_settings, keys: [...getChatCompletionSamplingSettingsKeys(settingsToUpdate), 'seed', 'bias_preset_selected'] };
        case 'textgenerationwebui':
            return { settings: textgenerationwebui_settings, keys: textgenSettingNames.filter(key => !TC_NON_SAMPLER_KEYS.has(key)) };
        case 'kobold':
        case 'koboldhorde':
            return { settings: kai_settings, keys: Object.keys(kai_settings).filter(key => !KOBOLD_NON_SAMPLER_KEYS.has(key)) };
        case 'novel':
            return { settings: nai_settings, keys: [...NOVEL_SAMPLER_KEYS] };
        default:
            return { settings: {}, keys: [] };
    }
}

/**
 * Reads the sampler values of a main api, keyed in the order of its key list.
 * @param {string} mainApi Main api id
 * @returns {Record<string, unknown>} Sampler key to value
 */
function readSamplers(mainApi) {
    const { settings, keys } = getSamplerSource(mainApi);
    /** @type {Record<string, unknown>} */
    const samplers = {};
    for (const key of keys) {
        samplers[key] = settings[key];
    }
    if (mainApi === 'openai') {
        samplers[CC_BIAS_ENTRIES_KEY] = oai_settings.bias_presets?.[oai_settings.bias_preset_selected];
    }
    return samplers;
}

/**
 * Reads the samplers of every backend, one map per sampler group.
 * @returns {Record<string, Record<string, unknown>>} Sampler group to sampler map
 */
function readSamplerGroups() {
    const groups = [...new Set(Object.values(SAMPLER_GROUP_BY_API))];
    return Object.fromEntries(groups.map(group => [group, readSamplers(group)]));
}

/**
 * One reader per watch entry (spec Appendix A "Getter"). Readers only read; `readProfileSnapshot` clones the result.
 * Content objects are literals so their keys keep a fixed order for the JSON comparison. No reader depends on the main
 * api: each reads a settings object, binding or select that exists whatever backend is selected.
 * @type {Readonly<Record<string, () => unknown>>}
 */
const SNAPSHOT_READERS = Object.freeze({
    'preset.openai': () => oai_settings.preset_settings_openai,
    'preset.textgenerationwebui': () => textgenerationwebui_settings.preset,
    'preset.kobold': () => kai_settings.preset_settings,
    'preset.novel': () => nai_settings.preset_settings_novel,
    'gen.openai_max_tokens': () => Number(oai_settings.openai_max_tokens),
    'gen.openai_max_context': () => Number(oai_settings.openai_max_context),
    'gen.amount_gen': () => Number(amount_gen),
    'gen.max_context': () => Number(max_context),
    'gen.stream_openai': () => Boolean(oai_settings.stream_openai),
    'gen.streaming_textgen': () => Boolean(textgenerationwebui_settings.streaming),
    'gen.streaming_kobold': () => Boolean(kai_settings.streaming_kobold),
    'gen.n_openai': () => Number(oai_settings.n),
    'gen.n_textgen': () => Number(textgenerationwebui_settings.n),
    'gen.nai_prefix': () => nai_settings.prefix,
    'sysprompt.enabled': () => Boolean(power_user.sysprompt?.enabled),
    'sysprompt.name': () => power_user.sysprompt?.name,
    'sysprompt.content': () => ({
        content: power_user.sysprompt?.content,
        post_history: power_user.sysprompt?.post_history,
    }),
    'instruct.enabled': () => Boolean(power_user.instruct?.enabled),
    'instruct.name': () => power_user.instruct?.preset,
    'context.name': () => power_user.context?.preset,
    'names.always_force_name2': () => Boolean(power_user.always_force_name2),
    'names.names_behavior_openai': () => Number(oai_settings.names_behavior),
    'request.show_thoughts': () => Boolean(oai_settings.show_thoughts),
    'request.reasoning_effort': () => oai_settings.reasoning_effort,
    'request.verbosity': () => oai_settings.verbosity,
    'request.enable_web_search': () => Boolean(oai_settings.enable_web_search),
    'request.request_images': () => Boolean(oai_settings.request_images),
    'request.request_image_resolution': () => oai_settings.request_image_resolution,
    'request.request_image_aspect_ratio': () => oai_settings.request_image_aspect_ratio,
    'reasoning.name': () => power_user.reasoning?.name,
    'reasoning.content': () => ({
        prefix: power_user.reasoning?.prefix,
        suffix: power_user.reasoning?.suffix,
        separator: power_user.reasoning?.separator,
    }),
    'fmt.tokenizer': () => Number(power_user.tokenizer),
    'fmt.custom_stopping_strings': () => power_user.custom_stopping_strings,
    'prefill.user_prompt_bias': () => String(power_user.user_prompt_bias ?? ''),
    'fmt.single_line': () => Boolean(power_user.single_line),
    'fmt.trim_sentences': () => Boolean(power_user.trim_sentences),
    'samplers': () => readSamplerGroups(),
    'regex.preset': () => resolveRegexPresetName(extension_settings.regex_presets, getRegexPresetSelectValue()),
    'regex.content': () => ({
        global: getEnabledRegexScriptIds(SCRIPT_TYPES.GLOBAL),
        scoped: getEnabledRegexScriptIds(SCRIPT_TYPES.SCOPED),
        preset: getEnabledRegexScriptIds(SCRIPT_TYPES.PRESET),
    }),
});

/**
 * Reads every watched setting, whatever the main api, so a switch across backends can be compared on the entries of
 * the backend it lands on. Samplers are read for every sampler group. The preset-scope Regex script ids are read under
 * the global `main_api`. Pure: nothing is normalized or written while reading.
 * @param {string} [mainApi] Main api id the snapshot is labelled with, the current one by default. It only labels the
 * snapshot: it selects no entries and changes no reading
 * @returns {Snapshot} Deep-cloned values, one per watch entry
 */
export function readProfileSnapshot(mainApi = main_api) {
    /** @type {Record<string, unknown>} */
    const values = {};
    for (const entry of PROFILE_WATCH_LIST) {
        const read = SNAPSHOT_READERS[entry.id];
        if (read) {
            values[entry.id] = read();
        }
    }
    return { mainApi, values: structuredClone(values) };
}

/**
 * Gets a tokenizer's name from the tokenizer list.
 * @param {unknown} value Tokenizer id
 * @returns {string | undefined} Name, if the id is listed
 */
function getTokenizerName(value) {
    try {
        return getAvailableTokenizers().find(tokenizer => tokenizer.tokenizerId === Number(value))?.tokenizerName;
    } catch {
        return undefined;
    }
}

/**
 * Gets the label of a Character Names Behavior radio. `#names_behavior` is a hidden input with no options.
 * @param {unknown} value Names behavior value
 * @returns {string | undefined} Label, if a radio has that value
 */
function getNamesBehaviorText(value) {
    const radio = document.querySelector(`input[name="character_names"][value="${CSS.escape(String(value))}"]`);
    return radio?.closest('label')?.querySelector('span')?.textContent?.trim() || undefined;
}

/**
 * Text sources for selects whose stored value has no matching option.
 * @type {Readonly<Record<string, (value: unknown) => string | undefined>>}
 */
const OPTION_TEXT_FALLBACKS = Object.freeze({
    '#tokenizer': getTokenizerName,
    '#names_behavior': getNamesBehaviorText,
});

/**
 * Gets the visible text of the option holding a value, or the value itself.
 * @param {string} selectId Select selector, e.g. `#tokenizer`
 * @param {unknown} value Stored value
 * @returns {string} Display text
 */
function getOptionText(selectId, value) {
    const text = document.querySelector(`${selectId} option[value="${CSS.escape(String(value))}"]`)?.textContent?.trim();
    if (text) {
        return text;
    }
    return OPTION_TEXT_FALLBACKS[selectId]?.(value) || String(value);
}

/**
 * Gets the translated display name of a command id. Falls back to the id before init or for an unknown id.
 * @param {string} id Command id
 * @returns {string} Display name
 */
function fancyName(id) {
    return tables?.fancyNames?.[id] ? translate(tables.fancyNames[id]) : id;
}

/**
 * Builds the display helpers for `formatProfileChange`, reading the locale at call time.
 * @returns {FormatHelpers} Helpers
 */
function getFormatHelpers() {
    return {
        translate,
        fancyName,
        snapshotName: id => PROFILE_SNAPSHOT_NAMES[id] ?? id,
        optionText: getOptionText,
        enabledText: translate('Enabled'),
        disabledText: translate('Disabled'),
        noneText: NONE_TEXT,
        emptyText: EMPTY_TEXT,
        truncate: text => (text.length > TRUNCATE_LENGTH ? `${text.slice(0, TRUNCATE_LENGTH)}…` : text),
    };
}

/**
 * Swaps the Kobold `gui` sentinel for its option text. The snapshot keeps the raw value for the comparison; other
 * Kobold preset values are names, while the select's option values are indexes, so only the sentinel is looked up.
 * @param {Change} change Change from the diff
 * @returns {Change} Change with display values
 */
function toDisplayChange(change) {
    if (change.id !== 'preset.kobold') {
        return change;
    }
    const show = (/** @type {unknown} */ value) => (value === KOBOLD_GUI_PRESET ? getOptionText(KOBOLD_PRESET_SELECT, value) : value);
    return { ...change, from: show(change.from), to: show(change.to) };
}

/**
 * Whether the Regex preset shown in the picker is not yet in effect. The picker shows the target preset as soon as
 * `/regex-preset` runs; the Regex extension marks it selected only after its saves and the chat reload. So the apply is
 * still running while the picker differs from the selected preset (a switch to another id), or while the live scripts
 * differ from the picker's preset (a same-id reapply never changes the selection).
 * @returns {boolean} True while the picker differs from the selected preset or the live scripts from the picker's preset
 */
function isRegexPresetApplying() {
    // Without the Regex extension there is no picker, and nothing can be applying.
    if (!document.getElementById('regex_presets')) {
        return false;
    }
    const pickerId = getRegexPresetSelectValue();
    const selectedId = extension_settings.regex_presets?.find(item => item?.isSelected)?.id ?? '';
    if (pickerId !== selectedId) {
        return true;
    }
    const preset = extension_settings.regex_presets?.find(item => item?.id === pickerId);
    if (!preset) {
        return false;
    }
    return !regexPresetMatchesLive(preset, {
        global: readRegexLiveScripts(SCRIPT_TYPES.GLOBAL),
        scoped: readRegexLiveScripts(SCRIPT_TYPES.SCOPED),
        preset: readRegexLiveScripts(SCRIPT_TYPES.PRESET),
    });
}

/**
 * Reads the busy hints of a profile apply, one state per hint, so the switch's tracker can tell them apart.
 * @param {boolean} watchRegexPreset Whether the profile sets a Regex preset, which arms the regex hint
 * @returns {{ api: boolean, offline: boolean, regex: boolean }} Whether each hint is on
 */
function readBusyHintStates(watchRegexPreset) {
    return {
        api: document.querySelector('.api_button.disabled') !== null,
        offline: online_status === 'no_connection',
        regex: watchRegexPreset && isRegexPresetApplying(),
    };
}

/**
 * Registers a synchronous activity listener for the events that mark a switch as still settling.
 * @param {() => void} onActivity Activity callback
 * @returns {() => void} Removes the listeners
 */
function subscribeToSettleActivity(onActivity) {
    const events = [
        event_types.ONLINE_STATUS_CHANGED,
        event_types.MAIN_API_CHANGED,
        event_types.CHATCOMPLETION_SOURCE_CHANGED,
        event_types.CHATCOMPLETION_MODEL_CHANGED,
        event_types.OAI_PRESET_CHANGED_AFTER,
        event_types.PRESET_CHANGED,
        event_types.SECRET_ROTATED,
        event_types.CHAT_CHANGED,
    ];
    events.forEach(name => eventSource.on(name, onActivity));
    return () => events.forEach(name => eventSource.removeListener(name, onActivity));
}

/**
 * Builds the list item of one change. Value lines are one text node; sampler and content lines end in a span that
 * holds the copy constant. Everything is set with `textContent`, so no profile or setting name is parsed as HTML.
 * @param {ProfileChangeLine} line Formatted change
 * @returns {HTMLLIElement} List item
 */
function buildProfileSwitchItem(line) {
    const item = document.createElement('li');
    if (!line.placeholder) {
        item.append(document.createTextNode(`${line.label}: ${line.from} → ${line.to}`));
        return item;
    }
    const isSamplers = Number.isFinite(line.count);
    item.append(document.createTextNode(isSamplers ? `${line.label}: ${line.count} ` : `${line.label} `));
    const copy = document.createElement('span');
    copy.dataset.sbProfileCopy = 'true';
    copy.textContent = isSamplers ? PROFILE_SWITCH_COPY.samplersChanged : PROFILE_SWITCH_COPY.contentReloaded;
    item.append(copy);
    return item;
}

/**
 * Shows the summary of a profile switch, replacing the previous summary. The title and message are DOM nodes because
 * `escapeHtml: false` makes toastr append the title raw: they must never be built from strings that hold a name.
 * @param {string} profileName Name of the applied profile
 * @param {ProfileChangeLine[]} lines Formatted changes
 */
function showProfileSwitchToast(profileName, lines) {
    if (previousSummary) {
        toastr.clear(previousSummary, { force: true });
    }
    const titleNode = document.createTextNode(profileName);
    const listNode = document.createElement('ul');
    listNode.className = 'sb-profile-switch-summary';
    listNode.append(...lines.map(buildProfileSwitchItem));
    previousSummary = toastr.info(listNode, titleNode, { escapeHtml: false, timeOut: 10000 });
}

/**
 * Opens the report for a switch. Synchronous and never throws: a throw here would skip the profile apply.
 * @param {object} args Arguments
 * @param {object} args.profile Profile being applied
 * @param {number} args.applySequence Sequence number of the switch
 * @param {'user'|'scripted'} [args.origin] Where the switch came from
 * @param {boolean} args.notify Whether the summary is shown
 * @param {string|null} [args.previousProfileId] Profile selected before the switch
 * @returns {ProfileSwitchReport | null} The report, or null if the arguments are invalid or it could not be opened
 */
export function beginProfileSwitchReport(args) {
    try {
        if (!isObject(args) || !isObject(args.profile) || !Number.isInteger(args.applySequence)) {
            return null;
        }
        const { profile, applySequence } = args;
        const watchRegexPreset = Boolean(profile['regex-preset']);
        const tracker = createBusyHintTracker([...BUSY_HINT_NAMES]);
        // Nothing is in flight at begin: a Regex mismatch now is drift the apply will undo, and the busy grace bounds it.
        tracker.read({ ...readBusyHintStates(watchRegexPreset), regex: false });
        const freshBefore = readProfileSnapshot();
        const { before } = resolveReportBaseline({ openReport, applySequence, freshBefore });
        if (openReport) {
            openReport.finished = true;
        }
        /** @type {ProfileSwitchReport} */
        const report = {
            applySequence,
            profileName: String(profile.name ?? ''),
            notify: Boolean(args.notify),
            before,
            finished: false,
            watchRegexPreset,
            tracker,
        };
        openReport = report;
        return report;
    } catch (error) {
        console.warn('[SillyBunny] Could not start the profile switch report', error);
        return null;
    }
}

/**
 * Marks a report closed so no later switch inherits its BEFORE, e.g. when the apply failed. Never throws.
 * @param {ProfileSwitchReport | null} report Report from `beginProfileSwitchReport`
 */
export function abandonProfileSwitchReport(report) {
    try {
        if (isObject(report)) {
            report.finished = true;
        }
    } catch (error) {
        console.warn('[SillyBunny] Could not abandon the profile switch report', error);
    }
}

/**
 * Waits for the switch to settle, then compares and hands the changes to the summary.
 * @param {ProfileSwitchReport} report Open report
 * @param {() => boolean} isCurrent Whether the switch is still the latest one
 * @returns {Promise<'superseded' | 'empty' | 'delivered'>} The outcome
 */
async function deliverProfileSwitchReport(report, isCurrent) {
    const outcome = await waitForProfileSettle({
        isCurrent,
        readFingerprint: () => JSON.stringify(readProfileSnapshot().values),
        // The tracker leaves out a hint that is on since begin (the regex hint starts off), so a busy reading is an edge.
        isBusy: () => report.tracker.read(readBusyHintStates(report.watchRegexPreset)),
        subscribe: subscribeToSettleActivity,
        initialNotBusy: true,
    });
    if (!outcome.settled || !isCurrent()) {
        return 'superseded';
    }
    const changes = diffProfileSnapshots(report.before, readProfileSnapshot());
    if (changes.length === 0) {
        return 'empty';
    }
    const helpers = getFormatHelpers();
    const lines = changes.map(change => formatProfileChange(toDisplayChange(change), helpers));
    showProfileSwitchToast(report.profileName, lines);
    return 'delivered';
}

/**
 * Closes a switch report. Never rejects. A silent, missing or already closed report resolves right away; otherwise
 * the summary is shown once the settings settle, if the switch is still the latest one and something changed.
 * Delivered, empty, silent and failed outcomes close the report. A superseded one stays open, so the switch that
 * superseded it carries its BEFORE forward even if this resolves before that switch begins. `openReport` is never
 * touched here, so a stale report cannot replace a newer open one.
 * @param {ProfileSwitchReport | null} report Report from `beginProfileSwitchReport`
 * @param {() => boolean} isCurrent Whether the switch is still the latest one
 * @returns {Promise<void>}
 */
export async function finishProfileSwitchReport(report, isCurrent) {
    if (!isObject(report)) {
        return;
    }
    let outcome = 'closed';
    try {
        if (!report.finished && report.notify) {
            outcome = await deliverProfileSwitchReport(report, isCurrent);
        }
    } catch (error) {
        console.warn('[SillyBunny] Could not report the profile switch', error);
    }
    if (outcome !== 'superseded') {
        abandonProfileSwitchReport(report);
    }
}

/**
 * Gets what the selected profile applies outside the connection fields.
 * @returns {string[]} Command ids in apply order; empty when no profile is selected or the selected one is missing
 */
function getSelectedProfileOverrides() {
    const settings = extension_settings.connectionManager;
    const selectedProfile = settings?.selectedProfile;
    if (!selectedProfile || !tables) {
        return [];
    }
    const profile = settings.profiles?.find(item => item?.id === selectedProfile);
    return profile ? getAppliedOverrideCommands(profile, tables) : [];
}

/**
 * Refreshes the "Also sets" line under the profile actions. Synchronous, a no-op before init, and never throws.
 * The line sits under shell MutationObservers, so it writes only what changed: the children, with one
 * `replaceChildren`, when the list of ids changes, and `hidden` when it flips. An empty list also clears the children,
 * because the select's `aria-describedby` still reads the text of a hidden line.
 */
export function refreshProfileSetsLine() {
    if (!tables) {
        return;
    }
    try {
        const line = document.getElementById(PROFILE_SETS_LINE_ID);
        if (!line) {
            return;
        }
        const ids = getSelectedProfileOverrides();
        const key = ids.join('|');
        if (key !== profileSetsKey) {
            if (ids.length === 0) {
                line.replaceChildren();
            } else {
                const copy = document.createElement('span');
                copy.dataset.sbProfileCopy = 'true';
                copy.textContent = PROFILE_SWITCH_COPY.alsoSets;
                line.replaceChildren(copy, document.createTextNode(` ${ids.map(id => fancyName(id)).join(', ')}`));
            }
            profileSetsKey = key;
        }
        const hidden = ids.length === 0;
        if (line.hidden !== hidden) {
            line.hidden = hidden;
        }
    } catch (error) {
        console.warn('[SillyBunny] Could not refresh the profile card line', error);
    }
}

/**
 * Stores the command tables and paints the card line for the first time. Called once from the extension's init,
 * after the settings template is in the page.
 * @param {ProfileChangeTables} commandTables Command tables and display names from cm/index.js
 */
export function initProfileChangeNotice(commandTables) {
    tables = commandTables;
    refreshProfileSetsLine();
}
