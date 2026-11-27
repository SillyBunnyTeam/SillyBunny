/* eslint-disable playwright/no-standalone-expect -- Jest contract for a static file. */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@jest/globals';

const list = fs.readFileSync(fileURLToPath(new URL('../../public/scripts/extensions/in-chat-agents/ui/agent-list.js', import.meta.url)), 'utf8');
const index = fs.readFileSync(fileURLToPath(new URL('../../public/index.html', import.meta.url)), 'utf8');

test('the entity list sheet is a panel sheet, which the idle activation skips', () => {
    expect(index).toMatch(/<link data-sb-deferred-style data-sb-panel-style data-sb-href="css\/sillybunny-entity-list\.css\?v=[\w.-]+"/);
});

test('the Agents list loads the entity list sheet before it reveals its rows, whichever panel opened first', () => {
    const literal = /const ENTITY_LIST_STYLESHEET = \{ href: '(css\/sillybunny-entity-list\.css\?v=[\w.-]+)', id: 'deferred-entity-list-css' \};/.exec(list);
    expect(literal).not.toBeNull();
    expect(index).toContain(`data-sb-href="${literal[1]}"`);
    const connect = list.slice(list.indexOf('async connect()'), list.indexOf('shell.root.hidden = false'));
    expect(connect).toContain('loadStylesheetAsync?.(ENTITY_LIST_STYLESHEET.href, { id: ENTITY_LIST_STYLESHEET.id })');
});
