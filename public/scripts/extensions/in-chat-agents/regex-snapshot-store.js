const regexScriptsByAgentId = new Map();

const REGEX_SCRIPT_REVISION_FIELDS = [
    'findRegex',
    'replaceString',
    'trimStrings',
    'placement',
    'disabled',
    'markdownOnly',
    'promptOnly',
    'runOnEdit',
    'substituteRegex',
    'minDepth',
    'maxDepth',
];

function cloneValue(value) {
    if (value === undefined) {
        return undefined;
    }

    return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    return `${value.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

function getRegexScriptRevisionPayload(script = {}) {
    return REGEX_SCRIPT_REVISION_FIELDS.reduce((payload, field) => {
        payload[field] = script?.[field] ?? null;
        return payload;
    }, {});
}

export function getRegexScriptRevision(script = {}) {
    return hashString(JSON.stringify(getRegexScriptRevisionPayload(script)));
}

export function buildRegexScriptRefsForAgent(agentId, scripts = []) {
    if (!agentId || !Array.isArray(scripts)) {
        return [];
    }

    return scripts
        .filter(script => script?.id)
        .map(script => ({
            agentId: String(agentId),
            scriptId: String(script.id),
            revision: getRegexScriptRevision(script),
        }));
}

export function cacheAgentRegexScripts(agentId, scripts = []) {
    if (!agentId) {
        return;
    }

    regexScriptsByAgentId.set(String(agentId), Array.isArray(scripts) ? cloneValue(scripts) : []);
}

export function deleteCachedAgentRegexScripts(agentId) {
    if (!agentId) {
        return;
    }

    regexScriptsByAgentId.delete(String(agentId));
}

export function clearCachedAgentRegexScripts() {
    regexScriptsByAgentId.clear();
}

export function resolveRegexScriptsForSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
        return [];
    }

    if (Array.isArray(snapshot.regexScriptRefs)) {
        const resolvedScripts = [];
        for (const ref of snapshot.regexScriptRefs) {
            const cachedScripts = regexScriptsByAgentId.get(String(ref?.agentId ?? '')) ?? [];
            const script = cachedScripts.find(item => String(item?.id ?? '') === String(ref?.scriptId ?? ''));
            if (script) {
                resolvedScripts.push(script);
            }
        }

        return resolvedScripts;
    }

    return Array.isArray(snapshot.regexScripts) ? snapshot.regexScripts : [];
}
