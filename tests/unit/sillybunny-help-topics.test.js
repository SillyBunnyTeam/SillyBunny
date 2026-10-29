/* eslint-disable playwright/no-standalone-expect -- Jest contracts for pure functions. */
import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
const { findHelpTopic, getHelpSections } = await import('../../public/scripts/sillybunny-help/topics.js');

const SECTION_TITLES = [
    'Getting Around',
    'Models and Connections',
    'Presets and Prompts',
    'Characters and Personas',
    'World Info',
    'Chatting',
    'Modes',
    'Agents',
    'Extensions and Themes',
    'Search',
    'Data and Importing',
    'Troubleshooting',
];
const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const allTopics = () => getHelpSections().flatMap(section => section.topics);

describe('Help topics', () => {
    test('lists the twelve sections in reading order', () => {
        expect(getHelpSections().map(section => section.title)).toEqual(SECTION_TITLES);
    });

    test('gives every section at least one titled topic', () => {
        const sectionsWithoutTopics = getHelpSections().filter(section => section.topics.length === 0).map(section => section.id);
        const untitledTopics = allTopics().filter(topic => topic.title.trim() === '').map(topic => topic.id);

        expect(sectionsWithoutTopics).toEqual([]);
        expect(untitledTopics).toEqual([]);
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

    test('finds a topic with its section, and nothing for an unknown id', () => {
        const [section] = getHelpSections();
        const [topic] = section.topics;

        expect(findHelpTopic(topic.id)).toEqual({ section, topic });
        expect(findHelpTopic('no-such-topic')).toBeNull();
    });
});
