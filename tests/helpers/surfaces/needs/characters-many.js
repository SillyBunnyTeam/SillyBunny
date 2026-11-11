/**
 * Twelve characters with distinct names, three of them long and two favourites, spread over the tags and folders of the
 * `tags` and `folders` needs. The cards are created on the server; the tag and folder assignments are in the settings.
 * See `index.js` for the shape of a need module.
 */

import { characterExists, createCharacterCard } from '../need-kit.js';

const NAMES = [
    'Aurelia Vance', 'Bram Holloway', 'Cassiopeia Thorne-Whitlock the Third of Marrowmere Reach', 'Dmitri Okonkwo',
    'Elowen Fairweather-Ashcombe of the Northern Marches and Beyond', 'Finnegan Lowe', 'Gwendolyn Sato', 'Hadrian Quill',
    'Isolde Marchetti', 'Jun-seo Park', 'Kestrel the Wandering Cartographer of the Salt Roads and Distant Harbours', 'Lysander Brooks',
];
const FAVOURITES = [0, 6];

const pad = index => String(index + 1).padStart(2, '0');

/** `characters` lists name, file, avatar and favourite flag; the tag ids and folder ids follow the tags and folders needs. */
export const fixture = Object.freeze({
    characters: Object.freeze(NAMES.map((name, index) => Object.freeze({
        name,
        file: `audit-many-${pad(index)}`,
        avatar: `audit-many-${pad(index)}.png`,
        favorite: FAVOURITES.includes(index),
        // Each character has two tags, and the first character of every three is in the first folder, the second in the second, the third in none.
        tagIndexes: Object.freeze([index % 8, (index + 3) % 8]),
        folderIndex: index % 3 === 2 ? null : index % 3,
    }))),
});

export default {
    requires: ['tags', 'folders'],
    async exists({ post }) {
        const present = await Promise.all(fixture.characters.map(character => characterExists(post, character.avatar)));
        return present.every(Boolean);
    },
    async seed({ post }) {
        let created = 0;
        for (const character of fixture.characters) {
            if (await characterExists(post, character.avatar)) {
                continue;
            }
            await createCharacterCard(post, {
                name: character.name,
                file: character.file,
                description: `${character.name} is a fixture character for the UI audit.`,
                firstMessage: `Hello, I am ${character.name}.`,
                favorite: character.favorite,
            });
            created++;
        }
        return `${created} characters ${fixture.characters[0].avatar} to ${fixture.characters.at(-1).avatar}`;
    },
    settings(settings) {
        const tagIds = settings.tags.map(tag => tag.id);
        const folders = settings.power_user.sb_folders.characters;
        for (const character of fixture.characters) {
            settings.tag_map[character.avatar] = character.tagIndexes.map(index => tagIds[index]);
            if (character.folderIndex !== null) {
                folders.members[character.avatar] = folders.folders[character.folderIndex].id;
            }
        }
    },
};
