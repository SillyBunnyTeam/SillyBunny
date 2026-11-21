import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildManifest } from '../../../src/sillybunny-managed-content.js';
import { createCard, createCardFile, createSpriteFile, createWorldFile } from './fixture-builder.js';

/** The items of the fixture content, in the order the manifest lists them. */
export const FIXTURE_ITEMS = Object.freeze([
    { type: 'character', filename: 'default_AssistantReisen.png' },
    { type: 'character', filename: 'default_AssistantTewi.png' },
    { type: 'sprites', filename: 'Assistant Reisen' },
    { type: 'sprites', filename: 'Assistant Tewi' },
    { type: 'world', filename: 'SillyBunny Lexicon.json' },
]);

const ASSISTANTS = Object.freeze([
    { name: 'Assistant Reisen', file: 'default_AssistantReisen.png', nickname: 'Reisen', seed: 11, spriteBase: 10 },
    { name: 'Assistant Tewi', file: 'default_AssistantTewi.png', nickname: 'Tewi', seed: 12, spriteBase: 20 },
]);

const SPRITE_NAMES = Object.freeze(['joy.webp', 'neutral.webp', 'sadness.webp']);

function writeFile(directory, name, content) {
    const target = path.join(directory, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

/**
 * Writes the fixture content that stands in for `default/content` in tests: two assistant cards with sprites and a
 * world, an index and the manifest built from them. The text is made up and is not the text of the real cards.
 * @param {string} directory
 */
export function generateFixtureContent(directory) {
    for (const assistant of ASSISTANTS) {
        const card = createCard({
            name: assistant.name,
            nickname: assistant.nickname,
            description: `Fixture description of ${assistant.name}.`,
            first_mes: `Fixture greeting of ${assistant.name}.`,
            character_version: '1.0',
        });
        writeFile(directory, assistant.file, createCardFile({ seed: assistant.seed, card }));
        SPRITE_NAMES.forEach((name, index) => writeFile(directory, `${assistant.name}/${name}`, createSpriteFile(assistant.spriteBase + index)));
    }
    writeFile(directory, 'SillyBunny Lexicon.json', createWorldFile([
        { key: ['fixture'], content: 'The first fixture entry.' },
        { key: ['lexicon'], content: 'The second fixture entry.' },
    ]));
    writeFile(directory, 'index.json', `${JSON.stringify(FIXTURE_ITEMS.map(({ filename, type }) => ({ filename, type })), null, 4)}\n`);
    const manifest = buildManifest({ bundledDirectory: directory, entries: [...FIXTURE_ITEMS] });
    writeFile(directory, 'sillybunny-managed.json', `${JSON.stringify(manifest, null, 4)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const target = path.join(path.dirname(fileURLToPath(import.meta.url)), 'content');
    fs.rmSync(target, { recursive: true, force: true });
    generateFixtureContent(target);
    console.log(`Wrote the fixture content to ${target}`);
}
