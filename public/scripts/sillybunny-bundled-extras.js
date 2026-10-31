/**
 * The items that Home lists in its Bundled Extras window. This module only describes them: it does not
 * install, enable or check anything.
 *
 * `url` is the repository of an extension or theme, and the creator's page for a preset, because a preset
 * has no repository of its own.
 *
 * A preset ships with the app in `default/content`, so it is not installed from a URL: `presetName` is the name
 * of the bundled file. A `theme-css` item is a third-party CSS theme that the server installs from its own pinned
 * allowlist (`src/sillybunny-bundled-themes.js`); its `id` is the key there and `themeName` is the `name` in the
 * theme file. The window lists a Third-Party Themes group only when an item has the kind `theme-css`.
 */

export const BUNDLED_EXTRA_KINDS = Object.freeze(['assistant', 'extension', 'theme-extension', 'theme-css', 'preset']);

export const BUNDLED_EXTRA_GROUP_IDS = Object.freeze(['assistants', 'first-party-extensions', 'third-party-extensions', 'themes', 'presets']);

/**
 * @typedef {object} BundledExtra
 * @property {string} id Lowercase words joined by hyphens. Names the item's copy slot.
 * @property {string} name The item's own name, shown as it is.
 * @property {typeof BUNDLED_EXTRA_GROUP_IDS[number]} group
 * @property {typeof BUNDLED_EXTRA_KINDS[number]} kind
 * @property {string | null} url
 * @property {string} [presetName] Only on a preset: the name of the bundled Chat Completion preset.
 * @property {string} [themeName] Only on a `theme-css` item: the name in the theme file.
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
    { id: 'geechan-universal-roleplay', name: 'Geechan - Universal Roleplay (v5.2)', group: 'presets', kind: 'preset', url: 'https://rentry.org/geechan', presetName: 'Geechan - Universal Roleplay (Chat Completions) (v5.2)' },
    { id: 'tld-card-conversion', name: 'TLD Card Conversion Preset', group: 'presets', kind: 'preset', url: 'https://botbooru.com/profile/25826', presetName: 'TLD Card Conversion Preset (Standalone)' },
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

/**
 * The folder that the server installs an extension into: the last part of its repository address, as in
 * `/api/extensions/install`. The extension list knows the extension by that name.
 * @param {Pick<BundledExtra, 'kind' | 'url'>} item
 * @returns {string}
 */
export function getExtensionFolderName(item) {
    if (item.kind !== 'extension' && item.kind !== 'theme-extension') {
        throw new Error(`A ${item.kind} item is not an extension, so it has no extension folder.`);
    }
    return new URL(item.url).pathname.split('/').filter(Boolean).at(-1).replace(/\.git$/, '');
}
