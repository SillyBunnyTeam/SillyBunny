/** A character card on the server's data root. See `index.js` for the shape of a need module. */

export const fixture = Object.freeze({
    name: 'Audit Character',
    file: 'audit-character',
    avatar: 'audit-character.png',
    description: 'A fixture character for the UI audit.',
    personality: 'Calm and precise.',
    scenario: 'A quiet room with a lamp.',
    firstMessage: 'Hello. This is the audit fixture.',
    example: '{{user}}: Hello.\n{{char}}: Hello.',
    notes: 'Created by the surface audit.',
});

export default {
    async exists({ post }) {
        return (await post('/api/characters/get', { data: { avatar_url: fixture.avatar } }, { allow: [404, 500] })).ok();
    },
    async seed({ post }) {
        await post('/api/characters/create', {
            data: {
                ch_name: fixture.name, file_name: fixture.file, description: fixture.description, personality: fixture.personality,
                scenario: fixture.scenario, first_mes: fixture.firstMessage, mes_example: fixture.example, creator_notes: fixture.notes,
                tags: '', talkativeness: '0.5', fav: 'false',
            },
        });
        return `character ${fixture.avatar}`;
    },
};
