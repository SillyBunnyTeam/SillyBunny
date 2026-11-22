/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { presentMarkdownEngineRow } from '../../public/scripts/sillybunny-markdown-engine-row.js';
import { splitUserSettingsContent } from '../../public/scripts/sillybunny-settings-content.js';
import { analyzeSearchRoots, getRowSearchText, tokenizeQuery } from '../../public/scripts/sillybunny-settings-search.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');

const SOURCE = `
    <div id="source">
        <label for="markdown_engine">
            <small data-i18n="Markdown Engine">Markdown Engine</small>
            <small class="ds-row-subtitle" data-i18n="Some words" data-sb-copy-placeholder="true">Some words</small>
        </label>
        <select id="markdown_engine">
            <option value="markdown-it">markdown-it</option>
            <option value="showdown">Showdown</option>
        </select>
    </div>`;

/** Mounts the authored source and presents it, as the shell does before it splits the settings. */
function mount(html = SOURCE, value = 'markdown-it') {
    const root = document.createElement('div');
    root.innerHTML = html;
    document.body.replaceChildren(root);
    const select = root.querySelector('#markdown_engine');
    select.value = value;
    return { root, select, row: presentMarkdownEngineRow(root) };
}

const radios = row => [...row.querySelectorAll('input[type="radio"]')];
const checkedLabel = row => radios(row).find(radio => radio.checked)?.closest('label').textContent.trim();

beforeEach(() => {
    document.body.replaceChildren();
});

describe('the Markdown Engine toggle row', () => {
    test('replaces the legacy label and select by one toggle row with the two engines in the order of the select', () => {
        const { root, row } = mount();
        expect(root.querySelector('#source')).toBeNull();
        expect(root.querySelectorAll('.ds-toggle-row')).toHaveLength(1);
        expect(row.querySelector('.ds-row-label').textContent).toBe('Markdown Engine');
        expect(row.querySelector('.ds-row-label').dataset.i18n).toBe('Markdown Engine');
        expect([...row.querySelectorAll('.sb-boolean-radio-option')].map(option => option.textContent.trim())).toEqual(['markdown-it', 'Showdown']);
        expect(radios(row).map(radio => radio.value)).toEqual(['markdown-it', 'showdown']);
    });

    test('names the radio group by the visible title', () => {
        const { row } = mount();
        const group = row.querySelector('[role="radiogroup"]');
        expect(document.getElementById(group.getAttribute('aria-labelledby')).textContent).toBe('Markdown Engine');
    });

    test('shows the stored value of the select', () => {
        expect(checkedLabel(mount(SOURCE, 'markdown-it').row)).toBe('markdown-it');
        expect(checkedLabel(mount(SOURCE, 'showdown').row)).toBe('Showdown');
    });

    test('keeps the select in the document, hidden, inside the row, so the stored value has one home', () => {
        const { select, row } = mount();
        expect(row.contains(select)).toBe(true);
        expect(select.hidden).toBe(true);
        expect(document.getElementById('markdown_engine')).toBe(select);
    });

    test('choosing an engine writes the select and fires input and change, in that order, for handlers that listen to it', () => {
        const { select, row } = mount();
        const events = [];
        for (const type of ['input', 'change']) select.addEventListener(type, () => events.push(`${type}:${select.value}`));
        radios(row)[1].checked = true;
        radios(row)[1].dispatchEvent(new Event('change', { bubbles: true }));
        expect(select.value).toBe('showdown');
        expect(events).toEqual(['input:showdown', 'change:showdown']);

        radios(row)[0].checked = true;
        radios(row)[0].dispatchEvent(new Event('change', { bubbles: true }));
        expect(select.value).toBe('markdown-it');
        expect(events.slice(2)).toEqual(['input:markdown-it', 'change:markdown-it']);
    });

    test('follows a value that the settings load writes into the select and announces with input', () => {
        const { select, row } = mount();
        select.value = 'showdown';
        select.dispatchEvent(new Event('input', { bubbles: true }));
        expect(checkedLabel(row)).toBe('Showdown');
        select.value = 'markdown-it';
        select.dispatchEvent(new Event('input', { bubbles: true }));
        expect(checkedLabel(row)).toBe('markdown-it');
    });

    test('follows a change that another script makes to the select', () => {
        const { select, row } = mount();
        select.value = 'showdown';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        expect(checkedLabel(row)).toBe('Showdown');
    });

    test('presenting twice builds one row', () => {
        const { root, row } = mount();
        expect(presentMarkdownEngineRow(root)).toBeNull();
        expect(root.querySelectorAll('.ds-toggle-row')).toHaveLength(1);
        expect(root.contains(row)).toBe(true);
    });

    test('does nothing when the select is absent', () => {
        const root = document.createElement('div');
        expect(presentMarkdownEngineRow(root)).toBeNull();
    });

    test('moves the subtitle of the markup into the row with its translation key and copy marker', () => {
        const subtitle = mount().row.querySelector('.ds-row-subtitle');
        expect(subtitle.textContent).toBe('Some words');
        expect(subtitle.dataset.i18n).toBe('Some words');
        expect(subtitle.dataset.sbCopyPlaceholder).toBe('true');
    });

    test('has no subtitle line when the markup has none', () => {
        const withoutSubtitle = SOURCE.replace(/<small class="ds-row-subtitle"[^>]*>[^<]*<\/small>/, '');
        const { row } = mount(withoutSubtitle);
        expect(row.querySelector('.ds-row-subtitle')).toBeNull();
    });
});

