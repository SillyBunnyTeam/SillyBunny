/**
 * The items that Home lists in its Bundled Extras window. This module only describes them: it does not
 * install, enable or check anything.
 *
 * `url` is the repository of an extension or theme, and the creator's page for a preset, because a preset
 * has no repository of its own.
 */

export const BUNDLED_EXTRA_GROUP_IDS = Object.freeze(['assistants', 'first-party-extensions', 'third-party-extensions', 'themes', 'presets']);

/**
 * @typedef {object} BundledExtra
 * @property {string} id Lowercase words joined by hyphens. Names the item's copy slot.
 * @property {string} name The item's own name, shown as it is.
 * @property {typeof BUNDLED_EXTRA_GROUP_IDS[number]} group
 * @property {'assistant' | 'extension' | 'theme-extension' | 'preset'} kind
 * @property {string | null} url
 */

const TEAM = 'https://github.com/SillyBunnyTeam';

/** @type {readonly BundledExtra[]} */
export const BUNDLED_EXTRAS = Object.freeze([
    { id: 'nahida', name: 'Nahida', group: 'assistants', kind: 'assistant', url: null },
    { id: 'alternate-descriptions', name: 'Alternate Descriptions', group: 'first-party-extensions', kind: 'extension', url: `${TEAM}/SillyBunny-AlternateDescriptions` },
    { id: 'bot-searcher', name: 'Bot Searcher', group: 'first-party-extensions', kind: 'extension', url: `${TEAM}/SillyBunny-BotSearcher` },
    { id: 'css-snippets', name: 'CSS Snippets', group: 'first-party-extensions', kind: 'extension', url: `${TEAM}/SillyBunny-CssSnippets` },
    { id: 'deep-swipe', name: 'Deep Swipe', group: 'first-party-extensions', kind: 'extension', url: `${TEAM}/SillyBunny-Deep-Swipe` },
    { id: 'macro-enhanced', name: 'Macro Enhanced', group: 'first-party-extensions', kind: 'extension', url: `${TEAM}/SillyBunny-MacroEnhanced` },
    { id: 'prompt-tags', name: 'Prompt Tags', group: 'first-party-extensions', kind: 'extension', url: `${TEAM}/SillyBunny-PromptTags` },
    { id: 'prompting-lab', name: 'Prompting Lab', group: 'first-party-extensions', kind: 'extension', url: `${TEAM}/SillyBunny-Prompting-Lab` },
    { id: 'regex-agent-themes', name: 'Regex Agent Themes', group: 'first-party-extensions', kind: 'extension', url: `${TEAM}/SillyBunny-Regex-Agent-Themes` },
    { id: 'time-machine', name: 'Time Machine', group: 'first-party-extensions', kind: 'extension', url: `${TEAM}/SillyBunny-Time-Machine` },
    { id: 'world-info-lab', name: 'World Info Lab', group: 'first-party-extensions', kind: 'extension', url: `${TEAM}/SillyBunny-WorldInfo-Lab` },
    { id: 'dialogue-colors', name: 'Dialogue Colors', group: 'third-party-extensions', kind: 'extension', url: 'https://github.com/platberlitz/sillytavern-character-colors' },
    { id: 'summary-sharder', name: 'Summary Sharder', group: 'third-party-extensions', kind: 'extension', url: 'https://github.com/Promansis/summary-sharder' },
    { id: 'group-utilities', name: 'Group Utilities', group: 'third-party-extensions', kind: 'extension', url: 'https://github.com/aracnai/SB-GroupUtilities' },
    { id: 'lalib', name: 'LALib', group: 'third-party-extensions', kind: 'extension', url: 'https://github.com/LenAnderson/SillyTavern-LALib' },
    { id: 'moonlit-echoes', name: 'Moonlit Echoes', group: 'themes', kind: 'theme-extension', url: `${TEAM}/SillyBunny-MoonlitEchoesTheme` },
    { id: 'terminal-ui', name: 'Terminal UI', group: 'themes', kind: 'theme-extension', url: `${TEAM}/SillyBunny-Terminal-UI` },
    { id: 'geechan-universal-roleplay', name: 'Geechan - Universal Roleplay (v5.2)', group: 'presets', kind: 'preset', url: 'https://rentry.org/geechan' },
    { id: 'tld-card-conversion', name: 'TLD Card Conversion Preset', group: 'presets', kind: 'preset', url: 'https://botbooru.com/profile/25826' },
].map(item => Object.freeze(item)));

/**
 * @param {string} id
 * @returns {string} The name of the placeholder slot for the item's description.
 */
export function getBundledExtraSlot(id) {
    return `BE-ITEM-${id.toUpperCase()}`;
}

/**
 * An assistant is a person with a subtitle, like a card on Home. The other items are described by their copy.
 * @param {BundledExtra} item
 * @returns {string} The name of the placeholder slot for the text under the item's name.
 */
export function getBundledExtraSubtitleSlot(item) {
    return item.group === 'assistants' ? `AS-${item.id.toUpperCase()}-SUB` : getBundledExtraSlot(item.id);
}

/**
 * @param {readonly BundledExtra[]} [items]
 * @returns {{ id: typeof BUNDLED_EXTRA_GROUP_IDS[number], items: BundledExtra[] }[]} Every group in page order, with the items of that group in list order.
 */
export function groupBundledExtras(items = BUNDLED_EXTRAS) {
    const groups = BUNDLED_EXTRA_GROUP_IDS.map(id => ({ id, items: [] }));
    for (const item of items) {
        const group = groups.find(candidate => candidate.id === item.group);
        if (!group) {
            throw new Error(`Bundled extra "${item.id}" is in an unknown group: ${item.group}`);
        }
        group.items.push(item);
    }
    return groups;
}
