import { characters, saveSettingsDebounced, substituteParams, substituteParamsExtended, this_chid } from '../../../script.js';
import { extension_settings, writeExtensionField } from '../../extensions.js';
import { getPresetManager } from '../../preset-manager.js';
import { regexFromString } from '../../utils.js';
import { lodash } from '../../../lib.js';

/**
 * @readonly
 * @enum {number} Regex scripts types
 */
export const SCRIPT_TYPES = {
    // ORDER MATTERS: defines the regex script priority
    GLOBAL: 0,
    PRESET: 2,
    SCOPED: 1,
};

/**
 * Special type for unknown/invalid script types.
 */
export const SCRIPT_TYPE_UNKNOWN = -1;

/**
 * @typedef {import('../../char-data.js').RegexScriptData} RegexScript
 */

/**
 * @typedef {object} GetRegexScriptsOptions
 * @property {boolean} allowedOnly Only return allowed scripts
 */

/**
 * @type {Readonly<GetRegexScriptsOptions>}
 */
const DEFAULT_GET_REGEX_SCRIPTS_OPTIONS = Object.freeze({ allowedOnly: false });

/**
 * Manages the compiled regex cache with LRU eviction.
 */
export class RegexProvider {
    /** @type {Map<string, RegExp>} */
    #cache = new Map();
    /** @type {number} */
    #maxSize = 1000;

    static instance = new RegexProvider();

    /**
     * Gets a regex instance by its string representation.
     * @param {string} regexString The regex string to retrieve
     * @returns {RegExp?} Compiled regex or null if invalid
     */
    get(regexString) {
        const isCached = this.#cache.has(regexString);
        const regex = isCached
            ? this.#cache.get(regexString)
            : regexFromString(regexString);

        if (!regex) {
            return null;
        }

        if (isCached) {
            // LRU: Move to end by re-inserting
            this.#cache.delete(regexString);
            this.#cache.set(regexString, regex);
        } else {
            // Evict oldest if at capacity
            if (this.#cache.size >= this.#maxSize) {
                const firstKey = this.#cache.keys().next().value;
                this.#cache.delete(firstKey);
            }
            this.#cache.set(regexString, regex);
        }

        // Reset lastIndex for global/sticky regexes
        if (regex.global || regex.sticky) {
            regex.lastIndex = 0;
        }

        return regex;
    }

    /**
     * Clears the entire cache.
     */
    clear() {
        this.#cache.clear();
        invalidateRegexScriptsCache();
    }
}

// SillyBunny: cache filtered and compiled script buckets by (placement, mode) across streaming ticks.
const EMPTY_SCRIPTS = Object.freeze([]);
const LEGACY_MACRO_RE = /<(?:user|bot|char|group|charifnotgroup)>/i;
let regexCacheRevision = 0;
let compiledScriptsCache = null;

function hasMacroSyntax(pattern) {
    return pattern.includes('{{')
        || LEGACY_MACRO_RE.test(pattern)
        || pattern.includes('\\{')
        || pattern.includes('\\}');
}

/**
 * Invalidates cached filtered/compiled script buckets used by getRegexedString.
 */
export function invalidateRegexScriptsCache() {
    regexCacheRevision++;
    compiledScriptsCache = null;
}

function isRegexDebugEnabled() {
    return Boolean(extension_settings?.regex_debug);
}

