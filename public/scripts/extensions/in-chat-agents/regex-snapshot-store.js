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

function getCachedRegexScript(agentId, scriptId) {
    const cachedScripts = regexScriptsByAgentId.get(String(agentId ?? '')) ?? [];
    return cachedScripts.find(item => String(item?.id ?? '') === String(scriptId ?? '')) ?? null;
}

function buildResolvedLegacyRegexScriptRef(activeAgentIds, legacyScript) {
    if (!legacyScript?.id || !Array.isArray(activeAgentIds)) {
        return null;
    }

    const legacyRevision = getRegexScriptRevision(legacyScript);
    const matchingRefs = [];
    for (const agentId of activeAgentIds) {
        const cachedScript = getCachedRegexScript(agentId, legacyScript.id);
        if (!cachedScript || getRegexScriptRevision(cachedScript) !== legacyRevision) {
            continue;
        }

        matchingRefs.push({
            agentId: String(agentId),
            scriptId: String(legacyScript.id),
            revision: legacyRevision,
        });
    }

    return matchingRefs.length === 1 ? matchingRefs[0] : null;
}

export function migrateLegacyRegexSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot.regexScriptRefs) || !Array.isArray(snapshot.regexScripts)) {
        return { changed: false, snapshot };
    }

    if (snapshot.regexScripts.length === 0) {
        return { changed: false, snapshot };
    }

    const regexScriptRefs = [];
    for (const legacyScript of snapshot.regexScripts) {
        const ref = buildResolvedLegacyRegexScriptRef(snapshot.activeAgentIds, legacyScript);
        if (!ref) {
            return { changed: false, snapshot };
        }

        regexScriptRefs.push(ref);
    }

    const nextSnapshot = { ...snapshot, regexScriptRefs };
    delete nextSnapshot.regexScripts;
    return { changed: true, snapshot: nextSnapshot };
}

function migrateLegacyRegexSnapshotInExtra(extra, extraKey) {
    if (!extra || typeof extra !== 'object' || !Object.hasOwn(extra, extraKey)) {
        return false;
    }

    const migration = migrateLegacyRegexSnapshot(extra[extraKey]);
    if (!migration.changed) {
        return false;
    }

    extra[extraKey] = migration.snapshot;
    return true;
}

export function migrateLegacyRegexSnapshotsInMessages(messages = [], extraKey = 'inChatAgents') {
    if (!Array.isArray(messages)) {
        return 0;
    }

    let migrated = 0;
    for (const message of messages) {
        if (migrateLegacyRegexSnapshotInExtra(message?.extra, extraKey)) {
            migrated++;
        }

        if (!Array.isArray(message?.swipe_info)) {
            continue;
        }

        for (const swipeInfo of message.swipe_info) {
            if (migrateLegacyRegexSnapshotInExtra(swipeInfo?.extra, extraKey)) {
                migrated++;
            }
        }
    }

    return migrated;
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
