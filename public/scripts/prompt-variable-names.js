const PROMPT_INLINE_SET_VARIABLE_REGEX = /{{\s*(setvar|setglobalvar)\s*::\s*([^:}]+?)\s*::|{{\s*(setvar|setglobalvar)\s+([^\s}]+)/gi;
const PROMPT_SCOPED_SET_VARIABLE_REGEX = /{{\s*#?\s*(setvar|setglobalvar)\s*::\s*([^:}]+?)\s*}}/gi;

function normalizePromptVariableName(name) {
    return String(name ?? '').trim();
}

function getVariableScopeName(macroName) {
    return String(macroName ?? '').toLowerCase().includes('global') ? 'global' : 'local';
}

function addPromptVariableName(names, macroName, name) {
    const variableName = normalizePromptVariableName(name);

    if (!variableName) {
        return;
    }

    names[getVariableScopeName(macroName)].add(variableName);
}

/**
 * Extracts variable names written by setvar/setglobalvar macros in prompt content.
 * @param {string} content Prompt content
 * @returns {{ local: string[], global: string[] }} Local and global variable names
 */
export function collectPromptSetVariableNames(content) {
    const names = {
        local: new Set(),
        global: new Set(),
    };

    if (typeof content !== 'string') {
        return { local: [], global: [] };
    }

    for (const match of content.matchAll(PROMPT_INLINE_SET_VARIABLE_REGEX)) {
        const macroName = match[1] ?? match[3];
        const name = match[2] ?? match[4];

        addPromptVariableName(names, macroName, name);
    }

    for (const match of content.matchAll(PROMPT_SCOPED_SET_VARIABLE_REGEX)) {
        addPromptVariableName(names, match[1], match[2]);
    }

    return {
        local: [...names.local],
        global: [...names.global],
    };
}
