// Pure model for the connection profile change notice: which profile commands count as applied on a switch,
// which of those are connection fields vs. overrides, and the labels/copy shown to the user.
// This module is import-free on purpose so Jest (Node, no jsdom) can load it directly.

/**
 * Commands that belong to the connection itself (as opposed to preset/template/behavior overrides).
 * @type {ReadonlySet<string>}
 */
export const PROFILE_CONNECTION_COMMANDS = Object.freeze(new Set([
    'api',
    'api-url',
    'model',
    'secret-id',
    'proxy',
    'service-tier',
    'custom-endpoint-profile',
    'custom-include-body',
    'custom-exclude-body',
    'custom-include-headers',
    'prompt-post-processing',
    'custom-reasoning-preset',
    'custom-reasoning-param-format',
    'custom-reasoning-param-name',
    'custom-reasoning-enabled-value',
    'custom-reasoning-disabled-value',
]));

/**
 * Labels for the snapshot rows, keyed by snapshot field.
 * @type {Readonly<Record<string, string>>}
 */
export const PROFILE_SNAPSHOT_NAMES = Object.freeze({
    'active-agents': 'Active Agents',
    'samplers': 'Samplers',
    'instruct-template': 'Instruct Template',
    'context-template': 'Context Template',
    'system-prompt': 'System Prompt',
    'world-info-active-count': 'World Info Active Entries',
});

export const PROFILE_SWITCH_COPY = Object.freeze({
    alsoSets: 'Also sets:',
    contentReloaded: '(content reloaded)',
    samplersChanged: 'changed',
    snapshotHeading: 'Saved snapshot (not applied)',
});

/**
 * @typedef {object} ProfileCommandTables
 * @property {string[]} ccCommands Command ids applied for Chat Completion profiles, in apply order.
 * @property {string[]} tcCommands Command ids applied for Text Completion profiles, in apply order.
 * @property {string[]} allowEmpty Command ids that record an empty value into the profile.
 * @property {boolean} [serviceTierApplied] Whether the service tier will be applied on switch.
 */

/**
 * Gets the commands a profile runs on switch, in apply order, without duplicates (CC lists `api` twice).
 * An undefined mode means Text Completion.
 * @param {object} profile Connection profile
 * @param {Pick<ProfileCommandTables, 'ccCommands' | 'tcCommands'>} tables Command tables
 * @returns {string[]} Command ids
 */
export function getProfileCommandList(profile, { ccCommands, tcCommands }) {
    const commands = profile?.mode === 'cc' ? ccCommands : tcCommands;
    return [...new Set(commands)];
}

/**
 * Whether a command with this id is run on switch, judged by the profile's recorded value alone.
 * Empty values count only for commands that are allowed to record an empty value.
 * @param {object} profile Connection profile
 * @param {string} id Command id
 * @param {Pick<ProfileCommandTables, 'allowEmpty'>} tables Command tables
 * @returns {boolean} True if the command is applied
 */
export function isAppliedOnSwitch(profile, id, { allowEmpty }) {
    return Boolean(profile?.[id]) || (allowEmpty.includes(id) && profile?.[id] === '');
}

/**
 * Gets the commands a switch to this profile applies, in apply order.
 * `proxy` is applied unless it is excluded, and `service-tier` only when the caller says it is applied.
 * `exclude` is read for no other id.
 * @param {object} profile Connection profile
 * @param {ProfileCommandTables} tables Command tables
 * @returns {string[]} Command ids
 */
export function getAppliedCommands(profile, { ccCommands, tcCommands, allowEmpty, serviceTierApplied = false }) {
    return getProfileCommandList(profile, { ccCommands, tcCommands }).filter(id => {
        if (id === 'proxy') {
            return Boolean(profile?.proxy) || !profile?.exclude?.includes('proxy');
        }
        if (id === 'service-tier') {
            return serviceTierApplied;
        }
        return isAppliedOnSwitch(profile, id, { allowEmpty });
    });
}

/**
 * Gets the applied commands that are not connection fields, i.e. what the switch also sets.
 * @param {object} profile Connection profile
 * @param {ProfileCommandTables} tables Command tables
 * @returns {string[]} Command ids
 */
