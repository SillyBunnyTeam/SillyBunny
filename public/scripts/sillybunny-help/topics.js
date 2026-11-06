import { t } from '../i18n.js';

/**
 * @typedef {object} HelpTopic
 * @property {string} id Stable kebab-case id. Other modules and tests refer to a topic by it, so it never changes.
 * @property {string} title A task-oriented label.
 * @property {string} descriptionSlot Names the copy of the one-line description.
 * @property {string} bodySlot Names the copy of the topic body.
 * @property {boolean} featured Whether the topic is on the front page.
 * @property {string} [template] Path of the topic body template under `scripts/templates/`. A topic without one shows the placeholder.
 * @property {string[]} seeAlso Ids of related topics, in display order.
 */

/**
 * @typedef {object} HelpSection
 * @property {string} id Stable kebab-case id.
 * @property {string} title
 * @property {string} icon Font Awesome icon name without the fa- prefix.
 * @property {string} descriptionSlot Names the copy of the one-line description.
 * @property {HelpTopic[]} topics At least one, in reading order. Add a topic by adding it here.
 */

/**
 * @param {string} id
 * @param {string} title
 * @param {{ featured?: boolean, seeAlso?: string[] }} [options]
 */
const topic = (id, title, { featured = false, seeAlso = [] } = {}) => ({
    id,
    title,
    descriptionSlot: `HELP-TOPIC-${id}-DESC`,
    bodySlot: `HELP-TOPIC-${id}`,
    template: `help/${id}`,
    featured,
    seeAlso,
});

/**
 * @param {string} id
 * @param {string} title
 * @param {string} icon
 * @param {ReturnType<typeof topic>[]} topics
 * @returns {HelpSection}
 */
const section = (id, title, icon, topics) => ({
    id,
    title,
    icon,
    descriptionSlot: `HELP-SECTION-${id}-DESC`,
    topics,
});

/**
 * Built on each call, so the titles follow the language that is active when the window opens.
 * @returns {HelpSection[]}
 */
export function getHelpSections() {
    return [
        section('getting-around', t`Getting Around`, 'compass', [
            topic('find-your-way-around', t`Find Your Way Around`, { seeAlso: ['switch-chat-mode', 'find-a-setting'] }),
        ]),
        section('models-and-connections', t`Models and Connections`, 'plug', [
            topic('connect-to-a-model', t`Connect to a Model`, { featured: true, seeAlso: ['choose-a-preset', 'fix-a-connection-problem'] }),
        ]),
        section('presets-and-prompts', t`Presets and Prompts`, 'sliders', [
            topic('choose-a-preset', t`Choose a Preset`, { featured: true, seeAlso: ['connect-to-a-model'] }),
        ]),
        section('characters-and-personas', t`Characters and Personas`, 'masks-theater', [
            topic('add-a-character', t`Add a Character`, { featured: true, seeAlso: ['start-a-chat', 'import-from-sillytavern'] }),
        ]),
        section('world-info', t`World Info`, 'book', [
            topic('add-world-info', t`Add World Info`, { seeAlso: ['add-a-character'] }),
        ]),
        section('chatting', t`Chatting`, 'comments', [
            topic('start-a-chat', t`Start a Chat`, { featured: true, seeAlso: ['add-a-character', 'switch-chat-mode'] }),
        ]),
        section('modes', t`Modes`, 'layer-group', [
            topic('switch-chat-mode', t`Switch Chat Mode`, { seeAlso: ['start-a-chat'] }),
        ]),
        section('agents', t`Agents`, 'robot', [
            topic('turn-on-an-agent', t`Turn On an Agent`, { seeAlso: ['connect-to-a-model'] }),
        ]),
        section('extensions-and-themes', t`Extensions and Themes`, 'puzzle-piece', [
            topic('install-an-extension', t`Install an Extension`),
        ]),
        section('search', t`Search`, 'magnifying-glass', [
            topic('find-a-setting', t`Find a Setting`, { seeAlso: ['find-your-way-around'] }),
        ]),
        section('data-and-importing', t`Data and Importing`, 'file-import', [
            topic('import-from-sillytavern', t`Import From SillyTavern`, { seeAlso: ['add-a-character'] }),
        ]),
        section('troubleshooting', t`Troubleshooting`, 'life-ring', [
            topic('fix-a-connection-problem', t`Fix a Connection Problem`, { seeAlso: ['connect-to-a-model'] }),
        ]),
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
    // Only titles are searched. The descriptions are placeholders until the copy exists, so the text of a
    // result row and this haystack are where to add them.
    return sections
        .map((entry) => {
            const topics = entry.topics.filter((candidate) => {
                const haystack = toSearchText(`${entry.title} ${candidate.title}`);
                return words.every(word => haystack.includes(word));
            });
            return { ...entry, topics };
        })
        .filter(entry => entry.topics.length > 0);
}

/**
 * @param {HelpSection[]} sections
 * @param {string} id A topic id.
 * @returns {{ section: HelpSection, topic: HelpTopic } | null}
 */
export function findHelpTopic(sections, id) {
    for (const entry of sections) {
        const found = entry.topics.find(candidate => candidate.id === id);
        if (found) {
            return { section: entry, topic: found };
        }
    }
    return null;
}

/**
 * @param {HelpSection[]} sections
 * @returns {{ section: HelpSection, topic: HelpTopic }[]} The topics for the front page, in reading order.
 */
export function getFeaturedTopics(sections) {
    return sections.flatMap(entry => entry.topics.filter(candidate => candidate.featured).map(topic => ({ section: entry, topic })));
}

/**
 * Throws when the model would break a page: an id that two entries share, a section without a topic, or a
 * See Also id that names no other topic. A window refuses such a model, because a page would otherwise drop
 * the link or open the wrong entry without a word.
 * @param {HelpSection[]} sections
 */
export function validateHelpSections(sections) {
    const ids = [...sections.map(entry => entry.id), ...sections.flatMap(entry => entry.topics.map(candidate => candidate.id))];
    const topicIds = new Set(sections.flatMap(entry => entry.topics.map(candidate => candidate.id)));
    const problems = [
        ...[...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))].map(id => `The id "${id}" is used more than once.`),
        ...sections.filter(entry => entry.topics.length === 0).map(entry => `The section "${entry.id}" has no topic.`),
        ...sections.flatMap(entry => entry.topics.flatMap(candidate => candidate.seeAlso.flatMap((id) => {
            if (id === candidate.id) {
                return [`The topic "${candidate.id}" lists itself in See Also.`];
            }
            return topicIds.has(id) ? [] : [`The topic "${candidate.id}" lists "${id}" in See Also, which is not a topic.`];
        }))),
    ];
    if (problems.length > 0) {
        throw new Error(`The Help model is not valid:\n${problems.join('\n')}`);
    }
}
