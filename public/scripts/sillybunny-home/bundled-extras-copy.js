import { t } from '../i18n.js';

/**
 * What each Bundled Extras item does, in one line. Each description is read when a row is made and not when this
 * file loads, so it follows the language that the account has chosen.
 * @type {Readonly<Record<string, () => string>>}
 */
const DESCRIPTIONS = Object.freeze({
    'alternate-descriptions': () => t`Keep several versions of a character's description, personality and other fields, and switch between them.`,
    'bot-searcher': () => t`Browse character card sites from inside SillyBunny and import the cards you like. Requires a server plugin to be installed.`,
    'css-snippets': () => t`Manage your own CSS snippets, and turn each on everywhere, for one theme or for one chat.`,
    'deep-swipe': () => t`Swipe for a new version of any message in the chat, not just the last one.`,
    'macro-enhanced': () => t`Adds utility, logic and lorebook macros, macros of your own, and a workbench to test them.`,
    'prompt-tags': () => t`Wraps prompt sections such as World Info, the description and your persona in tags, so models can tell them apart.`,
    'prompting-lab': () => t`Rebuild your characters' prompts and compare them before and after a change, without sending anything.`,
    'regex-agent-themes': () => t`Restyle your in-chat agents' tracker and companion panels with one of 78 themes, or your own.`,
    'time-machine': () => t`Keeps earlier versions of your character cards, lorebooks and presets, so you can compare and restore them.`,
    'world-info-lab': () => t`Shows why lorebook entries did or didn't activate, and how much of the prompt they take.`,
    'dialogue-colors': () => t`Gives each character's dialogue its own colour, saved per chat, per card or everywhere.`,
    'summary-sharder': () => t`Summarises long chats into Memory Shards before they fall out of context, so nothing important is forgotten.`,
    'group-chat-overhaul': () => t`A Group Dynamics panel plus Group Greetings, Group Utilities and Group SendAs. Turn off standalone copies first.`,
    'lalib': () => t`A library of extra slash commands for STScript, with lists, loops, text tools and more.`,
    'moonlit-echoes': () => t`RivelleDays' Moonlit Echoes theme, adapted to style SillyBunny's chat layouts.`,
    'terminal-ui': () => t`A command-first look: a tmux-style status line, a flat transcript and fzf-like command results.`,
    'geechan-universal-roleplay': () => t`A modular Chat Completion preset for roleplay and story writing, with the model as game master.`,
    'tld-card-conversion': () => t`A Chat Completion preset that turns source material into character cards, step by step.`,
});

/**
 * @param {string} id The id of an item of `BUNDLED_EXTRAS`.
 * @returns {string} What the item does.
 */
export function getBundledExtraDescription(id) {
    const getDescription = DESCRIPTIONS[id];
    if (!getDescription) {
        throw new Error(`No description for the Bundled Extras item: ${id}`);
    }
    return getDescription();
}