export function getAppliedOverrideCommands(profile, tables) {
    return getAppliedCommands(profile, { ...tables, serviceTierApplied: false })
        .filter(id => !PROFILE_CONNECTION_COMMANDS.has(id));
}

/**
 * @typedef {object} WatchEntry One setting the change notice watches across a profile switch.
 * @property {string} id Stable entry id, also the key of its value in a snapshot.
 * @property {string} group Where the setting lives in the UI (Appendix A "Shown in").
 * @property {'name'|'value'|'toggle'|'content'|'samplers'} kind How a difference is judged and reported.
 * @property {'all'|string[]} modes The main api ids this entry applies to, or `'all'`.
 * @property {{ text: string, key?: string } | { fancy: string } | { snapshot: string }} label Label source.
 * @property {'raw'|'option'|'toggle'|'count'|'truncate'|'stopStrings'|'regexName'} display How values are shown.
 * @property {string} [pairsWith] For `content` entries: the name entry that must be unchanged for a reload to count.
 * @property {string} [optionSelect] For `display: 'option'`: the select whose option text is shown.
 */

/**
 * @typedef {object} Snapshot
 * @property {string} mainApi Main api id in effect when the values were read.
 * @property {Record<string, unknown>} values Value per watch entry id, whatever the api. `samplers` holds one sampler map
 * per sampler group (`SAMPLER_GROUP_BY_API`).
 */

/**
 * @typedef {object} Change
 * @property {string} id Watch entry id.
 * @property {WatchEntry['kind']} kind Entry kind.
 * @property {unknown} from Value before the switch.
 * @property {unknown} to Value after the switch.
 * @property {number} [count] Number of changed keys, for `samplers`.
 */

/**
 * @typedef {object} FormatHelpers
 * @property {(text: string, key?: string) => string} translate Translates a label.
 * @property {(id: string) => string} fancyName Gets the display name of a profile command id.
 * @property {(id: string) => string} snapshotName Gets the display name of a snapshot row id.
 * @property {(selectId: string, value: unknown) => string | undefined} optionText Gets the visible text of a select option.
 * @property {string} enabledText Text for an enabled toggle.
 * @property {string} disabledText Text for a disabled toggle.
 * @property {string} noneText Text for a missing value.
 * @property {string} emptyText Text for an empty string.
 * @property {(text: string) => string} truncate Shortens a long text to one short line.
 */

const TEXT_STYLE_APIS = Object.freeze(['textgenerationwebui', 'kobold', 'koboldhorde', 'novel']);
const CC_APIS = Object.freeze(['openai']);
const TC_APIS = Object.freeze(['textgenerationwebui']);
const KOBOLD_APIS = Object.freeze(['kobold', 'koboldhorde']);
const NOVEL_APIS = Object.freeze(['novel']);

const GROUPS = Object.freeze({
    presets: 'Presets > Presets',
    generation: 'Presets > Generation Settings',
    sysprompt: 'Presets > System Prompt',
    syspromptEditor: 'Editor > System Prompt',
    instruct: 'Presets > Instruct Template',
    context: 'Presets > Context Template',
    names: 'Presets > Character Names',
    namesFormatting: 'Presets > Character Names & Prompt Formatting',
    request: 'Presets > Request Options',
    reasoning: 'Presets > Reasoning Template',
    tokenizer: 'Formatting > Tokenizer & Padding',
    stopping: 'Formatting > Stopping Strings',
    replyPrefix: 'Formatting > Reply Prefix',
    textCleanup: 'Formatting > Text Cleanup',
    sampling: 'Sampling',
    regex: 'Customize > Extensions > Regex',
});

/**
 * Builds one frozen watch entry.
 * @param {string} id Entry id
 * @param {string} group UI location
 * @param {WatchEntry['kind']} kind Entry kind
 * @param {WatchEntry['modes']} modes Main api ids, or 'all'
 * @param {WatchEntry['label']} label Label source
 * @param {WatchEntry['display']} display Value display
 * @param {Pick<WatchEntry, 'pairsWith' | 'optionSelect'>} [extra] Optional fields
 * @returns {Readonly<WatchEntry>} The entry
 */