describe('the Markdown Engine row in Customize > Messages', () => {
    let previousCSS;
    beforeAll(() => {
        previousCSS = globalThis.CSS;
        globalThis.CSS = { ...previousCSS, escape: value => String(value) };
    });
    afterAll(() => {
        globalThis.CSS = previousCSS;
    });

    function splitAuthoredSettings() {
        const page = new DOMParser().parseFromString(indexHtml, 'text/html');
        const block = document.adoptNode(page.getElementById('user-settings-block'));
        const originalContent = document.createElement('div');
        originalContent.append(...block.childNodes);
        document.body.replaceChildren(originalContent);
        presentMarkdownEngineRow(originalContent);
        return splitUserSettingsContent(originalContent);
    }

    test('the authored markup becomes a toggle row that sits in Message Display right after Auto-fix Markdown', () => {
        const body = splitAuthoredSettings().messages.querySelector('[data-sb-category="message-display"] > .sb-settings-category-body');
        const rows = [...body.children];
        const autoFix = rows.findIndex(row => row.contains(body.querySelector('#auto_fix_generated_markdown')));
        const engine = rows.findIndex(row => row.contains(body.querySelector('#markdown_engine')));
        expect(autoFix).toBeGreaterThanOrEqual(0);
        expect(engine).toBe(autoFix + 1);
        expect(rows[engine].classList.contains('ds-toggle-row')).toBe(true);
        expect(rows[engine].querySelector('.ds-row-label').textContent).toBe('Markdown Engine');
    });

    test('settings search finds the row by its title and by the names of its two engines, and skips the placeholder copy', () => {
        const { messages } = splitAuthoredSettings();
        const row = messages.querySelector('#markdown_engine').closest('.ds-toggle-row');
        const text = getRowSearchText(row);
        expect(text).toContain('markdown engine');
        expect(text).toContain('markdown-it');
        expect(text).toContain('showdown');
        expect(text).not.toContain('todo(copy)');
        for (const query of ['markdown engine', 'showdown']) {
            const { groups } = analyzeSearchRoots([messages], tokenizeQuery(query), { isAvailable: () => true });
            expect(groups.flatMap(group => group.matched.map(match => match.element))).toContain(row);
        }
    });

    test('offers markdown-it first and Showdown second, and no select row', () => {
        const { messages } = splitAuthoredSettings();
        const row = messages.querySelector('#markdown_engine').closest('.ds-toggle-row');
        expect([...row.querySelectorAll('.sb-boolean-radio-option')].map(option => option.textContent.trim())).toEqual(['markdown-it', 'Showdown']);
        expect(messages.querySelector('.ds-select-row #markdown_engine')).toBeNull();
    });
});
