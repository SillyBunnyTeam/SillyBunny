/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for static files. */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
const { getHelpSections } = await import('../../public/scripts/sillybunny-help/topics.js');

const TEMPLATE_DIRECTORY = new URL('../../public/scripts/templates/help/', import.meta.url);
const allTopics = () => getHelpSections().flatMap(section => section.topics);
const readTemplate = id => readFileSync(new URL(`${id}.html`, TEMPLATE_DIRECTORY), 'utf8');

describe('Help topic templates', () => {
    test('names a template for every topic, in the help folder of the templates, after the id of the topic', () => {
        expect(allTopics().map(topic => [topic.id, topic.template])).toEqual(allTopics().map(topic => [topic.id, `help/${topic.id}`]));
    });

    test('has one template file for every topic, and no file for anything else', () => {
        const files = readdirSync(TEMPLATE_DIRECTORY).sort();

        expect(files).toEqual(allTopics().map(topic => `${topic.id}.html`).sort());
    });

    test.each(allTopics().map(topic => [topic.id, topic]))('keeps the body of %s as copy that is still missing, in the slot the model names', (id, topic) => {
        const markup = readTemplate(id);
        const document = new DOMParser().parseFromString(markup, 'text/html');
        const body = document.body.children;

        expect(topic.bodySlot).toBe(`HELP-TOPIC-${id}`);
        expect(body).toHaveLength(1);
        expect(body[0].textContent).toBe('TODO(copy)');
        expect(body[0].getAttribute('data-sb-copy-placeholder')).toBe('true');
        expect(body[0].getAttribute('data-sb-copy-slot')).toBe(topic.bodySlot);
    });

    test('uses no template syntax, so the file is the text of its page and nothing else', () => {
        const withSyntax = allTopics().map(topic => topic.id).filter(id => /\{\{|<script|<style|\son\w+=/i.test(readTemplate(id)));

        expect(withSyntax).toEqual([]);
    });
});