function watchEntry(id, group, kind, modes, label, display, extra = {}) {
    return Object.freeze({ id, group, kind, modes, label: Object.freeze(label), display, ...extra });
}

/**
 * The settings a profile switch can change, in the order the notice lists them (spec Appendix A).
 * @type {ReadonlyArray<Readonly<WatchEntry>>}
 */
export const PROFILE_WATCH_LIST = Object.freeze([
    watchEntry('preset.openai', GROUPS.presets, 'name', CC_APIS, { text: 'Chat Completion Presets', key: 'openaipresets' }, 'raw'),
    watchEntry('preset.textgenerationwebui', GROUPS.presets, 'name', TC_APIS, { fancy: 'preset' }, 'raw'),
    watchEntry('preset.kobold', GROUPS.presets, 'name', KOBOLD_APIS, { fancy: 'preset' }, 'raw'),
    watchEntry('preset.novel', GROUPS.presets, 'name', NOVEL_APIS, { fancy: 'preset' }, 'raw'),
    watchEntry('gen.openai_max_tokens', GROUPS.generation, 'value', CC_APIS, { text: 'Max Response Length (tokens)' }, 'raw'),
    watchEntry('gen.openai_max_context', GROUPS.generation, 'value', CC_APIS, { text: 'Context Size (tokens)' }, 'raw'),
    watchEntry('gen.amount_gen', GROUPS.generation, 'value', TEXT_STYLE_APIS, { text: 'Response (tokens)' }, 'raw'),
    watchEntry('gen.max_context', GROUPS.generation, 'value', TEXT_STYLE_APIS, { text: 'Context (tokens)' }, 'raw'),
    watchEntry('gen.stream_openai', GROUPS.generation, 'toggle', CC_APIS, { text: 'Streaming' }, 'toggle'),
    watchEntry('gen.streaming_textgen', GROUPS.generation, 'toggle', TC_APIS, { text: 'Streaming' }, 'toggle'),
    watchEntry('gen.streaming_kobold', GROUPS.generation, 'toggle', KOBOLD_APIS, { text: 'Streaming' }, 'toggle'),
    watchEntry('gen.n_openai', GROUPS.generation, 'value', CC_APIS, { text: 'Multiple swipes per generation' }, 'raw'),
    watchEntry('gen.n_textgen', GROUPS.generation, 'value', TC_APIS, { text: 'Multiple swipes per generation' }, 'raw'),
    watchEntry('gen.nai_prefix', GROUPS.generation, 'value', NOVEL_APIS, { text: 'AI Module' }, 'option', { optionSelect: '#nai_prefix' }),
    watchEntry('sysprompt.enabled', GROUPS.sysprompt, 'toggle', TEXT_STYLE_APIS, { fancy: 'sysprompt-state' }, 'toggle'),
    watchEntry('sysprompt.name', GROUPS.sysprompt, 'name', TEXT_STYLE_APIS, { text: 'System Prompt' }, 'raw'),
    watchEntry('sysprompt.content', GROUPS.syspromptEditor, 'content', TEXT_STYLE_APIS, { text: 'System Prompt' }, 'raw', { pairsWith: 'sysprompt.name' }),
    watchEntry('instruct.enabled', GROUPS.instruct, 'toggle', TEXT_STYLE_APIS, { fancy: 'instruct-state' }, 'toggle'),
    watchEntry('instruct.name', GROUPS.instruct, 'name', TEXT_STYLE_APIS, { text: 'Instruct Template' }, 'raw'),
    watchEntry('context.name', GROUPS.context, 'name', TEXT_STYLE_APIS, { text: 'Context Template' }, 'raw'),
    watchEntry('names.always_force_name2', GROUPS.names, 'toggle', TEXT_STYLE_APIS, { text: 'Always add character\'s name to prompt' }, 'toggle'),
    watchEntry('names.names_behavior_openai', GROUPS.namesFormatting, 'value', CC_APIS, { text: 'Character Names Behavior' }, 'option', { optionSelect: '#names_behavior' }),
    watchEntry('request.show_thoughts', GROUPS.request, 'toggle', CC_APIS, { text: 'Request model reasoning' }, 'toggle'),
    watchEntry('request.reasoning_effort', GROUPS.request, 'value', CC_APIS, { text: 'Reasoning Effort' }, 'option', { optionSelect: '#openai_reasoning_effort' }),
    watchEntry('request.verbosity', GROUPS.request, 'value', CC_APIS, { text: 'Verbosity' }, 'option', { optionSelect: '#openai_verbosity' }),
    watchEntry('request.enable_web_search', GROUPS.request, 'toggle', CC_APIS, { text: 'Enable web search' }, 'toggle'),
    watchEntry('request.request_images', GROUPS.request, 'toggle', CC_APIS, { text: 'Request inline images' }, 'toggle'),
    watchEntry('request.request_image_resolution', GROUPS.request, 'value', CC_APIS, { text: 'Resolution' }, 'option', { optionSelect: '#request_image_resolution' }),
    watchEntry('request.request_image_aspect_ratio', GROUPS.request, 'value', CC_APIS, { text: 'Aspect Ratio' }, 'option', { optionSelect: '#request_image_aspect_ratio' }),
    watchEntry('reasoning.name', GROUPS.reasoning, 'name', 'all', { text: 'Reasoning Template' }, 'raw'),
    watchEntry('reasoning.content', GROUPS.reasoning, 'content', 'all', { text: 'Reasoning Template' }, 'raw', { pairsWith: 'reasoning.name' }),
    watchEntry('fmt.tokenizer', GROUPS.tokenizer, 'value', TEXT_STYLE_APIS, { text: 'Tokenizer' }, 'option', { optionSelect: '#tokenizer' }),
    watchEntry('fmt.custom_stopping_strings', GROUPS.stopping, 'value', 'all', { text: 'Custom Stopping Strings' }, 'stopStrings'),
    watchEntry('prefill.user_prompt_bias', GROUPS.replyPrefix, 'value', 'all', { text: 'Start Reply With' }, 'truncate'),
    watchEntry('fmt.single_line', GROUPS.textCleanup, 'toggle', TEXT_STYLE_APIS, { text: 'Generate only one line per request' }, 'toggle'),
    watchEntry('fmt.trim_sentences', GROUPS.textCleanup, 'toggle', TEXT_STYLE_APIS, { text: 'Trim Incomplete Sentences' }, 'toggle'),
    watchEntry('samplers', GROUPS.sampling, 'samplers', 'all', { snapshot: 'samplers' }, 'raw'),
    watchEntry('regex.preset', GROUPS.regex, 'name', 'all', { text: 'Regex Presets', key: 'ext_regex_presets' }, 'raw'),
    watchEntry('regex.content', GROUPS.regex, 'content', 'all', { text: 'Regex Presets', key: 'ext_regex_presets' }, 'raw', { pairsWith: 'regex.preset' }),
]);

