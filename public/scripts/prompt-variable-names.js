const PROMPT_SET_VARIABLE_REGEX = /{{\s*(setvar|setglobalvar)\s*::\s*([^:}]+?)\s*::|{{\s*(setvar|setglobalvar)\s+([^\s}]+)/gi;

function normalizePromptVariableName(name) {
    return String(name ?? '').trim();
}

function getVariableScopeName(macroName) {
    return String(macroName ?? '').toLowerCase().includes('global') ? 'global' : 'local';
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

    for (const match of content.matchAll(PROMPT_SET_VARIABLE_REGEX)) {
        const macroName = match[1] ?? match[3];
        const name = normalizePromptVariableName(match[2] ?? match[4]);

        if (!name) {
            continue;
        }

        names[getVariableScopeName(macroName)].add(name);
    }

    return {
        local: [...names.local],
        global: [...names.global],
    };
}
