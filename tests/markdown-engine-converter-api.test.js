import { describe, expect, jest, test } from '@jest/globals';
import markdownit from 'markdown-it';
import markdownItCjkFriendly from 'markdown-it-cjk-friendly';
import { full as markdownItEmoji } from 'markdown-it-emoji';

import { createMarkdownItConverter, createWarnOncePerName } from '../public/scripts/markdown-engine.js';
import { createSillyBunnyShowdownConverter } from './util/sillybunny-showdown.js';

const libraries = { markdownit, markdownItEmoji, markdownItCjkFriendly };

/** The methods of the Showdown converter that an extension can call on the converter that script.js exports. */
const SHOWDOWN_METHODS = Object.freeze([
    'addExtension', 'removeExtension', 'useExtension', 'setOption', 'getOption', 'getOptions', 'setFlavor', 'getFlavor', 'listen', 'makeMarkdown',
]);

/** Arguments of a typical call of each method. */
const TYPICAL_CALLS = Object.freeze({
    addExtension: [{ type: 'lang', regex: /a/g, replace: 'b' }, 'test-extension'],
    removeExtension: ['test-extension'],
    useExtension: ['test-extension'],
    setOption: ['simpleLineBreaks', true],
    getOption: ['simpleLineBreaks'],
    getOptions: [],
    setFlavor: ['github'],
    getFlavor: [],
    listen: ['makeHtml.before', () => {}],
    makeMarkdown: ['<p>text</p>'],
});

const silently = () => {};
const createConverter = (options = {}) => createMarkdownItConverter(libraries, { warnUnsupported: silently, ...options });

describe('the Showdown methods on the converter object', () => {
    test.each(SHOWDOWN_METHODS)('%s exists on the Showdown converter and on the markdown-it converter', (name) => {
        expect(typeof createSillyBunnyShowdownConverter()[name]).toBe('function');
        expect(typeof createConverter()[name]).toBe('function');
    });

    test.each(SHOWDOWN_METHODS)('%s on the markdown-it converter does not throw, with typical arguments or with none', (name) => {
        const converter = createConverter();
        expect(() => converter[name](...TYPICAL_CALLS[name])).not.toThrow();
        expect(() => converter[name]()).not.toThrow();
    });

    test('keeps makeHtml working next to the stubs', () => {
        expect(createConverter().makeHtml('*a*')).toBe('<p><em>a</em></p>\n');
    });

    test('returns the types that a caller reads from Showdown', () => {
        const converter = createConverter();
        expect(converter.getOption('simpleLineBreaks')).toBeUndefined();
        expect(converter.getOptions()).toEqual(expect.any(Object));
        expect(Array.isArray(converter.getOptions())).toBe(false);
        expect(typeof converter.getFlavor()).toBe('string');
        expect(typeof converter.makeMarkdown('<p>text</p>')).toBe('string');
        expect(converter.addExtension(...TYPICAL_CALLS.addExtension)).toBeUndefined();
        expect(converter.setOption('simpleLineBreaks', true)).toBeUndefined();
    });

    test('hands out a new options object each time, so a caller cannot change the next answer', () => {
        const converter = createConverter();
        converter.getOptions().simpleLineBreaks = true;
        expect(converter.getOptions()).toEqual({});
    });

    test('lets listen chain, as Showdown does', () => {
        const converter = createConverter();
        expect(converter.listen('makeHtml.before', () => {})).toBe(converter);
    });

    test('gives back the HTML that makeMarkdown received, so a caller that writes the result back loses nothing', () => {
        expect(createConverter().makeMarkdown('<p>text</p>')).toBe('<p>text</p>');
        expect(createConverter().makeMarkdown(undefined)).toBe('');
    });
});

describe('the warning of a Showdown method on the markdown-it converter', () => {
    test('names the method and tells the caller that it has no effect and that Showdown can be chosen', () => {
        const warnUnsupported = jest.fn();
        createConverter({ warnUnsupported }).setOption('simpleLineBreaks', true);
        expect(warnUnsupported).toHaveBeenCalledTimes(1);
        expect(warnUnsupported).toHaveBeenCalledWith('setOption');
    });

    test('createWarnOncePerName logs one sentence for a method, once, and again for the next method', () => {
        const log = jest.fn();
        const warn = createWarnOncePerName(log);
        warn('addExtension');
        warn('addExtension');
        warn('setOption');
        expect(log).toHaveBeenCalledTimes(2);

        const [first] = log.mock.calls[0];
        expect(first).toContain('addExtension()');
        expect(first).toContain('no effect');
        expect(first).toContain('markdown-it');
        expect(first).toContain('Showdown');
        expect(first.split(/\.\s/)).toHaveLength(1);
        expect(first.endsWith('.')).toBe(true);
        expect(log.mock.calls[1][0]).toContain('setOption()');
    });

    test('the default warns through console.warn, once for each method for the whole page, across converters', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(silently);
        try {
            const first = createMarkdownItConverter(libraries);
            const second = createMarkdownItConverter(libraries);
            for (const converter of [first, second, first]) {
                for (const name of SHOWDOWN_METHODS) converter[name](...TYPICAL_CALLS[name]);
            }
            const messages = warn.mock.calls.map(([message]) => String(message));
            expect(messages).toHaveLength(SHOWDOWN_METHODS.length);
            for (const name of SHOWDOWN_METHODS) {
                expect(messages.filter(message => message.includes(`${name}()`))).toHaveLength(1);
            }
        } finally {
            warn.mockRestore();
        }
    });
});