function placementsShallowEqual(a, b) {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function resolveAllowedScriptSources() {
    const globalScripts = Array.isArray(extension_settings?.regex) ? extension_settings.regex : EMPTY_SCRIPTS;

    const presetManager = getPresetManager();
    const presetApi = presetManager?.apiId ?? null;
    const presetName = presetManager?.getSelectedPresetName() ?? null;
    const presetAllowed = Boolean(presetApi && presetName && extension_settings?.preset_allowed_regex?.[presetApi]?.includes(presetName));
    const rawPresetScripts = presetAllowed ? presetManager?.readPresetExtensionField({ path: 'regex_scripts' }) : EMPTY_SCRIPTS;
    const presetScripts = Array.isArray(rawPresetScripts) ? rawPresetScripts : EMPTY_SCRIPTS;

    const scopedAvatar = characters?.[this_chid]?.avatar;
    const scopedAllowed = Boolean(extension_settings?.character_allowed_regex?.includes(scopedAvatar));
    const rawScopedScripts = scopedAllowed ? characters?.[this_chid]?.data?.extensions?.regex_scripts : EMPTY_SCRIPTS;
    const scopedScripts = Array.isArray(rawScopedScripts) ? rawScopedScripts : EMPTY_SCRIPTS;

    // Order matches SCRIPT_TYPES priority: GLOBAL -> PRESET -> SCOPED.
    return { globalScripts, presetScripts, scopedScripts };
}

function isCompiledCacheValid(cache, globalScripts, presetScripts, scopedScripts) {
    if (!cache || cache.revision !== regexCacheRevision) return false;
    if (cache.globalScripts !== globalScripts || cache.globalLen !== globalScripts.length) return false;
    if (cache.presetScripts !== presetScripts || cache.presetLen !== presetScripts.length) return false;
    if (cache.scopedScripts !== scopedScripts || cache.scopedLen !== scopedScripts.length) return false;

    const snapshots = cache.snapshots;
    let index = 0;
    const lists = [globalScripts, presetScripts, scopedScripts];
    for (let l = 0; l < lists.length; l++) {
        const list = lists[l];
        for (let i = 0; i < list.length; i++) {
            const script = list[i];
            const snap = snapshots[index++];
            if (!snap || snap.script !== script) return false;
            if (!script) continue;
            if (snap.disabled !== script.disabled
                || snap.findRegex !== script.findRegex
                || snap.markdownOnly !== script.markdownOnly
                || snap.promptOnly !== script.promptOnly
                || snap.runOnEdit !== script.runOnEdit
                || snap.substituteRegex !== script.substituteRegex
                || snap.minDepth !== script.minDepth
                || snap.maxDepth !== script.maxDepth
                || !placementsShallowEqual(script.placement, snap.placement)) {
                return false;
            }
        }
    }
    return index === snapshots.length;
}

function buildCompiledCache(globalScripts, presetScripts, scopedScripts) {
    const snapshots = [];
    const lists = [globalScripts, presetScripts, scopedScripts];
    for (let l = 0; l < lists.length; l++) {
        const list = lists[l];
        for (let i = 0; i < list.length; i++) {
            const script = list[i];
            snapshots.push(script
                ? {
                    script,
                    disabled: script.disabled,
                    findRegex: script.findRegex,
                    markdownOnly: script.markdownOnly,
                    promptOnly: script.promptOnly,
                    runOnEdit: script.runOnEdit,
                    substituteRegex: script.substituteRegex,
                    minDepth: script.minDepth,
                    maxDepth: script.maxDepth,
                    placement: Array.isArray(script.placement) ? script.placement.slice() : script.placement,
                }
                : { script });
        }
    }

    return {
        revision: regexCacheRevision,
        globalScripts,
        globalLen: globalScripts.length,
        presetScripts,
        presetLen: presetScripts.length,
        scopedScripts,
        scopedLen: scopedScripts.length,
        snapshots,
        buckets: new Map(),
    };
}

function getCompiledBucket(placement, isMarkdown, isPrompt) {
    const { globalScripts, presetScripts, scopedScripts } = resolveAllowedScriptSources();
    if (!isCompiledCacheValid(compiledScriptsCache, globalScripts, presetScripts, scopedScripts)) {
        compiledScriptsCache = buildCompiledCache(globalScripts, presetScripts, scopedScripts);
    }

    const mode = (isMarkdown ? 1 : 0) | (isPrompt ? 2 : 0);
    const bucketKey = typeof placement === 'number' ? (placement * 4) + mode : `${placement}:${mode}`;
    let bucket = compiledScriptsCache.buckets.get(bucketKey);
    if (bucket !== undefined) {
        return bucket;
    }

    bucket = [];
    const lists = [globalScripts, presetScripts, scopedScripts];
    for (let l = 0; l < lists.length; l++) {
        const list = lists[l];
        for (let i = 0; i < list.length; i++) {
            const script = list[i];
            if (!script || script.disabled || !script.findRegex) continue;
            const modeMatches = (script.markdownOnly && isMarkdown)
                || (script.promptOnly && isPrompt)
                || (!script.markdownOnly && !script.promptOnly && !isMarkdown && !isPrompt);
            if (!modeMatches) continue;
            if (!Array.isArray(script.placement) || !script.placement.includes(placement)) continue;

            const subMode = Number(script.substituteRegex);
            const hasStaticRegex = subMode === substitute_find_regex.NONE
                || ((subMode === substitute_find_regex.RAW || subMode === substitute_find_regex.ESCAPED)
                    && !hasMacroSyntax(script.findRegex));
            let compiledRegex = null;
            if (hasStaticRegex) {
                compiledRegex = RegexProvider.instance.get(script.findRegex);
                if (!compiledRegex) continue;
            }

            bucket.push({
                script,
                hasStaticRegex,
                compiledRegex,
                runOnEdit: Boolean(script.runOnEdit),
                hasMinDepth: !isNaN(script.minDepth) && script.minDepth !== null && script.minDepth >= -1,
                minDepth: script.minDepth,
                hasMaxDepth: !isNaN(script.maxDepth) && script.maxDepth !== null && script.maxDepth >= 0,
                maxDepth: script.maxDepth,
            });
        }
    }

    compiledScriptsCache.buckets.set(bucketKey, bucket);
    return bucket;
}

/**
 * Retrieves the list of regex scripts by combining the scripts from the extension settings and the character data
 *
 * @param {GetRegexScriptsOptions} options Options for retrieving the regex scripts
 * @returns {RegexScript[]} An array of regex scripts, where each script is an object containing the necessary information.
 */
export function getRegexScripts(options = DEFAULT_GET_REGEX_SCRIPTS_OPTIONS) {
    return [...Object.values(SCRIPT_TYPES).flatMap(type => getScriptsByType(type, options))];
}

/**
 * Retrieves the regex scripts for a specific type.
 * @param {SCRIPT_TYPES} scriptType The type of regex scripts to retrieve.
 * @param {GetRegexScriptsOptions} options Options for retrieving the regex scripts
 * @returns {RegexScript[]} An array of regex scripts for the specified type.
 */
export function getScriptsByType(scriptType, { allowedOnly } = DEFAULT_GET_REGEX_SCRIPTS_OPTIONS) {
    switch (scriptType) {
        case SCRIPT_TYPE_UNKNOWN:
            return [];
        case SCRIPT_TYPES.GLOBAL:
            return extension_settings.regex ?? [];
        case SCRIPT_TYPES.SCOPED: {
            if (allowedOnly && !extension_settings?.character_allowed_regex?.includes(characters?.[this_chid]?.avatar)) {
                return [];
            }
            const scopedScripts = characters[this_chid]?.data?.extensions?.regex_scripts;
            return Array.isArray(scopedScripts) ? scopedScripts : [];
        }
        case SCRIPT_TYPES.PRESET: {
            if (allowedOnly && !extension_settings?.preset_allowed_regex?.[getCurrentPresetAPI()]?.includes(getCurrentPresetName())) {
                return [];
            }
            const presetManager = getPresetManager();
            const presetScripts = presetManager?.readPresetExtensionField({ path: 'regex_scripts' });
            return Array.isArray(presetScripts) ? presetScripts : [];
        }
        default:
            console.warn(`getScriptsByType: Invalid script type ${scriptType}`);
            return [];
    }
}

/**
 * Saves an array of regex scripts for a specific type.
 * @param {RegexScript[]} scripts An array of regex scripts to save.
 * @param {SCRIPT_TYPES} scriptType The type of regex scripts to save.
 * @returns {Promise<void>}
 */
export async function saveScriptsByType(scripts, scriptType) {
    invalidateRegexScriptsCache();
    switch (scriptType) {
        case SCRIPT_TYPES.GLOBAL:
            extension_settings.regex = scripts;
            saveSettingsDebounced();
            break;
        case SCRIPT_TYPES.SCOPED:
            await writeExtensionField(this_chid, 'regex_scripts', scripts);
            break;
        case SCRIPT_TYPES.PRESET: {
            const presetManager = getPresetManager();
            await presetManager.writePresetExtensionField({ path: 'regex_scripts', value: scripts });
            break;
        }
        default:
            console.warn(`saveScriptsByType: Invalid script type ${scriptType}`);
            break;
    }
}

/**
 * Check if character's regexes are allowed to be used; if character is undefined, returns false
 * @param {Character|undefined} character
 * @returns {boolean}
 */
export function isScopedScriptsAllowed(character) {
    return !!extension_settings?.character_allowed_regex?.includes(character?.avatar);
}

/**
 * Allow character's regexes to be used; if character is undefined, do nothing
 * @param {Character|undefined} character
 * @returns {void}
 */
export function allowScopedScripts(character) {
    const avatar = character?.avatar;
    if (!avatar) {
        return;
    }
    if (!Array.isArray(extension_settings?.character_allowed_regex)) {
        extension_settings.character_allowed_regex = [];
    }
    if (!extension_settings.character_allowed_regex.includes(avatar)) {
        extension_settings.character_allowed_regex.push(avatar);
        invalidateRegexScriptsCache();
        saveSettingsDebounced();
    }
}

/**
 * Disallow character's regexes to be used; if character is undefined, do nothing
 * @param {Character|undefined} character
 * @returns {void}
 */
export function disallowScopedScripts(character) {
    const avatar = character?.avatar;
    if (!avatar) {
        return;
    }
    if (!Array.isArray(extension_settings?.character_allowed_regex)) {
        return;
    }
    const index = extension_settings.character_allowed_regex.indexOf(avatar);
    if (index !== -1) {
        extension_settings.character_allowed_regex.splice(index, 1);
        invalidateRegexScriptsCache();
        saveSettingsDebounced();
    }
}

/**
 * Check if preset's regexes are allowed to be used
 * @param {string} apiId API ID
 * @param {string} presetName Preset name
 * @returns {boolean} True if allowed, false if not
 */
export function isPresetScriptsAllowed(apiId, presetName) {
    if (!apiId || !presetName) {
        return false;
    }
    return !!extension_settings?.preset_allowed_regex?.[apiId]?.includes(presetName);
}

/**
 * Allow preset's regexes to be used
 * @param {string} apiId API ID
 * @param {string} presetName Preset name
 * @returns {void}
 */
export function allowPresetScripts(apiId, presetName) {
    if (!apiId || !presetName) {
        return;
    }
    if (!Array.isArray(extension_settings?.preset_allowed_regex?.[apiId])) {
        lodash.set(extension_settings, ['preset_allowed_regex', apiId], []);
    }
    if (!extension_settings.preset_allowed_regex[apiId].includes(presetName)) {
        extension_settings.preset_allowed_regex[apiId].push(presetName);
        invalidateRegexScriptsCache();
        saveSettingsDebounced();
    }
}

/**
 * Disallow preset's regexes to be used
 * @param {string} apiId API ID
 * @param {string} presetName Preset name
 * @returns {void}
 */
export function disallowPresetScripts(apiId, presetName) {
    if (!apiId || !presetName) {
        return;
    }
    if (!Array.isArray(extension_settings?.preset_allowed_regex?.[apiId])) {
        return;
    }
    const index = extension_settings.preset_allowed_regex[apiId].indexOf(presetName);
    if (index !== -1) {
        extension_settings.preset_allowed_regex[apiId].splice(index, 1);
        invalidateRegexScriptsCache();
        saveSettingsDebounced();
    }
}

/**
 * Gets the current API ID from the preset manager.
 * @returns {string|null} Current API ID, or null if no preset manager
 */
export function getCurrentPresetAPI() {
    return getPresetManager()?.apiId ?? null;
}

/**
 * Gets the name of the currently selected preset.
 * @returns {string|null} The name of the currently selected preset, or null if no preset manager
 */
export function getCurrentPresetName() {
    return getPresetManager()?.getSelectedPresetName() ?? null;
}

/**
 * @readonly
 * @enum {number} Where the regex script should be applied
 */
export const regex_placement = {
    /**
     * @deprecated MD Display is deprecated. Do not use.
     */
    MD_DISPLAY: 0,
    USER_INPUT: 1,
    AI_OUTPUT: 2,
    SLASH_COMMAND: 3,
    // 4 - sendAs (legacy)
    WORLD_INFO: 5,
    REASONING: 6,
};

/**
 * @readonly
 * @enum {number} How to substitute parameters in the find regex
 */
export const substitute_find_regex = {
    NONE: 0,
    RAW: 1,
    ESCAPED: 2,
};

function sanitizeRegexMacro(x) {
    return (x && typeof x === 'string') ?
        x.replaceAll(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs, function (s) {
            switch (s) {
                case '\n':
                    return '\\n';
                case '\r':
                    return '\\r';
                case '\t':
                    return '\\t';
                case '\v':
                    return '\\v';
                case '\f':
                    return '\\f';
                case '\0':
                    return '\\0';
                default:
                    return '\\' + s;
            }
        }) : x;
}

/**
 * Parent function to fetch a regexed version of a raw string
 * @param {string} rawString The raw string to be regexed
 * @param {regex_placement} placement The placement of the string
 * @param {RegexParams} params The parameters to use for the regex script
 * @returns {string} The regexed string
 * @typedef {{characterOverride?: string, isMarkdown?: boolean, isPrompt?: boolean, isEdit?: boolean, depth?: number }} RegexParams The parameters to use for the regex script
 */
export function getRegexedString(rawString, placement, { characterOverride, isMarkdown, isPrompt, isEdit, depth } = {}) {
    // WTF have you passed me?
    if (typeof rawString !== 'string') {
        console.warn('getRegexedString: rawString is not a string. Returning empty string.');
        return '';
    }

    let finalString = rawString;
    if (extension_settings.disabledExtensions?.includes('regex') || !rawString || placement === undefined) {
        return finalString;
    }

    // SillyBunny: use cached (placement, mode) compiled buckets and gate debug logging behind regex_debug.
    const bucket = getCompiledBucket(placement, Boolean(isMarkdown), Boolean(isPrompt));
    if (bucket.length === 0) {
        return finalString;
    }

    const debugEnabled = isRegexDebugEnabled();
    const hasDepth = typeof depth === 'number';
    for (let i = 0; i < bucket.length; i++) {
        const entry = bucket[i];
        if (isEdit && !entry.runOnEdit) {
            if (debugEnabled) {
                console.debug(`getRegexedString: Skipping script ${entry.script.scriptName} because it does not run on edit`);
            }
            continue;
        }

        // Check if the depth is within the min/max depth
        if (hasDepth) {
            if (entry.hasMinDepth && depth < entry.minDepth) {
                if (debugEnabled) {
                    console.debug(`getRegexedString: Skipping script ${entry.script.scriptName} because depth ${depth} is less than minDepth ${entry.minDepth}`);
                }
                continue;
            }

            if (entry.hasMaxDepth && depth > entry.maxDepth) {
                if (debugEnabled) {
                    console.debug(`getRegexedString: Skipping script ${entry.script.scriptName} because depth ${depth} is greater than maxDepth ${entry.maxDepth}`);
                }
                continue;
            }
        }

        if (entry.hasStaticRegex) {
            if (!finalString) break;
            const compiled = entry.compiledRegex;
            if (compiled.global || compiled.sticky) {
                compiled.lastIndex = 0;
            }
            finalString = applyCompiledRegex(entry.script, compiled, finalString, { characterOverride });
        } else {
            finalString = runRegexScript(entry.script, finalString, { characterOverride });
        }
    }

    return finalString;
}

/**
 * Runs the provided regex script on the given string
 * @param {RegexScript} regexScript The regex script to run
 * @param {string} rawString The string to run the regex script on
 * @param {RegexScriptParams} params The parameters to use for the regex script
 * @returns {string} The new string
 * @typedef {{characterOverride?: string}} RegexScriptParams The parameters to use for the regex script
 */
export function runRegexScript(regexScript, rawString, { characterOverride } = {}) {
    if (!regexScript || !!(regexScript.disabled) || !regexScript?.findRegex || !rawString) {
        return rawString;
    }

    const getRegexString = () => {
        const findRegexStr = regexScript.findRegex;
        switch (Number(regexScript.substituteRegex)) {
            case substitute_find_regex.NONE:
                return findRegexStr;
            case substitute_find_regex.RAW:
                // SillyBunny: skip macro substitution when findRegex contains neither {{...}}, legacy angle-bracket macros, nor escaped braces.
                return hasMacroSyntax(findRegexStr) ? substituteParamsExtended(findRegexStr) : findRegexStr;
            case substitute_find_regex.ESCAPED:
                return hasMacroSyntax(findRegexStr) ? substituteParamsExtended(findRegexStr, {}, sanitizeRegexMacro) : findRegexStr;
            default:
                console.warn(`runRegexScript: Unknown substituteRegex value ${regexScript.substituteRegex}. Using raw regex.`);
                return findRegexStr;
        }
    };
    const regexString = getRegexString();
    const findRegex = RegexProvider.instance.get(regexString);

    // The user skill issued. Return with nothing.
    if (!findRegex) {
        return rawString;
    }

    return applyCompiledRegex(regexScript, findRegex, rawString, { characterOverride });
}

/**
 * Applies an already-compiled regex for a regex script.
 * @param {RegexScript} regexScript The regex script
 * @param {RegExp} findRegex Compiled regular expression
 * @param {string} rawString The string to transform
 * @param {RegexScriptParams} params Replacement parameters
 * @returns {string} The transformed string
 */
function applyCompiledRegex(regexScript, findRegex, rawString, { characterOverride } = {}) {
    // Run replacement. Currently does not support the Overlay strategy
    return rawString.replace(findRegex, function (match) {
        const args = [...arguments];
        const replaceString = regexScript.replaceString.replace(/{{match}}/gi, '$0');
        const replaceWithGroups = replaceString.replaceAll(/\$(\d+)|\$<([^>]+)>/g, (_, num, groupName) => {
            if (num) {
                // Handle numbered capture groups ($1, $2, etc.)
                match = args[Number(num)];
            } else if (groupName) {
                // Handle named capture groups ($<name>)
                const groups = args[args.length - 1];
                match = groups && typeof groups === 'object' && groups[groupName];
            }

            // No match found - return the empty string
            if (!match) {
                return '';
            }

            // Remove trim strings from the match
            const filteredMatch = filterString(match, regexScript.trimStrings, { characterOverride });

            return filteredMatch;
        });

        // Substitute at the end
        return substituteParams(replaceWithGroups);
    });
}

/**
 * Filters anything to trim from the regex match
 * @param {string} rawString The raw string to filter
 * @param {string[]} trimStrings The strings to trim
 * @param {RegexScriptParams} params The parameters to use for the regex filter
 * @returns {string} The filtered string
 */
function filterString(rawString, trimStrings, { characterOverride } = {}) {
    let finalString = rawString;
    trimStrings.forEach((trimString) => {
        const subTrimString = substituteParams(trimString, { name2Override: characterOverride });
        finalString = finalString.replaceAll(subTrimString, '');
    });

    return finalString;
}
