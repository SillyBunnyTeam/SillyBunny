/* eslint-disable playwright/no-standalone-expect -- Jest contracts for pure functions. */
import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
const { filterHelpSections, findHelpTopic, getFeaturedTopics, getHelpSections, validateHelpSections } = await import('../../public/scripts/sillybunny-help/topics.js');

const TOPICS_BY_SECTION = [
    ['getting-around', 'Getting Around', [['find-your-way-around', 'Find Your Way Around']]],
    ['models-and-connections', 'Models and Connections', [['connect-to-a-model', 'Connect to a Model']]],
    ['presets-and-prompts', 'Presets and Prompts', [['choose-a-preset', 'Choose a Preset']]],
    ['characters-and-personas', 'Characters and Personas', [['add-a-character', 'Add a Character']]],
    ['world-info', 'World Info', [['add-world-info', 'Add World Info']]],
    ['chatting', 'Chatting', [['start-a-chat', 'Start a Chat']]],
    ['modes', 'Modes', [['switch-chat-mode', 'Switch Chat Mode']]],
    ['agents', 'Agents', [['turn-on-an-agent', 'Turn On an Agent']]],
    ['extensions-and-themes', 'Extensions and Themes', [['install-an-extension', 'Install an Extension']]],
    ['search', 'Search', [['find-a-setting', 'Find a Setting']]],
    ['data-and-importing', 'Data and Importing', [['import-from-sillytavern', 'Import From SillyTavern']]],
    ['troubleshooting', 'Troubleshooting', [['fix-a-connection-problem', 'Fix a Connection Problem']]],
];
const FEATURED_IDS = ['connect-to-a-model', 'choose-a-preset', 'add-a-character', 'start-a-chat'];
const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const allTopics = (sections = getHelpSections()) => sections.flatMap(section => section.topics);

/** The shipped model with two more topics in Troubleshooting, one of them featured. */
function withMoreTroubleshooting() {
    const sections = getHelpSections();
    const troubleshooting = sections.find(section => section.id === 'troubleshooting');
    troubleshooting.topics.push(
        { id: 'fix-a-slow-reply', title: 'Fix a Slow Reply', descriptionSlot: 'HELP-TOPIC-fix-a-slow-reply-DESC', featured: true, seeAlso: ['fix-a-connection-problem'] },
        { id: 'read-an-error-message', title: 'Read an Error Message', descriptionSlot: 'HELP-TOPIC-read-an-error-message-DESC', featured: false, seeAlso: [] },
    );
    return sections;
}

describe('Help model', () => {
    test('lists the twelve sections in reading order with the twelve topics they have always had', () => {
        const shape = getHelpSections().map(section => [section.id, section.title, section.topics.map(topic => [topic.id, topic.title])]);

        expect(shape).toEqual(TOPICS_BY_SECTION);
    });

    test('gives every section an icon and at least one topic', () => {
        const sections = getHelpSections();

        expect(sections.filter(section => section.topics.length === 0).map(section => section.id)).toEqual([]);
        expect(sections.filter(section => !/^[a-z0-9-]+$/.test(section.icon)).map(section => section.id)).toEqual([]);
    });

    test('keeps every section and topic id unique and in kebab-case', () => {
        const ids = [...getHelpSections().map(section => section.id), ...allTopics().map(topic => topic.id)];

        expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
        expect(ids.filter(id => !KEBAB_CASE.test(id))).toEqual([]);
    });

    test('only lets See Also name other topics that exist', () => {
        const known = new Set(allTopics().map(topic => topic.id));
        const brokenLinks = allTopics().flatMap(topic => topic.seeAlso
            .filter(id => !known.has(id) || id === topic.id)
            .map(id => `${topic.id} -> ${id}`));

        expect(allTopics().every(topic => Array.isArray(topic.seeAlso))).toBe(true);
        expect(brokenLinks).toEqual([]);
    });

    test('names the copy slot of every description after the section or topic', () => {
        const sections = getHelpSections();

        expect(sections.map(section => section.descriptionSlot)).toEqual(TOPICS_BY_SECTION.map(([id]) => `HELP-SECTION-${id}-DESC`));
        expect(allTopics().map(topic => topic.descriptionSlot)).toEqual(TOPICS_BY_SECTION.flatMap(([, , topics]) => topics.map(([id]) => `HELP-TOPIC-${id}-DESC`)));
    });

    test('pairs each featured topic with the section it sits in', () => {
        const sectionIds = getFeaturedTopics(getHelpSections()).map(({ section }) => section.id);

        expect(sectionIds).toEqual(['models-and-connections', 'presets-and-prompts', 'characters-and-personas', 'chatting']);
    });

    test('features the four topics a new user needs first, in reading order', () => {
        expect(getFeaturedTopics(getHelpSections()).map(({ topic }) => topic.id)).toEqual(FEATURED_IDS);
    });
});

