import { regexFromString, uuidv4 } from '../../utils.js';

/**
 * @readonly
 * @enum {number}
 */
export const AGENT_REGEX_PLACEMENT = {
    MD_DISPLAY: 0,
    USER_INPUT: 1,
    AI_OUTPUT: 2,
    SLASH_COMMAND: 3,
    WORLD_INFO: 5,
    REASONING: 6,
};

/**
 * @readonly
 * @enum {number}
 */
export const AGENT_REGEX_SUBSTITUTE = {
    NONE: 0,
    RAW: 1,
    ESCAPED: 2,
};

const VALID_REGEX_PLACEMENTS = new Set(Object.values(AGENT_REGEX_PLACEMENT));
const compiledRegexCache = new Map();
/** @type {WeakMap<object, { id: unknown, scriptName: unknown, findRegex: unknown, replaceString: unknown, disabled: unknown, markdownOnly: unknown, promptOnly: unknown, runOnEdit: unknown, substituteRegex: unknown, minDepth: unknown, maxDepth: unknown, placement: unknown, trimStrings: unknown, normalized: import('../../char-data.js').RegexScriptData }>} */
const normalizedScriptCache = new WeakMap();

function arraysShallowEqual(a, b) {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function matchesRawScriptSnapshot(raw, entry) {
    return raw.id === entry.id
        && raw.scriptName === entry.scriptName
        && raw.findRegex === entry.findRegex
        && raw.replaceString === entry.replaceString
        && raw.disabled === entry.disabled
        && raw.markdownOnly === entry.markdownOnly
        && raw.promptOnly === entry.promptOnly
        && raw.runOnEdit === entry.runOnEdit
        && raw.substituteRegex === entry.substituteRegex
        && raw.minDepth === entry.minDepth
        && raw.maxDepth === entry.maxDepth
        && arraysShallowEqual(raw.placement, entry.placement)
        && arraysShallowEqual(raw.trimStrings, entry.trimStrings);
}

function sanitizeRegexMacro(value) {
    return (value && typeof value === 'string')
        ? value.replaceAll(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs, function (match) {
            switch (match) {
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
                    return '\\' + match;
            }
        })
        : value;
}

function normalizeNullableDepth(value, { allowNegativeOne = false } = {}) {
    if (value === '' || value === null || value === undefined) {
        return null;
    }

    const depth = Number(value);
    if (!Number.isFinite(depth)) {
        return null;
    }

    if (allowNegativeOne && depth >= -1) {
        return depth;
    }

    return depth >= 0 ? depth : null;
}

function getCompiledRegex(regexString) {
    const cached = compiledRegexCache.get(regexString);
    if (cached) {
        if (cached.global || cached.sticky) {
            cached.lastIndex = 0;
        }
        return cached;
    }

    const compiled = regexFromString(regexString);
    if (!compiled) {
        return null;
    }

    if (compiledRegexCache.size >= 1000) {
        const oldest = compiledRegexCache.keys().next().value;
        compiledRegexCache.delete(oldest);
    }

    compiledRegexCache.set(regexString, compiled);
    return compiled;
}

/**
 * Creates a default ST-style agent regex script.
 * @returns {import('../../char-data.js').RegexScriptData}
 */
export function createDefaultRegexScript() {
    return {
        id: uuidv4(),
        scriptName: '',
        findRegex: '',
        replaceString: '',
        trimStrings: [],
        placement: [AGENT_REGEX_PLACEMENT.AI_OUTPUT],
        disabled: false,
        markdownOnly: true,
        promptOnly: false,
        runOnEdit: true,
        substituteRegex: AGENT_REGEX_SUBSTITUTE.NONE,
        minDepth: null,
        maxDepth: null,
    };
}

/**
 * Normalizes a regex script payload from templates, disk, or editor state.
 * @param {Partial<import('../../char-data.js').RegexScriptData>} rawScript
 * @returns {import('../../char-data.js').RegexScriptData}
 */
export function normalizeRegexScript(rawScript = {}) {
    const id = typeof rawScript.id === 'string' && rawScript.id.trim() ? rawScript.id.trim() : uuidv4();
    const placement = Array.isArray(rawScript.placement)
        ? rawScript.placement
            .map(value => Number(value))
            .filter(value => VALID_REGEX_PLACEMENTS.has(value))
        : [AGENT_REGEX_PLACEMENT.AI_OUTPUT];

    return {
        ...rawScript,
        id,
        scriptName: typeof rawScript.scriptName === 'string' ? rawScript.scriptName.trim() : '',
        findRegex: typeof rawScript.findRegex === 'string' ? rawScript.findRegex : '',
        replaceString: typeof rawScript.replaceString === 'string' ? rawScript.replaceString : '',
        trimStrings: Array.isArray(rawScript.trimStrings)
            ? rawScript.trimStrings.map(value => String(value ?? '')).filter(Boolean)
            : [],
        placement: placement.length > 0 ? [...new Set(placement)] : [AGENT_REGEX_PLACEMENT.AI_OUTPUT],
        disabled: Boolean(rawScript.disabled),
        markdownOnly: rawScript.markdownOnly === undefined ? true : Boolean(rawScript.markdownOnly),
        promptOnly: Boolean(rawScript.promptOnly),
        runOnEdit: rawScript.runOnEdit === undefined ? true : Boolean(rawScript.runOnEdit),
        substituteRegex: Number.isFinite(Number(rawScript.substituteRegex))
            ? Number(rawScript.substituteRegex)
            : AGENT_REGEX_SUBSTITUTE.NONE,
        minDepth: normalizeNullableDepth(rawScript.minDepth, { allowNegativeOne: true }),
        maxDepth: normalizeNullableDepth(rawScript.maxDepth),
    };
}

/**
 * Returns a memoized normalized regex script for read-only execution paths (such as streaming ticks).
 * Invalidates automatically if any relevant field or array element on the source script object is mutated.
 * @param {Partial<import('../../char-data.js').RegexScriptData>} rawScript
 * @returns {import('../../char-data.js').RegexScriptData}
 */
export function getNormalizedRegexScript(rawScript) {
    if (!rawScript || typeof rawScript !== 'object') {
        return normalizeRegexScript({});
    }

    const cached = normalizedScriptCache.get(rawScript);
    if (cached && matchesRawScriptSnapshot(rawScript, cached)) {
        return cached.normalized;
    }

    const normalized = normalizeRegexScript(rawScript);
    normalizedScriptCache.set(rawScript, {
        id: rawScript.id,
        scriptName: rawScript.scriptName,
        findRegex: rawScript.findRegex,
        replaceString: rawScript.replaceString,
        disabled: rawScript.disabled,
        markdownOnly: rawScript.markdownOnly,
        promptOnly: rawScript.promptOnly,
        runOnEdit: rawScript.runOnEdit,
        substituteRegex: rawScript.substituteRegex,
        minDepth: rawScript.minDepth,
        maxDepth: rawScript.maxDepth,
        placement: Array.isArray(rawScript.placement) ? rawScript.placement.slice() : rawScript.placement,
        trimStrings: Array.isArray(rawScript.trimStrings) ? rawScript.trimStrings.slice() : rawScript.trimStrings,
        normalized,
    });
    return normalized;
}

function shouldApplyScript(script, placement, { isMarkdown = false, isPrompt = false, isEdit = false, depth } = {}) {
    if (script.disabled || !script.findRegex || !Array.isArray(script.placement) || !script.placement.includes(placement)) {
        return false;
    }

    const supportsCurrentMode =
        (script.markdownOnly && isMarkdown) ||
        (script.promptOnly && isPrompt) ||
        (!script.markdownOnly && !script.promptOnly && !isMarkdown && !isPrompt);

    if (!supportsCurrentMode) {
        return false;
    }

    if (isEdit && !script.runOnEdit) {
        return false;
    }

    if (typeof depth === 'number') {
        if (script.minDepth !== null && depth < script.minDepth) {
            return false;
        }

        if (script.maxDepth !== null && depth > script.maxDepth) {
            return false;
        }
    }

    return true;
}

function filterTrimStrings(rawString, trimStrings, {
    characterOverride,
    substituteParamsFn = value => value,
} = {}) {
    let filtered = rawString;

    for (const trimString of trimStrings) {
        const resolvedTrim = substituteParamsFn(trimString, { name2Override: characterOverride });
        filtered = filtered.replaceAll(resolvedTrim, '');
    }

    return filtered;
}

/**
 * Applies a single ST-style regex script to a string.
 * @param {import('../../char-data.js').RegexScriptData} script
 * @param {string} rawString
 * @param {object} [options]
 * @param {string} [options.characterOverride]
 * @param {(value: string, params?: object, sanitizer?: (value: string) => string) => string} [options.substituteParamsExtendedFn]
 * @param {(value: string, params?: object) => string} [options.substituteParamsFn]
 * @returns {string}
 */
export function applyRegexScript(script, rawString, {
    characterOverride,
    substituteParamsExtendedFn = value => value,
    substituteParamsFn = value => value,
} = {}) {
    if (!script || typeof rawString !== 'string' || !rawString || !script.findRegex) {
        return rawString;
    }

    const regexString = (() => {
        switch (Number(script.substituteRegex)) {
            case AGENT_REGEX_SUBSTITUTE.NONE:
                return script.findRegex;
            case AGENT_REGEX_SUBSTITUTE.RAW:
                return substituteParamsExtendedFn(script.findRegex);
            case AGENT_REGEX_SUBSTITUTE.ESCAPED:
                return substituteParamsExtendedFn(script.findRegex, {}, sanitizeRegexMacro);
            default:
                return script.findRegex;
        }
    })();

    const compiled = getCompiledRegex(regexString);
    if (!compiled) {
        return rawString;
    }

    return rawString.replace(compiled, function (match) {
        const args = [...arguments];
        const replaceString = script.replaceString.replace(/{{match}}/gi, '$0');
        const interpolated = replaceString.replaceAll(/\$(\d+)|\$<([^>]+)>/g, (_, groupIndex, groupName) => {
            const replacement = groupIndex
                ? args[Number(groupIndex)]
                : (args[args.length - 1] && typeof args[args.length - 1] === 'object'
                    ? args[args.length - 1][groupName]
                    : undefined);

            if (!replacement) {
                return '';
            }

            return filterTrimStrings(replacement, script.trimStrings, {
                characterOverride,
                substituteParamsFn,
            });
        });

        return substituteParamsFn(interpolated);
    });
}

/**
 * Applies a list of regex scripts in order.
 * @param {string} rawString
 * @param {Partial<import('../../char-data.js').RegexScriptData>[]} scripts
 * @param {number} placement
 * @param {object} [options]
 * @param {string} [options.characterOverride]
 * @param {boolean} [options.isMarkdown]
 * @param {boolean} [options.isPrompt]
 * @param {boolean} [options.isEdit]
 * @param {number} [options.depth]
 * @param {(value: string, params?: object, sanitizer?: (value: string) => string) => string} [options.substituteParamsExtendedFn]
 * @param {(value: string, params?: object) => string} [options.substituteParamsFn]
 * @returns {string}
 */
export function applyRegexScriptList(rawString, scripts, placement, options = {}) {
    if (typeof rawString !== 'string' || !rawString || !Array.isArray(scripts) || placement === undefined) {
        return rawString;
    }

    let output = rawString;

    for (const rawScript of scripts) {
        const script = getNormalizedRegexScript(rawScript);
        if (!shouldApplyScript(script, placement, options)) {
            continue;
        }

        output = applyRegexScript(script, output, options);
    }

    return output;
}