/**
 * The watch entry that holds the completion preset name, per main api.
 * @type {Readonly<Record<string, string>>}
 */
export const PRESET_ENTRY_BY_API = Object.freeze({
    openai: 'preset.openai',
    textgenerationwebui: 'preset.textgenerationwebui',
    kobold: 'preset.kobold',
    koboldhorde: 'preset.kobold',
    novel: 'preset.novel',
});

/**
 * The sampler group of each main api: the key of its sampler map in a snapshot's `samplers` value. Kobold Horde keeps
 * the Kobold samplers.
 * @type {Readonly<Record<string, string>>}
 */
export const SAMPLER_GROUP_BY_API = Object.freeze({
    openai: 'openai',
    textgenerationwebui: 'textgenerationwebui',
    kobold: 'kobold',
    koboldhorde: 'kobold',
    novel: 'novel',
});

const WATCH_ENTRY_BY_ID = new Map(PROFILE_WATCH_LIST.map(entry => [entry.id, entry]));

/**
 * Gets the watch entries that apply to a main api.
 * @param {string} mainApi Main api id
 * @returns {WatchEntry[]} Entries whose modes are 'all' or include the api
 */
export function getWatchEntriesForApi(mainApi) {
    return PROFILE_WATCH_LIST.filter(entry => entry.modes === 'all' || entry.modes.includes(mainApi));
}