describe('Help model with more topics', () => {
    test('finds a topic with its section, and nothing for an unknown id', () => {
        const sections = withMoreTroubleshooting();
        const found = findHelpTopic(sections, 'read-an-error-message');

        expect(found.topic.title).toBe('Read an Error Message');
        expect(found.section.id).toBe('troubleshooting');
        expect(findHelpTopic(sections, 'no-such-topic')).toBeNull();
    });

    test('lists a new featured topic after the others', () => {
        const featured = getFeaturedTopics(withMoreTroubleshooting()).map(({ topic }) => topic.id);

        expect(featured).toEqual([...FEATURED_IDS, 'fix-a-slow-reply']);
    });

    test('search finds a new topic by its title and by the title of its section', () => {
        const sections = withMoreTroubleshooting();

        expect(allTopics(filterHelpSections(sections, 'slow reply')).map(topic => topic.id)).toEqual(['fix-a-slow-reply']);
        expect(allTopics(filterHelpSections(sections, 'troubleshooting')).map(topic => topic.id)).toEqual(['fix-a-connection-problem', 'fix-a-slow-reply', 'read-an-error-message']);
    });
});

describe('Help model validation', () => {
    const topic = (id, seeAlso = []) => ({ id, title: id, descriptionSlot: `HELP-TOPIC-${id}-DESC`, bodySlot: `HELP-TOPIC-${id}`, featured: false, seeAlso });
    const section = (id, topics) => ({ id, title: id, icon: 'book', descriptionSlot: `HELP-SECTION-${id}-DESC`, topics });

    test('accepts the shipped model and one with more topics', () => {
        expect(() => validateHelpSections(getHelpSections())).not.toThrow();
        expect(() => validateHelpSections(withMoreTroubleshooting())).not.toThrow();
    });

    test('refuses a See Also id that names no topic, and says which topic has it', () => {
        const sections = [section('first', [topic('alpha', ['no-such-topic'])])];

        expect(() => validateHelpSections(sections)).toThrow(/alpha.*no-such-topic/);
    });

    test('refuses a topic that lists itself in See Also', () => {
        expect(() => validateHelpSections([section('first', [topic('alpha', ['alpha'])])])).toThrow(/alpha.*itself/);
    });

    test('refuses an id that two topics share', () => {
        const sections = [section('first', [topic('alpha')]), section('second', [topic('alpha')])];

        expect(() => validateHelpSections(sections)).toThrow(/alpha.*more than once/);
    });

    test('refuses an id that a section and a topic share', () => {
        expect(() => validateHelpSections([section('alpha', [topic('alpha')])])).toThrow(/alpha.*more than once/);
    });

    test('refuses a section without a topic', () => {
        expect(() => validateHelpSections([section('first', [topic('alpha')]), section('empty', [])])).toThrow(/empty.*no topic/);
    });

    test('lists every problem at once', () => {
        const sections = [section('first', [topic('alpha', ['gone']), topic('alpha')]), section('empty', [])];
        const message = (() => {
            try {
                validateHelpSections(sections);
            } catch (error) {
                return error.message;
            }
            return '';
        })();

        expect(message).toMatch(/gone/);
        expect(message).toMatch(/alpha.*more than once/);
        expect(message).toMatch(/empty.*no topic/);
    });
});

describe('Help search', () => {
    test('keeps every section for an empty query', () => {
        const sections = getHelpSections();

        expect(filterHelpSections(sections, '   ')).toBe(sections);
    });

    test('needs every word of the query, ignores case and accents, and drops sections without a match', () => {
        const sections = getHelpSections();

        expect(filterHelpSections(sections, 'CHOOSE preset').map(section => section.id)).toEqual(['presets-and-prompts']);
        expect(filterHelpSections(sections, 'chóose').map(section => section.id)).toEqual(['presets-and-prompts']);
        expect(filterHelpSections(sections, 'zzzz')).toEqual([]);
    });
});
