import { describe, expect, test } from '@jest/globals';
import { stringLookup } from '../../scripts/copy-strings.js';
import { createOrigin } from '../helpers/copy-origin.js';

describe('stringLookup', () => {
    const lookup = stringLookup(['Check for updates', 'Actions for ${}', '${} group', '${} ${}', 'Delete ${}?']);

    test('finds a string that the tree holds, whitespace folded', () => {
        expect(lookup('Check  for updates')).toBe('Check for updates');
    });

    test('names the template that a text fills, so that the data in the hole is never judged', () => {
        expect(lookup('Actions for Seraphina')).toBe('Actions for ${}');
        expect(lookup('Audit Folder group')).toBe('${} group');
        expect(lookup('Delete Audit Folder?')).toBe('Delete ${}?');
    });

    test('does not match a text that no string or template makes, or a template with too little text of its own', () => {
        expect(lookup('Seraphina')).toBeNull();
        expect(lookup('Aurelia Vance')).toBeNull();
        expect(lookup('Actions')).toBeNull();
    });
});

describe('createOrigin', () => {
    const tree = { strings: ['Check for updates', 'Top nsigma', 'Actions for ${}', 'Shared label'], foreign: ['Generate image', 'Shared label'] };
    const upstream = { strings: ['Top nsigma', 'Shared label'] };
    const origin = createOrigin({ tree, upstream });

    test('a label that only SillyBunny wrote is sillybunny', () => {
        expect(origin.classify('Check for updates')).toEqual({ origin: 'sillybunny', text: 'Check for updates' });
    });

    test('a label that is verbatim in the upstream base is upstream, even where the tree repeats it', () => {
        expect(origin.classify('Top nsigma').origin).toBe('upstream');
    });

    test('a text that no file holds is data: a name, a file or a model id', () => {
        expect(origin.classify('Aurelia Vance')).toEqual({ origin: 'data', text: 'Aurelia Vance' });
        expect(origin.classify('bedroom clean.jpg').origin).toBe('data');
    });

    test('an identifier, such as an icon name, is data even when a file holds it', () => {
        const icons = createOrigin({ tree: { strings: ['eye-slash', 'Check for updates'], foreign: [] }, upstream: { strings: [] } });
        expect(icons.classify('eye-slash').origin).toBe('data');
    });

    test('a name of the bundled content is data even where a file repeats it, and so is a path', () => {
        const named = createOrigin({ tree: { strings: ['Geechan Preset', 'Check for updates', '/user/files/${}'], foreign: [], content: ['Geechan Preset'] }, upstream: { strings: [] } });
        expect(named.classify('Geechan Preset').origin).toBe('data');
        expect(named.classify('/user/files/x.png').origin).toBe('data');
        expect(named.classify('filter-list').origin).toBe('data');
        expect(named.classify('Check for updates').origin).toBe('sillybunny');
    });

    test('a text that only code the project does not own holds is foreign, and one that its own files hold as well is not', () => {
        expect(origin.classify('Generate image').origin).toBe('foreign');
        expect(origin.classify('Shared label').origin).toBe('upstream');
    });

    test('a text that fills a template is judged as the template', () => {
        expect(origin.classify('Actions for Seraphina')).toEqual({ origin: 'sillybunny', text: 'Actions for ${}' });
    });

    test('is unknown, not sillybunny, when the upstream set cannot be built', () => {
        const unreadable = createOrigin({ tree, upstream: { get strings() { throw new Error('bad object name'); } } });
        expect(unreadable.classify('Check for updates').origin).toBe('unknown');
        expect(unreadable.upstreamError.message).toBe('bad object name');
    });
});
