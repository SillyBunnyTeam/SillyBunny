/**
 * Where Home sends the user: each target opens one place of the shell through `globalThis.SillyBunnyShell`.
 * Targets keep the shell's own tab ids in one place. Every opener is idempotent: a second call leaves the
 * place open, and `characters` names its tab so the shell does not reopen on the last tab the user visited.
 */
const TARGET_OPENERS = Object.freeze({
    connections: shell => shell.openTab('left', 'connections'),
    presets: shell => shell.openTab('left', 'prompting'),
    characters: shell => shell.openTab('characters', 'characters'),
    personas: shell => shell.openTab('characters', 'persona'),
    'mode-menu': shell => shell.openModeMenu(),
    'ui-theme': shell => shell.revealSetting('right', 'appearance', '#themes'),
});

const REQUIRED_SHELL_METHODS = Object.freeze({
    connections: 'openTab',
    presets: 'openTab',
    characters: 'openTab',
    personas: 'openTab',
    'mode-menu': 'openModeMenu',
    'ui-theme': 'revealSetting',
});

export const SHELL_TARGETS = Object.freeze(Object.keys(TARGET_OPENERS));

/**
 * @param {string} target One of {@link SHELL_TARGETS}.
 * @param {object} [shell] The shell API.
 * @returns {unknown} Whatever the shell returns, for example a promise that settles when the place is shown.
 */
export function openShellTarget(target, shell = globalThis.SillyBunnyShell) {
    const open = TARGET_OPENERS[target];
    if (!open) {
        throw new Error(`Unknown Home shell target: ${target}`);
    }
    const method = REQUIRED_SHELL_METHODS[target];
    if (typeof shell?.[method] !== 'function') {
        throw new Error(`The shell does not provide ${method}, which the "${target}" target needs.`);
    }
    return open(shell);
}