/**
 * Parses a stop strings value. A JSON array of strings gives the list with its items untouched (the app never trims
 * them, so a leading newline is a real difference); an empty value is the empty list, as `''` and `'[]'` both mean
 * "no stop strings"; anything else is legacy text, kept trimmed.
 * @param {unknown} raw Stored value
 * @returns {{ list: string[] | null, text: string }} The list (null when not a list) and the trimmed raw text
 */
export function normalizeStopStrings(raw) {
    const text = String(raw ?? '').trim();
    if (text === '') {
        return { list: [], text };
    }
    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
            return { list: parsed, text };
        }
    } catch {
        // Not JSON: legacy text, compared as text.
    }
    return { list: null, text };
}

/**
 * Whether two values serialize to the same JSON. Two undefined values count as equal.
 * @param {unknown} a First value
 * @param {unknown} b Second value
 * @returns {boolean} True if equal
 */
function isSameValue(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Counts the sampler keys whose value differs between two sampler maps.
 * @param {Record<string, unknown> | undefined} before Samplers before the switch
 * @param {Record<string, unknown> | undefined} after Samplers after the switch
 * @returns {number} Number of keys in the union with a different value
 */
export function countSamplerChanges(before, after) {
    const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
    let count = 0;
    for (const key of keys) {
        if (!isSameValue(before?.[key], after?.[key])) {
            count++;
        }
    }
    return count;
}

/**
 * Resolves a Regex preset id to its name.
 * @param {{ id: string, name: string }[] | undefined} presets The regex presets, if the extension is loaded
 * @param {string} id Preset id
 * @returns {string} The name, or an empty string
 */
export function resolveRegexPresetName(presets, id) {
    return presets?.find(p => p.id === id)?.name ?? '';
}

/** The script types of a Regex preset, as the keys of its lists. */
const REGEX_PRESET_LISTS = Object.freeze(['global', 'scoped', 'preset']);

/**
 * @typedef {object} RegexLiveScripts The live Regex scripts of one script type.
 * @property {string[]} all Ids of every script of the type.
 * @property {string[]} enabled Ids of the scripts that are not disabled.
 */

/**
 * Compares enabled scripts in native preset order. Missing script ids are ignored; repeated preset ids use their first position.
 * Non-array lists leave their type unchanged. Empty lists and missing presets require all scripts to be disabled.
 * @param {{ global?: { id: string }[], scoped?: { id: string }[], preset?: { id: string }[] } | null | undefined} preset
 * Regex preset as stored in `extension_settings.regex_presets`
 * @param {Partial<Record<'global' | 'scoped' | 'preset', RegexLiveScripts>>} liveByType Live scripts per script type
 * @returns {boolean} True if every script type matches
 */
export function regexPresetMatchesLive(preset, liveByType) {
    return REGEX_PRESET_LISTS.every(type => {
        const listed = preset ? preset[type] : [];
        if (!Array.isArray(listed)) {
            return true;
        }
        const order = new Map();
        listed.forEach((item, index) => {
            if (!order.has(item?.id)) {
                order.set(item?.id, index);
            }
        });
        const expected = (liveByType?.[type]?.all ?? [])
            .filter(id => order.has(id))
            .sort((a, b) => order.get(a) - order.get(b));
        const enabled = liveByType?.[type]?.enabled ?? [];
        return enabled.length === expected.length && enabled.every((id, index) => id === expected[index]);
    });
}

/**
 * Whether the stop strings values differ: as lists when both parse as lists, otherwise as trimmed text.
 * @param {unknown} a Value before
 * @param {unknown} b Value after
 * @returns {boolean} True if changed
 */
function isStopStringsChanged(a, b) {
    const before = normalizeStopStrings(a);
    const after = normalizeStopStrings(b);
    return before.list && after.list ? !isSameValue(before.list, after.list) : before.text !== after.text;
}

/**
 * Whether the enabled Regex scripts differ. Global and scoped scripts always count; preset scripts count only
 * while the backend and its completion preset are unchanged, because a preset change swaps them anyway (and the
 * preset scripts of a snapshot are read under the main api in effect, not per backend).
 * @param {Snapshot} before Snapshot before the switch
 * @param {Snapshot} after Snapshot after the switch
 * @returns {boolean} True if changed
 */
function isRegexContentChanged(before, after) {
    const from = before.values['regex.content'];
    const to = after.values['regex.content'];
    if (!isSameValue(from?.global ?? [], to?.global ?? []) || !isSameValue(from?.scoped ?? [], to?.scoped ?? [])) {
        return true;
    }
    const samePreset = before.mainApi === after.mainApi
        && before.values[PRESET_ENTRY_BY_API[before.mainApi]] === after.values[PRESET_ENTRY_BY_API[after.mainApi]];
    return samePreset && !isSameValue(from?.preset ?? [], to?.preset ?? []);
}

/**
 * Whether a snapshot holds a value for an entry id. An explicit `undefined` is a real value, not an absent one.
 * @param {Snapshot} snapshot Snapshot
 * @param {string} id Watch entry id
 * @returns {boolean} True if present
 */
function hasValue(snapshot, id) {
    return Boolean(snapshot?.values) && Object.hasOwn(snapshot.values, id);
}

/**
 * Compares two snapshots on the watch entries of the backend after the switch, so a switch across backends reports
 * the destination backend's settings. An entry is compared only when both snapshots hold it. Samplers are compared
 * for the destination backend's sampler group.
 * @param {Snapshot} before Snapshot before the switch
 * @param {Snapshot} after Snapshot after the switch
 * @returns {Change[]} One change per differing entry, in watch list order
 */
export function diffProfileSnapshots(before, after) {
    /** @type {Change[]} */
    const changes = [];
    for (const entry of getWatchEntriesForApi(after?.mainApi)) {
        if (!hasValue(before, entry.id) || !hasValue(after, entry.id)) {
            continue;
        }
        const from = before.values[entry.id];
        const to = after.values[entry.id];
        switch (entry.kind) {
            case 'samplers': {
                // Each backend keeps its own samplers, so the destination backend's group is the one that changed.
                const group = SAMPLER_GROUP_BY_API[after.mainApi];
                const samplersFrom = /** @type {Record<string, Record<string, unknown>> | undefined} */ (from)?.[group];
                const samplersTo = /** @type {Record<string, Record<string, unknown>> | undefined} */ (to)?.[group];
                const count = countSamplerChanges(samplersFrom, samplersTo);
                if (count > 0) {
                    changes.push({ id: entry.id, kind: entry.kind, from: samplersFrom, to: samplersTo, count });
                }
                break;
            }
            case 'content': {
                // A reload only counts when the template or preset it belongs to kept its name.
                const paired = entry.pairsWith;
                if (!hasValue(before, paired) || !hasValue(after, paired) || !isSameValue(before.values[paired], after.values[paired])) {
                    break;
                }
                const changed = entry.id === 'regex.content' ? isRegexContentChanged(before, after) : !isSameValue(from, to);
                if (changed) {
                    changes.push({ id: entry.id, kind: entry.kind, from, to });
                }
                break;
            }
            default: {
                const changed = entry.display === 'stopStrings' ? isStopStringsChanged(from, to) : !isSameValue(from, to);
                if (changed) {
                    changes.push({ id: entry.id, kind: entry.kind, from, to });
                }
            }
        }
    }
    return changes;
}

/**
 * Formats one value for display.
 * @param {WatchEntry | undefined} entry Watch entry, if the id is known
 * @param {unknown} value Value to show
 * @param {FormatHelpers} helpers Display helpers
 * @returns {string} Display text
 */
function formatValue(entry, value, helpers) {
    if (value === null || value === undefined) {
        return helpers.noneText;
    }
    const shorten = (/** @type {string} */ text) => text === '' ? '' : helpers.truncate(text);
    let text;
    switch (entry?.display) {
        case 'toggle':
            return value ? helpers.enabledText : helpers.disabledText;
        case 'option':
            text = helpers.optionText(entry.optionSelect, value) || String(value);
            break;
        case 'stopStrings': {
            const stopStrings = normalizeStopStrings(value);
            text = stopStrings.list ? String(stopStrings.list.length) : shorten(stopStrings.text);
            break;
        }
        case 'truncate':
            text = shorten(String(value));
            break;
        default:
            text = String(value);
    }
    return text === '' ? helpers.emptyText : text;
}

/**
 * Formats a change for display. Content reloads and sampler changes use a suffix: they show a label (and a
 * count) but no before/after values.
 * @param {Change} change The change
 * @param {FormatHelpers} helpers Display helpers
 * @returns {{ label: string, from: string, to: string, count?: number, placeholder: boolean }} Display fields
 */
export function formatProfileChange(change, helpers) {
    const entry = WATCH_ENTRY_BY_ID.get(change.id);
    const source = entry?.label;
    let label = String(change.id);
    if (source && 'fancy' in source) {
        label = helpers.fancyName(source.fancy);
    } else if (source && 'snapshot' in source) {
        label = helpers.snapshotName(source.snapshot);
    } else if (source) {
        label = helpers.translate(source.text, source.key);
    }
    const placeholder = change.kind === 'content' || change.kind === 'samplers';
    const result = {
        label,
        from: placeholder ? '' : formatValue(entry, change.from, helpers),
        to: placeholder ? '' : formatValue(entry, change.to, helpers),
        placeholder,
    };
    return change.count === undefined ? result : { ...result, count: change.count };
}

/**
 * @typedef {object} OpenSwitchReport The state of a switch report that may still absorb the next switch.
 * @property {number} applySequence Sequence number of the switch the report was opened for.
 * @property {boolean} finished Whether the report has been delivered or discarded.
 * @property {Snapshot} before Snapshot taken before the switch the report was opened for.
 */

/**
 * Picks the BEFORE snapshot for a switch's report. A switch that lands right after an unfinished one carries that
 * report's BEFORE forward, so the report shows the net change instead of only the last hop; anything else starts
 * from a fresh snapshot.
 * @param {object} args Arguments
 * @param {OpenSwitchReport | null | undefined} args.openReport The report still open, if any
 * @param {number} args.applySequence Sequence number of the switch being reported
 * @param {Snapshot} args.freshBefore Snapshot taken just before this switch
 * @returns {{ before: Snapshot, reused: boolean }} The baseline and whether it was carried forward
 */
export function resolveReportBaseline({ openReport, applySequence, freshBefore }) {
    if (openReport && !openReport.finished && openReport.applySequence === applySequence - 1) {
        return { before: openReport.before, reused: true };
    }
    return { before: freshBefore, reused: false };
}

/**
 * Tracks named busy hints so that a hint counts only once it has been seen off. A hint that is on from the first
 * reading and never drops (an offline status from before the switch, say) is ignored without hiding another hint that
 * turns on later.
 * @param {string[]} names Hint names; other names in a reading are ignored
 * @returns {Readonly<{ read: (states: Record<string, boolean>) => boolean }>} The tracker. `read` first records every
 * named hint that is off, the very first reading included, then returns true if a hint that has been seen off is on
 */
export function createBusyHintTracker(names) {
    /** @type {Map<string, boolean>} */
    const seenOff = new Map(names.map(name => [name, false]));
    return Object.freeze({
        read(states) {
            for (const name of seenOff.keys()) {
                if (!states?.[name]) {
                    seenOff.set(name, true);
                }
            }
            return [...seenOff].some(([name, off]) => off && Boolean(states?.[name]));
        },
    });
}

/**
 * Waits until the settings a profile switch touches stop changing, so the report is taken after the extensions
 * that react to the switch have finished. Resolves once: `quiet` after `quietMs` without activity, `cap` when
 * `maxMs` is up, `superseded` when a newer switch made `isCurrent` false. Activity is an `onActivity` call from
 * `subscribe`, a changed fingerprint, or the rising edge of the busy hint. The edge counts as activity once and
 * holds the report back for `busyGraceMs` only, so a hint that is already on at the baseline (the start, or
 * `initialNotBusy` when given), or that sticks, cannot stall it. If a reader throws, the promise rejects after the
 * same cleanup.
 * @param {object} args Arguments
 * @param {() => boolean} args.isCurrent Whether this switch is still the latest one
 * @param {() => string} args.readFingerprint Reads the watched settings as one string; a different string is activity
 * @param {() => boolean} args.isBusy Reads the busy hint
 * @param {(onActivity: () => void) => (() => void)} args.subscribe Registers the activity listeners, returns the unsubscribe
 * @param {boolean} [args.initialNotBusy] Whether the hint was off at an earlier baseline (the switch's begin). When it is
 * a boolean it replaces the start reading of `isBusy`, so a hint that turned on after that baseline and is still on
 * when the wait starts counts as an edge; any other value keeps the start reading
 * @param {number} [args.quietMs] Quiet time that settles the wait
 * @param {number} [args.busyGraceMs] How long a busy edge keeps the wait open
 * @param {number} [args.maxMs] Longest wait before the cap delivers
 * @param {number} [args.pollMs] Time between checks
 * @param {() => number} [args.now] Clock
 * @param {(fn: () => void, ms: number) => ReturnType<typeof setTimeout>} [args.schedule] Timer start
 * @param {(handle: ReturnType<typeof setTimeout>) => void} [args.cancel] Timer stop
 * @returns {Promise<{ settled: boolean, reason: 'quiet' | 'cap' | 'superseded' }>} How the wait ended
 */
export function waitForProfileSettle({
    isCurrent, readFingerprint, isBusy, subscribe, initialNotBusy,
    quietMs = 750, busyGraceMs = 3000, maxMs = 8000, pollMs = 150,
    now = Date.now, schedule = setTimeout, cancel = clearTimeout,
}) {
    return new Promise((resolve, reject) => {
        const start = now();
        let lastActivity = start;
        let lastFingerprint = readFingerprint();
        // The baseline reading counts: a hint that is already on at it and never drops is never an edge.
        let sawNotBusy = typeof initialNotBusy === 'boolean' ? initialNotBusy : !isBusy();
        let busyEdgeAt = -Infinity;
        let handle;
        let finished = false;

        const unsubscribe = subscribe(() => {
            if (!finished) {
                lastActivity = now();
            }
        });

        const exit = () => {
            finished = true;
            cancel(handle);
            unsubscribe();
        };

        /** @returns {{ settled: boolean, reason: 'quiet' | 'cap' | 'superseded' } | undefined} The outcome, once there is one */
        const evaluate = () => {
            if (!isCurrent()) {
                return { settled: false, reason: 'superseded' };
            }
            const time = now();
            const fingerprint = readFingerprint();
            if (fingerprint !== lastFingerprint) {
                lastFingerprint = fingerprint;
                lastActivity = time;
            }
            let busyHolds = false;
            if (isBusy()) {
                if (sawNotBusy) {
                    sawNotBusy = false;
                    lastActivity = time;
                    busyEdgeAt = time;
                }
                busyHolds = time < busyEdgeAt + busyGraceMs;
            } else {
                sawNotBusy = true;
            }
            if (time - start >= maxMs) {
                return { settled: true, reason: 'cap' };
            }
            if (time - lastActivity >= quietMs && !busyHolds) {
                return { settled: true, reason: 'quiet' };
            }
            return undefined;
        };

        const queueTick = () => {
            try {
                // Never step past the cap, so the last tick lands exactly on it.
                handle = schedule(tick, Math.min(pollMs, start + maxMs - now()));
            } catch (error) {
                exit();
                reject(error);
            }
        };

        function tick() {
            if (finished) {
                return;
            }
            let outcome;
            try {
                outcome = evaluate();
            } catch (error) {
                exit();
                reject(error);
                return;
            }
            if (outcome) {
                exit();
                resolve(outcome);
            } else {
                queueTick();
            }
        }

        queueTick();
    });
}
