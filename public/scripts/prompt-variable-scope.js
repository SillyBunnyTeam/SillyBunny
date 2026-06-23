const promptVariableScopeStack = [];

const PROMPT_VARIABLE_WRITE_NAME_REGEX = /{{\s*(setvar|setglobalvar|addvar|addglobalvar)\s*::\s*([^:}]+?)\s*::|{{\s*(incvar|decvar|deletevar|flushvar|incglobalvar|decglobalvar|deleteglobalvar|flushglobalvar)\s*::\s*([^}]+?)\s*}}|{{\s*(setvar|setglobalvar|addvar|addglobalvar|incvar|decvar|deletevar|flushvar|incglobalvar|decglobalvar|deleteglobalvar|flushglobalvar)\s+([^\s}]+)/gi;
const PROMPT_VARIABLE_ASSIGNMENT_REGEX = /{{\s*(setvar|setglobalvar)\s*::\s*([^:}]+?)\s*::\s*([^}]*)}}|{{\s*(deletevar|flushvar|deleteglobalvar|flushglobalvar)\s*::\s*([^}]+?)\s*}}|{{\s*(setvar|setglobalvar|deletevar|flushvar|deleteglobalvar|flushglobalvar)\s+([^\s}]+)(?:\s+([^}]*?))?\s*}}/gi;

function normalizePromptVariableName(name) {
    return String(name ?? '').trim();
}

function getScopeStore(scope, scopeName) {
    return scopeName === 'global' ? scope.global : scope.local;
}

function getVariableScopeName(macroName) {
    return String(macroName ?? '').toLowerCase().includes('global') ? 'global' : 'local';
}

function* getPromptVariableSourceContents(sources) {
    const sourceList = Array.isArray(sources) ? sources : [sources];

    for (const source of sourceList) {
        if (typeof source === 'string') {
            yield source;
        } else if (typeof source?.content === 'string') {
            yield source.content;
        } else if (typeof source?.value === 'string') {
            yield source.value;
        }
    }
}

function addPromptVariableName(names, macroName, name) {
    const normalizedName = normalizePromptVariableName(name);

    if (!normalizedName) {
        return;
    }

    names[getVariableScopeName(macroName)].add(normalizedName);
}

function setPromptVariableScopeValue(scope, scopeName, name, value) {
    const normalizedName = normalizePromptVariableName(name);

    if (!normalizedName) {
        return;
    }

    getScopeStore(scope, scopeName).set(normalizedName, value);
}

function deletePromptVariableScopeValue(scope, scopeName, name) {
    setPromptVariableScopeValue(scope, scopeName, name, undefined);
}

function popPromptVariableScope(scope) {
    const activeIndex = promptVariableScopeStack.length - 1;

    if (promptVariableScopeStack[activeIndex] === scope) {
        promptVariableScopeStack.pop();
        return;
    }

    const scopeIndex = promptVariableScopeStack.lastIndexOf(scope);

    if (scopeIndex >= 0) {
        promptVariableScopeStack.splice(scopeIndex, 1);
    }
}

export function collectPromptVariableNames(sources = []) {
    const names = {
        local: new Set(),
        global: new Set(),
    };

    for (const content of getPromptVariableSourceContents(sources)) {
        for (const match of content.matchAll(PROMPT_VARIABLE_WRITE_NAME_REGEX)) {
            const macroName = match[1] ?? match[3] ?? match[5];
            const name = match[2] ?? match[4] ?? match[6];
            addPromptVariableName(names, macroName, name);
        }
    }

    return names;
}

export function createPromptVariableScope({ local = [], global = [] } = {}) {
    const scope = {
        local: new Map(),
        global: new Map(),
    };

    for (const name of local) {
        deletePromptVariableScopeValue(scope, 'local', name);
    }

    for (const name of global) {
        deletePromptVariableScopeValue(scope, 'global', name);
    }

    return scope;
}

export function applyPromptVariableAssignments(scope, sources = []) {
    for (const content of getPromptVariableSourceContents(sources)) {
        for (const match of content.matchAll(PROMPT_VARIABLE_ASSIGNMENT_REGEX)) {
            const colonSetMacro = match[1];
            const colonDeleteMacro = match[4];
            const spacedMacro = match[6]?.toLowerCase();
            const macroName = colonSetMacro ?? colonDeleteMacro ?? spacedMacro;
            const scopeName = getVariableScopeName(macroName);

            if (colonSetMacro) {
                setPromptVariableScopeValue(scope, scopeName, match[2], match[3] ?? '');
            } else if (colonDeleteMacro) {
                deletePromptVariableScopeValue(scope, scopeName, match[5]);
            } else if (spacedMacro === 'setvar' || spacedMacro === 'setglobalvar') {
                setPromptVariableScopeValue(scope, scopeName, match[7], match[8] ?? '');
            } else {
                deletePromptVariableScopeValue(scope, scopeName, match[7]);
            }
        }
    }

    return scope;
}

export function hasActivePromptVariableScope() {
    return promptVariableScopeStack.length > 0;
}

export function getPromptVariableScopedValue(scopeName, name) {
    const scope = promptVariableScopeStack[promptVariableScopeStack.length - 1];
    const normalizedName = normalizePromptVariableName(name);

    if (!scope || !normalizedName) {
        return { scoped: false, value: undefined };
    }

    const store = getScopeStore(scope, scopeName);

    if (!store.has(normalizedName)) {
        return { scoped: false, value: undefined };
    }

    return { scoped: true, value: store.get(normalizedName) };
}

export function setPromptVariableScopedValue(scopeName, name, value) {
    const scope = promptVariableScopeStack[promptVariableScopeStack.length - 1];

    if (!scope) {
        return false;
    }

    setPromptVariableScopeValue(scope, scopeName, name, value);
    return true;
}

export function deletePromptVariableScopedValue(scopeName, name) {
    const scope = promptVariableScopeStack[promptVariableScopeStack.length - 1];

    if (!scope) {
        return false;
    }

    deletePromptVariableScopeValue(scope, scopeName, name);
    return true;
}

export function withPromptVariableScope(scope, callback) {
    promptVariableScopeStack.push(scope);

    try {
        const result = callback();

        if (result && typeof result.finally === 'function') {
            return result.finally(() => popPromptVariableScope(scope));
        }

        popPromptVariableScope(scope);
        return result;
    } catch (error) {
        popPromptVariableScope(scope);
        throw error;
    }
}
