/**
 * One character card with an embedded lorebook (`character_book`), imported over `/api/characters/import` as the Import
 * button of the character list does. Home and the lists then show one more card. See `index.js` for the shape of a need module.
 */

import { characterExists } from '../need-kit.js';

export const fixture = Object.freeze({
    name: 'Audit Embedded Lorebook Card',
    file: 'audit-embedded-lorebook',
    avatar: 'audit-embedded-lorebook.png',
    book: 'Audit Embedded Lorebook',
});

function buildCard() {
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: fixture.name,
            description: 'A card with an embedded lorebook for the UI audit.',
            personality: '',
            scenario: '',
            first_mes: 'Hello.',
            mes_example: '',
            creator_notes: '',
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: [],
            tags: [],
            creator: '',
            character_version: '',
            extensions: { talkativeness: 0.5, fav: false, world: '', depth_prompt: { prompt: '', depth: 4, role: 'system' } },
            character_book: {
                name: fixture.book,
                description: '',
                scan_depth: 2,
                token_budget: 512,
                recursive_scanning: false,
                extensions: {},
                entries: [{
                    id: 0, keys: ['lamp'], secondary_keys: [], comment: 'Lamp', content: 'The lamp is lit.', constant: false,
                    selective: false, insertion_order: 100, enabled: true, position: 'before_char', extensions: {},
                }],
            },
        },
    };
}

export default {
    exists: ({ post }) => characterExists(post, fixture.avatar),
    async seed({ post }) {
        await post('/api/characters/import', {
            multipart: {
                avatar: { name: `${fixture.file}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(buildCard())) },
                file_type: 'json',
                preserved_name: fixture.file,
            },
        });
        // The route answers 200 with an error flag when it cannot write the card.
        if (!await characterExists(post, fixture.avatar)) {
            throw new Error(`The card ${fixture.avatar} was not imported.`);
        }
        return `character ${fixture.avatar} with the lorebook ${fixture.book}`;
    },
};
