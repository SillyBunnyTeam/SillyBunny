import { t } from '../i18n.js';

/**
 * @typedef {object} HelpTopic
 * @property {string} id Stable kebab-case id. Other modules and tests refer to a topic by it, so it never changes.
 * @property {string} title A task-oriented label.
 * @property {string} [template] Path of the topic body template, once the body is written.
 * @property {string[]} seeAlso Ids of related topics, in display order.
 */

/**
 * @typedef {object} HelpSection
 * @property {string} id Stable kebab-case id.
 * @property {string} title
 * @property {HelpTopic[]} topics
 */

/**
 * Built on each call, so the titles follow the language that is active when the window opens.
 * @returns {HelpSection[]}
 */
export function getHelpSections() {
    return [
        {
            id: 'getting-around',
            title: t`Getting Around`,
            topics: [
                { id: 'find-your-way-around', title: t`Find Your Way Around`, seeAlso: ['switch-chat-mode', 'find-a-setting'] },
            ],
        },
        {
            id: 'models-and-connections',
            title: t`Models and Connections`,
            topics: [
                { id: 'connect-to-a-model', title: t`Connect to a Model`, seeAlso: ['choose-a-preset', 'fix-a-connection-problem'] },
            ],
        },
        {
            id: 'presets-and-prompts',
            title: t`Presets and Prompts`,
            topics: [
                { id: 'choose-a-preset', title: t`Choose a Preset`, seeAlso: ['connect-to-a-model'] },
            ],
        },
        {
            id: 'characters-and-personas',
            title: t`Characters and Personas`,
            topics: [
                { id: 'add-a-character', title: t`Add a Character`, seeAlso: ['start-a-chat', 'import-from-sillytavern'] },
            ],
        },
        {
            id: 'world-info',
            title: t`World Info`,
            topics: [
                { id: 'add-world-info', title: t`Add World Info`, seeAlso: ['add-a-character'] },
            ],
        },
        {
            id: 'chatting',
            title: t`Chatting`,
            topics: [
                { id: 'start-a-chat', title: t`Start a Chat`, seeAlso: ['add-a-character', 'switch-chat-mode'] },
            ],
        },
        {
            id: 'modes',
            title: t`Modes`,
            topics: [
                { id: 'switch-chat-mode', title: t`Switch Chat Mode`, seeAlso: ['start-a-chat'] },
            ],
        },
        {
            id: 'agents',
            title: t`Agents`,
            topics: [
                { id: 'turn-on-an-agent', title: t`Turn On an Agent`, seeAlso: ['connect-to-a-model'] },
            ],
        },
        {
            id: 'extensions-and-themes',
            title: t`Extensions and Themes`,
            topics: [
                { id: 'install-an-extension', title: t`Install an Extension`, seeAlso: [] },
            ],
        },
        {
            id: 'search',
            title: t`Search`,
            topics: [
                { id: 'find-a-setting', title: t`Find a Setting`, seeAlso: ['find-your-way-around'] },
            ],
        },
        {
            id: 'data-and-importing',
            title: t`Data and Importing`,
            topics: [
                { id: 'import-from-sillytavern', title: t`Import From SillyTavern`, seeAlso: ['add-a-character'] },
            ],
        },
        {
            id: 'troubleshooting',
            title: t`Troubleshooting`,
            topics: [
                { id: 'fix-a-connection-problem', title: t`Fix a Connection Problem`, seeAlso: ['connect-to-a-model'] },
            ],
        },
    ];
}

function toSearchText(value) {
    return String(value).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/**
 * Keeps the topics whose section title and topic title together contain every word of the query.
 * Sections without a matching topic are dropped. An empty query keeps everything.
 * @param {HelpSection[]} sections
 * @param {string} query
 * @returns {HelpSection[]}
 */
export function filterHelpSections(sections, query) {
    const words = toSearchText(query).split(/\s+/).filter(Boolean);
    if (words.length === 0) {
        return sections;
    }
    return sections
        .map((section) => {
            const topics = section.topics.filter((topic) => {
                const haystack = toSearchText(`${section.title} ${topic.title}`);
                return words.every(word => haystack.includes(word));
            });
            return { ...section, topics };
        })
        .filter(section => section.topics.length > 0);
}

/**
 * @param {string} id A topic id.
 * @returns {{ section: HelpSection, topic: HelpTopic } | null}
 */
export function findHelpTopic(id) {
    for (const section of getHelpSections()) {
        const topic = section.topics.find(candidate => candidate.id === id);
        if (topic) {
            return { section, topic };
        }
    }
    return null;
}
