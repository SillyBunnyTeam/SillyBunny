import { deleteGlobalVariable, deleteLocalVariable } from './variables.js';
import { collectPromptSetVariableNames } from './prompt-variable-names.js';

/**
 * Deletes local/global variables written by a disabled prompt so stale toggle values
 * (e.g. NSFW Mode, narration, friction) do not persist after the prompt is turned off.
 * @param {string} content Prompt content
 */
export function clearPromptSetVariables(content) {
    const { local, global } = collectPromptSetVariableNames(content);

    for (const name of local) {
        deleteLocalVariable(name);
    }

    for (const name of global) {
        deleteGlobalVariable(name);
    }
}
