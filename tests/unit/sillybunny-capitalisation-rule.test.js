/* eslint-disable playwright/no-standalone-expect -- Jest table tests of a pure function. */
import { describe, expect, test } from '@jest/globals';
import { checkLabel, headerCase, isFullSentence, questionBranch, sentenceCase, styleFaults } from '../helpers/capitalisation.js';

// The examples of DESIGN.md, The Capitalisation Rule, and the cases that the recasing batches met.
describe('headerCase', () => {
    test.each([
        ['find and replace', 'Find and Replace'],
        ['self-test', 'Self-Test'],
        ['document cannot be found', 'Document Cannot Be Found'],
        ['Three Documents Updated', 'Three Documents Updated'],
        ['per-model sampling profiles', 'Per-Model Sampling Profiles'],
        ['remember sampling settings per model', 'Remember Sampling Settings per Model'],
        ['back to settings navigation', 'Back to Settings Navigation'],
        ['sync from upstream', 'Sync From Upstream'],
        ['Generate CSS with AI', 'Generate CSS With AI'],
        ['clear cookies & cache', 'Clear Cookies & Cache'],
        ['on', 'On'],
        ['keep newest', 'Keep Newest'],
        ['older than', 'Older Than'],
    ])('%s -> %s', (input, expected) => {
        expect(headerCase(input)).toBe(expected);
    });

    test.each([
        ['a token in brackets stays as written', 'Selfies Through Quick Image Gen ([selfie])'],
        ['a Handlebars helper is not text', '{{#if pinned}}Unpin Chat{{else}}Pin Chat{{/if}}'],
        ['a file extension stays as written', 'Download .md'],
        ['a command-line flag stays as written', 'Make Sure You Run It With --api Flag'],
        ['a template hole is not a word', 'Modify Tags of ${} ${}'],
        ['a plural marker belongs to its word', 'Import Embedded Lorebooks for ${} Visible Character(s)'],
        ['a code identifier stays as written', 'Sends include_reasoning'],
        ['a unit stays as written', 'Width in px'],
    ])('%s', (_name, text) => {
        expect(headerCase(text)).toBe(text);
    });

    test('the short words stay low only inside the phrase', () => {
        expect(headerCase('add to favorites')).toBe('Add to Favorites');
        expect(headerCase('to do')).toBe('To Do');
        expect(headerCase('what to')).toBe('What To');
    });
});

describe('sentenceCase', () => {
    test.each([
        ['Keep Sampling Settings Linked to Preset', 'Keep sampling settings linked to preset'],
        ['Remember Sampling Settings per Model', 'Remember sampling settings per model'],
        ['Open Quick Replies', 'Open Quick Replies'],
        ['Auto-Detect Message Icon', 'Auto-detect message icon'],
        ['Keep API/Model Linked to Preset', 'Keep API/Model linked to preset'],
    ])('%s -> %s', (input, expected) => {
        expect(sentenceCase(input)).toBe(expected);
    });
});

describe('question headings (DESIGN.md line 372)', () => {
    test.each([
        ['Replace File?', 'heading'],
        ['Save Changes?', 'heading'],
        ['Delete Chat?', 'heading'],
        ['Run Card Scripts?', 'heading'],
        ['Allow ${}?', 'heading'],
        ['What is Pathfinder?', 'sentence'],
        ['Clear the memory summary?', 'sentence'],
        ['Keep this chat?', 'sentence'],
        ['Discard your changes?', 'sentence'],
        ['Is this correct?', 'sentence'],
    ])('%s is a %s', (text, branch) => {
        expect(questionBranch(text)).toBe(branch);
    });

    test('a heading that is a full sentence takes sentence capitalisation', () => {
        expect(isFullSentence('Pathfinder is not configured')).toBe(true);
        expect(isFullSentence('SillyBunny could not finish loading')).toBe(true);
        expect(isFullSentence('Document Cannot Be Found')).toBe(true);
        expect(isFullSentence('Delete Selected')).toBe(false);
    });
});

describe('styleFaults', () => {
    test.each([
        ['Search...', ['three-dot ellipsis']],
        ['Delete.', ['trailing period']],
        ['For e.g. This', ['Latin abbreviation e.g.']],
        ['Search…', []],
        ['Delete', []],
        ['Keep <think>...</think> blocks', []],
        ['Keep OOC ((...)) blocks', []],
    ])('%s', (text, faults) => {
        expect(styleFaults(text)).toEqual(faults);
    });
});

