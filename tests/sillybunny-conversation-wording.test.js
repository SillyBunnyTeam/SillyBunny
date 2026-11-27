import { describe, expect, test } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

// Plan S1: "Conversations", "New Conversation", "New Group" and "chat" for a history. "Pals", "DM", "Solo", "Group DM",
// "Partner" and "Branch" as nouns are not in the interface. "Branch From Here" is an action name and stays.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODE_DIRECTORY = 'public/scripts/sillybunny-conversation';
const RETIRED = /\b(?:pals?|dms?|partners?|branch(?:es)?)\b/i;
const ACTION_NAMES = new Set(['Branch From Here']);
// What the model reads and the user never sees as interface text: the instructions that build a prompt. They name the
// conversation in the words that the model was tuned on, and changing them changes what the model writes.
const MODEL_FACING = /System directive|\[System|^\(No prior DM messages\.\)$/;
const MODEL_FACING_FILES = new Set([`${MODE_DIRECTORY}/prompt.js`, `${MODE_DIRECTORY}/shared-helpers.js`]);
// The directives of the automatic messages are built from parts, so the part that holds the word does not start with "[System".
const MODEL_FACING_PHRASES = new Map([[`${MODE_DIRECTORY}/auto-engine.js`, /private group DM|private aside DM|aside DM while|Send your DM|DM body|as a DM ping/]]);
// The credit that the default system prompt carries is a project's name.
const CREDIT = /Discord Pals|discord-pals/;

function listScripts(directory) {
    return readdirSync(`${ROOT}${directory}`, { withFileTypes: true }).flatMap(entry => {
        const relative = `${directory}/${entry.name}`;
        if (entry.isDirectory()) {
            return listScripts(relative);
        }
        return entry.name.endsWith('.js') ? [relative] : [];
    });
}

/** Every string literal and every text part of a template literal, with its line. */
function readStrings(source) {
    const strings = [];
    const visit = (node) => {
        if (!node || typeof node.type !== 'string') {
            return;
        }
        if (node.type === 'Literal' && typeof node.value === 'string') {
            strings.push({ text: node.value, line: node.loc.start.line });
        } else if (node.type === 'TemplateElement') {
            strings.push({ text: node.value.cooked ?? node.value.raw, line: node.loc.start.line });
        }
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) {
                value.forEach(visit);
            } else if (value && typeof value === 'object') {
                visit(value);
            }
        }
    };
    visit(acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true }));
    return strings;
}

describe('the wording of Conversation Mode', () => {
    const files = [...listScripts(MODE_DIRECTORY), 'public/scripts/sillybunny-conversation.js'];

    test('reads the files of the mode', () => {
        expect(files.length).toBeGreaterThan(60);
    });

    test('has no Pals, DM, Partner or Branch as a noun in any string that the interface can show', () => {
        const found = [];
        for (const file of files) {
            if (MODEL_FACING_FILES.has(file)) {
                continue;
            }
            for (const { text, line } of readStrings(readFileSync(`${ROOT}${file}`, 'utf8'))) {
                const isIdentifier = /^[\w:.-]+$/.test(text);
                if (isIdentifier || ACTION_NAMES.has(text) || MODEL_FACING.test(text) || MODEL_FACING_PHRASES.get(file)?.test(text) || CREDIT.test(text) || !RETIRED.test(text)) {
                    continue;
                }
                found.push(`${file}:${line}: ${text.slice(0, 90).replace(/\n/g, ' ')}`);
            }
        }
        expect(found).toEqual([]);
    });
});
