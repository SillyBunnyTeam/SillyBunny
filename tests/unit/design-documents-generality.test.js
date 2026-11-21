import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// DESIGN.md and DESIGN.json are the reference for designing a new element, so they state patterns, roles and conditions and
// never describe one feature of the application. These are the names of features, pages, windows and bundled extensions that
// the documents once described or could be tempted to. The list is the maintainers': add a name when a feature gets one.
// Matching is by whole word and by case, so "a welcome page" passes where "the Welcome window" does not.
const FEATURE_NAMES = Object.freeze([
    'Backend', 'Customize', 'Connections', 'Sampling', 'Presets', 'Formatting',
    'Home', 'Welcome', 'Getting Started', 'Characters', 'Persona', 'Personas', 'World Info', 'Lorebook',
    'Conversation', 'Roleplay', 'Author\'s Note', 'Quick Reply', 'Quick Replies', 'Data Bank', 'Chats Archive',
    'Tag Manager', 'Folder Manager', 'Backgrounds', 'Background Visibility', 'Paper Texture', 'Shell Style',
    'Visual Novel', 'visual-novel', 'Guided Generations', 'Chat Navigation', 'Scene Tracker', 'Open Assistant',
    'In-Chat Agents', 'Pathfinder', 'Companion', 'Expressions', 'Regex', 'Fractal',
    'Hush', 'Whisper', 'Echo', 'Tide', 'Ripple',
]);

// A listed word that is not a feature where it stands: the Home key, named beside End or in a key combination.
const NOT_A_FEATURE = Object.freeze([/Arrow, Home, and End/g, /\bHome and End\b/g, /\+Home\b/g]);

/**
 * @param {string} text
 * @returns {{ name: string, line: number, excerpt: string }[]}
 */
function featureNamesIn(text) {
    const found = [];
    text.split('\n').forEach((raw, index) => {
        const line = NOT_A_FEATURE.reduce((kept, pattern) => kept.replace(pattern, ''), raw);
        for (const name of FEATURE_NAMES) {
            const at = line.search(new RegExp(`(?<![A-Za-z])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`));
            if (at !== -1) {
                found.push({ name, line: index + 1, excerpt: line.slice(Math.max(0, at - 40), at + name.length + 40).trim() });
            }
        }
    });
    return found;
}

describe('the design documents state patterns, not features', () => {
    test.each(['DESIGN.md', 'DESIGN.json'])('%s names no feature of the application', file => {
        const found = featureNamesIn(fs.readFileSync(path.join(repoRoot, file), 'utf8'));

        // Reword the sentence as a pattern that a new element can follow, or move it to where the feature lives.
        expect(found.map(hit => `${file}:${hit.line} names "${hit.name}": …${hit.excerpt}…`)).toEqual([]);
    });

    test('a feature name is found by whole word and by case, and a key name is not one', () => {
        expect(featureNamesIn('The Welcome window keeps its size.').map(hit => hit.name)).toEqual(['Welcome']);
        expect(featureNamesIn('A welcome or first-run page; Arrow, Home, and End move between rows; Ctrl+Home goes to the first.')).toEqual([]);
        expect(featureNamesIn('Homepage and Personalised are other words.')).toEqual([]);
    });
});