describe('checkLabel', () => {
    test('a header role asks for header capitalisation and names the form it should have', () => {
        expect(checkLabel('button', 'Clear all cache')).toEqual({ ok: false, expected: 'Clear All Cache', why: 'header capitalisation' });
        expect(checkLabel('button', 'Clear All Cache')).toEqual({ ok: true });
        expect(checkLabel('menu item', 'Inspect tokens').expected).toBe('Inspect Tokens');
        expect(checkLabel('row title', 'Group-only greetings').expected).toBe('Group-Only Greetings');
    });

    test('a sentence role asks for sentence capitalisation', () => {
        expect(checkLabel('row subtitle', 'Match message icons to recognized model names')).toEqual({ ok: true });
        expect(checkLabel('placeholder', 'Search Character Names By Tag')).toEqual({ ok: false, expected: 'Search character names by tag', why: 'sentence capitalisation' });
        expect(checkLabel('check or radio label', 'Keep Sampling Settings Linked to Preset').expected).toBe('Keep sampling settings linked to preset');
    });

    test.each([
        ['Delete Failed', 'Delete failed'],
        ['Screenshot Ready', 'Screenshot ready'],
        ['Reload Cancelled', 'Reload cancelled'],
        ['Auto-Label Chat', 'Auto-label chat'],
        ['Quick Reply Init Failed', 'Quick Reply init failed'],
        ['World Info Save Failed', 'World Info save failed'],
        ['SillyBunny Palette', 'SillyBunny palette'],
    ])('a toast title is an informal heading in sentence capitalisation: %s -> %s', (input, expected) => {
        expect(checkLabel('toast title', input)).toEqual({ ok: false, expected, why: 'sentence capitalisation' });
        expect(checkLabel('toast title', expected)).toEqual({ ok: true });
    });

    test('a toast title keeps a product name, an acronym and an inner capital as written', () => {
        for (const title of ['API error', 'ST server cannot be reached', 'SillyBunny could not start', 'Pathfinder is not configured', 'Guided Generations fork deprecated', 'Reply in progress']) {
            expect(checkLabel('toast title', title)).toEqual({ ok: true });
        }
    });

    test('a heading that is a full sentence or a long question keeps sentence capitalisation', () => {
        expect(checkLabel('heading', 'Pathfinder is not configured')).toEqual({ ok: true });
        expect(checkLabel('heading', 'Document Cannot Be Found')).toEqual({ ok: true });
        expect(checkLabel('heading', 'SillyBunny could not Finish Loading').expected).toBe('SillyBunny could not finish loading');
        expect(checkLabel('heading', 'Keep this chat?')).toEqual({ ok: true });
        expect(checkLabel('heading', 'Delete chat?').expected).toBe('Delete Chat?');
        expect(checkLabel('heading', 'Delete Chat?')).toEqual({ ok: true });
        expect(checkLabel('heading', 'Import embedded lorebooks for ${} visible character(s)?')).toEqual({ ok: true });
    });

    test('a style fault is reported with the label that fixes the case', () => {
        expect(checkLabel('button', 'Save changes...')).toEqual({ ok: false, expected: 'Save Changes…', why: 'header capitalisation, three-dot ellipsis' });
    });

    test('text with a template or a Handlebars helper is not checked', () => {
        expect(checkLabel('tooltip', '{{#if pinned}}Unpin Chat{{else}}Pin Chat{{/if}}')).toEqual({ ok: true, skipped: 'template' });
    });
});

describe('sentence-length labels', () => {
    test('a heading, tooltip, toast title or row title as long as a sentence needs new wording, so it is not recased', () => {
        expect(checkLabel('tooltip', 'Edit prompt content, order, and placement.')).toEqual({ ok: true, skipped: 'sentence-length' });
        expect(checkLabel('tooltip', 'Inserted before the last User\'s message.')).toEqual({ ok: true, skipped: 'sentence-length' });
        expect(checkLabel('toast title', 'Preset switch also changes the connection setup')).toEqual({ ok: true, skipped: 'sentence-length' });
        expect(checkLabel('row title', 'Reset selections to the current chat/character lorebooks on chat change')).toEqual({ ok: true, skipped: 'sentence-length' });
        expect(checkLabel('row title', 'Automatically include attached lorebooks, aside from excluded lorebooks')).toEqual({ ok: true, skipped: 'sentence-length' });
        expect(checkLabel('row title', 'Keep sampling settings linked to preset').expected).toBe('Keep Sampling Settings Linked to Preset');
        expect(checkLabel('button', 'Save changes')).toMatchObject({ ok: false, expected: 'Save Changes' });
    });
});
