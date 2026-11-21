/** A lorebook with three entries. See `index.js` for the shape of a need module. */

export const fixture = Object.freeze({
    name: 'audit-lorebook',
    entries: Object.freeze(['Lamp', 'Desk', 'Window']),
});

export default {
    async exists({ post }) {
        return (await post('/api/worldinfo/get', { data: { name: fixture.name } }, { allow: [404, 500] })).ok();
    },
    async seed({ post }) {
        const entries = Object.fromEntries(fixture.entries.map((title, uid) => [uid, {
            uid, comment: title, key: [title.toLowerCase()], keysecondary: [], content: `The ${title.toLowerCase()} of the audit room.`,
            constant: false, vectorized: false, selective: true, order: 100, position: 0, disable: false, displayIndex: uid,
        }]));
        await post('/api/worldinfo/edit', { data: { name: fixture.name, data: { entries } } });
        return `lorebook ${fixture.name}`;
    },
};
