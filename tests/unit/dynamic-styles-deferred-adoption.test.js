/** @jest-environment jsdom */
import { beforeAll, beforeEach, describe, expect, test } from '@jest/globals';

let loadStylesheetAsync;

beforeAll(async () => {
    ({ loadStylesheetAsync } = await import('../../public/scripts/dynamic-styles.js'));
});

function buildHead() {
    document.head.innerHTML = `
        <link data-case="raw" data-sb-deferred-style data-sb-panel-style data-sb-href="css/raw-panel.css?v=20261101a" data-sb-media="all">
        <link data-case="rewritten" data-sb-deferred-style data-sb-panel-style data-sb-href="/frontend-assets/css/rewritten-panel-3e82856c1985.css" data-sb-media="all" data-sb-source-href="css/rewritten-panel.css">
        <link data-case="preload" rel="preload" as="style" data-sb-deferred-style href="css/preload-panel.css?v=20261101a">
        <link data-case="unrelated" rel="stylesheet" href="css/unrelated.css?v=20261101a">
        <link data-case="user" rel="stylesheet" href="css/user.css">
    `;
}

const byCase = name => document.head.querySelector(`[data-case="${name}"]`);
const headCases = () => Array.from(document.head.children, node => node.dataset.case ?? node.id);

describe('dynamic-styles loadStylesheetAsync adopts deferred placeholders in place', () => {
    beforeEach(buildHead);

    test.each([
        ['a raw data-sb-href with a ?v= key', 'css/raw-panel.css?v=20261101a', 'raw'],
        ['a rewritten hashed data-sb-href carrying data-sb-source-href without the query', 'css/rewritten-panel.css?v=20261101a', 'rewritten'],
        ['a rel="preload" link', 'css/preload-panel.css?v=20261101a', 'preload'],
    ])('uses %s instead of appending a second link', async (_label, href, id) => {
        const before = headCases();
        const placeholder = byCase(id);

        const loading = loadStylesheetAsync(href, { id: `adopted-${id}` });

        expect(headCases().length).toBe(before.length);
        expect(placeholder.id).toBe(`adopted-${id}`);
        expect(placeholder.relList.contains('stylesheet')).toBe(true);
        const userCss = document.querySelector('link[href="css/user.css"]');
        expect(placeholder.compareDocumentPosition(userCss) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        placeholder.dispatchEvent(new Event('load'));
        await expect(loading).resolves.toBe(placeholder);
    });

    test('loads the rewritten placeholder from its hashed data-sb-href', async () => {
        const placeholder = byCase('rewritten');
        const loading = loadStylesheetAsync('css/rewritten-panel.css?v=20261101a', { id: 'adopted-hashed' });

        expect(placeholder.getAttribute('href')).toBe('/frontend-assets/css/rewritten-panel-3e82856c1985.css');

        placeholder.dispatchEvent(new Event('load'));
        await loading;
    });

    test('does not match an unrelated stylesheet that shares a directory, a name prefix or a query key', async () => {
        const unrelated = byCase('unrelated');
        const placeholders = ['raw', 'rewritten', 'preload'].map(byCase);

        const loading = loadStylesheetAsync('css/unrelated-other.css?v=20261101a', { id: 'fresh-sheet' });

        const fresh = document.getElementById('fresh-sheet');
        expect(fresh).not.toBeNull();
        expect(fresh).not.toBe(unrelated);
        expect(placeholders.every(link => link.id !== 'fresh-sheet')).toBe(true);
        expect(headCases().at(-1)).toBe('fresh-sheet');
        expect(unrelated.getAttribute('href')).toBe('css/unrelated.css?v=20261101a');

        fresh.dispatchEvent(new Event('load'));
        await loading;
    });

    test('keeps the exact comparison for a plain stylesheet link, so a changed ?v= key loads the new URL', async () => {
        const unrelated = byCase('unrelated');

        const loading = loadStylesheetAsync('css/unrelated.css?v=20261102b', { id: 'bumped-sheet' });

        const bumped = document.getElementById('bumped-sheet');
        expect(bumped).not.toBe(unrelated);
        expect(headCases().at(-1)).toBe('bumped-sheet');
        expect(bumped.getAttribute('href')).toBe('css/unrelated.css?v=20261102b');

        bumped.dispatchEvent(new Event('load'));
        await loading;
    });
});
